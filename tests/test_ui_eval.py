"""Scoring of the interactive-answers eval (scripts/ui_eval.py)."""

import json
from pathlib import Path

from scripts import ui_eval

SQL = [{"kind": "sql", "label": "dbo.orders"}]


def _widget_output(tool, kind, sources=SQL, exit_code=0):
    widget = (
        {"type": "table", "data": {"sources": sources, "answer": True}}
        if kind == "table"
        else {"type": "ui", "data": {"declarative": kind, "sources": sources}}
        if tool == "render_widget"
        else {"type": "ui", "data": {"sources": sources}}
    )
    out = {"type": "tool_output", "tool": tool, "exit_code": exit_code}
    if exit_code == 0:
        out["widget"] = widget
    return out


def test_widget_with_expected_type_and_source_passes():
    entry = {"expect": "widget", "widget_types": ["kpi"], "data": ["sql"]}
    events = [
        {"type": "tool_start", "tool": "read_skill", "command": "read_skill: interactive-answers"},
        _widget_output("render_widget", "kpi"),
    ]
    r = ui_eval.score(entry, events)
    assert r["pass"] and r["chose"] == "widget" and r["types"] == ["kpi"]
    assert r["skills"] == ["interactive-answers"]


def test_retry_after_a_failed_call_still_builds_but_is_reported():
    entry = {"expect": "ui"}
    events = [_widget_output("render_ui", None, exit_code=1), _widget_output("render_ui", None)]
    r = ui_eval.score(entry, events)
    assert r["pass"] and r["failed_calls"] == 1


def test_view_where_text_was_right_fails():
    r = ui_eval.score({"expect": "text"}, [_widget_output("render_widget", "chart")])
    assert not r["pass"] and r["chose"] == "widget"


def test_illustrative_values_for_real_data_fail_sources():
    entry = {"expect": "widget", "data": ["sql"]}
    events = [
        _widget_output(
            "render_widget", "chart", sources=SQL + [{"kind": "illustrative", "label": "x"}]
        )
    ]
    r = ui_eval.score(entry, events)
    assert r["choice_ok"] and not r["sources_ok"] and not r["pass"]


def test_wrong_widget_type_fails():
    r = ui_eval.score(
        {"expect": "widget", "widget_types": ["diagram"]},
        [_widget_output("render_widget", "chart")],
    )
    assert not r["pass"]


def test_table_counts_as_table_type():
    r = ui_eval.score(
        {"expect": "view", "widget_types": ["table"], "data": ["sql"]},
        [_widget_output("render_widget", "table")],
    )
    assert r["pass"] and r["types"] == ["table"]


def test_sse_parsing_and_example_set_loads():
    events = ui_eval.parse_sse(
        ['data: {"type": "agent_step"}', "data: [DONE]", ": comment", "data: {bad"]
    )
    assert events == [{"type": "agent_step"}]
    entries = ui_eval.load_eval(
        str(Path(__file__).parents[1] / "scripts" / "ui_eval.example.jsonl")
    )
    assert len(entries) >= 30
    assert {e["expect"] for e in entries} == {"text", "widget", "ui", "view", "file"}
    assert len({e["id"] for e in entries}) == len(entries)
    json.dumps(entries)


def test_summary_leaves_not_applicable_prompts_out_of_the_rates():
    s = ui_eval.summarise(
        [
            {
                "status": "pass",
                "pass": True,
                "choice_ok": True,
                "sources_ok": True,
                "failed_calls": 0,
            },
            {
                "status": "fail",
                "pass": False,
                "choice_ok": True,
                "sources_ok": False,
                "failed_calls": 2,
            },
            {
                "status": "n/a",
                "pass": False,
                "choice_ok": False,
                "sources_ok": False,
                "failed_calls": 0,
            },
        ]
    )
    assert s == {
        "prompts": 3,
        "not_applicable": 1,
        "pass_rate": 0.5,
        "choice_rate": 1.0,
        "sources_rate": 0.5,
        "failed_calls": 2,
        "with_retry": 1,
    }


def _sql_listing(rows):
    return {
        "type": "tool_output",
        "tool": "query_sql",
        "exit_code": 0,
        "widget": {"type": "table", "data": {"rowCount": rows}},
    }


def test_missing_instance_data_is_not_applicable_not_a_failure():
    entry = {"expect": "widget", "widget_types": ["chart"], "data": ["sql"]}
    # No database here: the model looked, found nothing, answered in text.
    r = ui_eval.score(entry, [], setup_events=[_sql_listing(0)])
    assert r["status"] == "n/a" and r["missing_data"] == ["sql"]


def test_data_found_in_setup_makes_a_miss_a_real_failure():
    entry = {"expect": "widget", "widget_types": ["chart"], "data": ["sql"]}
    r = ui_eval.score(entry, [], setup_events=[_sql_listing(12)])
    assert r["status"] == "fail" and r["missing_data"] == []


def test_knowledge_availability_reads_the_tool_text():
    hit = {"type": "tool_output", "tool": "search_knowledge", "exit_code": 0, "output": "x" * 200}
    miss = {
        "type": "tool_output",
        "tool": "search_knowledge",
        "exit_code": 0,
        "output": 'No indexed document matched "x".',
    }
    assert ui_eval.available_kinds([hit]) == {"knowledge"}
    assert ui_eval.available_kinds([miss]) == set()


def test_user_and_model_data_never_make_a_prompt_not_applicable():
    r = ui_eval.score({"expect": "ui", "data": ["user"]}, [])
    assert r["status"] == "fail"


def test_example_set_needs_no_instance_specific_names():
    entries = ui_eval.load_eval(
        str(Path(__file__).parents[1] / "scripts" / "ui_eval.example.jsonl")
    )
    for e in entries:
        if set(e.get("data") or []) & {"sql", "knowledge"}:
            # Data from the instance is always found by the agent first.
            assert e.get("setup"), e["id"]
