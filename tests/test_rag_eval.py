"""Unit tests for the RAG eval harness scoring (scripts/rag_eval.py).

Pure logic — a stub fetch replaces the HTTP call, so no server is needed.
"""

import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    "rag_eval", pathlib.Path(__file__).resolve().parent.parent / "scripts" / "rag_eval.py"
)
rag_eval = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rag_eval)


def test_source_matches_handles_paths_and_basenames():
    assert rag_eval.source_matches("api_keys.md", "api_keys.md")
    assert rag_eval.source_matches("docs/api_keys.md", "api_keys.md")  # path vs basename
    assert rag_eval.source_matches("api_keys.md", "/srv/uploads/api_keys.md")
    assert not rag_eval.source_matches("api_keys.md", "other.md")
    assert not rag_eval.source_matches("", "api_keys.md")


def test_expected_sources_accepts_both_keys():
    assert rag_eval.expected_sources({"sources": ["a", "b"]}) == ["a", "b"]
    assert rag_eval.expected_sources({"source": "a"}) == ["a"]
    assert rag_eval.expected_sources({"q": "x"}) == []


def test_evaluate_recall_and_mrr():
    entries = [
        {"q": "a", "sources": ["foo.pdf"]},  # hit at rank 2 → recall 1, rr 0.5
        {"q": "b", "source": "bar.md"},  # miss → recall 0, rr 0
    ]
    db = {
        "a": [{"filename": "x.txt"}, {"filename": "foo.pdf"}],
        "b": [{"filename": "nope.txt"}],
    }

    def fetch(q, k):
        return db[q][:k]

    summary = rag_eval.evaluate(entries, fetch, k=10)
    assert summary["n"] == 2
    assert summary["recall_at_k"] == 0.5
    assert summary["mrr"] == 0.25


def test_recall_respects_k_cutoff():
    entries = [{"q": "a", "sources": ["foo.pdf"]}]  # hit only at rank 3

    def fetch(q, k):
        return [{"filename": "a"}, {"filename": "b"}, {"filename": "foo.pdf"}][:k]

    assert rag_eval.evaluate(entries, fetch, k=2)["recall_at_k"] == 0.0
    assert rag_eval.evaluate(entries, fetch, k=5)["recall_at_k"] == 1.0
