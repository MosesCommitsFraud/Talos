"""
Thumbnail proxy for the news cards.

The cards want the article images, and the browser must not go and get them.
Rendering a publisher's `img_src` straight into the page means one outbound
request per card, from the user's own IP, carrying their user-agent, to sites
they have not chosen to visit — a chat about a topic becomes a set of hits in
five publishers' logs. So the app fetches the bytes and serves them from its own
origin instead. The publisher sees the Talos server, once, with no referrer.

It is a proxy for exactly one job, and it is written as if the URL were hostile,
because it is: the URL arrives from a search engine's result set, not from
anything a user typed.

  * The same SSRF guard and admin domain policy as web_fetch. The app sits on a
    network that can reach vLLM, Qdrant, Redis and the LAN — an `img_src` of
    ``http://qdrant:6333/collections`` must not turn this into a window onto it.
  * Authenticated. An open image proxy on the public internet is someone else's
    bandwidth and someone else's abuse report.
  * Only images, verified on the RESPONSE content-type, and size-capped while
    streaming rather than trusted from Content-Length.
  * No redirects followed to a different host without re-validating.
"""

import logging
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request, Response

from src.auth_helpers import require_user

logger = logging.getLogger(__name__)

TIMEOUT = 10.0
# Comfortably above a news thumbnail (typically 10-80 KB) and far below anything
# worth proxying by accident.
MAX_BYTES = 3_000_000
MAX_REDIRECTS = 3

# Checked against the RESPONSE, never the URL's extension: ".jpg" in a path is a
# claim by whoever wrote the link, and this one came off a search engine.
ALLOWED_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
}

# Thumbnails for a given article do not change. A day of browser caching keeps a
# reopened chat from re-fetching every image in it.
CACHE_CONTROL = "private, max-age=86400"


def setup_news_routes():
    router = APIRouter(prefix="/api/news", tags=["news"])

    @router.get("/thumbnail")
    async def thumbnail(request: Request, url: str = ""):
        """Fetch one news thumbnail and serve it from this origin."""
        import httpx

        from src.web_search import _validate_fetch_url

        require_user(request)

        url = (url or "").strip()
        if not url:
            raise HTTPException(400, "Missing `url`.")
        if len(url) > 2048:
            raise HTTPException(400, "URL too long.")

        # Same validation web_fetch applies: scheme, host, admin domain policy,
        # and a DNS check that every address it resolves to is publicly routable.
        error = _validate_fetch_url(url)
        if error:
            logger.info("Thumbnail refused: %s", error)
            raise HTTPException(403, "This image may not be loaded.")

        current = url
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
                for _hop in range(MAX_REDIRECTS + 1):
                    response = await client.get(
                        current,
                        headers={
                            "Accept": "image/*",
                            # No Referer: the publisher does not need to be told
                            # which page asked for this.
                            "User-Agent": "Mozilla/5.0 (compatible; Talos/1.0)",
                        },
                    )
                    if response.status_code not in (301, 302, 303, 307, 308):
                        break
                    location = response.headers.get("location")
                    if not location:
                        raise HTTPException(502, "Redirect without a target.")
                    current = str(httpx.URL(current).join(location))
                    # A redirect is a second URL, chosen by the first one's
                    # owner. It gets the full check again — otherwise an image
                    # host redirecting to 127.0.0.1 walks straight past the
                    # guard above.
                    hop_error = _validate_fetch_url(current)
                    if hop_error:
                        logger.info("Thumbnail redirect refused: %s", hop_error)
                        raise HTTPException(403, "This image may not be loaded.")
                else:
                    raise HTTPException(502, "Too many redirects.")

                if response.status_code >= 400:
                    raise HTTPException(502, "The image could not be fetched.")

                raw_type = response.headers.get("content-type") or ""
                media_type = raw_type.split(";")[0].strip().lower()
                if media_type not in ALLOWED_TYPES:
                    logger.info(
                        "Thumbnail rejected: content-type %r from %s",
                        media_type,
                        urlparse(current).hostname,
                    )
                    raise HTTPException(415, "Not an image.")

                body = response.content
        except HTTPException:
            raise
        except httpx.HTTPError as e:
            logger.info("Thumbnail fetch failed for %s: %s", urlparse(current).hostname, e)
            raise HTTPException(502, "The image could not be fetched.")

        if len(body) > MAX_BYTES:
            raise HTTPException(413, "Image too large.")

        return Response(
            content=body,
            media_type=media_type,
            headers={
                "Cache-Control": CACHE_CONTROL,
                # The bytes are third-party and were not inspected beyond their
                # content-type. Never let a browser sniff them into something
                # executable, and never let them be framed.
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        )

    return router
