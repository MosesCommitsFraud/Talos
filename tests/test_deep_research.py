"""Deep research mode: the protocol, its budgets, and the subagent hookup.

The mode is a per-message switch, so its instructions must ride as turn
context (never in the cached head) and adapt to the sources the turn has.
"""

import asyncio
import importlib
import json

import pytest

dr = importlib.import_module("src.deep_research")
sub = importlib.import_module("src.subagents")
bg_jobs = importlib.import_module("src.bg_jobs")
agent_loop = importlib.import_module("src.agent_loop")
turn_context = importlib.import_module("src.turn_context")


def test_protocol_with_subagents_fans_out():
    text = dr.protocol(subagents=True, web=True, knowledge=False, database=False)
    assert "`delegate`" in text and "`update_plan`" in text and "`ask_user`" in text
    assert "web_search" in text
    assert "Work through the sub-questions yourself" not in text


def test_protocol_without_subagents_researches_itself():
    text = dr.protocol(subagents=False, web=True, knowledge=True, database=False)
    assert "`delegate`" not in text
    assert "yourself" in text
    assert "knowledge base first" in text


def test_protocol_without_web_says_so():
    text = dr.protocol(subagents=True, web=False, knowledge=True, database=True)
    assert "web is switched off" in text
    assert "query_sql" in text


def test_protocol_without_any_source_does_not_pretend():
    text = dr.protocol(subagents=True, web=False, knowledge=False, database=False)
    assert "No research source" in text
    assert "`delegate`" not in text


def test_protocol_message_is_turn_context():
    msg = dr.protocol_message(subagents=True, web=True, knowledge=False, database=False)
    assert msg["role"] == "user"
    assert msg["metadata"]["source"] == turn_context.TURN_CONTEXT_SOURCE
    # Stable text: the same switches give byte-identical instructions.
    again = dr.protocol_message(subagents=True, web=True, knowledge=False, database=False)
    assert msg["content"] == again["content"]


def test_turn_budget_only_raises(monkeypatch):
    monkeypatch.setattr(dr, "_setting", lambda key, default: default)
    assert dr.turn_budget(20, 4096) == (40, 16384)
    assert dr.turn_budget(120, 32000) == (120, 32000)
    # 0 = uncapped output stays uncapped.
    assert dr.turn_budget(20, 0) == (40, 0)


@pytest.fixture
def deep_turn(tmp_path, monkeypatch):
    monkeypatch.setattr(bg_jobs, "_JOBS_DIR", tmp_path / "bg_jobs")
    monkeypatch.setattr(bg_jobs, "_STORE", tmp_path / "bg_jobs.json")
    monkeypatch.setattr(sub, "_setting", lambda key, default: default)
    sub.set_turn_context(
        {
            "endpoint_url": "http://llm",
            "model": "m",
            "session_id": "s1",
            "use_rag": False,
            "deep_research": True,
        }
    )
    yield
    sub.set_turn_context(None)


def test_deep_turn_subagents_research_harder(deep_turn, monkeypatch):
    calls = []

    async def fake(endpoint_url, model, messages, **kw):
        calls.append({"messages": messages, **kw})
        yield "data: " + json.dumps({"delta": "Report [1]"}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_agent_loop", fake)
    tasks = {"tasks": [{"title": "A", "prompt": "Find A"}, {"title": "B", "prompt": "Find B"}]}
    out = asyncio.run(sub.run_tasks(json.dumps(tasks), session_id="s1"))
    assert out["exit_code"] == 0
    assert len(calls) == 2
    for call in calls:
        first = call["messages"][0]["content"]
        assert dr.SUBAGENT_HEAD in first
        assert call["max_rounds"] == 20
    # Same head for the whole wave: only the assignment differs.
    a, b = (c["messages"][0]["content"] for c in calls)
    assert a.split("Assignment:")[0] == b.split("Assignment:")[0]


def test_normal_turn_subagents_unchanged(deep_turn, monkeypatch):
    sub.set_turn_context({"endpoint_url": "http://llm", "model": "m", "session_id": "s1"})
    calls = []

    async def fake(endpoint_url, model, messages, **kw):
        calls.append({"messages": messages, **kw})
        yield "data: " + json.dumps({"delta": "Report"}) + "\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_agent_loop", fake)
    asyncio.run(sub.run_tasks(json.dumps({"tasks": [{"prompt": "Find A"}]}), session_id="s1"))
    assert dr.SUBAGENT_HEAD not in calls[0]["messages"][0]["content"]
    assert calls[0]["max_rounds"] == 12
