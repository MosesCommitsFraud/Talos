"""When the model server refuses a prompt as too long, the turn shrinks its
conversation and carries on instead of stalling on an error."""

import json

import pytest

from src import agent_loop, agent_runs, context_compactor
from src.context_compactor import (
    PRUNE_HEAD_CHARS,
    PRUNE_MARKER,
    PRUNE_TAIL_CHARS,
    prune_tool_results,
)
from src.llm_core import CONTEXT_OVERFLOW_CODE, _upstream_error_event, is_context_overflow


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


# ── recognising the refusal ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        # vLLM
        "This model's maximum context length is 262144 tokens. However, you requested "
        "270000 tokens (265904 in the messages, 4096 in the completion).",
        "The decoder prompt (length 300000) is longer than the maximum model length of 262144.",
        # OpenAI
        '{"error": {"code": "context_length_exceeded", "message": "..."}}',
        # Anthropic
        '{"type": "error", "error": {"message": "prompt is too long: 210000 tokens > 200000"}}',
        # llama.cpp
        '{"error": {"type": "exceed_context_size_error", "message": "the request exceeds '
        'the available context size"}}',
    ],
)
def test_the_ways_servers_say_the_prompt_is_too_long(body):
    assert is_context_overflow(400, body)
    assert _upstream_error_event(400, "friendly", body)["code"] == CONTEXT_OVERFLOW_CODE


def test_other_errors_carry_no_overflow_code():
    assert not is_context_overflow(401, '{"error": {"message": "Invalid API key"}}')
    assert not is_context_overflow(400, '{"error": {"message": "unknown parameter top_k"}}')
    assert "code" not in _upstream_error_event(503, "busy", "upstream unavailable")


# ── pruning ──────────────────────────────────────────────────────────────────


def test_large_tool_results_keep_their_start_and_their_end():
    big = "HEAD" + "x" * 30000 + "TAIL [Output compressed … id `out_ab12`]"
    messages = [
        {"role": "system", "content": "p"},
        {"role": "user", "content": "u" * 20000},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": big},
        {"role": "tool", "tool_call_id": "c2", "content": "small"},
    ]
    pruned, count = prune_tool_results(messages)

    assert count == 1
    result = pruned[3]["content"]
    assert result.startswith("HEAD") and result.endswith("id `out_ab12`]")
    assert PRUNE_MARKER in result
    assert len(result) == PRUNE_HEAD_CHARS + len(PRUNE_MARKER) + PRUNE_TAIL_CHARS
    assert pruned[3]["tool_call_id"] == "c1"
    # Everything that is not a large tool result is the very same object.
    assert all(pruned[i] is messages[i] for i in (0, 1, 2, 4))
    # The caller's list and messages are untouched.
    assert messages[3]["content"] == big


def test_fenced_tool_results_are_pruned_and_a_small_conversation_is_returned_as_is():
    prefix = "[Tool execution results]"
    messages = [
        {"role": "user", "content": "frage"},
        {"role": "user", "content": prefix + "\n\n" + "y" * 20000},
    ]
    pruned, count = prune_tool_results(messages, result_prefix=prefix)
    assert count == 1 and pruned[1]["content"].startswith(prefix)
    # Without the prefix the second message is an ordinary user message.
    assert prune_tool_results(messages) == (messages, 0)
    assert prune_tool_results(messages)[0] is messages


# ── the loop ─────────────────────────────────────────────────────────────────

OVERFLOW = (
    "event: error\ndata: "
    + json.dumps({"status": 400, "text": "too long", "raw": "", "code": CONTEXT_OVERFLOW_CODE})
    + "\n\n"
)


def _model(monkeypatch, script):
    """`script(n, messages)` returns the chunks of model call number n."""
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(json.loads(json.dumps(messages, default=str)))
        for chunk in script(len(requests), messages):
            yield chunk
        yield "data: [DONE]\n\n"

    async def fake_execute(block, **kwargs):
        return "bash: ok", {"output": "ROW " * 10000, "exit_code": 0}

    async def no_summary(*args, **kwargs):
        return None  # the summary call fails; pruning has to be enough

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setattr(context_compactor, "_summarize_older", no_summary)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def _run():
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=8
        )
    ]
    events = [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]
    errors = [c for c in chunks if c.startswith("event: error")]
    return events, errors


def _tool_call(n):
    call = {"id": f"c{n}", "name": "bash", "arguments": json.dumps({"command": f"dump {n}"})}
    return f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"


async def test_an_overflow_is_answered_by_pruning_and_the_turn_goes_on(monkeypatch):
    def script(n, messages):
        if n == 1:
            return [_tool_call(1)]
        if n == 2:
            return [OVERFLOW]
        return [f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"]

    requests = _model(monkeypatch, script)
    events, errors = await _run()

    assert len(requests) == 3
    assert not errors  # the user never sees the refusal
    refused = [m for m in requests[1] if m.get("role") == "tool"][0]["content"]
    retried = [m for m in requests[2] if m.get("role") == "tool"][0]["content"]
    assert len(refused) > 30000
    assert PRUNE_MARKER in retried and len(retried) < 6000
    assert {"type": "compacted", "context_length": 0} in events
    assert "Fertig." in "".join(e.get("delta", "") for e in events)
    profile = [e["data"] for e in events if e.get("type") == "metrics"][-1]["round_profile"]
    assert profile[1].get("overflow") is True


async def test_an_overflow_that_shrinking_cannot_fix_ends_the_turn_with_the_error(monkeypatch):
    # Nothing to prune and too little to summarize: the same request again
    # would be refused the same way, so it is not sent.
    requests = _model(monkeypatch, lambda n, messages: [OVERFLOW])
    events, errors = await _run()

    assert len(requests) == 1
    assert len(errors) == 1
    assert {"type": "context_overflow", "round": 1} in events
    metrics = [e["data"] for e in events if e.get("type") == "metrics"][-1]
    assert metrics["stop_reason"] == "context_overflow"


async def test_recovery_is_not_tried_forever(monkeypatch):
    def script(n, messages):
        return [_tool_call(n)] if n == 1 else [OVERFLOW]

    # Each recovery "works" (something is pruned the first time, and the
    # summary step is made to succeed after that), but the server keeps
    # refusing.
    requests = _model(monkeypatch, script)

    async def always_changed(endpoint_url, model, messages, **kwargs):
        return list(messages), True

    monkeypatch.setattr(agent_loop, "recover_from_overflow", always_changed)
    events, errors = await _run()

    # 1 working round + the refused round + 2 recoveries, then the error stands.
    assert len(requests) == 2 + agent_loop.MAX_OVERFLOW_RECOVERIES
    assert len(errors) == 1


async def test_a_call_that_failed_outright_is_not_nudged(monkeypatch):
    denied = (
        "event: error\ndata: "
        + json.dumps({"status": 401, "text": "rejected the API key"})
        + "\n\n"
    )
    requests = _model(monkeypatch, lambda n, messages: [denied])
    events, errors = await _run()

    assert len(requests) == 1  # no "your last round produced nothing" retries
    assert len(errors) == 1
    metrics = [e["data"] for e in events if e.get("type") == "metrics"][-1]
    assert metrics["stop_reason"] == "model_error"
    assert not [e for e in events if e.get("type") == "agent_stalled"]
