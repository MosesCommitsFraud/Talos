"""Server backstop that puts "[n]" behind lines drawn from knowledge sources."""

from routes.chat_helpers import apply_line_patches, attribute_rag_citations

BAND = {
    "n": 2,
    "filename": "macs_Report_Editor.pdf",
    "_text": "Ein neues Band wird im Report Editor über Neu und Band einfügen angelegt. "
    "Die Bandhöhe wird anschließend im Eigenschaftsfenster des Bandes eingestellt.",
}
DATASET = {
    "n": 3,
    "filename": "macs_Datasets.pdf",
    "_text": "Ein freies Dataset verbindet eine eigene SQL Abfrage mit dem Bericht. "
    "Die Felder des Datasets erscheinen danach in der Feldliste.",
}


def test_uncited_answer_gets_markers_per_line():
    answer = (
        "So gehst du vor:\n\n"
        "1. Im Report Editor über Neu und Band einfügen ein neues Band anlegen.\n"
        "2. Die Bandhöhe wird anschließend im Eigenschaftsfenster des Bandes eingestellt.\n"
        "3. Ein freies Dataset mit eigener SQL Abfrage verbindet Daten mit dem Bericht.\n\n"
        "```sql\nSELECT * FROM Report Editor Band einfügen Eigenschaftsfenster\n```"
    )
    patches = attribute_rag_citations(answer, [BAND, DATASET])
    out = apply_line_patches(answer, patches)
    assert "ein neues Band anlegen. [2]" in out
    assert "des Bandes eingestellt. [2]" in out
    assert "mit dem Bericht. [3]" in out
    assert "So gehst du vor: [" not in out
    assert "Eigenschaftsfenster\n```" in out  # code untouched


def test_answer_that_already_cites_is_left_alone():
    answer = "Im Report Editor über Neu und Band einfügen ein neues Band anlegen [2]."
    assert attribute_rag_citations(answer, [BAND]) == []


def test_unrelated_lines_and_figures_get_nothing():
    answer = "Das Wetter in Berlin ist heute sonnig und angenehm warm für die Jahreszeit."
    figure = {**BAND, "n": 4, "image_url": "/api/personal/rag-asset?source=x"}
    assert attribute_rag_citations(answer, [BAND, figure]) == []


def test_patches_apply_to_the_last_occurrence():
    text = "Zeile A\nZeile A"
    assert apply_line_patches(text, [("Zeile A", "Zeile A [1]")]) == "Zeile A\nZeile A [1]"
