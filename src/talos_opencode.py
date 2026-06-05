import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx


logger = logging.getLogger(__name__)

SANDBOX_URL = os.getenv("TALOS_SANDBOX_URL", "http://talos-sandbox:7800").rstrip("/")
OPENCODE_TIMEOUT = float(os.getenv("TALOS_OPENCODE_TIMEOUT_SECONDS", "600"))

_session_cache: dict[tuple[str, str], dict[str, str]] = {}


def _sse(payload: Any) -> str:
    if payload == "[DONE]":
        return "data: [DONE]\n\n"
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _safe_user_id(user: str | None) -> str:
    return user or "anonymous"


def _latest_prompt(current_message: str, attachment_paths: list[str]) -> str:
    prompt = current_message or "Please review the attached files."
    if attachment_paths:
        files = "\n".join(f"- {path}" for path in attachment_paths)
        prompt = f"{prompt}\n\nFiles available in the workspace:\n{files}"
    return prompt


def _opencode_tools(disabled_tools: set[str] | None) -> dict[str, bool]:
    disabled = disabled_tools or set()
    tools: dict[str, bool] = {}
    if {"bash", "python"} & disabled:
        tools["bash"] = False
    if "read_file" in disabled:
        tools["read"] = False
        tools["grep"] = False
        tools["glob"] = False
    if "write_file" in disabled:
        tools["edit"] = False
        tools["write"] = False
    return tools


async def _ensure_runtime(client: httpx.AsyncClient, user_id: str, chat_id: str) -> tuple[str, str]:
    await client.post(f"{SANDBOX_URL}/users/{user_id}/ensure")
    workspace_resp = await client.post(f"{SANDBOX_URL}/users/{user_id}/workspaces/{chat_id}/ensure")
    workspace_resp.raise_for_status()
    opencode_resp = await client.post(f"{SANDBOX_URL}/users/{user_id}/opencode/start")
    opencode_resp.raise_for_status()
    base_url = opencode_resp.json()["base_url"].rstrip("/")
    for _ in range(40):
        try:
            resp = await client.get(f"{base_url}/app")
            if resp.status_code < 500:
                break
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.25)
    return workspace_resp.json()["workspace"], base_url


async def _copy_attachments(
    client: httpx.AsyncClient,
    user_id: str,
    chat_id: str,
    upload_handler: Any,
    attachment_ids: list[str],
    owner: str | None,
    auth_manager: Any,
) -> list[str]:
    copied: list[str] = []
    if not upload_handler or not attachment_ids:
        return copied
    for upload_id in attachment_ids:
        try:
            resolved = upload_handler.resolve_upload(upload_id, owner=owner, auth_manager=auth_manager)
            if not resolved:
                continue
            path = Path(resolved["path"])
            name = Path(resolved.get("name") or path.name).name
            with path.open("rb") as fh:
                resp = await client.post(
                    f"{SANDBOX_URL}/users/{user_id}/workspaces/{chat_id}/upload",
                    files={"file": (name, fh, resolved.get("mime") or "application/octet-stream")},
                )
            resp.raise_for_status()
            copied.append(str(Path(resp.json()["workspace"]) / name))
        except Exception as exc:
            logger.warning("Failed to copy attachment %s into sandbox: %s", upload_id, exc)
    return copied


async def _session_id(client: httpx.AsyncClient, base_url: str, user_id: str, chat_id: str, workspace: str) -> tuple[str, bool]:
    key = (user_id, chat_id)
    cached = _session_cache.get(key)
    if cached and cached.get("base_url") == base_url and cached.get("workspace") == workspace:
        return cached["session_id"], False
    resp = await client.post(f"{base_url}/session", params={"directory": workspace}, json={"title": f"Talos {chat_id}"})
    resp.raise_for_status()
    sid = resp.json()["id"]
    _session_cache[key] = {"base_url": base_url, "workspace": workspace, "session_id": sid}
    return sid, True


def _event_session_id(payload: dict[str, Any]) -> str | None:
    props = payload.get("properties") or {}
    if "sessionID" in props:
        return props.get("sessionID")
    part = props.get("part") or {}
    if isinstance(part, dict):
        return part.get("sessionID")
    info = props.get("info") or {}
    if isinstance(info, dict):
        return info.get("id")
    return None


def _error_text(error: Any) -> str:
    if isinstance(error, dict):
        data = error.get("data")
        if isinstance(data, dict) and data.get("message"):
            return str(data["message"])
        if error.get("message"):
            return str(error["message"])
        if error.get("name"):
            return str(error["name"])
    return str(error or "opencode session error")


async def stream_opencode_agent(
    *,
    user: str | None,
    session_id: str,
    message: str,
    messages: list[dict[str, Any]],
    attachment_ids: list[str],
    upload_handler: Any,
    auth_manager: Any,
    disabled_tools: set[str] | None = None,
    agent: str = "build",
) -> AsyncGenerator[str, None]:
    started = time.time()
    user_id = _safe_user_id(user)
    text_parts: dict[str, str] = {}
    tool_started: set[str] = set()
    tool_completed: set[str] = set()
    metrics: dict[str, Any] = {"model": os.getenv("VLLM_MODEL", "qwen3-llm")}
    full_text = ""

    async with httpx.AsyncClient(timeout=httpx.Timeout(OPENCODE_TIMEOUT, connect=20.0)) as client:
        workspace, base_url = await _ensure_runtime(client, user_id, session_id)
        attachment_paths = await _copy_attachments(client, user_id, session_id, upload_handler, attachment_ids, user, auth_manager)
        oc_session_id, _is_new_session = await _session_id(client, base_url, user_id, session_id, workspace)
        prompt_text = _latest_prompt(message, attachment_paths)

        queue: asyncio.Queue[dict[str, Any] | BaseException | None] = asyncio.Queue()
        message_roles: dict[str, str] = {}

        async def read_events() -> None:
            try:
                async with client.stream("GET", f"{base_url}/global/event") as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if not raw:
                            continue
                        event = json.loads(raw)
                        payload = event.get("payload") if isinstance(event.get("payload"), dict) else event
                        if not isinstance(payload, dict) or _event_session_id(payload) != oc_session_id:
                            continue
                        await queue.put(payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(exc)

        async def send_prompt() -> None:
            try:
                tools = _opencode_tools(disabled_tools)
                body = {
                    "agent": agent,
                    "parts": [{"type": "text", "text": prompt_text}],
                }
                if tools:
                    body["tools"] = tools
                resp = await client.post(
                    f"{base_url}/session/{oc_session_id}/message",
                    params={"directory": workspace},
                    json=body,
                )
                resp.raise_for_status()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(exc)

        reader = asyncio.create_task(read_events())
        sender = asyncio.create_task(send_prompt())
        try:
            while True:
                item = await queue.get()
                if isinstance(item, BaseException):
                    raise item
                if item is None:
                    break
                event_type = item.get("type")
                props = item.get("properties") or {}
                if event_type == "message.updated":
                    info = props.get("info") or {}
                    if isinstance(info, dict) and info.get("id"):
                        message_roles[str(info["id"])] = str(info.get("role") or "")
                elif event_type == "message.part.updated":
                    part = props.get("part") or {}
                    if message_roles.get(str(part.get("messageID"))) != "assistant":
                        continue
                    part_type = part.get("type")
                    if part_type == "text":
                        delta = props.get("delta")
                        if delta is None:
                            previous = text_parts.get(part.get("id"), "")
                            current = part.get("text") or ""
                            delta = current[len(previous):] if current.startswith(previous) else current
                            text_parts[part.get("id", "")] = current
                        if delta:
                            full_text += delta
                            yield _sse({"delta": delta})
                    elif part_type == "tool":
                        call_id = part.get("callID") or part.get("id")
                        tool = part.get("tool") or "tool"
                        state = part.get("state") or {}
                        status = state.get("status")
                        title = state.get("title") or state.get("raw") or ""
                        if status in {"pending", "running"} and call_id not in tool_started:
                            tool_started.add(call_id)
                            yield _sse({"type": "tool_start", "tool": tool, "command": title})
                        elif status in {"completed", "error"} and call_id not in tool_completed:
                            tool_completed.add(call_id)
                            output = state.get("output") if status == "completed" else state.get("error")
                            yield _sse({"type": "tool_output", "tool": tool, "command": title, "output": output or "", "exit_code": 0 if status == "completed" else 1})
                    elif part_type == "step-finish":
                        tokens = part.get("tokens") or {}
                        metrics.update({
                            "input_tokens": tokens.get("input"),
                            "output_tokens": tokens.get("output"),
                            "reasoning_tokens": tokens.get("reasoning"),
                            "cost": part.get("cost"),
                        })
                elif event_type == "session.error":
                    yield _sse({"delta": f"\n\n*[opencode error: {_error_text(props.get('error'))}]*"})
                    break
                elif event_type == "session.idle":
                    break

            await sender
            metrics["response_time"] = round(time.time() - started, 2)
            if full_text and not metrics.get("output_tokens"):
                metrics["output_tokens"] = max(1, len(full_text) // 4)
            yield _sse({"type": "metrics", "data": metrics})
            yield _sse("[DONE]")
        finally:
            reader.cancel()
            sender.cancel()
            await client.post(f"{SANDBOX_URL}/users/{user_id}/opencode/touch")
