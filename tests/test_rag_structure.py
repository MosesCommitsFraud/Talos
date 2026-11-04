"""Real Haystack/Docling-core tests; no model downloads or external services."""

from copy import deepcopy

from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_structure import (
    assign_sections,
    docling_documents,
    expand_context,
    page_list,
    split_documents,
)
from src.rag_vector import VectorRAG, _embed_text, _redact_docs


def chunks(text, **kwargs):
    kwargs.setdefault("max_chars", 4000)
    docs = split_documents(
        [Document(content=text, meta={"source": "manual.md", "owner": "alice"})], **kwargs
    )
    assign_sections(docs)
    return docs


def hit(doc):
    return {"id": doc.id, "document": doc.content, "metadata": deepcopy(doc.meta)}


def store_for(docs):
    store = InMemoryDocumentStore()
    store.write_documents(docs)
    return store


def test_default_limit_keeps_a_typical_chapter_whole():
    from routes.rag_routes import RagPipelineConfig
    from src.rag_structure import DEFAULT_CHUNK_MAX_CHARS

    assert DEFAULT_CHUNK_MAX_CHARS == 6000
    assert RagPipelineConfig().chunk_max_chars == 6000
    text = "## Kapitel\n\n" + "\n\n".join("Ein Satz im Absatz. " * 20 for _ in range(14))
    assert 4000 < len(text) < 6000
    assert len(split_documents([Document(content=text)])) == 1
    assert len(split_documents([Document(content=text + text)])) == 2


def test_default_context_budget_holds_three_full_chunks():
    from routes.rag_routes import RagPipelineConfig, _clamp_chars
    from src.rag_structure import DEFAULT_CHUNK_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS

    assert DEFAULT_CONTEXT_MAX_CHARS == 18000
    assert RagPipelineConfig().max_context_chars == 18000
    assert _clamp_chars("kaputt") == 18000
    assert DEFAULT_CONTEXT_MAX_CHARS >= 3 * DEFAULT_CHUNK_MAX_CHARS


def test_long_chapter_preserves_middle_and_both_neighbors():
    docs = chunks("# Chapter\n\n" + "abcde " * 1600)
    assert len(docs) == 3
    assert len({d.meta["section_id"] for d in docs}) == 1
    result = expand_context(store_for(docs), [hit(docs[1])])[0]
    assert docs[1].content in result["expanded"]
    assert result["expanded"] == "# Chapter\n\n" + "abcde " * 1600
    assert [s["id"] for s in result["expanded_sources"]] == [d.id for d in docs]
    assert len(result["expanded"]) <= 12000


def test_small_budget_keeps_anchor_and_never_replaces_it_with_chapter_start():
    docs = chunks("# Chapter\n\n" + "abcde " * 1600)
    result = expand_context(store_for(docs), [hit(docs[1])], max_chars=2000)[0]
    assert "expanded" not in result
    assert result["document"] == docs[1].content


def test_duplicate_titles_and_code_fences_are_not_false_relationships():
    docs = chunks("# Setup\n\nFirst.\n\n```python\n# not a chapter\n```\n\n# Setup\n\nSecond.")
    assert len(docs) == 2
    assert docs[0].meta["section_id"] != docs[1].meta["section_id"]
    assert "# not a chapter" in docs[0].content
    assert docs[0].meta["heading_path"] == ["Setup"]


def test_setext_and_nested_heading_parent_relationships():
    docs = chunks("Manual\n======\n\nIntro.\n\n## Setup\n\nInstall.\n\n### Linux\n\nCommands.")
    assert [d.meta["heading_path"] for d in docs] == [
        ["Manual"],
        ["Manual", "Setup"],
        ["Manual", "Setup", "Linux"],
    ]
    assert docs[1].meta["parent_section_id"] == docs[0].meta["section_id"]
    assert docs[2].meta["parent_section_id"] == docs[1].meta["section_id"]


def test_long_unbroken_unicode_is_bounded_and_lossless():
    text = "ä🙂" * 5500
    docs = chunks(text)
    reconstructed = docs[0].content + "".join(d.content[200:] for d in docs[1:])
    assert reconstructed == text
    assert all(len(d.content) <= 4000 for d in docs)


def test_window_respects_authorization_and_document_version():
    docs = chunks("# Chapter\n\n" + "abcde " * 1600)
    alien = deepcopy(docs[0])
    alien.id = "alien"
    alien.content = "OWNER SECRET"
    alien.meta["owner"] = "bob"
    old = deepcopy(docs[0])
    old.id = "old-version"
    old.content = "STALE SECRET"
    old.meta["document_version"] = "old"
    store = store_for(docs + [alien, old])
    result = expand_context(
        store, [hit(docs[1])], filters={"field": "meta.owner", "operator": "==", "value": "alice"}
    )[0]
    assert "SECRET" not in result["expanded"]


def test_docling_json_retains_real_heading_hierarchy_and_repeated_titles():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    native = DoclingDocument(name="manual")
    native.add_heading(text="Manual", level=1)
    native.add_text(label=DocItemLabel.TEXT, text="Intro.")
    native.add_heading(text="Setup", level=2)
    native.add_text(label=DocItemLabel.TEXT, text="abcde " * 1600)
    native.add_heading(text="Setup", level=2)
    native.add_text(label=DocItemLabel.TEXT, text="Other setup.")
    docs = split_documents(docling_documents(native.model_dump_json()), max_chars=4000)
    assign_sections(docs)
    assert docs[0].meta["heading_path"] == ["Manual"]
    assert docs[1].meta["heading_path"] == ["Manual", "Setup"]
    assert docs[1].meta["section_id"] == docs[2].meta["section_id"]
    assert docs[-1].meta["section_id"] != docs[1].meta["section_id"]
    assert all(len(d.content) <= 4000 for d in docs)


def test_md_productive_router_does_not_call_docling(tmp_path, monkeypatch):
    path = tmp_path / "manual.md"
    path.write_text("# Setup\n\n" + "hello " * 1200, encoding="utf-8")
    rag = object.__new__(VectorRAG)
    rag._cfg = {"chunk_max_chars": 3000, "chunk_overlap_chars": 100}
    monkeypatch.setattr(
        rag, "_lane_docling", lambda _: (_ for _ in ()).throw(AssertionError("Docling called"))
    )
    monkeypatch.setattr(rag, "_apply_contextual", lambda _: None)
    monkeypatch.setattr(rag, "_apply_autokeywords", lambda _: None)
    docs = rag._documents_for_file(str(path), {"source": str(path)})
    assert len(docs) == 3
    assert all(len(d.content) <= 3000 for d in docs)
    assert all(d.meta["chunk_count"] == 3 for d in docs)


def test_redaction_also_cleans_heading_and_original_docling_text():
    doc = Document(
        content="body",
        meta={
            "heading_path": ["bob@example.com"],
            "dl_meta": {"doc_items": [{"orig": "bob@example.com"}]},
        },
    )
    _redact_docs([doc], True)
    assert "bob@example.com" not in _embed_text(doc.meta, doc.content)
    assert doc.meta["dl_meta"]["doc_items"][0]["orig"] == "[email]"


def test_section_runs_across_a_page_break_and_records_both_pages():
    raw = [
        Document(
            content=text,
            meta={
                "source": "x.pdf",
                "page": page,
                "section_ordinal": 1,
                "section_path": [1],
                "heading_path": ["Chapter"],
            },
        )
        for page, text in [(1, "First page."), (2, "Second page.")]
    ]
    docs = split_documents(raw)
    assign_sections(docs)
    assert [d.content for d in docs] == ["First page.\n\nSecond page."]
    assert docs[0].meta["page"] == 1
    assert docs[0].meta["pages"] == [1, 2]


def test_long_section_chunks_name_only_the_pages_of_their_own_text():
    raw = [
        Document(
            content="Satz auf dieser Seite. " * 120,
            meta={
                "page": page,
                "section_ordinal": 1,
                "section_path": [1],
                "heading_path": ["Chapter"],
            },
        )
        for page in (1, 2, 3)
    ]
    docs = split_documents(raw)
    assert docs[0].meta["page"] == 1
    assert docs[-1].meta["page"] > 1
    assert 3 in page_list(docs[-1].meta) and 1 not in page_list(docs[-1].meta)


def test_sentence_torn_by_a_page_break_is_one_paragraph_again():
    section = {"section_ordinal": 1, "section_path": [1], "heading_path": ["Kapitel"]}
    raw = [
        Document(content="Der Satz geht über die", meta={**section, "page": 1, "pages": [1]}),
        Document(content="Seitengrenze hinaus.", meta={**section, "page": 2, "pages": [2]}),
        Document(content="endet hier", meta={**section, "page": 2, "pages": [2]}),
        Document(content="Neuer Absatz auf Seite 3.", meta={**section, "page": 3, "pages": [3]}),
    ]
    docs = split_documents(raw)
    assert docs[0].content == (
        "Der Satz geht über die\n\nSeitengrenze hinaus.\n\nendet hier\n\nNeuer Absatz auf Seite 3."
    )
    raw[1].content = "seitengrenze hinaus."
    raw[2].content = "kein Riss auf derselben Seite."
    docs = split_documents(raw)
    assert docs[0].content == (
        "Der Satz geht über die seitengrenze hinaus.\n\n"
        "kein Riss auf derselben Seite.\n\nNeuer Absatz auf Seite 3."
    )
    assert docs[0].meta["pages"] == [1, 2, 3]


def test_tear_needs_page_provenance_so_word_paragraphs_stay_as_written():
    section = {"section_ordinal": 1, "section_path": [1], "heading_path": ["Kapitel"]}
    same_page = [
        Document(content="Umsatz, Menge,", meta={**section, "page": 4, "pages": [4]}),
        Document(content="jeweils mit Nummer.", meta={**section, "page": 4, "pages": [4]}),
    ]
    assert split_documents(same_page)[0].content == "Umsatz, Menge, jeweils mit Nummer."
    word = [
        Document(content="Umsatz, Menge,", meta=dict(section)),
        Document(content="jeweils mit Nummer.", meta=dict(section)),
    ]
    assert split_documents(word)[0].content == "Umsatz, Menge,\n\njeweils mit Nummer."


def test_chapter_title_without_text_opens_its_first_subchapter():
    docs = chunks(
        "# Teil 1\n\nIntro.\n\n# Teil 2\n\n## Kapitel A\n\nText A.\n\n## Kapitel B\n\nText B."
    )
    assert [d.content.strip() for d in docs] == [
        "# Teil 1\n\nIntro.",
        "# Teil 2\n\n## Kapitel A\n\nText A.",
        "## Kapitel B\n\nText B.",
    ]
    assert docs[1].meta["heading_path"] == ["Teil 2", "Kapitel A"]


def test_docling_chapter_title_folds_the_same_way():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    native = DoclingDocument(name="manual")
    native.add_heading(text="Teil 2", level=1)
    native.add_heading(text="Kapitel A", level=2)
    native.add_text(label=DocItemLabel.TEXT, text="Text A.")
    docs = split_documents(docling_documents(native.model_dump_json()))
    assert [d.content for d in docs] == ["# Teil 2\n\n## Kapitel A\n\nText A."]
    assert docs[0].meta["heading_path"] == ["Teil 2", "Kapitel A"]


def test_lone_heading_at_the_end_is_kept():
    docs = chunks("# Teil 1\n\nIntro.\n\n# Anhang\n")
    assert [d.content.strip() for d in docs] == ["# Teil 1\n\nIntro.", "# Anhang"]


def test_heading_directly_above_a_table_stays_on_the_table():
    table = "| A | B |\n| --- | --- |\n" + "| 1 | 2 |\n" * 900
    docs = chunks("## Kosten\n\n" + table)
    assert docs[0].content.startswith("## Kosten\n\n| A | B |")
    assert all(d.meta["block_type"] == "table" for d in docs)
    assert all(d.content.split("\n")[0] == "| A | B |" for d in docs[1:])
    assert all(len(d.content) <= 4000 for d in docs)
    result = expand_context(store_for(docs), [hit(docs[1])], max_chars=20000, window=5)[0]
    assert result["expanded"] == "## Kosten\n\n" + table


def test_yaml_front_matter_is_text_of_the_first_section_and_no_heading():
    head = "---\ndoc_id: macs-00\ntitel: Glossar\nschlagworte: [a, b]\n---\n\n"
    docs = chunks(head + "# Titel\n\nIntro.\n\n## Eins\n\nText.")
    assert [d.content.strip() for d in docs] == [head + "# Titel\n\nIntro.", "## Eins\n\nText."]
    assert docs[0].meta["heading_path"] == ["Titel"]
    assert docs[1].meta["heading_path"] == ["Titel", "Eins"]


def test_front_matter_followed_by_text_opens_no_chapter():
    head = "---\r\ndoc_id: x\r\n---\r\n"
    docs = chunks(head + "Vorwort.\r\n\r\n# Titel\r\n\r\nText.")
    assert docs[0].content.strip() == (head + "Vorwort.").strip()
    assert docs[0].meta["heading_path"] == []
    assert docs[1].meta["heading_path"] == ["Titel"]


def test_rule_above_ordinary_setext_text_is_no_front_matter():
    docs = chunks("---\nEin ganz normaler Satz ohne Schluessel\n---\n\nText.")
    assert docs[-1].meta["heading_path"] == ["Ein ganz normaler Satz ohne Schluessel"]


def test_rules_never_become_chunks_or_chunk_tails():
    docs = chunks(
        "---\n\n# Titel\n\nIntro.\n\n---\n\n## Eins\n\n| A |\n|---|\n| 1 |\n\n***\n\n"
        "## Zwei\n\nText.\n\n- - -\n\n## Drei\n\nEnde.\n"
    )
    assert [d.content.strip() for d in docs] == [
        "# Titel\n\nIntro.",
        "## Eins\n\n| A |\n|---|\n| 1 |",
        "## Zwei\n\nText.",
        "## Drei\n\nEnde.",
    ]


def test_title_and_rule_still_open_the_chapter_below():
    docs = chunks("# Teil 2\n\n---\n\n## Kapitel\n\nText.")
    assert len(docs) == 1
    assert docs[0].meta["heading_path"] == ["Teil 2", "Kapitel"]


def test_short_text_around_a_table_rides_with_it():
    table = "| A | B |\n|---|---|\n| 1 | 2 |\n"
    text = (
        f"## Kosten\n\nEs gilt:\n\n{table}\n**Regel:** Kosten sind netto.\n\n---\n\n## Rest\n\nX."
    )
    docs = chunks(text)
    assert docs[0].content == f"## Kosten\n\nEs gilt:\n\n{table}\n**Regel:** Kosten sind netto."
    assert docs[0].meta["block_type"] == "table"
    assert docs[1].content == "## Rest\n\nX."
    assert docs[0].meta["source_end"] - docs[0].meta["split_idx_start"] == len(docs[0].content)


def test_long_prose_around_a_table_keeps_its_own_vector():
    prose = "Das ist ein Satz. " * 40
    table = "| A |\n|---|\n| 1 |\n"
    docs = chunks(f"## Kosten\n\n{prose}\n\n{table}\n{prose}")
    assert [d.meta.get("block_type") for d in docs] == [None, "table", None]
    assert docs[1].content == table


def test_note_goes_on_the_last_part_of_a_long_table_and_comes_back_once():
    table = "| A | B |\n| --- | --- |\n" + "| 1 | 2 |\n" * 900
    text = "## Kosten\n\n" + table + "\nGilt netto.\n"
    docs = chunks(text)
    assert docs[-1].meta["block_type"] == "table"
    assert docs[-1].content.endswith("| 1 | 2 |\n\nGilt netto.\n")
    assert all(len(d.content) <= 4000 for d in docs)
    result = expand_context(store_for(docs), [hit(docs[1])], max_chars=20000, window=5)[0]
    assert result["expanded"] == text


def test_short_text_between_two_tables_introduces_the_second():
    one = "| A |\n|---|\n| 1 |\n"
    two = "| B |\n|---|\n| 2 |\n"
    docs = chunks(f"## Kosten\n\n{one}\nUnd weiter:\n\n{two}")
    assert [d.content for d in docs] == [f"## Kosten\n\n{one}", f"\nUnd weiter:\n\n{two}"]


def test_literal_text_keeps_its_rules():
    docs = split_documents([Document(content="---\n", meta={"literal_text": True})])
    assert [d.content for d in docs] == ["---\n"]


def test_long_section_is_cut_between_paragraphs_without_a_stray_tail():
    paragraphs = [f"Absatz {i}: " + "Das ist ein Satz. " * 40 for i in range(6)]
    text = "## Kapitel\n\n" + "\n\n".join(paragraphs)
    assert 4000 < len(text) < 7600  # Just over the limit, two parts are enough.
    docs = chunks(text)
    assert len(docs) == 2
    sizes = [len(d.content) for d in docs]
    assert min(sizes) > max(sizes) * 0.6
    assert docs[1].content.startswith("Absatz ")
    assert docs[0].content + docs[1].content == text  # Paragraph cut: no overlap needed.


def test_paragraph_longer_than_a_chunk_is_cut_at_sentences_with_whole_overlap():
    sentences = [f"Satz nummer {i} beschreibt die Sache z. B. genauer." for i in range(300)]
    docs = chunks("## Kapitel\n\n" + " ".join(sentences))
    assert len(docs) > 1
    assert all(len(d.content) <= 4000 for d in docs)
    for doc in docs[1:]:
        assert doc.content.startswith("Satz nummer ")
    for prev, doc in zip(docs, docs[1:]):
        shared = prev.meta["source_end"] - doc.meta["split_idx_start"]
        assert 0 < shared <= 200
        assert prev.content.endswith(doc.content[:shared])
    result = expand_context(store_for(docs), [hit(docs[1])], max_chars=40000, window=20)[0]
    assert result["expanded"] == "## Kapitel\n\n" + " ".join(sentences)


def test_abbreviations_and_ordinals_do_not_end_sentences():
    from src.rag_structure import _sentence_starts

    text = "Das gilt z. B. hier und Nr. 5 dort. Danach kommt der 1. Schritt und mehr! Ende."
    assert [text[i:].split()[0] for i in _sentence_starts(text)] == ["Danach", "Ende."]


def test_page_transcripts_continue_the_chapter_of_the_previous_page():
    raw = [
        Document(
            content="# Handbuch\n\n## Kapitel\n\nAnfang.",
            meta={"page": 1, "modality": "pdf_page", "continues_section": True},
        ),
        Document(
            content="Fortsetzung.\n\n## Weiter\n\nRest.",
            meta={"page": 2, "modality": "pdf_page", "continues_section": True},
        ),
    ]
    docs = split_documents(raw)
    assign_sections(docs)
    assert docs[0].meta["heading_path"] == ["Handbuch", "Kapitel"]
    assert "Fortsetzung." in docs[0].content
    assert docs[0].meta["pages"] == [1, 2]
    assert docs[1].meta["heading_path"] == ["Handbuch", "Weiter"]
    assert docs[1].meta["page"] == 2
    assert all("continues_section" not in d.meta for d in docs)


def test_extra_vision_pages_do_not_inherit_a_chapter():
    raw = [
        Document(content="# Kapitel\n\nText.", meta={"page": 1}),
        Document(content="Screenshot.", meta={"page": 1, "modality": "pdf_page"}),
    ]
    docs = split_documents(raw)
    assert [d.meta["heading_path"] for d in docs] == [["Kapitel"], []]


def test_figure_between_pages_does_not_split_the_section():
    section = {"section_ordinal": 1, "section_path": [1], "heading_path": ["Kapitel"]}
    figure = Document(content="Bild.", meta={"modality": "figure", "page": 1})
    raw = [
        Document(content="Seite eins.", meta={**section, "page": 1}),
        figure,
        Document(content="Seite zwei.", meta={**section, "page": 2}),
    ]
    docs = split_documents(raw)
    assert [d.content for d in docs] == ["Seite eins.\n\nSeite zwei.", "Bild."]
    assert docs[1] is figure


def test_old_cached_vlm_page_count_is_not_read_as_a_page_list():
    from src.rag_structure import context_location

    assert page_list({"page": 2, "pages": 12}) == [2]
    result = {"metadata": {}, "expanded_sources": [{"page": 2, "pages": 12}]}
    assert context_location(result) == "Context pages: 2"


def _docling_with_pages(mimetype):
    from docling_core.types.doc import BoundingBox, DocItemLabel, DoclingDocument, ProvenanceItem
    from docling_core.types.doc.document import DocumentOrigin

    native = DoclingDocument(
        name="deck",
        origin=DocumentOrigin(mimetype=mimetype, binary_hash=1, filename="deck"),
    )
    box = BoundingBox(l=0, t=0, r=1, b=1)
    for page in (1, 2):
        native.add_page(page_no=page, size={"width": 10, "height": 10})
        prov = ProvenanceItem(page_no=page, bbox=box, charspan=(0, 1))
        native.add_text(label=DocItemLabel.TEXT, text=f"Inhalt {page}.", prov=prov)
    return native.model_dump_json()


def test_slides_stay_apart_while_pdf_pages_join():
    pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    slides = split_documents(docling_documents(_docling_with_pages(pptx)))
    assert [d.content for d in slides] == ["Inhalt 1.", "Inhalt 2."]
    assert [d.meta["slide"] for d in slides] == [1, 2]
    pages = split_documents(docling_documents(_docling_with_pages("application/pdf")))
    assert [d.content for d in pages] == ["Inhalt 1.\n\nInhalt 2."]


def test_flat_numbered_pdf_headings_get_their_hierarchy_from_the_numbers():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    native = DoclingDocument(name="manual")
    for title, text in (("1 Planung", "A."), ("1.1 Kosten", "B."), ("2 Export", "C.")):
        native.add_heading(text=title, level=1)
        native.add_text(label=DocItemLabel.TEXT, text=text)
    docs = split_documents(docling_documents(native.model_dump_json()))
    assert [d.meta["heading_path"] for d in docs] == [
        ["1 Planung"],
        ["1 Planung", "1.1 Kosten"],
        ["2 Export"],
    ]


def test_explicit_docling_levels_are_never_overridden_by_numbering():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    native = DoclingDocument(name="manual")
    native.add_heading(text="1.1 Tief nummeriert", level=1)
    native.add_text(label=DocItemLabel.TEXT, text="A.")
    native.add_heading(text="2 Unter", level=2)
    native.add_text(label=DocItemLabel.TEXT, text="B.")
    docs = split_documents(docling_documents(native.model_dump_json()))
    assert docs[1].meta["heading_path"] == ["1.1 Tief nummeriert", "2 Unter"]


def test_docling_document_title_sits_above_top_level_headings():
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    native = DoclingDocument(name="manual")
    native.add_title(text="Handbuch")
    native.add_heading(text="Kapitel", level=1)
    native.add_text(label=DocItemLabel.TEXT, text="Text.")
    docs = split_documents(docling_documents(native.model_dump_json()))
    assert [d.content for d in docs] == ["# Handbuch\n\n# Kapitel\n\nText."]
    assert docs[0].meta["heading_path"] == ["Handbuch", "Kapitel"]


def test_docling_list_items_keep_their_markers():
    from docling_core.types.doc import DoclingDocument

    native = DoclingDocument(name="manual")
    group = native.add_list_group()
    native.add_list_item(text="Erster Punkt", marker="1.", parent=group)
    native.add_list_item(text="Zweiter Punkt", marker="", parent=group)
    docs = split_documents(docling_documents(native.model_dump_json()))
    assert docs[0].content.startswith("1. Erster Punkt\n\n")
    assert docs[0].content.split("\n\n")[1].endswith("Zweiter Punkt")
