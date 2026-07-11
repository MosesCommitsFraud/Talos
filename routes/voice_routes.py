# routes/voice_routes.py
"""Voice dictation: streaming (preferred) and batch (fallback) paths.

Streaming — ``WS /api/voice/stream`` bridges the browser to the
``services/dictation`` sidecar (``DICTATION_WS_URL``), which runs RealtimeSTT
for word-by-word partials. The bridge keeps the sidecar off the public
surface and enforces Talos session auth during the handshake (the HTTP auth
middleware does not run for WebSockets, so the cookie is checked here).

Batch — ``POST /api/voice/transcribe`` proxies a MediaRecorder clip to
``VIDEO_ASR_URL`` (the RAG video-lane endpoint), so voice input still works
with zero extra services, just without live preview. Both endpoint styles are
supported, mirroring ``src.rag_vector._transcribe_audio_file``:

  * OpenAI-compatible ``/v1/audio/transcriptions`` (vLLM Qwen3-ASR, whisper.cpp)
  * the Talos ``services/video_asr`` contract (``{"segments": [...]}``)

Either way the client gets back a flat ``{"text": "..."}``.
"""

import asyncio
import logging
import os
import time
from typing import Any, Dict
from urllib.parse import urlsplit

from fastapi import APIRouter, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi import File as FastFile

from src.auth_helpers import get_current_user

logger = logging.getLogger(__name__)

# Keep dictation snappy and inside the global REQUEST_HARD_TIMEOUT (45s):
# a preview pass that takes longer than this is useless anyway.
_ASR_TIMEOUT = float(os.getenv("VOICE_ASR_TIMEOUT", "40"))


def voice_streaming_configured() -> bool:
    """True when the RealtimeSTT dictation sidecar is reachable via config."""
    return bool(os.getenv("DICTATION_WS_URL", "").strip())


def _sidecar_health_url() -> str:
    """Derive the sidecar's HTTP /health URL from DICTATION_WS_URL
    (ws://host:8004/ws → http://host:8004/health)."""
    url = os.getenv("DICTATION_WS_URL", "").strip()
    if not url:
        return ""
    parts = urlsplit(url)
    scheme = "https" if parts.scheme == "wss" else "http"
    return f"{scheme}://{parts.netloc}/health"


# Probe result cache so /api/capabilities (fetched per composer mount) doesn't
# hammer the sidecar. Short TTL: the mic (dis)appears within ~15s + the
# frontend's own 60s staleTime after the service starts or dies.
_HEALTH_TTL_S = 15.0
_health_cache: tuple = (0.0, False)  # (monotonic timestamp, available)


def voice_streaming_available() -> bool:
    """Configured AND the sidecar is up with models loaded right now. This is
    what gates the composer's mic icon — configuration alone isn't enough,
    because a stopped sidecar would leave a dead mic in the UI."""
    global _health_cache
    url = _sidecar_health_url()
    if not url:
        return False
    now = time.monotonic()
    ts, ok = _health_cache
    if now - ts < _HEALTH_TTL_S:
        return ok
    ok = False
    try:
        import httpx

        resp = httpx.get(url, timeout=2.0)
        if resp.status_code == 200:
            payload = resp.json()
            # `loaded` stays false while Whisper weights download on first
            # start — don't offer the mic until dictation would actually work.
            ok = bool(payload.get("ok")) and bool(payload.get("loaded"))
    except Exception as e:
        logger.debug("voice: dictation sidecar health probe failed: %s", e)
    _health_cache = (now, ok)
    return ok


def voice_configured() -> bool:
    """Voice input works with either path. The batch fallback is deliberately
    independent of ``VIDEO_ASR_ENABLED``, which gates the RAG ingest lane."""
    return voice_streaming_available() or bool(os.getenv("VIDEO_ASR_URL", "").strip())


def _extract_text(payload: Dict[str, Any]) -> str:
    # OpenAI-style: {"text": "..."} — video_asr service: {"segments": [...]}
    if isinstance(payload.get("text"), str):
        return payload["text"].strip()
    parts = []
    for seg in payload.get("segments") or []:
        t = (seg.get("text") or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts)


def setup_voice_routes():
    router = APIRouter(prefix="/api/voice", tags=["voice"])

    @router.post("/transcribe")
    async def transcribe(
        request: Request,
        file: UploadFile = FastFile(...),
        language: str = Form(""),
    ):
        get_current_user(request)  # auth context; anonymous is fine when auth is off
        url = os.getenv("VIDEO_ASR_URL", "").strip()
        if not url:
            raise HTTPException(503, "Voice input is not configured (VIDEO_ASR_URL)")
        logger.info("voice: batch transcribe request (%s)", file.filename or "clip")

        import httpx

        from src.rag_vector import _asr_language_code

        lang = language.strip() or os.getenv("VIDEO_ASR_LANGUAGE", "")
        code = _asr_language_code(lang)
        if "/v1/audio/transcriptions" in url:
            data: Dict[str, Any] = {
                "model": os.getenv("VIDEO_ASR_MODEL", "qwen3-asr"),
                "response_format": "json",
            }
            # Empty/auto omits the field so the model auto-detects (vLLM rejects
            # an empty language string) — same rule as the ingest lane.
            if code and code not in ("auto", "detect"):
                data["language"] = code
        else:
            data = {"language": lang or "auto"}

        blob = await file.read()
        # Browsers record webm/opus (MediaRecorder), which soundfile-based ASR
        # endpoints (vLLM audio API) cannot decode — transcode to 16k mono WAV
        # first. Falls back to the original bytes if ffmpeg is unavailable.
        upload: tuple = (file.filename or "dictation.webm", blob)
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                "pipe:1",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            wav, err = await asyncio.wait_for(proc.communicate(blob), timeout=_ASR_TIMEOUT)
            if proc.returncode == 0 and wav:
                upload = ("dictation.wav", wav, "audio/wav")
            else:
                logger.warning("voice: ffmpeg transcode failed: %s", (err or b"")[-200:])
        except (FileNotFoundError, asyncio.TimeoutError) as e:
            logger.warning("voice: ffmpeg unavailable/timed out (%s), sending original", e)
        try:
            async with httpx.AsyncClient(timeout=_ASR_TIMEOUT) as client:
                resp = await client.post(url, files={"file": upload}, data=data)
        except httpx.HTTPError as e:
            logger.warning("voice: ASR endpoint unreachable: %s", e)
            raise HTTPException(502, f"ASR endpoint unreachable: {type(e).__name__}")
        if resp.status_code >= 400:
            logger.warning("voice: ASR endpoint %s: %s", resp.status_code, resp.text[:300])
            raise HTTPException(502, f"ASR endpoint {resp.status_code}: {resp.text[:300]}")
        return {"text": _extract_text(resp.json())}

    @router.websocket("/stream")
    async def stream(ws: WebSocket):
        """Bidirectional relay browser ⇄ dictation sidecar. Client sends binary
        PCM16@16k frames and a {"type":"stop"} text frame; the sidecar answers
        with partial/sentence/final JSON (see services/dictation/app.py)."""
        # The auth middleware only covers HTTP — validate the session cookie
        # ourselves before accepting (4401 mirrors HTTP 401).
        auth_mgr = getattr(ws.app.state, "auth_manager", None)
        if auth_mgr and auth_mgr.is_configured:
            from routes.auth_routes import SESSION_COOKIE

            if not auth_mgr.validate_token(ws.cookies.get(SESSION_COOKIE)):
                logger.info("voice: stream rejected — missing/invalid session cookie")
                await ws.close(code=4401)
                return
        url = os.getenv("DICTATION_WS_URL", "").strip()
        if not url:
            logger.info("voice: stream rejected — DICTATION_WS_URL not configured")
            await ws.close(code=4503)
            return

        import websockets

        await ws.accept()
        logger.info("voice: dictation stream started")
        try:
            async with websockets.connect(url, max_size=2**22) as upstream:

                async def client_to_sidecar():
                    while True:
                        msg = await ws.receive()
                        if msg["type"] == "websocket.disconnect":
                            return
                        if msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                        elif msg.get("text") is not None:
                            await upstream.send(msg["text"])

                async def sidecar_to_client():
                    async for m in upstream:
                        if isinstance(m, (bytes, bytearray)):
                            await ws.send_bytes(bytes(m))
                        else:
                            await ws.send_text(m)

                # Either side closing ends the relay; cancel the other pump.
                tasks = [
                    asyncio.create_task(client_to_sidecar()),
                    asyncio.create_task(sidecar_to_client()),
                ]
                _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
        except Exception as e:
            logger.warning("voice: dictation sidecar relay ended: %s", e)
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    return router
