"""Verbatim turn replay: a follow-up's prompt must extend the previous turn's."""

import json

from src import agent_loop
from src.history_replay import (
    HEAD_KEY,
    PREFACE_KEY,
    PRIOR_KEY,
    WIRE_KEY,
    WIRE_REPLAYED,
    apply_turn_wires,
    collect_turn_messages,
    expand_tool_history,
    make_turn_wire,
    stamp_answer,
)
from src.llm_core import _consolidate_system_messages

# ── storage / replay helpers ──


def test_make_turn_wire_keeps_only_provider_fields():
    wire = make_turn_wire(
        [
            {"role": "user", "content": "q", "metadata": {"x": 1}, PRIOR_KEY: True},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
            {"role": "tool", "tool_call_id": "c1", "content": "r"},
        ],
        "q",
    )
    assert wire["messages"][0] == {"role": "user", "content": "q"}
    assert wire["messages"][1] == {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": "c1"}],
    }


def test_oversized_wire_is_not_stored(monkeypatch):
    from src import history_replay

    monkeypatch.setattr(history_replay, "WIRE_MAX_BYTES", 10)
    assert make_turn_wire([{"role": "user", "content": "a long question"}], "q") is None


def _pair(question, sent, events=None):
    md = {WIRE_KEY: make_turn_wire(sent, question)}
    if events:
        md["tool_events"] = events
    return [
        {"role": "user", "content": question},
        {"role": "assistant", "content": "Antwort", "metadata": md},
    ]


def test_pair_with_wire_is_replaced_by_the_sent_messages():
    sent = [
        {"role": "user", "content": "[Kontext] Frage"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "Ergebnis"},
        {"role": "assistant", "content": "Antwort"},
    ]
    events = [{"tool": "query_sql", "output": "Ergebnis"}]
    out = apply_turn_wires(_pair("Frage", sent, events))
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "assistant"]
    assert out[0]["content"] == "[Kontext] Frage"
    # The legacy replay block is not added on top of the verbatim turn…
    assert expand_tool_history(out, enabled=True) == out
    # …but the artifact manifest still sees the tool events.
    assert out[-1]["metadata"][WIRE_REPLAYED] is True


def test_edited_question_falls_back_to_the_plain_pair():
    history = _pair("Frage", [{"role": "user", "content": "[Kontext] Frage"}])
    history[0]["content"] = "Geänderte Frage"
    out = apply_turn_wires(history)
    assert out[0]["content"] == "Geänderte Frage"
    assert WIRE_KEY not in out[1]["metadata"]


# ── end to end: two turns through the agent loop ──


async def test_follow_up_prompt_extends_the_previous_turn(monkeypatch):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(json.loads(json.dumps(messages, default=str)))
        if len(calls) == 1:  # turn 1, round 1: a tool call
            call = {"id": "c1", "name": "query_sql", "arguments": '{"query": "SELECT 1"}'}
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Antwort ' + str(len(calls))})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "_retrieve_sql_knowledge", lambda q: "")
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    async def run(messages):
        sink = {}
        async for _ in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1",
            "qwen3-llm",
            messages,
            max_rounds=3,
            force_db=True,
            wire_sink=sink,
        ):
            pass
        return collect_turn_messages(sink["messages"], sink["round_text"], sink["compacted"])

    def build(history, question):
        # What build_chat_context does: preface + replayed history, prior marked.
        msgs = [{"role": "system", "content": "Talos policy."}] + apply_turn_wires(history)
        msgs.append({"role": "user", "content": question})
        for m in msgs[:-1]:
            m[PRIOR_KEY] = True
        return msgs

    wire1 = await run(build([], "Umsatz 2025?"))
    # Turn context (clock, DB note), the question, the tool round, the answer.
    assert [m["role"] for m in wire1][-4:] == ["user", "assistant", "tool", "assistant"]
    assert wire1[-4]["content"] == "Umsatz 2025?"
    assert "DATABASE ACCESS" in json.dumps(wire1[:-4])
    history = [
        {"role": "user", "content": "Umsatz 2025?"},
        {
            "role": "assistant",
            "content": "Antwort 2",
            "metadata": {WIRE_KEY: make_turn_wire(wire1, "Umsatz 2025?")},
        },
    ]
    await run(build(history, "Und 2024?"))

    last_of_turn1 = _consolidate_system_messages(calls[1])  # turn 1, final round
    first_of_turn2 = _consolidate_system_messages(calls[2])  # turn 2, round 1
    # The follow-up repeats turn 1's final prompt byte for byte…
    assert first_of_turn2[: len(last_of_turn1)] == last_of_turn1
    # …then turn 1's answer and the new question.
    rest = first_of_turn2[len(last_of_turn1) :]
    assert rest[0] == {"role": "assistant", "content": "Antwort 2"}
    assert rest[-1]["content"].endswith("Und 2024?")


# ── the Claude-like edge cases ──


def test_hand_edited_answer_is_what_the_model_sees():
    sent = [
        {"role": "user", "content": "Frage"},
        {"role": "assistant", "content": "Original"},
    ]
    history = _pair("Frage", sent)
    stamp_answer(history[1]["metadata"][WIRE_KEY], "Antwort")
    history[1]["content"] = "Von Hand korrigiert"
    out = apply_turn_wires(history)
    assert out[-1]["role"] == "assistant" and out[-1]["content"] == "Von Hand korrigiert"
    assert out[0] == {"role": "user", "content": "Frage"}


def test_compacted_turn_replaces_everything_before_it():
    older = _pair("Alte Frage", [{"role": "user", "content": "Alte Frage"}])
    compacted_turn = [
        {"role": "system", "content": "[Zusammenfassung des bisherigen Gesprächs]"},
        {"role": "user", "content": "Neue Frage"},
        {"role": "assistant", "content": "Neue Antwort"},
    ]
    newer = [
        {"role": "user", "content": "Neue Frage"},
        {
            "role": "assistant",
            "content": "Neue Antwort",
            "metadata": {WIRE_KEY: make_turn_wire(compacted_turn, "Neue Frage", base=True)},
        },
    ]
    out = apply_turn_wires(older + newer)
    assert [m["content"] for m in out] == [
        "[Zusammenfassung des bisherigen Gesprächs]",
        "Neue Frage",
        "Neue Antwort",
    ]


def test_collect_after_compaction_drops_head_and_preface():
    messages = [
        {"role": "system", "content": "head", HEAD_KEY: True},
        {"role": "system", "content": "summary"},
        {"role": "user", "content": "skills index", PREFACE_KEY: True},
        {"role": "user", "content": "Frage"},
    ]
    turn = collect_turn_messages(messages, "Teilantwort", compacted=True)
    assert [m["content"] for m in turn] == ["summary", "Frage", "Teilantwort"]


def test_stopped_turn_keeps_what_happened_until_the_stop():
    messages = [
        {"role": "system", "content": "head", HEAD_KEY: True},
        {"role": "user", "content": "alt", PRIOR_KEY: True},
        {"role": "user", "content": "Frage"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "Ergebnis"},
    ]
    turn = collect_turn_messages(messages, "Ich schreibe gerade", compacted=False)
    assert [m["role"] for m in turn] == ["user", "assistant", "tool", "assistant"]
    assert turn[-1]["content"] == "Ich schreibe gerade"
