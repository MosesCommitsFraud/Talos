"""Tests for the context-meter category breakdown (src/agent_loop.py)."""

from src.agent_loop import (
    TOOL_RESULT_PREFIX,
    _compute_context_breakdown,
    _is_tool_result_message,
    _split_tool_schema_estimates,
)


def _schema(name: str, size: int = 200) -> dict:
    return {"type": "function", "function": {"name": name, "description": "x" * size}}


def test_tool_results_split_out_of_messages():
    messages = [
        {"role": "system", "content": "sys " * 200},
        {"role": "user", "content": "hello " * 200},
        {"role": "assistant", "content": "hi " * 200},
        {"role": "user", "content": f"{TOOL_RESULT_PREFIX}\n\n" + ("output " * 2000)},
    ]
    bd = _compute_context_breakdown(messages, None, 50_000)
    assert bd is not None
    assert "toolResults" in bd
    assert "messages" in bd
    # The tool dump is far bigger than the chat turns and must dominate.
    assert bd["toolResults"] > bd["messages"]
    assert sum(bd.values()) == 50_000


def test_native_tool_role_counts_as_tool_results():
    assert _is_tool_result_message({"role": "tool", "content": "x"})
    assert _is_tool_result_message({"role": "user", "content": f"{TOOL_RESULT_PREFIX}\n\nx"})
    assert not _is_tool_result_message({"role": "user", "content": "just a question"})
    assert not _is_tool_result_message({"role": "assistant", "content": "answer"})


def test_mcp_tools_split_from_builtin_tools():
    schemas = [_schema("read_file"), _schema("bash"), _schema("mcp__github__create_issue")]
    est = _split_tool_schema_estimates(schemas)
    assert set(est) == {"tools", "mcpTools"}
    # Two built-ins vs one MCP tool of the same size.
    assert est["tools"] > est["mcpTools"]


def test_schema_split_handles_missing_names():
    est = _split_tool_schema_estimates([{"type": "function"}, {}])
    assert est.get("mcpTools") is None
    assert est.get("tools", 0) > 0


def test_skills_and_knowledge_categorised_from_source():
    messages = [
        {
            "role": "user",
            "content": "skills " * 300,
            "metadata": {"source": "available skills index"},
        },
        {
            "role": "user",
            "content": "docs " * 300,
            "metadata": {"source": "retrieved documents"},
        },
        {
            "role": "user",
            "content": "editor " * 300,
            "metadata": {"source": "active editor document"},
        },
        {"role": "user", "content": "hi"},
    ]
    bd = _compute_context_breakdown(messages, None, 10_000)
    assert bd is not None
    assert "skills" in bd
    assert "knowledge" in bd
    # The active editor document is its own row, not lumped into knowledge.
    assert "documents" in bd
    assert sum(bd.values()) == 10_000


def test_breakdown_sums_exactly_with_tool_schemas():
    messages = [
        {"role": "system", "content": "s" * 4000},
        {"role": "user", "content": "u" * 4000},
        {"role": "tool", "content": "t" * 8000},
    ]
    schemas = [_schema("read_file"), _schema("mcp__x__y")]
    for total in (1, 999, 12_345, 262_144):
        bd = _compute_context_breakdown(messages, schemas, total)
        assert bd is not None, total
        assert sum(bd.values()) == total, (total, bd)


def test_no_breakdown_without_tokens():
    assert _compute_context_breakdown([{"role": "user", "content": "x"}], None, 0) is None


def test_opening_turn_yields_single_category():
    """A brand-new chat's first frame has only the user's message.

    The live frame withholds a one-category breakdown (len(bd) > 1 in
    stream_agent_loop._context_metrics_frame) so the meter shows the plain bar
    rather than a legend whose single row just restates the total.
    """
    bd = _compute_context_breakdown([{"role": "user", "content": "hello"}], None, 12)
    assert bd is not None
    assert len(bd) == 1
    assert set(bd) == {"messages"}


def test_second_turn_yields_a_real_split():
    """Once history exists the opening frame has something worth showing."""
    messages = [
        {"role": "user", "content": "first question " * 50},
        {"role": "assistant", "content": "an answer " * 50},
        {"role": "tool", "content": "tool output " * 200},
        {"role": "user", "content": "follow-up"},
    ]
    bd = _compute_context_breakdown(messages, None, 5_000)
    assert bd is not None
    assert len(bd) > 1
    assert {"messages", "toolResults"} <= set(bd)
