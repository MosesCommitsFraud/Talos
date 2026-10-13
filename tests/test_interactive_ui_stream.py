"""render_ui through the agent loop: streamed arguments become ui_stream_*
events, the call becomes a `ui` widget, and nothing opens the document panel."""

import json

from src import agent_loop
from src import interactive_ui as ui

CALL = {
    "title": "Umsatz je Monat",
    "initialHeight": 400,
    "placeholderMessages": ["Lade …"],
    "css": "",
    "html": '<div id="chart"></div>',
    "js": "function render(){}",
    "jsInit": ["render()"],
    "data": {"values": [1, 2]},
    "sources": [{"kind": "sql", "label": "dbo.orders"}],
}


async def _run(monkeypatch, first_round):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            for frame in first_round:
                yield f"data: {json.dumps(frame)}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "_retrieve_sql_knowledge", lambda q: "")
    monkeypatch.setattr(ui, "enabled", lambda: True)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    events = []
    async for chunk in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1",
        "qwen3-llm",
        [{"role": "user", "content": "Zeig mir den Umsatz"}],
        max_rounds=3,
    ):
        if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
            try:
                events.append(json.loads(chunk[6:]))
            except json.JSONDecodeError:
                pass
    return events


def _deltas(name, args, size=17, index=0):
    return [
        {"type": "tool_call_delta", "index": index, "name": name, "arg_delta": args[i : i + size]}
        for i in range(0, len(args), size)
    ]


async def test_native_render_ui_streams_into_the_chat(monkeypatch):
    args = json.dumps(CALL)
    frames = _deltas("render_ui", args) + [
        {"type": "tool_calls", "calls": [{"id": "c1", "name": "render_ui", "arguments": args}]}
    ]
    events = await _run(monkeypatch, frames)
    types = [e.get("type") for e in events]

    assert "doc_stream_open" not in types  # a render_ui title is not a document
    opens = [e for e in events if e.get("type") == "ui_stream_open"]
    assert len(opens) == 1
    html = "".join(
        e.get("append", "")
        for e in events
        if e.get("type") == "ui_stream_delta" and e.get("field") == "html"
    )
    assert html == CALL["html"]
    # The stream comes first, then the call runs and carries the widget.
    start = next(
        e for e in events if e.get("type") == "tool_start" and e.get("tool") == "render_ui"
    )
    assert start["command"] == "Umsatz je Monat"  # the title, never the payload
    out = next(e for e in events if e.get("type") == "tool_output" and e.get("tool") == "render_ui")
    assert out["widget"]["type"] == "ui"
    assert types.index("ui_stream_open") < types.index("tool_start")


async def test_other_tools_with_a_title_do_not_open_the_editor(monkeypatch):
    args = json.dumps({"title": "Notiz", "content": "x"})
    frames = _deltas("create_skill", args) + [
        {"type": "tool_calls", "calls": [{"id": "c1", "name": "create_skill", "arguments": args}]}
    ]
    events = await _run(monkeypatch, frames)
    assert not any(e.get("type") in ("doc_stream_open", "ui_stream_open") for e in events)


async def test_create_document_still_streams_to_the_editor(monkeypatch):
    args = json.dumps({"title": "Bericht", "content": "Hallo Welt"})
    frames = _deltas("create_document", args)
    events = await _run(monkeypatch, frames)
    assert any(e.get("type") == "doc_stream_open" for e in events)


async def test_fenced_render_ui_streams_too(monkeypatch):
    text = "Hier:\n```render_ui\n" + json.dumps(CALL) + "\n```\n"
    frames = [{"delta": text[i : i + 23]} for i in range(0, len(text), 23)]
    events = await _run(monkeypatch, frames)
    assert any(e.get("type") == "ui_stream_open" for e in events)
    html = "".join(
        e.get("append", "")
        for e in events
        if e.get("type") == "ui_stream_delta" and e.get("field") == "html"
    )
    assert html == CALL["html"]
