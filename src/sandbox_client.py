import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

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


def _workspace_url(owner: str | None, session_id: str) -> str:
    """Where a chat's workspace is. All chats of a project share the project's,
    under a sandbox account of its own (src/projects.py)."""
    from src.projects import sandbox_location

    user_id, chat_id = sandbox_location(owner, session_id)
    return f"{SANDBOX_URL}/users/{quote(user_id, safe='')}/workspaces/{quote(chat_id, safe='')}"


def _chat_scope(session_id: str) -> dict[str, str]:
    """For the calls that run something: in a project's workspace, which chat this is,
    so each keeps its own Python kernel, working directory and recent code."""
    from src.projects import project_of_ref, project_of_session

    if project_of_ref(session_id) or not project_of_session(session_id):
        return {}
    return {"scope": session_id}


async def exec_in_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    kind: str,
    command: str = "",
    code: str = "",
    timeout: int = 120,
    edits: list[dict[str, Any]] | None = None,
    code_id: str = "",
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeError("sandbox execution requires a session_id")
    # No read/write/pool timeout: a long compute or install must not be cut off.
    # Only the connect phase is bounded. The sandbox enforces its own limit via
    # the `timeout` field (0 = unlimited there too).
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)
    ) as client:
        resp = await client.post(
            f"{_workspace_url(owner, session_id)}/exec",
            params=_chat_scope(session_id),
            json={
                "kind": kind,
                "command": command,
                "code": code,
                "timeout": timeout,
                "edits": edits or [],
                "code_id": code_id,
            },
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
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)
    ) as client:
        resp = await client.post(
            f"{_workspace_url(owner, session_id)}/files/{operation}",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


async def unpack_zip_in_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    dest: str,
    zip_bytes: bytes,
) -> dict[str, Any]:
    """Unpack a zip under the workspace-relative folder `dest`. Binary-safe,
    one request for the whole archive (a skill bundle can be dozens of files)."""
    import base64

    return await file_tool_in_sandbox(
        owner=owner,
        session_id=session_id,
        operation="unpack",
        payload={"path": dest, "zip_b64": base64.b64encode(zip_bytes).decode("ascii")},
    )


def _sandbox_filename(path: str, display_name: str | None = None) -> str:
    stored_name = Path(path).name
    return (
        Path(display_name or stored_name).name.replace("/", "_").replace("\\", "_") or stored_name
    )


async def upload_file_to_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    path: str,
    display_name: str | None = None,
) -> dict[str, Any]:
    if not session_id:
        raise RuntimeError("sandbox upload requires a session_id")
    filename = _sandbox_filename(path, display_name)
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)
    ) as client:
        with open(path, "rb") as f:
            resp = await client.post(
                f"{_workspace_url(owner, session_id)}/upload",
                files={"file": (filename, f, "application/octet-stream")},
            )
        resp.raise_for_status()
        data = resp.json()
    data["sandbox_path"] = data.get("filename") or filename
    return data


async def run_cell_in_sandbox(
    *,
    owner: str | None,
    session_id: str | None,
    code: str,
    timeout: int = 0,
    edits: list[dict[str, Any]] | None = None,
    code_id: str = "",
) -> dict[str, Any]:
    """Run code in the chat's PERSISTENT Python kernel (state survives between calls)."""
    if not session_id:
        raise RuntimeError("run_cell requires a session_id")
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)
    ) as client:
        resp = await client.post(
            f"{_workspace_url(owner, session_id)}/kernel/execute",
            params=_chat_scope(session_id),
            json={"code": code, "timeout": timeout, "edits": edits or [], "code_id": code_id},
        )
        resp.raise_for_status()
        return resp.json()


def _shared_with_project(session_id: str) -> bool:
    """A project chat has no workspace of its own: deleting the chat must leave the
    project's alone. Only delete_project_workspace removes that one."""
    from src.projects import project_of_session

    return project_of_session(session_id) is not None


def delete_project_workspace(project_id: str) -> bool:
    """Delete a project's shared workspace. Best-effort, like delete_workspace."""
    from src.projects import workspace_ref

    if not sandbox_enabled():
        return False
    try:
        with httpx.Client(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
        ) as client:
            resp = client.delete(_workspace_url(None, workspace_ref(project_id)))
            resp.raise_for_status()
        return True
    except Exception:
        return False


def stop_project_chat_kernel(project_id: str, session_id: str) -> bool:
    """End the Python kernel a chat has in its project's workspace, for a chat that
    leaves it or goes away. The workspace stays, and with it no one else would ever
    stop this kernel. Best-effort, like delete_workspace."""
    from src.projects import workspace_ref

    if not sandbox_enabled():
        return False
    try:
        with httpx.Client(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
        ) as client:
            resp = client.post(
                f"{_workspace_url(None, workspace_ref(project_id))}/kernel/reset",
                params={"scope": session_id},
            )
            resp.raise_for_status()
        return True
    except Exception:
        return False


def copy_workspace_into_project(*, owner: str | None, session_id: str, project_id: str) -> bool:
    """Copy a chat's private workspace into its project's. Files already there stay,
    and the private copy remains, so a chat moved out again finds its files. Never
    raises: False means it is still to do."""
    from src.projects import WORKSPACE_CHAT_ID, workspace_ref

    if not sandbox_enabled():
        return True
    source = (
        f"{SANDBOX_URL}/users/{quote(safe_user_id(owner), safe='')}"
        f"/workspaces/{quote(session_id, safe='')}"
    )
    try:
        with httpx.Client(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=10.0)
        ) as client:
            resp = client.post(
                f"{source}/copy-into",
                json={
                    "target_user_id": workspace_ref(project_id),
                    "target_chat_id": WORKSPACE_CHAT_ID,
                },
            )
            resp.raise_for_status()
        return True
    except Exception:
        return False


async def delete_workspace(*, owner: str | None, session_id: str | None) -> bool:
    """Delete a chat's sandbox workspace (files + dir). Best-effort: never raise,
    so a down/disabled sandbox can't block chat deletion. Returns True on success."""
    if not session_id or not sandbox_enabled() or _shared_with_project(session_id):
        return False
    try:
        async with httpx.AsyncClient(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
        ) as client:
            resp = await client.delete(
                f"{_workspace_url(owner, session_id)}",
            )
            resp.raise_for_status()
        return True
    except Exception:
        return False


def delete_workspace_sync(owner: str | None, session_id: str | None) -> bool:
    """Sync wrapper for delete_workspace, for use from non-async delete routes."""
    if not session_id or not sandbox_enabled() or _shared_with_project(session_id):
        return False
    try:
        with httpx.Client(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
        ) as client:
            resp = client.delete(f"{_workspace_url(owner, session_id)}")
            resp.raise_for_status()
        return True
    except Exception:
        return False


async def fork_workspace(*, owner: str | None, session_id: str, target_session_id: str) -> bool:
    """Give a forked chat the source chat's workspace, as hard links rather than
    copies. Never raises: a fork without its files beats no fork, and False lets
    the caller say so. True also when there is no sandbox and so nothing to carry."""
    if not sandbox_enabled():
        return True
    # A fork stays in the project, and so in the workspace it already shares.
    if _shared_with_project(session_id):
        return True
    try:
        async with httpx.AsyncClient(
            headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=10.0)
        ) as client:
            resp = await client.post(
                f"{_workspace_url(owner, session_id)}/fork",
                json={"target_chat_id": target_session_id},
            )
            resp.raise_for_status()
        return True
    except Exception:
        return False


async def list_artifacts(*, owner: str | None, session_id: str | None) -> list[dict[str, Any]]:
    """List files in a chat's sandbox workspace (uploads + generated results)."""
    if not session_id:
        return []
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)
    ) as client:
        resp = await client.get(
            f"{_workspace_url(owner, session_id)}/artifacts",
        )
        resp.raise_for_status()
        return resp.json().get("artifacts", [])


async def list_workspace(*, owner: str | None, session_id: str) -> dict[str, Any]:
    """A workspace's files and folders. `dirs` is what keeps an empty folder on
    screen; an older sandbox doesn't send it, and folders then come from the paths."""
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)
    ) as client:
        resp = await client.get(f"{_workspace_url(owner, session_id)}/artifacts")
        resp.raise_for_status()
        data = resp.json()
    return {"artifacts": data.get("artifacts", []), "dirs": data.get("dirs", [])}


async def list_artifacts_bulk(
    *, owner: str | None, session_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    """Workspace files for many chats in one call, keyed by session id. Chats
    without a workspace are absent. Raises on an older sandbox without the
    route (404), so callers can fall back to leaving workspace files out."""
    if not session_ids:
        return {}
    user_path = quote(safe_user_id(owner), safe="")
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)
    ) as client:
        resp = await client.post(
            f"{SANDBOX_URL}/users/{user_path}/artifacts",
            json={"chat_ids": session_ids},
        )
        resp.raise_for_status()
        return resp.json().get("workspaces", {})


async def move_artifact(*, owner: str | None, session_id: str | None, src: str, dst: str) -> bool:
    """Rename/move a file inside a chat's workspace. Returns True on success."""
    if not session_id:
        return False
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
    ) as client:
        resp = await client.post(
            f"{_workspace_url(owner, session_id)}/files/move",
            json={"src": src, "dst": dst},
        )
        resp.raise_for_status()
        data = resp.json()
    return data.get("exit_code", 1) == 0


async def delete_artifact(*, owner: str | None, session_id: str | None, path: str) -> bool:
    """Delete a file or directory in a chat's workspace. Returns True on success."""
    if not session_id:
        return False
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(30.0, connect=10.0)
    ) as client:
        resp = await client.post(
            f"{_workspace_url(owner, session_id)}/files/delete",
            json={"path": path},
        )
        resp.raise_for_status()
        data = resp.json()
    return data.get("exit_code", 1) == 0


async def download_workspace_zip(*, owner: str | None, session_id: str | None) -> bytes:
    """Fetch the whole workspace as a zip archive."""
    if not session_id:
        raise RuntimeError("zip requires a session_id")
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)
    ) as client:
        resp = await client.get(
            f"{_workspace_url(owner, session_id)}/files/zip",
        )
        resp.raise_for_status()
        return resp.content


async def download_artifact(
    *, owner: str | None, session_id: str | None, path: str
) -> tuple[bytes, str, str]:
    """Fetch a workspace file's raw bytes. Returns (content, content_type, filename)."""
    if not session_id:
        raise RuntimeError("sandbox download requires a session_id")
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(None, connect=15.0)
    ) as client:
        resp = await client.get(
            f"{_workspace_url(owner, session_id)}/files/download",
            params={"path": path},
        )
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "application/octet-stream")
        fname = Path(path).name
        return resp.content, ctype, fname


async def preview_office_artifact(*, owner: str | None, session_id: str | None, path: str) -> bytes:
    """Render a workspace Word document to PDF in the sandbox."""
    if not session_id:
        raise RuntimeError("office preview requires a session_id")
    async with httpx.AsyncClient(
        headers=_SANDBOX_HEADERS, timeout=httpx.Timeout(120.0, connect=15.0)
    ) as client:
        resp = await client.get(
            f"{_workspace_url(owner, session_id)}/files/office-preview",
            params={"path": path},
        )
        resp.raise_for_status()
        return resp.content
