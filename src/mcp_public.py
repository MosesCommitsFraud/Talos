"""
mcp_public.py

Tool layer for Talos's *outward-facing* MCP server (mounted at ``/mcp``).

This is the mirror image of `src/builtin_mcp.py`: that module wires external
MCP servers *into* Talos, this one exposes Talos's own knowledge base and
skill library *out* to external MCP clients (Claude Desktop/Code, MACS, other
agents).

Deliberately transport-free — no JSON-RPC, no HTTP, no stdio. The HTTP
plumbing lives in `routes/mcp_public_routes.py`; keeping the tools here means
they stay unit-testable without a server, and a stdio wrapper could reuse them
verbatim.

Everything here is READ-ONLY. Nothing in this module writes to Qdrant, to the
skills directory, or to the settings store: an outward-facing endpoint reached
with a long-lived bearer token is the wrong place to accept mutations, and the
skills flow in particular has a deliberate publish/audit review step
(routes/skills_routes.py) that a write tool would route around.
"""

import asyncio
import concurrent.futures
import logging
import os
from typing import Any, Dict, List, Optional, Set, Tuple

from src.rag_scopes import SCOPE_IDS

logger = logging.getLogger(__name__)

# Token scopes gating the three tool families. Mirrored in
# routes/api_token_routes.py ALLOWED_SCOPES — a scope that isn't allowed
# there can never be minted onto a token, so the two lists must agree.
SCOPE_RAG_READ = "rag:read"
SCOPE_SKILLS_READ = "skills:read"
SCOPE_WEB_READ = "web:read"

# Per-tool output budget. Generous enough for a full SKILL.md, small enough
# that a wide `rag_get_document` can't blow up the client's context window.
MAX_TEXT_CHARS = 24_000
# Per-passage budget in the rendered search answer. Big enough that one
# `rag_query` answers the question on its own: the old 800-char snippet forced a
# second `rag_get_document` round trip for anything longer than a paragraph, and
# a client driving its own agent loop can't be relied on to make it. Divided
# across the hits so a wide topK can't blow the per-tool budget — each passage
# gets MAX_TEXT_CHARS/len(results), floored at MIN_PASSAGE_CHARS.
PASSAGE_CHARS = 4_000
MIN_PASSAGE_CHARS = 800
# Room reserved per hit for its header block (filename, source, collection,
# score) so the passages plus their headers stay inside MAX_TEXT_CHARS and the
# last hit isn't lopped off by the outer cap.
HEADER_ALLOWANCE = 200
# Snippet length in the *structured* payload of the REST service
# (src/rag_api.py), which carries the rendered text beside it and so does not
# need the full passage twice.
SNIPPET_CHARS = 800

# One MCP tool per published skill, alongside the skills_* family. Capped so an
# instance with hundreds of skills can't bury a client's tool palette (and its
# model's attention) — past the cap, skills_search stays the way in.
SKILL_TOOL_PREFIX = "skill_"
MAX_SKILL_TOOLS = 60

# Purpose-bound sub-indexes (the SQL schema files) are injected separately by
# the feature that owns them — see src/rag_scopes.py. They are noise in ordinary
# retrieval, so the default search excludes them exactly as the chat pipeline
# does. Derived from the scope catalogue so a new scope is excluded everywhere
# by adding one entry there.
DEFAULT_EXCLUDE_SCOPES = list(SCOPE_IDS)


def _truncate(text: str, limit: int = MAX_TEXT_CHARS) -> str:
    """Cap `text` at `limit` chars with an explicit note about what was cut."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n… (truncated — {len(text)} chars total)"


def _clamp_k(value: Any, default: int = 5) -> int:
    """Clamp a requested result count to 1–20, matching routes/rag_routes.py."""
    try:
        return max(1, min(int(value), 20))
    except (TypeError, ValueError):
        return default


def _clamp_limit(value: Any, default: int, hi: int) -> int:
    try:
        return max(1, min(int(value), hi))
    except (TypeError, ValueError):
        return default


def _run_async(coro):
    """Await `coro` from this module's synchronous dispatch.

    The web tools in `src/web_search.py` are async (httpx), while everything
    else here is blocking. `call_tool` runs in a worker thread with no event
    loop of its own (see routes/mcp_public_routes.py), so `asyncio.run` is the
    normal path. The fallback covers a caller that reaches `call_tool` from
    inside a running loop — handing the coroutine to a private thread beats
    raising "asyncio.run() cannot be called from a running event loop" at them.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


# ---------------------------------------------------------------------------
# Tool catalogue
# ---------------------------------------------------------------------------
# `_scope` is stripped before the definition goes over the wire — it's our
# gating metadata, not part of the MCP tool schema.

_TOOL_DEFS: List[Dict[str, Any]] = [
    {
        "_scope": SCOPE_RAG_READ,
        "name": "rag_query",
        "title": "Query the Talos knowledge bases",
        "description": (
            "Hybrid semantic + keyword search over one or more Talos knowledge "
            "bases (Qdrant dense+sparse retrieval followed by a cross-encoder "
            "rerank). Returns the most relevant passages with their source file, "
            "knowledge base and score — each with enough surrounding text to "
            "answer from directly, so a second call is rarely needed. Pass "
            "`collections` to search specific knowledge bases; list them with "
            "rag_list_collections. Call rag_get_document only when you need a "
            "whole file."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language question or search phrase.",
                },
                "collections": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Knowledge-base ids to search, as returned by "
                        "rag_list_collections. Several are searched together and "
                        "their hits merged by relevance. Omit to search the "
                        "default knowledge base."
                    ),
                },
                "topK": {
                    "type": "integer",
                    "description": "Number of passages to return (1–20, default 5).",
                    "minimum": 1,
                    "maximum": 20,
                },
                "language": {
                    "type": "string",
                    "description": (
                        "Language hint (e.g. 'de'). Accepted for interface "
                        "compatibility; retrieval is multilingual, so it does not "
                        "change which passages come back."
                    ),
                },
                "owner": {
                    "type": "string",
                    "description": (
                        "Restrict the search to one user's personal documents. "
                        "Omit to search the shared knowledge base (the default, "
                        "and what Talos chat itself searches)."
                    ),
                },
                "scope": {
                    "type": "string",
                    "description": (
                        "Restrict the search to a single knowledge namespace "
                        "(e.g. 'sql'). Omit for the ordinary knowledge base."
                    ),
                },
            },
            "required": ["query"],
        },
    },
    {
        "_scope": SCOPE_RAG_READ,
        "name": "rag_list_collections",
        "title": "List the knowledge bases",
        "description": (
            "List the knowledge bases ('collections') this Talos instance serves "
            "— id, name, description, declared language and document count. The "
            "ids are what rag_query takes in `collections`, and what "
            "rag_list_documents / rag_get_document take in `collection`."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "_scope": SCOPE_RAG_READ,
        "name": "rag_list_documents",
        "title": "List indexed documents",
        "description": (
            "List the documents currently indexed in the Talos knowledge base, "
            "one row per source file with its chunk count. Use `filter` to "
            "narrow by filename substring. Useful for discovering what is "
            "available before searching."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "filter": {
                    "type": "string",
                    "description": "Case-insensitive substring match on filename or path.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum rows to return (1–500, default 100).",
                    "minimum": 1,
                    "maximum": 500,
                },
                "collection": {
                    "type": "string",
                    "description": "Knowledge-base id to list. Omit for the default base.",
                },
            },
        },
    },
    {
        "_scope": SCOPE_RAG_READ,
        "name": "rag_get_document",
        "title": "Read an indexed document",
        "description": (
            "Return the indexed text of one document, in reading order. Pass the "
            "`source` value exactly as returned by rag_query or "
            "rag_list_documents. Only indexed documents can be read — this does "
            "not touch the filesystem."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "description": "The document's `source` identifier from rag_query.",
                },
                "max_chunks": {
                    "type": "integer",
                    "description": "Maximum chunks to include (1–200, default 50).",
                    "minimum": 1,
                    "maximum": 200,
                },
                "collection": {
                    "type": "string",
                    "description": (
                        "Knowledge-base id the document lives in — the "
                        "`collection` shown on the rag_query hit. Omit for the "
                        "default base."
                    ),
                },
            },
            "required": ["source"],
        },
    },
    {
        "_scope": SCOPE_SKILLS_READ,
        "name": "skills_list",
        "title": "List available skills",
        "description": (
            "List the published Talos skills — reusable, human-reviewed "
            "procedures — as name, category and description. Read one in full "
            "with skills_get before following it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Only list skills in this category.",
                }
            },
        },
    },
    {
        "_scope": SCOPE_SKILLS_READ,
        "name": "skills_search",
        "title": "Find skills relevant to a task",
        "description": (
            "Rank published skills by relevance to a task description. Returns "
            "each match with when to use it and its first steps. Only published "
            "(reviewed) skills are surfaced — drafts are never returned."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What you are trying to do.",
                },
                "max_items": {
                    "type": "integer",
                    "description": "Maximum skills to return (1–20, default 5).",
                    "minimum": 1,
                    "maximum": 20,
                },
            },
            "required": ["query"],
        },
    },
    {
        "_scope": SCOPE_SKILLS_READ,
        "name": "skills_get",
        "title": "Read a skill",
        "description": (
            "Return the full SKILL.md for one skill by name, including its "
            "procedure, pitfalls and verification steps."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill's slug, as returned by skills_list.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "_scope": SCOPE_SKILLS_READ,
        "name": "skills_read_reference",
        "title": "Read a skill's reference file",
        "description": (
            "Read a supporting file bundled with a skill (e.g. "
            "'references/checklist.md'). Paths are resolved inside the skill's "
            "own directory; traversal outside it is refused."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The skill's slug."},
                "path": {
                    "type": "string",
                    "description": "Path relative to the skill directory, e.g. 'references/x.md'.",
                },
            },
            "required": ["name", "path"],
        },
    },
    {
        "_scope": SCOPE_WEB_READ,
        "name": "web_search",
        "title": "Search the public web",
        "description": (
            "Search the public internet through Talos's self-hosted SearxNG "
            "instance. Returns ranked results with title, URL and snippet, plus "
            "any direct answer the engines provide. These are snippets, not full "
            "pages — call web_fetch on a promising URL when the answer needs "
            "detail the snippet doesn't carry."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query."},
                "max_results": {
                    "type": "integer",
                    "description": "Results to return (1–20, default 6).",
                    "minimum": 1,
                    "maximum": 20,
                },
                "language": {
                    "type": "string",
                    "description": "Language code to bias results, e.g. 'de' or 'en'.",
                },
                "category": {
                    "type": "string",
                    "description": (
                        "SearxNG category: general, news, science, it, images, "
                        "videos, map or music."
                    ),
                },
                "time_range": {
                    "type": "string",
                    "description": "Recency filter: day, week, month or year.",
                },
                "page": {
                    "type": "integer",
                    "description": "Result page, for paging past the first set.",
                    "minimum": 1,
                },
            },
            "required": ["query"],
        },
    },
    {
        "_scope": SCOPE_WEB_READ,
        "name": "web_fetch",
        "title": "Read a web page",
        "description": (
            "Fetch one public web page and return its readable text with the "
            "site chrome stripped. HTML, plain text, JSON and XML only — it "
            "cannot read PDFs or binaries. Private and internal addresses are "
            "refused, on redirects too."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The page to read."},
                "max_chars": {
                    "type": "integer",
                    "description": "Characters of page text to return (500–20000, default 8000).",
                    "minimum": 500,
                    "maximum": 20000,
                },
            },
            "required": ["url"],
        },
    },
]


_STATIC_TOOL_NAMES = {spec["name"] for spec in _TOOL_DEFS}

# Retired tool names that still resolve, so a client holding an older config
# keeps working. Not listed in the catalogue — this is a landing pad, not a
# second supported spelling.
_TOOL_ALIASES = {"rag_search": "rag_query"}


def list_tools(
    granted_scopes, owner: Optional[str] = None, skills_manager=None
) -> List[Dict[str, Any]]:
    """Tool definitions visible to a caller holding `granted_scopes`.

    Two gates, both applied at *list* time as well as at call time: the token's
    scopes, and the administrator's MCP settings (src/mcp_settings.py). A
    client that can't use a tool shouldn't see it in its palette at all.

    The static catalogue above is followed by one tool per published skill (see
    `skill_tools`), which is why this needs `owner` and the skills manager: the
    skill list is per-owner, so unlike the static tools the catalogue is not the
    same for every caller.
    """
    from src import mcp_settings

    granted = set(granted_scopes or ())
    out = []
    for spec in _TOOL_DEFS:
        if spec["_scope"] not in granted:
            continue
        if not mcp_settings.tool_enabled(spec["name"]):
            continue
        out.append({k: v for k, v in spec.items() if not k.startswith("_")})

    if SCOPE_SKILLS_READ in granted:
        out.extend(skill_tools(owner=owner, skills_manager=skills_manager))
    return out


def scope_for_tool(name: str) -> Optional[str]:
    """The scope a tool requires, or None if there is no such tool.

    Per-skill tools answer `skills:read` from their prefix alone — whether the
    *particular* skill exists is settled in `call_tool`, which has the owner and
    the skills manager this function does not.
    """
    wanted = _TOOL_ALIASES.get(name, name)
    for spec in _TOOL_DEFS:
        if spec["name"] == wanted:
            return spec["_scope"]
    if isinstance(name, str) and name.startswith(SKILL_TOOL_PREFIX):
        return SCOPE_SKILLS_READ
    return None


# ---------------------------------------------------------------------------
# RAG tools
# ---------------------------------------------------------------------------


def _rag(base_id: Optional[str] = None):
    """The VectorRAG instance for one knowledge base, or None when Qdrant/deps
    are unreachable.

    ``base_id`` names a knowledge base from ``src/rag_registry.py``; omitted
    means the default one, which is what the MCP tools use. The outward REST
    service (``src/rag_api.py``) passes a base so it can reuse these exact tool
    bodies and hand its callers byte-identical text.
    """
    from src.rag_singleton import get_rag_manager

    rag = get_rag_manager(base_id)
    if not rag or not getattr(rag, "healthy", False):
        return None
    return rag


def _rag_unavailable_text() -> str:
    from src.rag_singleton import last_init_error

    reason = last_init_error() or "no detail available"
    return f"The Talos knowledge base is currently unavailable ({reason})."


def _search_config(base_id: Optional[str] = None) -> Dict[str, Any]:
    """The RAG pipeline config for one knowledge base (global defaults plus that
    base's overrides), or {} when settings can't be read."""
    try:
        from src.rag_config import effective_config

        return effective_config(base_id)
    except Exception:
        return {}


def _collection_arg(args: Dict[str, Any]) -> Optional[str]:
    """The single knowledge base a document tool addresses, or None for default.

    ``rag_id`` is the older spelling — kept because it is what `src/rag_api.py`
    and existing clients pass.
    """
    for key in ("collection", "rag_id"):
        value = str(args.get(key) or "").strip()
        if value:
            return value
    return None


def _collections_arg(args: Dict[str, Any]) -> List[Optional[str]]:
    """The knowledge bases `rag_query` should search.

    Returns ``[None]`` — the default base — when the caller named none, so the
    fan-out below has exactly one shape to handle. A bare string is accepted
    alongside the array: a model that has been told "a list" will still
    occasionally send one id.
    """
    raw = args.get("collections")
    if raw is None:
        single = _collection_arg(args)
        return [single] if single else [None]
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise ToolError("`collections` must be a list of knowledge-base ids.")
    ids = [str(x).strip() for x in raw if str(x or "").strip()]
    return ids or [None]


def _known_collection_ids() -> List[str]:
    from src.rag_registry import list_bases

    return [str(b.get("id")) for b in (list_bases() or [])]


def _validate_collections(ids: List[Optional[str]]) -> None:
    """Reject an unknown id with the list of real ones.

    An unknown base is a caller mistake, and the fix is always the same: look at
    what exists. Saying so costs one registry read and saves a round trip.
    """
    named = [i for i in ids if i]
    if not named:
        return
    known = set(_known_collection_ids())
    unknown = [i for i in named if i not in known]
    if unknown:
        raise ToolError(
            f"Unknown knowledge base(s): {', '.join(repr(u) for u in unknown)}. "
            f"Available: {', '.join(sorted(known)) or '(none)'}. "
            "Call rag_list_collections for their names and descriptions."
        )


def _apply_rag_policy(
    args: Dict[str, Any],
    allowed: Optional[Set[str]],
    max_results: int,
    allowed_scopes: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """Bend one MCP call's arguments to the administrator's RAG policy.

    Returns a new dict — the caller's arguments are never mutated, and the tool
    bodies stay policy-free so `src/rag_api.py` and the in-app agent keep
    reaching every base.

    Three things happen here:

    * **Bases.** Any id the caller named must be on the allow-list; naming one
      that isn't is refused by name, the same way an unknown base is, so the
      client learns what it may address instead of silently getting nothing.
      A caller that named *none* would otherwise fall through to the `default`
      base — which may be exactly the one being withheld — so the search is
      pointed at the allowed set instead.
    * **Scopes.** `scope` addresses a sub-index a Talos feature manages for
      itself (the SQL schema files — see `src/rag_scopes.py`), which ordinary
      retrieval never returns. Unless the administrator named that scope, the
      argument is refused rather than quietly dropped: a caller that thinks it
      is reading the schema index should not be handed ordinary passages that
      look like an answer.
    * **Size.** `topK` is capped. A caller asking for fewer passages still gets
      fewer, and an instance whose pipeline default is smaller keeps it — this
      is a ceiling, not a default.
    """
    out = dict(args)

    scope = str(out.get("scope") or "").strip()
    if scope and scope not in (allowed_scopes or set()):
        raise ToolError(
            f"The {scope!r} namespace is not available over MCP. "
            + (
                f"Available: {', '.join(sorted(allowed_scopes))}."
                if allowed_scopes
                else "This instance shares no sub-index namespaces externally."
            )
        )

    if allowed is not None:
        named = [i for i in _collections_arg(out) if i]
        refused = [i for i in named if i not in allowed]
        if refused:
            raise ToolError(
                f"Knowledge base(s) not available over MCP: "
                f"{', '.join(repr(r) for r in refused)}. "
                f"Available: {', '.join(sorted(allowed)) or '(none)'}. "
                "Call rag_list_collections to see them."
            )
        if not named:
            if not allowed:
                raise ToolError(
                    "No knowledge bases are shared with external clients on "
                    "this Talos instance."
                )
            out.pop("rag_id", None)
            out["collections"] = sorted(allowed)
            # The single-base tools take one id, not a list.
            out["collection"] = sorted(allowed)[0]

    for key in ("topK", "k"):
        value = out.get(key)
        if value is None:
            continue
        try:
            out[key] = min(int(value), max_results)
        except (TypeError, ValueError):
            continue
    if out.get("topK") is None and out.get("k") is None:
        # No size named: the base's own pipeline default applies, held to the
        # same ceiling rather than replaced by it.
        configured = _search_config(_collections_arg(out)[0]).get("search_top_k", 5)
        out["topK"] = min(_clamp_k(configured), max_results)
    return out


def _tool_rag_query(args: Dict[str, Any]) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("`query` is required and must not be empty.")

    collections = _collections_arg(args)
    _validate_collections(collections)

    # `topK` is the documented name; `k` is what the old rag_search tool took
    # and what src/rag_api.py passes through.
    requested = args.get("topK")
    if requested is None:
        requested = args.get("k")
    if requested is None:
        requested = _search_config(collections[0]).get("search_top_k", 5)
    k = _clamp_k(requested)

    owner = str(args.get("owner") or "").strip() or None
    scope = str(args.get("scope") or "").strip() or None
    # An explicit scope means the caller wants that namespace; only apply the
    # default sql exclusion when they didn't ask for one.
    exclude = None if scope else DEFAULT_EXCLUDE_SCOPES

    language = str(args.get("language") or "").strip()
    if language:
        # Accepted so the call signature matches what agent frameworks send,
        # but the embedder and reranker are multilingual — filtering or
        # rewriting by language here would only remove correct hits.
        logger.debug("rag_query language hint %r (not used for retrieval)", language)

    hits: List[Dict[str, Any]] = []
    failures: List[str] = []
    for cid in collections:
        label = cid or _default_collection_id()
        rag = _rag(cid)
        if rag is None:
            failures.append(label)
            continue
        cfg = _search_config(cid)
        # Retrieve a wider candidate set than we return so the reranker has
        # something to work with — same ratio the /api/rag/search route uses.
        try:
            candidate_k = max(k, min(int(cfg.get("candidate_top_k", 40)), 100))
        except (TypeError, ValueError):
            candidate_k = max(k, 40)
        results = (
            rag.search(
                query,
                k=k,
                owner=owner,
                candidate_k=candidate_k,
                scope=scope,
                exclude_scopes=exclude,
            )
            or []
        )
        for r in results:
            # Which base a hit came from — the model needs it to pass
            # `collection` back to rag_get_document.
            r["collection"] = label
        hits.extend(results)

    if failures and not hits:
        raise ToolError(
            _rag_unavailable_text()
            + (f" (unreachable: {', '.join(failures)})" if len(collections) > 1 else "")
        )

    if len(collections) > 1:
        # Each base reranked its own candidates with the same cross-encoder, so
        # the scores are comparable and one merged ordering is meaningful.
        hits.sort(key=_hit_rank, reverse=True)
        hits = hits[:k]

    text = render_search_results(query, hits)
    if failures:
        text += (
            "\n\n_(Not searched — currently unavailable: "
            + ", ".join(sorted(failures))
            + ".)_"
        )
    return text


def _default_collection_id() -> str:
    from src.rag_registry import DEFAULT_ID

    return DEFAULT_ID


def _hit_rank(hit: Dict[str, Any]) -> float:
    """Sort key for merging hits from several bases. Reranked score wins;
    similarity is the fallback for a pipeline with reranking switched off."""
    for key in ("rerank_score", "similarity"):
        value = hit.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return 0.0


def render_search_results(query: str, results: List[Dict[str, Any]]) -> str:
    """Render search hits as the answer block a model receives.

    Split out of `_tool_rag_query` so the REST service (`src/rag_api.py`) can
    return byte-identical text *and* the structured hits from a single
    retrieval — reranking is a remote call, so searching twice to get both
    views would double the latency of every query.
    """
    if not results:
        return f"No passages found for {query!r}."

    # Share the per-tool budget across the hits rather than cutting every
    # passage at a fixed snippet length: one hit at topK=1 can carry a whole
    # section, twenty hits still fit in the same envelope. Headers and a safety
    # margin come off the top so `call_tool`'s outer cap never has to truncate
    # the last passage away.
    n = max(1, len(results))
    share = (int(MAX_TEXT_CHARS * 0.95) - HEADER_ALLOWANCE * n) // n
    budget = max(MIN_PASSAGE_CHARS, min(PASSAGE_CHARS, share))

    lines = [f"{len(results)} passage(s) for {query!r}:\n"]
    for i, r in enumerate(results, 1):
        meta = r.get("metadata") or {}
        source = meta.get("source") or meta.get("filename") or "unknown"
        filename = meta.get("filename") or os.path.basename(str(source)) or "unknown"
        # rerank_score is the number that actually ordered these; similarity is
        # the pre-rerank hybrid score. Show whichever the pipeline produced.
        score = r.get("rerank_score")
        score_label = "rerank" if score is not None else "similarity"
        if score is None:
            score = r.get("similarity")
        page = meta.get("page")
        header = f"### {i}. {filename}"
        if isinstance(page, (int, float)) and not isinstance(page, bool):
            header += f" (page {int(page)})"
        lines.append(header)
        lines.append(f"- source: `{source}`")
        if r.get("collection"):
            lines.append(f"- collection: `{r['collection']}`")
        if score is not None:
            try:
                lines.append(f"- {score_label}: {float(score):.4f}")
            except (TypeError, ValueError):
                pass
        if meta.get("modality") and meta.get("modality") != "text":
            lines.append(f"- modality: {meta['modality']}")
        # `expanded` is small-to-big: the matched chunk's whole section, which
        # the retrieval pipeline already fetched (src/rag_vector.py). It is what
        # Talos's own chat injects, so an external client gets the same context
        # the in-app model reasons over — and usually needs no follow-up call.
        # The citation still points at the matched chunk.
        passage = (r.get("expanded") or r.get("document") or "").strip()
        if r.get("expanded"):
            lines.append("- context: full section")
        lines.append("")
        lines.append(_truncate(passage, budget))
        lines.append("")
    return "\n".join(lines)


def _tool_rag_list_collections(allowed: Optional[Set[str]] = None) -> str:
    """The knowledge-base catalogue, so a client can address bases by id.

    Driven by the registry, not by Qdrant: an unreachable backend must still be
    able to say which bases *exist*, so the document counts (which do hit
    Qdrant, behind the registry's cache) degrade to "no count" rather than
    failing the call.

    ``allowed`` restricts the listing to those base ids (the administrator's
    MCP setting — see `src/mcp_settings.py`); None lists everything, which is
    what the in-app and REST callers get.
    """
    from src.rag_registry import DEFAULT_ID, describe, list_bases

    bases = list_bases() or []
    if allowed is not None:
        bases = [b for b in bases if str(b.get("id")) in allowed]
        if not bases:
            return "No knowledge bases are shared with external clients on this Talos instance."
    if not bases:
        return "No knowledge bases are registered."

    lines = [f"{len(bases)} knowledge base(s):", ""]
    for entry in bases:
        try:
            row = describe(entry, with_counts=True)
        except Exception:
            row = describe(entry, with_counts=False)
        rid = str(row.get("id") or "")
        head = f"- **{rid}** — {row.get('name') or rid}"
        if rid == DEFAULT_ID:
            head += " _(default — used when `collections` is omitted)_"
        lines.append(head)
        if row.get("description"):
            lines.append(f"  {row['description']}")
        facts = []
        if row.get("language"):
            facts.append(f"language: {row['language']}")
        if row.get("content_count") is not None:
            facts.append(f"documents: {row['content_count']}")
        if facts:
            lines.append("  " + " · ".join(facts))
    return "\n".join(lines)


def _tool_rag_list_documents(args: Dict[str, Any]) -> str:
    collection = _collection_arg(args)
    _validate_collections([collection])
    rag = _rag(collection)
    if rag is None:
        raise ToolError(_rag_unavailable_text())

    limit = _clamp_limit(args.get("limit"), default=100, hi=500)
    needle = str(args.get("filter") or "").strip().lower()

    docs = filter_documents(rag.list_documents(exclude_scopes=DEFAULT_EXCLUDE_SCOPES) or [], needle)
    return render_document_list(docs, limit, filtered=bool(needle))


def filter_documents(docs: List[Dict[str, Any]], needle: str) -> List[Dict[str, Any]]:
    """Case-insensitive substring match on filename or source path."""
    needle = (needle or "").strip().lower()
    if not needle:
        return docs
    return [
        d
        for d in docs
        if needle in str(d.get("filename", "")).lower()
        or needle in str(d.get("source", "")).lower()
    ]


def render_document_list(
    docs: List[Dict[str, Any]], limit: int, filtered: bool = False
) -> str:
    """Render a document listing as the block a model receives. Shared with the
    REST service so both surfaces describe an index identically."""
    if not docs:
        return "No indexed documents match." if filtered else "No documents are indexed."

    total = len(docs)
    shown = docs[:limit]
    lines = [
        f"{total} indexed document(s)"
        + (f", showing {len(shown)}:" if total > len(shown) else ":"),
        "",
    ]
    for d in shown:
        lines.append(
            f"- **{d.get('filename') or 'unknown'}** — {d.get('chunks', 0)} chunk(s)\n"
            f"  source: `{d.get('source')}`"
        )
    return "\n".join(lines)


def _tool_rag_get_document(args: Dict[str, Any]) -> str:
    source = str(args.get("source") or "").strip()
    if not source:
        raise ToolError("`source` is required. Get it from rag_query or rag_list_documents.")

    collection = _collection_arg(args)
    _validate_collections([collection])
    rag = _rag(collection)
    if rag is None:
        raise ToolError(_rag_unavailable_text())

    max_chunks = _clamp_limit(args.get("max_chunks"), default=50, hi=200)
    chunks = rag.get_document_chunks(source) or []
    if not chunks:
        raise ToolError(
            f"No indexed document with source {source!r} in knowledge base "
            f"{collection or _default_collection_id()!r}. Use rag_list_documents "
            "to see the exact source strings, and check the `collection` shown "
            "on the rag_query hit."
        )

    shown = chunks[:max_chunks]
    header = f"# {os.path.basename(source) or source}\n\nsource: `{source}`\n"
    if len(chunks) > len(shown):
        header += f"\n_Showing {len(shown)} of {len(chunks)} chunks._\n"
    body = "\n\n".join((c.get("content") or "").strip() for c in shown if c.get("content"))
    return header + "\n" + body


# ---------------------------------------------------------------------------
# Skills tools
# ---------------------------------------------------------------------------


def _skills(skills_manager=None):
    """The SkillsManager to read from.

    The app's instance is injected by the route (app.py owns the one built in
    `initialize_managers`). The fallback builds a fresh one from DATA_DIR:
    SkillsManager is disk-backed and holds no mutable state, so a second
    instance reads exactly the same skills — it just keeps this module usable
    from tests and a future stdio wrapper without app.py in the picture.
    """
    if skills_manager is not None:
        return skills_manager
    try:
        from services.memory.skills import SkillsManager
        from src.constants import DATA_DIR

        return SkillsManager(DATA_DIR)
    except Exception:
        logger.warning("SkillsManager unavailable for MCP", exc_info=True)
        return None


def _skill_filter():
    """The administrator's MCP skill gate — see src/mcp_settings.py.

    Applied on top of `index_for` / `published_only`, never instead of them:
    the MCP setting narrows what leaves the instance, it can't widen it into
    drafts or another user's skills.
    """
    from src import mcp_settings

    return mcp_settings.skill_filter()


def _gate_note() -> str:
    """Explain a name that exists but isn't shared over MCP.

    Without this an external client sees the same "no such skill" it gets for
    a typo and retries the spelling forever.
    """
    return (
        "\n\n_(This Talos instance shares only selected skills over MCP. "
        "Ask an administrator to add it in Settings → MCP.)_"
    )


def _owner_note(owner: Optional[str]) -> str:
    """Explain an empty skills result rather than leaving the caller guessing.

    Skills are owner-scoped on disk. A token minted by user X only ever sees
    X's skills, so "no skills" usually means "none owned by this token's
    owner" — not "none exist".
    """
    if owner:
        return f"\n\n_(Searching skills owned by `{owner}` — the owner of this API token.)_"
    return ""


def _tool_skills_list(args: Dict[str, Any], owner: Optional[str], sm) -> str:
    sm = _skills(sm)
    if sm is None:
        raise ToolError("The skills library is not available on this Talos instance.")

    category = str(args.get("category") or "").strip().lower()
    # index_for() is the same view the agent gets in its system prompt:
    # published skills only (plus platform/toolset gating), never raw drafts.
    idx = sm.index_for(owner=owner) or []
    allowed = _skill_filter()
    idx = [s for s in idx if allowed(s.get("name"))]
    if category:
        idx = [s for s in idx if str(s.get("category", "")).lower() == category]
    if not idx:
        which = f" in category {category!r}" if category else ""
        return f"No published skills{which}." + _owner_note(owner)

    lines = [f"{len(idx)} published skill(s):", ""]
    current = None
    for s in idx:
        cat = s.get("category") or "general"
        if cat != current:
            lines.append(f"## {cat}")
            current = cat
        lines.append(f"- **{s['name']}** — {s.get('description', '')}")
    return "\n".join(lines)


def _tool_skills_search(args: Dict[str, Any], owner: Optional[str], sm) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("`query` is required and must not be empty.")

    sm = _skills(sm)
    if sm is None:
        raise ToolError("The skills library is not available on this Talos instance.")

    max_items = _clamp_k(args.get("max_items") if args.get("max_items") is not None else 5)
    # published_only: this result reaches a model that will follow it as a
    # proven procedure, and a draft is by definition unreviewed. Same rule the
    # in-app skill search applies (src/tool_implementations.py).
    allowed = _skill_filter()
    # Filtered before the rerank budget is spent, so a gated skill can't push a
    # shareable one out of the max_items window.
    pool = [s for s in sm.load(owner=owner) if allowed(s.get("name"))]
    results = sm.get_relevant_skills(query, pool, max_items=max_items, published_only=True)
    if not results:
        return f"No published skills match {query!r}." + _owner_note(owner)

    lines = []
    for sk in results:
        proc = sk.get("procedure") or sk.get("steps") or []
        lines.append(
            f"**{sk['name']}** — {sk.get('description', '')}\n"
            f"  When to use: {sk.get('when_to_use', '')}\n"
            f"  Steps: {' → '.join(proc[:5]) if proc else '(see skills_get)'}"
        )
    return "\n\n".join(lines)


def _tool_skills_get(args: Dict[str, Any], owner: Optional[str], sm) -> str:
    name = str(args.get("name") or "").strip()
    if not name:
        raise ToolError("`name` is required. Get it from skills_list or skills_search.")

    sm = _skills(sm)
    if sm is None:
        raise ToolError("The skills library is not available on this Talos instance.")

    if not _skill_filter()(name):
        raise ToolError(f"Skill {name!r} is not shared over MCP." + _gate_note())

    md = sm.read_skill_md(name, owner=owner)
    if md is None:
        raise ToolError(f"No skill named {name!r}." + _owner_note(owner))
    return md


def _skill_tool_name(slug: Any) -> Optional[str]:
    """MCP tool name for a skill slug, or None if it can't be represented.

    Tool names have to survive a client that treats them as identifiers, so
    anything outside ``[a-z0-9_-]`` becomes an underscore. The mapping is
    lossy — two slugs can collide — which is why `skill_tools` keeps the first
    and `_resolve_skill_tool` re-derives names from the same list rather than
    trying to invert this.
    """
    slug = str(slug or "").strip().lower()
    if not slug:
        return None
    safe = "".join(c if (c.isalnum() and c.isascii()) or c in "-_" else "_" for c in slug)
    safe = safe.strip("_")
    if not safe:
        return None
    return (SKILL_TOOL_PREFIX + safe)[:64]


def _visible_skills(owner: Optional[str], skills_manager) -> List[Dict[str, Any]]:
    """The skills this caller may see, as (name, description, when_to_use).

    `index_for` is the same view Talos's own agent gets — published skills only
    (plus platform/toolset gating) — narrowed further by the administrator's
    MCP skill gate. `load` is consulted only to enrich the entries with
    `when_to_use`, which the index doesn't carry but a tool description wants.
    """
    sm = _skills(skills_manager)
    if sm is None:
        return []
    try:
        idx = sm.index_for(owner=owner) or []
    except Exception:
        logger.warning("skills index unavailable for MCP", exc_info=True)
        return []
    allowed = _skill_filter()
    idx = [s for s in idx if allowed(s.get("name"))]
    try:
        detail = {str(s.get("name")): s for s in (sm.load(owner=owner) or [])}
    except Exception:
        detail = {}
    out = []
    for s in idx:
        full = detail.get(str(s.get("name"))) or {}
        out.append(
            {
                "name": s.get("name"),
                "description": s.get("description") or full.get("description") or "",
                "when_to_use": full.get("when_to_use") or "",
            }
        )
    return out


def skill_tools(owner: Optional[str] = None, skills_manager=None) -> List[Dict[str, Any]]:
    """One MCP tool per published skill.

    A caller whose agent framework filters tools by name (MACS does) can then
    grant a role its skills through the tool list itself, instead of hoping the
    model reaches for skills_search. Calling one returns that skill's SKILL.md —
    the same text skills_get gives — because a Talos skill *is* a written
    procedure, not an executable: the model still carries it out with its own
    tools. The description says so, so a model doesn't wait for side effects
    that are never coming.
    """
    from src import mcp_settings

    # Two switches: the family, and this shape of it. An administrator with a
    # large library may want skills_search without a hundred tools in every
    # client's palette.
    if not mcp_settings.skills_enabled() or not mcp_settings.skills_per_skill_tools():
        return []

    out: List[Dict[str, Any]] = []
    seen = set()
    for skill in _visible_skills(owner, skills_manager):
        tool_name = _skill_tool_name(skill["name"])
        if not tool_name or tool_name in seen or tool_name in _STATIC_TOOL_NAMES:
            continue
        seen.add(tool_name)
        parts = []
        if skill["description"]:
            parts.append(str(skill["description"]).strip())
        if skill["when_to_use"]:
            parts.append(f"When to use: {str(skill['when_to_use']).strip()}")
        parts.append(
            "Returns the full written procedure for this skill; carry it out "
            "with your own tools."
        )
        out.append(
            {
                "name": tool_name,
                "title": f"Skill: {skill['name']}",
                "description": " ".join(parts),
                "inputSchema": {"type": "object", "properties": {}},
            }
        )
        if len(out) >= MAX_SKILL_TOOLS:
            logger.info(
                "MCP skill tools capped at %s; the rest stay reachable via skills_search",
                MAX_SKILL_TOOLS,
            )
            break
    return out


def _resolve_skill_tool(tool_name: str, owner: Optional[str], skills_manager) -> Optional[str]:
    """The skill slug behind a ``skill_*`` tool name, or None.

    Re-derived from the caller's own visible-skill list, so a name that was
    never offered to *this* caller — a gated skill, another owner's — resolves
    to nothing and is reported as an unknown tool.
    """
    for skill in _visible_skills(owner, skills_manager):
        if _skill_tool_name(skill["name"]) == tool_name:
            return str(skill["name"])
    return None


def _tool_skills_read_reference(args: Dict[str, Any], owner: Optional[str], sm) -> str:
    name = str(args.get("name") or "").strip()
    path = str(args.get("path") or "").strip()
    if not name or not path:
        raise ToolError("Both `name` and `path` are required.")

    sm = _skills(sm)
    if sm is None:
        raise ToolError("The skills library is not available on this Talos instance.")

    if not _skill_filter()(name):
        raise ToolError(f"Skill {name!r} is not shared over MCP." + _gate_note())

    # read_skill_reference refuses traversal outside the skill directory and
    # returns None for anything it won't serve, so no path check is needed here.
    text = sm.read_skill_reference(name, path, owner=owner)
    if text is None:
        raise ToolError(f"No reference {path!r} under skill {name!r}.")
    return text


# ---------------------------------------------------------------------------
# Web tools
# ---------------------------------------------------------------------------
# These wrap src/web_search.py, which already carries the parts that matter:
# the administrator's domain allow/deny policy, the outbound-query leak guard,
# and the SSRF check that re-validates every redirect hop. Nothing is
# re-implemented here — this is argument marshalling and error mapping only.


def _unwrap(outcome: Dict[str, Any]) -> str:
    """Turn a web_search-style ``{results}`` / ``{error}`` dict into text."""
    if not isinstance(outcome, dict):
        raise ToolError("The web backend returned an unexpected response.")
    if outcome.get("error"):
        raise ToolError(str(outcome["error"]))
    return str(outcome.get("results") or "")


def _tool_web_search(args: Dict[str, Any]) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("`query` is required and must not be empty.")

    from src import mcp_settings
    from src.web_search import search

    # A missing or zero max_results means "unspecified", not "zero results" —
    # fall back to the administrator's MCP default rather than clamping up to 1.
    default_results = mcp_settings.web_max_results()
    requested = args.get("max_results")
    max_results = (
        _clamp_limit(requested, default=default_results, hi=20) if requested else default_results
    )

    outcome = _run_async(
        search(
            query=query,
            max_results=max_results,
            language=str(args.get("language") or ""),
            category=str(args.get("category") or ""),
            time_range=str(args.get("time_range") or ""),
            page=_clamp_limit(args.get("page"), default=1, hi=50),
            # The leak guard scopes itself to a Talos chat session's retrieved
            # documents. An MCP caller has no such session, so there is no
            # context to leak and nothing to scope to.
            session_id="",
            # None when the admin left MCP inheriting the web-UI policy.
            policy=mcp_settings.web_policy(),
            # MCP-only: the in-app agent always searches at 0.
            safesearch=mcp_settings.web_safesearch(),
        )
    )
    return _unwrap(outcome)


def _tool_web_fetch(args: Dict[str, Any]) -> str:
    url = str(args.get("url") or "").strip()
    if not url:
        raise ToolError("`url` is required. Get one from web_search.")

    from src import mcp_settings
    from src.web_search import MAX_FETCH_CHARS, fetch

    default_chars = mcp_settings.web_max_fetch_chars()
    max_chars = args.get("max_chars")
    try:
        max_chars = max(500, min(int(max_chars), MAX_FETCH_CHARS))
    except (TypeError, ValueError):
        max_chars = default_chars

    return _unwrap(
        _run_async(fetch(url=url, max_chars=max_chars, policy=mcp_settings.web_policy()))
    )


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


class ToolError(Exception):
    """A tool-level failure.

    Surfaced to the client as an MCP result with ``isError: true`` rather than
    a JSON-RPC error — per the MCP spec, a tool that fails to do its job is a
    successful call with an error result, so the model can read the message and
    correct itself.
    """


def call_tool(
    name: str,
    arguments: Optional[Dict[str, Any]],
    *,
    granted_scopes,
    owner: Optional[str] = None,
    skills_manager=None,
) -> Tuple[str, bool]:
    """Run one tool. Returns ``(text, is_error)``.

    Blocking — the RAG search hits Qdrant and a rerank endpoint over HTTP, and
    the skills manager reads from disk. The HTTP route calls this in a worker
    thread so the event loop stays free.
    """
    args = arguments if isinstance(arguments, dict) else {}
    granted = set(granted_scopes or ())

    required = scope_for_tool(name)
    if required is None:
        return f"Unknown tool: {name!r}.", True
    if required not in granted:
        # Same message whether the tool exists but is out of scope — the tool
        # list already told this caller what it may use.
        return (
            f"Tool {name!r} requires the {required!r} scope, which this API token does not carry.",
            True,
        )

    # A tool the administrator switched off in Settings → MCP. Checked here as
    # well as in `list_tools`, because a client may have cached an older list
    # or simply call a name it knows.
    from src import mcp_settings

    if not mcp_settings.tool_enabled(_TOOL_ALIASES.get(name, name)):
        return (f"Tool {name!r} is disabled on this Talos instance.", True)

    try:
        # The administrator's knowledge-base and result-size policy. Applied to
        # a *copy* of the arguments here rather than inside the tool bodies,
        # which the REST service (src/rag_api.py) shares and which must stay
        # unrestricted for in-instance callers.
        rag_bases = mcp_settings.rag_bases()
        # rag_list_collections is left out: it takes no arguments, and it is
        # filtered where it is dispatched below. Refusing it when nothing is
        # shared would deny the client the one call that says so.
        if name.startswith("rag_") and name != "rag_list_collections":
            args = _apply_rag_policy(
                args,
                rag_bases,
                mcp_settings.rag_max_results(),
                mcp_settings.rag_allowed_scopes(),
            )
        # A per-skill tool (see `skill_tools`). Resolved against this caller's
        # own visible skills, then answered exactly as skills_get would.
        if name.startswith(SKILL_TOOL_PREFIX):
            slug = _resolve_skill_tool(name, owner, skills_manager)
            if slug is None:
                return (
                    f"Unknown tool: {name!r}. Call skills_list to see the "
                    "skills this token can reach." + _owner_note(owner),
                    True,
                )
            return _truncate(_tool_skills_get({"name": slug}, owner, skills_manager)), False
        # `rag_search` is the pre-`rag_query` name. Still accepted — an
        # external client may have it in a saved config — but no longer listed.
        if name in ("rag_query", "rag_search"):
            return _truncate(_tool_rag_query(args)), False
        if name == "rag_list_collections":
            return _truncate(_tool_rag_list_collections(rag_bases)), False
        if name == "rag_list_documents":
            return _truncate(_tool_rag_list_documents(args)), False
        if name == "rag_get_document":
            return _truncate(_tool_rag_get_document(args)), False
        if name == "skills_list":
            return _truncate(_tool_skills_list(args, owner, skills_manager)), False
        if name == "skills_search":
            return _truncate(_tool_skills_search(args, owner, skills_manager)), False
        if name == "skills_get":
            return _truncate(_tool_skills_get(args, owner, skills_manager)), False
        if name == "skills_read_reference":
            return _truncate(_tool_skills_read_reference(args, owner, skills_manager)), False
        if name == "web_search":
            return _truncate(_tool_web_search(args)), False
        if name == "web_fetch":
            return _truncate(_tool_web_fetch(args)), False
    except ToolError as e:
        return str(e), True
    except Exception as e:
        # Never leak a traceback to an external client; log it here instead.
        logger.exception("MCP tool %s failed", name)
        return f"{name} failed: {type(e).__name__}: {e}", True

    return f"Unknown tool: {name!r}.", True
