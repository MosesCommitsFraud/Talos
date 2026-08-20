"""Outward-facing MCP server — ``POST /mcp``.

Lets external MCP clients (Claude Desktop/Code, MACS, other agents) reach
Talos's RAG knowledge base, its skill library and its web access. The tools
themselves live in `src/mcp_public.py`; this module is only the JSON-RPC/HTTP
shell.

Transport: MCP **Streamable HTTP**, stateless flavour. Every request carries
everything the server needs, each JSON-RPC request gets a plain
``application/json`` response, and no ``Mcp-Session-Id`` is issued — the spec
makes sessions optional, and Talos's tools are read-only and independent, so
there is no per-connection state worth keeping. That also means the endpoint
survives a restart and works behind a load balancer without sticky sessions.

Rolled by hand rather than mounted from the `mcp` SDK's
``StreamableHTTPSessionManager``: that manager wants to own an anyio task group
across the app lifespan, which is exactly the pattern that already bit us in
`src/builtin_mcp.py` (cross-task cancel scopes taking down the event loop). The
subset of the protocol a read-only tool server needs is small enough that the
plumbing below is the cheaper, sturdier option.

Auth reuses the existing ``ody_`` bearer tokens: `AuthMiddleware` in app.py
validates them before the request lands here, and this module maps the token's
scopes onto the tool catalogue.
"""

import asyncio
import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from src import mcp_public

logger = logging.getLogger(__name__)

SERVER_NAME = "talos"
SERVER_TITLE = "Talos Knowledge & Skills"

# MCP revisions we can speak, newest first. We echo back the client's version
# when we know it, else our newest — per the spec's version-negotiation rules.
SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

# JSON-RPC 2.0 error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# A tools/call that hangs on an unreachable Qdrant or rerank endpoint would
# otherwise hold the client's request open indefinitely.
TOOL_TIMEOUT_SECONDS = 120

# Guard against a client posting a huge body at an endpoint that only ever
# needs small JSON-RPC frames.
MAX_BODY_BYTES = 1_000_000


def _server_version() -> str:
    """Talos's version string, for the initialize handshake."""
    try:
        from core.constants import APP_VERSION

        return str(APP_VERSION)
    except Exception:
        return os.getenv("TALOS_VERSION", "dev")


def _error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _result(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _caller_context(request: Request) -> Tuple[set, Optional[str], str]:
    """Resolve (granted_scopes, owner, label) for the current request.

    Three ways in, all already settled by `AuthMiddleware` before we run:

    * **API token** — the intended path for external clients. The token's own
      scopes decide which tools it sees, and its owner scopes the skills.
    * **Browser session** — a logged-in user poking at the endpoint from the
      same origin. They can read all of this in the UI anyway, so grant the
      full read catalogue.
    * **No auth** — AUTH_ENABLED=false or a trusted-loopback bypass. Nothing
      was authenticated, so nothing more can be checked here.
    """
    if getattr(request.state, "api_token", False):
        scopes = set(getattr(request.state, "api_token_scopes", None) or ())
        owner = getattr(request.state, "api_token_owner", None)
        return scopes, owner, f"token:{getattr(request.state, 'api_token_id', '?')}"

    all_scopes = {
        mcp_public.SCOPE_RAG_READ,
        mcp_public.SCOPE_SKILLS_READ,
        mcp_public.SCOPE_WEB_READ,
    }
    user = getattr(request.state, "current_user", None)
    return all_scopes, user, f"session:{user or 'anonymous'}"


def _negotiate_version(params: Dict[str, Any]) -> str:
    requested = params.get("protocolVersion")
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return LATEST_PROTOCOL_VERSION


async def _handle_message(
    message: Dict[str, Any], request: Request, skills_manager
) -> Optional[Dict[str, Any]]:
    """Handle one JSON-RPC message. Returns None for notifications."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return _error(None, INVALID_REQUEST, "Not a JSON-RPC 2.0 message")

    method = message.get("method")
    if not isinstance(method, str):
        return _error(message.get("id"), INVALID_REQUEST, "Missing method")

    # A message without an id is a notification: handle it, answer nothing.
    is_notification = "id" not in message
    request_id = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if is_notification:
        # notifications/initialized is the only one we expect; the rest are
        # safely ignorable by design (a notification has no reply channel).
        return None

    scopes, owner, label = _caller_context(request)

    if method == "initialize":
        return _result(
            request_id,
            {
                "protocolVersion": _negotiate_version(params),
                # No listChanged: the catalogue is static per token, so there
                # is nothing to notify about (and stateless HTTP has no
                # server→client channel to notify over anyway).
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": SERVER_NAME,
                    "title": SERVER_TITLE,
                    "version": _server_version(),
                },
                "instructions": (
                    "Talos exposes its organisational knowledge base, its "
                    "library of reviewed procedures ('skills'), and web access "
                    "through a self-hosted search engine. Use rag_search for "
                    "questions the organisation's own documents answer, "
                    "skills_search to find a proven procedure before improvising "
                    "one, and web_search/web_fetch for anything public. All "
                    "tools are read-only."
                ),
            },
        )

    if method == "ping":
        return _result(request_id, {})

    if method == "tools/list":
        tools = mcp_public.list_tools(scopes)
        return _result(request_id, {"tools": tools})

    if method == "tools/call":
        name = params.get("name")
        if not isinstance(name, str) or not name:
            return _error(request_id, INVALID_PARAMS, "tools/call requires a 'name'")
        arguments = params.get("arguments")
        try:
            # The tools block on Qdrant/rerank HTTP and on disk reads, so keep
            # them off the event loop.
            text, is_error = await asyncio.wait_for(
                asyncio.to_thread(
                    mcp_public.call_tool,
                    name,
                    arguments,
                    granted_scopes=scopes,
                    owner=owner,
                    skills_manager=skills_manager,
                ),
                timeout=TOOL_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            text, is_error = (
                f"{name} timed out after {TOOL_TIMEOUT_SECONDS}s. "
                "The knowledge base may be unreachable.",
                True,
            )
        except Exception as e:
            logger.exception("MCP tools/call failed (%s, caller=%s)", name, label)
            text, is_error = f"{name} failed: {type(e).__name__}: {e}", True

        logger.info("MCP tools/call %s by %s (error=%s)", name, label, is_error)
        # A failed tool is still a successful JSON-RPC call carrying isError —
        # that's what lets the model read the message and retry sensibly.
        return _result(
            request_id, {"content": [{"type": "text", "text": text}], "isError": is_error}
        )

    # We advertise neither resources nor prompts, but some clients probe for
    # them regardless. Empty lists are quieter than a method-not-found error.
    if method == "resources/list":
        return _result(request_id, {"resources": []})
    if method == "resources/templates/list":
        return _result(request_id, {"resourceTemplates": []})
    if method == "prompts/list":
        return _result(request_id, {"prompts": []})

    return _error(request_id, METHOD_NOT_FOUND, f"Method not found: {method}")


def setup_mcp_public_routes(skills_manager=None) -> APIRouter:
    """Build the ``/mcp`` router.

    `skills_manager` is app.py's instance, passed through so the skills tools
    read from the same manager the rest of Talos uses.
    """
    router = APIRouter(tags=["mcp_public"])

    @router.post("/mcp")
    async def mcp_endpoint(request: Request) -> Response:
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content=_error(None, INVALID_REQUEST, "Request body too large"),
            )
        try:
            payload: Union[Dict[str, Any], List[Any]] = json.loads(raw or b"")
        except Exception:
            return JSONResponse(status_code=400, content=_error(None, PARSE_ERROR, "Invalid JSON"))

        # A batch is an array; JSON-RPC batching was dropped in the 2025-06-18
        # revision but older clients still send it, and honouring it costs one
        # loop.
        if isinstance(payload, list):
            if not payload:
                return JSONResponse(
                    status_code=400, content=_error(None, INVALID_REQUEST, "Empty batch")
                )
            responses = []
            for msg in payload:
                out = await _handle_message(msg, request, skills_manager)
                if out is not None:
                    responses.append(out)
            if not responses:
                # Notifications only — nothing to answer with.
                return Response(status_code=202)
            return JSONResponse(content=responses)

        if not isinstance(payload, dict):
            return JSONResponse(
                status_code=400,
                content=_error(None, INVALID_REQUEST, "Expected a JSON-RPC object or array"),
            )

        response = await _handle_message(payload, request, skills_manager)
        if response is None:
            return Response(status_code=202)
        return JSONResponse(content=response)

    @router.get("/mcp")
    async def mcp_sse_unsupported() -> Response:
        """The spec's optional server→client SSE stream.

        Stateless servers may decline it; clients fall back to plain
        request/response on a 405.
        """
        return JSONResponse(
            status_code=405,
            content=_error(None, METHOD_NOT_FOUND, "This MCP endpoint is stateless: POST only"),
        )

    @router.delete("/mcp")
    async def mcp_session_delete() -> Response:
        """Session teardown. No sessions exist, so this is a no-op success."""
        return Response(status_code=204)

    return router
