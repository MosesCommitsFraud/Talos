"""video-asr — audio/video → timestamped transcript microservice.

The contract Talos depends on (``src.rag_vector.VectorRAG._lane_av``):

    POST /transcribe   (multipart: file=<media>, language=<str>)
      → 200 {"segments": [{"start": <sec>, "end": <sec>, "text": <str>}, ...]}

This is the **reference implementation**. It ships a portable backend
(faster-whisper) so the service is runnable anywhere; on the DGX Spark, point
``ASR_MODEL`` at the Qwen3-ASR-1.7B weights and swap ``_transcribe`` for the
Qwen3-ASR + ForcedAligner path (see Bauplan §3 Video). The HTTP contract above
stays identical, so nothing in Talos changes.

Run locally:  uvicorn app:app --host 0.0.0.0 --port 8003
"""

from __future__ import annotations

import logging
import os
import tempfile
from typing import Any, Dict, List

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi import File as FastFile

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("video-asr")

app = FastAPI(title="video-asr", version="1.0.0")

# Lazily built, cached model — first request loads it (can take a while for big
# weights), subsequent requests reuse it.
_model = None


def _device() -> str:
    dev = os.getenv("ASR_DEVICE", "auto").strip().lower()
    if dev not in ("auto", ""):
        return dev
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _get_model():
    """Load the faster-whisper backend once. Replace this with the Qwen3-ASR
    loader on the Spark — keep the return contract of ``_transcribe`` the same."""
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel  # heavy optional dep

    name = os.getenv("ASR_MODEL", "large-v3-turbo").strip() or "large-v3-turbo"
    device = _device()
    compute = "float16" if device == "cuda" else "int8"
    logger.info("loading ASR model %s on %s (%s)", name, device, compute)
    _model = WhisperModel(name, device=device, compute_type=compute)
    return _model


def _transcribe(path: str, language: str) -> List[Dict[str, Any]]:
    """Return ``[{start, end, text}]`` for the media at ``path``.

    Qwen3-ASR caps a single run at ~20 min, so long media must be split into
    ``ASR_MAX_SEGMENT_SECONDS`` windows and offset back to absolute timestamps;
    faster-whisper has no such cap, but we keep the knob so the Qwen3-ASR swap
    is a drop-in. Language names (e.g. "German") are mapped to ISO codes.
    """
    model = _get_model()
    lang = _LANG_CODES.get((language or "").strip().lower())
    segments, _info = model.transcribe(path, language=lang, vad_filter=True)
    out: List[Dict[str, Any]] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        out.append(
            {"start": round(float(seg.start), 3), "end": round(float(seg.end), 3), "text": text}
        )
    return out


# Common spoken-language names → ISO 639-1; unknown/empty → None (auto-detect).
_LANG_CODES = {
    "german": "de",
    "deutsch": "de",
    "de": "de",
    "english": "en",
    "en": "en",
}


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "model": os.getenv("ASR_MODEL", "large-v3-turbo"), "device": _device()}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = FastFile(...),
    language: str = Form("German"),
) -> Dict[str, Any]:
    suffix = os.path.splitext(file.filename or "")[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(await file.read())
        tmp.flush()
        tmp.close()
        segments = _transcribe(tmp.name, language)
        logger.info("transcribed %s → %d segments", file.filename, len(segments))
        return {"segments": segments}
    except Exception as e:
        logger.exception("transcription failed for %s", file.filename)
        raise HTTPException(500, f"transcription failed: {type(e).__name__}: {e}")
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
