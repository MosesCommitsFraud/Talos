"""Publication failures must never replace working knowledge with partial text."""

from dataclasses import replace

import pytest
from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_generations import GenerationCatalog


def doc(text, source="guide.md", owner="alice"):
    return Document(content=text, meta={"source": source, "owner": owner})


def test_publication_is_invisible_until_verified_then_replaces_legacy(tmp_path):
    store = InMemoryDocumentStore()
    old = doc("old")
    other = doc("other owner", owner="bob")
    store.write_documents([old, other])
    catalog = GenerationCatalog(tmp_path, "kb")
    new = [doc("new one"), doc("new two")]

    def writer(staged):
        store.write_documents(staged[:1])
        assert {d.content for d in store.filter_documents(filters=catalog.visibility_filter())} == {
            "old",
            "other owner",
        }
        store.write_documents(staged[1:])

    assert catalog.publish(new, store, writer) == 2
    assert {d.content for d in store.filter_documents(filters=catalog.visibility_filter())} == {
        "new one",
        "new two",
        "other owner",
    }
    assert old.id not in {d.id for d in store.filter_documents()}


def test_partial_write_failure_keeps_old_generation(tmp_path):
    store = InMemoryDocumentStore()
    store.write_documents([doc("old")])
    catalog = GenerationCatalog(tmp_path, "kb")

    def fail(staged):
        store.write_documents(staged[:1])
        raise RuntimeError("network interrupted")

    with pytest.raises(RuntimeError, match="network interrupted"):
        catalog.publish([doc("new one"), doc("new two")], store, fail)
    assert [d.content for d in store.filter_documents(filters=catalog.visibility_filter())] == [
        "old"
    ]
    assert catalog.read()["pending"] == []


def test_incomplete_acknowledged_write_is_not_activated(tmp_path):
    store = InMemoryDocumentStore()
    store.write_documents([doc("old")])
    catalog = GenerationCatalog(tmp_path, "kb")
    with pytest.raises(RuntimeError, match="Incomplete"):
        catalog.publish(
            [doc("one"), doc("two")], store, lambda parts: store.write_documents(parts[:1])
        )
    assert [d.content for d in store.filter_documents()] == ["old"]


def test_retirement_failure_hides_old_records_after_restart(tmp_path, monkeypatch):
    store = InMemoryDocumentStore()
    store.write_documents([doc("old")])
    catalog = GenerationCatalog(tmp_path, "kb")
    monkeypatch.setattr(
        store, "delete_documents", lambda ids: (_ for _ in ()).throw(RuntimeError("cleanup failed"))
    )
    catalog.publish([doc("new")], store, store.write_documents)
    assert len(store.filter_documents()) == 2
    reopened = GenerationCatalog(tmp_path, "kb")
    assert [d.content for d in store.filter_documents(filters=reopened.visibility_filter())] == [
        "new"
    ]


def test_pending_generation_is_hidden_after_process_restart(tmp_path):
    catalog = GenerationCatalog(tmp_path, "kb")
    catalog.save({"active": {}, "pending": ["incomplete"]})
    store = InMemoryDocumentStore()
    store.write_documents(
        [doc("old"), replace(doc("partial"), meta={"ingest_generation": "incomplete"})]
    )
    assert [
        d.content
        for d in store.filter_documents(
            filters=GenerationCatalog(tmp_path, "kb").visibility_filter()
        )
    ] == ["old"]


def test_scopes_are_independent_and_repeated_publication_removes_old_chunks(tmp_path):
    store = InMemoryDocumentStore()
    catalog = GenerationCatalog(tmp_path, "kb")
    sql = replace(doc("sql"), meta={"source": "guide.md", "owner": "alice", "scope": "sql"})
    store.write_documents([sql])
    catalog.publish([doc("one"), doc("two")], store, store.write_documents)
    catalog.publish([doc("replacement")], store, store.write_documents)
    assert {d.content for d in store.filter_documents(filters=catalog.visibility_filter())} == {
        "sql",
        "replacement",
    }
    assert len(store.filter_documents()) == 2


def test_visibility_and_null_scope_filters_with_real_local_qdrant(tmp_path):
    from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

    from src.rag_generations import store_filter

    store = QdrantDocumentStore(location=":memory:", embedding_dim=3, progress_bar=False)
    old = replace(doc("old"), embedding=[1.0, 0.0, 0.0])
    other = replace(doc("other", owner="bob"), embedding=[1.0, 0.0, 0.0])
    store.write_documents([old, other])
    catalog = GenerationCatalog(tmp_path, "qdrant")
    new = replace(doc("new"), embedding=[1.0, 0.0, 0.0])

    def writer(staged):
        store.write_documents(staged)
        assert {
            d.content
            for d in store.filter_documents(
                filters=store_filter(store, catalog.visibility_filter())
            )
        } == {"old", "other"}

    catalog.publish([new], store, writer)
    assert {
        d.content
        for d in store.filter_documents(filters=store_filter(store, catalog.visibility_filter()))
    } == {"new", "other"}
