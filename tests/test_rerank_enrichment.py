"""Reranking must see the same enriched text used to build vectors."""

import importlib
import sys
from types import SimpleNamespace

rv = importlib.import_module("src.rag_vector")


def test_reranker_uses_hidden_retrieval_document(monkeypatch):
    captured = {}

    class _Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"results": [{"index": 0, "relevance_score": 0.9}]}

    def _post(_url, json, headers, timeout):
        captured.update(json)
        return _Response()

    monkeypatch.setenv("RERANK_URL", "http://reranker/v1/rerank")
    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(post=_post))
    rag = object.__new__(rv.VectorRAG)
    rag._last_rerank_error = ""
    candidates = [
        {
            "id": "page28",
            "document": "Elementband",
            "_retrieval_document": "Elementband\n\nvertikale Toolbar Symbole Funktionen",
            "metadata": {"page": 28},
        }
    ]

    result = rag._rerank("Funktionen der Toolbar-Symbole", candidates, 1)

    assert captured["documents"] == ["Elementband\n\nvertikale Toolbar Symbole Funktionen"]
    assert result[0]["document"] == "Elementband"


def _rerank_with(monkeypatch, results, candidates, k):
    """Run _rerank against a stub endpoint returning `results` verbatim."""

    class _Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"results": results}

    monkeypatch.setenv("RERANK_URL", "http://reranker/v1/rerank")
    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(post=lambda *a, **kw: _Response()))
    rag = object.__new__(rv.VectorRAG)
    rag._last_rerank_error = ""
    return rag._rerank("query", candidates, k)


def test_rerank_sorts_unsorted_provider_response(monkeypatch):
    """A /score-style endpoint answers in INPUT order. Without a defensive sort,
    `[:k]` keeps the first k retrieval hits instead of the best k — the reranker
    becomes a no-op that only relabels scores."""
    candidates = [{"id": f"c{i}", "document": f"doc {i}"} for i in range(4)]
    results = [
        {"index": 0, "relevance_score": 0.11},
        {"index": 1, "relevance_score": 0.94},
        {"index": 2, "relevance_score": 0.22},
        {"index": 3, "relevance_score": 0.77},
    ]

    out = _rerank_with(monkeypatch, results, candidates, 2)

    assert [c["id"] for c in out] == ["c1", "c3"]
    assert out[0]["rerank_score"] == 0.94


def test_rerank_keeps_sorted_provider_response(monkeypatch):
    """A Cohere-style endpoint already sorts; the sort must be order-preserving."""
    candidates = [{"id": f"c{i}", "document": f"doc {i}"} for i in range(3)]
    results = [
        {"index": 2, "relevance_score": 0.9},
        {"index": 0, "relevance_score": 0.5},
        {"index": 1, "relevance_score": 0.1},
    ]

    out = _rerank_with(monkeypatch, results, candidates, 3)

    assert [c["id"] for c in out] == ["c2", "c0", "c1"]


def test_rerank_sorts_scoreless_entries_last(monkeypatch):
    """A missing score carries no relevance signal, so it must not outrank a
    real one — and must not raise on the float() comparison."""
    candidates = [{"id": f"c{i}", "document": f"doc {i}"} for i in range(3)]
    results = [
        {"index": 0},
        {"index": 1, "relevance_score": 0.4},
        {"index": 2, "relevance_score": 0.8},
    ]

    out = _rerank_with(monkeypatch, results, candidates, 3)

    assert [c["id"] for c in out] == ["c2", "c1", "c0"]
    assert out[-1]["rerank_score"] is None
