"""Per-deployment branding profiles (name + logos).

The code base stays "Talos"; a deployment picks a profile with
``TALOS_BRAND=<profile>`` in .env. A profile is a folder holding an optional
``brand.json`` (``{"name": "..."}``) plus optional ``logo-small.*`` (favicon,
chat marker, home screen) and ``logo-large.*`` (login screen, sidebar header).
Anything a profile leaves out falls back to the built-in Talos defaults, so an
unset or unknown profile renders exactly like stock Talos.

Profiles are looked up in ``data/branding/<profile>`` first (host-only, never
committed) and then in the repo's ``branding/<profile>``.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache

logger = logging.getLogger(__name__)

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SEARCH_ROOTS = (
    os.path.join(_BASE_DIR, "data", "branding"),
    os.path.join(_BASE_DIR, "branding"),
)
LOGO_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
}
DEFAULT_NAME = "Talos"


@dataclass(frozen=True)
class Brand:
    profile: str
    name: str
    logo_small: str | None  # absolute file path, or None for the built-in mark
    logo_large: str | None


def _find_logo(folder: str, stem: str) -> str | None:
    for ext in LOGO_TYPES:
        path = os.path.join(folder, stem + ext)
        if os.path.isfile(path):
            return path
    return None


@lru_cache(maxsize=1)
def get_brand() -> Brand:
    profile = (os.getenv("TALOS_BRAND") or "talos").strip().lower()
    if not re.fullmatch(r"[a-z0-9_-]+", profile):
        logger.warning("TALOS_BRAND=%r is not a valid profile name — using talos", profile)
        profile = "talos"
    folder = next(
        (
            os.path.join(root, profile)
            for root in _SEARCH_ROOTS
            if os.path.isdir(os.path.join(root, profile))
        ),
        None,
    )
    if folder is None:
        if profile != "talos":
            logger.warning("Branding profile %r not found — using Talos defaults", profile)
        return Brand("talos", DEFAULT_NAME, None, None)

    name = DEFAULT_NAME
    meta_path = os.path.join(folder, "brand.json")
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                name = str(json.load(f).get("name") or DEFAULT_NAME).strip() or DEFAULT_NAME
        except (OSError, ValueError) as e:
            logger.warning("Could not read %s: %s", meta_path, e)

    brand = Brand(profile, name, _find_logo(folder, "logo-small"), _find_logo(folder, "logo-large"))
    logger.info(
        "Branding: profile=%s name=%r small_logo=%s large_logo=%s",
        brand.profile,
        brand.name,
        bool(brand.logo_small),
        bool(brand.logo_large),
    )
    return brand


def brand_public() -> dict:
    """What the web UI needs; embedded into index.html as a <meta> tag."""
    b = get_brand()
    return {
        "name": b.name,
        "logoSmall": "/branding/logo-small" if b.logo_small else None,
        "logoLarge": "/branding/logo-large" if b.logo_large else None,
    }
