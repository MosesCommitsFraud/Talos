"""
mcp_settings.py

Policy resolution for Talos's *outward-facing* MCP server (mounted at ``/mcp``).

`src/mcp_public.py` holds the tools; this module answers the one question that
sits in front of every one of them: what is this instance willing to hand to an
external client at all? The web-UI settings (`searxng_url`, the domain lists,
the skill library) describe what the agent may do for a user who is logged into
the browser. An MCP caller is a bearer token on someone else's machine — same
capabilities, different trust level — so each area carries an ``inherit`` flag:

  * inherit ON  → the web-UI setting applies verbatim (the default, so an
                  upgrade changes nothing).
  * inherit OFF → the ``mcp_*`` values apply and the web-UI policy is ignored
                  for /mcp.

Skills deliberately have no second library: inherit OFF narrows which of the
*existing* published skills go out, it never introduces a separate copy that
would then have to be kept in sync.

Every lookup goes through `get_setting`, which is cached and re-read on save,
so this stays a plain function call — no state, no reload hook.
"""

import logging
from typing import Any, Callable, Dict, List, Optional

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


# ── Skills ──


def skills_enabled() -> bool:
    """Whether the skills_* tools are offered over MCP at all."""
    return _bool("mcp_skills_enabled", True)


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


def tool_enabled(name: str) -> bool:
    """Whether one MCP tool is switched on for this instance.

    Tools outside the two configurable families are always on — their gate is
    the token scope, which is checked separately in `mcp_public.call_tool`.
    """
    if name in ("web_search", "web_fetch"):
        return web_enabled()
    # Both the skills_* family and the per-skill `skill_<slug>` tools
    # (mcp_public.skill_tools) hang off the same switch.
    if name.startswith("skills_") or name.startswith("skill_"):
        return skills_enabled()
    return True
