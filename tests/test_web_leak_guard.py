"""Tests for ``src.web_leak_guard`` — keeping internal knowledge out of
outbound search queries.

The guard is a heuristic, so these tests pin down both sides of the tradeoff:
what must never leave (copied phrasing, names attached to identifiers) and what
must still be searchable (the public topic a document happens to be about).
"""

import importlib

import pytest

guard = importlib.import_module("src.web_leak_guard")

SESSION = "sess-1"

# Stand-in for RAG chunks injected into the turn.
RETRIEVED = """
Rahmenvertrag mit der Müller GmbH, gültig ab 2024. Klausel 7.3 regelt die
Kündigungsfrist: drei Monate zum Quartalsende. Ansprechpartnerin ist Frau
Sandra Brenner. Der Vertrag verweist auf die Photovoltaik-Förderung nach EEG.
"""


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    guard.forget_context(SESSION)
    monkeypatch.setattr(guard, "is_enabled", lambda: True)
    yield
    guard.forget_context(SESSION)


def test_no_retrieved_context_allows_anything():
    assert guard.check_query("Müller GmbH Umsatz", SESSION) is None


def test_copied_phrasing_is_blocked():
    guard.remember_context(SESSION, RETRIEVED)
    reason = guard.check_query("Kündigungsfrist Rahmenvertrag Müller GmbH Klausel 7.3", SESSION)
    assert reason is not None
    assert "internal documents" in reason


def test_reused_identifier_blocks_on_its_own():
    guard.remember_context(SESSION, RETRIEVED)
    # "7.3" is invisible to the bigram tokenizer (split into two 1-char tokens),
    # so the identifier rule is what has to catch it.
    assert guard.check_query("klausel 7.3", SESSION) is not None


def test_bare_years_are_not_identifiers():
    guard.remember_context(SESSION, RETRIEVED)
    # 2024 appears in the document, but blocking on a bare year would make
    # ordinary date-scoped research impossible.
    assert guard.check_query("EEG Novelle 2024", SESSION) is None


def test_public_topic_still_searchable():
    guard.remember_context(SESSION, RETRIEVED)
    # The generic version of the same question: no phrasing lifted from the doc.
    assert guard.check_query("EEG Förderung Photovoltaik 2026 Änderungen", SESSION) is None
    assert guard.check_query("Kündigungsfrist BGB Fristberechnung", SESSION) is None


def test_overlong_query_is_blocked_even_without_context():
    reason = guard.check_query("x " * 200, SESSION)
    assert reason is not None and "pasted content" in reason


def test_guard_is_scoped_to_its_own_session():
    guard.remember_context(SESSION, RETRIEVED)
    assert guard.check_query("Müller GmbH Klausel 7.3", "other-session") is None


def test_disabled_guard_allows_everything(monkeypatch):
    guard.remember_context(SESSION, RETRIEVED)
    monkeypatch.setattr(guard, "is_enabled", lambda: False)
    assert guard.check_query("Kündigungsfrist Rahmenvertrag Müller GmbH Klausel 7.3", SESSION) is None


def test_forget_clears_protection():
    guard.remember_context(SESSION, RETRIEVED)
    guard.forget_context(SESSION)
    assert guard.check_query("Kündigungsfrist Rahmenvertrag Müller GmbH Klausel 7.3", SESSION) is None


def test_session_store_is_bounded():
    for i in range(guard._MAX_SESSIONS + 25):
        guard.remember_context(f"s{i}", "irrelevant text")
    assert guard.stats()["sessions"] <= guard._MAX_SESSIONS


def test_enabled_by_default_when_settings_missing(monkeypatch):
    import src.settings as settings_mod

    monkeypatch.setattr(settings_mod, "get_setting", lambda k, d=None: d)
    importlib.reload(guard)  # drop the monkeypatched is_enabled from the fixture
    assert guard.is_enabled() is True


def test_search_refuses_before_any_request(monkeypatch):
    """The check must happen before the HTTP call — a blocked query that still
    reached SearxNG would already have reached Google."""
    import asyncio

    import src.web_search as ws

    ws_guard = importlib.import_module("src.web_leak_guard")
    ws_guard.remember_context(SESSION, RETRIEVED)
    monkeypatch.setattr(ws_guard, "is_enabled", lambda: True)

    def _explode(*a, **kw):
        raise AssertionError("an outbound request was made for a blocked query")

    monkeypatch.setattr(ws.httpx if hasattr(ws, "httpx") else importlib.import_module("httpx"),
                        "AsyncClient", _explode)
    result = asyncio.run(
        ws.search("Kündigungsfrist Rahmenvertrag Müller GmbH Klausel 7.3", session_id=SESSION)
    )
    assert result["exit_code"] == 1
    ws_guard.forget_context(SESSION)
