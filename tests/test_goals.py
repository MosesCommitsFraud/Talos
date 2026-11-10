"""A chat's goal: kept on the server, counted in rounds, and ended by the model
only with evidence (complete) or a blocker that has persisted (blocked)."""

import json

import pytest

from src import agent_loop, agent_runs, goals


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(goals, "_PATH", str(tmp_path / "goals.json"))
    monkeypatch.setattr(goals, "max_rounds_setting", lambda: 5)
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


# ── the record ───────────────────────────────────────────────────────────────


def test_a_goal_is_stored_per_chat_and_survives_a_reload():
    created = goals.create("chat-1", "  Alle   Rechnungen 2025\nprüfen ")
    assert created["objective"] == "Alle Rechnungen 2025 prüfen"
    assert (created["status"], created["round"], created["max_rounds"]) == ("active", 0, 5)
    # Read back from the file, as after a restart.
    assert goals.get("chat-1")["objective"] == "Alle Rechnungen 2025 prüfen"
    assert goals.get("chat-2") is None
    assert goals.is_active("chat-1") and not goals.is_active("chat-2")


def test_a_running_goal_is_not_replaced_and_an_empty_one_is_refused():
    goals.create("chat-1", "A")
    with pytest.raises(goals.GoalError):
        goals.create("chat-1", "B")
    with pytest.raises(goals.GoalError):
        goals.create("chat-2", "   ")
    # Once it has ended, a new objective takes its place.
    goals.begin_round("chat-1")
    goals.report("chat-1", "complete", evidence="geprüft")
    assert goals.create("chat-1", "B")["objective"] == "B"


def test_each_round_is_counted_and_worded_by_the_server():
    goals.create("chat-1", 'Bericht "Q3" fertigstellen')
    first = goals.begin_round("chat-1")
    second = goals.begin_round("chat-1")

    assert first.startswith("<goal_round>") and first.endswith("</goal_round>")
    assert 'Objective: "Bericht \\"Q3\\" fertigstellen"' in first
    assert "Round: 1/5" in first and "Round: 2/5" in second
    assert "update_goal" in first
    assert goals.get("chat-1")["round"] == 2


def test_the_round_limit_blocks_the_goal_and_resuming_grants_more_rounds():
    goals.create("chat-1", "A")
    for _ in range(5):
        goals.begin_round("chat-1")
    with pytest.raises(goals.GoalError, match="limit of 5 rounds"):
        goals.begin_round("chat-1")
    blocked = goals.get("chat-1")
    assert (blocked["status"], blocked["reason_code"], blocked["round"]) == (
        "blocked",
        "round-limit",
        5,
    )

    resumed = goals.resume("chat-1")
    assert (resumed["status"], resumed["max_rounds"]) == ("active", 10)
    assert "Round: 6/10" in goals.begin_round("chat-1")


def test_no_round_starts_for_a_goal_that_is_not_running():
    with pytest.raises(goals.GoalError):
        goals.begin_round("chat-1")
    goals.create("chat-1", "A")
    goals.pause("chat-1")
    with pytest.raises(goals.GoalError, match="paused"):
        goals.begin_round("chat-1")
    assert goals.get("chat-1")["round"] == 0


# ── the model's report ───────────────────────────────────────────────────────


def test_complete_needs_evidence():
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    refused = goals.report("chat-1", "complete")
    assert refused["exit_code"] == 1 and "evidence" in refused["error"]
    assert goals.is_active("chat-1")

    done = goals.report("chat-1", "complete", evidence="Alle 40 Tests grün, Bericht in output/")
    assert done["exit_code"] == 0 and done["goal"]["status"] == "complete"
    assert "closing message" in done["output"] and "Do not call any more tools" in done["output"]
    assert goals.get("chat-1")["evidence"].startswith("Alle 40 Tests")


def test_blocked_is_only_accepted_once_the_obstacle_has_persisted():
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    early = goals.report("chat-1", "blocked", reason="Kein Zugriff auf die Datenbank")
    assert early["exit_code"] == 1 and "after 3 rounds" in early["error"]
    assert goals.is_active("chat-1")

    goals.begin_round("chat-1")
    goals.begin_round("chat-1")
    assert goals.report("chat-1", "blocked")["exit_code"] == 1  # no reason given
    late = goals.report("chat-1", "blocked", reason="Kein Zugriff auf die Datenbank")
    assert late["exit_code"] == 0
    goal = goals.get("chat-1")
    assert (goal["status"], goal["reason_code"]) == ("blocked", "reported")
    assert goal["reason"] == "Kein Zugriff auf die Datenbank"


def test_a_report_without_a_running_goal_or_with_another_action_is_an_error():
    assert goals.report("chat-1", "complete", evidence="x")["exit_code"] == 1
    goals.create("chat-1", "A")
    assert goals.report("chat-1", "pause")["exit_code"] == 1


# ── how a round's turn ended ─────────────────────────────────────────────────


def test_a_turn_that_simply_ended_leaves_the_goal_running():
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    assert goals.settle_turn("chat-1")["status"] == "active"
    # A step cap reached mid-task is no reason to stop either: the next round
    # picks the work up.
    assert goals.settle_turn("chat-1", stop_reason="rounds_exhausted")["status"] == "active"


def test_a_stop_by_the_user_pauses_and_an_error_blocks():
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    assert goals.settle_turn("chat-1", stopped_by_user=True)["status"] == "paused"

    goals.resume("chat-1")
    blocked = goals.settle_turn("chat-1", stop_reason="context_overflow")
    assert (blocked["status"], blocked["reason_code"]) == ("blocked", "context-overflow")
    # A goal that has ended is left as it is.
    assert (
        goals.settle_turn("chat-1", stop_reason="model_error")["reason_code"] == "context-overflow"
    )


def test_clearing_removes_the_goal():
    goals.create("chat-1", "A")
    goals.clear("chat-1")
    assert goals.get("chat-1") is None
    goals.clear("chat-1")  # nothing to clear is fine


# ── the loop ─────────────────────────────────────────────────────────────────


def _model(monkeypatch, script):
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append({"messages": json.loads(json.dumps(messages, default=str)), **kwargs})
        for payload in script[min(len(requests), len(script)) - 1]:
            yield f"data: {json.dumps(payload)}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def _run(session_id, question="Los."):
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": question}]
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=6, session_id=session_id
        )
    ]
    return [json.loads(c[6:]) for c in chunks if c.startswith("data: {")]


def _tool_names(request):
    return {t["function"]["name"] for t in request.get("tools") or []}


async def test_the_goal_tool_is_only_offered_in_a_chat_with_a_running_goal(monkeypatch):
    requests = _model(monkeypatch, [[{"delta": "Fertig."}]])
    await _run("chat-without-goal")
    assert "update_goal" not in _tool_names(requests[0])

    goals.create("chat-1", "A")
    await _run("chat-1", goals.begin_round("chat-1"))
    assert "update_goal" in _tool_names(requests[1])
    assert "<goal_round>" in requests[1]["messages"][-1]["content"]


async def test_completing_the_goal_ends_the_run_with_a_closing_message(monkeypatch):
    goals.create("chat-1", "Bericht fertigstellen")
    call = {
        "id": "c1",
        "name": "update_goal",
        "arguments": json.dumps({"action": "complete", "evidence": "Bericht liegt in output/"}),
    }
    requests = _model(
        monkeypatch,
        [[{"type": "tool_calls", "calls": [call]}], [{"delta": "Der Bericht ist fertig."}]],
    )
    events = await _run("chat-1", goals.begin_round("chat-1"))

    assert goals.get("chat-1")["status"] == "complete"
    goal_events = [e["data"] for e in events if e.get("type") == "goal"]
    assert goal_events and goal_events[-1]["status"] == "complete"
    # The closing round cannot call tools any more.
    assert requests[1].get("tool_choice") == "none" or not requests[1].get("tools")
    result = [m for m in requests[1]["messages"] if m.get("role") == "tool"][-1]["content"]
    assert "closing message" in result
    assert "Der Bericht ist fertig." in "".join(e.get("delta", "") for e in events)


async def test_a_refused_report_keeps_the_goal_and_the_tools(monkeypatch):
    goals.create("chat-1", "A")
    call = {"id": "c1", "name": "update_goal", "arguments": json.dumps({"action": "complete"})}
    requests = _model(
        monkeypatch, [[{"type": "tool_calls", "calls": [call]}], [{"delta": "Ich prüfe noch."}]]
    )
    events = await _run("chat-1", goals.begin_round("chat-1"))

    assert goals.is_active("chat-1")
    assert not [e for e in events if e.get("type") == "goal"]
    assert "update_goal" in _tool_names(requests[1])
    result = [m for m in requests[1]["messages"] if m.get("role") == "tool"][-1]["content"]
    assert "evidence" in result
