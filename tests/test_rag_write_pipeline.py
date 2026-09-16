from dataclasses import replace

import pytest
from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_structure import assign_sections, split_documents
from src.rag_vector import VectorRAG


class Embedder:
    def run(self, documents):
        return {"documents": [replace(d, embedding=[1.0, 0.0, 0.0]) for d in documents]}


def test_complete_pipeline_reindex_preserves_raw_text_and_removes_old_generation(
    tmp_path, monkeypatch
):
    rag = object.__new__(VectorRAG)
    rag._cfg = {"embedding_tokenizer": "", "embedding_max_tokens": 0}
    rag.persist_directory = str(tmp_path)
    rag.collection_name = "test"
    rag._store = InMemoryDocumentStore()
    monkeypatch.delenv("RAG_EMBEDDING_TOKENIZER", raising=False)
    monkeypatch.setattr(rag, "_dense_doc_embedder", lambda: Embedder())
    monkeypatch.setattr(rag, "_sparse_doc_embedder", lambda: Embedder())
    for body in ("old " * 2500, "new content"):
        docs = split_documents(
            [Document(content=body, meta={"source": "x.md", "context": "embedding-only"})]
        )
        assign_sections(docs)
        rag._write_documents(docs, replace_sources=True)
        current = rag._read_documents()
        assert current
        assert all("embedding-only" not in d.content for d in current)
    assert [d.content for d in rag._read_documents()] == ["new content"]
    assert len(rag._store.filter_documents()) == 1

    class Failure:
        def run(self, documents):
            raise RuntimeError("endpoint unavailable")

    monkeypatch.setattr(rag, "_sparse_doc_embedder", lambda: Failure())
    docs = split_documents([Document(content="replacement", meta={"source": "x.md"})])
    assign_sections(docs)
    with pytest.raises(RuntimeError, match="endpoint unavailable"):
        rag._write_documents(docs, replace_sources=True)
    assert [d.content for d in rag._read_documents()] == ["new content"]
    assert docs[0].content == "replacement"
