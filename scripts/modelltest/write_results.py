"""Append the runs of one model test to the sheet "Ergebnisse" of the test workbook.

    python write_results.py <workbook.xlsx> <lines.txt> <grades.json> <Konfig-ID> <Tester>

lines.txt is what `MT.exportLines()` of harness.js returns: one line per run,
`key;date;chat id;<the eleven figures of the "Gesamt" row>;stop reasons`.
grades.json maps a key ("ALG-01|1") to the hand-graded columns, by column
letter: U V W X Y Z AA AB AC AD AG AH. A run without grades gets its metrics only.

The workbook is changed in place, so close it in Excel first and keep a copy.
Needs openpyxl (not a Talos dependency): use a throwaway venv.
"""

import datetime
import json
import sys

import openpyxl

SHEET = "Ergebnisse"
FIRST_ROW = 3
# Column numbers: A date, B tester, C config, D question, F run, G..R the metrics.
GRADE_COLUMNS = {
    "U": 21,
    "V": 22,
    "W": 23,
    "X": 24,
    "Y": 25,
    "Z": 26,
    "AA": 27,
    "AB": 28,
    "AC": 29,
    "AD": 30,
    "AG": 33,
    "AH": 34,
}
NOTES = "AH"
# Left as text: the chat id and tps_source. TTFT, time and tokens/s stay decimals.
TEXT_FIELDS = (0, 7)
DECIMAL_FIELDS = (1, 2, 6)
STOP_NOTES = {
    "rounds_exhausted": "Schrittlimit erreicht",
    "output_truncated": "Antwort am Längenlimit abgeschnitten",
    "agent_stalled": "ohne Ausgabe stehen geblieben",
    "budget_exceeded": "Tool-Budget erreicht",
}


def parse_lines(text):
    """{key: (date, [12 metric fields], [stop notes])} from exportLines output."""
    runs = {}
    for line in text.splitlines():
        parts = line.strip().split(";")
        if len(parts) < 14:
            continue
        stops = parts[14].split(",") if len(parts) > 14 and parts[14] else []
        runs[parts[0]] = (parts[1], parts[2:14], stops)
    return runs


def stop_note(stops):
    """Turn "T1:rounds_exhausted" into "Turn 1: Schrittlimit erreicht"."""
    notes = []
    for stop in stops:
        turn, _, reason = stop.partition(":")
        notes.append(f"Turn {turn.lstrip('T')}: {STOP_NOTES.get(reason, reason)}")
    return "; ".join(notes)


def order(key):
    """Allgemein first, then by question and run, as the sheet is read."""
    question, run = key.split("|")
    return (not question.startswith("ALG"), question, int(run))


def set_text(cell, value):
    """Write a value; text that starts with "=" must not become a formula.

    A note such as "=(B2-C2)/C2 und …" was saved as a formula and Excel then
    reported the workbook as damaged.
    """
    cell.value = value
    if isinstance(value, str) and value.startswith("="):
        cell.data_type = "s"


def append_runs(sheet, runs, grades, config, tester):
    """Write the runs below the last filled row and return the rows used."""
    filled = [r for r in range(FIRST_ROW, sheet.max_row + 1) if sheet.cell(r, 4).value]
    present = {
        (sheet.cell(r, 3).value, sheet.cell(r, 4).value, sheet.cell(r, 6).value) for r in filled
    }
    doubles = [k for k in runs if (config, k.split("|")[0], int(k.split("|")[1])) in present]
    if doubles:
        raise SystemExit(f"{config} already has {len(doubles)} of these runs, e.g. {doubles[0]}")
    row = first = (max(filled) + 1) if filled else FIRST_ROW
    for key in sorted(runs, key=order):
        question, run = key.split("|")
        date, fields, stops = runs[key]
        cell = sheet.cell(row, 1)
        cell.value = datetime.datetime.strptime(date, "%d.%m.%Y")
        cell.number_format = "DD.MM.YYYY"
        sheet.cell(row, 2).value = tester
        sheet.cell(row, 3).value = config
        sheet.cell(row, 4).value = question
        sheet.cell(row, 6).value = int(run)
        for i, value in enumerate(fields):
            if i in TEXT_FIELDS:
                sheet.cell(row, 7 + i).value = value
                continue
            number = float(value)
            whole = number.is_integer() and i not in DECIMAL_FIELDS
            sheet.cell(row, 7 + i).value = int(number) if whole else number
        grade = dict(grades.get(key, {}))
        if grade:
            grade = {"Y": "n.a.", "Z": "n.a.", **grade}
        if stops:
            grade[NOTES] = " ".join(x for x in (grade.get(NOTES), f"[{stop_note(stops)}]") if x)
        for letter, column in GRADE_COLUMNS.items():
            if letter in grade:
                set_text(sheet.cell(row, column), grade[letter])
        row += 1
    return first, row - 1


def main(argv):
    if len(argv) != 6:
        raise SystemExit(__doc__)
    path, lines_file, grades_file, config, tester = argv[1:]
    with open(lines_file, encoding="utf-8") as f:
        runs = parse_lines(f.read())
    with open(grades_file, encoding="utf-8") as f:
        grades = json.load(f)
    unknown = sorted(set(grades) - set(runs))
    if unknown:
        raise SystemExit(f"grades for runs that are not in the lines: {unknown[:5]}")
    workbook = openpyxl.load_workbook(path)
    first, last = append_runs(workbook[SHEET], runs, grades, config, tester)
    workbook.save(path)
    print(f"{len(runs)} runs in rows {first} to {last}, {len(runs) - len(grades)} without grades")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv)
