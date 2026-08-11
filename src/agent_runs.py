"""Detached agent-run manager.

Keeps an agent/chat stream running server-side after the SSE client disconnects
(tab close, navigate away, refresh). The streaming generator is drained by a
background asyncio task into a per-session replay buffer; SSE clients SUBSCRIBE
to that buffer (replay everything so far, then live). Closing the SSE only drops
the subscriber — the drain task keeps going.

The wrapped generator already persists the assistant message to the session on
completion, so reopening the session shows the finished result even if nobody
was connected when it finished. Reconnecting mid-run replays the buffer + streams
live (pick up where it is).

Durability scope: in-memory, survives as long as the server process runs (tab
close / navigation / refresh). It does NOT survive a server restart.
"""

import asyncio
import json
import logging
import time
from typing import AsyncGenerator, Dict, Optional

logger = logging.getLogger(__name__)


class _Run:
    __slots__ = ("buffer", "subscribers", "status", "task", "evict_task", "started_at")

    def __init__(self) -> None:
        self.buffer: list = []  # ordered SSE event strings (replay log)
        self.subscribers: set = set()  # one asyncio.Queue per connected client
        self.status: str = "running"  # running | done | error | stopped
        self.task: Optional[asyncio.Task] = None
        self.evict_task: Optional[asyncio.Task] = None
        # Monotonic start stamp so a reconnecting client can restore the elapsed
        # "working for" timer instead of restarting it from zero.
        self.started_at: float = time.monotonic()


_RUNS: Dict[str, _Run] = {}

# How long a FINISHED run (and its full replay buffer) is retained after the
# last subscriber disconnects, so a reconnect within the window can still
# replay the result. After this, the run is evicted to bound memory — without
# it, every session that ever streamed kept its entire event log forever.
_EVICT_GRACE_S = 180


def _publish(run: _Run, ev: str) -> None:
    """Append one SSE event and fan it out to every live subscriber."""
    run.buffer.append(ev)
    seq = len(run.buffer) - 1
    for q in list(run.subscribers):
        try:
            q.put_nowait((seq, ev))
        except Exception:
            pass


def _schedule_evict(session_id: str) -> None:
    """(Re)arm a grace-period eviction for a terminal run with no subscribers.
    Identity-checked so a run that gets replaced/reused is never evicted by a
    stale timer."""
    run = _RUNS.get(session_id)
    if run is None:
        return
    if run.evict_task and not run.evict_task.done():
        run.evict_task.cancel()

    async def _evict(run_ref: _Run) -> None:
        try:
            await asyncio.sleep(_EVICT_GRACE_S)
        except asyncio.CancelledError:
            return
        cur = _RUNS.get(session_id)
        if cur is run_ref and cur.status != "running" and not cur.subscribers:
            _RUNS.pop(session_id, None)

    run.evict_task = asyncio.create_task(_evict(run))


def is_active(session_id: str) -> bool:
    r = _RUNS.get(session_id)
    return bool(r and r.status == "running")


def active_sessions() -> list:
    """Every session id with a run still in flight. Lets a freshly loaded page
    ask "what is still going?" and reconnect to each via subscribe()."""
    return [sid for sid, run in list(_RUNS.items()) if run.status == "running"]


def elapsed_ms(session_id: str) -> Optional[int]:
    """How long the run has been going, in ms. None if there's no such run.
    Reported as an elapsed span (not a wall-clock stamp) so a client can rebase
    it on its own clock without caring about server/client skew."""
    r = _RUNS.get(session_id)
    if r is None:
        return None
    return int((time.monotonic() - r.started_at) * 1000)


def get_status(session_id: str) -> Optional[str]:
    r = _RUNS.get(session_id)
    return r.status if r else None


# Fields a `tool_output` event carries through to the persisted tool event, so
# an in-flight snapshot renders with the same detail a finished turn does.
_TOOL_OUTPUT_FIELDS = (
    "output",
    "exit_code",
    "diff",
    "image_url",
    "image_prompt",
    "image_model",
    "image_size",
    "image_quality",
    "image_note",
    "screenshot",
    "created_images",
)


def partial_snapshot(session_id: str) -> Optional[dict]:
    """Everything the in-flight turn has produced so far, replayed out of the
    run buffer in the shape a FINISHED assistant row is persisted in.

    The assistant row is only written to the DB when the turn ENDS, so anything
    that snapshots a session mid-run (ticket attachments) would otherwise show
    the user's question with no answer under it — even though the reporter was
    looking at a screen full of streamed text, tool rows and reasoning.

    Reconstructs the turn the same way the client does: content deltas
    concatenated, thinking deltas kept per round (re-wrapped in `<think>` tags,
    which is how finished rounds persist reasoning inside `round_texts`),
    `agent_step` starting a new round, `content_final` replacing the current
    round's text, and `tool_start`/`tool_output` pairs collected into
    `tool_events` tagged with their 1-based round.

    Returns None when the session has no run, and a dict with `content`,
    `round_texts`, `thinking` and `tool_events` otherwise (any of which may be
    empty — the caller decides whether that is worth showing).
    """
    run = _RUNS.get(session_id)
    if run is None:
        return None
    rounds: list = [{"text": "", "thinking": ""}]
    tool_events: list = []
    for ev in list(run.buffer):
        _, _, payload = str(ev).partition("data: ")
        payload = payload.strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        delta = obj.get("delta")
        if isinstance(delta, str):
            rounds[-1]["thinking" if obj.get("thinking") else "text"] += delta
            continue
        kind = obj.get("type")
        if kind == "agent_step":
            if rounds[-1]["text"].strip() or rounds[-1]["thinking"].strip():
                rounds.append({"text": "", "thinking": ""})
        elif kind == "content_final" and isinstance(obj.get("content"), str):
            rounds[-1]["text"] = obj["content"]
        elif kind == "tool_start":
            tool_events.append(
                {
                    "round": len(rounds),
                    "tool": str(obj.get("tool") or "tool"),
                    "command": obj.get("command"),
                }
            )
        elif kind == "tool_output" and tool_events:
            # Events arrive in order and a tool's output follows its start, so
            # the open call is the last one that has no output yet.
            open_call = next(
                (e for e in reversed(tool_events) if "output" not in e and "exit_code" not in e),
                None,
            )
            if open_call is not None:
                for field in _TOOL_OUTPUT_FIELDS:
                    if obj.get(field) is not None:
                        open_call[field] = obj[field]

    round_texts = []
    for round_data in rounds:
        thinking = round_data["thinking"].strip()
        text = round_data["text"].strip()
        if not thinking and not text:
            continue
        round_texts.append(f"<think>{thinking}</think>\n\n{text}".strip() if thinking else text)
    texts = [r["text"].strip() for r in rounds if r["text"].strip()]
    return {
        "content": "\n\n".join(texts),
        "round_texts": round_texts,
        "thinking": "\n\n".join(r["thinking"].strip() for r in rounds if r["thinking"].strip()),
        "tool_events": tool_events,
    }


def partial_text(session_id: str) -> Optional[str]:
    """The answer text streamed so far. See :func:`partial_snapshot`."""
    snapshot = partial_snapshot(session_id)
    return (snapshot or {}).get("content") or None


async def _drain(
    session_id: str, agen: AsyncGenerator[str, None], prev_task: Optional[asyncio.Task] = None
) -> None:
    """Pull every event from the wrapped generator into the run buffer, fanning
    each out to live subscribers. Runs to completion regardless of subscribers."""
    run = _RUNS.get(session_id)
    if run is None:
        return
    # If this run replaced an in-flight one (rapid double-send), wait for that
    # one to fully finish first. Its CancelledError handler calls aclose(), which
    # persists its partial response — letting it complete before we start writing
    # keeps the two runs' session saves sequential instead of interleaved.
    if prev_task is not None and not prev_task.done():
        try:
            await asyncio.wait({prev_task})
        except asyncio.CancelledError:
            raise  # our own cancellation — propagate
        except Exception:
            pass
    try:
        async for ev in agen:
            _publish(run, ev)
        if run.status == "running":
            run.status = "done"
    except asyncio.CancelledError:
        run.status = "stopped"
        # Let the wrapped generator's own CancelledError handler run (it saves
        # the partial response to the session).
        try:
            await agen.aclose()
        except Exception:
            pass
    except Exception as e:
        logger.error("[agent-run] %s failed: %s", session_id, e, exc_info=True)
        run.status = "error"
        _publish(
            run,
            "event: error\n"
            f"data: {json.dumps({'error': 'Agent run failed before completion.', 'status': 500})}\n\n",
        )
        _publish(run, "data: [DONE]\n\n")
    finally:
        # Wake every subscriber with the end sentinel so their SSE closes.
        for q in list(run.subscribers):
            try:
                q.put_nowait((None, None))
            except Exception:
                pass
        # Run is terminal — arm the grace timer so it (and its buffer) is
        # eventually freed even if nobody ever reconnects. subscribe() cancels
        # this on connect and re-arms on disconnect.
        _schedule_evict(session_id)


def start(session_id: str, agen: AsyncGenerator[str, None]) -> _Run:
    """Start a detached run draining `agen` for a session. If a run is already in
    flight for this session (e.g. a rapid double-send), it's cancelled first."""
    prev = _RUNS.get(session_id)
    prev_task: Optional[asyncio.Task] = None
    if prev:
        if prev.task and not prev.task.done():
            prev.task.cancel()
            prev_task = prev.task  # new run awaits this before it starts writing
        if prev.evict_task and not prev.evict_task.done():
            prev.evict_task.cancel()
    run = _Run()
    _RUNS[session_id] = run
    run.task = asyncio.create_task(_drain(session_id, agen, prev_task))
    return run


async def subscribe(session_id: str) -> AsyncGenerator[str, None]:
    """Replay the run's buffer from the start, then stream live until it ends.
    Safe to call repeatedly (reconnect) and from multiple clients at once."""
    run = _RUNS.get(session_id)
    if run is None:
        return
    q: asyncio.Queue = asyncio.Queue()
    run.subscribers.add(q)  # register BEFORE replaying so nothing is missed
    # A live subscriber is connected — don't let a pending grace timer evict
    # the run out from under it mid-replay.
    if run.evict_task and not run.evict_task.done():
        run.evict_task.cancel()
    try:
        next_seq = 0
        while next_seq < len(run.buffer):
            yield run.buffer[next_seq]
            next_seq += 1
        if run.status != "running":
            return
        while True:
            seq, ev = await q.get()
            if seq is None:  # end sentinel
                while next_seq < len(run.buffer):  # flush any tail the sentinel raced
                    yield run.buffer[next_seq]
                    next_seq += 1
                break
            if seq >= next_seq:  # skip events already replayed from the buffer
                yield ev
                next_seq = seq + 1
    finally:
        run.subscribers.discard(q)
        # Last subscriber gone on a finished run — (re)arm eviction so the
        # buffer doesn't linger indefinitely.
        if not run.subscribers and run.status != "running":
            _schedule_evict(session_id)


def stop(session_id: str) -> bool:
    """Cancel an in-flight run (the wrapped generator saves its partial)."""
    run = _RUNS.get(session_id)
    if run and run.task and not run.task.done():
        run.task.cancel()
        return True
    return False
