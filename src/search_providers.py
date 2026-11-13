"""Web-search providers other than SearxNG.

SearxNG scrapes the public engines from the server's own IP, and bursts of
agent searches get that IP CAPTCHA'd or rate limited (2026-11-12: every engine
at once, for hours). An API provider answers under a contract instead. Which
one is used is an admin setting (Settings -> Internetzugriff):
``web_search_provider`` plus that provider's fields. SearxNG stays the default;
a provider whose required fields are empty is not used, so nothing here costs
money unless an admin enters a key.

The set follows Open WebUI's web-search providers (its
backend/open_webui/retrieval/web/), with the request and response formats
taken from there. Left out: Bing (Microsoft retired the Bing Search APIs in
2025), Azure AI Search (searches your own index, not the web), Sougou (needs
Tencent's SDK), DuckDuckGo via the ddgs library (scrapes like SearxNG, which
already covers it) and Perplexity's chat endpoint (an LLM answer, not a
search; Perplexity's Search API is in).

Every answer is turned into SearxNG's JSON shape (``results`` with
title/url/content/publishedDate/engine, optional ``answers``), so rendering,
domain policy and citations in src/web_search.py work unchanged. A provider
that fails raises ProviderError and the caller falls back to SearxNG.
"""

import base64
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from xml.etree import ElementTree

logger = logging.getLogger(__name__)

PROVIDER_TIMEOUT = 30.0
TIME_RANGES = {"day", "week", "month", "year"}


class ProviderError(Exception):
    """The provider could not answer; the caller falls back to SearxNG."""


@dataclass(frozen=True)
class Field:
    """One setting a provider needs. `kind` picks the label in the UI:
    api_key, url, engine_id, engine, domain, username, password, config."""

    setting: str
    kind: str
    required: bool = False
    secret: bool = False
    placeholder: str = ""


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    call: Optional[Callable[..., Awaitable[Dict[str, Any]]]]
    fields: Tuple[Field, ...] = field(default_factory=tuple)
    paid: bool = True


def _key(provider_id: str, required: bool = True) -> Field:
    return Field(f"web_search_{provider_id}_api_key", "api_key", required=required, secret=True)


def _url(provider_id: str, placeholder: str, required: bool = False) -> Field:
    return Field(f"web_search_{provider_id}_url", "url", required=required, placeholder=placeholder)


def _result(title: Any, url: Any, content: Any, published: Any, engine: str) -> Dict[str, Any]:
    return {
        "title": str(title or ""),
        "url": str(url or ""),
        "content": str(content or ""),
        "publishedDate": str(published or ""),
        "engine": engine,
    }


def _lang(language: str) -> str:
    return (language or "").split("-")[0].lower()


def _check(resp, label: str) -> None:
    if resp.status_code in (401, 403):
        raise ProviderError(f"{label} rejected the credentials (HTTP {resp.status_code})")
    if resp.status_code == 402:
        raise ProviderError(f"{label}: payment required / credits used up (HTTP 402)")
    if resp.status_code == 429:
        raise ProviderError(f"{label} quota or rate limit reached (HTTP 429)")
    if resp.status_code >= 400:
        raise ProviderError(f"{label} returned HTTP {resp.status_code}")


def _json(resp, label: str) -> Any:
    _check(resp, label)
    try:
        return resp.json()
    except Exception as exc:
        raise ProviderError(f"{label} did not return JSON") from exc


# ── The calls. Each gets (client, cfg, query, n, language, time_range, page). ──


async def _brave(client, cfg, q, n, language, time_range, page):
    params: Dict[str, Any] = {"q": q, "count": min(n, 20), "offset": max(0, min(page - 1, 9))}
    if _lang(language):
        params["search_lang"] = _lang(language)
    freshness = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}.get(time_range)
    if freshness:
        params["freshness"] = freshness
    resp = await client.get(
        "https://api.search.brave.com/res/v1/web/search",
        params=params,
        headers={"Accept": "application/json", "X-Subscription-Token": cfg["api_key"]},
    )
    data = _json(resp, "Brave")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("description"), r.get("page_age"), "brave")
            for r in ((data.get("web") or {}).get("results") or [])
        ]
    }


async def _brave_llm(client, cfg, q, n, language, time_range, page):
    resp = await client.get(
        "https://api.search.brave.com/res/v1/llm/context",
        params={"q": q, "count": min(n, 20), "maximum_number_of_tokens": 8192},
        headers={"Accept": "application/json", "X-Subscription-Token": cfg["api_key"]},
    )
    data = _json(resp, "Brave LLM Context")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), "\n\n".join(r.get("snippets") or []), "", "brave")
            for r in ((data.get("grounding") or {}).get("generic") or [])
        ]
    }


async def _tavily(client, cfg, q, n, language, time_range, page):
    body: Dict[str, Any] = {"query": q, "max_results": min(n, 20), "search_depth": "basic"}
    if time_range in TIME_RANGES:
        body["time_range"] = time_range
    resp = await client.post(
        "https://api.tavily.com/search",
        json=body,
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Tavily")
    out: Dict[str, Any] = {
        "results": [
            _result(
                r.get("title"), r.get("url"), r.get("content"), r.get("published_date"), "tavily"
            )
            for r in (data.get("results") or [])
        ]
    }
    if data.get("answer"):
        out["answers"] = [str(data["answer"])]
    return out


async def _serper(client, cfg, q, n, language, time_range, page):
    body: Dict[str, Any] = {"q": q, "num": min(n, 20), "page": max(1, page)}
    if _lang(language):
        body["hl"] = _lang(language)
    tbs = {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}.get(time_range)
    if tbs:
        body["tbs"] = tbs
    resp = await client.post(
        "https://google.serper.dev/search",
        json=body,
        headers={"X-API-KEY": cfg["api_key"], "Content-Type": "application/json"},
    )
    data = _json(resp, "Serper")
    out: Dict[str, Any] = {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("snippet"), r.get("date"), "serper")
            for r in (data.get("organic") or [])
        ]
    }
    box = data.get("answerBox") or {}
    if box.get("answer") or box.get("snippet"):
        out["answers"] = [str(box.get("answer") or box.get("snippet"))]
    return out


async def _google_pse(client, cfg, q, n, language, time_range, page):
    # At most 10 per request; `start` is 1-based.
    params: Dict[str, Any] = {
        "key": cfg["api_key"],
        "cx": cfg["engine_id"],
        "q": q,
        "num": min(n, 10),
        "start": 1 + 10 * (max(1, page) - 1),
    }
    if _lang(language):
        params["lr"] = f"lang_{_lang(language)}"
    restrict = {"day": "d1", "week": "w1", "month": "m1", "year": "y1"}.get(time_range)
    if restrict:
        params["dateRestrict"] = restrict
    resp = await client.get("https://www.googleapis.com/customsearch/v1", params=params)
    data = _json(resp, "Google PSE")
    return {
        "results": [
            _result(i.get("title"), i.get("link"), i.get("snippet"), "", "google_pse")
            for i in (data.get("items") or [])
        ]
    }


async def _kagi(client, cfg, q, n, language, time_range, page):
    resp = await client.post(
        "https://kagi.com/api/v1/search",
        json={"query": q, "limit": n},
        headers={"Authorization": f"Bearer {cfg['api_key']}"},
    )
    data = _json(resp, "Kagi")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("snippet"), r.get("published"), "kagi")
            for r in ((data.get("data") or {}).get("search") or [])
            if r.get("url")
        ]
    }


async def _mojeek(client, cfg, q, n, language, time_range, page):
    params: Dict[str, Any] = {"q": q, "api_key": cfg["api_key"], "fmt": "json", "t": n}
    resp = await client.get(
        "https://api.mojeek.com/search", params=params, headers={"Accept": "application/json"}
    )
    data = _json(resp, "Mojeek")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("desc"), r.get("date"), "mojeek")
            for r in ((data.get("response") or {}).get("results") or [])
        ]
    }


async def _exa(client, cfg, q, n, language, time_range, page):
    resp = await client.post(
        "https://api.exa.ai/search",
        json={
            "query": q,
            "numResults": n,
            "type": "auto",
            "contents": {"text": {"maxCharacters": 1000}},
        },
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Exa")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("text"), r.get("publishedDate"), "exa")
            for r in (data.get("results") or [])
        ]
    }


async def _jina(client, cfg, q, n, language, time_range, page):
    resp = await client.post(
        cfg.get("url") or "https://s.jina.ai/",
        json={"q": q, "count": min(n, 10)},
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": cfg["api_key"],
            "X-Retain-Images": "none",
        },
    )
    data = _json(resp, "Jina")
    return {
        "results": [
            _result(
                r.get("title"),
                r.get("url"),
                r.get("description") or r.get("content"),
                r.get("date"),
                "jina",
            )
            for r in (data.get("data") or [])
        ]
    }


async def _linkup(client, cfg, q, n, language, time_range, page):
    resp = await client.post(
        "https://api.linkup.so/v1/search",
        json={"q": q, "depth": "standard", "outputType": "searchResults", "maxResults": n},
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Linkup")
    items = data.get("results") or data.get("sources") or []
    return {
        "results": [
            _result(
                r.get("name") or r.get("title"),
                r.get("url"),
                r.get("content") or r.get("text") or r.get("snippet"),
                "",
                "linkup",
            )
            for r in items
        ]
    }


async def _perplexity(client, cfg, q, n, language, time_range, page):
    resp = await client.post(
        "https://api.perplexity.ai/search",
        json={"query": q, "max_results": min(n, 20)},
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Perplexity")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("snippet"), r.get("date"), "perplexity")
            for r in (data.get("results") or [])
        ]
    }


async def _searchapi(client, cfg, q, n, language, time_range, page):
    engine = cfg.get("engine") or "google"
    params: Dict[str, Any] = {
        "engine": engine,
        "q": q,
        "api_key": cfg["api_key"],
        "page": max(1, page),
    }
    if engine.startswith("google"):
        params["link"] = "resolved"
    if _lang(language):
        params["hl"] = _lang(language)
    resp = await client.get("https://www.searchapi.io/api/v1/search", params=params)
    data = _json(resp, "SearchApi")
    items = [*(data.get("organic_results") or []), *(data.get("top_stories") or [])]
    return {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("snippet"), r.get("date"), "searchapi")
            for r in items[:n]
        ]
    }


async def _serpapi(client, cfg, q, n, language, time_range, page):
    params: Dict[str, Any] = {
        "engine": cfg.get("engine") or "google",
        "q": q,
        "api_key": cfg["api_key"],
    }
    if _lang(language):
        params["hl"] = _lang(language)
    resp = await client.get("https://serpapi.com/search", params=params)
    data = _json(resp, "SerpApi")
    items = sorted(data.get("organic_results") or [], key=lambda x: x.get("position", 0))
    return {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("snippet"), r.get("date"), "serpapi")
            for r in items[:n]
        ]
    }


async def _serply(client, cfg, q, n, language, time_range, page):
    from urllib.parse import urlencode

    lang = _lang(language) or "en"
    query = urlencode({"q": q, "language": lang, "num": min(n, 100), "hl": lang})
    resp = await client.get(
        f"https://api.serply.io/v1/search/{query}",
        headers={"X-API-KEY": cfg["api_key"], "X-User-Agent": "desktop"},
    )
    data = _json(resp, "Serply")
    items = sorted(data.get("results") or [], key=lambda x: x.get("realPosition", 0))
    return {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("description"), "", "serply")
            for r in items[:n]
        ]
    }


async def _serpstack(client, cfg, q, n, language, time_range, page):
    resp = await client.get(
        "https://api.serpstack.com/search",
        params={"access_key": cfg["api_key"], "query": q, "num": min(n, 100), "page": max(1, page)},
    )
    data = _json(resp, "serpstack")
    if isinstance(data, dict) and data.get("success") is False:
        raise ProviderError(f"serpstack: {(data.get('error') or {}).get('info', 'request failed')}")
    items = sorted(data.get("organic_results") or [], key=lambda x: x.get("position", 0))
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("snippet"), "", "serpstack")
            for r in items[:n]
        ]
    }


async def _serphouse(client, cfg, q, n, language, time_range, page):
    resp = await client.get(
        "https://api.serphouse.com/serp/live",
        params={
            "q": q,
            "domain": cfg.get("domain") or "google.com",
            "device": "desktop",
            "serp_type": "web",
            "page": max(1, page),
            "num_result": n,
        },
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Accept": "application/json"},
    )
    data = _json(resp, "SERPHouse")
    organic = (((data.get("results") or {}).get("results")) or {}).get("organic") or []
    organic = sorted(organic, key=lambda x: x.get("position", 0))
    return {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("snippet"), "", "serphouse")
            for r in organic[:n]
            if r.get("link")
        ]
    }


async def _youcom(client, cfg, q, n, language, time_range, page):
    resp = await client.get(
        "https://ydc-index.io/v1/search",
        params={"query": q, "count": n, "language": (_lang(language) or "en").upper()},
        headers={"Accept": "application/json", "X-API-KEY": cfg["api_key"]},
    )
    data = _json(resp, "You.com")
    out = []
    for r in ((data.get("results") or {}).get("web") or [])[:n]:
        parts = [r.get("description") or "", *(r.get("snippets") or [])]
        out.append(
            _result(
                r.get("title"),
                r.get("url"),
                "\n\n".join(p for p in parts if p),
                r.get("page_age"),
                "youcom",
            )
        )
    return {"results": out}


async def _staan(client, cfg, q, n, language, time_range, page):
    resp = await client.get(
        "https://api.staan.ai/v2/search/web",
        params={"q": q},
        headers={"Accept": "application/json", "Authorization": f"Bearer {cfg['api_key']}"},
    )
    data = _json(resp, "Staan")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("snippet"), "", "staan")
            for r in ((data.get("web") or {}).get("results") or [])[:n]
        ]
    }


async def _bocha(client, cfg, q, n, language, time_range, page):
    freshness = {"day": "oneDay", "week": "oneWeek", "month": "oneMonth", "year": "oneYear"}.get(
        time_range, "noLimit"
    )
    resp = await client.post(
        "https://api.bochaai.com/v1/web-search",
        json={"query": q, "summary": True, "freshness": freshness, "count": n},
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Bocha")
    pages = (((data.get("data") or {}).get("webPages")) or {}).get("value") or []
    return {
        "results": [
            _result(
                r.get("name"),
                r.get("url"),
                r.get("summary") or r.get("snippet"),
                r.get("datePublished") or r.get("dateLastCrawled"),
                "bocha",
            )
            for r in pages[:n]
        ]
    }


async def _firecrawl(client, cfg, q, n, language, time_range, page):
    base = (cfg.get("url") or "https://api.firecrawl.dev").rstrip("/")
    url = f"{base}/search" if base.endswith("/v2") else f"{base}/v2/search"
    resp = await client.post(
        url,
        json={"query": q, "limit": n, "timeout": n * 3000, "ignoreInvalidURLs": True},
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Firecrawl").get("data") or {}
    items = data if isinstance(data, list) else (data.get("web") or [])
    out = []
    for r in items[:n]:
        meta = r.get("metadata") or {}
        link = r.get("url") or meta.get("sourceURL") or meta.get("url")
        if link:
            out.append(
                _result(
                    r.get("title") or meta.get("title"),
                    link,
                    r.get("description") or r.get("snippet") or meta.get("description"),
                    "",
                    "firecrawl",
                )
            )
    return {"results": out}


async def _ollama(client, cfg, q, n, language, time_range, page):
    base = (cfg.get("url") or "https://ollama.com").rstrip("/")
    resp = await client.post(
        f"{base}/api/web_search",
        json={"query": q, "max_results": min(n, 10)},
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
    )
    data = _json(resp, "Ollama")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("content"), "", "ollama")
            for r in (data.get("results") or [])
        ]
    }


async def _web_iq(client, cfg, q, n, language, time_range, page):
    base = (cfg.get("url") or "https://api.microsoft.ai/v3").rstrip("/")
    resp = await client.post(
        f"{base}/search/web",
        json={
            "query": q,
            "maxResults": n,
            "language": _lang(language) or "en",
            "contentFormat": "passage",
        },
        headers={"x-apikey": cfg["api_key"], "content-type": "application/json"},
    )
    data = _json(resp, "Microsoft Web IQ")
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("content"), "", "microsoft_web_iq")
            for r in (data.get("webResults") or [])
        ]
    }


def _xml_text(element) -> str:
    if element is None:
        return ""
    parts = [element.text or ""]
    for child in element:
        parts.append(_xml_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


async def _yandex(client, cfg, q, n, language, time_range, page):
    payload: Dict[str, Any] = {}
    if cfg.get("config"):
        try:
            payload = json.loads(cfg["config"])
        except ValueError as exc:
            raise ProviderError("Yandex: the extra JSON settings are not valid JSON") from exc
    query = payload.get("query") if isinstance(payload.get("query"), dict) else {}
    query.setdefault("searchType", "SEARCH_TYPE_COM")
    query["queryText"] = q
    payload["query"] = query
    group = payload.get("groupSpec") if isinstance(payload.get("groupSpec"), dict) else {}
    group.setdefault("groupMode", "GROUP_MODE_DEEP")
    group["groupsOnPage"] = n
    group["docsInGroup"] = 1
    payload["groupSpec"] = group
    resp = await client.post(
        cfg.get("url") or "https://searchapi.api.cloud.yandex.net/v2/web/search",
        json=payload,
        headers={"Authorization": f"Api-Key {cfg['api_key']}"},
    )
    body = _json(resp, "Yandex")
    if "rawData" not in body:
        raise ProviderError("Yandex answered without rawData")
    try:
        root = ElementTree.fromstring(base64.b64decode(body["rawData"]))
    except Exception as exc:
        raise ProviderError("Yandex: could not read the result XML") from exc
    out = []
    for g in root.findall("response/results/grouping/group"):
        out.append(
            _result(
                _xml_text(g.find("doc/title")).strip(),
                _xml_text(g.find("doc/url")).strip(),
                _xml_text(g.find("doc/passages/passage")).strip(),
                "",
                "yandex",
            )
        )
    return {"results": out[:n]}


async def _yacy(client, cfg, q, n, language, time_range, page):
    import httpx

    url = cfg["url"].rstrip("/")
    if not url.endswith("yacysearch.json"):
        url += "/yacysearch.json"
    auth = None
    if cfg.get("username") or cfg.get("password"):
        auth = httpx.DigestAuth(cfg.get("username") or "", cfg.get("password") or "")
    resp = await client.get(
        url,
        params={
            "query": q,
            "contentdom": "text",
            "resource": "global",
            "maximumRecords": n,
            "nav": "none",
        },
        auth=auth,
    )
    data = _json(resp, "YaCy")
    items = ((data.get("channels") or [{}])[0] or {}).get("items") or []
    items = sorted(items, key=lambda x: x.get("ranking", 0), reverse=True)
    return {
        "results": [
            _result(r.get("title"), r.get("link"), r.get("description"), r.get("pubDate"), "yacy")
            for r in items[:n]
        ]
    }


async def _openserp(client, cfg, q, n, language, time_range, page):
    resp = await client.get(f"{cfg['url'].rstrip('/')}/mega/search", params={"text": q, "limit": n})
    data = _json(resp, "OpenSERP")
    items = data.get("results") if isinstance(data, dict) else data
    return {
        "results": [
            _result(r.get("title"), r.get("url"), r.get("snippet"), "", "openserp")
            for r in (items or [])[:n]
        ]
    }


async def _external(client, cfg, q, n, language, time_range, page):
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    resp = await client.post(cfg["url"], json={"query": q, "count": n}, headers=headers)
    data = _json(resp, "External search")
    items = data if isinstance(data, list) else (data.get("results") or [])
    return {
        "results": [
            _result(r.get("title"), r.get("link") or r.get("url"), r.get("snippet"), "", "external")
            for r in items[:n]
        ]
    }


# ── Registry ──

PROVIDER_LIST: Tuple[Provider, ...] = (
    Provider("searxng", "SearxNG", None, paid=False),
    Provider("brave", "Brave Search API", _brave, (_key("brave"),)),
    Provider(
        "brave_llm",
        "Brave LLM Context",
        _brave_llm,
        (Field("web_search_brave_api_key", "api_key", required=True, secret=True),),
    ),
    Provider("tavily", "Tavily", _tavily, (_key("tavily"),)),
    Provider("serper", "Serper (Google)", _serper, (_key("serper"),)),
    Provider(
        "google_pse",
        "Google Programmable Search",
        _google_pse,
        (_key("google_pse"), Field("web_search_google_pse_engine_id", "engine_id", required=True)),
    ),
    Provider("kagi", "Kagi", _kagi, (_key("kagi"),)),
    Provider("mojeek", "Mojeek", _mojeek, (_key("mojeek"),)),
    Provider("exa", "Exa", _exa, (_key("exa"),)),
    Provider("jina", "Jina Search", _jina, (_key("jina"), _url("jina", "https://s.jina.ai/"))),
    Provider("linkup", "Linkup", _linkup, (_key("linkup"),)),
    Provider("perplexity", "Perplexity Search API", _perplexity, (_key("perplexity"),)),
    Provider(
        "searchapi",
        "SearchApi",
        _searchapi,
        (_key("searchapi"), Field("web_search_searchapi_engine", "engine", placeholder="google")),
    ),
    Provider(
        "serpapi",
        "SerpApi",
        _serpapi,
        (_key("serpapi"), Field("web_search_serpapi_engine", "engine", placeholder="google")),
    ),
    Provider("serply", "Serply", _serply, (_key("serply"),)),
    Provider("serpstack", "serpstack", _serpstack, (_key("serpstack"),)),
    Provider(
        "serphouse",
        "SERPHouse",
        _serphouse,
        (
            _key("serphouse"),
            Field("web_search_serphouse_domain", "domain", placeholder="google.com"),
        ),
    ),
    Provider("youcom", "You.com", _youcom, (_key("youcom"),)),
    Provider("staan", "Staan", _staan, (_key("staan"),)),
    Provider("bocha", "Bocha", _bocha, (_key("bocha"),)),
    Provider(
        "firecrawl",
        "Firecrawl",
        _firecrawl,
        (_key("firecrawl"), _url("firecrawl", "https://api.firecrawl.dev")),
    ),
    Provider(
        "ollama",
        "Ollama Web Search",
        _ollama,
        (_key("ollama"), _url("ollama", "https://ollama.com")),
    ),
    Provider(
        "microsoft_web_iq",
        "Microsoft Web IQ",
        _web_iq,
        (_key("microsoft_web_iq"), _url("microsoft_web_iq", "https://api.microsoft.ai/v3")),
    ),
    Provider(
        "yandex",
        "Yandex Search API",
        _yandex,
        (
            _key("yandex"),
            _url("yandex", "https://searchapi.api.cloud.yandex.net/v2/web/search"),
            Field("web_search_yandex_config", "config", placeholder='{"folderId": "…"}'),
        ),
    ),
    Provider(
        "yacy",
        "YaCy (self-hosted)",
        _yacy,
        (
            _url("yacy", "http://yacy:8090", required=True),
            Field("web_search_yacy_username", "username"),
            Field("web_search_yacy_password", "password", secret=True),
        ),
        paid=False,
    ),
    Provider(
        "openserp",
        "OpenSERP (self-hosted)",
        _openserp,
        (_url("openserp", "http://openserp:7000", required=True),),
        paid=False,
    ),
    Provider(
        "external",
        "External search endpoint",
        _external,
        (
            _url("external", "https://search.example.com/search", required=True),
            _key("external", required=False),
        ),
        paid=False,
    ),
)
PROVIDERS: Dict[str, Provider] = {p.id: p for p in PROVIDER_LIST}

# Every setting a provider reads; the secret ones are stored encrypted and
# never sent back to the browser (routes/auth_routes.py).
ALL_SETTINGS: Tuple[str, ...] = tuple(
    dict.fromkeys(f.setting for p in PROVIDER_LIST for f in p.fields)
)
SECRET_SETTINGS: Tuple[str, ...] = tuple(
    dict.fromkeys(f.setting for p in PROVIDER_LIST for f in p.fields if f.secret)
)


def default_settings() -> Dict[str, Any]:
    """The provider settings and their defaults, for src/settings.py."""
    return {"web_search_provider": "searxng", **{s: "" for s in ALL_SETTINGS}}


def _field_name(f: Field) -> str:
    return f.kind


def configured_provider() -> Optional[Tuple[str, Dict[str, str]]]:
    """(provider id, its settings by field kind) when an admin chose a
    provider other than SearxNG and filled in what it needs, else None."""
    try:
        from src.secret_storage import decrypt
        from src.settings import get_setting
    except Exception:
        return None
    name = str(get_setting("web_search_provider", "searxng") or "searxng").strip().lower()
    provider = PROVIDERS.get(name)
    if provider is None or provider.call is None:
        return None
    cfg: Dict[str, str] = {}
    for f in provider.fields:
        value = str(get_setting(f.setting, "") or "").strip()
        if f.secret:
            value = decrypt(value).strip()
        if f.required and not value:
            return None
        cfg[_field_name(f)] = value
    return name, cfg


async def provider_search(
    name: str,
    cfg: Dict[str, str],
    query: str,
    max_results: int,
    language: str = "",
    time_range: str = "",
    page: int = 1,
) -> Dict[str, Any]:
    """One query against a provider, as a SearxNG-shaped payload."""
    import httpx

    provider = PROVIDERS.get(name)
    if provider is None or provider.call is None:
        raise ProviderError(f"Unknown search provider {name!r}")
    tr = time_range if time_range in TIME_RANGES else ""
    try:
        async with httpx.AsyncClient(timeout=PROVIDER_TIMEOUT) as client:
            return await provider.call(
                client, cfg, query, max(1, int(max_results)), language, tr, max(1, int(page or 1))
            )
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError(f"{name}: {exc.__class__.__name__}: {exc}") from exc


def provider_choices() -> List[Dict[str, Any]]:
    """For the settings UI: every provider with the fields it needs."""
    return [
        {
            "id": p.id,
            "label": p.label,
            "paid": p.paid,
            "fields": [
                {
                    "setting": f.setting,
                    "kind": f.kind,
                    "required": f.required,
                    "secret": f.secret,
                    "placeholder": f.placeholder,
                }
                for f in p.fields
            ],
        }
        for p in PROVIDER_LIST
    ]
