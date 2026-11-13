"""Paid search providers: their answers, the fallback to SearxNG, and keys.

No provider is used unless an admin picked one and entered its key; a failing
provider must never leave the agent without search."""

import asyncio

import pytest

from src import search_providers as sp
from src import web_search


class _Resp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


def _client(status, data, seen):
    class Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, params=None, headers=None, **kw):
            seen.append(("GET", url, params, headers))
            return _Resp(status, data)

        async def post(self, url, json=None, headers=None, **kw):
            seen.append(("POST", url, json, headers))
            return _Resp(status, data)

    return Client


@pytest.fixture
def http(monkeypatch):
    import httpx

    seen = []

    def use(status, data):
        monkeypatch.setattr(httpx, "AsyncClient", _client(status, data, seen))

    return use, seen


def test_brave_answer_becomes_searxng_results(http):
    use, seen = http
    use(
        200,
        {
            "web": {
                "results": [
                    {
                        "title": "T",
                        "url": "https://a.de",
                        "description": "S",
                        "page_age": "2026-11-01",
                    }
                ]
            }
        },
    )
    out = asyncio.run(sp.provider_search("brave", {"api_key": "k1"}, "nis2", 5, "de", "week"))
    assert out["results"] == [
        {
            "title": "T",
            "url": "https://a.de",
            "content": "S",
            "publishedDate": "2026-11-01",
            "engine": "brave",
        }
    ]
    method, url, params, headers = seen[0]
    assert headers["X-Subscription-Token"] == "k1"
    assert params["freshness"] == "pw" and params["search_lang"] == "de"


def test_tavily_and_serper_answers(http):
    use, seen = http
    use(200, {"results": [{"title": "T", "url": "https://b.de", "content": "C"}], "answer": "42"})
    out = asyncio.run(sp.provider_search("tavily", {"api_key": "k2"}, "q", 5))
    assert out["results"][0]["url"] == "https://b.de" and out["answers"] == ["42"]
    assert seen[-1][3]["Authorization"] == "Bearer k2"

    use(
        200,
        {
            "organic": [{"title": "G", "link": "https://c.de", "snippet": "X"}],
            "answerBox": {"answer": "7"},
        },
    )
    out = asyncio.run(sp.provider_search("serper", {"api_key": "k3"}, "q", 5, "de", "day"))
    assert out["results"][0]["url"] == "https://c.de" and out["answers"] == ["7"]
    assert seen[-1][3]["X-API-KEY"] == "k3" and seen[-1][2]["tbs"] == "qdr:d"


@pytest.mark.parametrize("status", [401, 429, 500])
def test_a_failing_provider_raises_for_the_fallback(http, status):
    use, _ = http
    use(status, {})
    with pytest.raises(sp.ProviderError):
        asyncio.run(sp.provider_search("brave", {"api_key": "k"}, "q", 5))


@pytest.fixture
def settings(monkeypatch):
    values = {}
    from src import settings as settings_mod

    monkeypatch.setattr(settings_mod, "get_setting", lambda k, d=None: values.get(k, d))
    return values


def test_no_key_means_searxng(settings):
    settings["web_search_provider"] = "brave"
    assert sp.configured_provider() is None
    settings["web_search_brave_api_key"] = "secret"
    assert sp.configured_provider() == ("brave", {"api_key": "secret"})
    settings["web_search_provider"] = "searxng"
    assert sp.configured_provider() is None


def test_search_falls_back_to_searxng_when_the_provider_fails(monkeypatch):
    calls = []

    async def failing(*a, **kw):
        calls.append("provider")
        raise sp.ProviderError("quota")

    async def searx(**kw):
        calls.append("searxng")
        return {"payload": {"results": [{"title": "S", "url": "https://s.de"}]}, "max_results": 5}

    monkeypatch.setattr(sp, "configured_provider", lambda: ("brave", {"api_key": "k"}))
    monkeypatch.setattr(sp, "provider_search", failing)
    monkeypatch.setattr(web_search, "_searx_request", searx)
    monkeypatch.setattr(web_search, "_search_cache", {})
    from src import web_leak_guard

    monkeypatch.setattr(web_leak_guard, "check_query", lambda q, s: None)

    out = asyncio.run(web_search.search("frage"))
    assert calls == ["provider", "searxng"]
    assert "https://s.de" in out["results"]


def test_news_and_an_mcp_searxng_override_stay_on_searxng(monkeypatch):
    calls = []

    async def searx(**kw):
        calls.append(kw.get("category"))
        return {"payload": {"results": []}, "max_results": 5}

    monkeypatch.setattr(sp, "configured_provider", lambda: ("brave", {"api_key": "k"}))
    monkeypatch.setattr(web_search, "_searx_request", searx)
    asyncio.run(web_search.search("x", category="news"))
    asyncio.run(web_search.search("x", policy={"searxng_url": "http://other:8080"}))
    assert calls == ["news", ""]


def test_settings_route_encrypts_and_masks_the_key(monkeypatch):
    from routes import auth_routes

    masked = auth_routes._mask_search_keys(
        {"web_search_brave_api_key": "enc:abc", "web_search_tavily_api_key": ""}
    )
    assert masked["web_search_brave_api_key"] == auth_routes.SEARCH_KEY_MASK
    assert masked["web_search_tavily_api_key"] == ""
    # Non-admins get the scrubbed copy, which blanks *_api_key values.
    from src.settings_scrub import scrub_settings

    assert scrub_settings({"web_search_brave_api_key": "enc:abc"})["web_search_brave_api_key"] == ""


# One answer per provider, in the shape its API returns (taken from Open
# WebUI's provider code), and the URL that must come out of it.
_SAMPLES = {
    "brave_llm": (
        {"grounding": {"generic": [{"url": "https://u.de", "title": "T", "snippets": ["a", "b"]}]}},
        {"api_key": "k"},
    ),
    "google_pse": (
        {"items": [{"link": "https://u.de", "title": "T", "snippet": "S"}]},
        {"api_key": "k", "engine_id": "cx"},
    ),
    "kagi": (
        {"data": {"search": [{"url": "https://u.de", "title": "T", "snippet": "S"}]}},
        {"api_key": "k"},
    ),
    "mojeek": (
        {"response": {"results": [{"url": "https://u.de", "title": "T", "desc": "S"}]}},
        {"api_key": "k"},
    ),
    "exa": ({"results": [{"url": "https://u.de", "title": "T", "text": "S"}]}, {"api_key": "k"}),
    "jina": ({"data": [{"url": "https://u.de", "title": "T", "content": "S"}]}, {"api_key": "k"}),
    "linkup": (
        {"results": [{"url": "https://u.de", "name": "T", "content": "S"}]},
        {"api_key": "k"},
    ),
    "perplexity": (
        {"results": [{"url": "https://u.de", "title": "T", "snippet": "S"}]},
        {"api_key": "k"},
    ),
    "searchapi": (
        {"organic_results": [{"link": "https://u.de", "title": "T", "snippet": "S"}]},
        {"api_key": "k"},
    ),
    "serpapi": (
        {"organic_results": [{"link": "https://u.de", "title": "T", "position": 1}]},
        {"api_key": "k"},
    ),
    "serply": (
        {"results": [{"link": "https://u.de", "title": "T", "description": "S"}]},
        {"api_key": "k"},
    ),
    "serpstack": ({"organic_results": [{"url": "https://u.de", "title": "T"}]}, {"api_key": "k"}),
    "serphouse": (
        {"results": {"results": {"organic": [{"link": "https://u.de", "title": "T"}]}}},
        {"api_key": "k"},
    ),
    "youcom": (
        {
            "results": {
                "web": [
                    {"url": "https://u.de", "title": "T", "description": "D", "snippets": ["x"]}
                ]
            }
        },
        {"api_key": "k"},
    ),
    "staan": (
        {"web": {"results": [{"url": "https://u.de", "title": "T", "snippet": "S"}]}},
        {"api_key": "k"},
    ),
    "bocha": (
        {"data": {"webPages": {"value": [{"url": "https://u.de", "name": "T", "summary": "S"}]}}},
        {"api_key": "k"},
    ),
    "firecrawl": (
        {"data": {"web": [{"url": "https://u.de", "title": "T", "description": "S"}]}},
        {"api_key": "k"},
    ),
    "ollama": (
        {"results": [{"url": "https://u.de", "title": "T", "content": "S"}]},
        {"api_key": "k"},
    ),
    "microsoft_web_iq": (
        {"webResults": [{"url": "https://u.de", "title": "T", "content": "S"}]},
        {"api_key": "k"},
    ),
    "yacy": (
        {"channels": [{"items": [{"link": "https://u.de", "title": "T", "ranking": 1}]}]},
        {"url": "http://yacy:8090"},
    ),
    "openserp": (
        {"results": [{"url": "https://u.de", "title": "T", "snippet": "S"}]},
        {"url": "http://openserp:7000"},
    ),
    "external": (
        [{"link": "https://u.de", "title": "T", "snippet": "S"}],
        {"url": "https://search.example/x"},
    ),
}


@pytest.mark.parametrize("name", sorted(_SAMPLES))
def test_every_provider_maps_its_answer(http, name):
    use, _ = http
    data, cfg = _SAMPLES[name]
    use(200, data)
    out = asyncio.run(sp.provider_search(name, cfg, "frage", 5))
    assert out["results"] and out["results"][0]["url"] == "https://u.de"
    assert out["results"][0]["title"] == "T"


def test_yandex_reads_the_base64_xml(http):
    import base64

    xml = (
        "<yandexsearch><response><results><grouping><group><doc>"
        "<url>https://u.de</url><title>T <hlword>x</hlword></title>"
        "<passages><passage>S</passage></passages></doc></group></grouping></results>"
        "</response></yandexsearch>"
    )
    use, seen = http
    use(200, {"rawData": base64.b64encode(xml.encode()).decode()})
    out = asyncio.run(sp.provider_search("yandex", {"api_key": "k"}, "frage", 5))
    assert out["results"][0]["url"] == "https://u.de" and out["results"][0]["title"] == "T x"
    assert seen[-1][3]["Authorization"] == "Api-Key k"


def test_every_provider_is_tested_or_searxng():
    assert set(sp.PROVIDERS) == set(_SAMPLES) | {"searxng", "brave", "tavily", "serper", "yandex"}


def test_required_fields_decide_whether_a_provider_is_used(settings):
    settings["web_search_provider"] = "google_pse"
    settings["web_search_google_pse_api_key"] = "k"
    assert sp.configured_provider() is None  # the engine id is missing
    settings["web_search_google_pse_engine_id"] = "cx1"
    assert sp.configured_provider() == ("google_pse", {"api_key": "k", "engine_id": "cx1"})
    settings["web_search_provider"] = "yacy"  # free, needs only its URL
    assert sp.configured_provider() is None
    settings["web_search_yacy_url"] = "http://yacy:8090"
    name, cfg = sp.configured_provider()
    assert name == "yacy" and cfg["url"] == "http://yacy:8090"


def test_every_provider_setting_is_a_known_setting_and_secrets_are_scrubbed():
    from src.settings import DEFAULT_SETTINGS
    from src.settings_scrub import is_secret_key

    assert set(sp.ALL_SETTINGS) <= set(DEFAULT_SETTINGS)
    assert all(is_secret_key(s) for s in sp.SECRET_SETTINGS)
    # A field that is not a secret must not be blanked for its own users.
    assert not any(is_secret_key(s) for s in set(sp.ALL_SETTINGS) - set(sp.SECRET_SETTINGS))
