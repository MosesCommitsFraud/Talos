"""
tile_proxy.py — map tiles for interactive answers, fetched and cached by Talos.

Maps in the chat (talos.map / Leaflet in a sandboxed frame) do not load tiles
from the tile server directly. They load them from this instance, which fetches
each tile once, keeps it on disk and serves it to every user. This is what the
OpenStreetMap tile usage policy (operations.osmfoundation.org/policies/tiles)
asks of an application, and what a browser-side setup cannot deliver here:

  * Caching. The frame has an opaque origin; browsers do not reliably keep its
    requests in their HTTP cache, so every view, rebuild and full-screen copy
    would fetch every tile again. Here a tile is fetched once per instance and
    kept as long as the server's caching headers allow — at least 7 days when
    they say nothing — and refreshed with conditional requests (ETag /
    Last-Modified), so an unchanged tile costs a 304.
  * Identification. Requests carry a stable User-Agent naming Talos (plus a
    contact, when configured) and a Referer with this instance's origin —
    never a stripped Referer, never a library default.
  * No prefetching. Only the tiles a viewer's map asks for are fetched; the
    frame keeps Leaflet's look-ahead to one ring of tiles.

As a side effect the users' IP addresses no longer reach the tile server.

Only the configured tile server is proxied (`ui_map_tile_url`, an https URL
template), only valid z/x/y coordinates up to the configured zoom, rate-limited
per client. The cache is bounded (`ui_map_cache_mb`) and trims the least
recently used tiles.
"""

from __future__ import annotations

import asyncio
import email.utils
import json
import logging
import os
import re
import time
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# The policy's floor when the server's caching headers cannot be used.
MIN_TTL_SECONDS = 7 * 24 * 3600
# What the browser is told. Short: the instance cache is the real cache.
CLIENT_MAX_AGE = 24 * 3600
TIMEOUT = 15.0
MAX_TILE_BYTES = 2_000_000
_PRUNE_EVERY = 200

_locks: Dict[str, asyncio.Lock] = {}
_writes_since_prune = 0


class TileError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def cache_dir() -> str:
    from src.constants import DATA_DIR

    return os.path.join(DATA_DIR, "tile_cache")


def _setting(key: str, default):
    try:
        from src.settings import get_setting

        value = get_setting(key, default)
        return default if value in (None, "") else value
    except Exception:
        return default


def user_agent() -> str:
    """Stable and specific, as the policy requires — never a library default."""
    try:
        from core.constants import APP_VERSION
    except Exception:
        APP_VERSION = "dev"
    contact = str(_setting("ui_map_contact", "") or _setting("app_public_url", "")).strip()
    base = f"Talos/{APP_VERSION} (self-hosted AI assistant; map tiles for chat answers"
    return f"{base}; +{contact})" if contact else f"{base})"


def referer(request_origin: str) -> str:
    """This instance's origin: the configured public URL, else the origin the
    browser used. Origin only, never a path."""
    public = str(_setting("app_public_url", "")).strip()
    origin = public or request_origin
    m = re.match(r"^(https?://[^/]+)", origin or "")
    return (m.group(1) + "/") if m else ""


def _paths(z: int, x: int, y: int) -> Tuple[str, str]:
    folder = os.path.join(cache_dir(), str(z), str(x))
    return os.path.join(folder, f"{y}.png"), os.path.join(folder, f"{y}.json")


def _read_meta(path: str) -> Dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _ttl(headers) -> int:
    """Seconds the server allows the tile to be reused; MIN_TTL when it says
    nothing usable. `no-store`/`no-cache` from the server are honoured as 0
    (revalidate every time)."""
    cc = (headers.get("cache-control") or "").lower()
    if "no-store" in cc or "no-cache" in cc:
        return 0
    m = re.search(r"max-age=(\d+)", cc)
    if m:
        return int(m.group(1))
    expires = headers.get("expires")
    if expires:
        try:
            when = email.utils.parsedate_to_datetime(expires).timestamp()
            return max(0, int(when - time.time()))
        except (TypeError, ValueError):
            pass
    return MIN_TTL_SECONDS


def validate(z: int, x: int, y: int, max_zoom: int) -> None:
    if not (0 <= z <= max_zoom):
        raise TileError(404, "Zoom out of range.")
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        raise TileError(404, "Tile out of range.")


async def get_tile(z: int, x: int, y: int, request_origin: str) -> Tuple[bytes, str]:
    """(png bytes, etag) — from the cache when fresh, else from the tile server."""
    from src.interactive_ui import map_config

    cfg = map_config()
    upstream = cfg.get("upstream") or ""
    if not cfg.get("enabled") or not upstream:
        raise TileError(404, "Maps are disabled.")
    validate(z, x, y, int(cfg.get("maxZoom") or 19))

    tile_path, meta_path = _paths(z, x, y)
    key = f"{z}/{x}/{y}"
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        meta = _read_meta(meta_path)
        cached = os.path.isfile(tile_path)
        if cached and meta.get("expires_at", 0) > time.time():
            _touch(tile_path)
            return _read(tile_path), meta.get("etag") or ""
        try:
            body, meta = await _fetch(upstream, z, x, y, meta if cached else {}, request_origin)
        except TileError:
            if cached:  # stale beats nothing when the tile server is unreachable
                return _read(tile_path), meta.get("etag") or ""
            raise
        if body is None:  # 304: still valid
            _write_meta(meta_path, meta)
            _touch(tile_path)
            return _read(tile_path), meta.get("etag") or ""
        os.makedirs(os.path.dirname(tile_path), exist_ok=True)
        tmp = tile_path + ".part"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, tile_path)
        _write_meta(meta_path, meta)
        _after_write()
        return body, meta.get("etag") or ""


async def _fetch(upstream: str, z: int, x: int, y: int, meta: Dict, request_origin: str):
    import httpx

    url = upstream.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    url = url.replace("{s}", "a")
    headers = {"User-Agent": user_agent(), "Accept": "image/png,image/*;q=0.8"}
    ref = referer(request_origin)
    if ref:
        headers["Referer"] = ref
    if meta.get("etag"):
        headers["If-None-Match"] = meta["etag"]
    if meta.get("last_modified"):
        headers["If-Modified-Since"] = meta["last_modified"]
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, follow_redirects=False, http2=False
        ) as client:
            res = await client.get(url, headers=headers)
    except httpx.HTTPError as e:
        logger.info("Tile fetch failed (%s): %s", key_of(z, x, y), e)
        raise TileError(502, "The tile server did not respond.")
    if res.status_code == 304 and meta:
        meta = {**meta, "expires_at": time.time() + max(_ttl(res.headers), 0)}
        return None, meta
    if res.status_code != 200:
        logger.info("Tile server answered %s for %s", res.status_code, key_of(z, x, y))
        raise TileError(502 if res.status_code >= 500 else 404, "Tile not available.")
    ctype = (res.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not ctype.startswith("image/") or len(res.content) > MAX_TILE_BYTES:
        raise TileError(502, "The tile server sent something that is not a tile.")
    return res.content, {
        "etag": res.headers.get("etag") or "",
        "last_modified": res.headers.get("last-modified") or "",
        "expires_at": time.time() + _ttl(res.headers),
        "fetched_at": time.time(),
    }


def key_of(z: int, x: int, y: int) -> str:
    return f"{z}/{x}/{y}"


def _read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _write_meta(path: str, meta: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f)


def _touch(path: str) -> None:
    """Mark as recently used (the trim removes the least recently used)."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _after_write() -> None:
    global _writes_since_prune
    _writes_since_prune += 1
    if _writes_since_prune >= _PRUNE_EVERY:
        _writes_since_prune = 0
        try:
            prune()
        except Exception:
            logger.exception("tile cache prune failed")


def prune(limit_mb: Optional[int] = None) -> int:
    """Trim the cache to its size limit, least recently used first. Returns the
    number of tiles removed."""
    limit = (
        int(limit_mb if limit_mb is not None else _setting("ui_map_cache_mb", 1024)) * 1024 * 1024
    )
    tiles = []
    total = 0
    for root, _dirs, files in os.walk(cache_dir()):
        for name in files:
            if not name.endswith(".png"):
                continue
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            tiles.append((st.st_mtime, st.st_size, path))
            total += st.st_size
    if total <= limit:
        return 0
    removed = 0
    target = int(limit * 0.9)
    for _mtime, size, path in sorted(tiles):
        if total <= target:
            break
        for p in (path, path[:-4] + ".json"):
            try:
                os.remove(p)
            except OSError:
                pass
        total -= size
        removed += 1
    return removed
