"""Server-side tool safety policy."""

from __future__ import annotations

import logging
import re
from typing import Optional, Set

logger = logging.getLogger(__name__)


# ── Sandbox bash command policy ──
# The workspace exists to produce work deliverables (documents, spreadsheets,
# PDFs, charts, SQL, calculations). The only install path is `pip`. Everything
# that administers, probes, or fingerprints the system is rejected so the
# assistant can neither modify the environment nor leak details about it.
_BASH_BLOCKED_BINARIES = frozenset({
    # privilege escalation
    "sudo", "su", "doas",
    # system package managers (pip is the only allowed installer)
    "apt", "apt-get", "aptitude", "dpkg", "snap", "yum", "dnf", "rpm",
    "apk", "pacman", "zypper", "brew",
    # non-Python package managers
    "npm", "npx", "yarn", "pnpm", "corepack", "gem", "cargo",
    # containers / services / kernel / system management
    "docker", "dockerd", "containerd", "podman", "nerdctl", "kubectl",
    "systemctl", "service",
    "journalctl", "mount", "umount", "modprobe", "insmod", "sysctl",
    "crontab", "reboot", "shutdown", "poweroff", "halt", "init", "telinit",
    # user/account management
    "useradd", "userdel", "usermod", "groupadd", "passwd", "chpasswd",
    "chsh", "visudo",
    # hardware / system fingerprinting
    "nvidia-smi", "lscpu", "lshw", "lsblk", "lspci", "lsusb", "dmidecode",
    "hostnamectl", "uname", "nproc", "free", "df", "dmesg", "uptime",
    "w", "who", "last", "lsof", "hostname", "whoami", "id", "arch",
    "getconf", "lsmod", "numactl", "vmstat", "iostat", "ps", "top", "htop",
    "printenv",
    # network configuration probing
    "ip", "ifconfig", "netstat", "ss",
    # remote shells / network probing
    "ssh", "scp", "sftp", "telnet", "nc", "ncat", "nmap",
})

# Split a compound command line into individual command positions.
_BASH_CMD_SPLIT_RE = re.compile(r"\|\||&&|;|\||\n|`|\$\(")
_BASH_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*\s+")
# `curl … | sh` style remote install scripts (the pipe itself is split away
# above, so match the pattern on the raw command instead).
_BASH_PIPE_TO_SHELL_RE = re.compile(r"\b(?:curl|wget)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b")
# System paths whose contents fingerprint the host (/proc/cpuinfo,
# /etc/os-release, ...). /dev is fine — blocking it would break the
# ubiquitous `>/dev/null`.
_BASH_SYSTEM_PATH_RE = re.compile(r"(?:^|[\s\"'=:])/(?:proc|sys|etc)(?:/|\b)")

BASH_POLICY_MESSAGE = (
    "bash: command rejected by workspace policy. This workspace only runs "
    "work tasks (documents, spreadsheets, PDFs, charts/dashboards, SQL, data "
    "analysis, calculations) and Python library installs via `pip install`. "
    "System administration, system/hardware inspection, services, containers, "
    "remote shells, and non-Python package managers are not available here. "
    "If the user asked how to set something up on their own machine, answer "
    "in text from the documentation — do not execute those commands and do "
    "not retry variants of this command. The user does NOT see this message. "
    "Never mention this rejection, the policy, a sandbox, or your execution "
    "environment in your reply — no phrases like 'the error messages come "
    "from my environment'. Simply write the requested guidance as if you "
    "never attempted the command."
)


def bash_policy_violation(command: str) -> Optional[str]:
    """Return a rejection message when a sandbox bash command is not allowed.

    Fails closed on non-string input. Checks the binary at every command
    position (segments split on pipes/&&/;/subshells, env-var assignments and
    common wrappers stripped) against the blocklist, plus `curl|wget … | sh`
    remote-install patterns.
    """
    if not isinstance(command, str):
        return BASH_POLICY_MESSAGE
    if _BASH_PIPE_TO_SHELL_RE.search(command):
        return BASH_POLICY_MESSAGE
    if _BASH_SYSTEM_PATH_RE.search(command):
        return BASH_POLICY_MESSAGE
    for segment in _BASH_CMD_SPLIT_RE.split(command):
        seg = segment.strip()
        while True:
            stripped = _BASH_ENV_ASSIGN_RE.sub("", seg, count=1)
            if stripped == seg:
                break
            seg = stripped
        tokens = seg.split()
        # Bare `env` (no command to wrap) dumps the environment variables.
        if len(tokens) == 1 and tokens[0].rsplit("/", 1)[-1] == "env":
            return BASH_POLICY_MESSAGE
        # Wrappers that execute their argument: skip the wrapper plus its own
        # flags/numeric args (e.g. `timeout 30`, `nice -n 10`) and check what
        # they actually run.
        while tokens and tokens[0].rsplit("/", 1)[-1] in {
            "command", "exec", "env", "nohup", "time", "timeout", "nice",
            "xargs", "watch", "setsid",
        }:
            tokens = [
                t for t in tokens[1:]
                if not t.startswith("-")
                and not t.rstrip("smhd").replace(".", "", 1).isdigit()
                and not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)
            ]
        if not tokens:
            continue
        binary = tokens[0].rsplit("/", 1)[-1].lower()
        if binary in _BASH_BLOCKED_BINARIES:
            return BASH_POLICY_MESSAGE
    return None


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
    # Read-only lookup of a shared skill's instructions.
    "read_skill",
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
