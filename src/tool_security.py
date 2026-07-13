"""Server-side tool safety policy."""

from __future__ import annotations

import logging
from typing import Optional, Set

logger = logging.getLogger(__name__)


# Tools regular/public users must not execute directly. These either expose
# server/runtime access, sensitive user data, external messaging, persistent
# state changes, or generic loopback/integration surfaces.
NON_ADMIN_BLOCKED_TOOLS = {
    "bash",
    "python",
    "run_cell",
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "glob",
    "ls",
    "search_chats",
    "manage_skills",
    "manage_endpoints",
    "manage_mcp",
    "manage_tokens",
    "manage_documents",
    "manage_settings",
    "api_call",
    "vault_search",
    "vault_get",
    "vault_unlock",
}


# Plan mode allows investigation only. Mutating tools are blocked by converting
# this allowlist into the existing disabled-tools denylist.
PLAN_MODE_READONLY_TOOLS = {
    "read_file",
    "grep",
    "glob",
    "ls",
    "search_chats",
    "list_models",
    "list_sessions",
    # Lets the planner resolve a genuine ambiguity by asking the user a
    # multiple-choice question (it ends the turn and waits) instead of
    # re-deriving the answer itself. Read-only: it mutates nothing.
    "ask_user",
}


_PLAN_MODE_KNOWN_MUTATORS = {
    "bash",
    "python",
    "run_cell",
    "write_file",
    "edit_file",
    "create_document",
    "edit_document",
    "update_document",
    "suggest_document",
    "manage_documents",
    "create_session",
    "manage_session",
    "send_to_session",
    "manage_skills",
    "manage_endpoints",
    "manage_mcp",
    "manage_tokens",
    "manage_settings",
    "api_call",
    "generate_image",
}


def plan_mode_disabled_tools() -> Set[str]:
    """Return tool names to disable while proposing a plan.

    Fails closed: if dynamic schema discovery fails, known mutators are still
    disabled. New unknown tools default to disabled when present in schemas.
    """
    try:
        import src.agent_tools  # noqa: F401
        from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

        all_names = {(t.get("function") or {}).get("name") for t in FUNCTION_TOOL_SCHEMAS}
        all_names.discard(None)
    except Exception as exc:
        logger.warning("Unable to load tool schemas for plan-mode gating: %s", exc)
        all_names = set()
    return (all_names | _PLAN_MODE_KNOWN_MUTATORS) - PLAN_MODE_READONLY_TOOLS


def is_public_blocked_tool(tool_name: Optional[str]) -> bool:
    """Return True when a non-admin/public user must not execute this tool.

    This is a security gate, so it fails CLOSED: a malformed non-string tool
    name can't be matched against the blocklist or the ``mcp__`` namespace, so
    it is treated as blocked rather than silently allowed through. ``None`` /
    empty string means there is no tool to gate.
    """
    if tool_name is None or tool_name == "":
        return False
    if not isinstance(tool_name, str):
        return True
    return tool_name in NON_ADMIN_BLOCKED_TOOLS or tool_name.startswith("mcp__")


def owner_is_admin_or_single_user(owner: Optional[str]) -> bool:
    """Return True for admins, or when auth is not configured yet."""
    try:
        from core.auth import AuthManager

        auth = AuthManager()
        if not auth.is_configured:
            return True
        return bool(owner and auth.is_admin(owner))
    except Exception as exc:
        logger.warning("Unable to evaluate owner admin status: %s", exc)
        return False


def blocked_tools_for_owner(owner: Optional[str]) -> Set[str]:
    """Tools to hide/disable for this owner under public-user policy."""
    if owner_is_admin_or_single_user(owner):
        return set()
    return set(NON_ADMIN_BLOCKED_TOOLS)
