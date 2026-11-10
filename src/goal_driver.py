"""Starts the next round of a running goal, on the server.

A goal (src/goals.py) keeps a chat working round after round. Each round is an
ordinary chat turn. Until now the open chat page asked for every one of them,
so a goal stopped moving the moment the tab was closed. Here the server asks.

A turn is built by the chat route: its context, the tools for the user, the
stream, what is saved. There is exactly one of those, and a second way to start
a turn would have to stay in step with it forever. So the driver does not start
a turn itself. When a turn ends and the chat's goal is still running, it sends
the app the same request the page would have sent — in process, with no socket
— and the chat route does the rest.

Whose request it is: the user who set or resumed the goal. The page's request
that starts a goal "arms" the driver for that chat: it notes the user and the
turn's switches (knowledge, database, web, thinking, language). Later rounds go
out under the app's internal token with that user as owner, the mechanism the
tool layer already uses for calls to its own routes, so a goal is not cut short
by a login that expires overnight, and the user's own privileges still apply.

Being armed is not saved. After a restart a goal is found running but nothing
continues it until the user resumes: starting work because the process came up
is not something anyone asked for.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlencode

from src import goals

logger = logging.getLogger(__name__)

CHAT_PATH = "/api/chat_stream"
# Time the page gets to send something of its own first (a message the user
# queued during the round), before the next round is started.
GRACE_S = 1.5
# How long to wait for the app to answer the request with a status.
START_TIMEOUT_S = 120.0

# Fields of the arming request that belong to that one message, not to the
# goal's later rounds.
_PER_MESSAGE_FIELDS = frozenset(
    {"message", "session", "attachments", "artifact_selection", "ask_answers", "goal_round"}
)
# Headers that say where the request came from. A round sent from here comes
# from the app itself; forwarding these would make it look like a proxied one.
_KEPT_HEADERS = ("host", "x-tz-offset", "x-tz-name", "accept-language")
_CREDENTIAL_HEADERS = ("cookie", "authorization", "x-api-key", "x-auth-token")


@dataclass
class Arming:
    """What is needed to ask for a chat's next goal round."""

    app: Any
    owner: Optional[str]
    fields: Dict[str, str]
    headers: Dict[str, str]
    scheme: str = "http"
    server: Tuple[str, int] = ("127.0.0.1", 80)
    root_path: str = ""


_armed: Dict[str, Arming] = {}
_starting: Set[str] = set()
# Requests in flight. The app call lasts as long as the round's stream; the
# reference keeps the task from being collected mid-round.
_requests: Set[asyncio.Task] = set()


def arm(session_id: str, request: Any, form: Any, owner: Optional[str]) -> None:
    """Note how this chat's goal rounds are to be asked for. Called for every
    goal round request, so the latest one always decides."""
    fields = {
        str(k): str(v)
        for k, v in (form.items() if hasattr(form, "items") else [])
        if isinstance(v, str) and str(k) not in _PER_MESSAGE_FIELDS
    }
    headers = {name: request.headers[name] for name in _KEPT_HEADERS if request.headers.get(name)}
    if not owner:
        # No user to act for (auth is off): the round goes out the way the
        # arming request came in.
        headers.update(
            {n: request.headers[n] for n in _CREDENTIAL_HEADERS if request.headers.get(n)}
        )
    scope = getattr(request, "scope", {}) or {}
    _armed[session_id] = Arming(
        app=request.app,
        owner=owner,
        fields=fields,
        headers=headers,
        scheme=str(scope.get("scheme") or "http"),
        server=tuple(scope.get("server") or ("127.0.0.1", 80)),
        root_path=str(scope.get("root_path") or ""),
    )


def disarm(session_id: str) -> None:
    _armed.pop(session_id, None)


def is_armed(session_id: str) -> bool:
    return session_id in _armed


def view(goal: Optional[Dict[str, Any]], session_id: str) -> Optional[Dict[str, Any]]:
    """The goal as the page gets it: the record plus whether the server is
    continuing it."""
    if not goal:
        return None
    return {**goal, "armed": goal.get("status") == goals.ACTIVE and is_armed(session_id)}


def _run_active(session_id: str) -> bool:
    from src import agent_runs

    return agent_runs.is_active(session_id)


def turn_finished(session_id: str, awaiting_user: bool = False) -> Optional[asyncio.Task]:
    """A turn of this chat has ended. Starts the goal's next round if there is
    one to start. Returns the task doing so, or None.

    `awaiting_user`: the turn ended on a question to the user. The goal waits
    for the answer; the turn that carries it ends here again.
    """
    if awaiting_user or not is_armed(session_id) or not goals.is_active(session_id):
        if not goals.is_active(session_id):
            disarm(session_id)
        return None
    if session_id in _starting:
        return None
    _starting.add(session_id)
    task = asyncio.create_task(_continue(session_id))
    _requests.add(task)
    task.add_done_callback(_requests.discard)
    return task


async def _continue(session_id: str) -> None:
    try:
        await asyncio.sleep(GRACE_S)
        # Something else is running in this chat — the page sent a queued
        # message, or the user did. Starting a turn now would cancel it. Its
        # end comes through turn_finished again.
        if _run_active(session_id):
            return
        arming = _armed.get(session_id)
        if arming is None or not goals.is_active(session_id):
            return
        status = await _post_round(arming, session_id)
        if status == 200:
            return
        # 409: the goal reached its round limit or ended meanwhile; its record
        # says which. Anything else: the round could not be started (the user
        # lost access to the chat, a daily limit). Either way nothing is sent
        # again until the user resumes.
        disarm(session_id)
        if status != 409:
            logger.warning(
                "goal driver: round for chat %s was refused with status %s — goal left waiting",
                session_id,
                status,
            )
    except Exception:
        disarm(session_id)
        logger.exception("goal driver: could not start the next round for chat %s", session_id)
    finally:
        _starting.discard(session_id)


def _request_headers(arming: Arming, body: bytes) -> List[Tuple[bytes, bytes]]:
    headers = dict(arming.headers)
    headers.setdefault("host", "127.0.0.1")
    headers["content-type"] = "application/x-www-form-urlencoded"
    headers["content-length"] = str(len(body))
    headers["user-agent"] = "talos-goal-driver"
    if arming.owner:
        from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN

        headers[INTERNAL_TOOL_HEADER.lower()] = INTERNAL_TOOL_TOKEN
        headers["x-talos-owner"] = arming.owner
    return [
        (k.lower().encode("latin-1"), v.encode("latin-1", "replace")) for k, v in headers.items()
    ]


async def _post_round(arming: Arming, session_id: str) -> int:
    """Ask the app for the chat's next goal round. Returns the HTTP status.

    The response is the round's event stream, which nobody here reads: the run
    is detached from it and a page that is open follows it on its own. So the
    call returns as soon as the status is known and lets the rest drain.
    """
    body = urlencode(
        {**arming.fields, "session": session_id, "message": "goal round", "goal_round": "true"}
    ).encode("utf-8")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": arming.scheme,
        "path": CHAT_PATH,
        "raw_path": CHAT_PATH.encode("ascii"),
        "query_string": b"",
        "root_path": arming.root_path,
        "headers": _request_headers(arming, body),
        # From this machine, with no forwarding headers: the only kind of
        # request the internal token is accepted from.
        "client": ("127.0.0.1", 0),
        "server": arming.server,
        "state": {},
    }
    started: asyncio.Future = asyncio.get_running_loop().create_future()
    sent = False
    never = asyncio.Event()

    async def receive() -> Dict[str, Any]:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # Not a disconnect: the stream is to run to its end.
        await never.wait()
        return {"type": "http.disconnect"}

    async def send(message: Dict[str, Any]) -> None:
        if message.get("type") == "http.response.start" and not started.done():
            started.set_result(int(message.get("status") or 0))
        # Body chunks are dropped as they come; nothing is collected.

    async def call() -> None:
        try:
            await arming.app(scope, receive, send)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not started.done():
                started.set_exception(exc)
            else:
                logger.warning(
                    "goal driver: round stream for chat %s ended badly: %s", session_id, exc
                )
        finally:
            if not started.done():
                started.set_result(0)

    task = asyncio.create_task(call())
    _requests.add(task)
    task.add_done_callback(_requests.discard)
    return await asyncio.wait_for(asyncio.shield(started), START_TIMEOUT_S)
