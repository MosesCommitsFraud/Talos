"""The explorer's text download: the document's own text, no ingest annotations."""

from routes.rag_routes import clean_document_text


def test_clean_export_drops_annotations_figures_and_overlap():
    chunks = [
        {
            "content": "Kapitel 1\n\nDer Report Editor legt Bänder an. Ein Band hat eine Höhe.",
            "context": "Dieser Abschnitt erklärt Bänder.",
            "aux_terms": "Band, Höhe",
            "modality": "",
        },
        {"content": "VLM: Screenshot des Eigenschaftsfensters", "modality": "figure"},
        {
            "content": "Ein Band hat eine Höhe. Sie wird im Eigenschaftsfenster geändert.",
            "modality": "",
        },
    ]
    out = clean_document_text(chunks)
    assert out == (
        "Kapitel 1\n\nDer Report Editor legt Bänder an. Ein Band hat eine Höhe.\n\n"
        "Sie wird im Eigenschaftsfenster geändert.\n"
    )
    for noise in ("Dieser Abschnitt", "Band, Höhe", "VLM", "chunk #", "Ingest dump"):
        assert noise not in out


def test_short_coincidental_match_is_not_treated_as_overlap():
    out = clean_document_text([{"content": "Ende mit A."}, {"content": "A. Neuer Satz."}])
    assert out == "Ende mit A.\n\nA. Neuer Satz.\n"
