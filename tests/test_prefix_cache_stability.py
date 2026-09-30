"""The prompt a turn sends must share its head with the previous turn's prompt.

vLLM's prefix cache reuses computation from token 0 up to the first byte that
differs. Anything that changes per message — the clock, a composer switch, the
tool subset, a mid-turn nudge — has to sit after the conversation history, or
every message re-prefills the whole chat. These tests pin that contract.
"""

import json

import pytest

from src import agent_loop
from src.llm_core import SYSTEM_NOTICE_PREFIX, _consolidate_system_messages
from src.tool_catalog import (
    CORE_TOOLS,
    FIND_TOOLS,
    META_TOOL_SCHEMAS,
    RUN_TOOL,
    catalog_prompt,
    find_tools,
    split_tools,
    unwrap_run_tool,
)
from src.turn_context import insert_before_last_user, turn_context_message

# ── system-message consolidation ──


def test_leading_system_messages_are_hoisted():
    out = _consolidate_system_messages(
        [
            {"role": "system", "content": "A"},
            {"role": "user", "content": "preface"},
            {"role": "system", "content": "B"},
            {"role": "user", "content": "q"},
        ]
    )
    assert out[0] == {"role": "system", "content": "A\n\nB"}
    assert [m["role"] for m in out] == ["system", "user"]


def test_later_system_messages_stay_in_place_as_user_turns():
    msgs = [
        {"role": "system", "content": "policy"},
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "system", "content": "nudge"},
        {"role": "user", "content": "q2"},
    ]
    out = _consolidate_system_messages(msgs)
    assert out[0] == {"role": "system", "content": "policy"}
    assert out[1] == {"role": "user", "content": "q1"}
    assert out[2]["role"] == "assistant"
    # Converted in place and merged with the adjacent user turn.
    assert out[3]["role"] == "user"
    assert out[3]["content"].startswith(SYSTEM_NOTICE_PREFIX)
    assert out[3]["content"].endswith("q2")
    assert len(out) == 4


# ── turn context ──


def test_turn_context_goes_right_before_the_last_user_message():
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "new"},
    ]
    insert_before_last_user(msgs, turn_context_message("clock"))
    assert msgs[3]["role"] == "user" and "clock" in msgs[3]["content"]
    assert msgs[4]["content"] == "new"


def test_empty_turn_context_is_skipped():
    assert turn_context_message("", None, "  ") is None
    msgs = [{"role": "user", "content": "q"}]
    assert insert_before_last_user(msgs, None) == [{"role": "user", "content": "q"}]


# ── tool catalog ──


def _schema(name, desc="Does a thing. More detail."):
    return {
        "type": "function",
        "function": {"name": name, "description": desc, "parameters": {"type": "object"}},
    }


def test_split_keeps_core_order_and_sorts_the_catalog():
    fns = [_schema("bash"), _schema("manage_mcp"), _schema("web_search"), _schema("list_models")]
    mcp = [_schema("mcp__z__tool"), _schema("mcp__a__tool")]
    core, catalog = split_tools(fns, mcp, hidden={"list_models"})
    names = [s["function"]["name"] for s in core]
    assert names == ["bash", "web_search", FIND_TOOLS, RUN_TOOL]
    assert [s["function"]["name"] for s in catalog] == [
        "manage_mcp",
        "mcp__a__tool",
        "mcp__z__tool",
    ]


def test_no_meta_tools_without_a_catalog():
    core, catalog = split_tools([_schema("bash")], [], hidden=set())
    assert catalog == [] and [s["function"]["name"] for s in core] == ["bash"]


def test_catalog_prompt_lists_one_line_per_tool():
    text = catalog_prompt([_schema("manage_mcp", "Manage MCP servers. Long tail.")])
    assert "`manage_mcp` — Manage MCP servers" in text
    assert "Long tail" not in text


def test_find_tools_by_name_and_by_query():
    catalog = [_schema("manage_mcp", "Manage MCP servers."), _schema("list_models", "List models.")]
    by_name = find_tools(catalog, names=["list_models"])
    assert '"name": "list_models"' in by_name and "manage_mcp" not in by_name
    by_query = find_tools(catalog, query="configure mcp servers")
    assert '"name": "manage_mcp"' in by_query
    assert "No matching tool" in find_tools(catalog, names=["nope"])


def test_unwrap_run_tool():
    assert unwrap_run_tool('{"name": "list_models", "arguments": {"filter": "qwen"}}') == (
        "list_models",
        '{"filter": "qwen"}',
    )
    # Double-encoded nested arguments are tolerated.
    assert unwrap_run_tool({"name": "x", "arguments": '{"a": 1}'}) == ("x", '{"a": 1}')
    assert unwrap_run_tool('{"arguments": {}}') is None
    assert unwrap_run_tool('{"name": "run_tool"}') is None


def test_run_tool_call_executes_the_named_tool():
    blocks, used_native = agent_loop._resolve_tool_blocks(
        "",
        [{"name": RUN_TOOL, "arguments": '{"name": "list_models", "arguments": {"filter": "q"}}'}],
        1,
        native_mode=True,
    )
    assert used_native and blocks[0].tool_type == "list_models"


def test_malformed_run_tool_call_reports_an_error_block():
    blocks, _ = agent_loop._resolve_tool_blocks(
        "", [{"name": RUN_TOOL, "arguments": "{}"}], 1, native_mode=True
    )
    assert blocks[0].tool_type == RUN_TOOL


def test_core_tools_include_the_knowledge_sources():
    # Available sources are always core tools, never hidden in the catalog.
    for name in ("web_search", "web_fetch", "query_sql", "search_knowledge", "create_document"):
        assert name in CORE_TOOLS
    assert {s["function"]["name"] for s in META_TOOL_SCHEMAS} == {FIND_TOOLS, RUN_TOOL}


# ── end to end: two turns through the agent loop ──


@pytest.fixture
def captured(monkeypatch):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(
            {
                "messages": json.loads(json.dumps(messages, default=str)),
                "tools": kwargs.get("tools"),
                "tool_choice": kwargs.get("tool_choice"),
            }
        )
        yield f"data: {json.dumps({'delta': 'Antwort.'})}\n\n"
        yield "data: [DONE]\n\n"

    clock = iter(f"## Current date and time\nIt is 10:{m:02d}." for m in range(60))
    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr("src.user_time.current_datetime_prompt", lambda *a, **k: next(clock))
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return calls


async def _run_turn(messages, **kwargs):
    async for _ in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=1, **kwargs
    ):
        pass


def _wire(call):
    """What stream_llm would put on the wire, minus provider details."""
    return _consolidate_system_messages(call["messages"])


async def test_second_turn_extends_the_first_turns_prompt(captured):
    base = [
        {"role": "system", "content": "Talos policy."},
        {"role": "user", "content": "Hallo"},
        {"role": "assistant", "content": "Hallo! Wie kann ich helfen?"},
        {"role": "user", "content": "Wie viele Kunden haben wir?"},
    ]
    # "Full knowledge" on both messages — the usual case: a mode stays on.
    await _run_turn([dict(m) for m in base], use_rag=True, force_db=True)
    turn2 = [dict(m) for m in base] + [
        {"role": "assistant", "content": "Antwort."},
        {"role": "user", "content": "Und im Vorjahr?"},
    ]
    await _run_turn(turn2, use_rag=True, force_db=True)
    first, second = captured
    assert first["tools"] == second["tools"]
    w1, w2 = _wire(first), _wire(second)
    # Identical system turn — the clock and the DB note are not in it.
    assert w1[0] == w2[0]
    assert "10:0" not in w1[0]["content"]
    assert "DATABASE ACCESS" not in w1[0]["content"]
    # Everything before the first turn's question is shared verbatim; the
    # question itself differs only because its turn context is gone.
    assert len(w1) == 4
    assert w2[:3] == w1[:3]
    assert w2[3] == {"role": "user", "content": "Wie viele Kunden haben wir?"}
    assert "10:00" in w1[3]["content"] and "10:01" in w2[-1]["content"]
    # The per-turn material sits in the new question's turn.
    assert "DATABASE ACCESS" in w2[-1]["content"]
    assert w2[-1]["content"].endswith("Und im Vorjahr?")


async def test_switched_off_sources_are_not_offered(captured):
    msgs = [{"role": "system", "content": "p"}, {"role": "user", "content": "wer ist markus rühl"}]
    # "Nur Chat" with web off: no database, no knowledge base, no web.
    await _run_turn(
        [dict(m) for m in msgs],
        use_rag=False,
        force_db=False,
        disabled_tools={"web_search", "web_fetch"},
    )
    (call,) = captured
    names = {t["function"]["name"] for t in call["tools"]}
    assert not names & {"query_sql", "search_knowledge", "web_search", "web_fetch"}
    wire = _wire(call)
    assert "DATABASE ACCESS" not in json.dumps(wire)
    available = next(
        line for line in wire[0]["content"].splitlines() if line.startswith("Available tools:")
    )
    assert "query_sql" not in available and "search_knowledge" not in available


async def test_sql_knowledge_refresh_is_appended_not_rewritten(monkeypatch):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(json.loads(json.dumps(messages, default=str)))
        if len(calls) == 1:
            call = {"id": "c1", "name": "query_sql", "arguments": '{"query": "SELECT 1"}'}
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    retrievals = iter(["[a.md]\nTabelle A", "[a.md]\nTabelle A\n\n---\n\n[b.md]\nTabelle B"])
    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "_retrieve_sql_knowledge", lambda q: next(retrievals, ""))
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    msgs = [{"role": "system", "content": "p"}, {"role": "user", "content": "Umsatz 2025?"}]
    async for _ in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1", "qwen3-llm", msgs, max_rounds=2, force_db=True
    ):
        pass
    first, second = (_consolidate_system_messages(c) for c in calls)
    # Round 2 starts with round 1's prompt, byte for byte.
    assert second[: len(first)] == first
    assert "Tabelle A" in json.dumps(first)
    # The refresh sits at the end and carries only the new section.
    tail = second[-1]["content"]
    assert "Tabelle B" in tail and "Tabelle A" not in tail
