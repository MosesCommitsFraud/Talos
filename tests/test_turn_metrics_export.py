"""Turn metrics CSV export (src/turn_metrics_export.py)."""

import json

from src.turn_metrics_export import COLUMNS, build_rows, to_csv


def _assistant(**md):
    return {
        "role": "assistant",
        "content": "answer",
        "metadata": md,
        "timestamp": "2026-10-15T10:00:00",
    }


def _user(text):
    return {"role": "user", "content": text, "metadata": {}, "timestamp": "2026-10-15T09:59:58"}


def test_one_row_per_turn_and_a_total():
    messages = [
        _user("Wie viele Kunden gibt es?"),
        _assistant(
            time_to_first_token=1.5,
            response_time=12.0,
            output_tokens=300,
            input_tokens=9000,
            context_tokens=4000,
            tokens_per_second=25.0,
            tps_source="computed",
            model="qwen",
            tool_events=[
                {"round": 1, "tool": "query_sql", "command": "{}", "exit_code": 0},
                {"round": 2, "tool": "query_sql", "command": "{}", "exit_code": 1},
            ],
        ),
        _user("Und davon aktiv?"),
        _assistant(
            time_to_first_token=0.8,
            response_time=4.0,
            output_tokens=100,
            context_tokens=4500,
            tokens_per_second=50.0,
            tps_source="computed",
            model="qwen",
        ),
    ]
    rows = build_rows(messages, "chat1")
    assert [r["Turn"] for r in rows] == [1, 2, "Gesamt"]
    first, second, total = rows
    assert first["Runden"] == 3  # two tool rounds + the closing answer
    assert (first["Tool-Calls"], first["Fehlerhafte Tool-Calls"]) == (2, 1)
    assert first["Tools"] == "query_sql, query_sql"
    assert second["Runden"] == 1
    assert total["TTFT [s]"] == 1.5
    assert total["Antwortzeit [s]"] == 16.0
    assert total["Ausgabe-Tokens"] == 400
    assert total["Kontext-Tokens"] == 4500
    # Weighted by output tokens: (25*300 + 50*100) / 400
    assert total["Tokens/s"] == 31.25
    assert total["Runden"] == 4


def test_follow_up_messages_join_their_turn_and_hidden_ones_are_skipped():
    messages = [
        _user("Recherchiere X"),
        _assistant(response_time=5.0, output_tokens=50),
        {
            "role": "assistant",
            "content": "summary",
            "metadata": {"hidden": True, "response_time": 99},
        },
        _assistant(response_time=7.0, output_tokens=70),  # background follow-up
    ]
    rows = build_rows(messages, "c")
    assert len(rows) == 2
    assert rows[0]["Antwortzeit [s]"] == 12.0
    assert rows[0]["Ausgabe-Tokens"] == 120


def test_delegate_counts_its_tasks():
    tasks = {
        "tasks": [
            {"title": "a", "prompt": "x"},
            {"title": "b", "prompt": "y"},
            {"title": "c", "prompt": "z"},
        ]
    }
    messages = [
        _user("Vergleiche"),
        _assistant(
            response_time=30.0,
            tool_events=[
                {"round": 1, "tool": "delegate", "command": json.dumps(tasks), "exit_code": 0},
            ],
        ),
    ]
    assert build_rows(messages, "c")[0]["Sub-Agenten"] == 3


def test_unanswered_turn_is_left_out():
    assert build_rows([_user("Hallo")], "c") == []


def test_csv_for_german_excel_uses_semicolons_and_decimal_commas():
    rows = build_rows(
        [_user("q"), _assistant(time_to_first_token=1.25, response_time=2.5, output_tokens=10)], "c"
    )
    text = to_csv(rows)
    header, first = text.splitlines()[:2]
    assert header.split(";") == COLUMNS
    cells = first.split(";")
    assert cells[COLUMNS.index("TTFT [s]")] == "1,25"
    assert cells[COLUMNS.index("Antwortzeit [s]")] == "2,50"
    plain = to_csv(rows, excel_de=False)
    assert plain.splitlines()[1].split(",")[COLUMNS.index("TTFT [s]")] == "1.25"
