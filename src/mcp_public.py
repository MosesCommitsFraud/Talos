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
from typing import Any, Dict, List, Optional, Tuple

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
# Per-result snippet in rag_search. The client re-queries with
# `rag_get_document` when it needs the surrounding text.
SNIPPET_CHARS = 800

# The SQL schema files live in their own knowledge namespace and are injected
# separately when the SQL source is active (see src/chat_processor.py). They
# are noise in ordinary retrieval, so the default search excludes them exactly
# as the chat pipeline does.
DEFAULT_EXCLUDE_SCOPES = ["sql"]


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
        "name": "rag_search",
        "title": "Search the Talos knowledge base",
        "description": (
            "Hybrid semantic + keyword search over the Talos RAG index (Qdrant "
            "dense+sparse retrieval followed by a cross-encoder rerank). Returns "
            "the most relevant document passages with their source file and "
            "score. Use this to answer questions from the organisation's indexed "
            "documents. Call rag_get_document afterwards to read a hit in full."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language question or search phrase.",
                },
                "k": {
                    "type": "integer",
                    "description": "Number of passages to return (1–20, default 5).",
                    "minimum": 1,
                    "maximum": 20,
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
            },
        },
    },
    {
        "_scope": SCOPE_RAG_READ,
        "name": "rag_get_document",
        "title": "Read an indexed document",
        "description": (
            "Return the indexed text of one document, in reading order. Pass the "
            "`source` value exactly as returned by rag_search or "
            "rag_list_documents. Only indexed documents can be read — this does "
            "not touch the filesystem."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "description": "The document's `source` identifier from rag_search.",
                },
                "max_chunks": {
                    "type": "integer",
                    "description": "Maximum chunks to include (1–200, default 50).",
                    "minimum": 1,
                    "maximum": 200,
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


def list_tools(granted_scopes) -> List[Dict[str, Any]]:
    """Tool definitions visible to a caller holding `granted_scopes`.

    Scope filtering happens at *list* time as well as at call time: a client
    that can't use a tool shouldn't see it in its palette at all.
    """
    granted = set(granted_scopes or ())
    out = []
    for spec in _TOOL_DEFS:
        if spec["_scope"] not in granted:
            continue
        out.append({k: v for k, v in spec.items() if not k.startswith("_")})
    return out


def scope_for_tool(name: str) -> Optional[str]:
    """The scope a tool requires, or None if there is no such tool."""
    for spec in _TOOL_DEFS:
        if spec["name"] == name:
            return spec["_scope"]
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


def _tool_rag_search(args: Dict[str, Any]) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("`query` is required and must not be empty.")

    rag = _rag(args.get("rag_id"))
    if rag is None:
        raise ToolError(_rag_unavailable_text())

    cfg = _search_config(args.get("rag_id"))
    k = _clamp_k(args.get("k") if args.get("k") is not None else cfg.get("search_top_k", 5))
    # Retrieve a wider candidate set than we return so the reranker has
    # something to work with — same ratio the /api/rag/search route uses.
    try:
        candidate_k = max(k, min(int(cfg.get("candidate_top_k", 40)), 100))
    except (TypeError, ValueError):
        candidate_k = max(k, 40)

    owner = str(args.get("owner") or "").strip() or None
    scope = str(args.get("scope") or "").strip() or None
    # An explicit scope means the caller wants that namespace; only apply the
    # default sql exclusion when they didn't ask for one.
    exclude = None if scope else DEFAULT_EXCLUDE_SCOPES

    results = rag.search(
        query,
        k=k,
        owner=owner,
        candidate_k=candidate_k,
        scope=scope,
        exclude_scopes=exclude,
    )
    return render_search_results(query, results)


def render_search_results(query: str, results: List[Dict[str, Any]]) -> str:
    """Render search hits as the answer block a model receives.

    Split out of `_tool_rag_search` so the REST service (`src/rag_api.py`) can
    return byte-identical text *and* the structured hits from a single
    retrieval — reranking is a remote call, so searching twice to get both
    views would double the latency of every query.
    """
    if not results:
        return f"No passages found for {query!r}."

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
        if score is not None:
            try:
                lines.append(f"- {score_label}: {float(score):.4f}")
            except (TypeError, ValueError):
                pass
        if meta.get("modality") and meta.get("modality") != "text":
            lines.append(f"- modality: {meta['modality']}")
        snippet = (r.get("document") or "").strip()
        lines.append("")
        lines.append(_truncate(snippet, SNIPPET_CHARS))
        lines.append("")
    return "\n".join(lines)


def _tool_rag_list_documents(args: Dict[str, Any]) -> str:
    rag = _rag(args.get("rag_id"))
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
        raise ToolError("`source` is required. Get it from rag_search or rag_list_documents.")

    rag = _rag(args.get("rag_id"))
    if rag is None:
        raise ToolError(_rag_unavailable_text())

    max_chunks = _clamp_limit(args.get("max_chunks"), default=50, hi=200)
    chunks = rag.get_document_chunks(source) or []
    if not chunks:
        raise ToolError(
            f"No indexed document with source {source!r}. "
            "Use rag_list_documents to see the exact source strings."
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
    results = sm.get_relevant_skills(
        query, sm.load(owner=owner), max_items=max_items, published_only=True
    )
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

    md = sm.read_skill_md(name, owner=owner)
    if md is None:
        raise ToolError(f"No skill named {name!r}." + _owner_note(owner))
    return md


def _tool_skills_read_reference(args: Dict[str, Any], owner: Optional[str], sm) -> str:
    name = str(args.get("name") or "").strip()
    path = str(args.get("path") or "").strip()
    if not name or not path:
        raise ToolError("Both `name` and `path` are required.")

    sm = _skills(sm)
    if sm is None:
        raise ToolError("The skills library is not available on this Talos instance.")

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

    from src.web_search import DEFAULT_RESULTS, search

    # A missing or zero max_results means "unspecified", not "zero results" —
    # fall back to the backend's own default rather than clamping up to 1.
    requested = args.get("max_results")
    max_results = (
        _clamp_limit(requested, default=DEFAULT_RESULTS, hi=20) if requested else DEFAULT_RESULTS
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
        )
    )
    return _unwrap(outcome)


def _tool_web_fetch(args: Dict[str, Any]) -> str:
    url = str(args.get("url") or "").strip()
    if not url:
        raise ToolError("`url` is required. Get one from web_search.")

    from src.web_search import DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS, fetch

    max_chars = args.get("max_chars")
    try:
        max_chars = max(500, min(int(max_chars), MAX_FETCH_CHARS))
    except (TypeError, ValueError):
        max_chars = DEFAULT_FETCH_CHARS

    return _unwrap(_run_async(fetch(url=url, max_chars=max_chars)))


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

    try:
        if name == "rag_search":
            return _truncate(_tool_rag_search(args)), False
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
