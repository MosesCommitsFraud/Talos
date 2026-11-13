"""A deliverable the model built but did not hand over is shown anyway.

In the 2026-11-12 model test three runs wrote the spreadsheet or Word file the
user asked for and ended without present_files, so no card appeared."""

from src.agent_loop import _auto_present_files


def test_the_office_file_of_the_turn_is_shown():
    created = ["build_kostenstellen.py", "Kostenstellenuebersicht.xlsx"]
    assert _auto_present_files(created, []) == ["Kostenstellenuebersicht.xlsx"]


def test_nothing_is_added_when_the_model_presented_something():
    events = [{"tool": "present_files", "presented_files": ["output/a.xlsx"]}]
    assert _auto_present_files(["output/a.xlsx", "output/b.docx"], events) == []


def test_helper_files_and_copies_are_left_out():
    created = [
        "skills/xlsx/scripts/recalc.py",
        "skills/docx/templates/vorlage.docx",
        "_orig.xlsx",
        "_recalc/in.xlsx",
        "output/preview.pdf",
        "tmp_build.xlsx",
        ".talos-home/x.pdf",
        "chart.png",
        "data.csv",
    ]
    assert _auto_present_files(created, []) == []


def test_files_under_output_win_and_the_newest_per_format_is_taken():
    created = [
        "Urlaubsplaner_2027.xlsx",
        "output/Verfahrensanweisung_v1.docx",
        "output/Verfahrensanweisung_v2.docx",
        "output/dashboard.html",
    ]
    assert _auto_present_files(created, []) == [
        "output/Verfahrensanweisung_v2.docx",
        "output/dashboard.html",
    ]


def test_html_outside_output_and_generated_images_are_not_shown():
    assert _auto_present_files(["page.html", "generated-image:abc"], []) == []
