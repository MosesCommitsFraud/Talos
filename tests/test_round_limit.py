"""A turn has no step cap unless one is configured: it takes as many rounds as
the work needs, and a configured cap still ends it."""

import json

import pytest

from src import agent_loop, agent_runs
from src.settings import DEFAULT_SETTINGS


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


def _working_model(monkeypatch, tool_rounds):
    """A model that makes a different call each round, then answers."""
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(len(messages))
        if len(requests) <= tool_rounds:
            call = {
                "id": f"c{len(requests)}",
                "name": "bash",
                "arguments": json.dumps({"command": f"step {len(requests)}"}),
            }
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


async def _run(max_rounds):
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=max_rounds
        )
    ]
    return [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]


def test_the_default_is_no_cap():
    assert DEFAULT_SETTINGS["agent_max_rounds"] == 0


async def test_without_a_cap_the_turn_runs_until_the_model_is_done(monkeypatch):
    # Far past the old default of 20 and the old code default of 50.
    requests = _working_model(monkeypatch, tool_rounds=60)
    events = await _run(max_rounds=0)

    assert len(requests) == 61
    assert not [e for e in events if e.get("type") == "rounds_exhausted"]
    assert "Fertig." in "".join(e.get("delta", "") for e in events)


async def test_a_configured_cap_still_ends_the_turn(monkeypatch):
    requests = _working_model(monkeypatch, tool_rounds=60)
    events = await _run(max_rounds=5)

    assert len(requests) == 5
    assert {"type": "rounds_exhausted", "rounds": 5} in events
