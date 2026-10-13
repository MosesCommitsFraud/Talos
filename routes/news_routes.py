"""
Thumbnail proxy for the news cards.

The cards want the article images, and the browser must not go and get them.
Rendering a publisher's `img_src` straight into the page means one outbound
request per card, from the user's own IP, carrying their user-agent, to sites
they have not chosen to visit — a chat about a topic becomes a set of hits in
five publishers' logs. So the app fetches the bytes and serves them from its own
origin instead. The publisher sees the Talos server, once, with no referrer.

The fetching itself — SSRF guard, admin domain policy, image-only content type,
size cap, re-validated redirects — lives in src/image_proxy.py, shared with the
images of interactive answers. This route adds what is specific to the cards:
it is authenticated (an open image proxy on the public internet is someone
else's bandwidth and someone else's abuse report).
"""

import logging

from fastapi import APIRouter, Request, Response

from src.auth_helpers import require_user
from src.image_proxy import ALLOWED_TYPES, MAX_BYTES, SAFE_HEADERS, fetch_public_image

logger = logging.getLogger(__name__)

__all__ = ["ALLOWED_TYPES", "MAX_BYTES", "setup_news_routes"]

# Thumbnails for a given article do not change. A day of browser caching keeps a
# reopened chat from re-fetching every image in it.
CACHE_CONTROL = "private, max-age=86400"


def setup_news_routes():
    router = APIRouter(prefix="/api/news", tags=["news"])

    @router.get("/thumbnail")
    async def thumbnail(request: Request, url: str = ""):
        """Fetch one news thumbnail and serve it from this origin."""
        require_user(request)
        body, media_type = await fetch_public_image(url, label="Thumbnail")
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": CACHE_CONTROL, **SAFE_HEADERS},
        )

    return router
