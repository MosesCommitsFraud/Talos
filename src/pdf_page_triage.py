# src/pdf_page_triage.py
"""Per-page visual triage for the PDF VLM lane.

Decides, from pypdfium2 page objects alone (no rendering, ~ms per page),
whether a page carries visual content the vision model should read. The
raster-image-coverage rule matches the lane's original behavior; the two new
rules are ported from opendataloader-pdf's ``TriageProcessor`` (Apache-2.0,
Hancom Inc.), which tuned them experimentally for table/chart detection:

* **vector graphics** — charts, diagrams, and line-art drawn as PDF *path*
  objects contain no image XObjects at all, so image-area triage never sees
  them and Docling's OCR reads only their stray labels. Many small-ish paths
  covering a meaningful share of the page is the signal.
* **wide images** — a raster image covering as little as 11% of the page but
  with a chart/table-like aspect ratio (≥ 1.75 wide) is usually a figure worth
  transcribing even though it misses the whole-page coverage threshold.

The triage is deliberately conservative in the same direction as upstream:
false positives cost one extra VLM call; false negatives lose content.

Env knobs:
    PDF_VLM_PAGE_RATIO         image/path coverage threshold (default 0.35)
    PDF_VLM_MIN_PATHS          path-object count to arm the vector rule
                               (default 24; 0 or negative disables the rule)
    PDF_VLM_WIDE_IMAGE_RATIO   wide-image area threshold (default 0.11)
    PDF_VLM_WIDE_IMAGE_ASPECT  width/height ratio for "wide" (default 1.75)
"""

import logging
import os
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def _fenv(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)) or default)
    except Exception:
        return default


def _ienv(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)) or default)
    except Exception:
        return default


def page_ratio_threshold() -> float:
    """Coverage threshold shared by the image-area and vector-graphics rules."""
    return _fenv("PDF_VLM_PAGE_RATIO", 0.35)


def _obj_bounds(obj):
    """(left, bottom, right, top) across pypdfium2 versions (``get_pos`` in
    v4, ``get_bounds`` in v5+). Raises if neither getter works so callers keep
    their existing conservative except-paths."""
    getter = getattr(obj, "get_pos", None) or getattr(obj, "get_bounds")
    left, bottom, right, top = getter()
    return (left, bottom, right, top)


def page_signals(page, pdfium_c) -> Dict[str, float]:
    """One cheap pass over a page's objects → visual signals for triage.

    Failure modes stay conservative, mirroring the lane's previous inline
    logic: an image whose extent can't be read counts as full-page; a page
    whose objects can't be introspected at all is reported as fully covered
    by images (so it gets sent to vision rather than silently dropped).

    Paths whose bbox covers ≥ 90% of the page are ignored — those are page
    background/border rectangles, not content, and would otherwise make every
    styled page look like a diagram.
    """
    w, h = page.get_size()
    page_area = (w * h) or 1.0
    img_area = 0.0
    path_area = 0.0
    img_count = 0
    path_count = 0
    wide_img_ratio = 0.0
    wide_aspect = _fenv("PDF_VLM_WIDE_IMAGE_ASPECT", 1.75)

    try:
        for obj in page.get_objects():
            obj_type = getattr(obj, "type", None)
            if obj_type == pdfium_c.FPDF_PAGEOBJ_IMAGE:
                img_count += 1
                try:
                    left, bottom, right, top = _obj_bounds(obj)
                    area = abs((right - left) * (top - bottom))
                    img_area += area
                    width, height = abs(right - left), abs(top - bottom)
                    if height > 0 and (width / height) >= wide_aspect:
                        wide_img_ratio = max(wide_img_ratio, area / page_area)
                except Exception:
                    img_area += page_area  # unknown extent → assume full
            elif obj_type == pdfium_c.FPDF_PAGEOBJ_PATH:
                try:
                    left, bottom, right, top = _obj_bounds(obj)
                    area = abs((right - left) * (top - bottom))
                except Exception:
                    continue
                if area >= 0.9 * page_area:
                    continue
                path_count += 1
                path_area += min(area, page_area)
    except Exception:
        img_area = page_area  # can't introspect → treat as image page

    return {
        "img_ratio": min(img_area / page_area, 1.0),
        "img_count": img_count,
        "path_count": path_count,
        "path_ratio": min(path_area / page_area, 1.0),
        "wide_img_ratio": min(wide_img_ratio, 1.0),
    }


def is_image_dominant(signals: Dict[str, float], page_thr: Optional[float] = None) -> bool:
    """True when raster images alone cover the page (scan/screenshot page).

    This is the *only* signal that may count toward the doc-level "mostly
    image" classification, which discards Docling text for the whole file.
    The wide-image and vector-graphics rules mark pages worth an extra vision
    pass, but a page full of tables or with an embedded 16:9 screenshot is
    still a text page — feeding those rules into the doc-level ratio made
    ordinary text documents lose their entire text lane.
    """
    thr = page_ratio_threshold() if page_thr is None else page_thr
    return signals["img_ratio"] >= thr


def is_visually_heavy(signals: Dict[str, float], page_thr: Optional[float] = None) -> bool:
    """True when a page should be rendered and sent to the vision model."""
    thr = page_ratio_threshold() if page_thr is None else page_thr
    if signals["img_ratio"] >= thr:
        return True
    if signals["wide_img_ratio"] >= _fenv("PDF_VLM_WIDE_IMAGE_RATIO", 0.11):
        return True
    min_paths = _ienv("PDF_VLM_MIN_PATHS", 24)
    if min_paths > 0 and signals["path_count"] >= min_paths and signals["path_ratio"] >= thr:
        return True
    return False
