"""
history_replay.py

Replay past tool calls and their outputs into the prompt.

Talos persists a turn's tool activity in the assistant message's
``metadata.tool_events`` (tool name, command/arguments, output, exit code) so
the UI can redraw it on reload. Nothing ever fed it back to the model, so on the
next turn the assistant could see its own final prose but NOT what any tool had
returned — ask "what port was that on?" a turn later and it had to re-run the
retrieval or guess. Claude/ChatGPT keep tool exchanges in the window as
first-class messages until compaction; this closes that gap.

Shape: one synthetic `user` message per past turn, carrying a compact record of
that turn's calls, inserted immediately before the assistant message it belongs
to. That is deliberately the same shape the fenced runtime path already uses for
in-flight results (`[Tool execution results]` as a user message), so the model
sees a consistent format for tool output whether it is from this turn or an
earlier one. Reconstructing native `assistant.tool_calls` + `role:"tool"` pairs
instead would mean inventing `tool_call_id`s that never existed, and any gap in
the saved data would produce an orphaned tool message that makes the whole
request 400.

`ChatMessage` only has role/content/metadata, so there is nowhere to persist a
real tool message — which is why this reconstructs rather than stores.
"""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Opens a replayed block. Distinct from the runtime prefix so the model can tell
# "this is what happened earlier" from "this just ran".
REPLAY_PREFIX = "[Tool results from an earlier turn in this conversation]"

# Marks the messages this module creates, so display/persistence paths can tell
# them apart from real user turns (same mechanism as the "slash" source filter).
REPLAY_SOURCE = "tool_replay"

# 0 = unbounded, everywhere below. Replay is LOSSLESS by default: truncating it
# is gradual, silent context loss, which is precisely what compaction exists to
# replace. Growth is bounded by compaction instead — it summarizes the older half
# and prunes those messages from stored history, so their tool records stop being
# replayed at all. These constants are only the fallback for when settings can't
# be read; the live values come from DEFAULT_SETTINGS / settings.json.
DEFAULT_OUTPUT_MAX_CHARS = 0
DEFAULT_TURN_MAX_CHARS = 0
DEFAULT_TOTAL_MAX_CHARS = 0

# Retrieval output gets its own knob, so that anyone who DOES impose caps can
# keep it more generous than the generic one. Its output is the evidence an
# answer rests on and is not cheaply recoverable: re-running a retrieval costs a
# round and can legitimately return DIFFERENT passages (reranker scores, changed
# index, live web). A 2k head of a 13k knowledge-base hit is a stub that invites
# the model to fill the rest from memory — the exact failure that produced a
# fabricated compose file. Shell and Python output, by contrast, is reproducible
# on demand and usually just a log.
_RETRIEVAL_TOOLS = frozenset({"search_knowledge", "web_fetch", "web_search", "get_news"})
DEFAULT_RETRIEVAL_OUTPUT_MAX_CHARS = 0


def _setting(key: str, default: int) -> int:
    try:
        from src.settings import get_setting

        value = int(get_setting(key, default))
        return value if value >= 0 else default
    except Exception:
        return default


def replay_enabled() -> bool:
    try:
        from src.settings import get_setting

        return bool(get_setting("history_tool_replay_enabled", True))
    except Exception:
        return True


def _arguments_text(command: Any) -> str:
    """Render a tool's input compactly.

    `command` is whatever the executor recorded — a raw shell string for bash,
    a JSON blob for structured tools. JSON is re-dumped without the indentation
    noise; anything else is passed through.
    """
    if command is None:
        return ""
    if isinstance(command, (dict, list)):
        try:
            return json.dumps(command, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(command)
    text = str(command).strip()
    if text[:1] in "{[":
        try:
            return json.dumps(json.loads(text), ensure_ascii=False)
        except (json.JSONDecodeError, ValueError):
            return text
    return text


def format_tool_events(
    events: List[Dict],
    output_max_chars: int = DEFAULT_OUTPUT_MAX_CHARS,
    turn_max_chars: int = DEFAULT_TURN_MAX_CHARS,
    retrieval_max_chars: int = DEFAULT_RETRIEVAL_OUTPUT_MAX_CHARS,
) -> str:
    """Render one turn's tool_events as a replayable block, or "" if there's
    nothing worth replaying.

    Every cap is 0 = unbounded by default, so nothing is dropped. When a cap is
    set, the truncation is always MARKED, so the model knows it is reading a head
    rather than the whole output — an unmarked truncation reads as complete and is
    what invites invention.
    """
    if not events:
        return ""
    parts: List[str] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        tool = str(ev.get("tool") or "?")
        args = _arguments_text(ev.get("command"))
        out = str(ev.get("output") or "").strip()
        rc = ev.get("exit_code")

        head = f"[{tool}] {args}" if args else f"[{tool}]"
        rc_s = f" (exit {rc})" if rc not in (None, 0) else ""
        cap = retrieval_max_chars if tool in _RETRIEVAL_TOOLS else output_max_chars
        if not out:
            body = "(no output)"
        elif cap and len(out) > cap:
            dropped = len(out) - cap
            body = out[:cap] + f"\n… [+{dropped} chars truncated]"
        else:
            body = out
        parts.append(f"{head}{rc_s}\n-> {body}")

    if not parts:
        return ""
    block = "\n\n".join(parts)
    if turn_max_chars and len(block) > turn_max_chars:
        block = block[:turn_max_chars] + "\n… [earlier-turn tool record truncated]"
    return block


def build_artifact_manifest(messages: List[Dict]) -> str:
    """List the documents and images produced earlier in this conversation.

    A manifest instead of the content itself, deliberately. Artifacts are durable
    and addressable: the model can pull any of them back with `manage_documents`
    (`action=read`) the moment it needs the text. Inlining every artifact on
    every turn would re-send the same kilobytes indefinitely — and on a
    prefill-bound box that is the expensive kind of waste. What the model
    actually lacks is not the bytes, it is the KNOWLEDGE that they exist and are
    fetchable; a stale inline copy is also worse than a fresh read, since the
    user may have edited the document in the editor since.
    """
    docs: Dict[str, str] = {}
    images: List[str] = []
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        for ev in (msg.get("metadata") or {}).get("tool_events") or []:
            if not isinstance(ev, dict):
                continue
            doc_id = ev.get("doc_id")
            if doc_id:
                docs[str(doc_id)] = str(ev.get("doc_title") or "").strip() or "Untitled"
            for name in ev.get("created_artifacts") or []:
                if isinstance(name, str) and name not in images:
                    images.append(name)

    if not docs and not images:
        return ""

    lines = ["[Artifacts you created earlier in this conversation]"]
    for doc_id, title in docs.items():
        lines.append(f"- document: [{title}](#document-{doc_id}) — id `{doc_id}`")
    for name in images:
        lines.append(f"- file: {name}")
    lines.append(
        "These already exist — do not recreate them. To read a document's current "
        'content call manage_documents with {"action":"read","document_id":"<id>"}; '
        "to change one use edit_document. Reference them with the markdown anchors above."
    )
    return "\n".join(lines)


def expand_tool_history(messages: List[Dict], enabled: Optional[bool] = None) -> List[Dict]:
    """Insert replayed tool records into a prompt message list.

    Walks the messages, and for every assistant message carrying
    ``metadata.tool_events`` inserts one synthetic user message with that turn's
    tool record immediately BEFORE it — so the order reads: user asked → tools
    returned this → assistant answered.

    Lossless by default (all caps 0). If a total budget IS set, newest turns are
    budgeted first and older records are dropped whole rather than truncating
    everything evenly: recent tool output is what a follow-up is usually about,
    and a stale record is the cheapest thing to lose. Returns a new list; input
    is not mutated.
    """
    if enabled is None:
        enabled = replay_enabled()
    if not enabled or not messages:
        return messages

    output_max = _setting("history_tool_output_max_chars", DEFAULT_OUTPUT_MAX_CHARS)
    turn_max = _setting("history_tool_turn_max_chars", DEFAULT_TURN_MAX_CHARS)
    total_max = _setting("history_tool_total_max_chars", DEFAULT_TOTAL_MAX_CHARS)
    retrieval_max = _setting(
        "history_retrieval_output_max_chars", DEFAULT_RETRIEVAL_OUTPUT_MAX_CHARS
    )

    # Pass 1, newest first: render what fits in the total budget.
    blocks: Dict[int, str] = {}
    spent = 0
    for idx in range(len(messages) - 1, -1, -1):
        msg = messages[idx]
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        events = (msg.get("metadata") or {}).get("tool_events")
        if not isinstance(events, list) or not events:
            continue
        block = format_tool_events(events, output_max, turn_max, retrieval_max)
        if not block:
            continue
        if total_max and spent + len(block) > total_max:
            # Out of budget — every remaining turn is older still, so stop.
            logger.debug(
                "[history_replay] budget exhausted at %d chars; older tool records omitted", spent
            )
            break
        blocks[idx] = block
        spent += len(block)

    manifest = build_artifact_manifest(messages)
    if not blocks and not manifest:
        return messages

    # The manifest goes immediately before the live query: adjacent to what the
    # user just asked, and as a SYSTEM message so it (a) is not mistaken for the
    # current user turn by anything looking for the last user message, and (b)
    # survives compaction, which keeps system messages. Index of the final user
    # message; -1 when there isn't one.
    manifest_at = next(
        (
            i
            for i in range(len(messages) - 1, -1, -1)
            if isinstance(messages[i], dict) and messages[i].get("role") == "user"
        ),
        -1,
    )

    # Pass 2, in order: splice the rendered blocks in.
    out: List[Dict] = []
    for idx, msg in enumerate(messages):
        block = blocks.get(idx)
        if block:
            out.append(
                {
                    "role": "user",
                    "content": f"{REPLAY_PREFIX}\n\n{block}",
                    "metadata": {"source": REPLAY_SOURCE},
                }
            )
        if manifest and idx == manifest_at:
            out.append(
                {"role": "system", "content": manifest, "metadata": {"source": REPLAY_SOURCE}}
            )
        out.append(msg)
    if manifest and manifest_at < 0:
        out.append({"role": "system", "content": manifest, "metadata": {"source": REPLAY_SOURCE}})

    logger.info(
        "[history_replay] replayed %d turn(s) of tool output, %d chars%s",
        len(blocks),
        spent,
        " + artifact manifest" if manifest else "",
    )
    return out
