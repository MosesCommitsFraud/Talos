"""Every tool call the model makes gets an answer it can act on: a call that
cannot be run is rejected with a reason instead of being dropped, results stay
with their calls, and an output cut off at the length limit is told apart from
a finished one."""

import json

import httpx
import pytest

from src import agent_loop, agent_runs, llm_core
from src.agent_tools import RejectedToolCall
from src.tool_schemas import TRUNCATED_CALL_ERROR, native_call_to_tool_block


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


# ── native call → block ──────────────────────────────────────────────────────


def test_a_usable_call_is_converted_as_before():
    block = native_call_to_tool_block("bash", json.dumps({"command": "ls -la"}))
    assert not isinstance(block, RejectedToolCall)
    assert (block.tool_type, block.content) == ("bash", "ls -la")


def test_an_unknown_tool_is_rejected_with_the_nearest_names():
    block = native_call_to_tool_block("read_fil", json.dumps({"path": "a.txt"}))
    assert isinstance(block, RejectedToolCall)
    assert block.tool_type == "read_fil"
    assert 'unknown tool "read_fil"' in block.error
    assert "read_file" in block.error


def test_broken_json_is_rejected_and_says_what_is_wrong():
    block = native_call_to_tool_block("bash", '{"command": "echo hi')
    assert isinstance(block, RejectedToolCall)
    assert block.tool_type == "bash"
    assert "not valid JSON" in block.error
    assert block.content == '{"command": "echo hi'


def test_broken_json_after_a_cut_off_output_names_the_length_limit():
    block = native_call_to_tool_block(
        "write_file", '{"path": "a.py", "content": "x', truncated=True
    )
    assert isinstance(block, RejectedToolCall)
    assert block.error == TRUNCATED_CALL_ERROR


def test_a_missing_required_property_lists_what_is_accepted_and_what_was_sent():
    block = native_call_to_tool_block("bash", json.dumps({"cmd": "ls"}))
    assert isinstance(block, RejectedToolCall)
    assert 'missing required property "command"' in block.error
    assert "Accepted properties: command." in block.error
    assert "You sent: cmd." in block.error


def test_arguments_that_are_not_an_object_are_named_as_such():
    block = native_call_to_tool_block("bash", json.dumps(["ls -la"]))
    assert isinstance(block, RejectedToolCall)
    assert "expected a JSON object, got list" in block.error


def test_tools_without_required_properties_keep_their_lenient_shapes():
    # A python repair call sends `edits` and no `code`.
    repair = native_call_to_tool_block(
        "python", json.dumps({"edits": [{"find": "a", "replace": "b"}]})
    )
    assert not isinstance(repair, RejectedToolCall)
    # No arguments at all is a valid `ls`.
    assert not isinstance(native_call_to_tool_block("ls", ""), RejectedToolCall)
    # Aliases still resolve.
    assert native_call_to_tool_block("shell", json.dumps({"command": "pwd"})).tool_type == "bash"


def test_required_properties_of_this_turns_tools_are_checked_too():
    mcp = {
        "type": "function",
        "function": {
            "name": "mcp__crm__find",
            "parameters": {
                "type": "object",
                "properties": {"customer": {"type": "string"}},
                "required": ["customer"],
            },
        },
    }
    rejected = native_call_to_tool_block("mcp__crm__find", "{}", schemas=[mcp])
    assert isinstance(rejected, RejectedToolCall)
    assert 'missing required property "customer"' in rejected.error
    ok = native_call_to_tool_block(
        "mcp__crm__find", json.dumps({"customer": "macs"}), schemas=[mcp]
    )
    assert not isinstance(ok, RejectedToolCall)


# ── the loop ─────────────────────────────────────────────────────────────────


def _events(chunks):
    return [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]


def _scripted_model(monkeypatch, rounds):
    """Each entry of `rounds` is the list of SSE payloads one model call yields."""
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(json.loads(json.dumps(messages, default=str)))
        for payload in rounds[min(len(requests), len(rounds)) - 1]:
            yield f"data: {json.dumps(payload)}\n\n"
        yield "data: [DONE]\n\n"

    real_execute = agent_loop.execute_tool_block

    async def fake_execute(block, **kwargs):
        if getattr(block, "error", None):
            return await real_execute(block, **kwargs)
        return f"{block.tool_type}: ok", {"output": f"ran:{block.content}", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def _run(**kwargs):
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    return [
        chunk
        async for chunk in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=4, **kwargs
        )
    ]


def _tool_results(request):
    return {m["tool_call_id"]: m["content"] for m in request if m.get("role") == "tool"}


async def test_every_call_of_a_round_gets_its_own_result(monkeypatch):
    calls = [
        {"id": "c1", "name": "bash", "arguments": json.dumps({"command": "echo a"})},
        {"id": "c2", "name": "no_such_tool", "arguments": "{}"},
        {"id": "c3", "name": "bash", "arguments": '{"command": "echo c'},
        {"id": "c4", "name": "bash", "arguments": json.dumps({"command": "echo d"})},
    ]
    requests = _scripted_model(
        monkeypatch, [[{"type": "tool_calls", "calls": calls}], [{"delta": "Fertig."}]]
    )
    chunks = await _run()

    second = requests[1]
    assistant = [m for m in second if m.get("role") == "assistant" and m.get("tool_calls")][-1]
    assert [tc["id"] for tc in assistant["tool_calls"]] == ["c1", "c2", "c3", "c4"]
    results = _tool_results(second)
    assert list(results) == ["c1", "c2", "c3", "c4"]
    # The rejected calls no longer shift the others onto the wrong ids.
    assert "ran:echo a" in results["c1"]
    assert 'unknown tool "no_such_tool"' in results["c2"]
    assert "not valid JSON" in results["c3"]
    assert "ran:echo d" in results["c4"]

    # The user sees the rejected calls as failed tool rows.
    failed = [
        e for e in _events(chunks) if e.get("type") == "tool_output" and e.get("exit_code") == 1
    ]
    assert {e["tool"] for e in failed} == {"no_such_tool", "bash"}


async def test_a_call_cut_off_at_the_length_limit_is_not_run(monkeypatch):
    cut = {"id": "c1", "name": "write_file", "arguments": '{"path": "a.py", "content": "impo'}
    requests = _scripted_model(
        monkeypatch,
        [
            [{"type": "tool_calls", "calls": [cut]}, {"type": "finish", "reason": "length"}],
            [{"delta": "Fertig."}],
        ],
    )
    chunks = await _run()

    assert _tool_results(requests[1])["c1"].endswith(TRUNCATED_CALL_ERROR)
    metrics = [e["data"] for e in _events(chunks) if e.get("type") == "metrics"][-1]
    assert metrics["round_profile"][0]["truncated"] is True
    assert "truncated" not in metrics["round_profile"][1]


async def test_an_answer_cut_off_at_the_length_limit_is_reported(monkeypatch):
    requests = _scripted_model(
        monkeypatch,
        [[{"delta": "Die ersten drei Punkte sind"}, {"type": "finish", "reason": "length"}]],
    )
    chunks = await _run()

    assert len(requests) == 1  # no nudge, no rewrite: the turn ends and says why
    assert {"type": "output_truncated", "round": 1} in _events(chunks)
    metrics = [e["data"] for e in _events(chunks) if e.get("type") == "metrics"][-1]
    assert metrics["stop_reason"] == "output_truncated"


async def test_a_round_that_spent_the_limit_on_thinking_is_told_so(monkeypatch):
    requests = _scripted_model(
        monkeypatch,
        [
            [{"delta": "hm, also...", "thinking": True}, {"type": "finish", "reason": "length"}],
            [{"delta": "Fertig."}],
        ],
    )
    await _run()

    assert "output length limit" in str(requests[1][-1]["content"])


# ── the stream layer ─────────────────────────────────────────────────────────


def _sse(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


async def _stream(monkeypatch, body):
    def handle(request):
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)
    out = []
    async for chunk in llm_core.stream_llm(
        "http://vllm.test:8000/v1", "qwen3-llm", [{"role": "user", "content": "hi"}]
    ):
        if chunk.startswith("data: {"):
            out.append(json.loads(chunk[6:]))
    await client.aclose()
    return out


async def test_the_stream_reports_a_length_stop_and_nothing_for_a_normal_one(monkeypatch):
    cut = await _stream(
        monkeypatch,
        _sse(
            {"choices": [{"delta": {"content": "abc"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
        ),
    )
    assert cut[-1] == {"type": "finish", "reason": "length"}

    done = await _stream(
        monkeypatch,
        _sse(
            {"choices": [{"delta": {"content": "abc"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ),
    )
    assert not [e for e in done if e.get("type") == "finish"]


async def test_a_length_stop_on_the_usage_chunk_is_still_seen(monkeypatch):
    # Some servers put finish_reason on the final chunk that also carries usage.
    events = await _stream(
        monkeypatch,
        _sse(
            {"choices": [{"delta": {"content": "abc"}}]},
            {
                "choices": [{"delta": {}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3},
            },
        ),
    )
    assert {"type": "finish", "reason": "length"} in events


async def test_the_turns_metrics_count_what_the_loop_had_to_do(monkeypatch):
    calls = [
        {"id": "c1", "name": "no_such_tool", "arguments": "{}"},
        {"id": "c2", "name": "bash", "arguments": '{"command": "echo c'},
    ]
    _scripted_model(monkeypatch, [[{"type": "tool_calls", "calls": calls}], [{"delta": "Fertig."}]])
    chunks = await _run()

    metrics = [e["data"] for e in _events(chunks) if e.get("type") == "metrics"][-1]
    # Zero entries are left out, so a clean turn stores nothing.
    assert metrics["loop"] == {"rejected_calls": 2}


async def test_a_clean_turn_has_no_loop_statistics(monkeypatch):
    _scripted_model(monkeypatch, [[{"delta": "Fertig."}]])
    metrics = [e["data"] for e in _events(await _run()) if e.get("type") == "metrics"][-1]
    assert "loop" not in metrics and "stop_reason" not in metrics
