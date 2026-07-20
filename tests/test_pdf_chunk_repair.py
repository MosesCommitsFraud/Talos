"""Regression coverage for defensive PDF chunk repair and figure fallback."""

import importlib

rv = importlib.import_module("src.rag_vector")


class _Doc:
    def __init__(self, content, meta=None):
        self.content = content
        self.meta = meta or {}


def test_collapsed_pdf_chunk_is_replaced_by_page_chunks(monkeypatch):
    monkeypatch.setenv("RAG_MAX_CHUNK_CHARS", "1000")
    monkeypatch.setattr(
        rv,
        "_pdf_text_pages",
        lambda _path: [(1, "alpha " * 100), (2, "beta " * 100)],
    )
    original = _Doc("whole document " * 100, {"dl_meta": {"headings": ["Deck"]}})

    docs = rv._repair_oversized_pdf_chunks("deck.pdf", [original])

    assert len(docs) == 2
    assert [d.meta["page"] for d in docs] == [1, 2]
    assert all(d.meta["modality"] == "pdf_page" for d in docs)
    assert all(d.meta["extraction"] == "pdf_text_fallback" for d in docs)
    assert all(len(d.content) <= 1000 for d in docs)


def test_pdf_repair_leaves_good_chunks_untouched(monkeypatch):
    monkeypatch.setenv("RAG_MAX_CHUNK_CHARS", "1000")
    monkeypatch.setattr(
        rv, "_pdf_text_pages", lambda _path: (_ for _ in ()).throw(AssertionError())
    )
    docs = [_Doc("small chunk"), _Doc("another small chunk")]

    assert rv._repair_oversized_pdf_chunks("deck.pdf", docs) is docs


def test_oversized_office_chunk_is_split_without_losing_metadata(monkeypatch):
    monkeypatch.setenv("RAG_MAX_CHUNK_CHARS", "1000")
    original = _Doc("alpha beta gamma\n" * 200, {"dl_meta": {"headings": ["Report"]}})

    docs = rv._split_oversized_chunks([original])

    assert len(docs) > 1
    assert all(len(d.content) <= 1000 for d in docs)
    assert all(d.meta["dl_meta"]["headings"] == ["Report"] for d in docs)
    assert [d.meta["chunk_part"] for d in docs] == list(range(1, len(docs) + 1))


def test_embedding_retrieval_text_includes_filename():
    text = rv._embed_text({"filename": "Quarterly Falcon Report.docx"}, "Revenue increased.")

    assert text.startswith("Document: Quarterly Falcon Report.docx")
    assert text.endswith("Revenue increased.")


def test_figure_locator_inherits_searchable_page_text():
    page = _Doc(
        "Gruppierung: Neue Gruppierung, Sortierung, Löschen und Verschieben.",
        {"modality": "pdf_page", "page": 24},
    )
    figure = _Doc(
        "Figure from training.pdf (page 24)",
        {
            "modality": "figure",
            "page": 24,
            "caption_source": "locator",
            "image_caption": "Figure from training.pdf (page 24)",
        },
    )

    rv._enrich_uncaptioned_figures([page, figure])

    assert "Gruppierung" in figure.content
    assert figure.meta["caption_source"] == "page_text_fallback"
    assert figure.meta["image_caption"] == figure.content


def test_real_caption_is_not_overwritten():
    page = _Doc("page body", {"modality": "pdf_page", "page": 1})
    figure = _Doc(
        "A screenshot of the report editor.",
        {"modality": "figure", "page": 1, "caption_source": "vlm"},
    )

    rv._enrich_uncaptioned_figures([page, figure])

    assert figure.content == "A screenshot of the report editor."
    assert figure.meta["caption_source"] == "vlm"


def test_pdf_visual_line_wraps_are_reflowed():
    raw = (
        "macs Report Editor\n"
        "1. Editor\n"
        "-Bereich\n"
        "Im Editor wird der Bericht\n"
        "mit all seinen Elementen\n"
        "definiert.\n"
        "2. Datenquelle"
    )

    text = rv._reflow_pdf_text(raw)

    assert "Editor-Bereich" in text
    assert "Bericht mit all seinen Elementen definiert." in text
    assert "\n\n2. Datenquelle" in text


def test_page_retrieval_context_includes_its_figure_caption_only():
    page = _Doc("Elementband", {"modality": "pdf_page", "page": 28})
    figure = _Doc(
        "Die vertikale Toolbar enthält fünf Symbole mit unterschiedlichen Funktionen.",
        {"modality": "figure", "page": 28, "caption_source": "vlm"},
    )
    other = _Doc(
        "DrillDownControl",
        {"modality": "figure", "page": 27, "caption_source": "vlm"},
    )

    rv._attach_pdf_visual_context([page, figure, other])

    assert "vertikale Toolbar" in page.meta["_visual_context"]
    assert "DrillDownControl" not in page.meta["_visual_context"]


def test_page_text_fallback_is_not_duplicated_as_visual_context():
    page = _Doc("Elementband", {"modality": "pdf_page", "page": 28})
    fallback = _Doc(
        "Elementband",
        {
            "modality": "figure",
            "page": 28,
            "caption_source": "page_text_fallback",
        },
    )

    rv._attach_pdf_visual_context([page, fallback])

    assert "_visual_context" not in page.meta


def test_office_image_caption_is_attached_to_text_retrieval_context():
    text = _Doc("Main report text")
    figure = _Doc(
        "A blue pump connected to a pressure gauge.",
        {"modality": "figure", "document_figure": True},
    )

    rv._attach_office_visual_context([text, figure])

    assert "pressure gauge" in text.meta["_visual_context"]
