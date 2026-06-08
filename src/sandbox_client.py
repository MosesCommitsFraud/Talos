import os
from pathlib import Path
from typing import Any

import httpx


SANDBOX_URL = os.getenv("TALOS_SANDBOX_URL", "http://talos-sandbox:7800").rstrip("/")
# Timeout for quick control-plane calls (file ops, ensure, etc.). Code execution
# is NOT bounded by this — see exec_in_sandbox, which uses no read timeout so a
# long-running bash/python job is never cut off client-side.
SANDBOX_TIMEOUT = float(os.getenv("TALOS_SANDBOX_EXEC_TIMEOUT_SECONDS", "180"))

# Shared-secret header sent on every sandbox call (matches the daemon's
# TALOS_SANDBOX_KEY). Empty when unset → no header, daemon auth disabled.
_SANDBOX_KEY = os.getenv("TALOS_SANDBOX_KEY", "").strip()
_SANDBOX_HEADERS = {"X-Talos-Sandbox-Key": _SANDBOX_KEY} if _SANDBOX_KEY else {}


def sandbox_enabled() -> bool:
    return os.getenv("TALOS_SANDBOX_TOOLS", "true").lower() not in {"0", "false", "no", "off"}


def safe_user_id(owner: str | None) -> str:
    return owner or "anonymous"


async def exec_in_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    kind: str,
    command: str = "",
    code: str = "",
    timeout: int = 120,
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeError("sandbox execution requires a session_id")
    user_id = safe_user_id(owner)
    # No read/write/pool timeout: a long compute or install must not be cut off.
    # Only the connect phase is bounded. The sandbox enforces its own limit via
    # the `timeout` field (0 = unlimited there too).
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)) as client:
        resp = await client.post(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/exec",
            json={"kind": kind, "command": command, "code": code, "timeout": timeout},
        )
        resp.raise_for_status()
        return resp.json()


async def file_tool_in_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeError("sandbox file operation requires a session_id")
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
        resp = await client.post(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/files/{operation}",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


def _sandbox_filename(path: str, display_name: str | None = None) -> str:
    stored_name = Path(path).name
    return Path(display_name or stored_name).name.replace("/", "_").replace("\\", "_") or stored_name


async def upload_file_to_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    path: str,
    display_name: str | None = None,
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeError("sandbox upload requires a session_id")
    user_id = safe_user_id(owner)
    filename = _sandbox_filename(path, display_name)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
        with open(path, "rb") as f:
            resp = await client.post(
                f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/upload",
                files={"file": (filename, f, "application/octet-stream")},
            )
        resp.raise_for_status()
        data = resp.json()
    data["sandbox_path"] = data.get("filename") or filename
    return data


async def run_cell_in_sandbox(*, owner: str | None, session_id: str | None, code: str, timeout: int = 0) -> dict[str, Any]:
    """Run code in the chat's PERSISTENT Python kernel (state survives between calls)."""
    if not session_id:
        raise RuntimeError("run_cell requires a session_id")
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)) as client:
        resp = await client.post(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/kernel/execute",
            json={"code": code, "timeout": timeout},
        )
        resp.raise_for_status()
        return resp.json()


async def delete_workspace(*, owner: str | None, session_id: str | None) -> bool:
    """Delete a chat's sandbox workspace (files + dir). Best-effort: never raise,
    so a down/disabled sandbox can't block chat deletion. Returns True on success."""
    if not session_id or not sandbox_enabled():
        return False
    user_id = safe_user_id(owner)
    try:
        async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            resp = await client.delete(
                f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}",
            )
            resp.raise_for_status()
        return True
    except Exception:
        return False


def delete_workspace_sync(owner: str | None, session_id: str | None) -> bool:
    """Sync wrapper for delete_workspace, for use from non-async delete routes."""
    if not session_id or not sandbox_enabled():
        return False
    user_id = safe_user_id(owner)
    try:
        with httpx.Client(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            resp = client.delete(f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}")
            resp.raise_for_status()
        return True
    except Exception:
        return False


async def list_artifacts(*, owner: str | None, session_id: str | None) -> list[dict[str, Any]]:
    """List files in a chat's sandbox workspace (uploads + generated results)."""
    if not session_id:
        return []
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
        resp = await client.get(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/artifacts",
        )
        resp.raise_for_status()
        return resp.json().get("artifacts", [])


async def delete_artifact(*, owner: str | None, session_id: str | None, path: str) -> bool:
    """Delete a file or directory in a chat's workspace. Returns True on success."""
    if not session_id:
        return False
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        resp = await client.post(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/files/delete",
            json={"path": path},
        )
        resp.raise_for_status()
        data = resp.json()
    return data.get("exit_code", 1) == 0


async def download_workspace_zip(*, owner: str | None, session_id: str | None) -> bytes:
    """Fetch the whole workspace as a zip archive."""
    if not session_id:
        raise RuntimeError("zip requires a session_id")
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)) as client:
        resp = await client.get(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/files/zip",
        )
        resp.raise_for_status()
        return resp.content


async def download_artifact(*, owner: str | None, session_id: str | None, path: str) -> tuple[bytes, str, str]:
    """Fetch a workspace file's raw bytes. Returns (content, content_type, filename)."""
    if not session_id:
        raise RuntimeError("sandbox download requires a session_id")
    user_id = safe_user_id(owner)
    async with httpx.AsyncClient(headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)) as client:
        resp = await client.get(
            f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/files/download",
            params={"path": path},
        )
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "application/octet-stream")
        fname = Path(path).name
        return resp.content, ctype, fname
