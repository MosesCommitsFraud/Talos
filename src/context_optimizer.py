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
# This is the *aggressive* floor, used only when the context is nearly full.
MIN_COMPRESS_CHARS = 4_000
# Target size for a compressed output (chars, ~1.5K tokens). Aggressive end.
TARGET_CHARS = 5_000
# Compression must save at least this fraction or the original is kept
# (a marker that says "saved 3%" is pure noise).
MIN_SAVINGS = 0.25

# --- Context-pressure scaling -------------------------------------------------
# Compression is not free: head/tail truncation drops the middle of a tool
# output, and the model only recovers it by noticing the marker and spending a
# round on expand_output. That trade is worth it when the context is about to
# overflow and worthless when there is plenty of room. So the thresholds move
# with how full the context actually is.
#
#   pressure < FLOOR    -> pass everything through untouched
#   FLOOR..CEILING      -> interpolate between the relaxed and aggressive limits
#   pressure >= CEILING -> full aggression (MIN_COMPRESS_CHARS / TARGET_CHARS)
PRESSURE_FLOOR = 0.60
PRESSURE_CEILING = 0.90
# Limits used at PRESSURE_FLOOR. Tool outputs are already capped upstream
# (MAX_OUTPUT_CHARS=10k, MAX_READ_CHARS=20k), so a 16k floor means only a
# full-size file read is touched while there is still room to spare.
RELAXED_COMPRESS_CHARS = 16_000
RELAXED_TARGET_CHARS = 12_000

# --- Tools whose output is never compressed ----------------------------------
# Compression trades fidelity for room: head/tail cuts through the MIDDLE of an
# output and the model only recovers it by spending a round on expand_output.
# That trade is wrong for three kinds of tool:
#
#   1. Verbatim instructions (browse_skills, read_skill) — compressing the
#      procedure strips the steps the tool exists to deliver.
#   2. The recovery path itself (expand_output) — compressing it re-stores the
#      expansion under a new id, so the model expands the expansion forever and
#      never reaches the content.
#   3. Retrieval (search_knowledge, web_fetch, web_search) — the retrieved text
#      IS the answer's evidence, and the model cannot re-derive the dropped
#      middle from anywhere. A truncated RAG hit reads as complete, so the model
#      fills the hole with a plausible invention. search_knowledge matters most:
#      it is the ONLY tool here with no upstream output cap (its size comes from
#      top-k × parent-chunk size and routinely exceeds the relaxed 16k floor),
#      which is exactly why it was the one that broke.
#
# Deliberately NOT exempt — for these, compression is the correct behaviour and
# a flat exemption would trade a real overflow for a fidelity gain that isn't
# needed:
#   bash / python / run_cell / query_sql are capped at MAX_OUTPUT_CHARS (10k)
#   before they get here, and read_file at MAX_READ_CHARS (20k). 10k is below
#   the relaxed 16k floor, so they are only ever compressed once pressure is
#   genuinely high and the floor has interpolated down — the point at which the
#   alternative is overflowing the window. Their compressors also match their
#   shape (log-run collapsing, JSON array crushing, both of which annotate what
#   they removed), and the model can always re-run a narrower command, a LIMIT'd
#   query, or a targeted grep. api_call is the JSON crusher's main case.
NEVER_COMPRESS_TOOLS = frozenset(
    {
        "browse_skills",
        "read_skill",
        "expand_output",
        "search_knowledge",
        "web_fetch",
        "web_search",
    }
)

# Ceiling on the exemption. search_knowledge has no upstream cap at all — its
# size is top-k × parent-chunk size, so a wide retrieval with large parents can
# run to six figures of characters. Passing that through whole would trade a
# truncated answer for a blown context window, which is worse. Above this,
# exempt tools are compressed like anything else (still reversible via the
# store). Set well clear of a normal multi-hit retrieval (~19k observed) so the
# ordinary case is untouched.
EXEMPTION_CEILING_CHARS = 48_000

# expand_output is exempt without any ceiling: it is the recovery path, and
# compressing it is the loop this list exists to prevent. Its own page size
# (EXPAND_PAGE_CHARS) is what bounds it.
ALWAYS_EXEMPT_TOOLS = frozenset({"expand_output"})

# Reversible store: id -> {"text", "tool"}. Bounded so a long-running server
# can't leak memory; oldest entries are evicted first.
_STORE_MAX_ENTRIES = 200
_STORE_MAX_TOTAL_CHARS = 20_000_000  # ~20 MB of text
_store: "OrderedDict[str, dict]" = OrderedDict()
_store_total_chars = 0
_store_lock = threading.Lock()

# How much an expand_output call returns per page. Kept below
# RELAXED_COMPRESS_CHARS as belt-and-braces: the exemption in
# optimize_tool_output is what actually prevents an expansion from being
# re-compressed, but a page that is smaller than the gentlest compression floor
# cannot trigger it even if that exemption is ever lost. At the old 18_000 every
# full page was guaranteed to exceed the 16_000 floor.
EXPAND_PAGE_CHARS = 15_000


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


def _thresholds_for_pressure(pressure: Optional[float]) -> Optional[tuple]:
    """Resolve (min_compress_chars, target_chars) for the current context load.

    `pressure` is used/budget tokens. None means the caller couldn't measure it
    — fall back to the aggressive limits rather than silently disabling
    compression for a caller that may genuinely be near the wall. Returns None
    when there is enough headroom that compressing would only cost fidelity.
    """
    if pressure is None:
        return MIN_COMPRESS_CHARS, TARGET_CHARS
    if pressure < PRESSURE_FLOOR:
        return None
    span = PRESSURE_CEILING - PRESSURE_FLOOR
    t = 1.0 if span <= 0 else min(1.0, (pressure - PRESSURE_FLOOR) / span)
    min_chars = int(RELAXED_COMPRESS_CHARS + (MIN_COMPRESS_CHARS - RELAXED_COMPRESS_CHARS) * t)
    target = int(RELAXED_TARGET_CHARS + (TARGET_CHARS - RELAXED_TARGET_CHARS) * t)
    return min_chars, target


def context_pressure(used_tokens: int, budget_tokens: int) -> Optional[float]:
    """Fraction of the input budget already consumed, or None if unmeasurable."""
    try:
        if used_tokens > 0 and budget_tokens > 0:
            return float(used_tokens) / float(budget_tokens)
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return None


def optimize_tool_output(
    text: str,
    tool_name: str = "",
    used_tokens: int = 0,
    budget_tokens: int = 0,
) -> str:
    """Compress a formatted tool output if it is large; reversible via store.

    Compression scales with context pressure: with plenty of headroom the
    output passes through in full, and the limits tighten as the context fills.
    Pass `used_tokens`/`budget_tokens` to enable that; omitting both keeps the
    unconditional aggressive behaviour.

    Returns the original text unchanged when compression is disabled, there is
    enough context headroom, the text is small, or compression wouldn't save
    enough to matter.
    """
    if not isinstance(text, str):
        return text

    limits = _thresholds_for_pressure(context_pressure(used_tokens, budget_tokens))
    if limits is None:
        return text
    min_compress_chars, target_chars = limits

    if len(text) < min_compress_chars:
        return text
    # Instructions, the recovery path, and retrieved evidence are never
    # compressed — see NEVER_COMPRESS_TOOLS for why each one is on the list.
    if tool_name in ALWAYS_EXEMPT_TOOLS:
        return text
    if tool_name in NEVER_COMPRESS_TOOLS and len(text) <= EXEMPTION_CEILING_CHARS:
        return text
    if not compression_enabled():
        return text

    try:
        compressed = _try_compress_json(text)
        if compressed is None:
            compressed = _collapse_log_lines(text)
        compressed = _head_tail(compressed, target_chars)
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
        f"{len(text)} -> {len(compressed)} chars (id={oid}, "
        f"floor={min_compress_chars}, target={target_chars}, "
        f"pressure={used_tokens}/{budget_tokens})"
    )
    return compressed + marker


# A page request, however the model phrases it: "2", "page 2", "p2", "Seite 2",
# "page: 2", "#2". The header tells it to "pass a page number", so `page 2` is
# the natural thing to write — and it used to fall through to search mode and
# come back "No lines matching 'page 1'", costing rounds for nothing.
_PAGE_ARG_RE = re.compile(r"^(?:(?:page|pg|p|seite|s)\s*[:#]?\s*)?(\d+)$", re.IGNORECASE)


def _page_number(arg: str) -> Optional[int]:
    """Page number if `arg` requests one, else None (meaning: search term)."""
    m = _PAGE_ARG_RE.match((arg or "").strip().strip("#"))
    return int(m.group(1)) if m else None


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
    requested_page = _page_number(arg)
    total_pages = max(1, -(-len(text) // EXPAND_PAGE_CHARS))

    # Search mode: return matching lines with a little context.
    if arg and requested_page is None:
        needle = arg.lower()
        src_lines = text.split("\n")
        hits = [i for i, l in enumerate(src_lines) if needle in l.lower()]
        if not hits:
            return {
                "output": (
                    f"No lines matching '{arg}' in stored output {oid} "
                    f"({len(text):,} chars total). It has {total_pages} page(s) — "
                    f"put a page number on line 2 (e.g. `1`) to read it in full, "
                    f"or try a different search term."
                ),
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
    page = min(max(1, requested_page or 1), total_pages)
    start = (page - 1) * EXPAND_PAGE_CHARS
    body = text[start : start + EXPAND_PAGE_CHARS]
    header = f"Stored output {oid} ({entry.get('tool') or 'tool'}, {len(text):,} chars) — page {page}/{total_pages}:"
    if page < total_pages:
        # Name the exact next call. A model that is told only "pages exist" tends
        # to treat one page as the whole document and fill the rest from
        # guesswork; the remaining pages are content it has not read.
        header += (
            f"\n[Page {page} of {total_pages}. This is PARTIAL — pages "
            f"{page + 1}-{total_pages} are content you have NOT seen. To continue, "
            f"call expand_output again with `{oid}` on line 1 and `{page + 1}` on "
            f"line 2. Do not describe the unread pages until you have read them.]"
        )
    return {"output": f"{header}\n{body}", "exit_code": 0}
