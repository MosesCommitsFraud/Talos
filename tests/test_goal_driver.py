"""The server continues a running goal by itself: when a turn ends it asks the
app for the next round, as the user who armed it, and never while something
else is running in the chat."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN
from src import goal_driver, goals


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setattr(goals, "_PATH", str(tmp_path / "goals.json"))
    monkeypatch.setattr(goals, "max_rounds_setting", lambda: 5)
    monkeypatch.setattr(goal_driver, "GRACE_S", 0)
    goal_driver._armed.clear()
    goal_driver._starting.clear()
    yield
    goal_driver._armed.clear()
    goal_driver._starting.clear()


class _PassThrough(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request.state.current_user = request.headers.get("x-talos-owner")
        return await call_next(request)


class FakeChat:
    """Stands in for the chat route: one goal round per request, and at the end
    of each turn it tells the driver, as the real route does."""

    def __init__(self, monkeypatch, complete_after=3, status=None):
        self.seen = []
        self.active = set()
        self.complete_after = complete_after
        self.status = status
        # Behind the same kind of middleware the real app has: a request made
        # in process has to stream through it like one from a socket.
        self.app = Starlette(
            routes=[Route("/api/chat_stream", self.chat_stream, methods=["POST"])],
            middleware=[Middleware(_PassThrough), Middleware(_PassThrough)],
        )
        monkeypatch.setattr(goal_driver, "_run_active", lambda sid: sid in self.active)

    async def chat_stream(self, request):
        form = await request.form()
        self.seen.append(
            {
                "fields": dict(form),
                "headers": dict(request.headers),
                "client": request.client.host,
                "scheme": request.url.scheme,
            }
        )
        if self.status:
            return JSONResponse({"detail": "refused"}, self.status)
        session = form["session"]
        try:
            goals.begin_round(session)
        except goals.GoalError as exc:
            return JSONResponse({"detail": str(exc)}, 409)

        async def stream():
            self.active.add(session)
            for i in range(50):  # a stream nobody reads has to run through anyway
                yield f"data: {json.dumps({'delta': 'x' * 200})}\n\n"
            await asyncio.sleep(0.01)
            if goals.get(session)["round"] >= self.complete_after:
                goals.report(session, "complete", evidence="fertig")
            self.active.discard(session)
            goal_driver.turn_finished(session)
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    def request(self, **headers):
        """The page's request that started the goal."""
        base = {"host": "talos.test", "cookie": "session=abc", "x-tz-name": "Europe/Berlin"}
        return SimpleNamespace(
            app=self.app,
            headers={**base, **headers},
            scope={"scheme": "https", "server": ("talos.test", 443), "root_path": ""},
        )


async def _settle(timeout=5.0):
    """Wait until the driver has nothing in flight."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        pending = [t for t in goal_driver._requests if not t.done()]
        if not pending and not goal_driver._starting:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("the goal driver did not settle")


FORM = {
    "message": "Ziel · Runde 1: Bericht",
    "session": "chat-1",
    "goal_round": "true",
    "use_rag": "true",
    "use_db": "false",
    "reasoning_effort": "high",
    "lang": "de",
    "attachments": '["file-1"]',
    "ask_answers": "[]",
}


async def test_the_server_runs_the_rounds_until_the_model_completes_the_goal(monkeypatch):
    chat = FakeChat(monkeypatch, complete_after=3)
    goals.create("chat-1", "Bericht fertigstellen")
    goals.begin_round("chat-1")  # round 1 was the page's own request …
    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    goal_driver.turn_finished("chat-1")  # … and now it has ended
    await _settle()

    assert len(chat.seen) == 2  # rounds 2 and 3, with nobody asking for them
    goal = goals.get("chat-1")
    assert (goal["status"], goal["round"]) == ("complete", 3)
    assert not goal_driver.is_armed("chat-1")


async def test_a_round_is_asked_for_as_the_user_who_armed_the_goal(monkeypatch):
    chat = FakeChat(monkeypatch, complete_after=2)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm(
        "chat-1", chat.request(**{"x-forwarded-for": "203.0.113.9"}), FORM, owner="anna"
    )
    goal_driver.turn_finished("chat-1")
    await _settle()

    sent = chat.seen[0]
    # The app's internal token with the user as owner: no login that can expire.
    assert sent["headers"][INTERNAL_TOOL_HEADER.lower()] == INTERNAL_TOOL_TOKEN
    assert sent["headers"]["x-talos-owner"] == "anna"
    assert "cookie" not in sent["headers"]
    # From this machine and not forwarded — the only place that token counts.
    assert sent["client"] == "127.0.0.1" and "x-forwarded-for" not in sent["headers"]
    assert sent["scheme"] == "https" and sent["headers"]["host"] == "talos.test"
    # The turn's switches come along, what belonged to that one message does not.
    fields = sent["fields"]
    assert (fields["session"], fields["goal_round"]) == ("chat-1", "true")
    assert (fields["use_rag"], fields["use_db"], fields["reasoning_effort"]) == (
        "true",
        "false",
        "high",
    )
    assert fields["lang"] == "de" and sent["headers"]["x-tz-name"] == "Europe/Berlin"
    assert "attachments" not in fields and "ask_answers" not in fields


async def test_without_a_user_the_round_goes_out_the_way_the_request_came_in(monkeypatch):
    chat = FakeChat(monkeypatch, complete_after=2)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm("chat-1", chat.request(), FORM, owner=None)
    goal_driver.turn_finished("chat-1")
    await _settle()

    headers = chat.seen[0]["headers"]
    assert headers["cookie"] == "session=abc"
    assert INTERNAL_TOOL_HEADER.lower() not in headers and "x-talos-owner" not in headers


async def test_nothing_is_started_for_a_goal_that_is_not_armed_or_not_running(monkeypatch):
    chat = FakeChat(monkeypatch)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    assert goal_driver.turn_finished("chat-1") is None  # found running, never armed

    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    assert goal_driver.turn_finished("chat-1", awaiting_user=True) is None  # a question is open
    assert goal_driver.is_armed("chat-1")  # the answer's turn continues it

    goals.pause("chat-1")
    assert goal_driver.turn_finished("chat-1") is None
    assert not goal_driver.is_armed("chat-1")
    await _settle()
    assert chat.seen == []


async def test_no_round_is_started_while_something_else_runs_in_the_chat(monkeypatch):
    chat = FakeChat(monkeypatch)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    chat.active.add("chat-1")  # the user's queued message became a turn
    goal_driver.turn_finished("chat-1")
    await _settle()

    assert chat.seen == []  # starting a turn would have cancelled theirs
    assert goal_driver.is_armed("chat-1")
    # When that turn ends, the goal picks up.
    chat.active.discard("chat-1")
    chat.complete_after = 2
    goal_driver.turn_finished("chat-1")
    await _settle()
    assert len(chat.seen) == 1 and goals.get("chat-1")["status"] == "complete"


async def test_two_endings_at_once_start_one_round(monkeypatch):
    chat = FakeChat(monkeypatch, complete_after=2)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    first = goal_driver.turn_finished("chat-1")
    second = goal_driver.turn_finished("chat-1")
    await _settle()

    assert first is not None and second is None
    assert len(chat.seen) == 1


async def test_the_round_limit_stops_the_chain(monkeypatch):
    chat = FakeChat(monkeypatch, complete_after=99)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    goal_driver.turn_finished("chat-1")
    await _settle()

    goal = goals.get("chat-1")
    assert (goal["status"], goal["reason_code"], goal["round"]) == ("blocked", "round-limit", 5)
    assert len(chat.seen) == 5  # rounds 2-5, and the one that was refused
    assert not goal_driver.is_armed("chat-1")


async def test_a_refused_round_leaves_the_goal_waiting_for_the_user(monkeypatch):
    chat = FakeChat(monkeypatch, status=403)
    goals.create("chat-1", "A")
    goals.begin_round("chat-1")
    goal_driver.arm("chat-1", chat.request(), FORM, owner="anna")
    goal_driver.turn_finished("chat-1")
    await _settle()

    assert len(chat.seen) == 1  # not retried
    assert goals.get("chat-1")["status"] == "active"
    assert not goal_driver.is_armed("chat-1")


def test_the_page_is_told_whether_the_server_is_continuing_the_goal():
    goal = goals.create("chat-1", "A")
    assert goal_driver.view(goal, "chat-1")["armed"] is False
    goal_driver._armed["chat-1"] = object()
    assert goal_driver.view(goal, "chat-1")["armed"] is True
    assert goal_driver.view(goals.pause("chat-1"), "chat-1")["armed"] is False
    assert goal_driver.view(None, "chat-1") is None
