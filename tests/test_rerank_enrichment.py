"""Reranking must see the same enriched text used to build vectors."""

import importlib
import sys
from types import SimpleNamespace

rv = importlib.import_module("src.rag_vector")


def test_reranker_uses_hidden_retrieval_document(monkeypatch):
    captured = {}

    class _Response:
        status_code = 200

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
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"results": results}

    monkeypatch.setenv("RERANK_URL", "http://reranker/v1/rerank")
    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(post=lambda *a, **kw: _Response()))
    rag = object.__new__(rv.VectorRAG)
    rag._last_rerank_error = ""
    return rag._rerank("query", candidates, k)


def _rerank_candidates():
    return [{"id": str(i), "document": f"doc {i}", "metadata": {}} for i in range(2)]


def _rerank_with_status(monkeypatch, statuses):
    """Stub endpoint answering each call with the next status; records the payloads."""
    calls = []

    def _post(_url, json, headers, timeout):
        calls.append(json)
        status = statuses[len(calls) - 1]

        class _Response:
            status_code = status

            def raise_for_status(self):
                if status >= 400:
                    raise RuntimeError(f"HTTP {status}")

            def json(self):
                return {"results": [{"index": 1, "relevance_score": 0.9}]}

        return _Response()

    monkeypatch.setenv("RERANK_URL", "http://reranker/v1/rerank")
    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(post=_post))
    rag = object.__new__(rv.VectorRAG)
    rag._last_rerank_error = ""
    return rag, rag._rerank("query", _rerank_candidates(), 1), calls


def test_oversized_document_retries_with_truncation_and_keeps_the_ranking(monkeypatch):
    rag, result, calls = _rerank_with_status(monkeypatch, [400, 200])
    assert "truncate_prompt_tokens" not in calls[0]
    assert calls[1]["truncate_prompt_tokens"] == -1
    assert calls[1]["documents"] == calls[0]["documents"]
    assert result[0]["id"] == "1"
    assert rag._last_rerank_error == ""


def test_endpoint_that_cannot_truncate_falls_back_to_hybrid_order(monkeypatch):
    rag, result, calls = _rerank_with_status(monkeypatch, [400, 422])
    assert len(calls) == 2
    assert result[0]["id"] == "0"
    assert "422" in rag._last_rerank_error


def test_other_errors_do_not_retry(monkeypatch):
    rag, result, calls = _rerank_with_status(monkeypatch, [500])
    assert len(calls) == 1
    assert result[0]["id"] == "0"


def test_failed_rerank_is_reported_on_the_hits_and_in_the_summary(monkeypatch):
    rv.clear_rerank_failures()
    rag, result, _ = _rerank_with_status(monkeypatch, [500])
    assert [r["rerank_error"] for r in result] == ["HTTP 500"]
    summary = rv.rerank_failure_summary()
    assert summary["failures_last_hour"] == 1
    assert summary["last_error"] == "HTTP 500"
    assert summary["last_failed_at"] is not None


def test_timeout_has_a_readable_reason_even_with_an_empty_message(monkeypatch):
    class ReadTimeout(Exception):
        pass

    def _post(*_a, **_kw):
        raise ReadTimeout()

    rv.clear_rerank_failures()
    monkeypatch.setenv("RERANK_URL", "http://reranker/v1/rerank")
    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(post=_post))
    rag = object.__new__(rv.VectorRAG)
    result = rag._rerank("query", _rerank_candidates(), 1)
    assert result[0]["rerank_error"] == "timed out after 180 s"
    assert rag._last_rerank_error == "timed out after 180 s"


def test_successful_rerank_reports_no_failure(monkeypatch):
    rv.clear_rerank_failures()
    _, result, _ = _rerank_with_status(monkeypatch, [200])
    assert "rerank_error" not in result[0]
    assert rv.rerank_failure_summary() == {
        "failures_last_hour": 0,
        "last_failed_at": None,
        "last_error": "",
    }


def test_failures_older_than_an_hour_no_longer_count(monkeypatch):
    rv.clear_rerank_failures()
    rv._record_rerank_failure("old")
    real_time = rv.time.time
    monkeypatch.setattr(rv.time, "time", lambda: real_time() + 3601)
    assert rv.rerank_failure_summary()["failures_last_hour"] == 0


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
