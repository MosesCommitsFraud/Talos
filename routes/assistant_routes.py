"""Named AI endpoints (assistant profiles) — admin CRUD + OpenAI-compatible API.

Admin routes (require_admin):
    GET/POST    /api/assistants
    PATCH/DELETE /api/assistants/{id}

OpenAI-compatible invocation (gated by an `ody_` API token, `chat` scope):
    GET  /v1/models                  → lists enabled assistants as models
    POST /v1/chat/completions        → runs the agent loop with the assistant's
                                        capability bundle (RAG / SQL / reasoning)

Each assistant is selectable on the LAN as an OpenAI `model` (its slug), so any
OpenAI client (OpenWebUI, Continue, LangChain, curl) can drive it. See
routes/api_token_routes.py for the CRUD pattern this mirrors.
"""

import json
import logging
import re
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.database import get_db_session, AssistantEndpoint, ModelEndpoint
from core.middleware import require_admin

logger = logging.getLogger(__name__)

MAX_NAME_LEN = 100
MAX_PROMPT_LEN = 16_000
MAX_MESSAGES = 100

# Sandbox / code-execution tools that are ALWAYS blocked on the OpenAI-compatible
# invocation path. These endpoints are meant to be driven by an external agent
# framework (e.g. MS Agent Framework) that owns its own tool orchestration; the
# Talos endpoint only provides RAG + SQL + reasoning. Code execution is never
# exposed here regardless of per-assistant config.
ALWAYS_BLOCKED_TOOLS = {"bash", "python", "run_cell"}


def _slugify(name: str) -> str:
    """Lowercase, non-alphanumeric → hyphen, collapsed and trimmed."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "assistant"


def _unique_slug(db, base: str, exclude_id: str | None = None) -> str:
    """First free slug of the form base, base-2, base-3, …"""
    candidate = base
    n = 1
    while True:
        q = db.query(AssistantEndpoint).filter(AssistantEndpoint.slug == candidate)
        if exclude_id:
            q = q.filter(AssistantEndpoint.id != exclude_id)
        if not q.first():
            return candidate
        n += 1
        candidate = f"{base}-{n}"


def _clamp_temperature(value, default: float = 0.3) -> float:
    try:
        return max(0.0, min(float(value), 2.0))
    except (TypeError, ValueError):
        return default


def _clamp_max_tokens(value, default: int = 4096) -> int:
    try:
        return max(1, min(int(value), 200_000))
    except (TypeError, ValueError):
        return default


def _parse_disabled_tools(value) -> str | None:
    """Normalize a tools list (list or JSON/CSV string) to a stored JSON array."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            parsed = [t.strip() for t in value.replace(",", " ").split() if t.strip()]
    else:
        parsed = value
    if not isinstance(parsed, list):
        return None
    tools = [str(t).strip() for t in parsed if str(t).strip()]
    return json.dumps(tools) if tools else None


def _public(a: AssistantEndpoint, endpoint_name: str | None = None) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "slug": a.slug,
        "description": a.description or "",
        "endpoint_id": a.endpoint_id,
        "endpoint_name": endpoint_name,
        "model": a.model or "",
        "system_prompt": a.system_prompt or "",
        "temperature": a.temperature,
        "max_tokens": a.max_tokens,
        "use_rag": bool(a.use_rag),
        "use_sql": bool(a.use_sql),
        "reasoning": bool(a.reasoning),
        "disabled_tools": json.loads(a.disabled_tools) if a.disabled_tools else [],
        "is_enabled": bool(a.is_enabled),
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


def _require_endpoint(db, endpoint_id: str) -> ModelEndpoint:
    ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == endpoint_id).first()
    if not ep:
        raise HTTPException(400, "Unknown endpoint_id (configure a model endpoint first)")
    return ep


# ----------------------------------------------------------------------------- #
# OpenAI invocation helpers
# ----------------------------------------------------------------------------- #

def _last_user_text(messages: list[dict]) -> str:
    """Latest user message as plain text (flattening OpenAI content blocks)."""
    for m in reversed(messages or []):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [
                b.get("text", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            return "\n".join(p for p in parts if p)
    return ""


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """Coerce OpenAI messages to the {role, content:str} shape the loop expects."""
    out = []
    for m in messages or []:
        role = m.get("role") or "user"
        content = m.get("content")
        if isinstance(content, list):
            content = "\n".join(
                b.get("text", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        out.append({"role": role, "content": content or ""})
    return out


def setup_assistant_routes(chat_processor=None, session_manager=None) -> APIRouter:
    router = APIRouter(tags=["assistants"])

    # ------------------------------------------------------------------ #
    # Admin CRUD — /api/assistants
    # ------------------------------------------------------------------ #

    @router.get("/api/assistants")
    def list_assistants(request: Request):
        require_admin(request)
        with get_db_session() as db:
            rows = db.query(AssistantEndpoint).order_by(AssistantEndpoint.created_at).all()
            ep_names = {
                e.id: e.name
                for e in db.query(ModelEndpoint.id, ModelEndpoint.name).all()
            }
            return [_public(a, ep_names.get(a.endpoint_id)) for a in rows]

    @router.post("/api/assistants")
    async def create_assistant(request: Request):
        require_admin(request)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            raise HTTPException(400, "Invalid JSON body")
        name = str(payload.get("name", "")).strip()[:MAX_NAME_LEN]
        if not name:
            raise HTTPException(400, "Assistant name is required")
        endpoint_id = str(payload.get("endpoint_id", "")).strip()
        if not endpoint_id:
            raise HTTPException(400, "endpoint_id is required")

        with get_db_session() as db:
            _require_endpoint(db, endpoint_id)
            slug = _unique_slug(db, _slugify(payload.get("slug") or name))
            a = AssistantEndpoint(
                id=str(uuid.uuid4())[:8],
                name=name,
                slug=slug,
                description=(str(payload.get("description") or "")[:MAX_PROMPT_LEN] or None),
                endpoint_id=endpoint_id,
                model=(str(payload.get("model") or "").strip() or None),
                system_prompt=(str(payload.get("system_prompt") or "")[:MAX_PROMPT_LEN] or None),
                temperature=_clamp_temperature(payload.get("temperature"), 0.3),
                max_tokens=_clamp_max_tokens(payload.get("max_tokens"), 4096),
                use_rag=bool(payload.get("use_rag", False)),
                use_sql=bool(payload.get("use_sql", False)),
                reasoning=bool(payload.get("reasoning", True)),
                disabled_tools=_parse_disabled_tools(payload.get("disabled_tools")),
                is_enabled=bool(payload.get("is_enabled", True)),
            )
            db.add(a)
            db.flush()
            return _public(a)

    @router.patch("/api/assistants/{assistant_id}")
    async def update_assistant(request: Request, assistant_id: str):
        require_admin(request)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            raise HTTPException(400, "Invalid JSON body")
        with get_db_session() as db:
            a = db.query(AssistantEndpoint).filter(AssistantEndpoint.id == assistant_id).first()
            if not a:
                raise HTTPException(404, "Assistant not found")
            if "name" in payload and str(payload["name"]).strip():
                a.name = str(payload["name"]).strip()[:MAX_NAME_LEN]
            if "slug" in payload and str(payload["slug"]).strip():
                a.slug = _unique_slug(db, _slugify(str(payload["slug"])), exclude_id=a.id)
            if "description" in payload:
                a.description = str(payload["description"] or "")[:MAX_PROMPT_LEN] or None
            if "endpoint_id" in payload and str(payload["endpoint_id"]).strip():
                _require_endpoint(db, str(payload["endpoint_id"]).strip())
                a.endpoint_id = str(payload["endpoint_id"]).strip()
            if "model" in payload:
                a.model = str(payload["model"] or "").strip() or None
            if "system_prompt" in payload:
                a.system_prompt = str(payload["system_prompt"] or "")[:MAX_PROMPT_LEN] or None
            if "temperature" in payload:
                a.temperature = _clamp_temperature(payload["temperature"], a.temperature)
            if "max_tokens" in payload:
                a.max_tokens = _clamp_max_tokens(payload["max_tokens"], a.max_tokens)
            for flag in ("use_rag", "use_sql", "reasoning", "is_enabled"):
                if flag in payload:
                    setattr(a, flag, bool(payload[flag]))
            if "disabled_tools" in payload:
                a.disabled_tools = _parse_disabled_tools(payload["disabled_tools"])
            db.add(a)
            db.flush()
            return _public(a)

    @router.delete("/api/assistants/{assistant_id}")
    def delete_assistant(request: Request, assistant_id: str):
        require_admin(request)
        with get_db_session() as db:
            deleted = db.query(AssistantEndpoint).filter(
                AssistantEndpoint.id == assistant_id
            ).delete()
            if not deleted:
                raise HTTPException(404, "Assistant not found")
        return {"status": "deleted"}

    # ------------------------------------------------------------------ #
    # OpenAI-compatible API — /v1/*  (API-token gated)
    # ------------------------------------------------------------------ #

    def _require_chat_token(request: Request):
        if not getattr(request.state, "api_token", False):
            raise HTTPException(403, "This endpoint requires an API token")
        scopes = set(getattr(request.state, "api_token_scopes", []) or [])
        if "chat" not in scopes:
            raise HTTPException(403, "API token is not scoped for chat")
        return getattr(request.state, "api_token_owner", None)

    @router.get("/v1/models")
    def list_models(request: Request):
        _require_chat_token(request)
        with get_db_session() as db:
            rows = db.query(AssistantEndpoint).filter(
                AssistantEndpoint.is_enabled == True  # noqa: E712
            ).order_by(AssistantEndpoint.created_at).all()
            created = int(time.time())
            return {
                "object": "list",
                "data": [
                    {
                        "id": a.slug,
                        "object": "model",
                        "created": created,
                        "owned_by": "talos",
                    }
                    for a in rows
                ],
            }

    class ChatCompletionRequest(BaseModel):
        model: str = Field(..., max_length=200)
        messages: list[dict] = Field(..., max_length=MAX_MESSAGES)
        stream: bool = False
        temperature: float | None = None
        max_tokens: int | None = None

    @router.post("/v1/chat/completions")
    async def chat_completions(request: Request, body: ChatCompletionRequest):
        owner = _require_chat_token(request)
        if not body.messages:
            raise HTTPException(400, "messages is required")

        # Resolve the assistant config by slug.
        with get_db_session() as db:
            a = db.query(AssistantEndpoint).filter(
                AssistantEndpoint.slug == body.model
            ).first()
            if not a:
                raise HTTPException(404, f"Unknown model: {body.model}")
            if not a.is_enabled:
                raise HTTPException(400, f"Assistant '{a.slug}' is disabled")
            cfg = _public(a)  # snapshot before the session closes

        from src.endpoint_resolver import resolve_endpoint_by_id

        resolved = resolve_endpoint_by_id(cfg["endpoint_id"], cfg["model"], owner=owner)
        if not resolved:
            raise HTTPException(502, "Upstream model endpoint is unavailable or disabled")
        chat_url, upstream_model, headers = resolved

        # Build RAG / system-prompt preface (memory skipped — stateless API).
        preface: list[dict] = []
        if chat_processor is not None:
            try:
                preface, _rag, _web = chat_processor.build_context_preface(
                    message=_last_user_text(body.messages),
                    session=None,
                    use_rag=cfg["use_rag"],
                    use_memory=False,
                    preset_system_prompt=cfg["system_prompt"] or None,
                    owner=owner,
                    agent_mode=True,
                    incognito=True,
                )
            except Exception as e:
                logger.warning("Assistant preface build failed: %s", e)
                preface = (
                    [{"role": "system", "content": cfg["system_prompt"]}]
                    if cfg["system_prompt"] else []
                )

        messages = preface + _normalize_messages(body.messages)
        temperature = (
            _clamp_temperature(body.temperature, cfg["temperature"])
            if body.temperature is not None else cfg["temperature"]
        )
        max_tokens = (
            _clamp_max_tokens(body.max_tokens, cfg["max_tokens"])
            if body.max_tokens is not None else cfg["max_tokens"]
        )
        # Always strip sandbox code-execution tools (external agent frameworks
        # orchestrate their own tools); merge with any per-assistant blocks.
        disabled = set(cfg["disabled_tools"]) | ALWAYS_BLOCKED_TOOLS

        from src.agent_loop import stream_agent_loop

        async def _run_loop():
            async for chunk in stream_agent_loop(
                chat_url,
                upstream_model,
                messages,
                headers=headers,
                temperature=temperature,
                max_tokens=max_tokens,
                force_db=cfg["use_sql"],
                reasoning=cfg["reasoning"],
                disabled_tools=disabled,
                owner=owner,
            ):
                yield chunk

        completion_id = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())

        # ---- Streaming: re-wrap visible deltas as OpenAI chat.completion.chunks
        if body.stream:
            async def event_stream():
                role_sent = False
                async for chunk in _run_loop():
                    if not chunk.startswith("data: "):
                        continue
                    raw = chunk[6:].strip()
                    if raw == "[DONE]":
                        break
                    try:
                        data = json.loads(raw)
                    except Exception:
                        continue
                    delta = data.get("delta")
                    if delta is None or data.get("thinking"):
                        continue  # drop reasoning + Talos-only events
                    out_delta = {"content": delta}
                    if not role_sent:
                        out_delta["role"] = "assistant"
                        role_sent = True
                    payload = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": cfg["slug"],
                        "choices": [{"index": 0, "delta": out_delta, "finish_reason": None}],
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                done = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": cfg["slug"],
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                yield f"data: {json.dumps(done)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(event_stream(), media_type="text/event-stream")

        # ---- Non-streaming: aggregate visible text into one chat.completion
        content = ""
        async for chunk in _run_loop():
            if not chunk.startswith("data: "):
                continue
            raw = chunk[6:].strip()
            if raw == "[DONE]":
                break
            try:
                data = json.loads(raw)
            except Exception:
                continue
            delta = data.get("delta")
            if delta is not None and not data.get("thinking"):
                content += delta

        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": cfg["slug"],
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    return router
