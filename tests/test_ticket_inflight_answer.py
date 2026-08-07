"""Tests for capturing an in-flight answer in a ticket snapshot.

The gap this closes: the assistant row is written to the DB only when a turn
FINISHES. Filing a ticket while the agent is still working — the most common
moment to report a problem — froze the question with no answer under it, even
though the reporter was looking at a screen full of streamed text. The snapshot
now replays the detached run's buffer (``agent_runs.partial_text``) and appends
what has streamed so far, flagged ``partial``.
"""

import json

import pytest

from src import agent_runs


def _ev(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@pytest.fixture
def run(monkeypatch):
    """A detached run registered under a throwaway session id."""
    r = agent_runs._Run()
    monkeypatch.setitem(agent_runs._RUNS, "sid", r)
    return r


def test_deltas_are_joined_and_thinking_dropped(run):
    run.buffer = [
        _ev({"delta": "weighing options", "thinking": True}),
        _ev({"delta": "Let me read "}),
        _ev({"delta": "the file."}),
    ]
    assert agent_runs.partial_text("sid") == "Let me read the file."


def test_agent_step_separates_rounds(run):
    run.buffer = [
        _ev({"delta": "First I inspect the data."}),
        _ev({"type": "tool_start", "tool": "bash"}),
        _ev({"type": "tool_output", "output": "42 rows"}),
        _ev({"type": "agent_step"}),
        _ev({"delta": "Now the document."}),
    ]
    assert agent_runs.partial_text("sid") == "First I inspect the data.\n\nNow the document."


def test_content_final_replaces_the_current_round(run):
    """Mirrors the client: the anti-hallucination guard's rewrite wins over the
    deltas it already streamed."""
    run.buffer = [
        _ev({"delta": "Answer with ![fake](/nope.png)"}),
        _ev({"type": "content_final", "content": "Answer without the figure"}),
    ]
    assert agent_runs.partial_text("sid") == "Answer without the figure"


def test_nothing_streamed_yet_is_none(run):
    """A run still inside its first tool call adds no empty bubble."""
    run.buffer = [_ev({"type": "tool_start", "tool": "bash"})]
    assert agent_runs.partial_text("sid") is None


def test_unknown_session_is_none():
    assert agent_runs.partial_text("no-such-session") is None


def test_malformed_events_are_skipped(run):
    run.buffer = ["event: error\ndata: not json\n\n", "data: \n\n", _ev({"delta": "ok"})]
    assert agent_runs.partial_text("sid") == "ok"
