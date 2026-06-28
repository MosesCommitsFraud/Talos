"""Unit tests for Phase 10 small-to-big (parent/child) retrieval.

Pure logic: section tagging, the gate, and the expansion (with a fake store).
No network, no Haystack, no Qdrant.
"""

import importlib

rv = importlib.import_module("src.rag_vector")


def test_expand_inactive_by_default(monkeypatch):
    monkeypatch.delenv("EXPAND_TO_PARENT_ENABLED", raising=False)
    assert rv._expand_active() is False
    monkeypatch.setenv("EXPAND_TO_PARENT_ENABLED", "true")
    assert rv._expand_active() is True


class _Doc:
    def __init__(self, content, meta=None):
        self.content = content
        self.meta = dict(meta or {})


def test_section_assignment_windows_neighbours():
    docs = [_Doc(f"chunk {i}", {"source": "/x/doc.md"}) for i in range(5)]
    rv.VectorRAG._assign_sections(object(), docs)
    # seq is the running order.
    assert [d.meta["seq"] for d in docs] == [0, 1, 2, 3, 4]
    # Window of 3 → first three share a section, next two share another.
    s = [d.meta["section_id"] for d in docs]
    assert s[0] == s[1] == s[2]
    assert s[3] == s[4]
    assert s[0] != s[3]


def test_section_key_prefers_headings():
    meta = {"dl_meta": {"headings": ["Guide", "Setup"]}}
    assert rv._section_key(meta, 0) == "Guide / Setup"
    # No headings → falls back to the window bucket.
    assert rv._section_key({}, 7) == "win2"


class _Store:
    def __init__(self, docs):
        self._docs = docs

    def filter_documents(self, filters=None):
        # The fake ignores filters and returns the section's siblings.
        return list(self._docs)


class _RagLike:
    def __init__(self, store):
        self._store = store


def test_expand_merges_siblings_by_section(monkeypatch):
    monkeypatch.setenv("EXPAND_TO_PARENT_ENABLED", "true")
    monkeypatch.delenv("RAG_PARENT_MAX_CHARS", raising=False)
    siblings = [
        _Doc("second part", {"seq": 1}),
        _Doc("first part", {"seq": 0}),  # out of order on purpose
    ]
    rag = _RagLike(_Store(siblings))
    results = [{"document": "first part", "metadata": {"source": "/x", "section_id": "abc"}}]
    out = rv.VectorRAG._expand_to_parent(rag, results)
    # Siblings merged in seq order.
    assert out[0]["expanded"] == "first part\n\nsecond part"


def test_expand_respects_char_cap(monkeypatch):
    monkeypatch.setenv("EXPAND_TO_PARENT_ENABLED", "true")
    monkeypatch.setenv("RAG_PARENT_MAX_CHARS", "10")
    siblings = [_Doc("x" * 50, {"seq": 0})]
    rag = _RagLike(_Store(siblings))
    results = [{"document": "x", "metadata": {"source": "/x", "section_id": "abc"}}]
    out = rv.VectorRAG._expand_to_parent(rag, results)
    assert len(out[0]["expanded"]) == 10


def test_expand_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("EXPAND_TO_PARENT_ENABLED", "")
    rag = _RagLike(_Store([_Doc("sib", {"seq": 0})]))
    results = [{"document": "chunk", "metadata": {"source": "/x", "section_id": "abc"}}]
    out = rv.VectorRAG._expand_to_parent(rag, results)
    assert "expanded" not in out[0]
