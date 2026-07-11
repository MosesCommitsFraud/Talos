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
