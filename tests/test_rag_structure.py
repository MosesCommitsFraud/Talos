"""Real Haystack/Docling-core tests; no model downloads or external services."""

from copy import deepcopy

from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_structure import assign_sections, docling_documents, expand_context, split_documents
from src.rag_vector import VectorRAG, _embed_text, _redact_docs


def chunks(text, **kwargs):
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
    docs = split_documents(docling_documents(native.model_dump_json()))
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


def test_section_continues_across_pages_but_page_provenance_stays_local():
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
        for page, text in [(1, "first page"), (2, "second page")]
    ]
    docs = split_documents(raw)
    assign_sections(docs)
    assert [d.meta["page"] for d in docs] == [1, 2]
    result = expand_context(store_for(docs), [hit(docs[1])])[0]
    assert result["expanded"] == "first page\n\nsecond page"
    assert [s["page"] for s in result["expanded_sources"]] == [1, 2]
