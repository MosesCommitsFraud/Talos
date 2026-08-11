"""get_news (src/news.py) — the second widget-emitting tool, and the SearxNG
request split it shares with web_search."""

import asyncio

from src import news as news_mod
from src.widgets import sanitize_widget

# ── helpers ──


def _searx_payload():
    return {
        "results": [
            {
                "url": "https://www.tagesschau.de/ausland/eu-ai-act-102.html",
                "title": "EU AI Act tritt in Kraft",
                "content": "Die   Verordnung  gilt\nab sofort für alle Anbieter.",
                "publishedDate": "2026-08-10T08:30:00+00:00",
                "engine": "google news",
            },
            {
                "url": "https://m.heise.de/news/ai-act-9999.html",
                "title": "Was der AI Act für Entwickler bedeutet",
                "content": "Analyse der Pflichten.",
                "publishedDate": "",
                "engine": "bing news",
            },
        ]
    }


def _install(monkeypatch, payload=None, picked=None, filtered=0, capture=None):
    """Stub the two web_search internals get_news builds on."""
    import src.web_search as ws

    async def _fake_request(**kwargs):
        if capture is not None:
            capture.update(kwargs)
        return {"payload": payload or _searx_payload(), "max_results": kwargs["max_results"]}

    def _fake_pick(pl, n):
        return (picked if picked is not None else (pl.get("results") or [])[:n], filtered)

    monkeypatch.setattr(ws, "_searx_request", _fake_request)
    monkeypatch.setattr(ws, "_pick_results", _fake_pick)


# ── article shaping ──


def test_source_name_strips_noise_prefixes():
    assert news_mod.source_name("https://www.tagesschau.de/x") == "tagesschau.de"
    assert news_mod.source_name("https://m.heise.de/x") == "heise.de"
    assert news_mod.source_name("https://news.ycombinator.com/x") == "ycombinator.com"
    # No host to read: fall back to the engine that produced the hit.
    assert news_mod.source_name("", "google news") == "google news"


def test_only_plausible_timestamps_survive():
    """The card renders relative ages, which it can only do from a real stamp.
    Engines vary, so anything unparseable is dropped rather than guessed at."""
    stamp = news_mod._published({"publishedDate": "2026-08-10T08:30:00+00:00"})
    assert stamp.startswith("2026-08-10")
    assert news_mod._published({"publishedDate": "gestern"}) == ""
    assert news_mod._published({"publishedDate": None}) == ""
    assert news_mod._published({}) == ""


def test_build_articles_normalises_rows():
    articles = news_mod.build_articles(_searx_payload()["results"])
    assert len(articles) == 2
    first = articles[0]
    assert first["source"] == "tagesschau.de"
    # Whitespace collapsed — a snippet with newlines breaks the card's clamp.
    assert first["snippet"] == "Die Verordnung gilt ab sofort für alle Anbieter."
    assert first["published"].startswith("2026-08-10")
    assert articles[1]["published"] == ""


def test_rows_without_a_url_are_dropped():
    articles = news_mod.build_articles([{"title": "Headline with nowhere to go", "url": ""}])
    assert articles == []


def test_snippets_and_titles_are_capped():
    articles = news_mod.build_articles(
        [{"url": "https://example.com/a", "title": "T" * 400, "content": "C" * 900}]
    )
    assert len(articles[0]["title"]) <= news_mod.TITLE_LIMIT + 1
    assert len(articles[0]["snippet"]) <= news_mod.SNIPPET_LIMIT + 1


def test_a_title_less_row_falls_back_to_its_url():
    articles = news_mod.build_articles([{"url": "https://example.com/a", "title": ""}])
    assert articles[0]["title"] == "https://example.com/a"


# ── get_news ──


def test_empty_query_is_an_error():
    result = asyncio.run(news_mod.get_news(query="   "))
    assert result["exit_code"] == 1
    assert "query" in result["error"]


def test_builds_output_and_widget(monkeypatch):
    _install(monkeypatch)
    result = asyncio.run(news_mod.get_news(query="EU AI Act"))

    assert result["exit_code"] == 0
    assert "EU AI Act tritt in Kraft" in result["output"]
    assert "tagesschau.de" in result["output"]
    # Without this the model re-lists the headlines under its own cards.
    assert "already displayed to the user" in result["output"]

    widget = result["widget"]
    assert widget["type"] == "news"
    assert [a["source"] for a in widget["data"]["articles"]] == ["tagesschau.de", "heise.de"]
    assert widget["data"]["query"] == "EU AI Act"
    assert sanitize_widget(widget) is not None


def test_no_articles_means_no_widget(monkeypatch):
    """An empty card stack is a worse answer than the sentence explaining that
    nothing came back."""
    _install(monkeypatch, picked=[])
    result = asyncio.run(news_mod.get_news(query="etwas sehr Obskures"))
    assert "widget" not in result
    assert "No news results" in result["output"]


def test_domain_policy_count_reaches_both_copies(monkeypatch):
    _install(monkeypatch, filtered=3)
    result = asyncio.run(news_mod.get_news(query="EU AI Act"))
    assert "3 further result(s) hidden" in result["output"]
    assert result["widget"]["data"]["hiddenByPolicy"] == 3


def test_defaults_and_clamping(monkeypatch):
    seen: dict = {}
    _install(monkeypatch, capture=seen)

    asyncio.run(news_mod.get_news(query="x"))
    # News goes stale in a way general search does not, so the window is narrow
    # by default and the category is pinned.
    assert seen["time_range"] == news_mod.DEFAULT_TIME_RANGE
    assert seen["category"] == "news"
    assert seen["max_results"] == news_mod.DEFAULT_ARTICLES

    asyncio.run(news_mod.get_news(query="x", max_results=500))
    assert seen["max_results"] == news_mod.MAX_ARTICLES
    asyncio.run(news_mod.get_news(query="x", max_results="lots"))
    assert seen["max_results"] == news_mod.DEFAULT_ARTICLES


def test_search_errors_pass_through_untouched(monkeypatch):
    """Including the leak-guard refusal — its wording is an instruction for the
    model and must not be replaced with a generic 'no news'."""
    import src.web_search as ws

    async def _refuse(**kwargs):
        return {"error": "Query looks like it contains document content.", "exit_code": 1}

    monkeypatch.setattr(ws, "_searx_request", _refuse)
    result = asyncio.run(news_mod.get_news(query="x"))
    assert result["exit_code"] == 1
    assert "document content" in result["error"]
    assert "widget" not in result


def test_session_id_is_forwarded_to_the_leak_guard(monkeypatch):
    seen: dict = {}
    _install(monkeypatch, capture=seen)
    asyncio.run(news_mod.get_news(query="x", session_id="sess-42"))
    assert seen["session_id"] == "sess-42"


# ── tool argument parsing ──


def test_bare_topic_is_accepted(monkeypatch):
    from src import tool_implementations as tool_impl

    seen: dict = {}

    async def _fake(query="", max_results=8, language="", time_range="week", session_id=""):
        seen.update(query=query, time_range=time_range)
        return {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(news_mod, "get_news", _fake)
    asyncio.run(tool_impl.do_get_news("EU AI Act"))
    assert seen["query"] == "EU AI Act"


def test_json_arguments_are_accepted(monkeypatch):
    from src import tool_implementations as tool_impl

    seen: dict = {}

    async def _fake(query="", max_results=8, language="", time_range="week", session_id=""):
        seen.update(query=query, max_results=max_results, language=language, time_range=time_range)
        return {"output": "ok", "exit_code": 0}

    monkeypatch.setattr(news_mod, "get_news", _fake)
    asyncio.run(
        tool_impl.do_get_news('{"query": "Bundestag", "language": "de", "time_range": "day"}')
    )
    assert (seen["query"], seen["language"], seen["time_range"]) == ("Bundestag", "de", "day")


# ── the split web_search still has to work through ──


def test_web_search_still_renders_markdown(monkeypatch):
    """`search` was refactored onto `_searx_request` + `_pick_results`; it must
    keep producing exactly what it did before."""
    import src.web_search as ws

    async def _fake_request(**kwargs):
        return {"payload": _searx_payload(), "max_results": 6}

    monkeypatch.setattr(ws, "_searx_request", _fake_request)
    result = asyncio.run(ws.search(query="EU AI Act"))
    assert "results" in result
    assert "EU AI Act tritt in Kraft" in result["results"]
    assert "https://www.tagesschau.de/ausland/eu-ai-act-102.html" in result["results"]


def test_pick_results_dedupes_by_url():
    from src.web_search import _pick_results

    payload = {
        "results": [
            {"url": "https://a.example/1"},
            {"url": "https://a.example/1"},
            {"url": "https://b.example/2"},
            {"url": ""},
        ]
    }
    picked, filtered = _pick_results(payload, 10)
    assert [p["url"] for p in picked] == ["https://a.example/1", "https://b.example/2"]
    assert filtered == 0


# ── wiring ──


def test_get_news_is_registered_end_to_end():
    from src.agent_loop import TOOL_SECTIONS
    from src.agent_tools import TOOL_TAGS
    from src.context_optimizer import NEVER_COMPRESS_TOOLS
    from src.history_replay import _RETRIEVAL_TOOLS
    from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_parsing import _TOOL_NAME_MAP
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS
    from src.tool_security import plan_mode_disabled_tools
    from src.widgets import WIDGET_TYPES

    assert "get_news" in TOOL_TAGS
    assert "get_news" in {s["function"]["name"] for s in FUNCTION_TOOL_SCHEMAS}
    assert "get_news" in BUILTIN_TOOL_DESCRIPTIONS
    assert "get_news" in TOOL_SECTIONS
    assert "get_news" in ALWAYS_AVAILABLE
    assert _TOOL_NAME_MAP["news"] == "get_news"
    assert _TOOL_NAME_MAP["nachrichten"] == "get_news"
    # Retrieval output: a compressor that drops the middle leaves entries that
    # read complete but have lost their URL.
    assert "get_news" in NEVER_COMPRESS_TOOLS
    assert "get_news" in _RETRIEVAL_TOOLS
    # Read-only lookup — usable while planning.
    assert "get_news" not in plan_mode_disabled_tools()
    assert "news" in WIDGET_TYPES


def test_widget_payload_is_not_echoed_into_model_context():
    from src.tool_execution import format_tool_result
    from src.widgets import make_widget

    text = format_tool_result(
        "get_news: EU AI Act",
        {
            "output": "1. **EU AI Act tritt in Kraft**",
            "widget": make_widget("news", {"articles": [{"title": "secret"}]}),
            "exit_code": 0,
        },
    )
    assert "EU AI Act" in text
    assert "secret" not in text
