"""Reasoning of earlier steps goes back to the model only when the setting asks
for it, only to servers we run ourselves, and then for every step so the prompt
stays what was generated."""

import json

import httpx
import pytest

from src import agent_loop, agent_runs, llm_core, settings
from src.history_replay import collect_turn_messages, make_turn_wire

VLLM = "http://192.168.10.91:8000/v1"


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


def _setting(monkeypatch, on):
    def fake(key, default=None):
        return on if key == "reasoning_passback" else default

    monkeypatch.setattr(settings, "get_setting", fake)
    monkeypatch.setattr(agent_loop, "get_setting", fake)


STEP = {
    "role": "assistant",
    "content": None,
    "reasoning_content": "Erst die Tabelle ansehen.",
    "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "ls", "arguments": "{}"}}],
}
CONVERSATION = [
    {"role": "system", "content": "p"},
    {"role": "user", "content": "Los."},
    STEP,
    {"role": "tool", "tool_call_id": "c1", "content": "a.csv"},
]


# ── what is sent ─────────────────────────────────────────────────────────────


def test_by_default_no_reasoning_leaves_the_app():
    sent = llm_core._sanitize_llm_messages(CONVERSATION)
    assert all("reasoning" not in m and "reasoning_content" not in m for m in sent)


def test_kept_reasoning_goes_out_under_both_field_names():
    sent = llm_core._consolidate_system_messages(
        llm_core._sanitize_llm_messages(CONVERSATION, keep_reasoning=True), keep_reasoning=True
    )
    step = [m for m in sent if m["role"] == "assistant"][0]
    # Current vLLM templates read `reasoning`, older ones `reasoning_content`.
    assert step["reasoning"] == step["reasoning_content"] == "Erst die Tabelle ansehen."
    assert step["tool_calls"] == STEP["tool_calls"]


def test_only_self_hosted_servers_get_it(monkeypatch):
    _setting(monkeypatch, True)
    assert llm_core.reasoning_passback_enabled(VLLM, "openai")
    assert llm_core.reasoning_passback_enabled("http://localhost:8000/v1", "openai")
    # Hosted APIs have their own rules for message fields.
    assert not llm_core.reasoning_passback_enabled("https://api.openai.com/v1", "openai")
    assert not llm_core.reasoning_passback_enabled("https://api.deepseek.com/v1", "openai")
    assert not llm_core.reasoning_passback_enabled("https://api.anthropic.com/v1", "anthropic")
    assert not llm_core.reasoning_passback_enabled("http://localhost:11434", "ollama")

    _setting(monkeypatch, False)
    assert not llm_core.reasoning_passback_enabled(VLLM, "openai")


async def _request_body(monkeypatch, url):
    seen = {}

    def handle(request):
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            text='data: {"choices": [{"delta": {"content": "ok"}}]}\n\ndata: [DONE]\n\n',
            headers={"content-type": "text/event-stream"},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)
    async for _ in llm_core.stream_llm(url, "qwen3-llm", CONVERSATION):
        pass
    await client.aclose()
    return seen


async def test_the_request_carries_the_reasoning_when_the_setting_is_on(monkeypatch):
    _setting(monkeypatch, True)
    body = await _request_body(monkeypatch, VLLM)
    step = [m for m in body["messages"] if m["role"] == "assistant"][0]
    assert step["reasoning"] == "Erst die Tabelle ansehen."


async def test_the_request_is_unchanged_when_the_setting_is_off(monkeypatch):
    _setting(monkeypatch, False)
    body = await _request_body(monkeypatch, VLLM)
    step = [m for m in body["messages"] if m["role"] == "assistant"][0]
    assert set(step) == {"role", "content", "tool_calls"}


# ── the loop ─────────────────────────────────────────────────────────────────


def _thinking_model(monkeypatch):
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(json.loads(json.dumps(messages, default=str)))
        n = len(requests)
        yield f"data: {json.dumps({'delta': f'Gedanke {n}', 'thinking': True})}\n\n"
        if n <= 2:
            call = {"id": f"c{n}", "name": "bash", "arguments": json.dumps({"command": f"s{n}"})}
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    async def fake_execute(block, **kwargs):
        return "bash: ok", {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def _run(sink=None):
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    return [
        c
        async for c in agent_loop.stream_agent_loop(
            VLLM, "qwen3-llm", messages, max_rounds=6, wire_sink=sink
        )
    ]


def _reasoning(request):
    return [m.get("reasoning_content") for m in request if m.get("role") == "assistant"]


async def test_with_the_setting_every_step_keeps_its_reasoning(monkeypatch):
    _setting(monkeypatch, True)
    requests = _thinking_model(monkeypatch)
    sink = {}
    await _run(sink)

    third = requests[2]
    assert _reasoning(third) == ["Gedanke 1", "Gedanke 2"]
    # Round 3's prompt is round 2's prompt plus what came after: nothing the
    # server has seen changes, so nothing is prefilled twice.
    assert third[: len(requests[1])] == requests[1]

    # The stored turn replays the same reasoning, the final answer's included.
    turn = collect_turn_messages(
        sink["messages"], sink["round_text"], final_reasoning=sink["round_reasoning"]
    )
    wire = make_turn_wire(turn, "Los.", keep_reasoning=True)
    stored = [m.get("reasoning_content") for m in wire["messages"] if m["role"] == "assistant"]
    assert stored == ["Gedanke 1", "Gedanke 2", "Gedanke 3"]


async def test_without_the_setting_only_the_newest_step_has_it_and_nothing_is_stored(monkeypatch):
    _setting(monkeypatch, False)
    requests = _thinking_model(monkeypatch)
    sink = {}
    await _run(sink)

    assert _reasoning(requests[2]) == [None, "Gedanke 2"]
    wire = make_turn_wire(collect_turn_messages(sink["messages"], sink["round_text"]), "Los.")
    assert all("reasoning_content" not in m for m in wire["messages"])
