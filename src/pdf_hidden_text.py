# src/pdf_hidden_text.py
"""Detect and strip *hidden* text from PDFs before it reaches an LLM.

Hidden text — white-on-white, invisible render mode, zero-size fonts,
off-page placement — is the classic PDF prompt-injection channel: extractors
(pypdf, Docling) read it like any other text, so instructions a human never
sees flow straight into chat context and the RAG index.

The detection approach is ported from opendataloader-pdf's
``HiddenTextProcessor`` (Apache-2.0, Hancom Inc.), which flags any text chunk
whose WCAG contrast ratio against the actually-rendered background falls below
**1.2**. That single rendering-based check catches hiding techniques
regardless of *how* the text was hidden (matching fill color, covered by a
shape, drawn over an image of the same color). We add the cheap structural
checks first (invisible render mode, ~zero font size, off-page bbox, zero
alpha) so most malicious objects never need the pixel sampling.

Because extraction happens elsewhere (Docling / pypdf produce the text), the
scan reports the hidden *strings* and ``strip_hidden_text`` removes them from
already-extracted text with whitespace-tolerant matching.

On by default; set ``PDF_HIDDEN_TEXT_FILTER=false`` to disable. Scans at most
``PDF_HIDDEN_TEXT_MAX_PAGES`` (default 300) pages per document. Every entry
point degrades to a no-op on error — the filter must never break ingest.
"""

import ctypes
import logging
import os
import re
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# Same threshold as opendataloader-pdf / veraPDF: below this, text is
# effectively invisible to a human reader.
MIN_CONTRAST_RATIO = 1.2

# PDF text render modes that never paint glyphs.
_INVISIBLE_RENDER_MODES = (3, 7)  # INVISIBLE, CLIP

# Long side of the page render used for background sampling. Small on
# purpose — we sample colors, not glyph shapes.
_RENDER_TARGET_PX = 600.0


def hidden_filter_active() -> bool:
    """On unless explicitly disabled — a security filter that defaults off
    protects nobody. ``PDF_HIDDEN_TEXT_FILTER=false`` (or 0/off/no) disables."""
    val = os.getenv("PDF_HIDDEN_TEXT_FILTER", "true").strip().lower()
    return val not in ("", "0", "false", "off", "no")


def _max_pages() -> int:
    try:
        return max(1, int(os.getenv("PDF_HIDDEN_TEXT_MAX_PAGES", "300") or 300))
    except Exception:
        return 300


# ── WCAG contrast ──


def _srgb_channel(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _relative_luminance(rgb: Tuple[int, int, int]) -> float:
    r, g, b = (_srgb_channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: Tuple[int, int, int], b: Tuple[int, int, int]) -> float:
    """WCAG 2.x contrast ratio between two sRGB colors (1.0 … 21.0)."""
    la, lb = _relative_luminance(a), _relative_luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


# ── pypdfium2 raw-API helpers ──


def _obj_bounds(obj) -> Optional[Tuple[float, float, float, float]]:
    """(left, bottom, right, top) of a page object across pypdfium2 versions
    (``get_pos`` in v4, ``get_bounds`` in v5+)."""
    for name in ("get_pos", "get_bounds"):
        getter = getattr(obj, name, None)
        if getter is not None:
            try:
                left, bottom, right, top = getter()
                return (left, bottom, right, top)
            except Exception:
                return None
    return None


def _object_text(obj, textpage, pdfium_c) -> str:
    """Text content of a text page-object (UTF-16LE via FPDFTextObj_GetText)."""
    if textpage is None:
        return ""
    try:
        n = pdfium_c.FPDFTextObj_GetText(obj.raw, textpage.raw, None, 0)
        if n <= 1:
            return ""
        buf = (ctypes.c_ushort * n)()
        pdfium_c.FPDFTextObj_GetText(obj.raw, textpage.raw, buf, n)
        raw = ctypes.string_at(buf, n * 2)
        return raw.decode("utf-16-le", errors="ignore").rstrip("\x00")
    except Exception:
        return ""


def _text_color(obj, pdfium_c) -> Optional[Tuple[int, int, int, int]]:
    """(r, g, b, alpha) the glyphs are painted with, honoring the render mode
    (stroke-only modes paint with the stroke color, everything else fill)."""
    try:
        mode = pdfium_c.FPDFTextObj_GetTextRenderMode(obj.raw)
    except Exception:
        mode = 0
    getter = (
        pdfium_c.FPDFPageObj_GetStrokeColor if mode in (1, 5) else pdfium_c.FPDFPageObj_GetFillColor
    )
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    try:
        ok = getter(obj.raw, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a))
    except Exception:
        return None
    if not ok:
        return None
    return (r.value, g.value, b.value, a.value)


def _median_color(img, scale: float, page_h: float, bbox, margin: int = 3):
    """Median RGB of the rendered region under/around a text bbox.

    Includes the glyph pixels themselves: for genuinely hidden text they match
    the background anyway, and for visible text glyph coverage stays well under
    half the region, so the median is still the background.
    """
    left, bottom, right, top = bbox
    x0 = int(left * scale) - margin
    x1 = int(right * scale) + margin
    y0 = int((page_h - top) * scale) - margin
    y1 = int((page_h - bottom) * scale) + margin
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, img.width), min(y1, img.height)
    if x1 <= x0 or y1 <= y0:
        return None
    raw = img.crop((x0, y0, x1, y1)).tobytes()  # packed RGB triplets
    mid = (len(raw) // 3) // 2
    return tuple(sorted(raw[i::3])[mid] for i in range(3))


# ── public API ──


def find_hidden_spans(path: str) -> List[str]:
    """Scan a PDF and return the text of every hidden text object."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    spans: List[str] = []
    pdf = pdfium.PdfDocument(path)
    try:
        for i in range(min(len(pdf), _max_pages())):
            page = pdf[i]
            try:
                textpage = page.get_textpage()
            except Exception:
                textpage = None
            page_w, page_h = page.get_size()
            rendered = None  # (PIL image, scale) — rendered lazily, once per page

            for obj in page.get_objects():
                if getattr(obj, "type", None) != pdfium_c.FPDF_PAGEOBJ_TEXT:
                    continue
                text = _object_text(obj, textpage, pdfium_c)
                if not text.strip():
                    continue

                try:
                    mode = pdfium_c.FPDFTextObj_GetTextRenderMode(obj.raw)
                except Exception:
                    mode = 0
                if mode in _INVISIBLE_RENDER_MODES:
                    spans.append(text.strip())
                    continue

                size = ctypes.c_float()
                try:
                    if pdfium_c.FPDFTextObj_GetFontSize(obj.raw, ctypes.byref(size)) and (
                        0 < size.value < 0.5
                    ):
                        spans.append(text.strip())
                        continue
                except Exception:
                    pass

                bounds = _obj_bounds(obj)
                if bounds is None:
                    continue
                left, bottom, right, top = bounds
                if right <= 0 or left >= page_w or top <= 0 or bottom >= page_h:
                    spans.append(text.strip())
                    continue

                color = _text_color(obj, pdfium_c)
                if color is None:
                    continue
                if color[3] == 0:
                    spans.append(text.strip())
                    continue

                # Contrast check against the actually-rendered background.
                try:
                    if rendered is None:
                        scale = _RENDER_TARGET_PX / max(page_w, page_h, 1.0)
                        img = page.render(scale=scale).to_pil().convert("RGB")
                        rendered = (img, scale)
                    bg = _median_color(rendered[0], rendered[1], page_h, (left, bottom, right, top))
                except Exception as e:
                    logger.debug("hidden-text: contrast sampling failed: %s", e)
                    continue
                if bg is not None and contrast_ratio(color[:3], bg) < MIN_CONTRAST_RATIO:
                    spans.append(text.strip())
    finally:
        try:
            pdf.close()
        except Exception:
            pass
    return spans


def strip_hidden_text(text: str, spans: List[str]) -> Tuple[str, int]:
    """Remove every occurrence of the hidden spans from extracted text.

    Matching is whitespace-tolerant because extractors re-flow whitespace:
    the span's tokens must appear in order, separated by any whitespace.
    Returns ``(cleaned_text, occurrences_removed)``.
    """
    removed = 0
    for span in dict.fromkeys(s.strip() for s in spans):
        if len(span) < 3:
            continue  # 1-2 char spans would shred legitimate text
        tokens = span.split()
        pattern = r"[ \t]*" + r"\s+".join(re.escape(t) for t in tokens)
        try:
            text, n = re.subn(pattern, "", text)
        except re.error:
            continue
        removed += n
    return text, removed


def filter_pdf_text(path: str, text: str) -> str:
    """Convenience wrapper: scan ``path`` and strip its hidden spans from
    ``text``. Honors the env toggle and never raises."""
    if not text or not hidden_filter_active():
        return text
    try:
        spans = find_hidden_spans(path)
        if not spans:
            return text
        cleaned, n = strip_hidden_text(text, spans)
        if n:
            logger.warning(
                "hidden text: removed %d hidden span match(es) from %s",
                n,
                os.path.basename(path),
            )
        return cleaned
    except Exception as e:
        logger.warning("hidden-text filter failed for %s: %s", path, e)
        return text
