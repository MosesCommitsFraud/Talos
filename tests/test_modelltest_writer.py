"""The model test's results reach the workbook as values Excel accepts
(scripts/modelltest/write_results.py)."""

import openpyxl
import pytest

from scripts.modelltest import write_results as writer

LINES = "\n".join(
    [
        "SKL-05|1;18.11.2026;chat-b;0.11;2.15;185;12166;12166;85.93;computed;1;0;0;0;",
        "ALG-13|2;18.11.2026;chat-a;0.1;544.0;27133;894090;64004;49.82;computed;21;23;0;0;"
        "T1:rounds_exhausted",
        "ALG-01|1;18.11.2026;chat-c;0.83;2.99;194;12154;12154;64.92;computed;1;0;0;0",
    ]
)
GRADES = {
    "SKL-05|1": {"W": "ja", "X": 0, "AH": "=(B2-C2)/C2, Prozentformat."},
    "ALG-13|2": {"W": "teilweise", "AH": "Feiertage unvollständig."},
}


def _sheet(filled=0):
    sheet = openpyxl.Workbook().active
    sheet.title = writer.SHEET
    for row in range(writer.FIRST_ROW, writer.FIRST_ROW + filled):
        sheet.cell(row, 3).value = "K1"
        sheet.cell(row, 4).value = "ALG-01"
        sheet.cell(row, 6).value = row
    return sheet


def test_runs_go_below_the_filled_rows_allgemein_first():
    sheet = _sheet(filled=2)
    assert writer.append_runs(sheet, writer.parse_lines(LINES), GRADES, "K2", "Moritz") == (5, 7)
    assert [sheet.cell(r, 4).value for r in (5, 6, 7)] == ["ALG-01", "ALG-13", "SKL-05"]
    assert [sheet.cell(5, c).value for c in (2, 3, 6)] == ["Moritz", "K2", 1]
    assert sheet.cell(5, 1).value.strftime("%Y-%m-%d") == "2026-11-18"


def test_metrics_keep_their_kind():
    sheet = _sheet()
    writer.append_runs(sheet, writer.parse_lines(LINES), {}, "K2", "Moritz")
    values = [sheet.cell(4, c).value for c in range(7, 19)]
    assert values == ["chat-a", 0.1, 544.0, 27133, 894090, 64004, 49.82, "computed", 21, 23, 0, 0]
    assert isinstance(values[2], float) and isinstance(values[3], int)


def test_a_note_that_starts_with_an_equals_sign_stays_text():
    """Saved as a formula it made Excel report the workbook as damaged."""
    sheet = _sheet()
    writer.append_runs(sheet, writer.parse_lines(LINES), GRADES, "K2", "Moritz")
    note = sheet.cell(5, writer.GRADE_COLUMNS["AH"])
    assert note.value == "=(B2-C2)/C2, Prozentformat."
    assert note.data_type == "s"


def test_a_stop_reason_is_added_to_the_notes():
    sheet = _sheet()
    writer.append_runs(sheet, writer.parse_lines(LINES), GRADES, "K2", "Moritz")
    assert sheet.cell(4, 34).value == "Feiertage unvollständig. [Turn 1: Schrittlimit erreicht]"
    assert sheet.cell(4, 25).value == "n.a."  # RAG columns of a graded run
    assert sheet.cell(3, 34).value is None  # ungraded, ended normally


def test_what_changed_around_a_run_is_added_to_the_notes():
    setup = "Memory neu: #8 Monatsabschluss | seit Teststart: Skill ausgeschaltet: dashboard"
    lines = LINES.replace("T1:rounds_exhausted", "T1:rounds_exhausted;" + setup) + ";;" + setup
    sheet = _sheet()
    writer.append_runs(sheet, writer.parse_lines(lines), GRADES, "K2", "Moritz")
    # ALG-01 is ungraded and ended normally: the setup note stands alone.
    assert sheet.cell(3, 34).value == f"[Setup: {setup}]"
    assert sheet.cell(4, 34).value == (
        f"Feiertage unvollständig. [Turn 1: Schrittlimit erreicht] [Setup: {setup}]"
    )
    # A run nothing changed around keeps its notes as they were.
    assert sheet.cell(5, 34).value == "=(B2-C2)/C2, Prozentformat."


def test_runs_that_are_already_there_are_refused():
    sheet = _sheet()
    runs = writer.parse_lines(LINES)
    writer.append_runs(sheet, runs, GRADES, "K2", "Moritz")
    with pytest.raises(SystemExit, match="K2 already has 3"):
        writer.append_runs(sheet, runs, GRADES, "K2", "Moritz")
    assert writer.append_runs(sheet, runs, GRADES, "K4", "Moritz") == (6, 8)
