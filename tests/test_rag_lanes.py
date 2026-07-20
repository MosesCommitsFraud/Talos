"""Unit tests for the RAG modality router and the opt-in ASR gate.

These exercise pure routing/gating logic only — the heavy Haystack/Docling
imports live inside the lane handlers and are never reached here, so the tests
run without the optional RAG dependencies installed.
"""

import base64
import importlib

import pytest

rv = importlib.import_module("src.rag_vector")


class _Router:
    """Minimal stand-in so we can call the unbound ``_documents_for_file`` and
    record which lane it dispatches to, without building a real VectorRAG (which
    would require a live Qdrant + embedding endpoint)."""

    def __init__(self):
        self.calls = []

    def _lane_av(self, path, meta, stage_cb=None):
        self.calls.append("av")
        return []

    def _lane_docling(self, path):
        self.calls.append("docling")
        return []

    def _lane_text(self, path):
        self.calls.append("text")
        return []

    # Post-dispatch steps `_documents_for_file` always runs — no-ops on the stub.
    def _assign_sections(self, docs):
        pass

    def _apply_contextual(self, docs):
        pass

    def _apply_autokeywords(self, docs):
        pass


def _route(path):
    r = _Router()
    rv.VectorRAG._documents_for_file(r, path, {})
    return r.calls[0]


def test_router_picks_av():
    assert _route("lesson.mp4") == "av"
    assert _route("podcast.mp3") == "av"


def test_router_picks_docling():
    assert _route("manual.pdf") == "docling"
    assert _route("screenshot.png") == "docling"


def test_router_picks_text():
    assert _route("module.py") == "text"
    assert _route("notes.txt") == "text"


def test_av_exts_cover_common_formats():
    for ext in (".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a"):
        assert ext in rv._AV_EXTS


def test_asr_inactive_by_default(monkeypatch):
    monkeypatch.delenv("VIDEO_ASR_ENABLED", raising=False)
    monkeypatch.delenv("VIDEO_ASR_URL", raising=False)
    assert rv._asr_active() is False


def test_asr_requires_both_toggle_and_url(monkeypatch):
    monkeypatch.setenv("VIDEO_ASR_ENABLED", "true")
    monkeypatch.delenv("VIDEO_ASR_URL", raising=False)
    assert rv._asr_active() is False  # toggle on but no endpoint
    monkeypatch.setenv("VIDEO_ASR_URL", "http://video-asr:8003/transcribe")
    assert rv._asr_active() is True


def test_av_lane_skips_when_disabled(monkeypatch):
    """An AV file with ASR off raises a clear message (so the queue shows why),
    and never reaches the network — proving the default stack is untouched."""
    monkeypatch.setenv("VIDEO_ASR_ENABLED", "")
    monkeypatch.delenv("VIDEO_ASR_URL", raising=False)

    class _Dummy:
        pass

    with pytest.raises(RuntimeError, match="ASR is disabled"):
        rv.VectorRAG._lane_av(_Dummy(), "clip.mp4", {})


def test_vllm_asr_helpers_normalize_language_and_segments():
    assert rv._asr_language_code("German") == "de"
    assert rv._asr_language_code("English") == "en"
    assert rv._asr_segments(
        {"segments": [{"start": 1, "end": 2.5, "text": " hello "}, {"text": ""}]}
    ) == [{"start": 1.0, "end": 2.5, "text": "hello"}]
    assert rv._asr_segments({"text": "full transcript"}) == [
        {"start": 0.0, "end": 0.0, "text": "full transcript"}
    ]


# ── Video keyframe lane gating ──


def test_keyframes_inactive_by_default(monkeypatch):
    monkeypatch.delenv("VIDEO_FRAMES_ENABLED", raising=False)
    monkeypatch.delenv("VLM_URL", raising=False)
    assert rv._keyframes_active() is False


def test_keyframes_require_both_toggle_and_vlm_url(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAMES_ENABLED", "true")
    monkeypatch.delenv("VLM_URL", raising=False)
    assert rv._keyframes_active() is False  # toggle on but no vision endpoint
    monkeypatch.setenv("VLM_URL", "http://192.168.10.91:8000/v1/chat/completions")
    assert rv._keyframes_active() is True


def test_video_exts_subset_of_av():
    assert rv._VIDEO_EXTS < rv._AV_EXTS
    assert ".mp3" not in rv._VIDEO_EXTS


def test_extract_video_keyframes_skips_audio_and_never_raises(monkeypatch):
    """Best-effort lane: audio files yield no keyframes, and an extraction
    failure yields [] instead of breaking the ASR ingest."""

    class _Dummy:
        _vlm_detect_region = None

    assert rv.VectorRAG._extract_video_keyframes(_Dummy(), "talk.mp3", {}) == []

    import src.video_frames as vf

    def _boom(*a, **k):
        raise RuntimeError("decoder exploded")

    monkeypatch.setattr(vf, "extract_keyframes", _boom)
    assert rv.VectorRAG._extract_video_keyframes(_Dummy(), "clip.mp4", {}) == []


def test_vlm_detect_region_parses_and_rejects(monkeypatch):
    from PIL import Image

    img = Image.new("RGB", (16, 9), (0, 0, 0))

    def _region(answer):
        class _Stub:
            _VLM_REGION_PROMPT = rv.VectorRAG._VLM_REGION_PROMPT

            def _vlm_transcribe_image(self, b64, prompt=None):
                return answer

        return rv.VectorRAG._vlm_detect_region(_Stub(), img)

    assert _region('{"x1": 0, "y1": 0, "x2": 750, "y2": 1000}') == (0.0, 0.0, 0.75, 1.0)
    # Values clamp into range; prose around the JSON is tolerated.
    assert _region('The box is {"x1": -5, "y1": 0, "x2": 1200, "y2": 1000} roughly.') == (
        0.0,
        0.0,
        1.0,
        1.0,
    )
    assert _region("no json here") is None
    assert _region('{"x1": 0, "y1": 0}') is None  # missing keys
    assert _region('{"x1": 0, "y1": 0, "x2": 100, "y2": 100}') is None  # box too small


# ── Document vision (VLM) lane gating ──


def test_pdf_vlm_inactive_by_default(monkeypatch):
    monkeypatch.delenv("PDF_VLM_ENABLED", raising=False)
    monkeypatch.delenv("VLM_URL", raising=False)
    assert rv._pdf_vlm_active() is False


def test_pdf_vlm_requires_both_toggle_and_url(monkeypatch):
    monkeypatch.setenv("PDF_VLM_ENABLED", "true")
    monkeypatch.delenv("VLM_URL", raising=False)
    assert rv._pdf_vlm_active() is False  # toggle on but no endpoint
    monkeypatch.setenv("VLM_URL", "http://192.168.10.91:8000/v1/chat/completions")
    assert rv._pdf_vlm_active() is True


def test_vlm_doc_exts_cover_pdf_and_office():
    assert rv._VLM_DOC_EXTS == {".pdf", ".docx", ".pptx"}


def test_vlm_chat_url_normalizes_base_and_full(monkeypatch):
    class _Dummy:
        pass

    monkeypatch.setenv("VLM_URL", "http://host:8000/v1")
    assert rv.VectorRAG._vlm_chat_url(_Dummy()) == "http://host:8000/v1/chat/completions"
    monkeypatch.setenv("VLM_URL", "http://host:8000/v1/chat/completions")
    assert rv.VectorRAG._vlm_chat_url(_Dummy()) == "http://host:8000/v1/chat/completions"
    monkeypatch.setenv("VLM_URL", "http://host:8000")
    assert rv.VectorRAG._vlm_chat_url(_Dummy()) == "http://host:8000/v1/chat/completions"


def test_router_uses_vlm_lane_only_for_image_bearing_docs(monkeypatch):
    """With the VLM lane on, an image-bearing PDF/Office routes to vision; a
    text-only one (no images detected) stays on Docling."""
    monkeypatch.setenv("PDF_VLM_ENABLED", "true")
    monkeypatch.setenv("VLM_URL", "http://host:8000/v1/chat/completions")

    class _R:
        def __init__(self):
            self.calls = []

        def _lane_pdf_vlm(self, path, meta, stage_cb=None):
            self.calls.append("pdf_vlm")
            return []

        def _lane_office_vlm(self, path, meta, stage_cb=None):
            self.calls.append("office_vlm")
            return []

        def _lane_docling(self, path):
            self.calls.append("docling")
            return []

        # Post-dispatch no-ops so the router can run on the stub.
        def _assign_sections(self, docs):
            pass

        def _apply_contextual(self, docs):
            pass

        def _apply_autokeywords(self, docs):
            pass

    def _route_doc(path, has_images):
        monkeypatch.setattr(rv, "_file_has_images", lambda p: has_images)
        r = _R()
        rv.VectorRAG._documents_for_file(r, path, {})
        return r.calls[0]

    assert _route_doc("deck.pdf", True) == "pdf_vlm"
    assert _route_doc("report.docx", True) == "office_vlm"
    assert _route_doc("textonly.pdf", False) == "docling"


def test_office_vlm_persists_images_as_renderable_figures(monkeypatch, tmp_path):
    monkeypatch.setattr(
        rv,
        "_concurrent_map",
        lambda fn, values, workers, on_done=None: ["Gauge diagram"],
    )

    class _R:
        def _lane_docling(self, path):
            return []

        def _ooxml_images(self, path):
            return [("word/media/image1.png", base64.b64encode(b"png-bytes").decode())]

        def _figures_dir(self):
            return str(tmp_path)

        def _vlm_transcribe_image(self, b64, prompt=None):
            return "Gauge diagram"

        _VLM_IMAGE_PROMPT = "describe"

    docs = rv.VectorRAG._lane_office_vlm(_R(), "report.docx", {})

    assert len(docs) == 1
    assert docs[0].meta["modality"] == "figure"
    assert docs[0].meta["document_figure"] is True
    assert docs[0].meta["image_url"].startswith("/api/personal/rag-asset?source=")
    assert docs[0].meta["image_caption"] == "Gauge diagram"
    assert len(list(tmp_path.iterdir())) == 1


# ── Phase 5: pixel image lane gating + VL embed parsing ──


def test_image_lane_inactive_by_default(monkeypatch):
    monkeypatch.delenv("IMAGE_PIXEL_ENABLED", raising=False)
    monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)
    assert rv._image_active() is False


def test_image_lane_requires_both_toggle_and_url(monkeypatch):
    monkeypatch.setenv("IMAGE_PIXEL_ENABLED", "true")
    monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)
    assert rv._image_active() is False
    monkeypatch.setenv("IMAGE_EMBED_URL", "http://vl:8004/v1/embeddings")
    assert rv._image_active() is True


def test_pixel_write_is_noop_when_disabled(monkeypatch):
    """With the lane off, the pixel write returns immediately — no network, no
    qdrant — proving the default image path (OCR text only) is untouched."""
    monkeypatch.setenv("IMAGE_PIXEL_ENABLED", "")
    monkeypatch.delenv("IMAGE_EMBED_URL", raising=False)

    class _Dummy:
        pass

    assert rv.VectorRAG._write_image_pixel(_Dummy(), "shot.png", {}, "") is False


def test_vl_embed_parses_openai_shape(monkeypatch):
    monkeypatch.setenv("IMAGE_EMBED_URL", "http://vl:8004/v1/embeddings")
    monkeypatch.setenv("IMAGE_EMBED_MODEL", "qwen3-vl-embed")
    import httpx

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"embedding": [0.1, 0.2, 0.3]}]}

    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp())

    class _Dummy:
        pass

    assert rv.VectorRAG._vl_embed(_Dummy(), "a query") == [0.1, 0.2, 0.3]


# ── Phase 6: tree-sitter code lane ──


def test_code_lane_inactive_by_default(monkeypatch):
    monkeypatch.delenv("CODE_LANE_ENABLED", raising=False)
    assert rv._code_active() is False


def test_code_chunks_by_symbol():
    """A 3-function file → 3 AST chunks, each tagged with its symbol."""
    pytest.importorskip("tree_sitter_language_pack")
    src = (
        "import os\n\n"
        "def alpha():\n    return 1\n\n"
        "def beta(x):\n    return x + 1\n\n"
        "def gamma():\n    return 3\n"
    )
    chunks = rv._code_chunks(src, "python")
    assert chunks is not None
    assert len(chunks) == 3
    assert sorted(sym for _text, sym in chunks) == ["alpha", "beta", "gamma"]


def test_extract_imports_is_language_agnostic():
    src = "import os\nfrom a import b\n#include <stdio.h>\nx = 1\n"
    got = rv._extract_imports(src)
    assert "import os" in got and "from a import b" in got and "#include <stdio.h>" in got
    assert "x = 1" not in got
