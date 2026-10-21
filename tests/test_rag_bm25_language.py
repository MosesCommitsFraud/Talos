"""The keyword (BM25) side stems in the knowledge base's language."""

from dataclasses import replace

import pytest
from haystack import Document
from haystack.dataclasses import SparseEmbedding
from haystack.document_stores.in_memory import InMemoryDocumentStore

import src.rag_vector as rv
from src import rag_documents as rd
from src.rag_vector import VectorRAG, bm25_language


def test_base_language_maps_to_a_snowball_language():
    assert bm25_language("de") == "german"
    assert bm25_language("DE-at") == "german"
    assert bm25_language("Deutsch") == "german"
    assert bm25_language("french") == "french"
    assert bm25_language("") == "english"
    assert bm25_language("xx") == "english"


class Encoder:
    """Stands in for FastEmbed: records which language encoded what."""

    def __init__(self, language):
        self.language = language

    def run(self, documents=None, text=None):
        tag = 1 if self.language == "german" else 0
        if text is not None:
            return {"sparse_embedding": SparseEmbedding(indices=[tag], values=[1.0])}
        return {
            "documents": [
                replace(d, sparse_embedding=SparseEmbedding(indices=[tag], values=[1.0]))
                for d in documents
            ]
        }


class Dense:
    def run(self, documents):
        return {"documents": [replace(d, embedding=[1.0, 0.0]) for d in documents]}


@pytest.fixture
def make_rag(tmp_path, monkeypatch):
    built = []

    def fake_shared(kind, model, language=None):
        built.append((kind, language))
        return Encoder(language)

    monkeypatch.setattr(rv, "_shared_sparse_embedder", fake_shared)
    monkeypatch.delenv("RAG_EMBEDDING_TOKENIZER", raising=False)

    def make(language="de", collection="kb", store=None):
        rag = object.__new__(VectorRAG)
        rag._cfg = {"embedding_tokenizer": "", "embedding_max_tokens": 0, "base_language": language}
        rag.persist_directory = str(tmp_path / "rag")
        rag.collection_name = collection
        rag._store = store or InMemoryDocumentStore()
        rag._healthy = True
        rag._sparse_model = "Qdrant/bm25"
        rag._sparse_q = rag._sparse_d = None
        monkeypatch.setattr(rag, "_dense_doc_embedder", lambda: Dense())
        return rag

    make.built = built
    return make


def test_existing_collection_keeps_english_until_rebuilt(make_rag):
    store = InMemoryDocumentStore()
    store.write_documents(
        [
            Document(content="Reisekosten", meta={"source": "a.md"}, embedding=[1.0, 0.0]),
            Document(content="Urlaubsantrag", meta={"source": "b.md"}, embedding=[1.0, 0.0]),
        ]
    )
    rag = make_rag("de", store=store)
    status = rag.sparse_status()
    assert status == {
        "model": "Qdrant/bm25",
        "indexed_language": "english",
        "configured_language": "german",
        "stale": True,
    }
    # Queries keep matching the stored (English) vectors until the rebuild.
    assert rag._sparse_text_embedder().language == "english"

    result = rag.rebuild_sparse()
    assert result["updated"] == 2 and result["language"] == "german"
    assert all(d.sparse_embedding.indices == [1] for d in store.filter_documents())
    assert all(d.embedding == [1.0, 0.0] for d in store.filter_documents())
    assert rag.sparse_status()["stale"] is False
    assert rag._sparse_text_embedder().language == "german"
    # The switch is recorded for every process sharing the register.
    reg = rd.DocumentRegister(rag.persist_directory)
    assert reg.get_meta("kb", "sparse_language") == "german"


def test_new_empty_collection_starts_in_its_language(make_rag):
    rag = make_rag("fr", collection="neu")
    assert rag.sparse_status()["indexed_language"] == "french"
    assert rag.sparse_status()["stale"] is False
    rag._write_documents([Document(content="bonjour", meta={"source": "x.md"})])
    [doc] = rag._store.filter_documents()
    assert doc.sparse_embedding is not None
    assert ("doc", "french") in make_rag.built


def test_shared_embedder_passes_the_language_only_to_bm25(monkeypatch):
    import sys
    import types

    made = []

    class FakeEmbedder:
        def __init__(self, model, model_kwargs=None):
            made.append((model, model_kwargs))

        def warm_up(self):
            pass

    module = types.SimpleNamespace(
        FastembedSparseTextEmbedder=FakeEmbedder, FastembedSparseDocumentEmbedder=FakeEmbedder
    )
    monkeypatch.setitem(sys.modules, "haystack_integrations.components.embedders.fastembed", module)
    monkeypatch.setattr(rv, "_SPARSE_EMBEDDERS", {})
    rv._shared_sparse_embedder("text", "Qdrant/bm25", "german")
    rv._shared_sparse_embedder("text", "prithivida/Splade_PP_en_v1", "german")
    assert made == [
        ("Qdrant/bm25", {"language": "german"}),
        ("prithivida/Splade_PP_en_v1", None),
    ]


def test_base_language_reaches_the_engine_but_never_the_overrides(tmp_path, monkeypatch):
    from src import rag_config, rag_registry

    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(rag_config, "global_config", lambda: {"rerank_url": "http://r"})
    entry = rag_registry.create_base("Docs", language="de")
    assert "base_language" not in rag_config.effective_config(entry["id"])
    assert rag_config.instance_config(entry["id"])["base_language"] == "de"
