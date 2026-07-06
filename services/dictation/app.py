"""dictation — real-time streaming speech-to-text sidecar (RealtimeSTT).

Powers the composer's voice input with word-by-word partials, unlike the
batch ``video_asr`` service (which stays as-is for RAG ingest). Two-tier
setup per RealtimeSTT's recommendation: a small model chases the speech for
live partials, a bigger one produces the accurate committed text.

WebSocket contract Talos depends on (``routes.voice_routes`` bridges to it):

    WS /ws
      client → binary frames: 16-bit little-endian mono PCM @ 16 kHz
      client → text frame {"type": "stop"} to finish the dictation
      server → {"type": "partial",  "text": str}  # in-progress utterance
      server → {"type": "sentence", "text": str}  # utterance committed by VAD
      server → {"type": "final",    "text": str}  # full transcript, then close
      server → {"type": "error",    "error": str}

The models are shared, so one dictation session runs at a time — a second
connection gets {"type": "error", "error": "busy"} and is closed. Fine for a
self-hosted assistant; fan out with multiple replicas if that ever changes.

Run locally:  uvicorn app:app --host 0.0.0.0 --port 8004
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from typing import Any, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dictation")

app = FastAPI(title="dictation", version="1.0.0")

MODEL = os.getenv("DICTATION_MODEL", "large-v3-turbo").strip() or "large-v3-turbo"
REALTIME_MODEL = os.getenv("DICTATION_REALTIME_MODEL", "small").strip() or "small"
# Empty = Whisper auto-detect per utterance — right default for mixed EN/DE.
LANGUAGE = os.getenv("DICTATION_LANGUAGE", "").strip()
# How long a pause ends an utterance (the "sentence commit" trigger).
SILENCE_S = float(os.getenv("DICTATION_SILENCE", "0.7"))
# Upper bound for the final big-model pass after the client sends stop.
FINALIZE_TIMEOUT_S = float(os.getenv("DICTATION_FINALIZE_TIMEOUT", "20"))


class _Session:
    """The one active dictation: an asyncio queue the recorder threads feed
    (via ``call_soon_threadsafe``) and the committed-sentence accumulator."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.events: asyncio.Queue = asyncio.Queue()
        self.committed: list[str] = []
        # True once a partial arrived for an utterance the sentence loop hasn't
        # committed yet — tells `stop` whether to wait for one more sentence.
        self.utterance_open = False

    def emit(self, kind: str, text: str) -> None:
        self.loop.call_soon_threadsafe(self.events.put_nowait, (kind, text))


_recorder = None
_recorder_init_lock = threading.Lock()
_session: Optional[_Session] = None  # set/cleared by the WS handler only


def _on_partial(text: str) -> None:
    s = _session
    if s and text:
        s.utterance_open = True
        s.emit("partial", text)


def _sentence_loop() -> None:
    """Forever: block on the next VAD-delimited utterance and commit it to the
    active session. Runs whether or not a session is connected — with nobody
    feeding audio the recorder just idles inside ``text()``."""
    while True:
        try:
            sentence = (_recorder.text() or "").strip()
        except Exception as e:  # pragma: no cover — keep the loop alive
            logger.exception("sentence loop error: %s", e)
            continue
        s = _session
        if s:
            s.utterance_open = False
            if sentence:
                s.committed.append(sentence)
            s.emit("sentence", sentence)


def _get_recorder():
    """Build the shared recorder once (loads both models; the first call can
    take a while if weights need downloading)."""
    global _recorder
    with _recorder_init_lock:
        if _recorder is not None:
            return _recorder
        from RealtimeSTT import AudioToTextRecorder

        logger.info(
            "loading models: final=%s realtime=%s language=%s",
            MODEL,
            REALTIME_MODEL,
            LANGUAGE or "auto",
        )
        kwargs: Dict[str, Any] = {}
        device = os.getenv("DICTATION_DEVICE", "").strip()  # RealtimeSTT default: cuda
        if device:
            kwargs["device"] = device
        _recorder = AudioToTextRecorder(
            model=MODEL,
            realtime_model_type=REALTIME_MODEL,
            language=LANGUAGE,
            enable_realtime_transcription=True,
            on_realtime_transcription_update=_on_partial,
            use_microphone=False,
            spinner=False,
            post_speech_silence_duration=SILENCE_S,
            **kwargs,
        )
        threading.Thread(target=_sentence_loop, daemon=True, name="sentences").start()
        logger.info("models ready")
        return _recorder


@app.on_event("startup")
def _preload_models() -> None:
    """Load the models in the background right away instead of on the first
    connection: Talos gates the composer's mic on /health reporting
    ``loaded: true``, and the first load can take minutes (weight download)."""

    def _load() -> None:
        try:
            _get_recorder()
        except Exception:  # pragma: no cover — /ws retries and reports to client
            logger.exception("model preload failed")

    threading.Thread(target=_load, daemon=True, name="preload").start()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL,
        "realtime_model": REALTIME_MODEL,
        "language": LANGUAGE or "auto",
        "loaded": _recorder is not None,
        "busy": _session is not None,
    }


async def _finalize(ws: WebSocket, session: _Session, recorder) -> None:
    """Client sent stop: force the current utterance to end, wait (bounded) for
    the big model to commit it, then send the full transcript."""
    try:
        recorder.stop()
    except Exception:
        pass
    if session.utterance_open:
        try:
            deadline = asyncio.get_event_loop().time() + FINALIZE_TIMEOUT_S
            while session.utterance_open:
                timeout = deadline - asyncio.get_event_loop().time()
                if timeout <= 0:
                    logger.warning("finalize timed out; returning committed text only")
                    break
                kind, text = await asyncio.wait_for(session.events.get(), timeout)
                if kind == "sentence":
                    break
        except asyncio.TimeoutError:
            logger.warning("finalize timed out; returning committed text only")
    await ws.send_json({"type": "final", "text": " ".join(session.committed).strip()})


@app.websocket("/ws")
async def ws_dictate(ws: WebSocket) -> None:
    global _session
    await ws.accept()
    if _session is not None:
        await ws.send_json({"type": "error", "error": "busy"})
        await ws.close()
        return
    session = _Session(asyncio.get_event_loop())
    _session = session
    try:
        recorder = await asyncio.to_thread(_get_recorder)
    except Exception as e:
        logger.exception("recorder init failed")
        _session = None
        await ws.send_json({"type": "error", "error": f"model load failed: {e}"})
        await ws.close()
        return

    async def pump_events() -> None:
        """Relay recorder events to the client. Sentences are re-joined with
        the accumulator so the client can treat `partial` as append-only UI."""
        while True:
            kind, text = await session.events.get()
            if kind == "sentence":
                await ws.send_json({"type": "sentence", "text": text})
            else:
                await ws.send_json({"type": "partial", "text": text})

    logger.info("session started")
    fed_bytes = 0
    pump = asyncio.create_task(pump_events())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break  # cancel: client vanished without stop — discard
            data = msg.get("bytes")
            if data:
                if fed_bytes == 0:
                    logger.info("first audio frame received (%d bytes)", len(data))
                fed_bytes += len(data)
                recorder.feed_audio(data)
                continue
            text = msg.get("text")
            if text:
                try:
                    cmd = json.loads(text)
                except ValueError:
                    continue
                if cmd.get("type") == "stop":
                    pump.cancel()
                    await _finalize(ws, session, recorder)
                    break
    except WebSocketDisconnect:
        pass
    finally:
        logger.info(
            "session ended (%d bytes ≈ %.1fs audio, %d sentences)",
            fed_bytes,
            fed_bytes / 32000.0,  # PCM16 mono @ 16 kHz
            len(session.committed),
        )
        pump.cancel()
        _session = None
        # Reset shared state for the next session: end any open utterance and
        # drop buffered audio so it can't bleed into the next dictation.
        try:
            recorder.stop()
        except Exception:
            pass
        try:
            recorder.clear_audio_queue()
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass
