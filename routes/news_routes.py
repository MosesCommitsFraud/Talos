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

The icons of cited web pages go the same way, for the same reason: a list of
sources that loaded each site's favicon from the browser would tell every one
of those sites that this user's answer cited it.
"""

import logging
import re

from fastapi import APIRouter, HTTPException, Request, Response

from src.auth_helpers import require_user
from src.image_proxy import ALLOWED_TYPES, MAX_BYTES, SAFE_HEADERS, fetch_public_image

logger = logging.getLogger(__name__)

__all__ = ["ALLOWED_TYPES", "MAX_BYTES", "setup_news_routes"]

# Thumbnails for a given article do not change. A day of browser caching keeps a
# reopened chat from re-fetching every image in it.
CACHE_CONTROL = "private, max-age=86400"

# A site's icon changes about as often as its logo.
FAVICON_CACHE_CONTROL = "private, max-age=604800"

# What a favicon may be on top of the photo formats: the .ico container, under
# either of the two names servers give it. Still no SVG.
FAVICON_TYPES = ALLOWED_TYPES | {"image/x-icon", "image/vnd.microsoft.icon"}

# A bare DNS name: labels of letters, digits and hyphens, and a last label that
# is a word (or punycode) — so no scheme, port, path, credentials or IP address
# can ride in on the `host` parameter. Where the name resolves to is checked by
# the fetch itself.
_HOST_NAME = re.compile(
    r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$"
)


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

    @router.get("/favicon")
    async def favicon(request: Request, host: str = ""):
        """Fetch the icon of a cited site and serve it from this origin. Only the
        host name comes from the caller; the path is always /favicon.ico."""
        require_user(request)
        name = (host or "").strip().lower().rstrip(".")
        if not _HOST_NAME.match(name):
            raise HTTPException(400, "Not a host name.")
        body, media_type = await fetch_public_image(
            f"https://{name}/favicon.ico", label="Favicon", allowed_types=FAVICON_TYPES
        )
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": FAVICON_CACHE_CONTROL, **SAFE_HEADERS},
        )

    return router
