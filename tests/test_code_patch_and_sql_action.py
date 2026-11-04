"""Regressions from the "Datenanalyse und Prognose" run (2026-08-31).

Two guards turned recoverable model mistakes into dead ends, and the turn died
after 31 rounds and 4.6M input tokens with neither the Excel file nor the
dashboard the user asked for:

1. `_repair_hint` tells the model to fix failing code with
   ``{"edits": [...]}`` in a ```python``` block — and the misformatted-tool-call
   guard in ``execute_tool_block`` rejected exactly that payload. Every repair
   attempt bounced; the last one ended the turn.
2. ``query_sql`` hard-failed on ``{"query": "SELECT ...", "action": "query_sql"}``
   even though the payload said unambiguously what was meant.
"""

import pytest

from src.tool_execution import _CODE_PATCH_KEYS, _parse_code_edits
from src.tool_implementations import _normalize_sql_action

PATCH = (
    '{"edits": [{"target": "for j, t in jares_total.items():", '
    '"replacement": "for j, t in jahres_total.items():"}]}'
)


class _Block:
    def __init__(self, tool_type, content):
        self.tool_type = tool_type
        self.content = content


# ── 1. The repair-patch format reaches the executor ──


def test_repair_patch_parses_into_edits():
    edits, _ = _parse_code_edits(PATCH)
    assert len(edits) == 1
    assert edits[0]["target"].startswith("for j, t in jares_total")


def test_patch_keys_match_what_the_parser_consumes():
    """The guard's exemption set must cover the key `_parse_code_edits` reads."""
    assert "edits" in _CODE_PATCH_KEYS


@pytest.mark.asyncio
async def test_python_edits_payload_is_not_misformatted():
    from src.tool_execution import execute_tool_block

    # No session_id → the sandbox path refuses rather than running anything, so
    # this exercises the guard without touching a container.
    desc, result = await execute_tool_block(_Block("python", PATCH), session_id=None)
    assert "misformatted" not in desc
    assert "not a tool call" not in str(result.get("error") or "")


@pytest.mark.asyncio
async def test_plain_json_in_python_block_is_still_rejected():
    """The original guard must keep working for genuinely misformatted calls."""
    from src.tool_execution import execute_tool_block

    block = _Block("python", '{"path": "notes.md", "old_string": "a", "new_string": "b"}')
    desc, result = await execute_tool_block(block, session_id=None)
    assert "misformatted" in desc
    assert "not a tool call" in result["error"]


# ── 2. query_sql action aliases ──


def test_tool_name_echoed_as_action_runs_the_query():
    assert _normalize_sql_action("query_sql", {"query": "SELECT 1"}) == "query"


def test_real_actions_pass_through():
    for action in ("query", "list_databases", "list_tables", "describe", "knowledge"):
        assert _normalize_sql_action(action, {}) == action


def test_knowledge_action_is_not_mistaken_for_sql():
    args = {"query": "welche Tabelle hat den Umsatz"}
    assert _normalize_sql_action("knowledge", args) == "knowledge"
    assert _normalize_sql_action("search_knowledge", args) == "knowledge"


async def test_knowledge_action_returns_the_sections_without_a_database(monkeypatch):
    from src import rag_mini
    from src.tool_implementations import do_query_sql

    queries = []

    def retrieve(query):
        queries.append(query)
        return ["[schema.md]\norders", "[schema.md]\nstatus"]

    monkeypatch.setattr(rag_mini, "retrieve_sections", retrieve)
    # No connection is needed: nothing here touches the database.
    monkeypatch.setattr(
        "src.tool_implementations._sql_connections",
        lambda: pytest.fail("the knowledge action must not need a database connection"),
    )
    result = await do_query_sql('{"action": "knowledge", "query": "Statuscodes"}')
    assert queries == ["Statuscodes"]
    assert result["exit_code"] == 0
    assert result["output"] == "[schema.md]\norders\n\n---\n\n[schema.md]\nstatus"


async def test_knowledge_action_says_when_there_is_nothing(monkeypatch):
    from src import rag_mini
    from src.tool_implementations import do_query_sql

    monkeypatch.setattr(rag_mini, "retrieve_sections", lambda query: [])
    result = await do_query_sql('{"action": "knowledge", "query": "x"}')
    assert result["exit_code"] == 0 and "nothing" in result["output"]


async def test_knowledge_action_needs_a_query():
    from src.tool_implementations import do_query_sql

    result = await do_query_sql('{"action": "knowledge"}')
    assert result["exit_code"] == 1


def test_unknown_action_falls_back_to_the_payload():
    assert _normalize_sql_action("frobnicate", {"query": "SELECT 1"}) == "query"
    assert _normalize_sql_action("frobnicate", {"table": "dbo.dim10"}) == "describe"


def test_unknown_action_with_no_hint_stays_unknown():
    assert _normalize_sql_action("frobnicate", {}) == "frobnicate"
