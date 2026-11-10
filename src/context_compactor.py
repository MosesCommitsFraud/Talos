"""
context_compactor.py

Auto-compacts conversation history when approaching context window limits.
Summarizes older messages via the same LLM, preserving key context.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from core.models import ChatMessage
from src.endpoint_resolver import resolve_endpoint
from src.llm_core import llm_call_async
from src.model_context import estimate_tokens, get_context_length

logger = logging.getLogger(__name__)


def _content_as_text(content: Any) -> str:
    """Flatten a message's content to plain text.

    Handles the three shapes that flow through history: a plain string, a
    multimodal list of content blocks (vision/image attachments), and None
    (assistant turns that carried only native tool_calls persist content as
    None). Returns "" for anything without text so callers can safely slice
    the result.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("text"))
    return ""


COMPACT_THRESHOLD = 0.85  # Default: trigger compaction at 85% of context window
SUMMARY_MAX_TOKENS = 1024

# Inline figures the model placed in an answer (![caption](/api/personal/rag-asset…)).
# These must survive compaction: the LLM summary would otherwise collapse them into
# prose and the image would disappear from both context and the visible transcript.
_FIGURE_MD_RE = re.compile(r"!\[[^\]]*\]\(/api/personal/rag-asset\?source=[^)\s]*\)")


def _extract_figure_markdown(msgs: List[Dict]) -> List[str]:
    """Collect distinct inline figure image-markdown from the messages being
    summarized, so it can be carried forward verbatim into the kept summary."""
    seen: set = set()
    out: List[str] = []
    for m in msgs:
        for md in _FIGURE_MD_RE.findall(_content_as_text(m.get("content"))):
            if md not in seen:
                seen.add(md)
                out.append(md)
    return out


def get_compact_threshold() -> float:
    """Read the auto-compact trigger from settings (`compact_threshold`).

    Accepts a fraction (0.7) or a percent (70). Clamped to [0.3, 0.95] so a
    typo can't disable compaction or make it fire on every message.
    """
    try:
        from src.settings import load_settings

        val = float(load_settings().get("compact_threshold", COMPACT_THRESHOLD))
        if val > 1:
            val /= 100.0
        return min(0.95, max(0.3, val))
    except Exception:
        return COMPACT_THRESHOLD


SMALL_CONTEXT_LIMIT = 8192  # Models with context <= this get aggressive trimming

# Cursor-style self-summarization prompt — produces structured, dense summaries
SELF_SUMMARY_SYSTEM_PROMPT = """You are summarizing a conversation to preserve context after compaction. Produce a structured summary that lets the conversation continue seamlessly.

Use this format:

## Conversation Summary
**Turns summarized:** {count}  |  **Compactions so far:** {n}

### User Goal
One sentence describing what the user is trying to accomplish.

### What Was Done
- Bullet points of completed actions, decisions made, and key outputs
- Include specific file paths, function names, variable names, URLs, and config values
- Note any errors encountered and how they were resolved

### Current State
What is the system/code/task state right now? What was the last thing discussed?

### Pending / Next Steps
- What remains to be done
- Any open questions or blockers

### Key Context
- Important constraints, preferences, or decisions that must not be forgotten
- Specific values: model names, ports, paths, credentials references, versions

Keep the summary under 1000 tokens. Be dense — every token should carry information. Do not include pleasantries or meta-commentary."""


def _sanitize_tool_messages(msgs: List[Dict]) -> List[Dict]:
    """Drop orphaned `tool` messages and dangling assistant `tool_calls`.

    OpenAI's API requires every `role:"tool"` message to immediately
    follow an assistant message that carries `tool_calls` (or another
    tool message in the same batch). Front-trimming the history can cut
    the assistant `tool_calls` parent while keeping its tool responses,
    which triggers: "messages with role 'tool' must be a response to a
    preceding message with 'tool_calls'". This pass repairs that:
      - drops `tool` messages with no valid preceding tool_calls
      - drops assistant `tool_calls` messages whose tool responses were
        all trimmed away (some providers reject unanswered tool_calls)
    """
    # Pass 1: drop orphan tool messages.
    cleaned: List[Dict] = []
    in_batch = False  # are we right after an assistant tool_calls (or mid-batch)?
    for m in msgs:
        role = m.get("role")
        if role == "tool":
            if in_batch:
                cleaned.append(m)
            # else: orphan — drop
            continue
        if role == "assistant" and m.get("tool_calls"):
            in_batch = True
        else:
            in_batch = False
        cleaned.append(m)

    # Pass 2: drop assistant tool_calls messages that have NO following
    # tool response (dangling) — walk backwards so we know what follows.
    out: List[Dict] = []
    for i, m in enumerate(cleaned):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            nxt = cleaned[i + 1] if i + 1 < len(cleaned) else None
            if not (nxt and nxt.get("role") == "tool"):
                # Dangling tool_calls — keep the message but strip the
                # tool_calls so it's a plain assistant turn (preserves any
                # text content the model produced alongside the calls).
                m = {k: v for k, v in m.items() if k != "tool_calls"}
                if not (m.get("content") or "").strip():
                    continue  # nothing left worth keeping
        out.append(m)
    return out


def _message_text_token_estimate(text: str) -> int:
    if not isinstance(text, str):
        return 4
    return int(len(text) * 0.3) + 4


def _truncate_text_to_token_budget(text: str, token_budget: int) -> str:
    """Trim a too-large current user message instead of dropping it entirely."""
    if token_budget <= 32:
        return "[Current user message omitted: it exceeded the model context window.]"

    if not isinstance(text, str):
        # This helper is typed/used as text downstream, so return an empty
        # string rather than the raw non-string (which would move the crash
        # into the caller that concatenates/measures the result).
        return ""
    # Match src.model_context.estimate_tokens' rough chars * 0.3 estimate.
    max_chars = max(200, int((token_budget - 16) / 0.3))
    if len(text) <= max_chars:
        return text

    notice = (
        "\n\n[Notice: the pasted message was too large for this model's context "
        "window, so Talos kept the beginning and end.]"
    )
    keep_chars = max(200, max_chars - len(notice))
    head_len = max(100, int(keep_chars * 0.7))
    tail_len = max(80, keep_chars - head_len)
    return text[:head_len].rstrip() + notice + "\n\n" + text[-tail_len:].lstrip()


def _truncate_tool_call_args(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """Shrink oversized assistant tool_call arguments to fit token_budget."""
    tool_calls = msg.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return msg
    content_tokens = estimate_tokens(
        [{"role": msg.get("role", "assistant"), "content": msg.get("content")}]
    )
    per_call = max(16, (max(0, token_budget - content_tokens)) // len(tool_calls))
    new_calls = []
    changed = False
    for tc in tool_calls:
        fn = tc.get("function") if isinstance(tc, dict) else None
        args = fn.get("arguments") if isinstance(fn, dict) else None
        if isinstance(args, str) and int(len(args) * 0.3) > per_call:
            new_fn = dict(fn)
            new_fn["arguments"] = json.dumps({"_truncated_for_context": len(args)})
            new_tc = dict(tc)
            new_tc["function"] = new_fn
            new_calls.append(new_tc)
            changed = True
        else:
            new_calls.append(tc)
    if not changed:
        return msg
    out = dict(msg)
    out["tool_calls"] = new_calls
    return out


def _truncate_message_to_token_budget(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """Return a copy of msg whose content and tool-call args fit token_budget."""
    out = dict(msg)
    content = out.get("content", "")
    if isinstance(content, str):
        out["content"] = _truncate_text_to_token_budget(content, token_budget)
    elif isinstance(content, list):
        remaining = token_budget
        new_content = []
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "text":
                new_content.append(item)
                continue
            text = item.get("text", "")
            truncated = _truncate_text_to_token_budget(text, remaining)
            cloned = dict(item)
            cloned["text"] = truncated
            new_content.append(cloned)
            remaining -= _message_text_token_estimate(truncated)
        out["content"] = new_content
    return _truncate_tool_call_args(out, token_budget)


def trim_for_context(
    messages: List[Dict], context_length: int, reserve_tokens: int = 512
) -> List[Dict]:
    """Trim system messages to fit within context_length.

    For small-context models, progressively strips:
    1. RAG/memory system messages (keep preset system prompt)
    2. Older conversation turns
    Reserves space for the response.
    """
    budget = context_length - reserve_tokens
    used = estimate_tokens(messages)
    if used <= budget:
        return messages

    logger.info(f"Trimming messages: {used} tokens > {budget} budget (ctx={context_length})")

    # Separate system messages from conversation.
    # Messages marked _protected (e.g. active document) are never trimmed.
    system_msgs = []
    protected_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("_protected"):
            protected_msgs.append(msg)
        elif msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    # Protected messages count toward budget but are never dropped
    protected_tokens = estimate_tokens(protected_msgs)
    budget -= protected_tokens

    # Priority: keep first system msg (preset prompt), drop others (memory, RAG, memo)
    essential_system = system_msgs[:1] if system_msgs else []
    extra_system = system_msgs[1:]

    # Try dropping extra system messages one by one (from the end)
    trimmed = essential_system + convo_msgs
    if estimate_tokens(trimmed) <= budget:
        # Dropping extras was enough — try adding back some
        result = list(essential_system)
        for msg in extra_system:
            candidate = result + [msg] + convo_msgs
            if estimate_tokens(candidate) <= budget:
                result.append(msg)
            else:
                break
        return _sanitize_tool_messages(result + protected_msgs + convo_msgs)

    # Still too big — truncate the first system message (but keep more than 500 chars)
    if essential_system:
        sys_text = essential_system[0].get("content", "")
        if len(sys_text) > 2000:
            essential_system[0] = {
                "role": "system",
                "content": sys_text[:2000] + "\n[System prompt truncated for context limits]",
            }
            trimmed = essential_system + convo_msgs
            if estimate_tokens(trimmed) <= budget:
                return _sanitize_tool_messages(essential_system + protected_msgs + convo_msgs)

    # Still too big — drop older conversation turns BUT always keep the current
    # user turn. If a pasted message alone exceeds the model context, truncate
    # that message with a visible notice instead of dropping it; otherwise the
    # model appears to "ignore" large pastes because it never receives them.
    # Hermes-style: recent context matters more than old context.
    PROTECT_RECENT = 10
    current_msg = convo_msgs[-1:] if convo_msgs else []
    prior_convo = convo_msgs[:-1] if convo_msgs else []
    if len(prior_convo) >= PROTECT_RECENT:
        old_msgs = prior_convo[: -(PROTECT_RECENT - 1)]
        recent_msgs = prior_convo[-(PROTECT_RECENT - 1) :] + current_msg
        while old_msgs and estimate_tokens(essential_system + old_msgs + recent_msgs) > budget:
            old_msgs.pop(0)
        convo_msgs = old_msgs + recent_msgs
    else:
        convo_msgs = prior_convo + current_msg
        while (
            prior_convo and estimate_tokens(essential_system + prior_convo + current_msg) > budget
        ):
            prior_convo.pop(0)
        convo_msgs = prior_convo + current_msg

    # If the current message itself is too large, shrink only that message.
    if current_msg and estimate_tokens(essential_system + protected_msgs + convo_msgs) > budget:
        prefix = essential_system + protected_msgs + convo_msgs[:-1]
        available_for_current = max(64, budget - estimate_tokens(prefix))
        convo_msgs[-1] = _truncate_message_to_token_budget(convo_msgs[-1], available_for_current)

    result = _sanitize_tool_messages(essential_system + protected_msgs + convo_msgs)
    logger.info(f"Trimmed to {estimate_tokens(result)} tokens ({len(result)} messages)")
    return result


async def maybe_compact(
    session,
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
) -> tuple:
    """Check context usage and compact if above threshold.

    Returns (messages, context_length, was_compacted).
    """
    context_length = get_context_length(endpoint_url, model)
    threshold = get_compact_threshold()
    est_used = estimate_tokens(messages)

    # The cheap estimate decides the trigger by default. When it shows we're
    # near the threshold, confirm with the server's real tokenizer (vLLM/
    # llama.cpp /tokenize) so compaction fires on the *actual* count, not a
    # chars*0.3 guess. The 0.8 margin covers the estimate undercounting.
    used = est_used
    exact = False
    if context_length and est_used >= threshold * context_length * 0.8:
        from src.model_context import count_tokens_exact

        real = count_tokens_exact(endpoint_url, model, messages, headers=headers)
        if real:
            used, exact = real, True

    pct = (used / context_length) * 100 if context_length else 0

    if pct < threshold * 100:
        return messages, context_length, False

    logger.info(
        f"Context at {pct:.1f}% ({used}/{context_length} tokens, "
        f"{'exact' if exact else 'estimated'}) — compacting"
    )

    # Split into system preface and conversation
    system_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    if len(convo_msgs) < 4:
        return messages, context_length, False

    # Split conversation: summarize older half, keep recent half
    split_point = len(convo_msgs) // 2
    older = convo_msgs[:split_point]
    recent = convo_msgs[split_point:]

    summary = await _summarize_older(older, system_msgs, endpoint_url, model, headers)
    if summary is None:
        return system_msgs + recent, context_length, False

    compacted = system_msgs + [_summary_message(summary)] + recent

    # Update persisted history using the conversation split point. Runtime
    # messages may include transient preface system messages that are not in
    # session.history, so _update_session_history maps by non-system messages.
    # Replayed tool records are non-system runtime messages that have NO history
    # counterpart either (they are reconstructed from an assistant message's
    # metadata — see src/history_replay.py), so they must not be counted or the
    # mapping lands past the real split and truncates stored history wrongly.
    # Pass the BARE summary — _update_session_history adds its own header.
    _update_session_history(session, split_point - _synthetic_count(older), summary)

    new_used = estimate_tokens(compacted)
    logger.info(
        f"Compacted: {used} -> {new_used} tokens "
        f"({len(older)} messages summarized, {len(recent)} kept)"
    )

    return compacted, context_length, True


def _synthetic_count(msgs: List[Dict]) -> int:
    """How many of `msgs` are runtime-only reconstructions with no counterpart
    in `session.history` (replayed tool records — see src/history_replay.py).

    Anything that counts prompt messages against stored history has to discount
    these, or the index mapping drifts by however many were spliced in.
    """
    from src.history_replay import REPLAY_SOURCE

    return sum(
        1
        for m in msgs
        if isinstance(m, dict) and (m.get("metadata") or {}).get("source") == REPLAY_SOURCE
    )


def _summary_message(summary: str) -> Dict:
    """Wrap a bare summary as the runtime system message.

    Kept separate from the bare text because `_update_session_history` applies
    its own `[Conversation summary]` header to what it persists — handing it the
    already-wrapped content would nest two headers.
    """
    return {
        "role": "system",
        "content": f"[Conversation summary — earlier messages were compacted]\n{summary}",
    }


async def _summarize_older(
    older: List[Dict],
    system_msgs: List[Dict],
    endpoint_url: str,
    model: str,
    headers: Optional[Dict] = None,
) -> Optional[str]:
    """Summarize `older` into bare summary text, or None on failure.

    Shared by the between-turns path (`maybe_compact`) and the mid-turn path
    (`compact_mid_turn`) so both summarize identically and the numbering of
    successive summaries stays consistent. Returns the text, not a message:
    the runtime message and the persisted history entry get different headers.
    """
    # Build the text to summarize
    convo_text = "\n".join(
        f"{msg.get('role', 'user').upper()}: {_content_as_text(msg.get('content'))[:2000]}"
        for msg in older
    )

    # Count prior compactions from existing summary messages
    compaction_count = sum(
        1 for m in system_msgs if "[Conversation summary" in str(m.get("content") or "")
    )

    # Use utility model if configured, otherwise fall back to session model
    util_url, util_model, util_headers = resolve_endpoint("utility")
    compact_url = util_url or endpoint_url
    compact_model = util_model or model
    compact_headers = util_headers if util_url else headers

    prompt = SELF_SUMMARY_SYSTEM_PROMPT.replace("{count}", str(len(older))).replace(
        "{n}", str(compaction_count + 1)
    )
    summary_messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": convo_text},
    ]

    try:
        summary = await llm_call_async(
            compact_url,
            compact_model,
            summary_messages,
            temperature=0.2,
            max_tokens=SUMMARY_MAX_TOKENS,
            headers=compact_headers,
            timeout=30,
        )
    except Exception as e:
        logger.error(f"Compaction summary failed: {e}")
        return None

    # Carry any figures the model showed in the summarized turns into the kept
    # summary verbatim, so they survive compaction instead of being flattened
    # into prose (and lost from the transcript).
    figures = _extract_figure_markdown(older)
    if figures:
        summary = (
            summary + "\n\n### Figures shown earlier (still relevant)\n" + "\n\n".join(figures)
        )

    return summary


# ── Mid-turn compaction ──
#
# maybe_compact runs BETWEEN turns. A single agent turn can outgrow the window
# on its own (a dozen rounds each pulling a large retrieval), and between-turn
# compaction never gets a chance to help — the per-round trim in the agent loop
# fires instead, which DROPS old messages rather than summarizing them. This is
# the mid-turn equivalent: summarize and carry on with the same query.

# A turn may compact itself at most this many times. Without a cap, a turn whose
# context stays above the threshold after compacting (because the recent half is
# itself enormous) would compact every round, spending an LLM call each time.
MAX_MID_TURN_COMPACTIONS = 3


def _safe_split_index(msgs: List[Dict], preferred: int, result_prefix: str = "") -> Optional[int]:
    """First index at or after `preferred` where the list can be cut without
    orphaning a tool result from the assistant message that requested it.

    Cutting mid-batch is what breaks the NEXT request: OpenAI-compatible servers
    reject a `role:"tool"` message that does not follow an assistant message
    carrying `tool_calls`. `_sanitize_tool_messages` can repair that after the
    fact by DROPPING messages, but choosing a clean cut keeps the content.
    """
    for i in range(max(0, preferred), len(msgs)):
        msg = msgs[i]
        if msg.get("role") == "tool":
            continue  # inside a tool batch
        prev = msgs[i - 1] if i > 0 else None
        if prev is not None and prev.get("role") == "assistant" and prev.get("tool_calls"):
            continue  # would separate a batch from its parent
        # Fenced-tool path: results arrive as a synthetic user message that
        # belongs to the assistant message before it.
        if result_prefix and str(msg.get("content") or "").startswith(result_prefix):
            continue
        return i
    return None


async def compact_mid_turn(
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
    pinned: Optional[List[Dict]] = None,
    result_prefix: str = "",
) -> tuple:
    """Summarize the older half of an in-flight turn. Returns (messages, did_compact).

    Differs from `maybe_compact` in three ways that matter mid-turn:

    * It does NOT touch ``session.history``. The current turn has not been
      persisted yet, so the runtime-to-history index mapping that
      ``_update_session_history`` relies on does not hold — writing through it
      here would corrupt the stored conversation.
    * It refuses to cut inside a tool batch (see `_safe_split_index`).
    * ``pinned`` messages are kept verbatim. The caller pins the user's original
      request, so a turn that compacts itself never loses the task it is working
      on — the failure that would make this worse than trimming.

    The caller owns the threshold decision; this function always compacts.
    """
    system_msgs: List[Dict] = []
    convo_msgs: List[Dict] = []
    pinned_ids = {id(m) for m in (pinned or [])}
    for msg in messages:
        if id(msg) in pinned_ids:
            continue  # re-inserted below, never summarized
        if msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    if len(convo_msgs) < 4:
        return messages, False

    split_point = _safe_split_index(convo_msgs, len(convo_msgs) // 2, result_prefix)
    # Nothing cuttable at or after the midpoint (e.g. the whole back half is one
    # giant tool batch) — leave it to the caller's trim rather than cutting badly.
    if split_point is None or split_point >= len(convo_msgs) or split_point == 0:
        logger.info("[compact] mid-turn: no safe split point, skipping")
        return messages, False

    older = convo_msgs[:split_point]
    recent = convo_msgs[split_point:]

    summary = await _summarize_older(older, system_msgs, endpoint_url, model, headers)
    if summary is None:
        return messages, False

    before = estimate_tokens(messages)
    compacted = _sanitize_tool_messages(
        system_msgs + [_summary_message(summary)] + list(pinned or []) + recent
    )
    after = estimate_tokens(compacted)
    if after >= before:
        # Summarizing made it bigger (tiny history, verbose summary). Keep the
        # original rather than paying tokens for nothing.
        logger.info(
            "[compact] mid-turn: summary was not smaller (%d -> %d), skipping", before, after
        )
        return messages, False

    logger.info(
        "[compact] mid-turn: %d -> %d tokens (%d messages summarized, %d kept)",
        before,
        after,
        len(older),
        len(recent),
    )
    return compacted, True


# ── Checkpoint compaction (the chat's own model, warm prompt cache) ──
#
# The summary above is written by the utility model from a transcript in which
# every message is cut to 2,000 characters, and may be 1,024 tokens long. A
# small helper model with a small window is the wrong author for what the main
# model has to keep working from, and most of what long tool results held is
# gone before it even reads them.
#
# Here the model that is doing the work writes its own checkpoint. The request
# is the conversation exactly as it was last sent — same system prompt, same
# tool list, same messages — up to the point where the kept tail begins, with
# the instruction as one more user message at the end. Everything before that
# instruction is already in the server's prefix cache, so the call costs the
# instruction and the checkpoint's own tokens, not a second prefill of a
# conversation that is by definition at its largest.
#
# The checkpoint comes back as a user message after the system prompt, which
# stays untouched (and cached). Nothing is moved to the front.

COMPACTION_MODES = ("main", "utility")
# Share of the context window kept verbatim behind the checkpoint.
RETAIN_RATIO = 0.16
# Room for the checkpoint. Generous compared with the old 1,024: it replaces
# most of a full window, and a checkpoint cut off mid-list is worse than none.
CHECKPOINT_MAX_TOKENS = 3000
# The summary is written at decode speed with nothing streamed to the user, so
# this is a wall-clock guard, not an expectation.
CHECKPOINT_TIMEOUT_S = 900

CHECKPOINT_HEADER = "[Conversation summary — earlier messages were compacted]"
CHECKPOINT_KEY = "_checkpoint"

CHECKPOINT_INSTRUCTION = """Stop working on the task for a moment. The conversation above is about to be removed to free up context, and you will carry on from a checkpoint instead. Write that checkpoint now: everything a model needs to continue this work with nothing lost that matters.

Use exactly these sections, in this order. Short bullets, no paragraphs. Write "(none)" under a section that has nothing; never leave one out.

## Request and intent
- what the user asked for and how that changed; quote their wording where it matters

## Facts and findings
- what was established so far: results, numbers, names, decisions, with where each came from

## Files, data and artifacts
- exact paths, tables, documents, URLs: what each is, what was done to it

## Errors and fixes
- what went wrong, what solved it, what did not work and should not be tried again

## Open tasks
- what the user asked for that is not done yet

## Current work
- exactly what was in progress when this checkpoint was written

## Next step
- the one next action, in line with the latest request, or "(none)"

## Constraints and preferences
- rules, corrections and preferences the user gave, and anything else that must not be forgotten

Rules:
- Keep exact values exact: paths, commands, queries, error messages, identifiers, numbers, dates.
- Write in the language the user writes in.
- If the conversation already contains a checkpoint like this one, it is an older one: keep what is still true, drop what is outdated, and merge it into this single checkpoint.
- Do not mention this request or that anything was summarized.
- Output only the checkpoint. Do not call a tool."""


def get_compaction_mode() -> str:
    """Who writes the summary when a conversation is compacted (setting
    `compaction_model`): the chat's own model ("main") or the utility model."""
    try:
        from src.settings import get_setting

        mode = str(get_setting("compaction_model", "main") or "main").strip().lower()
    except Exception:
        return "main"
    return mode if mode in COMPACTION_MODES else "main"


def _checkpoint_message(summary: str) -> Dict:
    """The checkpoint as the model reads it from now on."""
    return {
        "role": "user",
        "content": (
            f"{CHECKPOINT_HEADER}\n"
            "This checkpoint was written automatically. It stands for the earlier part "
            "of this conversation, which was removed to free up context. Treat it as "
            "established background and continue from the messages that follow. Do not "
            "mention the checkpoint.\n\n"
            f"<checkpoint>\n{summary.strip()}\n</checkpoint>"
        ),
        CHECKPOINT_KEY: True,
    }


async def _write_checkpoint(
    endpoint_url: str,
    model: str,
    prefix: List[Dict],
    headers: Optional[Dict] = None,
    tools: Optional[List[Dict]] = None,
    tool_choice_ok: bool = True,
) -> Optional[str]:
    """Ask the chat's model for a checkpoint of `prefix`. None on failure.

    `prefix` and `tools` are sent as they were in the conversation, so the
    server finds the whole prefix in its cache. The tools ride along although
    none may be called: they are rendered into the prompt ahead of the
    messages, and leaving them out would change it from its first tokens on.
    """
    import json as _json

    from src.llm_core import stream_llm
    from src.text_helpers import strip_thinking

    request = list(prefix) + [{"role": "user", "content": CHECKPOINT_INSTRUCTION}]
    text = ""
    try:
        async for chunk in stream_llm(
            endpoint_url,
            model,
            request,
            headers=headers,
            temperature=0.2,
            max_tokens=CHECKPOINT_MAX_TOKENS,
            tools=tools or None,
            tool_choice="none" if (tools and tool_choice_ok) else None,
            enable_thinking=False,
            timeout=CHECKPOINT_TIMEOUT_S,
        ):
            if chunk.startswith("event: error"):
                logger.error("Checkpoint call failed: %s", chunk.strip()[:300])
                return None
            if not chunk.startswith("data: {"):
                continue
            try:
                data = _json.loads(chunk[6:])
            except ValueError:
                continue
            if data.get("type") == "finish" and data.get("reason") == "length":
                # A checkpoint that stops mid-list silently loses its last
                # sections, the ones about what to do next.
                logger.warning("Checkpoint was cut off at the length limit — not used")
                return None
            if "delta" in data and not data.get("thinking"):
                text += data["delta"]
    except Exception as exc:
        logger.error("Checkpoint call failed: %s", exc)
        return None
    text = (strip_thinking(text) or "").strip()
    return text or None


def _retain_start(msgs: List[Dict], retain_tokens: Optional[int]) -> int:
    """Index in `msgs` where the verbatim tail begins.

    The newest messages are kept until they add up to `retain_tokens`. Counting
    tokens rather than messages matters because sizes differ by orders of
    magnitude: half the messages can be nearly all of the context. Without a
    budget, or when everything fits in it, the split is the middle.
    """
    half = len(msgs) // 2
    if not retain_tokens or retain_tokens <= 0:
        return half
    kept = 0
    start = len(msgs)
    for i in range(len(msgs) - 1, -1, -1):
        kept += estimate_tokens([msgs[i]])
        if kept > retain_tokens:
            break
        start = i
    if start == 0:
        return half  # all of it fits: still cut, or nothing is gained
    # Keep at least the newest message; never summarize the entire list.
    return min(start, len(msgs) - 1)


async def compact_with_checkpoint(
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
    pinned: Optional[List[Dict]] = None,
    result_prefix: str = "",
    tools: Optional[List[Dict]] = None,
    tool_choice_ok: bool = True,
    retain_tokens: Optional[int] = None,
    threshold_tokens: Optional[int] = None,
) -> tuple:
    """Shrink a conversation: prune large tool results, and if that is not
    enough, replace its older part by a checkpoint the chat's model writes.
    Returns (messages, did_compact).

    Like `compact_mid_turn`, it leaves ``session.history`` alone, never cuts
    inside a tool batch, and keeps ``pinned`` messages verbatim.

    * ``threshold_tokens`` — when pruning alone brings the conversation below
      it, no summary is written at all.
    * ``retain_tokens`` — how much of the newest conversation stays verbatim.
    * ``tools`` / ``tool_choice_ok`` — the tool list of the conversation's
      requests, for the cache (see `_write_checkpoint`).
    """
    before = estimate_tokens(messages)

    # 1. Without a model call. Old file dumps and query results are most of the
    #    bulk; cutting their middles out is often all it takes.
    pruned, pruned_count = prune_tool_results(messages, result_prefix)
    if pruned_count and threshold_tokens and estimate_tokens(pruned) < threshold_tokens:
        logger.info(
            "[compact] %d -> %d tokens by pruning %d tool result(s); no summary needed",
            before,
            estimate_tokens(pruned),
            pruned_count,
        )
        return pruned, True

    # 2. A checkpoint for the older part. It is written from the conversation
    #    as it was sent (unpruned), because that is what the server has cached.
    head_end = next((i for i, m in enumerate(messages) if m.get("role") != "system"), len(messages))
    body = messages[head_end:]
    if len(body) < 4:
        return (pruned, True) if pruned_count else (messages, False)

    split = _safe_split_index(body, _retain_start(body, retain_tokens), result_prefix)
    if split is None or split == 0 or split >= len(body):
        logger.info("[compact] no safe split point for a checkpoint")
        return (pruned, True) if pruned_count else (messages, False)

    cut = head_end + split  # index in `messages` where the kept tail begins
    summary = await _write_checkpoint(
        endpoint_url, model, messages[:cut], headers, tools, tool_choice_ok
    )
    if summary is None:
        return (pruned, True) if pruned_count else (messages, False)

    figures = _extract_figure_markdown(messages[head_end:cut])
    if figures:
        summary += "\n\n## Figures shown earlier (still relevant)\n" + "\n\n".join(figures)

    # 3. The new conversation: the untouched system head, the checkpoint, any
    #    pinned message that would otherwise be summarized away, and the tail —
    #    pruned too, since it is prefilled again anyway. A pinned message that
    #    is already in the tail stays where it is.
    pinned_ids = {id(m) for m in (pinned or [])}
    rescued = [m for m in messages[head_end:cut] if id(m) in pinned_ids]
    tail, _ = prune_tool_results(messages[cut:], result_prefix)
    compacted = _sanitize_tool_messages(
        messages[:head_end] + [_checkpoint_message(summary)] + rescued + tail
    )
    after = estimate_tokens(compacted)
    if after >= before:
        logger.info("[compact] checkpoint was not smaller (%d -> %d), skipping", before, after)
        return (pruned, True) if pruned_count else (messages, False)

    logger.info(
        "[compact] checkpoint: %d -> %d tokens (%d messages summarized, %d kept)",
        before,
        after,
        cut - head_end,
        len(tail),
    )
    return compacted, True


# ── Pruning tool results ──
#
# Most of a long turn's bulk is old tool output: file contents, query results,
# fetched pages. Cutting the middle out of the large ones frees a lot of room
# without a model call, and keeps what a result usually needs to stay useful —
# how it starts, and how it ends (errors, totals, and the note that names where
# the full output can be read again).
#
# It rewrites messages the model server has already seen, so everything after
# the first pruned one is prefilled again. That is why it only runs when the
# context has to shrink anyway: on overflow, and before a summary.

PRUNE_THRESHOLD_CHARS = 8192
PRUNE_HEAD_CHARS = 4096
PRUNE_TAIL_CHARS = 1024
PRUNE_MARKER = "\n\n[... the middle of this tool result was removed to free up context ...]\n\n"


def _prune_text(text: str) -> Optional[str]:
    """`text` with its middle removed, or None when it is small enough."""
    if len(text) <= PRUNE_THRESHOLD_CHARS:
        return None
    return text[:PRUNE_HEAD_CHARS] + PRUNE_MARKER + text[-PRUNE_TAIL_CHARS:]


def prune_tool_results(messages: List[Dict], result_prefix: str = "") -> tuple:
    """Cut the middle out of large tool results. Returns (messages, pruned_count).

    Covers native `role:"tool"` messages and, for the fenced-tool path, the
    synthetic user message that starts with `result_prefix`. Messages are
    replaced by copies, never changed in place, so a caller holding the old
    list (or a pinned message) still sees what it had.
    """
    out: List[Dict] = []
    pruned = 0
    for msg in messages:
        content = msg.get("content")
        is_result = msg.get("role") == "tool" or (
            bool(result_prefix)
            and msg.get("role") == "user"
            and isinstance(content, str)
            and content.startswith(result_prefix)
        )
        shorter = _prune_text(content) if is_result and isinstance(content, str) else None
        if shorter is None:
            out.append(msg)
        else:
            out.append({**msg, "content": shorter})
            pruned += 1
    return (out, pruned) if pruned else (messages, 0)


async def recover_from_overflow(
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
    pinned: Optional[List[Dict]] = None,
    result_prefix: str = "",
    mode: str = "utility",
    tools: Optional[List[Dict]] = None,
    tool_choice_ok: bool = True,
    retain_tokens: Optional[int] = None,
) -> tuple:
    """Shrink a conversation the model server refused as too long.

    Returns (messages, changed). First the large tool results are pruned, then
    the older part is summarized — by the chat's own model as a checkpoint
    (`mode` "main", see `compact_with_checkpoint`) or by the utility model.
    `changed` is True when either step made the conversation smaller; only
    then is sending the request again worth it. A summary that fails after
    pruning helped still counts: the pruned conversation is returned.
    """
    before = estimate_tokens(messages)
    current, pruned = prune_tool_results(messages, result_prefix)
    try:
        if mode == "main":
            # The checkpoint is written from the pruned conversation here: the
            # unpruned one is what the server just refused as too long.
            compacted, did_compact = await compact_with_checkpoint(
                endpoint_url,
                model,
                current,
                headers=headers,
                pinned=pinned,
                result_prefix=result_prefix,
                tools=tools,
                tool_choice_ok=tool_choice_ok,
                retain_tokens=retain_tokens,
            )
        else:
            compacted, did_compact = await compact_mid_turn(
                endpoint_url,
                model,
                current,
                headers=headers,
                pinned=pinned,
                result_prefix=result_prefix,
            )
    except Exception as exc:
        logger.warning("[compact] overflow recovery: summary failed: %s", exc)
        compacted, did_compact = current, False
    if did_compact:
        current = compacted
    after = estimate_tokens(current)
    changed = (pruned > 0 or did_compact) and after < before
    logger.info(
        "[compact] overflow recovery: %d -> %d tokens (%d result(s) pruned, summary %s)",
        before,
        after,
        pruned,
        "written" if did_compact else "not written",
    )
    return (current, True) if changed else (messages, False)


def _update_session_history(session, split_point: int, summary: str):
    """Update the in-memory session history after compaction.

    `split_point` is indexed against runtime `convo_msgs`, which excludes
    system messages. Runtime messages can include transient system preface
    entries that are not persisted in session.history, so locate the matching
    history offset by counting non-system history messages instead of adding a
    runtime system-message count.
    """
    if not session or not hasattr(session, "history"):
        return

    history = list(session.history)
    non_system_seen = 0
    effective_split = None
    for idx, msg in enumerate(history):
        role = getattr(msg, "role", None)
        if role is None and isinstance(msg, dict):
            role = msg.get("role")
        if role == "system":
            continue
        if non_system_seen == split_point:
            effective_split = idx
            break
        non_system_seen += 1

    if effective_split is None or effective_split >= len(history):
        return

    system_prefix = []
    for msg in history[:effective_split]:
        role = getattr(msg, "role", None)
        if role is None and isinstance(msg, dict):
            role = msg.get("role")
        if role == "system":
            system_prefix.append(msg)
    recent_history = history[effective_split:]
    summary_msg = ChatMessage(
        role="system",
        content=f"[Conversation summary]\n{summary}",
        metadata={"compacted": True, "summarized_count": split_point},
    )
    new_history = system_prefix + [summary_msg] + recent_history
    try:
        from core import models as _core_models

        manager = getattr(_core_models, "_session_manager", None)
    except Exception:
        manager = None
    if manager and getattr(session, "id", None):
        if manager.replace_messages(session.id, new_history):
            return
    session.history = new_history
