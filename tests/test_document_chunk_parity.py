"""Rich document text and Markdown share retrieval-sized overlapping windows."""

from haystack.dataclasses import Document

from src.rag_vector import VectorRAG


def _rag():
    rag = object.__new__(VectorRAG)
    rag._splitter = None
    return rag


def test_extracted_text_matches_markdown_with_overlap(tmp_path):
    words = [f"word{i}" for i in range(620)]
    text = " ".join(words)
    path = tmp_path / "sample.md"
    path.write_text(text, encoding="utf-8")
    rag = _rag()
    meta = {"page": 3, "dl_meta": {"headings": ["Pivot"]}}

    rich = rag._split_extracted_documents([Document(content=text, meta=meta)])
    markdown = rag._lane_text(str(path))

    assert [d.content for d in rich] == [d.content for d in markdown]
    assert len(rich) == 3
    assert rich[0].content.split()[-40:] == rich[1].content.split()[:40]
    assert {w for d in rich for w in d.content.split()} == set(words)
    assert all(d.meta["page"] == 3 and d.meta["dl_meta"] == meta["dl_meta"] for d in rich)


def test_figures_remain_intact_and_page_metadata_stays_local():
    rag = _rag()
    figure = Document(content="caption " * 300, meta={"modality": "figure", "page": 1})
    docs = rag._split_extracted_documents([
        Document(content="alpha " * 300, meta={"page": 1}),
        figure,
        Document(content="beta " * 300, meta={"page": 2}),
    ])

    assert docs[2] is figure
    assert [d.meta["page"] for d in docs] == [1, 1, 1, 2, 2]
    assert all("beta" not in d.content for d in docs[:2])


def test_docx_router_uses_shared_splitter(monkeypatch):
    rag = _rag()
    monkeypatch.setattr(rag, "_lane_docling", lambda path: [Document(content="word " * 620)])
    monkeypatch.setattr(rag, "_assign_sections", lambda docs: None)
    monkeypatch.setattr(rag, "_apply_contextual", lambda docs: None)
    monkeypatch.setattr(rag, "_apply_autokeywords", lambda docs: None)
    monkeypatch.setenv("PDF_VLM_ENABLED", "")
    monkeypatch.setenv("RAG_REDACT_PII", "")

    docs = rag._documents_for_file("sample.docx", {})

    assert len(docs) == 3
    assert all(len(d.content.split()) <= 250 for d in docs)
