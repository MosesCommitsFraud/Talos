"""Unit tests for Phase 8 Contextual Retrieval.

Pure logic only: the gate, the embed-prefix helper, and the content-hash cache
(LLM call stubbed). No network, no Haystack, no Qdrant.
"""

import importlib

rv = importlib.import_module("src.rag_vector")


def test_contextual_inactive_by_default(monkeypatch):
    monkeypatch.delenv("CONTEXTUAL_RETRIEVAL_ENABLED", raising=False)
    monkeypatch.delenv("RAG_LLM_URL", raising=False)
    assert rv._contextual_active() is False


def test_contextual_requires_toggle_and_llm(monkeypatch):
    monkeypatch.setenv("CONTEXTUAL_RETRIEVAL_ENABLED", "true")
    monkeypatch.delenv("RAG_LLM_URL", raising=False)
    assert rv._contextual_active() is False  # toggle on but no endpoint
    monkeypatch.setenv("RAG_LLM_URL", "http://llm:8000/v1/chat/completions")
    assert rv._contextual_active() is True


def test_prefix_context_prepends_and_preserves_original():
    out = rv._prefix_context("Situating context.", "the original chunk")
    assert out.startswith("Situating context.")
    assert out.endswith("the original chunk")
    # No context → unchanged (original text only).
    assert rv._prefix_context("", "the original chunk") == "the original chunk"


class _Doc:
    def __init__(self, content):
        self.content = content
        self.meta = {}


def test_apply_contextual_sets_context_and_caches(monkeypatch):
    monkeypatch.setenv("CONTEXTUAL_RETRIEVAL_ENABLED", "true")
    monkeypatch.setenv("RAG_LLM_URL", "http://llm:8000/v1/chat/completions")
    monkeypatch.delenv("REDIS_URL", raising=False)  # force the in-process cache
    rv._CONTEXT_CACHE.clear()

    calls = []

    class _Dummy:
        def _contextual_blurb(self, full, chunk):
            calls.append(chunk)
            return "Situating context."

    docs = [_Doc("alpha chunk body"), _Doc("beta chunk body")]
    rv.VectorRAG._apply_contextual(_Dummy(), docs)
    assert docs[0].meta["context"] == "Situating context."
    assert docs[1].meta["context"] == "Situating context."
    assert len(calls) == 2  # one blurb per distinct chunk

    # Re-ingest the same chunks → cache hit, zero new LLM calls.
    docs2 = [_Doc("alpha chunk body"), _Doc("beta chunk body")]
    rv.VectorRAG._apply_contextual(_Dummy(), docs2)
    assert docs2[0].meta["context"] == "Situating context."
    assert len(calls) == 2


def test_apply_contextual_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("CONTEXTUAL_RETRIEVAL_ENABLED", "")
    monkeypatch.delenv("RAG_LLM_URL", raising=False)

    class _Dummy:
        def _contextual_blurb(self, full, chunk):
            raise AssertionError("should not be called when disabled")

    docs = [_Doc("x")]
    rv.VectorRAG._apply_contextual(_Dummy(), docs)
    assert "context" not in docs[0].meta
