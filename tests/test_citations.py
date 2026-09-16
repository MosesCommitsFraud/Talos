"""Turn-wide citation numbers (src/citations.py) and their use in web search output."""

import importlib

from src import citations

web_search = importlib.import_module("src.web_search")


def test_numbers_are_turn_wide_and_stable():
    citations.begin_turn("s1")
    a = citations.cite_web("s1", "https://example.com/a", "A", "snippet a")
    b = citations.cite_rag("s1", {"_id": "chunk-7", "filename": "handbuch.pdf", "snippet": "x", "_page": 3})
    again = citations.cite_web("s1", "https://example.com/a/", "A", "snippet a")
    assert (a, b, again) == (1, 2, 1)
    rag = citations.entries("s1", {2})[0]
    assert rag == {"kind": "rag", "title": "handbuch.pdf", "snippet": "x", "page": 3, "n": 2}

    citations.begin_turn("s1")
    assert citations.entries("s1") == []
    assert citations.cite_web("s1", "https://example.com/b", "B", "") == 1


def test_no_turn_means_no_numbers():
    assert citations.cite_web(None, "https://example.com", "T", "") is None
    assert citations.cite_web("never-started", "https://example.com", "T", "") is None


def test_cited_numbers_parses_groups():
    text = "Erstens [1]. Zweitens [2][4] und [3, 5]. Code `x[9]` zählt auch."
    assert citations.cited_numbers(text) == {1, 2, 3, 4, 5, 9}


def test_search_results_carry_citation_numbers():
    payload = {"results": [
        {"url": "https://example.com/a", "title": "Erste", "content": "eins"},
        {"url": "https://example.com/b", "title": "Zweite", "content": "zwei"},
    ]}
    citations.begin_turn("s2")
    citations.cite_web("s2", "https://other.org", "Vorher", "")
    out = web_search._format_search_results("q", payload, max_results=5, session_id="s2")
    assert "[2] **Erste**" in out and "[3] **Zweite**" in out
    assert citations.CITATION_RULE in out
    # Outside a chat turn (e.g. the MCP server) the plain list stays.
    plain = web_search._format_search_results("q", payload, max_results=5)
    assert "1. **Erste**" in plain and citations.CITATION_RULE not in plain
