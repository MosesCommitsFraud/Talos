"""Tests for mid-turn compaction (``src.context_compactor.compact_mid_turn``).

`maybe_compact` only runs between turns, so a single agent turn that outgrows
the window was handled by `trim_for_context` — which DROPS older rounds instead
of summarizing them. This is the mid-turn equivalent: summarize and carry on
with the same query.

The three things that must hold, because getting any of them wrong makes this
worse than the trimming it replaces:
  1. the user's pinned request survives (else the turn forgets its task),
  2. no cut orphans a `tool` message from its `tool_calls` parent (else the next
     request is rejected by the API),
  3. session.history is never written (the turn isn't persisted yet).
"""

import pytest

from src import context_compactor as cc


@pytest.fixture(autouse=True)
def _stub_summarizer(monkeypatch):
    """Replace the LLM summary call with a deterministic short string."""

    async def _fake(older, system_msgs, endpoint_url, model, headers=None):
        return f"summarized {len(older)} messages"

    monkeypatch.setattr(cc, "_summarize_older", _fake)


def _call(cid):
    return {"id": cid, "type": "function", "function": {"name": "x", "arguments": "{}"}}


def _round(i):
    """One native-tool round: assistant tool_calls + its tool result."""
    return [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [_call(f"c{i}")],
        },
        {"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * 400},
    ]


def _long_turn(rounds=8):
    query = {"role": "user", "content": "SET UP THE SPARK"}
    msgs = [{"role": "system", "content": "sys"}, query]
    for i in range(rounds):
        msgs += _round(i)
    return msgs, query


# ── The pinned request survives ──


async def test_pinned_query_is_never_summarized_away():
    msgs, query = _long_turn()
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert did is True
    assert any(m.get("content") == "SET UP THE SPARK" for m in out)


async def test_pinned_query_appears_exactly_once():
    msgs, query = _long_turn()
    out, _ = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert sum(1 for m in out if m.get("content") == "SET UP THE SPARK") == 1


async def test_system_messages_are_kept():
    msgs, query = _long_turn()
    out, _ = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert any(m.get("content") == "sys" for m in out)


async def test_it_actually_shrinks_and_summarizes():
    msgs, query = _long_turn()
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert did is True
    assert len(out) < len(msgs)
    assert any("Conversation summary" in str(m.get("content") or "") for m in out)


# ── Tool pairing stays valid ──


def _pairing_is_valid(msgs):
    """Every `tool` message follows an assistant tool_calls or another tool."""
    in_batch = False
    for m in msgs:
        role = m.get("role")
        if role == "tool":
            if not in_batch:
                return False
            continue
        in_batch = bool(role == "assistant" and m.get("tool_calls"))
    return True


@pytest.mark.parametrize("rounds", [4, 5, 6, 7, 8, 9, 12, 15])
async def test_never_orphans_a_tool_result(rounds):
    msgs, query = _long_turn(rounds)
    out, _ = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert _pairing_is_valid(out), [m.get("role") for m in out]


def test_safe_split_skips_into_a_tool_batch():
    msgs = _round(0) + _round(1) + _round(2)
    # index 1, 3, 5 are `tool` messages — the split must never land on one, nor
    # immediately after an assistant that carries tool_calls.
    for preferred in range(len(msgs)):
        idx = cc._safe_split_index(msgs, preferred)
        if idx is None:
            continue
        assert msgs[idx].get("role") != "tool"
        prev = msgs[idx - 1] if idx > 0 else None
        assert not (prev and prev.get("role") == "assistant" and prev.get("tool_calls"))


def test_safe_split_respects_the_fenced_result_prefix():
    prefix = "[Tool execution results]"
    msgs = [
        {"role": "assistant", "content": "running"},
        {"role": "user", "content": f"{prefix}\n\nout"},
        {"role": "assistant", "content": "again"},
        {"role": "user", "content": f"{prefix}\n\nout2"},
    ]
    idx = cc._safe_split_index(msgs, 1, prefix)
    # Index 1 belongs to the assistant before it, so the cut moves to 2.
    assert idx == 2


# ── Refusals ──


async def test_short_turn_is_left_alone():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[msgs[1]])
    assert did is False
    assert out == msgs


async def test_no_safe_split_leaves_messages_untouched():
    """A back half that is one unbroken tool batch has nowhere clean to cut."""
    query = {"role": "user", "content": "q"}
    msgs = [
        query,
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "b"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [_call("c")],
        },
    ] + [{"role": "tool", "tool_call_id": "c", "content": "r"} for _ in range(6)]
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert did is False
    assert out == msgs


async def test_summary_failure_is_not_fatal(monkeypatch):
    async def _fail(older, system_msgs, endpoint_url, model, headers=None):
        return None

    monkeypatch.setattr(cc, "_summarize_older", _fail)
    msgs, query = _long_turn()
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert did is False
    assert out == msgs


async def test_no_compaction_when_summary_would_be_bigger(monkeypatch):
    async def _huge(older, system_msgs, endpoint_url, model, headers=None):
        return "z" * 100_000

    monkeypatch.setattr(cc, "_summarize_older", _huge)
    msgs, query = _long_turn()
    out, did = await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert did is False
    assert out == msgs


# ── session.history is never touched ──


class _FakeSession:
    def __init__(self):
        self.history = [{"role": "user", "content": "old"}]


async def test_session_history_is_not_written(monkeypatch):
    """maybe_compact rewrites session.history; mid-turn must not, because the
    current turn is not in history yet and the index mapping would be wrong."""
    calls = []
    monkeypatch.setattr(cc, "_update_session_history", lambda *a, **k: calls.append(a))
    msgs, query = _long_turn()
    await cc.compact_mid_turn("u", "m", msgs, pinned=[query])
    assert calls == []


async def test_between_turns_persists_the_bare_summary(monkeypatch):
    """`_update_session_history` applies its own `[Conversation summary]`
    header, so it must receive the BARE text — handing it the runtime message
    content nests two headers in the stored transcript."""
    captured = {}
    monkeypatch.setattr(
        cc, "_update_session_history", lambda s, sp, summary: captured.update(summary=summary)
    )
    monkeypatch.setattr(cc, "get_context_length", lambda *a, **k: 1000)
    monkeypatch.setattr(cc, "get_compact_threshold", lambda: 0.5)
    monkeypatch.setattr(cc, "estimate_tokens", lambda m: 900)
    # Crossing the threshold makes maybe_compact confirm with the server's real
    # tokenizer; returning None keeps it on the estimate instead of a live call.
    monkeypatch.setattr("src.model_context.count_tokens_exact", lambda *a, **k: None)

    msgs = [{"role": "system", "content": "s"}] + [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(8)
    ]
    out, _, did = await cc.maybe_compact(_FakeSession(), "u", "m", msgs)

    assert did is True
    assert captured["summary"] == "summarized 4 messages"
    assert "Conversation summary" not in captured["summary"]
    # The runtime message, by contrast, carries exactly one header.
    runtime = next(m for m in out if "Conversation summary" in str(m.get("content") or ""))
    assert str(runtime["content"]).count("Conversation summary") == 1


# ── The retry cap exists ──


def test_mid_turn_compaction_cap_is_bounded():
    assert 1 <= cc.MAX_MID_TURN_COMPACTIONS <= 5
