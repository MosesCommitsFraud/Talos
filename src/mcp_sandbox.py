"""
mcp_sandbox.py

The `sandbox` tool of the outward MCP server (src/mcp_public.py): run Python in
the code sandbox for an external client, with files in and files out.

Talos only does the work here. Whatever the client keeps, it keeps on its own
side: the files a run creates or changes go back in the tool result, and the
sandbox account that held them is deleted when the MCP session ends.

One sandbox account per MCP session
  The session is the `Mcp-Session-Id` the route hands out at `initialize` and
  the client sends back on every call. All calls of a session run under one
  Linux account with one workspace, so a file uploaded once can be worked on
  across several calls. The account is deleted when the client ends the session
  (`DELETE /mcp`) or after SESSION_IDLE_SECONDS without a call, and on startup
  every MCP account the sandbox still holds is removed, since sessions live
  only in this process's memory.

  A session id this process does not know (one from before a restart, or one
  the reaper already ended) simply starts a fresh, empty account: the client
  keeps working and only finds earlier files gone, which the result says. A
  client that sends no session id at all gets an account for that one call.

  The account is named after a hash of the session id, never the id itself:
  the id is what lets a client into its workspace, so it stays out of paths,
  user names and logs.

Python only
  The tool takes `code` and runs it as Python, the way the chat's `python`
  tool does. Shell commands work through `subprocess` in that code; a separate
  language argument would only be one more thing for a model to get wrong.

Variables do not survive between calls; each call is a new process. Files do.
"""

import base64
import hashlib
import logging
import mimetypes
import re
import threading
import time
import uuid
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

logger = logging.getLogger(__name__)

SESSION_IDLE_SECONDS = 30 * 60
REAPER_INTERVAL_SECONDS = 60
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 600
MAX_CODE_CHARS = 100_000
MAX_INPUT_FILES = 50
# What comes back. Above these a file is named with its size but not sent, so
# one large output cannot fill the client's context or the response.
MAX_OUTPUT_FILES = 20
MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024
MAX_OUTPUT_TOTAL_BYTES = 15 * 1024 * 1024
MAX_STDOUT_CHARS = 20_000

USER_PREFIX = "mcp-"
WORKSPACE = "workspace"

# Visible ASCII, as the MCP spec requires of a session id; the length bounds
# keep a client from handing in something absurd.
_SESSION_ID_RE = re.compile(r"^[\x21-\x7e]{8,128}$")

_TEXT_TYPES = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
    "application/sql",
    "image/svg+xml",
}
_TEXT_SUFFIXES = {
    ".md",
    ".csv",
    ".tsv",
    ".json",
    ".txt",
    ".html",
    ".htm",
    ".xml",
    ".py",
    ".sql",
    ".svg",
    ".yaml",
    ".yml",
    ".log",
}

_sessions: Dict[str, float] = {}
_lock = threading.Lock()
_reaper: Optional[threading.Thread] = None


class SandboxToolError(Exception):
    """A failure the client should read and correct, not a server fault."""


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def new_session_id() -> str:
    return uuid.uuid4().hex


def valid_session_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_SESSION_ID_RE.match(value))


def _user_id(session_id: str) -> str:
    return USER_PREFIX + hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:32]


def _touch(session_id: str) -> bool:
    """Mark a session used. Returns True when it was not known yet."""
    with _lock:
        fresh = session_id not in _sessions
        _sessions[session_id] = time.monotonic()
    return fresh


def _forget(session_id: str) -> bool:
    with _lock:
        return _sessions.pop(session_id, None) is not None


def end_session(session_id: Optional[str]) -> None:
    """The client ended its MCP session: delete its sandbox account."""
    if not valid_session_id(session_id):
        return
    if _forget(session_id):
        _delete_account(_user_id(session_id))


def _expired(now: float) -> List[str]:
    with _lock:
        old = [sid for sid, at in _sessions.items() if now - at > SESSION_IDLE_SECONDS]
        for sid in old:
            _sessions.pop(sid, None)
    return old


def start_reaper() -> None:
    """Start the thread that removes leftover and idle sandbox accounts.

    Called at app startup. Its first pass removes every MCP account the sandbox
    still holds from before this process started; after that it deletes the
    accounts of sessions idle for longer than SESSION_IDLE_SECONDS.
    """
    global _reaper
    from src.sandbox_client import sandbox_enabled

    if not sandbox_enabled():
        return
    with _lock:
        if _reaper is not None and _reaper.is_alive():
            return
        _reaper = threading.Thread(target=_reap_forever, name="mcp-sandbox-reaper", daemon=True)
        _reaper.start()


def _reap_forever() -> None:
    cleaned = False
    while True:
        try:
            if not cleaned:
                with _lock:
                    keep = [_user_id(sid) for sid in _sessions]
                _post("/mcp-users/cleanup", json={"keep": keep})
                cleaned = True
            for sid in _expired(time.monotonic()):
                _delete_account(_user_id(sid))
        except Exception as e:
            # The sandbox may still be starting; the next pass tries again.
            logger.info("MCP sandbox cleanup deferred: %s", e)
        time.sleep(REAPER_INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Sandbox daemon calls
# ---------------------------------------------------------------------------


def _client(timeout: Optional[float] = 60.0):
    import httpx

    from src.sandbox_client import _SANDBOX_HEADERS

    return httpx.Client(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(timeout, connect=15.0))


def _url(path: str) -> str:
    from src.sandbox_client import SANDBOX_URL

    return f"{SANDBOX_URL}{path}"


def _post(path: str, **kwargs) -> Dict[str, Any]:
    with _client() as c:
        resp = c.post(_url(path), **kwargs)
        resp.raise_for_status()
        return resp.json()


def _workspace_path(user_id: str) -> str:
    return f"/users/{quote(user_id, safe='')}/workspaces/{WORKSPACE}"


def _delete_account(user_id: str) -> None:
    try:
        with _client() as c:
            c.delete(_url(f"/users/{quote(user_id, safe='')}")).raise_for_status()
    except Exception as e:
        logger.warning("Could not delete MCP sandbox account %s: %s", user_id, e)


# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------


def _clamp_timeout(value: Any) -> int:
    try:
        return max(1, min(int(value), MAX_TIMEOUT))
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT


def _input_files(raw: Any) -> List[Tuple[str, bytes]]:
    if raw in (None, []):
        return []
    if not isinstance(raw, list):
        raise SandboxToolError("`files` must be a list of {name, content, encoding} objects.")
    if len(raw) > MAX_INPUT_FILES:
        raise SandboxToolError(f"At most {MAX_INPUT_FILES} files per call.")
    out = []
    for item in raw:
        if not isinstance(item, dict):
            raise SandboxToolError("Each entry in `files` must be an object with name and content.")
        name = PurePosixPath(str(item.get("name") or "").replace("\\", "/")).name
        if not name or name in (".", ".."):
            raise SandboxToolError("Each file needs a `name`, such as data.csv.")
        content = item.get("content")
        if not isinstance(content, str):
            raise SandboxToolError(f"{name}: `content` must be a string.")
        encoding = str(item.get("encoding") or "text").lower()
        if encoding == "base64":
            try:
                data = base64.b64decode(content, validate=True)
            except Exception:
                raise SandboxToolError(f"{name}: `content` is not valid base64.")
        elif encoding == "text":
            data = content.encode("utf-8")
        else:
            raise SandboxToolError(f"{name}: `encoding` must be 'text' or 'base64'.")
        out.append((name, data))
    return out


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


def _mime(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def _is_text(path: str, mime: str) -> bool:
    return (
        mime.startswith("text/")
        or mime in _TEXT_TYPES
        or PurePosixPath(path).suffix.lower() in _TEXT_SUFFIXES
    )


def file_block(path: str, data: bytes) -> Dict[str, Any]:
    """One output file as an MCP content block.

    Images as `image`, so a client shows them; text as an embedded resource
    with `text`, so the model can read it; everything else as a resource with
    a base64 `blob`. `_meta.path` carries the workspace path, which an image
    block has no field for, so a client can save the file under its name.
    """
    mime = _mime(path)
    meta = {"path": path}
    uri = "sandbox:///" + quote(path)
    if mime.startswith("image/") and mime != "image/svg+xml":
        return {
            "type": "image",
            "data": base64.b64encode(data).decode("ascii"),
            "mimeType": mime,
            "_meta": meta,
        }
    if _is_text(path, mime):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        if text is not None:
            return {
                "type": "resource",
                "resource": {"uri": uri, "mimeType": mime, "text": text},
                "_meta": meta,
            }
    return {
        "type": "resource",
        "resource": {"uri": uri, "mimeType": mime, "blob": base64.b64encode(data).decode("ascii")},
        "_meta": meta,
    }


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def _summary(
    result: Dict[str, Any],
    timeout: int,
    sent: List[Tuple[str, int]],
    held: List[Tuple[str, Optional[int], str]],
    fresh: bool,
    persistent: bool,
) -> str:
    lines = []
    if result.get("timed_out"):
        lines.append(f"Timed out after {timeout}s; the process was stopped.")
    lines.append(f"exit_code: {int(result.get('exit_code') or 0)}")
    out = (str(result.get("stdout") or "") + str(result.get("stderr") or "")).rstrip()
    if len(out) > MAX_STDOUT_CHARS:
        out = out[:MAX_STDOUT_CHARS] + f"\n… (output cut at {MAX_STDOUT_CHARS} of {len(out)} chars)"
    lines.append("--- output ---")
    lines.append(out or "(none)")
    if sent or held:
        lines.append("--- files created or changed ---")
        lines.extend(f"{p} ({_size(n)})" for p, n in sent)
        lines.extend(
            f"{p}{f' ({_size(n)})' if n is not None else ''}: not returned, {why}"
            for p, n, why in held
        )
    if fresh and persistent:
        lines.append(
            "(New sandbox for this session: files from any earlier session are not here; "
            "send them again in `files` if the code needs them.)"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------


def run(arguments: Dict[str, Any], session_id: Optional[str]) -> Tuple[List[Dict[str, Any]], bool]:
    """Run one `sandbox` call. Returns MCP content blocks and whether it failed."""
    from src.sandbox_client import sandbox_enabled

    if not sandbox_enabled():
        return [_text("The code sandbox is switched off on this Talos instance.")], True
    try:
        code = arguments.get("code")
        if not isinstance(code, str) or not code.strip():
            raise SandboxToolError("`code` is required: the Python code to run.")
        if len(code) > MAX_CODE_CHARS:
            raise SandboxToolError(
                f"`code` is {len(code)} chars; the limit is {MAX_CODE_CHARS}. "
                "Send a long script as a file in `files` and run it with exec(open(...).read())."
            )
        files = _input_files(arguments.get("files"))
        timeout = _clamp_timeout(arguments.get("timeout", DEFAULT_TIMEOUT))
    except SandboxToolError as e:
        return [_text(str(e))], True

    persistent = valid_session_id(session_id)
    sid = session_id if persistent else new_session_id()
    fresh = _touch(sid) if persistent else True
    user_id = _user_id(sid)
    base = _workspace_path(user_id)
    try:
        with _client(timeout=None) as c:
            for name, data in files:
                c.post(
                    _url(f"{base}/upload"),
                    files={"file": (name, data, "application/octet-stream")},
                ).raise_for_status()
            resp = c.post(
                _url(f"{base}/exec"),
                json={"kind": "python", "code": code, "timeout": timeout},
            )
            resp.raise_for_status()
            result = resp.json()
            blocks: List[Dict[str, Any]] = []
            sent: List[Tuple[str, int]] = []
            held: List[Tuple[str, Optional[int], str]] = []
            budget = MAX_OUTPUT_TOTAL_BYTES
            for path in result.get("created_artifacts") or []:
                if len(sent) >= MAX_OUTPUT_FILES:
                    held.append((path, None, f"more than {MAX_OUTPUT_FILES} files"))
                    continue
                dl = c.get(_url(f"{base}/files/download"), params={"path": path})
                if dl.status_code == 404:
                    continue  # created and removed again during the run
                dl.raise_for_status()
                data = dl.content
                if len(data) > MAX_OUTPUT_FILE_BYTES:
                    held.append((path, len(data), f"over {_size(MAX_OUTPUT_FILE_BYTES)} per file"))
                    continue
                if len(data) > budget:
                    held.append((path, len(data), "the response is full"))
                    continue
                budget -= len(data)
                blocks.append(file_block(path, data))
                sent.append((path, len(data)))
        summary = _summary(result, timeout, sent, held, fresh, persistent)
        failed = bool(result.get("timed_out")) or int(result.get("exit_code") or 0) != 0
        return [_text(summary)] + blocks, failed
    except Exception as e:
        logger.warning("MCP sandbox call failed: %s", e)
        return [_text(f"The sandbox could not run the code: {type(e).__name__}: {e}")], True
    finally:
        if not persistent:
            _delete_account(user_id)


def _text(text: str) -> Dict[str, Any]:
    return {"type": "text", "text": text}
