"""
Routes behind interactive answers (render_ui) — data refresh and images.

Both are called on behalf of a sandboxed frame that itself has no cookies and
no network: the data route by the host page (the user's own session), the image
route by the frame's <img> tags, authorised by a signature instead of a cookie.
See src/ui_data.py and src/interactive_ui.py (proxy_images).
"""

import logging

from fastapi import APIRouter, HTTPException, Request, Response

from src.auth_helpers import effective_user, require_user
from src.image_proxy import SAFE_HEADERS, fetch_public_image
from src.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

# Per UI: a slider dragged end to end fires plenty of refreshes; the frame
# debounces, this is the backstop.
_data_limiter = RateLimiter(max_requests=40, window_seconds=60)
# Per signed URL set: a page full of images loads once, then the browser cache
# holds them.
_image_limiter = RateLimiter(max_requests=240, window_seconds=60)

IMAGE_CACHE = "private, max-age=86400"
# Per client: a map view is ~20-40 tiles, panning and zooming adds a few dozen
# more. Generous for people, a backstop against scraping through the proxy.
_tile_limiter = RateLimiter(max_requests=600, window_seconds=60)


def setup_ui_routes():
    router = APIRouter(prefix="/api/ui", tags=["interactive-ui"])

    @router.post("/data")
    async def refresh_data(request: Request):
        """Re-run a data source an interactive answer declared, with new
        parameter values. Only the stored spec runs; the request supplies
        values for its declared, typed parameters and nothing else."""
        from src import interactive_ui, ui_data

        require_user(request)
        owner = effective_user(request) or None
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Expected JSON.")
        if not isinstance(body, dict):
            raise HTTPException(400, "Expected a JSON object.")
        ui_id = str(body.get("uiId") or "")
        source_id = str(body.get("sourceId") or "")
        if not ui_id or not source_id or len(ui_id) > 64 or len(source_id) > 64:
            raise HTTPException(400, "uiId and sourceId are required.")
        if not interactive_ui.enabled():
            raise HTTPException(403, "Interactive answers are turned off.")

        row = ui_data.load(ui_id, source_id)
        # Not found and not yours look the same from outside.
        if row is None or (row["owner"] or None) != owner:
            raise HTTPException(404, "Unknown data source.")
        spec = row["spec"]
        if not ui_data.tool_allowed(spec["kind"], owner):
            raise HTTPException(403, "This data source is not available to you.")
        if not _data_limiter.check(f"{owner}:{ui_id}"):
            raise HTTPException(429, "Too many refreshes — wait a moment.")
        try:
            params = ui_data.resolve_params(spec, body.get("params"))
            result = await ui_data.run(spec, params, row["session_id"] or "")
        except ui_data.DataSourceError as e:
            raise HTTPException(422, str(e))
        except HTTPException:
            raise
        except Exception:
            logger.exception("ui data source %s/%s failed", ui_id, source_id)
            raise HTTPException(502, "The data source failed.")
        return {"sourceId": source_id, "params": params, "data": result}

    @router.get("/img")
    async def image(u: str = "", s: str = ""):
        """An image from an interactive answer, fetched by this instance.

        No cookie check — the sandboxed frame cannot send one. Instead the URL
        must carry the signature render_ui put on it, so only images that were
        part of an answer can be loaded through here."""
        from src.interactive_ui import image_signature_ok

        if not u or not s or not image_signature_ok(u, s):
            raise HTTPException(403, "Unsigned image.")
        if not _image_limiter.check(s):
            raise HTTPException(429, "Too many requests.")
        body, media_type = await fetch_public_image(u, label="UI image")
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": IMAGE_CACHE, **SAFE_HEADERS},
        )

    @router.get("/tiles/{z}/{x}/{tile}")
    async def tile(request: Request, z: int, x: int, tile: str):
        """A map tile, from this instance's cache or fetched once from the
        configured tile server (src/tile_proxy.py). No cookie check — the
        sandboxed frame cannot send one; the route only ever serves tiles of
        the configured server, valid coordinates only, rate-limited per client."""
        from src import tile_proxy

        if not tile.endswith(".png") or not tile[:-4].isdigit():
            raise HTTPException(404, "Not a tile.")
        client = request.client.host if request.client else "?"
        if not _tile_limiter.check(client):
            raise HTTPException(429, "Too many tile requests.")
        origin = f"{request.url.scheme}://{request.url.netloc}"
        try:
            body, etag = await tile_proxy.get_tile(z, x, int(tile[:-4]), origin)
        except tile_proxy.TileError as e:
            raise HTTPException(e.status, str(e))
        headers = {"Cache-Control": f"public, max-age={tile_proxy.CLIENT_MAX_AGE}"}
        if etag:
            headers["ETag"] = etag
        return Response(content=body, media_type="image/png", headers=headers)

    return router
