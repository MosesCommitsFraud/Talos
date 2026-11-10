"""Checkpoint compaction: the chat's own model summarizes the conversation from
the prompt the server has cached, after large tool results were pruned, and the
result keeps the system prompt, the user's request and the newest messages."""

import json

import pytest

from src import agent_loop, agent_runs, llm_core, settings
from src import context_compactor as cc


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


TOOLS = [{"type": "function", "function": {"name": "bash", "parameters": {"type": "object"}}}]


def _call(cid):
    return {"id": cid, "type": "function", "function": {"name": "bash", "arguments": "{}"}}


def _round(i, size=600):
    return [
        {"role": "assistant", "content": None, "tool_calls": [_call(f"c{i}")]},
        {"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * size},
    ]


def _turn(rounds=10, size=600):
    question = {"role": "user", "content": "BAU DAS DASHBOARD"}
    messages = [{"role": "system", "content": "SYSTEM PROMPT"}, question]
    for i in range(rounds):
        messages += _round(i, size)
    return messages, question


@pytest.fixture
def checkpoint(monkeypatch):
    """Stub the model call; records what it was asked to summarize."""
    seen = {}

    async def fake(endpoint_url, model, prefix, headers=None, tools=None, tool_choice_ok=True):
        seen.update(prefix=list(prefix), tools=tools, tool_choice_ok=tool_choice_ok)
        seen["calls"] = seen.get("calls", 0) + 1
        return seen.get("answer", "## Request and intent\n- Dashboard bauen")

    monkeypatch.setattr(cc, "_write_checkpoint", fake)
    return seen


# ── the request to the model ─────────────────────────────────────────────────


async def test_the_checkpoint_request_is_the_conversation_plus_one_instruction(monkeypatch):
    captured = {}

    async def fake_stream(url, model, messages, **kwargs):
        captured.update(messages=messages, **kwargs)
        yield f"data: {json.dumps({'delta': 'nachdenken', 'thinking': True})}\n\n"
        yield f"data: {json.dumps({'delta': '## Request and intent'})}\n\n"
        yield f"data: {json.dumps({'delta': ' - Dashboard'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(llm_core, "stream_llm", fake_stream)
    prefix, _ = _turn(3)
    text = await cc._write_checkpoint("u", "m", prefix, tools=TOOLS)

    assert text == "## Request and intent - Dashboard"
    # Byte for byte what the conversation's requests sent, so the server finds
    # it in its prefix cache; the instruction is the only thing added.
    assert captured["messages"][:-1] == prefix
    assert captured["messages"][-1] == {"role": "user", "content": cc.CHECKPOINT_INSTRUCTION}
    # The tools are rendered ahead of the messages, so they have to be there,
    # but none may be called.
    assert captured["tools"] == TOOLS and captured["tool_choice"] == "none"
    assert captured["enable_thinking"] is False


@pytest.mark.parametrize(
    "chunks",
    [
        ['event: error\ndata: {"status": 400}\n\n'],
        [
            f"data: {json.dumps({'delta': '## Request'})}\n\n",
            f"data: {json.dumps({'type': 'finish', 'reason': 'length'})}\n\n",
        ],
        ["data: [DONE]\n\n"],
    ],
)
async def test_a_failed_cut_off_or_empty_checkpoint_is_not_used(monkeypatch, chunks):
    async def fake_stream(url, model, messages, **kwargs):
        for chunk in chunks:
            yield chunk

    monkeypatch.setattr(llm_core, "stream_llm", fake_stream)
    assert await cc._write_checkpoint("u", "m", _turn(3)[0]) is None


# ── what the conversation looks like afterwards ──────────────────────────────


async def test_layout_head_checkpoint_request_tail(checkpoint):
    messages, question = _turn(10)
    out, did = await cc.compact_with_checkpoint("u", "m", messages, pinned=[question])

    assert did
    # The system prompt is the same object in the same place: its cache stays.
    assert out[0] is messages[0]
    # The checkpoint is a user message right behind it, not part of the head.
    assert out[1]["role"] == "user" and out[1]["content"].startswith(cc.CHECKPOINT_HEADER)
    assert "<checkpoint>" in out[1]["content"]
    # The request would have been summarized away; it is kept verbatim.
    assert out[2] is question
    assert sum(1 for m in out if m is question) == 1
    # The newest rounds are still there, as the very same messages.
    assert out[-1] is messages[-1]
    assert len(out) < len(messages)
    # What the model summarized is exactly the part that was removed.
    assert checkpoint["prefix"] == messages[: len(checkpoint["prefix"])]
    assert checkpoint["prefix"][-1] is not out[-1]


async def test_no_tool_result_loses_its_call(checkpoint):
    for rounds in range(4, 14):
        messages, question = _turn(rounds)
        out, _ = await cc.compact_with_checkpoint("u", "m", messages, pinned=[question])
        open_calls = set()
        for m in out:
            if m.get("tool_calls"):
                open_calls |= {c["id"] for c in m["tool_calls"]}
            if m.get("role") == "tool":
                assert m["tool_call_id"] in open_calls


async def test_a_pinned_message_in_the_tail_stays_where_it_is(checkpoint):
    # Before a turn's first request the question is the last message. Moving
    # it behind the checkpoint would put it ahead of the older conversation.
    history, _ = _turn(10)
    question = {"role": "user", "content": "UND JETZT ALS PDF"}
    messages = history + [{"role": "assistant", "content": "Fertig."}, question]
    out, did = await cc.compact_with_checkpoint("u", "m", messages, pinned=[question])

    assert did and out[-1] is question
    assert sum(1 for m in out if m is question) == 1


async def test_the_tail_is_measured_in_tokens_not_messages(checkpoint):
    messages, question = _turn(10, size=200)
    messages += _round(99, size=7000)  # one result as big as everything before
    # Room for the big result and a little more.
    out, did = await cc.compact_with_checkpoint(
        "u", "m", messages, pinned=[question], retain_tokens=2300
    )

    assert did
    kept_results = [m for m in out if m.get("role") == "tool"]
    # By message count half of the rounds would have been kept; by size the
    # budget is used up by the big result and its closest neighbours.
    assert kept_results[-1]["tool_call_id"] == "c99"
    assert len(kept_results) < 5


async def test_pruning_alone_can_be_enough(checkpoint):
    messages, question = _turn(6, size=30000)
    before = cc.estimate_tokens(messages)
    out, did = await cc.compact_with_checkpoint(
        "u", "m", messages, pinned=[question], threshold_tokens=before // 2
    )

    assert did and "calls" not in checkpoint  # no model call at all
    assert len(out) == len(messages)
    assert all(cc.PRUNE_MARKER in m["content"] for m in out if m.get("role") == "tool")


async def test_the_checkpoint_is_written_from_the_unpruned_conversation(checkpoint):
    # That is the prompt the server has cached; the pruned one starts to differ
    # at the first big result.
    messages, question = _turn(8, size=30000)
    out, did = await cc.compact_with_checkpoint("u", "m", messages, pinned=[question])

    assert did
    assert all(cc.PRUNE_MARKER not in str(m.get("content")) for m in checkpoint["prefix"])
    # The kept tail is pruned, since it is prefilled again anyway.
    assert all(cc.PRUNE_MARKER in m["content"] for m in out if m.get("role") == "tool")


async def test_a_failed_checkpoint_leaves_the_conversation_or_its_pruned_form(
    checkpoint, monkeypatch
):
    async def none(*args, **kwargs):
        return None

    monkeypatch.setattr(cc, "_write_checkpoint", none)
    small, question = _turn(8)
    assert await cc.compact_with_checkpoint("u", "m", small, pinned=[question]) == (small, False)

    big, question = _turn(8, size=30000)
    out, did = await cc.compact_with_checkpoint("u", "m", big, pinned=[question])
    assert did and len(out) == len(big)  # pruning still helped


async def test_a_checkpoint_that_is_not_smaller_is_dropped(checkpoint):
    checkpoint["answer"] = "y" * 200000
    messages, question = _turn(8)
    assert await cc.compact_with_checkpoint("u", "m", messages, pinned=[question]) == (
        messages,
        False,
    )


async def test_figures_shown_earlier_survive(checkpoint):
    messages, question = _turn(10)
    figure = "![Umsatz](/api/personal/rag-asset?source=abc)"
    messages[3] = {**messages[3], "content": "Siehe " + figure}
    out, _ = await cc.compact_with_checkpoint("u", "m", messages, pinned=[question])
    assert figure in out[1]["content"]


# ── the loop ─────────────────────────────────────────────────────────────────


def _mode(monkeypatch, mode):
    def fake(key, default=None):
        return mode if key == "compaction_model" else default

    monkeypatch.setattr(settings, "get_setting", fake)


def _model(monkeypatch, tool_rounds):
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append({"messages": json.loads(json.dumps(messages, default=str)), **kwargs})
        n = len(requests)
        if n <= tool_rounds:
            call = {"id": f"c{n}", "name": "bash", "arguments": json.dumps({"command": f"s{n}"})}
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    async def fake_execute(block, **kwargs):
        return "bash: ok", {"output": "ZEILE " * 600, "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def _run(messages, sink=None, context_length=8000):
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1",
            "qwen3-llm",
            messages,
            max_rounds=0,
            context_length=context_length,
            wire_sink=sink,
        )
    ]
    return [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]


def _checkpoints(request):
    return [m for m in request["messages"] if cc.CHECKPOINT_HEADER in str(m.get("content"))]


async def test_a_long_turn_writes_its_checkpoint_with_the_tools_it_was_sending(
    monkeypatch, checkpoint
):
    _mode(monkeypatch, "main")
    requests = _model(monkeypatch, tool_rounds=12)
    sink = {}
    events = await _run(
        [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}], sink
    )

    assert checkpoint.get("calls", 0) >= 1
    assert {"type": "compacted", "context_length": 8000} in events
    # Same tool list as the requests around it, or the cache would not match.
    sent_tools = [r.get("tools") for r in requests if r.get("tools")]
    assert checkpoint["tools"] == sent_tools[0]
    after = next(r for r in requests if _checkpoints(r))
    assert len(_checkpoints(after)) == 1
    # The request of this turn survives every compaction, verbatim.
    assert all(
        any(m.get("content") == "Los." for m in r["messages"]) or _checkpoints(r) == []
        for r in requests
    )
    assert any(m.get("content") == "Los." for m in requests[-1]["messages"])
    # The stored turn has to carry the whole compacted conversation.
    assert sink["compacted"] is True
    assert "Fertig." in "".join(e.get("delta", "") for e in events)


async def test_a_full_conversation_gets_its_checkpoint_before_the_first_request(
    monkeypatch, checkpoint
):
    _mode(monkeypatch, "main")
    requests = _model(monkeypatch, tool_rounds=0)
    history = [{"role": "system", "content": "p"}]
    for i in range(20):
        history += [
            {"role": "user", "content": f"Frage {i} " + "a" * 800},
            {"role": "assistant", "content": f"Antwort {i} " + "b" * 800},
        ]
    question = {"role": "user", "content": "UND JETZT?"}
    sink = {}
    events = await _run(history + [question], sink)

    first = requests[0]["messages"]
    assert len(_checkpoints(requests[0])) == 1
    assert first[0]["role"] == "system"
    # Nothing was dropped silently: old turns are in the checkpoint's source.
    assert any("Frage 0" in str(m.get("content")) for m in checkpoint["prefix"])
    # The new question is still the last thing the model reads.
    assert first[-1]["content"].endswith("UND JETZT?")
    assert {"type": "compacted", "context_length": 8000} in events
    assert sink["compacted"] is True


async def test_utility_mode_keeps_the_old_path(monkeypatch, checkpoint):
    _mode(monkeypatch, "utility")
    used = {}

    async def old_path(endpoint_url, model, messages, **kwargs):
        used["called"] = True
        return messages, False

    monkeypatch.setattr(agent_loop, "compact_mid_turn", old_path)
    _model(monkeypatch, tool_rounds=12)
    await _run([{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}])

    assert used.get("called") and "calls" not in checkpoint


def test_the_mode_setting_falls_back_to_main(monkeypatch):
    _mode(monkeypatch, "nonsense")
    assert cc.get_compaction_mode() == "main"
    _mode(monkeypatch, "utility")
    assert cc.get_compaction_mode() == "utility"
