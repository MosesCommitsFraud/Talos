"""
news.py — headlines as cards, on top of the SearxNG instance web_search uses.

Not a new backend: `get_news` is the same request `web_search` makes with
`categories=news`, rendered twice. The model gets the usual snippet list, the
user gets a stack of article cards with source, age and a link that opens the
piece. That split is the whole reason this is its own tool rather than a flag on
web_search — a widget has to be attached at the point where the caller knows the
result IS a set of articles, and "search the news" is exactly that point.

Thumbnails ride along where SearxNG offers one, but only as a URL for the app's
own proxy to resolve (`routes/news_routes.py`). Handing the raw `img_src` to the
page would make the user's browser fetch an image straight from each publisher —
one outbound request per card, from their IP, to sites they have not chosen to
visit. The proxy moves that request to the server, so a card can show a picture
without a chat topic turning into hits in five publishers' logs.
"""

import logging
import re
from typing import Any, Dict, List
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

DEFAULT_ARTICLES = 8
MAX_ARTICLES = 20
# News goes stale in a way general search results do not: an "aktuelle Lage"
# question answered with a piece from 2019 is wrong, not merely old. A default
# window is the cheapest guard against that, and the caller can widen it.
DEFAULT_TIME_RANGE = "week"

SNIPPET_LIMIT = 320
TITLE_LIMIT = 200

# Hosts wear "www." and a country suffix that say nothing; the readable name is
# what is left. Kept deliberately dumb — a mapping of real publisher names would
# be a list nobody maintains.
_HOST_TRIM = re.compile(r"^(?:www|m|amp|news)\.", re.IGNORECASE)


def source_name(url: str, engine: str = "") -> str:
    """Publisher label for a card: the bare host, or the engine as a fallback."""
    host = (urlparse(url).hostname or "").strip()
    if not host:
        return engine or ""
    return _HOST_TRIM.sub("", host)


def _published(item: Dict[str, Any]) -> str:
    """ISO date of publication, or "" — the card renders relative ages ("vor 3
    Std."), which it can only do from a real timestamp. SearxNG passes the
    engine's own field through, so the shape varies by engine; anything that is
    not a plausible ISO stamp is dropped rather than guessed at."""
    raw = str(item.get("publishedDate") or "").strip()
    return raw if re.match(r"^\d{4}-\d{2}-\d{2}", raw) else ""


def _collapse(text: str, limit: int) -> str:
    out = re.sub(r"\s+", " ", str(text or "")).strip()
    return out if len(out) <= limit else out[:limit].rstrip() + "…"


def _thumbnail(item: Dict[str, Any]) -> str:
    """The article image URL, or "".

    Engines disagree on the field name — `thumbnail` is the small one where an
    engine bothers to make one, `img_src` the full-size original. Prefer the
    thumbnail; the proxy caps the size either way.

    Only the URL is carried, and it is NOT validated here: it is validated at
    the moment of fetching, by the proxy, against the admin domain policy and
    the SSRF guard as they are THEN. Sanitising it into the payload would bake a
    verdict into a card that gets replayed weeks later.
    """
    for key in ("thumbnail", "thumbnail_src", "img_src"):
        value = str(item.get(key) or "").strip()
        # Data URLs would defeat the whole point — the bytes would be inlined
        # into the payload, and the payload has a size cap for good reasons.
        if value.startswith(("http://", "https://")):
            return value
    return ""


def build_articles(picked: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """SearxNG result rows -> the card payload."""
    articles = []
    for item in picked:
        url = (item.get("url") or "").strip()
        if not url:
            continue
        articles.append(
            {
                "title": _collapse(item.get("title") or "", TITLE_LIMIT) or url,
                "url": url,
                "source": source_name(url, str(item.get("engine") or "")),
                "snippet": _collapse(item.get("content") or "", SNIPPET_LIMIT),
                "published": _published(item),
                "thumbnail": _thumbnail(item),
            }
        )
    return articles


def _summary(query: str, articles: List[Dict[str, Any]], filtered: int) -> str:
    """The model's copy: the same headlines as text.

    Complete rather than a pointer at the cards, for the same reason as the
    weather summary — the model has to be able to answer a follow-up ("what did
    the second one say?") from context, and a replayed turn carries this text.
    """
    if not articles:
        line = f'No news results for "{query}".'
        if filtered:
            return line + f" ({filtered} removed by the administrator's domain policy.)"
        return line + " Try different wording, a wider `time_range`, or a plain web_search."

    lines = [f'News: "{query}" — {len(articles)} article(s).']
    for i, article in enumerate(articles, 1):
        meta = " · ".join(x for x in (article["source"], article["published"][:10]) if x)
        lines.append(f"{i}. **{article['title']}**\n   {article['url']}")
        if article["snippet"]:
            lines.append(f"   {article['snippet']}")
        if meta:
            lines.append(f"   _{meta}_")
    if filtered:
        lines.append(f"\n({filtered} further result(s) hidden by the domain policy.)")
    lines.append(
        "\n[These headlines are already displayed to the user as clickable cards. Do not "
        "re-list them — answer what they asked, or give a short read of what the coverage "
        "adds up to. These are snippets, not articles: call web_fetch on a URL before "
        "claiming what a piece actually says.]"
    )
    return "\n".join(lines)


async def get_news(
    query: str,
    max_results: int = DEFAULT_ARTICLES,
    language: str = "",
    time_range: str = DEFAULT_TIME_RANGE,
    session_id: str = "",
) -> Dict[str, Any]:
    """Recent articles on a topic. Returns the tool-result shape: `output` for
    the model, `widget` for the UI, or `error` + a non-zero `exit_code`."""
    from src.web_search import _pick_results, _searx_request
    from src.widgets import make_widget

    query = (query or "").strip()
    if not query:
        return {"error": "get_news needs a non-empty `query` (the topic).", "exit_code": 1}

    try:
        max_results = max(1, min(int(max_results or DEFAULT_ARTICLES), MAX_ARTICLES))
    except (TypeError, ValueError):
        max_results = DEFAULT_ARTICLES

    outcome = await _searx_request(
        query=query,
        max_results=max_results,
        language=language,
        category="news",
        time_range=time_range,
        page=1,
        session_id=session_id,
    )
    if "error" in outcome:
        # Including the leak-guard refusal: the query never left the building,
        # and the reason is written for the model to act on.
        return outcome

    picked, filtered = _pick_results(outcome["payload"], outcome["max_results"])
    articles = build_articles(picked)

    result: Dict[str, Any] = {"output": _summary(query, articles, filtered), "exit_code": 0}
    # No cards, no widget: an empty stack is a worse answer than the sentence
    # explaining that nothing came back.
    if articles:
        result["widget"] = make_widget(
            "news",
            {
                "query": query,
                "timeRange": (time_range or "").strip().lower(),
                "articles": articles,
                "hiddenByPolicy": filtered,
            },
        )
    return result
