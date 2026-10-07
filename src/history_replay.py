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
_RETRIEVAL_TOOLS = frozenset(
    {"search_knowledge", "read_knowledge", "delegate", "web_fetch", "web_search", "get_news"}
)
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
        if (msg.get("metadata") or {}).get(WIRE_REPLAYED):
            # Replayed verbatim by apply_turn_wires — its tool calls and results
            # are already in the prompt as real messages.
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


# ── Verbatim turn replay ("wire") ───────────────────────────────────────────
#
# The reconstruction above changes a turn's shape between the request that
# produced it and every later request: native tool calls become one summary
# block, the question loses the context it was sent with. vLLM's prefix cache
# reuses work only up to the first differing token, so each follow-up re-ran
# the prefill for the whole previous turn — 25k+ tokens, 30–40 s before the
# first token after a dashboard turn.
#
# So a finished turn's messages are stored exactly as they were sent (the
# question with its context, the assistant's tool calls, the tool results, the
# final answer) and replayed unchanged on later turns — append-only, the way
# Claude and other chat APIs keep a conversation. Turns stored without a wire
# (chats from before this existed) still go through expand_tool_history.
#
# The edge cases follow what Claude does with a conversation:
# * an edited question deletes that turn and everything after it and resends
#   (the frontend already does this); the question fingerprint is a backstop;
# * an answer edited by hand is what the model sees from then on;
# * a stopped answer keeps exactly what had happened up to the stop;
# * a turn that compacted itself mid-way carries the compacted conversation,
#   which replaces everything before it (`base`).

# Metadata key on the persisted assistant message holding its turn's wire.
WIRE_KEY = "_wire"
# Marker set on the replayed final assistant message: skip the legacy replay
# block for it, but keep its tool_events visible to build_artifact_manifest.
WIRE_REPLAYED = "wire_replayed"
# Marks the agent's leading system block (system prompt, policy) — never part
# of a stored turn. Set in the agent loop.
HEAD_KEY = "_head"
# Marks the per-request preface (skills index and the like) from
# build_chat_context — rebuilt fresh every turn, so never stored either.
PREFACE_KEY = "_preface"
# Marks messages that were already in the conversation before this turn
# (set in build_chat_context); everything after the last marked one is the turn
# that make_turn_wire stores. Dropped before sending, like all unknown keys.
PRIOR_KEY = "_prior"
_WIRE_VERSION = 1
_WIRE_ALLOWED_KEYS = ("role", "content", "name", "tool_call_id", "tool_calls")
# Larger wires (inline images, huge tool output) are not stored; the turn then
# falls back to the reconstructed replay.
WIRE_MAX_BYTES = 16_000_000


def _content_fingerprint(content: Any) -> str:
    import hashlib

    raw = json.dumps(content, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def collect_turn_messages(
    messages: List[Dict], final_text: str, compacted: bool = False
) -> List[Dict]:
    """This turn's messages as sent, plus the final (or, after a stop, partial)
    answer text of the last round, which no request carried yet.

    Normally that is everything after the prior conversation (PRIOR_KEY). After
    a mid-turn compaction it is the whole compacted conversation minus the
    system head and preface — the summary stands in for what came before.
    """
    if compacted:
        turn = [
            m
            for m in messages
            if isinstance(m, dict) and not m.get(HEAD_KEY) and not m.get(PREFACE_KEY)
        ]
    else:
        last_prior = max(
            (i for i, m in enumerate(messages) if isinstance(m, dict) and m.get(PRIOR_KEY)),
            default=-1,
        )
        if last_prior < 0:
            # No prior conversation: the turn starts after the system head.
            last_prior = next(
                (i - 1 for i, m in enumerate(messages) if not m.get(HEAD_KEY)),
                len(messages) - 1,
            )
        turn = list(messages[last_prior + 1 :])
    if not turn:
        return []
    if (final_text or "").strip() and not (
        turn[-1].get("role") == "assistant" and (turn[-1].get("content") or "") == final_text
    ):
        turn.append({"role": "assistant", "content": final_text})
    return turn


def make_turn_wire(
    sent_messages: List[Dict], question_content: Any, base: bool = False
) -> Optional[Dict]:
    """Package a turn's sent messages for storage, or None if too large/empty.

    `question_content` is the user message as stored in the session history; it
    is fingerprinted so an edited question never replays a stale turn. `base`
    marks a compacted turn that replaces everything before it.
    """
    clean = []
    for m in sent_messages or []:
        if not isinstance(m, dict) or not m.get("role"):
            continue
        clean.append({k: m[k] for k in _WIRE_ALLOWED_KEYS if k in m and m[k] is not None})
        if m.get("role") == "assistant" and "content" not in clean[-1]:
            clean[-1]["content"] = None
    if not clean:
        return None
    wire = {"v": _WIRE_VERSION, "q": _content_fingerprint(question_content), "messages": clean}
    if base:
        wire["base"] = True
    try:
        size = len(json.dumps(wire, ensure_ascii=False, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return None
    if size > WIRE_MAX_BYTES:
        logger.info("[history_replay] turn wire not stored (%d bytes)", size)
        return None
    return wire


def stamp_answer(wire: Dict, answer_content: Any) -> None:
    """Record the answer as saved, so a later hand edit can be detected."""
    wire["a"] = _content_fingerprint(answer_content)


def apply_turn_wires(history: List[Dict]) -> List[Dict]:
    """Replace each stored (question, answer) pair that has a wire by the
    messages exactly as they were sent. Returns a new list.

    A pair is replaced only when the answer's wire matches the question right
    before it (an edited or regenerated question falls back to the plain pair).
    """
    import copy

    out: List[Dict] = []
    for msg in history:
        md = (msg.get("metadata") or {}) if isinstance(msg, dict) else {}
        wire = md.get(WIRE_KEY)
        prev = out[-1] if out else None
        if (
            msg.get("role") == "assistant"
            and isinstance(wire, dict)
            and wire.get("v") == _WIRE_VERSION
            and isinstance(wire.get("messages"), list)
            and wire["messages"]
            and isinstance(prev, dict)
            and prev.get("role") == "user"
            and wire.get("q") == _content_fingerprint(prev.get("content"))
        ):
            out.pop()  # the plain question — the wire carries it as sent
            if wire.get("base"):
                # Compacted mid-turn: its summary already covers everything before.
                out.clear()
            replayed = copy.deepcopy(wire["messages"])
            if wire.get("a") and wire["a"] != _content_fingerprint(msg.get("content")):
                # The answer was edited by hand: the model sees the edited text,
                # like the user does.
                while replayed and replayed[-1].get("role") == "assistant":
                    replayed.pop()
                replayed.append({"role": "assistant", "content": msg.get("content")})
            # Hand the turn's tool_events to the artifact manifest via the last
            # assistant message (metadata never reaches the provider).
            for m in reversed(replayed):
                if m.get("role") == "assistant":
                    m["metadata"] = {
                        "tool_events": md.get("tool_events") or [],
                        WIRE_REPLAYED: True,
                    }
                    break
            out.extend(replayed)
            continue
        if isinstance(msg, dict) and WIRE_KEY in md:
            msg = {**msg, "metadata": {k: v for k, v in md.items() if k != WIRE_KEY}}
        out.append(msg)
    return out
