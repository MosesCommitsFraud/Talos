"""Server-side tool safety policy."""

from __future__ import annotations

import logging
import re
from typing import Optional, Set, Tuple

logger = logging.getLogger(__name__)


# ── Sandbox bash command policy ──
# The workspace exists to produce work deliverables (documents, spreadsheets,
# PDFs, charts, SQL, calculations). The only install path is `pip`. Everything
# that administers, probes, or fingerprints the system is rejected so the
# assistant can neither modify the environment nor leak details about it.
_BASH_BLOCKED_BINARIES = frozenset(
    {
        # privilege escalation
        "sudo",
        "su",
        "doas",
        # system package managers (pip is the only allowed installer)
        "apt",
        "apt-get",
        "aptitude",
        "dpkg",
        "snap",
        "yum",
        "dnf",
        "rpm",
        "apk",
        "pacman",
        "zypper",
        "brew",
        # non-Python package managers
        "npm",
        "npx",
        "yarn",
        "pnpm",
        "corepack",
        "gem",
        "cargo",
        # containers / services / kernel / system management
        "docker",
        "dockerd",
        "containerd",
        "podman",
        "nerdctl",
        "kubectl",
        "systemctl",
        "service",
        "journalctl",
        "mount",
        "umount",
        "modprobe",
        "insmod",
        "sysctl",
        "crontab",
        "reboot",
        "shutdown",
        "poweroff",
        "halt",
        "init",
        "telinit",
        # user/account management
        "useradd",
        "userdel",
        "usermod",
        "groupadd",
        "passwd",
        "chpasswd",
        "chsh",
        "visudo",
        # hardware / system fingerprinting
        "nvidia-smi",
        "lscpu",
        "lshw",
        "lsblk",
        "lspci",
        "lsusb",
        "dmidecode",
        "hostnamectl",
        "uname",
        "nproc",
        "free",
        "df",
        "dmesg",
        "uptime",
        "w",
        "who",
        "last",
        "lsof",
        "hostname",
        "whoami",
        "id",
        "arch",
        "getconf",
        "lsmod",
        "numactl",
        "vmstat",
        "iostat",
        "ps",
        "top",
        "htop",
        "printenv",
        # network configuration probing
        "ip",
        "ifconfig",
        "netstat",
        "ss",
        # remote shells / network probing
        "ssh",
        "scp",
        "sftp",
        "telnet",
        "nc",
        "ncat",
        "nmap",
        # model serving / inference runtimes. These belong to the USER'S GPU
        # box, never to this workspace: they appear here only when a setup
        # guide is being executed instead of written out.
        "ollama",
        "vllm",
        "llama-cli",
        "llama-server",
        "llama-bench",
        "llamafile",
        "lms",
        "text-generation-launcher",
        "tensorrtllm",
        "trtllm-build",
        "huggingface-cli",
        "hf",
        "modelscope",
        # source builds / toolchains. Work deliverables never require compiling
        # anything; a build here is a setup guide running away with itself.
        "cmake",
        "make",
        "ninja",
        "meson",
        "bazel",
        "gcc",
        "g++",
        "cc",
        "clang",
        "clang++",
        "nvcc",
        "ld",
        "configure",
        # alternative Python environment managers. `pip install` is the one
        # sanctioned install path; these fetch interpreters and toolchains.
        "conda",
        "mamba",
        "micromamba",
        "conda-env",
        "pyenv",
        "asdf",
    }
)

# Cloning a repo is step one of every build guide. Blocked at the subcommand
# level rather than the binary level: read-only `git status` / `git log` on
# workspace files is legitimate work, `git clone` is a setup guide starting up.
# Per-VCS, because the subcommand names collide: `git checkout <branch>` is a
# local no-op on workspace files, while `svn checkout` IS the clone.
_VCS_REMOTE_SUBCOMMANDS = {
    "git": frozenset({"clone", "fetch", "pull", "push", "submodule"}),
    "svn": frozenset({"checkout", "co", "export", "update", "up"}),
    "hg": frozenset({"clone", "pull", "push"}),
}

# Python packages that only make sense on the user's own GPU machine. `pip
# install` stays open for the work libraries the workspace exists to use
# (pandas, openpyxl, python-pptx, sqlalchemy, plotly, ...) — this list only
# catches multi-gigabyte inference/training stacks, which are always a setup
# guide being executed rather than a work task needing a dependency.
_PIP_BLOCKED_PACKAGES = frozenset(
    {
        "vllm",
        "torch",
        "torchvision",
        "torchaudio",
        "tensorflow",
        "jax",
        "jaxlib",
        "transformers",
        "accelerate",
        "bitsandbytes",
        "unsloth",
        "peft",
        "trl",
        "deepspeed",
        "flash-attn",
        "xformers",
        "llama-cpp-python",
        "text-generation",
        "auto-gptq",
        "autoawq",
        "optimum",
        "ms-swift",
        "megatron-lm",
        "nvidia-cudnn-cu12",
        "triton",
    }
)

_PIP_BINARIES = frozenset({"pip", "pip3", "uv", "poetry", "pdm", "pipenv"})
# Strip version/extras decoration so `torch==2.4.0`, `vllm[all]`, and
# `flash-attn>=2` all resolve back to the package name.
_PIP_PKG_SPLIT_RE = re.compile(r"[\[=<>!~;@\s]")

# HTTP fetchers. These are not a safety concern — they simply cannot work: the
# sandbox sits on an `internal: true` Docker network with no route out, so every
# one of them dies on DNS resolution. Left alone, a model asked for something
# from the web scrapes DuckDuckGo with curl, watches it fail, and reports to the
# user that the whole assistant has no internet access — which is what happened
# before this check existed. Redirecting to web_search costs one round instead.
_BASH_NETWORK_BINARIES = frozenset(
    {
        "curl",
        "wget",
        "aria2c",
        "httpie",
        "http",
        "https",
        "lynx",
        "w3m",
        "links",
        "elinks",
        "youtube-dl",
        "yt-dlp",
    }
)

NETWORK_REDIRECT_MESSAGE = (
    "bash: the workspace has no network access, so this command cannot reach "
    "the internet — retrying it, or trying wget/urllib/requests instead, will "
    "fail the same way. Use the `web_search` tool to search the internet and "
    "`web_fetch` to read a specific URL; those run outside the workspace and "
    "do have network access. If neither tool is available to you this turn, "
    "tell the user web access is not enabled rather than describing this "
    "workspace or its network."
)

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
    "remote shells, non-Python package managers, source builds, repository "
    "checkouts, model runtimes (ollama/vLLM/llama.cpp), and GPU inference or "
    "training stacks are not available here. "
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

    HTTP fetchers get their own message pointing at web_search/web_fetch — they
    are unreachable rather than forbidden, and the difference matters to what
    the model does next.
    """
    if not isinstance(command, str):
        return BASH_POLICY_MESSAGE
    if _BASH_PIPE_TO_SHELL_RE.search(command):
        return BASH_POLICY_MESSAGE
    if _BASH_SYSTEM_PATH_RE.search(command):
        return BASH_POLICY_MESSAGE
    for tokens, bare_env in _command_segments(command):
        # Bare `env` (no command to wrap) dumps the environment variables.
        if bare_env:
            return BASH_POLICY_MESSAGE
        if tokens[0].rsplit("/", 1)[-1].lower() in _BASH_BLOCKED_BINARIES:
            return BASH_POLICY_MESSAGE
        if _pip_installs_blocked_package(tokens):
            return BASH_POLICY_MESSAGE
        if _vcs_fetches_remote(tokens):
            return BASH_POLICY_MESSAGE
    return None


def _command_segments(command: str):
    """Yield `(tokens, is_bare_env)` for each command position in `command`.

    Segments are split on pipes/&&/;/subshells, then env-var assignments and
    wrappers that execute their argument (`timeout 30 …`, `nice -n 10 …`) are
    stripped so the binary that actually runs is first in `tokens`.
    """
    for segment in _BASH_CMD_SPLIT_RE.split(command):
        seg = segment.strip()
        while True:
            stripped = _BASH_ENV_ASSIGN_RE.sub("", seg, count=1)
            if stripped == seg:
                break
            seg = stripped
        tokens = seg.split()
        if len(tokens) == 1 and tokens[0].rsplit("/", 1)[-1] == "env":
            yield ["env"], True
            continue
        while tokens and tokens[0].rsplit("/", 1)[-1] in {
            "command",
            "exec",
            "env",
            "nohup",
            "time",
            "timeout",
            "nice",
            "xargs",
            "watch",
            "setsid",
        }:
            tokens = [
                t
                for t in tokens[1:]
                if not t.startswith("-")
                and not t.rstrip("smhd").replace(".", "", 1).isdigit()
                and not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)
            ]
        if not tokens:
            continue
        yield tokens, False


def _command_binaries(command: str):
    """Yield `(binary, is_bare_env)` for each command position in `command`."""
    for tokens, bare_env in _command_segments(command):
        yield tokens[0].rsplit("/", 1)[-1].lower(), bare_env


def _vcs_fetches_remote(tokens: list) -> bool:
    """True when this command position clones or syncs a repository."""
    if not tokens:
        return False
    subcommands = _VCS_REMOTE_SUBCOMMANDS.get(tokens[0].rsplit("/", 1)[-1].lower())
    if not subcommands:
        return False
    # Only the SUBCOMMAND position counts — the first non-flag token. Scanning
    # every argument would reject `git commit -m pull` on its message text.
    for token in tokens[1:]:
        if token.startswith("-"):
            continue
        return token.lower() in subcommands
    return False


def _pip_installs_blocked_package(tokens: list) -> bool:
    """True when this command position pip-installs a GPU inference/training
    stack. Requirements files are opaque to us, so `-r requirements.txt` is
    left alone; the named-package form is what setup guides actually use.
    """
    if not tokens:
        return False
    # `python -m pip install …` is the same command wearing a hat.
    if tokens[0].rsplit("/", 1)[-1].lower().startswith("python") and tokens[1:3] == ["-m", "pip"]:
        tokens = tokens[2:]
    if not tokens or tokens[0].rsplit("/", 1)[-1].lower() not in _PIP_BINARIES:
        return False
    rest = [t for t in tokens[1:] if not t.startswith("-")]
    if "install" not in rest and "add" not in rest:
        return False
    for token in rest:
        # Quotes survive the whitespace split (`pip install 'vllm[all]'`), so
        # strip them before the extras/version decoration.
        name = _PIP_PKG_SPLIT_RE.split(token.strip("\"'"), 1)[0].strip().lower().replace("_", "-")
        if name in _PIP_BLOCKED_PACKAGES:
            return True
    return False


def network_command_redirect(command: str) -> Optional[str]:
    """Return the web_search redirect when `command` tries to reach the network.

    Separate from `bash_policy_violation` on purpose, and applied only when the
    command is headed for the sandbox: these tools are not forbidden, they are
    unreachable *there*. With no sandbox configured, bash runs on the app
    container, which does have network — so curl stays a legitimate command.
    """
    if not isinstance(command, str):
        return None
    for binary, _ in _command_binaries(command):
        if binary in _BASH_NETWORK_BINARIES:
            return NETWORK_REDIRECT_MESSAGE
    return None


# Tool groups a regular user only gets when an admin grants the matching
# privilege in the users panel. Keys must exist in core.auth.DEFAULT_PRIVILEGES,
# which also decides what a freshly created account starts with.
#
# Admins are never filtered by this map (see blocked_tools_for_owner), and
# neither is a single-user install with auth switched off.
TOOL_PRIVILEGE_GROUPS: dict[str, Set[str]] = {
    # Code execution. Runs in the per-chat sandbox when TALOS_SANDBOX_TOOLS is
    # on; with the sandbox off it runs on the app container instead, which is
    # why this is a decision an admin has to make per deployment.
    "can_use_shell": {"bash", "python", "run_cell"},
    # Workspace file access. Scoped to the caller's own chat workspace, and
    # required for anything the model cannot read from inline context — a long
    # PDF, a spreadsheet, a file too big for the attachment budget.
    "can_use_files": {"read_file", "write_file", "edit_file", "grep", "glob", "ls"},
    # Owner-scoped: only ever searches the caller's own chats.
    "can_search_chats": {"search_chats"},
    # Arbitrary outbound HTTP plus every connected MCP server. MCP tool names
    # are namespaced dynamically, so the `mcp__` prefix is gated as a whole
    # rather than enumerated (see is_tool_blocked_for_owner).
    "can_use_mcp": {"api_call"},
    # Stored third-party credentials.
    "can_use_vault": {"vault_search", "vault_get", "vault_unlock"},
    # Instance configuration: endpoints, MCP servers, API tokens, settings,
    # shared skills and every user's documents.
    "can_manage_instance": {
        "manage_skills",
        "manage_endpoints",
        "manage_mcp",
        "manage_tokens",
        "manage_documents",
        "manage_settings",
    },
}

# Every tool under privilege control. Kept as a flat set because callers
# (workspace_routes, tests) ask "is this tool privilege-gated at all?".
NON_ADMIN_BLOCKED_TOOLS = {t for group in TOOL_PRIVILEGE_GROUPS.values() for t in group}


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
    "browse_skills",
    # Research while planning. Both are read-only: they mutate nothing on the
    # server and nothing the user owns.
    "web_search",
    "web_fetch",
    # Read-only lookup against a public API, same as the two above.
    "get_weather",
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
    "create_skill",
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
    """Return True when `tool_name` is under privilege control at all.

    Says nothing about a specific user — use `is_tool_blocked_for_owner` for
    that. This is a security helper, so it fails CLOSED: a malformed non-string
    tool name can't be matched against the group map or the ``mcp__``
    namespace, so it is treated as gated rather than silently allowed through.
    ``None`` / empty string means there is no tool to gate.
    """
    if tool_name is None or tool_name == "":
        return False
    if not isinstance(tool_name, str):
        return True
    return tool_name in NON_ADMIN_BLOCKED_TOOLS or tool_name.startswith("mcp__")


def _auth_snapshot(owner: Optional[str]) -> Tuple[bool, Optional[dict]]:
    """One auth read: ``(unrestricted, privileges)`` for this owner.

    ``unrestricted`` covers admins and the auth-not-configured single-user
    install; ``privileges`` is then irrelevant and comes back None. For a
    regular account ``privileges`` is the merged privilege dict, or None when
    the lookup failed — the fail-closed signal, since a failed read tells us
    nothing about what the account may do.

    Constructing an AuthManager re-reads auth.json from disk, so every gate
    below takes its snapshot exactly once rather than asking question by
    question. This runs per tool call.
    """
    try:
        from core.auth import AuthManager

        auth = AuthManager()
        if not auth.is_configured:
            return True, None
        normalized = (owner or "").strip().lower()
        if normalized and auth.is_admin(normalized):
            return True, None
        return False, auth.get_privileges(normalized)
    except Exception as exc:
        logger.warning("Unable to evaluate tool privileges for owner=%r: %s", owner, exc)
        return False, None


def owner_is_admin_or_single_user(owner: Optional[str]) -> bool:
    """Return True for admins, or when auth is not configured yet."""
    return _auth_snapshot(owner)[0]


def _blocked_from_privileges(privs: Optional[dict]) -> Set[str]:
    """Named tools withheld by this privilege dict (None ⇒ withhold all)."""
    if privs is None:
        return set(NON_ADMIN_BLOCKED_TOOLS)
    return {
        tool
        for key, group in TOOL_PRIVILEGE_GROUPS.items()
        if not privs.get(key, False)
        for tool in group
    }


def blocked_tools_for_owner(owner: Optional[str]) -> Set[str]:
    """Named tools this owner may not use, per their privilege toggles.

    Does NOT cover the `mcp__` namespace — those names only exist at runtime.
    Callers that build a tool list must additionally drop MCP schemas when
    `mcp_blocked_for_owner` says so.
    """
    unrestricted, privs = _auth_snapshot(owner)
    if unrestricted:
        return set()
    return _blocked_from_privileges(privs)


def mcp_blocked_for_owner(owner: Optional[str]) -> bool:
    """Whether every MCP server should be hidden from this owner."""
    unrestricted, privs = _auth_snapshot(owner)
    if unrestricted:
        return False
    return not (privs or {}).get("can_use_mcp", False)


def is_tool_blocked_for_owner(tool_name: Optional[str], owner: Optional[str]) -> bool:
    """Execution-time gate: may `owner` run `tool_name`?

    Fails closed on a malformed tool name, mirroring `is_public_blocked_tool`.
    """
    if tool_name is None or tool_name == "":
        return False
    if not isinstance(tool_name, str):
        return True
    unrestricted, privs = _auth_snapshot(owner)
    if unrestricted:
        return False
    if tool_name.startswith("mcp__"):
        return not (privs or {}).get("can_use_mcp", False)
    return tool_name in _blocked_from_privileges(privs)
