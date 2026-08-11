"""Tests for the full-fidelity ticket snapshot.

A ticket exists so an admin can see what went wrong in someone else's chat. The
prose alone almost never explains an agent bug — what does is the reasoning, the
tool calls and their output. These cover the three pieces that make that work:
replaying an in-flight turn out of the run buffer, rewriting owner-scoped media
URLs onto the ticket's own route, and the markdown export.
"""

import json
from types import SimpleNamespace

import pytest

from routes import ticket_routes
from src import agent_runs


def _ev(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@pytest.fixture
def run(monkeypatch):
    r = agent_runs._Run()
    monkeypatch.setitem(agent_runs._RUNS, "sid", r)
    return r


# ── the in-flight turn ────────────────────────────────────────────────────────


def test_partial_snapshot_keeps_thinking_and_tool_calls(run):
    run.buffer = [
        _ev({"delta": "weighing options", "thinking": True}),
        _ev({"delta": "Reading the file."}),
        _ev({"type": "tool_start", "tool": "bash", "command": "cat notes.md"}),
        _ev({"type": "tool_output", "output": "hello", "exit_code": 0}),
    ]
    snapshot = agent_runs.partial_snapshot("sid")
    assert snapshot["content"] == "Reading the file."
    assert snapshot["thinking"] == "weighing options"
    assert snapshot["round_texts"] == ["<think>weighing options</think>\n\nReading the file."]
    assert snapshot["tool_events"] == [
        {
            "round": 1,
            "tool": "bash",
            "command": "cat notes.md",
            "output": "hello",
            "exit_code": 0,
        }
    ]


def test_partial_snapshot_tags_tool_calls_with_their_round(run):
    run.buffer = [
        _ev({"delta": "First pass."}),
        _ev({"type": "tool_start", "tool": "bash", "command": "ls"}),
        _ev({"type": "tool_output", "output": "a b", "exit_code": 0}),
        _ev({"type": "agent_step"}),
        _ev({"delta": "Second pass."}),
        _ev({"type": "tool_start", "tool": "read_file", "command": "a"}),
        _ev({"type": "tool_output", "output": "contents", "exit_code": 0}),
    ]
    snapshot = agent_runs.partial_snapshot("sid")
    assert [e["round"] for e in snapshot["tool_events"]] == [1, 2]
    assert len(snapshot["round_texts"]) == 2


def test_partial_snapshot_of_a_turn_still_inside_its_first_tool_call(run):
    """No text yet, but the tool row is already worth freezing."""
    run.buffer = [_ev({"type": "tool_start", "tool": "bash", "command": "ls"})]
    snapshot = agent_runs.partial_snapshot("sid")
    assert snapshot["content"] == ""
    assert snapshot["tool_events"][0]["tool"] == "bash"


# ── media refs ────────────────────────────────────────────────────────────────


def test_owner_scoped_urls_are_rewritten_onto_the_ticket_route():
    media = ticket_routes._MediaMap("/api/tickets/t1/attachments/a1/media")
    payload = [
        {
            "role": "assistant",
            "content": "Here it is: ![chart](/api/generated-image/abc123.png)",
            "metadata": {
                "tool_events": [
                    {"tool": "generate_image", "image_url": "/api/generated-image/abc123.png"}
                ]
            },
        }
    ]
    rewritten = ticket_routes._rewrite_media(payload, media)
    ref = next(iter(media.entries))
    url = f"/api/tickets/t1/attachments/a1/media?ref={ref}"
    assert url in rewritten[0]["content"]
    assert rewritten[0]["metadata"]["tool_events"][0]["image_url"] == url
    # The same file twice is one ref — the map is an allow-list, not a log.
    assert media.entries == {ref: {"kind": "generated_image", "value": "abc123.png"}}


def test_artifact_download_urls_become_refs():
    media = ticket_routes._MediaMap("/api/tickets/t1/attachments/a1/media")
    payload = {"content": "see /api/artifacts/sess-9/download?path=out/report.docx now"}
    rewritten = ticket_routes._rewrite_media(payload, media)
    assert "/api/artifacts/" not in rewritten["content"]
    assert list(media.entries.values()) == [{"kind": "artifact", "value": "out/report.docx"}]


def test_unknown_urls_are_left_alone():
    media = ticket_routes._MediaMap("/api/tickets/t1/attachments/a1/media")
    payload = {"content": "![x](/api/personal/rag-asset?source=%2Fdocs%2Fa.png) and /api/upload/u7"}
    assert ticket_routes._rewrite_media(payload, media) == payload
    assert media.entries == {}


# ── markdown export ───────────────────────────────────────────────────────────


def _attachment(transcript, *, artifacts=None, version=2):
    return SimpleNamespace(
        id="a1",
        session_name="Broken run",
        format_version=version,
        transcript=json.dumps(transcript),
        artifacts=json.dumps(artifacts or []),
    )


def _ticket():
    return SimpleNamespace(id="t1", title="Agent hangs", created_by="ada")


def test_markdown_export_carries_reasoning_and_tool_output():
    attachment = _attachment(
        [
            {"role": "user", "content": "why is it slow?", "metadata": {}},
            {
                "role": "assistant",
                "content": "The query scans the whole table.",
                "metadata": {
                    "round_texts": [
                        "<think>check the plan first</think>\n\nLet me look.",
                        "The query scans the whole table.",
                    ],
                    "tool_events": [
                        {
                            "round": 1,
                            "tool": "query_sql",
                            "command": "EXPLAIN SELECT 1",
                            "output": "Seq Scan",
                            "exit_code": 0,
                        }
                    ],
                    "rag_sources": [{"filename": "schema.md"}],
                },
            },
        ],
        artifacts=[{"name": "report.md", "size": 12}],
    )
    md = ticket_routes._transcript_markdown(_ticket(), attachment)
    assert "check the plan first" in md
    assert "EXPLAIN SELECT 1" in md
    assert "Seq Scan" in md
    assert "schema.md" in md
    assert "report.md" in md
    assert "### Round 1" in md


def test_markdown_export_marks_an_unfinished_turn():
    attachment = _attachment(
        [{"role": "assistant", "content": "Still w", "metadata": {}, "partial": True}]
    )
    md = ticket_routes._transcript_markdown(_ticket(), attachment)
    assert "Still being generated" in md
    assert "Still w" in md


def test_legacy_snapshots_still_export():
    """Format-1 rows predate reasoning/tool capture — they must not crash the
    export just because their metadata isn't there."""
    attachment = _attachment(
        [{"role": "assistant", "content": "old answer", "timestamp": "2025-01-01T00:00:00"}],
        version=1,
    )
    md = ticket_routes._transcript_markdown(_ticket(), attachment)
    assert "old answer" in md
    assert "2025-01-01T00:00:00" in md
