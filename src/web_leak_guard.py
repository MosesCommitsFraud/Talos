"""
web_leak_guard.py

Keeps internal knowledge out of outbound search queries.

SearxNG anonymises *who* is searching — the query still reaches Google/Bing/
DuckDuckGo verbatim. So the exposure that matters is not the transport, it is
what the model types into the box. The dangerous moment is built into the
tool's own design: the model is told to search when the retrieved documents
don't answer the question, which is precisely when it is staring at an
internal document and wants more. Left alone it will happily search for

    "Kündigungsfrist Rahmenvertrag Müller GmbH Klausel 7.3"

and hand a customer, a contract and a clause number to a search engine.

This module scores a candidate query against the retrieved knowledge that was
injected into the same chat turn and refuses the ones that carry it outward.
The chat layer registers that text per session (``remember_context``); the
web_search tool consults ``check_query`` before any request leaves.

Admin-controlled via the ``web_leak_guard`` setting (Settings → Web). Turning
it off disables both this check and the confidentiality rule in the prompt.

Two deliberate design notes:

* It is a **heuristic**, and the failure it prefers is a false positive: a
  blocked query costs the model one reformulation, a missed one is permanent.
* It only sees the *retrieved* text, not everything confidential in the world.
  It is a backstop for the specific RAG→web path, not a general DLP system.

Known gap, accepted deliberately: a query that reuses exactly one ordinary word
pair from the document — a bare company name and nothing else — is allowed
through, because in German the same pair is often just the topic ("Photovoltaik
Förderung") and blocking it would make the tool useless on any document's own
subject. The prompt rule in ``_WEB_CONFIDENTIALITY_RULE`` covers that case; this
module catches the copied phrasings and identifiers the prompt rule misses.
"""

from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict
from typing import Dict, Optional, Tuple

from src.text_overlap import bigrams, content_tokens

logger = logging.getLogger(__name__)

# Beyond this, a "query" is pasted content rather than a search.
MAX_QUERY_CHARS = 300
# Two copied word-pairs is phrasing, not coincidence.
MAX_SHARED_BIGRAMS = 1
_HAS_DIGIT_RE = re.compile(r"\d")

# Internal identifiers — clause 7.3, RV-4471, ISO9001, 2024-A17. The shared
# tokenizer in src.text_overlap splits these apart ("7.3" → "7", "3", both too
# short to survive), so they need their own pass or they are invisible to the
# bigram rule. Requiring a non-digit character keeps bare numbers out: a year
# or a plain figure is too ambiguous to block on, and "EEG Förderung 2024"
# must stay searchable even when 2024 appears in the document.
_IDENTIFIER_RE = re.compile(r"[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9._/-]*[A-Za-zÀ-ÿ0-9]")


def _identifiers(text: str) -> set:
    """Mixed alphanumeric identifiers in `text`, lowercased."""
    found = set()
    for raw in _IDENTIFIER_RE.findall(text or ""):
        tok = raw.strip("._/-").lower()
        if len(tok) < 2 or not _HAS_DIGIT_RE.search(tok):
            continue
        if tok.isdigit():  # bare number / year — too ambiguous to act on
            continue
        found.add(tok)
    return found


# Retrieved text per session. Bounded — this is a cache for the current turn,
# not storage: the entry is rewritten on every turn that retrieves anything.
_MAX_SESSIONS = 200
_TTL_SECONDS = 3600.0
_protected: "OrderedDict[str, Tuple[float, str]]" = OrderedDict()


def remember_context(session_id: str, text: str) -> None:
    """Record the retrieved knowledge injected into `session_id`'s current turn."""
    if not session_id or not text:
        return
    now = time.monotonic()
    _protected[session_id] = (now, text)
    _protected.move_to_end(session_id)
    while len(_protected) > _MAX_SESSIONS:
        _protected.popitem(last=False)


def forget_context(session_id: str) -> None:
    """Drop a session's retrieved text (chat deleted / turn carried no RAG)."""
    _protected.pop(session_id, None)


def _get_context(session_id: str) -> str:
    entry = _protected.get(session_id)
    if not entry:
        return ""
    ts, text = entry
    if time.monotonic() - ts > _TTL_SECONDS:
        _protected.pop(session_id, None)
        return ""
    return text


def is_enabled() -> bool:
    """Admin toggle; defaults ON, and fails ON if settings can't be read."""
    try:
        from src.settings import get_setting

        return get_setting("web_leak_guard", True) is not False
    except Exception as e:
        logger.warning("web_leak_guard setting unreadable, staying enabled: %s", e)
        return True


def check_query(query: str, session_id: str = "") -> Optional[str]:
    """Return a refusal message if `query` must not leave, else None."""
    if not is_enabled():
        return None
    query = (query or "").strip()
    if not query:
        return None

    if len(query) > MAX_QUERY_CHARS:
        return (
            f"Blocked: that search query is {len(query)} characters — that is pasted content, "
            "not a search. Send a short query of the key terms instead, and leave out anything "
            "that came from the user's documents."
        )

    protected = _get_context(session_id)
    if not protected:
        return None

    # Rule 1: an internal identifier lifted straight out of the document.
    shared_ids = _identifiers(query) & _identifiers(protected)
    if shared_ids:
        logger.info("[web-guard] blocked outbound query (session=%s, identifier reuse)", session_id)
        return _refusal(", ".join(sorted(shared_ids)[:3]))

    # Rule 2: copied phrasing. One shared pair can be coincidence on a topic the
    # document is about; two is lifted wording. A pair carrying a number counts
    # on its own.
    q_tokens = content_tokens(query)
    shared = bigrams(q_tokens) & bigrams(content_tokens(protected))
    if not shared:
        return None

    carries_number = any(_HAS_DIGIT_RE.search(a) or _HAS_DIGIT_RE.search(b) for a, b in shared)
    if len(shared) > MAX_SHARED_BIGRAMS or carries_number:
        logger.info(
            "[web-guard] blocked outbound query (session=%s, shared=%d)", session_id, len(shared)
        )
        return _refusal(", ".join(f'"{a} {b}"' for a, b in sorted(shared)[:3]))
    return None


def _refusal(sample: str) -> str:
    """The message the model gets back. It has to teach the rule well enough
    that the retry is a good generic query, not the same one reworded."""
    return (
        "Blocked: this query repeats content from the user's internal documents "
        f"({sample}) and would send it to a public search engine. Never put document "
        "content, customer or person names, internal identifiers, contract or clause "
        "numbers into a web search. Search for the general, public version of the "
        "question instead — the concept, the law, the standard, the product — and apply "
        "what you find to the internal document yourself. If the answer only exists in "
        "the user's documents, say so instead of searching."
    )


def stats() -> Dict[str, int]:
    """Small introspection hook for debugging/tests."""
    return {"sessions": len(_protected)}
