"""A written answer followed by its chart ends the turn: another round would only
yield a closing remark and then, through the completeness nudge, the whole answer
a second time."""

import json

from src import agent_loop, interactive_ui
from src.history_replay import collect_turn_messages

ANSWER = "Der geplante Absatz liegt bei 461.294,47. " * 20
CHART = {
    "type": "chart",
    "title": "Absatz 2026",
    "data": {
        "kind": "bar",
        "categories": ["Jan", "Feb"],
        "series": [{"name": "A", "values": [1, 2]}],
    },
    "sources": [{"kind": "sql", "label": "dbo.plan"}],
}
BROKEN_CHART = {"type": "gauge", "data": {}, "sources": CHART["sources"]}


async def _run(monkeypatch, text, calls_in_first_round):
    prompts = []

    async def fake_stream(candidates, messages, **kwargs):
        prompts.append(json.loads(json.dumps(messages, default=str)))
        if len(prompts) == 1:
            yield f"data: {json.dumps({'delta': text})}\n\n"
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': calls_in_first_round})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Gern.'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(interactive_ui, "enabled", lambda: True)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    sink = {}
    events = []
    async for chunk in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1",
        "qwen3-llm",
        [{"role": "user", "content": "Welcher Absatz ist geplant?"}],
        max_rounds=4,
        wire_sink=sink,
    ):
        if chunk.startswith("data: {"):
            events.append(json.loads(chunk[6:]))
    return prompts, events, sink


def _call(name, args, call_id="c1"):
    return {"id": call_id, "name": name, "arguments": json.dumps(args)}


async def test_answer_with_chart_needs_no_further_round(monkeypatch):
    prompts, events, sink = await _run(monkeypatch, ANSWER, [_call("render_widget", CHART)])

    assert len(prompts) == 1
    assert not [e for e in events if e.get("type") == "agent_step" and e.get("round", 0) > 1]
    output = [e for e in events if e.get("type") == "tool_output"]
    assert output and output[-1]["exit_code"] == 0
    assert "".join(e.get("delta", "") for e in events) == ANSWER


async def test_stored_turn_keeps_the_chart_and_holds_the_answer_once(monkeypatch):
    _, _, sink = await _run(monkeypatch, ANSWER, [_call("render_widget", CHART)])

    turn = collect_turn_messages(sink["messages"], sink["round_text"])
    assert any(m.get("tool_calls") for m in turn)  # a follow-up can still change the chart
    assert sum(ANSWER.strip() in str(m.get("content") or "") for m in turn) == 1


async def test_chart_with_only_a_lead_in_goes_on(monkeypatch):
    prompts, _, _ = await _run(monkeypatch, "Hier das Diagramm:", [_call("render_widget", CHART)])
    assert len(prompts) == 2


async def test_failed_chart_gets_another_round(monkeypatch):
    prompts, _, _ = await _run(monkeypatch, ANSWER, [_call("render_widget", BROKEN_CHART)])
    assert len(prompts) > 1


async def test_chart_next_to_a_query_goes_on(monkeypatch):
    prompts, _, _ = await _run(
        monkeypatch,
        ANSWER,
        [
            _call("render_widget", CHART),
            _call("query_sql", {"action": "list_databases"}, call_id="c2"),
        ],
    )
    assert len(prompts) > 1
