"""
context_optimizer.py

Headroom-style reversible compression of tool outputs before they reach the
LLM (inspired by https://github.com/chopratejas/headroom).

Large tool outputs are the main thing that blows up agent context: JSON API
responses with hundreds of array items, log dumps with thousands of repeated
lines, huge file reads. This module routes each output to a content-aware
compressor (JSON crusher / log collapser / head-tail text), keeps the FULL
original in an in-memory store, and appends a marker telling the model it can
retrieve the original via the `expand_output` tool. Nothing is silently lost.

Toggled by the `context_compression` app setting (default on).
"""

import json
import logging
import re
import threading
import uuid
from collections import OrderedDict
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Outputs smaller than this are never touched — compression overhead (marker
# text, retrieval round-trips) isn't worth it below a few thousand chars.
MIN_COMPRESS_CHARS = 4_000
# Target size for a compressed output (chars, ~1.5K tokens).
TARGET_CHARS = 5_000
# Compression must save at least this fraction or the original is kept
# (a marker that says "saved 3%" is pure noise).
MIN_SAVINGS = 0.25

# Reversible store: id -> {"text", "tool"}. Bounded so a long-running server
# can't leak memory; oldest entries are evicted first.
_STORE_MAX_ENTRIES = 200
_STORE_MAX_TOTAL_CHARS = 20_000_000  # ~20 MB of text
_store: "OrderedDict[str, dict]" = OrderedDict()
_store_total_chars = 0
_store_lock = threading.Lock()

# How much an expand_output call returns per page.
EXPAND_PAGE_CHARS = 18_000


def compression_enabled() -> bool:
    try:
        from src.settings import load_settings

        return bool(load_settings().get("context_compression", True))
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Reversible store
# ---------------------------------------------------------------------------


def _store_original(text: str, tool_name: str) -> str:
    global _store_total_chars
    oid = "out_" + uuid.uuid4().hex[:8]
    with _store_lock:
        _store[oid] = {"text": text, "tool": tool_name}
        _store_total_chars += len(text)
        while _store and (
            len(_store) > _STORE_MAX_ENTRIES or _store_total_chars > _STORE_MAX_TOTAL_CHARS
        ):
            _, evicted = _store.popitem(last=False)
            _store_total_chars -= len(evicted["text"])
    return oid


def get_stored_output(oid: str) -> Optional[dict]:
    with _store_lock:
        entry = _store.get(oid)
        if entry:
            _store.move_to_end(oid)
        return entry


# ---------------------------------------------------------------------------
# Compressors
# ---------------------------------------------------------------------------

_JSON_KEEP_HEAD = 5  # array items kept from the front
_JSON_KEEP_TAIL = 2  # array items kept from the back
_JSON_MAX_STRING = 400


def _crush_json(value: Any, depth: int = 0) -> Any:
    """Recursively shrink a parsed JSON value: long arrays keep head+tail
    items plus an omission marker, long strings are truncated."""
    if isinstance(value, str):
        if len(value) > _JSON_MAX_STRING:
            return value[:_JSON_MAX_STRING] + f"… [+{len(value) - _JSON_MAX_STRING} chars omitted]"
        return value
    if isinstance(value, list):
        if len(value) > _JSON_KEEP_HEAD + _JSON_KEEP_TAIL + 1:
            omitted = len(value) - _JSON_KEEP_HEAD - _JSON_KEEP_TAIL
            crushed = [_crush_json(v, depth + 1) for v in value[:_JSON_KEEP_HEAD]]
            crushed.append(f"… {omitted} similar items omitted (total {len(value)}) …")
            crushed.extend(_crush_json(v, depth + 1) for v in value[-_JSON_KEEP_TAIL:])
            return crushed
        return [_crush_json(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: _crush_json(v, depth + 1) for k, v in value.items()}
    return value


def _try_compress_json(text: str) -> Optional[str]:
    stripped = text.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        parsed = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, (list, dict)):
        return None
    crushed = _crush_json(parsed)
    try:
        return json.dumps(crushed, indent=1, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None


_TIMESTAMP_RE = re.compile(
    r"^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,:\d]*\]?\s*|^\[?\d{2}:\d{2}:\d{2}[.,:\d]*\]?\s*"
)


def _collapse_log_lines(text: str) -> str:
    """Collapse runs of identical (modulo leading timestamps) log lines."""
    lines = text.split("\n")
    if len(lines) < 40:
        return text
    out = []
    prev_key = None
    run = 0
    for line in lines:
        key = _TIMESTAMP_RE.sub("", line).strip()
        if key and key == prev_key:
            run += 1
            continue
        if run > 1:
            out.append(f"  [last line repeated {run}x]")
        run = 1
        prev_key = key
        out.append(line)
    if run > 1:
        out.append(f"  [last line repeated {run}x]")
    return "\n".join(out)


def _head_tail(text: str, budget: int) -> str:
    """Keep the start and end of an oversized text — errors and summaries
    cluster at the edges; the middle is usually bulk data."""
    if len(text) <= budget:
        return text
    head = int(budget * 0.65)
    tail = budget - head
    omitted = len(text) - head - tail
    return (
        text[:head].rstrip()
        + f"\n\n… [{omitted:,} chars omitted from the middle] …\n\n"
        + text[-tail:].lstrip()
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def optimize_tool_output(text: str, tool_name: str = "") -> str:
    """Compress a formatted tool output if it is large; reversible via store.

    Returns the original text unchanged when compression is disabled, the
    text is small, or compression wouldn't save enough to matter.
    """
    if not isinstance(text, str) or len(text) < MIN_COMPRESS_CHARS:
        return text
    # Skill tools deliver the procedure the model is required to follow verbatim;
    # compressing them (head/tail + summary) strips the very steps they exist to
    # provide. Always pass skill output through in full.
    if tool_name in ("browse_skills", "read_skill"):
        return text
    if not compression_enabled():
        return text

    try:
        compressed = _try_compress_json(text)
        if compressed is None:
            compressed = _collapse_log_lines(text)
        compressed = _head_tail(compressed, TARGET_CHARS)
    except Exception as e:  # never let compression break a tool round
        logger.warning(f"context_optimizer: compression failed ({e}); passing through")
        return text

    if len(compressed) > len(text) * (1 - MIN_SAVINGS):
        return text

    oid = _store_original(text, tool_name)
    marker = (
        f"\n\n[Output compressed: {len(text):,} → {len(compressed):,} chars. "
        f"The FULL original is stored under id `{oid}` — if you need omitted "
        f"details, call the expand_output tool with that id (line 1 = id, "
        f"optional line 2 = search term or page number).]"
    )
    logger.info(
        f"context_optimizer: compressed {tool_name or 'tool'} output "
        f"{len(text)} -> {len(compressed)} chars (id={oid})"
    )
    return compressed + marker


def do_expand_output(content: str) -> dict:
    """`expand_output` tool implementation.

    Line 1 = stored output id. Line 2 (optional) = search term, or a page
    number (1-based) to page through very large outputs.
    """
    lines = (content or "").strip().split("\n")
    oid = lines[0].strip().strip("`'\"") if lines else ""
    arg = lines[1].strip() if len(lines) > 1 else ""

    if not oid:
        return {
            "error": "Usage: line 1 = output id (e.g. out_3fa9c2), optional line 2 = search term or page number.",
            "exit_code": 1,
        }

    entry = get_stored_output(oid)
    if not entry:
        return {
            "error": f"No stored output with id '{oid}'. Stored outputs are kept in memory and expire when the server restarts or the store fills up.",
            "exit_code": 1,
        }

    text = entry["text"]

    # Search mode: return matching lines with a little context.
    if arg and not arg.isdigit():
        needle = arg.lower()
        src_lines = text.split("\n")
        hits = [i for i, l in enumerate(src_lines) if needle in l.lower()]
        if not hits:
            return {
                "output": f"No lines matching '{arg}' in stored output {oid} ({len(text):,} chars total).",
                "exit_code": 0,
            }
        chunks, last_end = [], -1
        for i in hits[:80]:
            start, end = max(0, i - 2), min(len(src_lines), i + 3)
            if start > last_end:
                chunks.append(f"--- line {start + 1} ---")
            chunks.extend(src_lines[max(start, last_end) : end])
            last_end = end
        body = "\n".join(chunks)
        if len(body) > EXPAND_PAGE_CHARS:
            body = body[:EXPAND_PAGE_CHARS] + "\n… [match output truncated]"
        return {
            "output": f"{len(hits)} matching line(s) for '{arg}' in {oid}:\n{body}",
            "exit_code": 0,
        }

    # Page mode.
    page = max(1, int(arg)) if arg.isdigit() else 1
    total_pages = max(1, -(-len(text) // EXPAND_PAGE_CHARS))
    page = min(page, total_pages)
    start = (page - 1) * EXPAND_PAGE_CHARS
    body = text[start : start + EXPAND_PAGE_CHARS]
    header = f"Stored output {oid} ({entry.get('tool') or 'tool'}, {len(text):,} chars) — page {page}/{total_pages}:"
    if total_pages > 1:
        header += (
            f" (pass a page number 1-{total_pages} on line 2 for other pages, or a search term)"
        )
    return {"output": f"{header}\n{body}", "exit_code": 0}
