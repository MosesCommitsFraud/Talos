"""Per-turn citation numbers shared by every source the model can cite.

Web search results, fetched pages and knowledge-base sections all land in the
model's context during one turn, through different code paths (auto-injected
RAG, `search_knowledge`, `web_search`, `web_fetch`). For inline citations
("… [3]") to be unambiguous, every one of them needs a number that is unique
for the whole turn, and the same source retrieved twice must keep its number.
This module is that single counter, keyed by chat session.

`begin_turn` resets a session at the start of a user turn. Paths without a
running turn (the outward MCP server, tests) never call it, and `cite` returns
None for them so their output stays unnumbered.

Entries are public (safe for the client and the DB):
  web: {n, kind: "web", title, url, site, snippet, published?}
  rag: {n, kind: "rag", title, snippet, page?, image_url?, deeplink?, start?}
"""

from __future__ import annotations

import re
import threading
from typing import Dict, List, Optional
from urllib.parse import urlparse

_MAX_SESSIONS = 500
_lock = threading.Lock()
_turns: Dict[str, dict] = {}

# "[3]", "[3, 5]", "[3][5]" — citation numbers are 1..999.
_MARKER_RE = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")

# Rule placed next to numbered source material, where small models follow it
# far more reliably than a distant system line.
CITATION_RULE = (
    "Cite sources inline: put the source number in square brackets directly after "
    "the sentence or claim it supports, e.g. `… beträgt 150 cm [3].` Several "
    "sources: `[3][5]`. Only use numbers shown above; never invent a number, do "
    "not add a separate source list at the end."
)


def begin_turn(session_id: Optional[str]) -> None:
    if not session_id:
        return
    with _lock:
        _turns.pop(session_id, None)
        if len(_turns) >= _MAX_SESSIONS:
            _turns.pop(next(iter(_turns)))
        _turns[session_id] = {"keys": {}, "items": []}


def active(session_id: Optional[str]) -> bool:
    return bool(session_id) and session_id in _turns


def cite(session_id: Optional[str], key: str, entry: dict) -> Optional[int]:
    """Number for a source in this turn; the same key keeps its number."""
    if not session_id:
        return None
    with _lock:
        turn = _turns.get(session_id)
        if turn is None:
            return None
        n = turn["keys"].get(key)
        if n is None:
            n = len(turn["items"]) + 1
            turn["keys"][key] = n
            turn["items"].append({**entry, "n": n})
        return n


def entries(session_id: Optional[str], numbers: Optional[set] = None) -> List[dict]:
    with _lock:
        turn = _turns.get(session_id or "")
        items = list(turn["items"]) if turn else []
    return [dict(e) for e in items if numbers is None or e["n"] in numbers]


def cited_numbers(text: str) -> set:
    out: set = set()
    for m in _MARKER_RE.finditer(text or ""):
        out.update(int(x) for x in re.split(r"\s*,\s*", m.group(1)))
    return out


def site_name(url: str) -> str:
    host = (urlparse(url or "").hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def cite_web(
    session_id: Optional[str], url: str, title: str, snippet: str, published: str = ""
) -> Optional[int]:
    entry = {
        "kind": "web",
        "title": title or site_name(url),
        "url": url,
        "site": site_name(url),
        "snippet": (snippet or "")[:500],
    }
    if published:
        entry["published"] = published
    return cite(session_id, "web:" + (url or "").rstrip("/"), entry)


def cite_rag(session_id: Optional[str], source: dict) -> Optional[int]:
    """Number a retrieved knowledge-base section (a rag_sources dict)."""
    key = source.get("_id") or "|".join(
        str(x)
        for x in (source.get("filename"), source.get("_page"), (source.get("snippet") or "")[:80])
    )
    entry = {
        "kind": "rag",
        "title": source.get("filename") or "",
        "snippet": (source.get("snippet") or "")[:500],
    }
    for k in ("image_url", "image_caption", "deeplink", "start", "end", "modality"):
        if source.get(k) is not None:
            entry[k] = source[k]
    if source.get("_page") is not None:
        entry["page"] = source["_page"]
    return cite(session_id, "rag:" + str(key), entry)
