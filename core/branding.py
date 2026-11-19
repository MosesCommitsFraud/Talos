"""Per-deployment branding profiles (name + logos).

The code base stays "Talos"; a deployment picks a profile with
``TALOS_BRAND=<profile>`` in .env. A profile is a folder holding an optional
``brand.json`` (``{"name": "..."}``) plus optional ``logo-small.*`` (favicon,
chat marker, home screen) and ``logo-large.*`` (login screen, sidebar header).
Anything a profile leaves out falls back to the built-in Talos defaults.

Without ``TALOS_BRAND`` the profile is ``talos``, unless the checkout itself
ships exactly one profile under ``branding/``: a copy of the code that carries
a single brand shows that brand with no configuration. An unknown or invalid
name falls back the same way.

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
_PROFILE_NAME = re.compile(r"[a-z0-9_-]+")


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


def _profile_folder(profile: str) -> str | None:
    return next(
        (
            os.path.join(root, profile)
            for root in _SEARCH_ROOTS
            if os.path.isdir(os.path.join(root, profile))
        ),
        None,
    )


def _default_profile() -> str:
    """The profile used when TALOS_BRAND names none.

    Only the checkout's own ``branding/`` counts (the last search root): a
    host-only folder under ``data/branding`` is something an admin picks with
    TALOS_BRAND, it must not change what an unconfigured instance shows.
    """
    try:
        shipped = [
            name
            for name in os.listdir(_SEARCH_ROOTS[-1])
            if _PROFILE_NAME.fullmatch(name)
            and os.path.isdir(os.path.join(_SEARCH_ROOTS[-1], name))
        ]
    except OSError:
        shipped = []
    return shipped[0] if len(shipped) == 1 else "talos"


@lru_cache(maxsize=1)
def get_brand() -> Brand:
    default = _default_profile()
    profile = (os.getenv("TALOS_BRAND") or default).strip().lower()
    if not _PROFILE_NAME.fullmatch(profile):
        logger.warning("TALOS_BRAND=%r is not a valid profile name — using %s", profile, default)
        profile = default
    folder = _profile_folder(profile)
    if folder is None and profile != default:
        logger.warning("Branding profile %r not found — using %s", profile, default)
        profile, folder = default, _profile_folder(default)
    if folder is None:
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
