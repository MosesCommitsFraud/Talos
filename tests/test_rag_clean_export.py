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


def test_clean_export_rejoins_a_cut_paragraph_by_its_offsets():
    first = "## Kapitel\n\nErster Satz des Absatzes. "
    second = "Erster Satz des Absatzes. Zweiter Satz."
    meta = {"section_id": "s1"}
    out = clean_document_text(
        [
            {
                "content": first,
                "metadata": {**meta, "split_idx_start": 0, "source_end": len(first)},
            },
            {
                "content": second,
                "metadata": {
                    **meta,
                    "split_idx_start": len(first) - 26,
                    "source_end": len(first) + 13,
                },
            },
            {
                "content": "## Weiter\n\nRest.",
                "metadata": {"section_id": "s2", "split_idx_start": 0, "source_end": 16},
            },
        ]
    )
    assert out == ("## Kapitel\n\nErster Satz des Absatzes. Zweiter Satz.\n\n## Weiter\n\nRest.\n")


def test_clean_export_drops_a_repeated_table_header():
    header = "| A |\n| --- |\n"
    out = clean_document_text(
        [
            {
                "content": header + "| 1 |\n",
                "metadata": {"section_id": "s", "split_idx_start": 0, "source_end": 21},
            },
            {
                "content": header + "| 2 |\n",
                "metadata": {
                    "section_id": "s",
                    "split_idx_start": 21,
                    "source_end": 27,
                    "repeated_header_chars": len(header),
                },
            },
        ]
    )
    assert out == header + "| 1 |\n| 2 |\n"


def test_short_coincidental_match_is_not_treated_as_overlap():
    out = clean_document_text([{"content": "Ende mit A."}, {"content": "A. Neuer Satz."}])
    assert out == "Ende mit A.\n\nA. Neuer Satz.\n"
