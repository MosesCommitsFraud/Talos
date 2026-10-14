"""Where did this prompt stop matching the last one? — prefix-cache diagnostics.

vLLM reuses prefill only up to the first token that differs from a prompt it
has seen. When a turn comes back with `cached` far below `prompt` in the
`[agent-perf]` line, either something early in the prompt changed or the
server lost its cache (restart, eviction). This module tells the two apart:
it keeps the last few prompts sent to each (endpoint, model) and logs, for
every request, how far the new prompt matches the best of them and what the
first differing piece is.

Pieces are compared in the order Qwen-style chat templates render them —
system prompt, tool definitions, then the remaining messages — so "differs in
tools" really means the bytes right after the system prompt.

Only lengths, positions and the names of the differing pieces are logged,
never message text.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_KEEP = 16  # prompts remembered per (endpoint, model)
_CHARS_PER_TOKEN = 3.5  # rough; the log says "≈"

_lock = threading.Lock()
_recent: Dict[Tuple[str, str], Deque[Tuple[float, List[Tuple[str, str]]]]] = {}


def _pieces(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict]],
    template_kwargs: Optional[Dict[str, Any]] = None,
) -> List[Tuple[str, str]]:
    """(label, serialized) in render order: system, tools, everything after.

    The chat-template kwargs go first: Qwen3.8 renders `reasoning_effort` into
    the prompt text, so a changed effort changes the prompt even when every
    message is identical.
    """
    out: List[Tuple[str, str]] = [
        ("template kwargs", json.dumps(template_kwargs or {}, sort_keys=True))
    ]
    rest = messages
    if messages and messages[0].get("role") == "system":
        out.append(("system", json.dumps(messages[0], sort_keys=True, ensure_ascii=False)))
        rest = messages[1:]
    out.append(("tools", json.dumps(tools or [], sort_keys=True, ensure_ascii=False)))
    offset = len(messages) - len(rest)
    for i, m in enumerate(rest):
        label = f"msg[{i + offset}] {m.get('role', '?')}"
        out.append((label, json.dumps(m, sort_keys=True, ensure_ascii=False)))
    return out


def _common_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    # Binary search on slice equality — C-speed compares, fine for 100k+ chars.
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _match(
    new: List[Tuple[str, str]], old: List[Tuple[str, str]]
) -> Tuple[int, Optional[str], int]:
    """(matching chars, label of first differing piece or None, chars into it)."""
    chars = 0
    for i, (label, text) in enumerate(new):
        if i >= len(old):
            return chars, None, 0  # the old prompt is a prefix of the new one
        old_label, old_text = old[i]
        if text == old_text and label == old_label:
            chars += len(text)
            continue
        into = _common_prefix_len(text, old_text)
        return chars + into, label, into
    return chars, None, 0


def record(
    url: str,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict]],
    template_kwargs: Optional[Dict[str, Any]] = None,
) -> None:
    """Compare this request's prompt with recent ones and log the result.

    Never raises — this is diagnostics on the hot path.
    """
    try:
        new = _pieces(messages, tools, template_kwargs)
        total = sum(len(t) for _, t in new)
        key = (url, model)
        now = time.time()
        with _lock:
            hist = _recent.setdefault(key, deque(maxlen=_KEEP))
            best = None  # (chars, label, into, age_s)
            for ts, old in hist:
                chars, label, into = _match(new, old)
                if best is None or chars > best[0]:
                    best = (chars, label, into, now - ts)
            hist.append((now, new))
        if best is None:
            logger.info(
                "[prompt-diff] %s: first prompt since Talos start (%d pieces, ≈%d tok)",
                model,
                len(new),
                total / _CHARS_PER_TOKEN,
            )
            return
        chars, label, into, age = best
        where = (
            "no difference before the shorter one ends"
            if label is None
            else f"first difference in {label} at char {into}"
        )
        logger.info(
            "[prompt-diff] %s: matches ≈%d of ≈%d tok of a prompt sent %.0fs ago — %s",
            model,
            chars / _CHARS_PER_TOKEN,
            total / _CHARS_PER_TOKEN,
            age,
            where,
        )
    except Exception:  # pragma: no cover — must never break a request
        logger.debug("prompt-diff failed", exc_info=True)
