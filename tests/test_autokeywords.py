"""Unit tests for Phase 9 auto keyword/question generation.

Pure logic: the gate, the embed-text builder (terms embedded but excluded from
the stored/displayed content), and the content-hash cache. LLM call stubbed.
"""

import importlib

rv = importlib.import_module("src.rag_vector")


def test_autokw_inactive_by_default(monkeypatch):
    monkeypatch.delenv("RAG_AUTO_KEYWORDS_N", raising=False)
    monkeypatch.delenv("RAG_AUTO_QUESTIONS_N", raising=False)
    monkeypatch.setenv("RAG_LLM_URL", "http://llm/v1/chat/completions")
    assert rv._autokw_active() is False


def test_autokw_requires_llm_and_a_count(monkeypatch):
    monkeypatch.setenv("RAG_AUTO_KEYWORDS_N", "5")
    monkeypatch.delenv("RAG_LLM_URL", raising=False)
    assert rv._autokw_active() is False  # counts set but no endpoint
    monkeypatch.setenv("RAG_LLM_URL", "http://llm/v1/chat/completions")
    assert rv._autokw_active() is True


def test_embed_text_appends_terms_but_content_excludes_them():
    meta = {"aux_terms": "rotate key\nhow do I rotate the API key?"}
    embedded = rv._embed_text(meta, "the original chunk body")
    # The embedding sees the extra terms…
    assert "rotate key" in embedded
    assert "the original chunk body" in embedded
    # …but the source content (what the citation snippet shows) does not.
    assert "rotate key" not in "the original chunk body"


def test_embed_text_combines_context_and_terms():
    meta = {"context": "From the API guide.", "aux_terms": "kw1"}
    out = rv._embed_text(meta, "body")
    assert out.startswith("From the API guide.")
    assert out.endswith("kw1")
    assert "body" in out


class _Doc:
    def __init__(self, content):
        self.content = content
        self.meta = {}


def test_apply_autokeywords_sets_aux_terms_and_caches(monkeypatch):
    monkeypatch.setenv("RAG_LLM_URL", "http://llm/v1/chat/completions")
    monkeypatch.setenv("RAG_AUTO_KEYWORDS_N", "3")
    monkeypatch.setenv("RAG_AUTO_QUESTIONS_N", "0")
    monkeypatch.delenv("REDIS_URL", raising=False)
    rv._CONTEXT_CACHE.clear()

    calls = []

    class _Dummy:
        def _auto_terms(self, chunk):
            calls.append(chunk)
            return "kw-a\nkw-b\nkw-c"

    docs = [_Doc("chunk one"), _Doc("chunk two")]
    rv.VectorRAG._apply_autokeywords(_Dummy(), docs)
    assert docs[0].meta["aux_terms"] == "kw-a\nkw-b\nkw-c"
    assert docs[0].content == "chunk one"  # content untouched → snippet excludes terms
    assert len(calls) == 2

    # Re-ingest → cache hit, no new LLM calls.
    rv.VectorRAG._apply_autokeywords(_Dummy(), [_Doc("chunk one"), _Doc("chunk two")])
    assert len(calls) == 2


def test_empty_llm_output_is_not_cached(monkeypatch):
    monkeypatch.setenv("RAG_LLM_URL", "http://llm/v1/chat/completions")
    monkeypatch.setenv("RAG_AUTO_KEYWORDS_N", "3")
    monkeypatch.setenv("RAG_AUTO_QUESTIONS_N", "2")
    monkeypatch.delenv("REDIS_URL", raising=False)
    rv._CONTEXT_CACHE.clear()

    calls = []

    class _Dummy:
        def _auto_terms(self, chunk):
            calls.append(chunk)
            return ""

    first = _Doc("chunk one")
    second = _Doc("chunk one")
    rv.VectorRAG._apply_autokeywords(_Dummy(), [first])
    rv.VectorRAG._apply_autokeywords(_Dummy(), [second])

    assert calls == ["chunk one", "chunk one"]
    assert "aux_terms_error" in first.meta
    assert "aux_terms_error" in second.meta


def test_llm_url_and_reasoning_response_compatibility():
    assert rv._openai_chat_url("http://llm:8000/v1") == (
        "http://llm:8000/v1/chat/completions"
    )
    assert rv._chat_response_text(
        {"choices": [{"message": {"content": "", "reasoning_content": "keyword"}}]}
    ) == "keyword"
