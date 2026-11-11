"""A turn stopped while its tool calls were running keeps those calls.

The round's calls and results only enter the conversation once all of them are
back. A stop before that used to leave no trace of the round in the stored
turn, so the model began the next turn not knowing that a call had been sent
off and may have gone through.
"""

import asyncio
import json

import pytest

from src import agent_loop, agent_runs
from src.agent_loop import STOPPED_RESULT, stopped_round_messages
from src.history_replay import WIRE_KEY, apply_turn_wires, collect_turn_messages, make_turn_wire


def _call(call_id, name, **args):
    return {"id": call_id, "name": name, "arguments": json.dumps(args)}


@pytest.fixture
def stopped_turn(monkeypatch):
    """Run a turn whose model sends `calls`; the stop arrives while the call
    named `stop_in` is running. Returns the loop's wire sink."""
    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    monkeypatch.setattr(agent_loop, "_tool_parallelism", lambda: 1)

    async def run(calls, stop_in, text="Ich lege die Datei an."):
        async def fake_stream(candidates, messages, **kwargs):
            yield f"data: {json.dumps({'delta': text})}\n\n"
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': calls})}\n\n"
            yield "data: [DONE]\n\n"

        async def execute(block, **kwargs):
            if block.tool_type == stop_in:
                raise asyncio.CancelledError()
            return f"{block.tool_type}: ok", {"output": "erledigt", "exit_code": 0}

        monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
        monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
        sink = {}
        messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
        with pytest.raises(asyncio.CancelledError):
            async for _ in agent_loop.stream_agent_loop(
                "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=3, wire_sink=sink
            ):
                pass
        return sink

    yield run
    agent_runs._RUNS.clear()


def _stored(sink):
    return collect_turn_messages(
        sink["messages"], sink["round_text"], stopped_round=stopped_round_messages(sink)
    )


async def test_the_stored_turn_ends_with_the_call_and_its_unknown_outcome(stopped_turn):
    sink = await stopped_turn([_call("c1", "write_file", path="a.txt", content="x")], "write_file")
    turn = _stored(sink)

    assert [m["role"] for m in turn][-3:] == ["user", "assistant", "tool"]
    assistant, result = turn[-2], turn[-1]
    # The round's text is on the message that carries the call, once.
    assert assistant["content"] == "Ich lege die Datei an."
    assert assistant["tool_calls"][0]["function"]["name"] == "write_file"
    assert result == {"role": "tool", "tool_call_id": "c1", "content": STOPPED_RESULT}
    assert sum("Ich lege die Datei an." in str(m.get("content")) for m in turn) == 1
    # The live conversation is left as it was.
    assert not any(m.get("role") == "tool" for m in sink["messages"])


async def test_calls_that_were_done_keep_their_results(stopped_turn):
    sink = await stopped_turn(
        [
            _call("c1", "read_file", path="a.txt"),
            _call("c2", "write_file", path="b.txt", content="x"),
            _call("c3", "bash", command="ls"),
        ],
        "write_file",
    )
    results = [m["content"] for m in _stored(sink) if m["role"] == "tool"]

    assert "erledigt" in results[0] and STOPPED_RESULT not in results[0]
    # The one that was running, and the one after it: with calls running side
    # by side nobody can say that a later one had not started.
    assert results[1:] == [STOPPED_RESULT, STOPPED_RESULT]


async def test_the_next_turn_reads_it(stopped_turn):
    sink = await stopped_turn([_call("c1", "write_file", path="a.txt", content="x")], "write_file")
    wire = make_turn_wire(_stored(sink), "Los.")
    replayed = apply_turn_wires(
        [
            {"role": "user", "content": "Los."},
            {"role": "assistant", "content": "…", "metadata": {WIRE_KEY: wire}},
        ]
    )

    assert [m["role"] for m in replayed][-2:] == ["assistant", "tool"]
    assert replayed[-1]["content"] == STOPPED_RESULT
    # Every call has its answer, or the provider refuses the request.
    asked = [c["id"] for m in replayed for c in m.get("tool_calls") or []]
    assert asked == [m["tool_call_id"] for m in replayed if m["role"] == "tool"]


async def test_a_stop_outside_a_rounds_calls_adds_nothing(monkeypatch):
    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    async def fake_stream(candidates, messages, **kwargs):
        yield f"data: {json.dumps({'delta': 'Die Antwort ist'})}\n\n"
        raise asyncio.CancelledError()

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    sink = {}
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    with pytest.raises(asyncio.CancelledError):
        async for _ in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=3, wire_sink=sink
        ):
            pass
    agent_runs._RUNS.clear()

    assert stopped_round_messages(sink) == []
    assert _stored(sink)[-1] == {"role": "assistant", "content": "Die Antwort ist"}


async def test_a_turn_that_ran_through_has_no_round_in_flight(monkeypatch):
    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    rounds = []

    async def fake_stream(candidates, messages, **kwargs):
        rounds.append(1)
        if len(rounds) == 1:
            call = _call("c1", "read_file", path="a.txt")
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    async def execute(block, **kwargs):
        return "read_file: ok", {"output": "inhalt", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", execute)
    sink = {}
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Los."}]
    async for _ in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=3, wire_sink=sink
    ):
        pass
    agent_runs._RUNS.clear()

    assert stopped_round_messages(sink) == []


def test_the_text_protocol_gets_the_note_as_a_result_block():
    sink = {
        "in_flight": {
            "round_response": "```bash\nrm -r build\n```",
            "native_tool_calls": [],
            "tools": ["bash"],
            "tool_results": [],
            "tool_result_texts": [],
            "used_native": False,
            "round_num": 2,
            "round_reasoning": "",
        }
    }
    assistant, results = stopped_round_messages(sink)
    assert assistant == {"role": "assistant", "content": "```bash\nrm -r build\n```"}
    assert results["role"] == "user"
    assert results["content"].startswith(agent_loop.TOOL_RESULT_PREFIX)
    assert f"### bash\n{STOPPED_RESULT}" in results["content"]


# ── subagents ────────────────────────────────────────────────────────────────


def _flight(call):
    return {
        "round_response": "",
        "native_tool_calls": [call],
        "tools": [call["name"]],
        "tool_results": [],
        "tool_result_texts": [],
        "used_native": True,
        "round_num": 1,
        "round_reasoning": "",
    }


@pytest.mark.parametrize("stopped", [True, False])
async def test_a_stopped_subagent_keeps_its_running_calls_for_continue_task(
    monkeypatch, tmp_path, stopped
):
    from types import SimpleNamespace

    from src import subagents

    async def fake_loop(url, model, messages, wire_sink=None, **kwargs):
        wire_sink.update(messages=messages, round_text="", compacted=False)
        wire_sink["in_flight"] = _flight(_call("c1", "write_file", path="a.txt", content="x"))
        if stopped:
            raise asyncio.CancelledError()
        # The loop ended the turn itself with the round still open (the tool
        # budget does that): nothing was stopped, so nothing is unknown.
        yield f"data: {json.dumps({'delta': 'Bericht.'})}\n\n"

    monkeypatch.setattr(agent_loop, "stream_agent_loop", fake_loop)
    run = SimpleNamespace(
        rec={"id": "j1", "log_path": str(tmp_path / "j1.log")},
        target={"endpoint_url": "u", "model": "m"},
        messages=[{"role": "user", "content": "Auftrag"}],
        kind="worker",
        text="",
        on_event=lambda data: None,
    )
    if stopped:
        with pytest.raises(asyncio.CancelledError):
            await subagents._run_one(run, {})
    else:
        await subagents._run_one(run, {})

    history = subagents._load_history(run.rec)
    assert history[0] == {"role": "user", "content": "Auftrag"}
    if stopped:
        assert history[-1] == {"role": "tool", "tool_call_id": "c1", "content": STOPPED_RESULT}
        assert history[-2]["tool_calls"][0]["function"]["name"] == "write_file"
    else:
        assert not any(m["role"] == "tool" for m in history)
