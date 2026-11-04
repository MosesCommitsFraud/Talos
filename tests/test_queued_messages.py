"""Messages queued during a turn: delivered at the next round boundary, without
disturbing the prompt so far, and never at the cost of the interrupted turn."""

import asyncio
import json

import pytest

from src import agent_loop, agent_runs
from src.history_replay import collect_turn_messages


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


def _events(chunks):
    out = []
    for chunk in chunks:
        if chunk.startswith("data: {"):
            out.append(json.loads(chunk[6:]))
    return out


def _fake_model(monkeypatch, tool_rounds=1):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(json.loads(json.dumps(messages, default=str)))
        if len(calls) <= tool_rounds:
            call = {"id": f"c{len(calls)}", "name": "web_search", "arguments": json.dumps({"query": f"q{len(calls)}"})}
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return calls


async def _run(messages, **kwargs):
    return [
        chunk
        async for chunk in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=4, **kwargs
        )
    ]


async def test_queued_message_reaches_the_next_round_and_keeps_the_prompt_prefix(monkeypatch):
    calls = _fake_model(monkeypatch)
    inbox = [[], [{"id": "m1", "text": "Bitte auch 2024 prüfen."}]]
    sink = {}
    msgs = [{"role": "system", "content": "p"}, {"role": "user", "content": "Umsatz 2025?"}]
    chunks = await _run(msgs, inbox=lambda: inbox.pop() if inbox else [], wire_sink=sink)

    first, second = calls
    # Round 2 starts with round 1's prompt, byte for byte, so nothing re-prefills.
    assert second[: len(first)] == first
    # The original question is still there, the addition sits at the very end.
    assert any(m.get("content", "") and "Umsatz 2025?" in str(m["content"]) for m in second)
    assert second[-1]["role"] == "user"
    assert second[-1]["content"].endswith("Bitte auch 2024 prüfen.")
    assert "still open" in second[-1]["content"]

    events = _events(chunks)
    delivered = [e for e in events if e.get("type") == "queued_message"]
    assert delivered == [{"type": "queued_message", "id": "m1", "text": "Bitte auch 2024 prüfen."}]
    metrics = [e["data"] for e in events if e.get("type") == "metrics"][-1]
    assert metrics["queued_messages"] == [{"id": "m1", "text": "Bitte auch 2024 prüfen.", "round": 2}]
    # Stored with the turn, so later turns replay it verbatim.
    turn = collect_turn_messages(sink["messages"], "Fertig.")
    assert any("Bitte auch 2024 prüfen." in str(m.get("content")) for m in turn)


async def test_a_turn_without_another_round_leaves_the_message_queued(monkeypatch):
    calls = _fake_model(monkeypatch, tool_rounds=0)
    agent_runs._RUNS["s1"] = agent_runs._Run()
    assert agent_runs.enqueue("s1", {"id": "m1", "text": "Noch was"})
    msgs = [{"role": "system", "content": "p"}, {"role": "user", "content": "Hallo"}]
    chunks = await _run(msgs, inbox=lambda: agent_runs.take_queued("s1"))
    assert len(calls) == 1
    assert not [e for e in _events(chunks) if e.get("type") == "queued_message"]
    # The client sends what the turn never reported as a turn of its own.
    assert agent_runs._RUNS["s1"].inbox == [{"id": "m1", "text": "Noch was"}]


def test_text_protocol_extends_the_unsent_tool_results():
    msgs = [{"role": "user", "content": f"{agent_loop.TOOL_RESULT_PREFIX}\n\nok"}]
    assert agent_loop._append_queued_message(msgs, "Und das?") is None
    assert len(msgs) == 1
    assert msgs[0]["content"].startswith(agent_loop.TOOL_RESULT_PREFIX)
    assert msgs[0]["content"].endswith("Und das?")


def test_queue_needs_a_running_turn_and_hands_each_message_out_once():
    assert not agent_runs.enqueue("nope", {"id": "a", "text": "x"})
    agent_runs._RUNS["s1"] = agent_runs._Run()
    assert agent_runs.enqueue("s1", {"id": "a", "text": "x"})
    assert agent_runs.enqueue("s1", {"id": "b", "text": "y"})
    assert agent_runs.withdraw("s1", "a")
    assert not agent_runs.withdraw("s1", "a")
    assert [item["id"] for item in agent_runs.take_queued("s1")] == ["b"]
    assert agent_runs.take_queued("s1") == []


async def test_stop_and_wait_returns_after_the_partial_answer_is_saved():
    saved = []
    started = asyncio.Event()

    async def turn():
        try:
            started.set()
            yield "data: {}\n\n"
            await asyncio.sleep(60)
        finally:
            # The route saves in its cancellation handler, which can take a moment.
            await asyncio.sleep(0.01)
            saved.append(True)

    run = agent_runs.start("s1", turn())
    await started.wait()
    await asyncio.sleep(0)
    agent_runs.enqueue("s1", {"id": "a", "text": "x"})
    assert await agent_runs.stop_and_wait("s1")
    assert saved == [True]
    assert run.status == "stopped"
    assert run.inbox == []
    assert not await agent_runs.stop_and_wait("s1")
