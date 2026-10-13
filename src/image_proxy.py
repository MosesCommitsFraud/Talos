"""
image_proxy.py — fetch one public image on behalf of the browser.

Shared by the news thumbnails (routes/news_routes.py) and the images in
interactive answers (routes/ui_routes.py). The browser must not fetch
third-party images itself: that is one request per image from the user's own
IP, carrying their user-agent, to hosts they never chose to visit. So the app
fetches the bytes and serves them from its own origin.

Written as if the URL were hostile, because it is — it comes from a search
result or from model output, not from anything the user typed:

  * the same SSRF guard and admin domain policy as web_fetch (the app sits on a
    network that can reach vLLM, Qdrant, Redis and the LAN);
  * only images, verified on the RESPONSE content-type, size-capped;
  * redirects re-validated hop by hop.
"""

import logging
from typing import Tuple
from urllib.parse import urlparse

from fastapi import HTTPException

logger = logging.getLogger(__name__)

TIMEOUT = 10.0
MAX_BYTES = 3_000_000
MAX_REDIRECTS = 3

# Checked against the RESPONSE, never the URL's extension: ".jpg" in a path is a
# claim by whoever wrote the link.
ALLOWED_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
}

# Headers for serving the bytes back: third-party content, not inspected beyond
# its content-type — never sniffed into something executable, never framed.
SAFE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


async def fetch_public_image(url: str, label: str = "Image") -> Tuple[bytes, str]:
    """Return (bytes, media_type) or raise HTTPException with a client-safe
    message. `label` only prefixes log lines."""
    import httpx

    from src.web_search import _validate_fetch_url

    url = (url or "").strip()
    if not url:
        raise HTTPException(400, "Missing `url`.")
    if len(url) > 2048:
        raise HTTPException(400, "URL too long.")

    # Same validation web_fetch applies: scheme, host, admin domain policy,
    # and a DNS check that every address it resolves to is publicly routable.
    error = _validate_fetch_url(url)
    if error:
        logger.info("%s refused: %s", label, error)
        raise HTTPException(403, "This image may not be loaded.")

    current = url
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
            for _hop in range(MAX_REDIRECTS + 1):
                response = await client.get(
                    current,
                    headers={
                        "Accept": "image/*",
                        # No Referer: the host does not need to be told which
                        # page asked for this.
                        "User-Agent": "Mozilla/5.0 (compatible; Talos/1.0)",
                    },
                )
                if response.status_code not in (301, 302, 303, 307, 308):
                    break
                location = response.headers.get("location")
                if not location:
                    raise HTTPException(502, "Redirect without a target.")
                current = str(httpx.URL(current).join(location))
                # A redirect is a second URL, chosen by the first one's owner.
                # It gets the full check again — otherwise an image host
                # redirecting to 127.0.0.1 walks straight past the guard above.
                hop_error = _validate_fetch_url(current)
                if hop_error:
                    logger.info("%s redirect refused: %s", label, hop_error)
                    raise HTTPException(403, "This image may not be loaded.")
            else:
                raise HTTPException(502, "Too many redirects.")

            if response.status_code >= 400:
                raise HTTPException(502, "The image could not be fetched.")

            raw_type = response.headers.get("content-type") or ""
            media_type = raw_type.split(";")[0].strip().lower()
            if media_type not in ALLOWED_TYPES:
                logger.info(
                    "%s rejected: content-type %r from %s",
                    label,
                    media_type,
                    urlparse(current).hostname,
                )
                raise HTTPException(415, "Not an image.")

            body = response.content
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        logger.info("%s fetch failed for %s: %s", label, urlparse(current).hostname, e)
        raise HTTPException(502, "The image could not be fetched.")

    if len(body) > MAX_BYTES:
        raise HTTPException(413, "Image too large.")
    return body, media_type
