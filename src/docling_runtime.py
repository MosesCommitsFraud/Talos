"""Helpers for the optional Docling document-extraction dependency.

Docling (MIT, IBM) converts a broad range of formats — PDF (incl. scanned, via
OCR), Office, HTML, and standalone images — into structured Markdown, preserving
tables and layout. It is the preferred "ingest anything" extractor; when absent,
callers degrade gracefully and fall back to pypdf / markitdown (see
``src.personal_docs.extract_file_content``). The MIT core never hard-depends on
it. Mirrors the optional-dependency pattern in ``src/markitdown_runtime.py``.

Install with ``pip install -r requirements-optional.txt``.
"""

import logging
import os
import threading

logger = logging.getLogger(__name__)

DOCLING_MISSING = (
    "Rich document/image extraction requires docling. Install optional "
    "dependencies with `pip install -r requirements-optional.txt`."
)

# Formats we route through Docling. This is intentionally broad: it covers the
# formats markitdown/pypdf already handle (so Docling supersedes them when
# installed) plus images, which the legacy text path dropped entirely. Plain
# text / code / json stay on the cheaper built-in reader.
DOCLING_EXTS = frozenset({
    ".pdf",
    ".docx", ".pptx", ".xlsx",
    ".html", ".xhtml",
    ".md", ".adoc", ".asciidoc",
    ".csv",
    ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif",
})

# DocumentConverter loads ML models (layout, OCR) on first use and is expensive
# to construct, so we build it once and reuse it across files.
_converter = None
_converter_lock = threading.Lock()


def is_docling_format(path: str) -> bool:
    """True if the file extension is one we route through Docling."""
    if not isinstance(path, str):
        return False
    return os.path.splitext(path)[1].lower() in DOCLING_EXTS


def load_docling():
    """Return the DocumentConverter class, or raise a user-facing setup hint."""
    try:
        from docling.document_converter import DocumentConverter  # optional dep
    except ImportError as exc:
        raise RuntimeError(DOCLING_MISSING) from exc
    return DocumentConverter


def _get_converter():
    """Lazily build and cache the shared DocumentConverter (thread-safe)."""
    global _converter
    if _converter is not None:
        return _converter
    converter_cls = load_docling()
    with _converter_lock:
        if _converter is None:
            _converter = converter_cls()
    return _converter


def convert_to_markdown(path: str) -> str | None:
    """Convert a document or image to Markdown text via Docling.

    Returns the extracted Markdown, or ``None`` if Docling is unavailable or the
    conversion fails — callers degrade gracefully rather than erroring.
    """
    try:
        converter = _get_converter()
    except RuntimeError:
        logger.warning("docling not installed; cannot extract %s", path)
        return None
    try:
        result = converter.convert(path)
        return result.document.export_to_markdown()
    except Exception as e:
        logger.warning("docling failed to convert %s: %s", path, e)
        return None
