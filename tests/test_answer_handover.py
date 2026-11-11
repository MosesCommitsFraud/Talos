"""The model writes its answer once and what it hands over arrives: a question
at the end of an answer does not swallow the document that answer describes,
and a short closing line after the answer does not cost a second answer."""

import json

import pytest

from src import agent_loop, agent_runs

ANSWER = ("Der Bericht ist fertig und enthält alle Kennzahlen des Quartals. " * 12).strip()
assert len(ANSWER) >= agent_loop._FULL_ANSWER_MIN_CHARS


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


def _call(cid, name, **args):
    return {"id": cid, "name": name, "arguments": json.dumps(args)}


DOC = _call("c1", "create_document", title="Quartalsbericht", content="# Bericht")
FILES = _call("c2", "present_files", files=["output/bericht.pdf"])
SEARCH = _call("c3", "web_search", query="weitere Zahlen")


def _model(monkeypatch, rounds, fail=()):
    requests, executed = [], []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(json.loads(json.dumps(messages, default=str)))
        for payload in rounds[min(len(requests), len(rounds)) - 1]:
            yield f"data: {json.dumps(payload)}\n\n"
        yield "data: [DONE]\n\n"

    real_execute = agent_loop.execute_tool_block

    async def fake_execute(block, **kwargs):
        if getattr(block, "error", None):
            return await real_execute(block, **kwargs)
        executed.append(block.tool_type)
        if block.tool_type in fail:
            return f"{block.tool_type}: failed", {"error": "kaputt", "exit_code": 1}
        return f"{block.tool_type}: ok", {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests, executed


async def _run(sink=None):
    messages = [
        {"role": "system", "content": "p"},
        {"role": "user", "content": "Erstelle den Bericht."},
    ]
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=6, wire_sink=sink
        )
    ]
    return [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]


def _rows(events):
    return [(e["tool"], e.get("exit_code")) for e in events if e.get("type") == "tool_output"]


# ── an answer that ends with a question ──────────────────────────────────────


async def test_what_the_answer_hands_over_is_delivered_and_the_turn_ends(monkeypatch):
    requests, executed = _model(
        monkeypatch,
        [
            [
                {"delta": ANSWER + " Soll ich noch eine PDF-Version erstellen?"},
                {"type": "tool_calls", "calls": [DOC, FILES]},
            ]
        ],
    )
    sink = {}
    events = await _run(sink)

    assert executed == ["create_document", "present_files"]
    assert _rows(events) == [("create_document", 0), ("present_files", 0)]
    # The question stands: no further round answers it for the user.
    assert len(requests) == 1
    # The stored turn has the calls with their results, and the answer once.
    stored = sink["messages"]
    assert [m["role"] for m in stored[-3:]] == ["assistant", "tool", "tool"]
    assert sink["round_text"] == ""


async def test_calls_that_would_carry_the_work_on_are_left_out_and_say_why(monkeypatch):
    requests, executed = _model(
        monkeypatch,
        [
            [
                {"delta": ANSWER + " Soll ich weitere Zahlen recherchieren?"},
                {"type": "tool_calls", "calls": [DOC, SEARCH]},
            ]
        ],
    )
    sink = {}
    events = await _run(sink)

    assert executed == ["create_document"]
    # Shown as not run, not as a failure.
    assert _rows(events) == [("create_document", 0), ("web_search", None)]
    results = {m["tool_call_id"]: m["content"] for m in sink["messages"] if m["role"] == "tool"}
    assert list(results) == ["c1", "c3"]
    assert "ended with a question to the user" in results["c3"]
    metrics = [e["data"] for e in events if e.get("type") == "metrics"][-1]
    assert "loop" not in metrics  # a left-out call is not a rejected one


async def test_a_question_with_only_work_calls_ends_the_turn_without_running_them(monkeypatch):
    requests, executed = _model(
        monkeypatch,
        [
            [
                {"delta": ANSWER + " Soll ich weitersuchen?"},
                {"type": "tool_calls", "calls": [SEARCH]},
            ]
        ],
    )
    events = await _run()

    assert executed == [] and len(requests) == 1
    assert [e["output"] for e in events if e.get("type") == "tool_output"] == ["not executed"]


async def test_a_failed_hand_over_gives_the_model_another_round(monkeypatch):
    requests, executed = _model(
        monkeypatch,
        [
            [{"delta": ANSWER + " Passt das so?"}, {"type": "tool_calls", "calls": [DOC]}],
            [{"delta": "Das Dokument ließ sich nicht anlegen."}],
        ],
        fail=("create_document",),
    )
    await _run()
    assert len(requests) == 2


async def test_a_short_text_or_an_ask_user_call_is_not_affected(monkeypatch):
    # A short lead-in ending with "?" is not an answer; the work goes on.
    requests, executed = _model(
        monkeypatch,
        [
            [{"delta": "Welche Zahlen gibt es?"}, {"type": "tool_calls", "calls": [SEARCH]}],
            [{"delta": "Fertig."}],
        ],
    )
    await _run()
    assert executed == ["web_search"] and len(requests) == 2


# ── a short closing line after the answer ────────────────────────────────────


async def test_the_answer_is_written_once(monkeypatch):
    requests, executed = _model(
        monkeypatch,
        [
            [{"delta": ANSWER}, {"type": "tool_calls", "calls": [SEARCH]}],
            [{"delta": "Das war alles."}],
        ],
    )
    events = await _run()

    # Two model calls: no third one asking for the whole answer again.
    assert len(requests) == 2
    text = "".join(e.get("delta", "") for e in events)
    assert text.count(ANSWER) == 1 and text.rstrip().endswith("Das war alles.")
    assert not any("final message is incomplete" in str(m.get("content")) for m in requests[-1])
    # Both rounds' texts are saved, so the chat can show the answer above the
    # closing line (web/src/components/Messages.tsx, answerBody).
    metrics = [e["data"] for e in events if e.get("type") == "metrics"][-1]
    assert [t for t in metrics["round_texts"]] == [ANSWER, "Das war alles."]
