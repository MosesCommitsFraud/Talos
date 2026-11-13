"""Tests for ``src.web_search`` — the SearxNG-backed internet access.

Covers the three things that can silently go wrong:

* the SSRF guard on ``web_fetch`` (the app container can reach vLLM, Qdrant,
  Redis and the LAN — a fetched URL must never land there),
* SearxNG's JSON shape → markdown rendering, including the dedupe across
  engines and the "JSON format not enabled" failure mode,
* the argument parsing in the tool layer, which has to accept a bare query
  line as well as JSON because that is what models actually emit.
"""

import asyncio
import importlib

import pytest

web_search = importlib.import_module("src.web_search")
tool_impl = importlib.import_module("src.tool_implementations")


# ── SSRF guard ──


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:7000/admin",
        "http://127.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "file:///etc/passwd",
        "ftp://example.com/x",
    ],
)
def test_fetch_rejects_non_public_targets(url):
    assert web_search._validate_fetch_url(url) is not None


def test_fetch_rejects_unresolvable_host():
    # Fails closed: a host that doesn't resolve is not provably public.
    assert web_search._validate_fetch_url("https://no-such-host.invalid/") is not None


def test_private_ip_literals_are_not_public():
    for host in ("10.0.0.5", "192.168.10.91", "172.16.4.4", "127.0.0.1"):
        assert web_search._is_public_host(host) is False


def test_fetch_tool_refuses_internal_url():
    result = asyncio.run(web_search.fetch("http://192.168.10.91:8000/v1/models"))
    assert result["exit_code"] == 1
    assert "private" in result["error"]


# ── result formatting ──


def _payload(**overrides):
    base = {
        "results": [
            {
                "title": "Erste Quelle",
                "url": "https://example.com/a",
                "content": "Ein  Snippet   mit\nWhitespace.",
                "engine": "duckduckgo",
                "publishedDate": "2026-07-01T00:00:00",
            },
            # Same URL from a second engine — must not appear twice.
            {"title": "Erste Quelle", "url": "https://example.com/a", "engine": "google"},
            {"title": "Zweite Quelle", "url": "https://example.com/b", "content": "Mehr Text."},
        ]
    }
    base.update(overrides)
    return base


def test_format_dedupes_and_limits():
    out = web_search._format_search_results("test", _payload(), max_results=5)
    assert out.count("https://example.com/a") == 1
    assert "Zweite Quelle" in out
    # Whitespace in snippets is collapsed so results stay compact in context.
    assert "Ein Snippet mit Whitespace." in out


def test_format_respects_max_results():
    out = web_search._format_search_results("test", _payload(), max_results=1)
    assert "https://example.com/b" not in out


def test_format_surfaces_direct_answers():
    out = web_search._format_search_results("test", _payload(answers=["42"]), max_results=3)
    assert "Direct answer" in out and "42" in out


def test_format_handles_no_results():
    out = web_search._format_search_results(
        "test", {"results": [], "suggestions": ["anderes wort"]}, max_results=5
    )
    assert "No results" in out
    assert "anderes wort" in out
    # It names where searching ends instead of asking for more of it.
    assert "saying so is the answer" in out and "Try different wording" not in out


def test_an_empty_search_says_how_many_of_the_turn_found_nothing():
    from src import citations

    def search(session_id):
        return web_search._format_search_results(
            "test", {"results": []}, max_results=5, session_id=session_id
        )

    citations.begin_turn("s-empty")
    first, second, third, fourth = (search("s-empty") for _ in range(4))
    # A first response often sends two wordings at once; the count starts after.
    assert first == second and web_search.NO_RESULTS in first
    assert "3 searches without a result" in third and "4 searches" in fourth
    # A search that finds something is not counted.
    web_search._format_search_results("test", _payload(), max_results=5, session_id="s-empty")
    assert "5 searches" in search("s-empty")

    citations.begin_turn("s-empty")  # the next turn starts over
    assert web_search.NO_RESULTS in search("s-empty")
    # Outside a turn (the MCP server) nothing is counted.
    assert all(web_search.NO_RESULTS in search("") for _ in range(4))


def test_a_blocked_search_says_blocked_not_that_the_web_has_nothing():
    """2026-11-12: every engine CAPTCHA'd the server IP, and "No results … the web
    has nothing on this" made the model tell users facts did not exist."""
    payload = {
        "results": [],
        "unresponsive_engines": [
            ["duckduckgo", "CAPTCHA"],
            ["brave", "too many requests"],
            ["wikipedia", "timeout"],
        ],
    }
    out = web_search._format_search_results("NIS2", payload, max_results=5)
    assert "unavailable right now" in out
    assert "duckduckgo (CAPTCHA)" in out and "brave (too many requests)" in out
    assert "wikipedia" not in out  # a timeout is not a refusal
    assert web_search.NO_RESULTS not in out


def test_engines_that_only_timed_out_still_read_as_no_results():
    payload = {"results": [], "unresponsive_engines": [["wikipedia", "timeout"]]}
    out = web_search._format_search_results("x", payload, max_results=5)
    assert "No results" in out


class _FakeSearx:
    """Stands in for httpx.AsyncClient against SearxNG, counting requests."""

    calls = 0
    active = 0
    peak = 0
    payload: dict = {}

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        cls = type(self)
        cls.calls += 1
        cls.active += 1
        cls.peak = max(cls.peak, cls.active)
        await asyncio.sleep(0.05)
        cls.active -= 1

        class Resp:
            status_code = 200

            @staticmethod
            def json():
                return cls.payload

        return Resp()


@pytest.fixture
def fake_searx(monkeypatch):
    import httpx

    class Fake(_FakeSearx):
        calls = active = peak = 0
        payload = _payload()

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    monkeypatch.setattr(web_search, "get_searxng_url", lambda policy=None: "http://searx")
    monkeypatch.setattr(web_search, "SEARCH_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(web_search, "_search_cache", {})
    monkeypatch.setattr(web_search, "_search_gate", None)
    from src import web_leak_guard

    monkeypatch.setattr(web_leak_guard, "check_query", lambda q, s: None)
    return Fake


def _request(query):
    return web_search._searx_request(query, 5, "", "", "", 1, "")


def test_a_repeated_query_is_answered_from_the_cache(fake_searx):
    async def run():
        await _request("cloud rechenzentrum")
        await _request("cloud rechenzentrum")
        await _request("anderes thema")

    asyncio.run(run())
    assert fake_searx.calls == 2


def test_an_empty_answer_is_not_cached(fake_searx):
    fake_searx.payload = {"results": [], "unresponsive_engines": [["brave", "too many requests"]]}

    async def run():
        await _request("x")
        await _request("x")

    asyncio.run(run())
    assert fake_searx.calls == 2


def test_parallel_searches_are_throttled(fake_searx, monkeypatch):
    monkeypatch.setattr(web_search, "SEARCH_CONCURRENCY", 2)

    async def run():
        await asyncio.gather(*(_request(f"frage {i}") for i in range(8)))

    asyncio.run(run())
    assert fake_searx.calls == 8
    assert fake_searx.peak == 2


# ── tool-layer argument parsing ──


def test_empty_query_is_rejected_without_calling_out():
    result = asyncio.run(tool_impl.do_web_search(""))
    assert result["exit_code"] == 1


def test_bare_query_line_is_accepted(monkeypatch):
    seen = {}

    async def _fake_search(**kwargs):
        seen.update(kwargs)
        return {"results": "ok"}

    monkeypatch.setattr(web_search, "search", _fake_search)
    asyncio.run(tool_impl.do_web_search("aktuelle Nachrichten Photovoltaik"))
    assert seen["query"] == "aktuelle Nachrichten Photovoltaik"


def test_json_args_are_passed_through(monkeypatch):
    seen = {}

    async def _fake_search(**kwargs):
        seen.update(kwargs)
        return {"results": "ok"}

    monkeypatch.setattr(web_search, "search", _fake_search)
    asyncio.run(
        tool_impl.do_web_search('{"query": "solar", "language": "de", "time_range": "week"}')
    )
    assert seen["query"] == "solar"
    assert seen["language"] == "de"
    assert seen["time_range"] == "week"


def test_bare_url_line_is_accepted(monkeypatch):
    seen = {}

    async def _fake_fetch(**kwargs):
        seen.update(kwargs)
        return {"results": "ok"}

    monkeypatch.setattr(web_search, "fetch", _fake_fetch)
    asyncio.run(tool_impl.do_web_fetch("https://example.com/article"))
    assert seen["url"] == "https://example.com/article"


# ── wiring ──


def test_tools_are_registered_end_to_end():
    from src.agent_tools import TOOL_TAGS
    from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    schema_names = {s["function"]["name"] for s in FUNCTION_TOOL_SCHEMAS}
    for name in ("web_search", "web_fetch"):
        assert name in TOOL_TAGS
        assert name in schema_names
        assert name in BUILTIN_TOOL_DESCRIPTIONS
        # Internet access is never gated behind tool retrieval.
        assert name in ALWAYS_AVAILABLE


# ── domain policy ──


@pytest.fixture
def domains(monkeypatch):
    """Drive the admin allow/block lists without touching data/settings.json."""
    state = {"web_domain_allowlist": [], "web_domain_blocklist": []}

    def _fake_get_setting(key, default=None):
        return state.get(key, default)

    import src.settings as settings_mod

    monkeypatch.setattr(settings_mod, "get_setting", _fake_get_setting)
    return state


def test_no_lists_allows_everything(domains):
    assert web_search.check_domain("example.com") is None


def test_blocklist_blocks_domain_and_subdomains(domains):
    domains["web_domain_blocklist"] = ["facebook.com"]
    assert web_search.check_domain("facebook.com") is not None
    assert web_search.check_domain("m.facebook.com") is not None
    # A domain that merely ends with the same letters is not a subdomain.
    assert web_search.check_domain("notfacebook.com") is None


def test_allowlist_is_exclusive_when_set(domains):
    domains["web_domain_allowlist"] = ["wikipedia.org", "https://docs.python.org/3/"]
    assert web_search.check_domain("de.wikipedia.org") is None
    assert web_search.check_domain("docs.python.org") is None
    assert web_search.check_domain("example.com") is not None


def test_blocklist_wins_over_allowlist(domains):
    domains["web_domain_allowlist"] = ["example.com"]
    domains["web_domain_blocklist"] = ["intranet.example.com"]
    assert web_search.check_domain("intranet.example.com") is not None


@pytest.mark.parametrize(
    "entry,expected",
    [
        ("https://Example.com/path?q=1", "example.com"),
        ("*.example.com", "example.com"),
        ("user@example.com:8443", "example.com"),
        ("  example.com.  ", "example.com"),
    ],
)
def test_domain_normalization(entry, expected):
    assert web_search._normalize_domain(entry) == expected


def test_blocked_results_are_filtered_out(domains):
    domains["web_domain_blocklist"] = ["example.com"]
    out = web_search._format_search_results("test", _payload(), max_results=5)
    assert "https://example.com/a" not in out
    assert "domain policy" in out


def test_fetch_refuses_blocked_domain(domains):
    domains["web_domain_blocklist"] = ["example.com"]
    assert "blocked-domain" in (web_search._validate_fetch_url("https://example.com/x") or "")


def test_html_extraction_strips_chrome():
    pytest.importorskip("bs4")
    title, text = web_search._extract_readable(
        "<html><head><title>Titel</title></head><body><nav>Menü</nav>"
        "<article><p>Der Inhalt.</p></article><script>evil()</script></body></html>"
    )
    assert title == "Titel"
    assert "Der Inhalt." in text
    assert "Menü" not in text and "evil" not in text
