"""
mcp_settings.py

Policy resolution for Talos's *outward-facing* MCP server (mounted at ``/mcp``).

`src/mcp_public.py` holds the tools; this module answers the one question that
sits in front of every one of them: what is this instance willing to hand to an
external client at all? The web-UI settings (`searxng_url`, the domain lists,
the skill library, the knowledge-base registry) describe what the agent may do
for a user who is logged into the browser. An MCP caller is a bearer token on
someone else's machine — same capabilities, different trust level — so each of
the three areas (web, RAG, skills) carries an ``inherit`` flag:

  * inherit ON  → the web-UI setting applies verbatim (the default, so an
                  upgrade changes nothing).
  * inherit OFF → the ``mcp_*`` values apply and the web-UI policy is ignored
                  for /mcp.

Skills and RAG deliberately have no second library: inherit OFF narrows which
of the *existing* published skills, or registered knowledge bases, go out — it
never introduces a separate copy that would then have to be kept in sync. RAG
additionally has a per-tool allow-list, because "may search, may not download
whole documents" is a distinction worth drawing for an outside caller.

Every lookup goes through `get_setting`, which is cached and re-read on save,
so this stays a plain function call — no state, no reload hook.
"""

import logging
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


def _get(key: str, default: Any) -> Any:
    """One setting, falling back to `default` when settings can't be read.

    Fails *open* on the enable flags by way of their defaults: a broken
    settings file should not silently blank out an integration the admin
    can no longer see the state of.
    """
    try:
        from src.settings import get_setting

        return get_setting(key, default)
    except Exception as e:  # settings unavailable during early boot
        logger.debug("MCP setting %s lookup failed: %s", key, e)
        return default


def _bool(key: str, default: bool) -> bool:
    val = _get(key, default)
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "on")
    return bool(val)


def _int(key: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(int(_get(key, default)), hi))
    except (TypeError, ValueError):
        return default


def _allowed_tools(key: str, known: tuple) -> Set[str]:
    """Resolve one tool-family allow-list against the tools that exist.

    Names outside `known` are dropped rather than trusted: the setting is an
    allow-list of things that exist, so a typo narrows the catalogue instead of
    silently inventing a tool.

    The default is every tool in `known`, which is also what an instance
    upgraded from before the setting existed gets — `get_setting` merges
    DEFAULT_SETTINGS, and `_get` falls back to the same list if settings can't
    be read at all. An *explicitly* empty list therefore means what it says:
    none of them.
    """
    configured = _get(key, list(known))
    if isinstance(configured, str):
        configured = configured.split()
    if not isinstance(configured, (list, tuple)):
        return set(known)
    return {str(n).strip() for n in configured} & set(known)


def _list(key: str) -> List[str]:
    val = _get(key, [])
    if isinstance(val, str):
        val = val.split()
    if not isinstance(val, (list, tuple)):
        return []
    return [str(x).strip() for x in val if str(x).strip()]


# ── Web ──


def web_enabled() -> bool:
    """Whether web_search / web_fetch are offered over MCP at all."""
    return _bool("mcp_web_enabled", True)


def web_policy() -> Optional[Dict[str, Any]]:
    """The domain/backend policy for MCP web calls, or None to inherit.

    None is meaningful, not an error: `src/web_search.py` reads its own
    admin settings when no policy is passed, which is exactly what
    "inherit from the web UI" means. Returning an empty dict instead would
    quietly drop the admin's domain lists for MCP callers.
    """
    if _bool("mcp_web_inherit", True):
        return None
    return {
        "searxng_url": str(_get("mcp_web_searxng_url", "") or "").strip(),
        "allowlist": _list("mcp_web_domain_allowlist"),
        "blocklist": _list("mcp_web_domain_blocklist"),
    }


def web_max_results() -> int:
    """Result count for an MCP caller that didn't name one."""
    return _int("mcp_web_max_results", 6, 1, 20)


def web_max_fetch_chars() -> int:
    """Page-text budget for an MCP caller that didn't name one."""
    return _int("mcp_web_max_fetch_chars", 8000, 500, 20_000)


# The web tools that exist, and the default allow-set — see `rag_tools` for why
# an empty or unknown-only setting falls back to all of them.
WEB_TOOLS = ("web_search", "web_fetch")


def web_tools() -> Set[str]:
    """The web_* tools this instance hands out."""
    return _allowed_tools("mcp_web_tools", WEB_TOOLS)


def web_safesearch() -> int:
    """SearxNG safe-search level for MCP callers (0 off, 1 moderate, 2 strict).

    MCP-only by design: the in-app agent searches at 0, and a bearer token on
    someone else's machine is the case where an administrator may want
    otherwise.
    """
    return _int("mcp_web_safesearch", 0, 0, 2)


# ── RAG ──

# The rag_* tools that exist, and the default allow-set.
RAG_TOOLS = (
    "rag_query",
    "rag_list_collections",
    "rag_list_documents",
    "rag_get_document",
)


def rag_enabled() -> bool:
    """Whether the rag_* tools are offered over MCP at all."""
    return _bool("mcp_rag_enabled", True)


def rag_tools() -> Set[str]:
    """The rag_* tools this instance hands out."""
    return _allowed_tools("mcp_rag_tools", RAG_TOOLS)


def rag_bases() -> Optional[Set[str]]:
    """Knowledge-base ids reachable over MCP, or None to expose all of them.

    None is the inherit case and means "don't filter" — distinct from an empty
    set, which is an administrator who switched inheritance off and then picked
    nothing, and so must expose nothing.
    """
    if _bool("mcp_rag_inherit", True):
        return None
    return {b.strip() for b in _list("mcp_rag_allowed")}


def rag_max_results() -> int:
    """Ceiling on the number of passages one MCP rag_query may return."""
    return _int("mcp_rag_max_results", 10, 1, 20)


def rag_allowed_scopes() -> Set[str]:
    """Sub-index namespaces (src/rag_scopes.py) an MCP caller may ask for.

    Empty by default, and empty means none. A scope is a set of documents a
    Talos *feature* manages for itself — the SQL schema files today — which
    ordinary retrieval deliberately never returns; `rag_query`'s `scope`
    argument was the one way past that from outside. Opening one is now a
    decision an administrator makes by name.
    """
    return {s.strip() for s in _list("mcp_rag_allowed_scopes") if s.strip()}


# ── Skills ──


def skills_enabled() -> bool:
    """Whether the skills_* tools are offered over MCP at all."""
    return _bool("mcp_skills_enabled", True)


# The skills_* tools that exist, and the default allow-set. The per-skill
# `skill_<slug>` tools are governed separately by `skills_per_skill_tools`:
# they are the same library in a different shape, and a client's palette is
# where the difference is felt.
SKILLS_TOOLS = ("skills_list", "skills_search", "skills_get", "skills_read_reference")


def skills_tools() -> Set[str]:
    """The skills_* tools this instance hands out."""
    return _allowed_tools("mcp_skills_tools", SKILLS_TOOLS)


def skills_per_skill_tools() -> bool:
    """Whether each published skill is also offered as its own skill_* tool."""
    return _bool("mcp_skills_per_skill_tools", True)


def skill_filter() -> Callable[[Any], bool]:
    """Predicate deciding whether one skill may leave via MCP.

    Returned as a callable so a caller filtering a whole index pays the
    settings lookup once rather than per skill. Takes `Any` rather than `str`
    because callers pass `skill.get("name")` straight in — a missing name
    normalizes to "" and is refused, which is the right answer anyway.
    """
    if _bool("mcp_skills_inherit", True):
        return lambda _name: True
    allowed = {n.strip().lower() for n in _list("mcp_skills_allowed")}
    return lambda name: str(name or "").strip().lower() in allowed


def rate_limit_per_minute() -> int:
    """Calls one API token may make to /mcp per minute; 0 = no limit.

    Enforced in `routes/mcp_public_routes.py`, which is where a caller identity
    exists. Zero is the default so an upgrade cannot throttle an integration
    that was working the day before.
    """
    return _int("mcp_rate_limit_per_minute", 0, 0, 10_000)


def tool_enabled(name: str) -> bool:
    """Whether one MCP tool is switched on for this instance.

    Two gates per family: the family switch, then that family's own tool
    allow-list. Anything outside the three families is always on — its gate is
    the token scope, which is checked separately in `mcp_public.call_tool`.

    Retired spellings (`rag_search`) are resolved to the current name before
    this is reached — see `mcp_public._TOOL_ALIASES` — so only real names are
    matched here.
    """
    if name in WEB_TOOLS:
        return web_enabled() and name in web_tools()
    if name in RAG_TOOLS:
        return rag_enabled() and name in rag_tools()
    if name in SKILLS_TOOLS:
        return skills_enabled() and name in skills_tools()
    # A per-skill `skill_<slug>` tool: the library in its other shape.
    if name.startswith("skill_"):
        return skills_enabled() and skills_per_skill_tools()
    return True
