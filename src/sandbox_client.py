import os
from pathlib import Path
from typing import Any

import httpx


SANDBOX_URL = os.getenv("TALOS_SANDBOX_URL", "http://talos-sandbox:7800").rstrip("/")
SANDBOX_TIMEOUT = float(os.getenv("TALOS_SANDBOX_EXEC_TIMEOUT_SECONDS", "180"))


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
    async with httpx.AsyncClient(timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
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
    async with httpx.AsyncClient(timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
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
    async with httpx.AsyncClient(timeout=httpx.Timeout(SANDBOX_TIMEOUT, connect=15.0)) as client:
        with open(path, "rb") as f:
            resp = await client.post(
                f"{SANDBOX_URL}/users/{user_id}/workspaces/{session_id}/upload",
                files={"file": (filename, f, "application/octet-stream")},
            )
        resp.raise_for_status()
        data = resp.json()
    data["sandbox_path"] = filename
    return data
