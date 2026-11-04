"""Term spellings the knowledge base lookup has to treat as the same term."""

from types import SimpleNamespace

import pytest

from src.rag_term_match import term_parts, term_regex, word_regexes
from src.rag_vector import FailedSearch, VectorRAG


class _Store:
    def __init__(self, docs):
        self.docs = docs
        self.reads = 0

    def count_documents(self):
        return len(self.docs)


def _doc(i, content, **meta):
    return SimpleNamespace(
        id=f"c{i}", content=content, meta={"filename": "h.pdf", "seq": i, **meta}
    )


def _rag(docs):
    rag = object.__new__(VectorRAG)
    rag._healthy = True
    rag._cfg = {}
    rag._last_error = ""
    rag._store = _Store(docs)
    rag._build_filters = lambda **kw: None

    def read(filters=None):
        rag._store.reads += 1
        return list(rag._store.docs)

    rag._read_documents = read
    return rag


def test_grep_finds_spelling_variants_and_shows_the_place():
    rag = _rag(
        [_doc(1, "x" * 200 + " Drücken Sie Strg + M. " + "y" * 200), _doc(2, "Sonst nichts")]
    )
    hits = rag.grep_chunks("strg+m")
    assert [h["id"] for h in hits] == ["c1"]
    assert "Strg + M" in hits[0]["snippet"]
    assert hits[0]["snippet"].startswith("…")
    assert hits[0]["snippet"].endswith("…")


def test_grep_searches_the_hidden_enrichment_too():
    hits = _rag([_doc(1, "Text", aux_terms="Stichwort Pivot")]).grep_chunks("pivot")
    assert [h["id"] for h in hits] == ["c1"]


def test_all_words_only_when_asked_and_only_without_a_phrase_hit():
    docs = [_doc(1, "Fehler beim Export der Daten"), _doc(2, "Nur ein Export")]
    assert _rag(docs).grep_chunks("Export Fehler") == []
    loose = _rag(docs).grep_chunks("Export Fehler", all_words=True)
    assert [h["id"] for h in loose] == ["c1"]
    assert loose[0]["all_words"] is True
    exact = _rag(docs).grep_chunks("Nur ein Export", all_words=True)
    assert [h["id"] for h in exact] == ["c2"]
    assert "all_words" not in exact[0]


def test_grep_keeps_the_chunks_for_the_next_lookup():
    rag = _rag([_doc(1, "Text")])
    rag.grep_chunks("Text")
    rag.grep_chunks("Anderes")
    assert rag._store.reads == 1


def test_a_write_from_another_process_is_noticed():
    rag = _rag([_doc(1, "Text")])
    assert rag.grep_chunks("Neu") == []
    rag._store.docs.append(_doc(2, "Neu"))
    assert [h["id"] for h in rag.grep_chunks("Neu")] == ["c2"]


def test_a_large_collection_is_not_kept_in_memory(monkeypatch):
    monkeypatch.setattr("src.rag_vector._GREP_CACHE_MAX_CHUNKS", 0)
    rag = _rag([_doc(1, "Text")])
    rag.grep_chunks("Text")
    rag.grep_chunks("Text")
    assert rag._store.reads == 2


def test_failures_are_told_apart_from_nothing_found():
    rag = _rag([])

    def broken(filters=None):
        raise RuntimeError("Qdrant down")

    rag._read_documents = broken
    result = rag.grep_chunks("Text")
    assert isinstance(result, FailedSearch)
    assert "Qdrant down" in result.error
    assert result == []


@pytest.mark.parametrize(
    "term,text",
    [
        ("Strg+M", "Drücken Sie Strg + M."),
        ("Strg + M", "mit Strg+M"),
        ("strg-m", "Strg M öffnet"),
        ("Datentransfer", "im DATENTRANSFER"),
        ("Daten-Transfer", "der Daten Transfer"),
        ("Daten Transfer", "der Datentransfer"),
        ("Uebersetzen", "die Funktion Übersetzen"),
        ("Übersetzen", "Uebersetzen klicken"),
        ("Strasse", "Hauptstraße"),
        ("Datenart", "alle Datenarten"),
        ("MX-404", "Fehler MX 404 erscheint"),
    ],
)
def test_same_term(term, text):
    assert term_regex(term).search(text)


@pytest.mark.parametrize(
    "term,text",
    [
        ("Strg+M", "Strg Menü"),
        ("Strg+M", "Strg+N"),
        ("Datenart", "Daten und Arten"),
        ("Export", "Import"),
    ],
)
def test_different_term(term, text):
    assert not term_regex(term).search(text)


def test_positions_point_into_the_original_text():
    text = "Am besten über Strg + M öffnen"
    match = term_regex("strg+m").search(text)
    assert text[match.start() : match.end()] == "Strg + M"


def test_a_term_of_only_punctuation_is_taken_literally():
    assert term_parts("+++") == []
    assert term_regex("+++").search("a +++ b")
    assert word_regexes("+++") == []


def test_words_only_for_several_words():
    assert word_regexes("Datentransfer") == []
    patterns = word_regexes("Export Fehler")
    assert all(p.search("Fehler beim Export") for p in patterns)
