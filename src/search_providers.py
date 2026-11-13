"""Paid web-search APIs as an alternative to SearxNG.

SearxNG scrapes the public engines from the server's own IP, and bursts of
agent searches get that IP CAPTCHA'd or rate limited (2026-11-12: every engine
at once, for hours). An API provider answers under a contract instead. Which
one is used is an admin setting (Settings -> Web): ``web_search_provider`` plus
that provider's key. No provider or no key means SearxNG, as before — nothing
here costs money unless an admin enters a key.

Every provider's answer is turned into SearxNG's JSON shape (``results`` with
title/url/content/publishedDate/engine, optional ``answers``), so the rendering,
domain policy and citation code in src/web_search.py work unchanged. A provider
that fails (wrong key, quota used up, outage) raises ProviderError and the
caller falls back to SearxNG.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

PROVIDER_TIMEOUT = 20.0

# id -> (label, setting that holds the key). "searxng" needs no key.
PROVIDERS: Dict[str, Tuple[str, str]] = {
    "searxng": ("SearxNG (self-hosted, free)", ""),
    "brave": ("Brave Search API", "web_search_brave_api_key"),
    "tavily": ("Tavily", "web_search_tavily_api_key"),
    "serper": ("Serper (Google results)", "web_search_serper_api_key"),
}
SECRET_SETTINGS = tuple(key for _, key in PROVIDERS.values() if key)


class ProviderError(Exception):
    """The provider could not answer; the caller falls back to SearxNG."""


def configured_provider() -> Optional[Tuple[str, str]]:
    """(provider id, API key) when an admin chose a paid provider and entered
    its key, else None (= SearxNG)."""
    try:
        from src.secret_storage import decrypt
        from src.settings import get_setting
    except Exception:
        return None
    name = str(get_setting("web_search_provider", "searxng") or "searxng").strip().lower()
    if name not in PROVIDERS or name == "searxng":
        return None
    key = decrypt(str(get_setting(PROVIDERS[name][1], "") or "")).strip()
    return (name, key) if key else None


def _result(title: Any, url: Any, content: Any, published: Any, engine: str) -> Dict[str, Any]:
    return {
        "title": str(title or ""),
        "url": str(url or ""),
        "content": str(content or ""),
        "publishedDate": str(published or ""),
        "engine": engine,
    }


async def _brave(client, key: str, query: str, n: int, language: str, time_range: str, page: int):
    params: Dict[str, Any] = {"q": query, "count": min(n, 20), "offset": max(0, min(page - 1, 9))}
    if language:
        params["search_lang"] = language.split("-")[0].lower()
    freshness = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}.get(time_range)
    if freshness:
        params["freshness"] = freshness
    resp = await client.get(
        "https://api.search.brave.com/res/v1/web/search",
        params=params,
        headers={"Accept": "application/json", "X-Subscription-Token": key},
    )
    _raise_for(resp, "Brave")
    data = resp.json()
    results = [
        _result(r.get("title"), r.get("url"), r.get("description"), r.get("page_age"), "brave")
        for r in ((data.get("web") or {}).get("results") or [])
    ]
    return {"results": results}


async def _tavily(client, key: str, query: str, n: int, language: str, time_range: str, page: int):
    body: Dict[str, Any] = {"query": query, "max_results": min(n, 20), "search_depth": "basic"}
    if time_range in {"day", "week", "month", "year"}:
        body["time_range"] = time_range
    resp = await client.post(
        "https://api.tavily.com/search",
        json=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    _raise_for(resp, "Tavily")
    data = resp.json()
    results = [
        _result(r.get("title"), r.get("url"), r.get("content"), r.get("published_date"), "tavily")
        for r in (data.get("results") or [])
    ]
    out: Dict[str, Any] = {"results": results}
    if data.get("answer"):
        out["answers"] = [str(data["answer"])]
    return out


async def _serper(client, key: str, query: str, n: int, language: str, time_range: str, page: int):
    body: Dict[str, Any] = {"q": query, "num": min(n, 20), "page": max(1, page)}
    if language:
        body["hl"] = language.split("-")[0].lower()
    tbs = {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}.get(time_range)
    if tbs:
        body["tbs"] = tbs
    resp = await client.post(
        "https://google.serper.dev/search",
        json=body,
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
    )
    _raise_for(resp, "Serper")
    data = resp.json()
    results = [
        _result(r.get("title"), r.get("link"), r.get("snippet"), r.get("date"), "serper")
        for r in (data.get("organic") or [])
    ]
    out: Dict[str, Any] = {"results": results}
    box = data.get("answerBox") or {}
    answer = box.get("answer") or box.get("snippet")
    if answer:
        out["answers"] = [str(answer)]
    return out


_CALLS = {"brave": _brave, "tavily": _tavily, "serper": _serper}


def _raise_for(resp, label: str) -> None:
    if resp.status_code in (401, 403):
        raise ProviderError(f"{label} rejected the API key (HTTP {resp.status_code})")
    if resp.status_code == 429:
        raise ProviderError(f"{label} quota or rate limit reached (HTTP 429)")
    if resp.status_code >= 400:
        raise ProviderError(f"{label} returned HTTP {resp.status_code}")


async def provider_search(
    name: str,
    key: str,
    query: str,
    max_results: int,
    language: str = "",
    time_range: str = "",
    page: int = 1,
) -> Dict[str, Any]:
    """One query against a paid provider, as a SearxNG-shaped payload."""
    import httpx

    call = _CALLS.get(name)
    if call is None:
        raise ProviderError(f"Unknown search provider {name!r}")
    try:
        async with httpx.AsyncClient(timeout=PROVIDER_TIMEOUT) as client:
            return await call(client, key, query, max_results, language, time_range, page)
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError(f"{name}: {exc.__class__.__name__}: {exc}") from exc


def provider_choices() -> List[Dict[str, str]]:
    """For the settings UI: id, label and the setting that holds the key."""
    return [{"id": k, "label": v[0], "key_setting": v[1]} for k, v in PROVIDERS.items()]
