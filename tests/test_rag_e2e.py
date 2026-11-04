"""The scoring and reporting of the end-to-end eval; the turns themselves need a model."""

import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "rag_e2e", Path(__file__).resolve().parent.parent / "scripts" / "rag_e2e.py"
)
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)


def _sse(event):
    return "data: " + json.dumps(event) + "\n\n"


def test_every_must_has_to_match_and_no_forbid_may():
    entry = {"must": ["Strg", "M"], "forbid": [r"\d{5,}"]}
    assert e2e.is_correct(entry, "Über strg + m")
    assert not e2e.is_correct(entry, "Über Strg")
    assert not e2e.is_correct(entry, "Strg + M oder 123456")


def test_thinking_does_not_count_as_the_answer():
    entry = {"must": ["Strg"]}
    assert not e2e.is_correct(entry, "<think>Strg + M wäre es</think>Keine Ahnung")
    assert not e2e.is_correct({}, "<think>nur gedacht</think>")


def test_events_give_answer_tools_rounds_and_metrics():
    parsed = e2e.parse_events(
        [
            _sse({"type": "tool_start", "tool": "search_knowledge", "command": '{"query": "x"}'}),
            _sse({"type": "agent_step", "round": 2}),
            _sse({"delta": "Ant"}),
            _sse({"delta": "wort"}),
            _sse({"type": "metrics", "data": {"input_tokens": 7}}),
            "data: [DONE]\n\n",
            "data: not json\n\n",
        ]
    )
    assert parsed["answer"] == "Antwort"
    assert parsed["rounds"] == 2
    assert parsed["tools"][0]["tool"] == "search_knowledge"
    assert parsed["metrics"] == {"input_tokens": 7}


def test_row_and_summary_count_what_the_turn_cost():
    parsed = {
        "answer": "Strg + M",
        "rounds": 3,
        "tools": [{"tool": "search_knowledge"}, {"tool": "web_fetch"}],
        "metrics": {"input_tokens": 100, "output_tokens": 10, "round_profile": [{"tools_s": 2.5}]},
    }
    row = e2e.row_for({"q": "F", "kind": "fakt", "must": ["Strg"]}, parsed, 4.0)
    assert (row["ok"], row["tool_calls"], row["knowledge_calls"]) == (True, 2, 1)
    assert row["tool_seconds"] == 2.5

    bad = e2e.row_for({"q": "G", "kind": "fehlt", "must": ["x"]}, {"answer": "y"}, 2.0, "boom")
    summary = e2e.summarize([row, bad])
    assert summary["correct"] == 1
    assert summary["errors"] == 1
    assert summary["kinds"] == {"fakt": "1/1", "fehlt": "0/1"}
    assert summary["max_rounds"] == 3
    assert summary["mean_seconds"] == 3.0


def test_compare_shows_the_change():
    lines = e2e.compare({"correct": 30, "mean_rounds": 2.0}, {"correct": 33, "mean_rounds": 1.0})
    text = "\n".join(lines)
    assert "+10%" in text
    assert "-50%" in text


def test_eval_file_skips_comments_and_blanks(tmp_path):
    path = tmp_path / "e.jsonl"
    path.write_text('# Kommentar\n\n{"q": "F"}\n', encoding="utf-8")
    assert e2e.load_eval(str(path)) == [{"q": "F"}]
