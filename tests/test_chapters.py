"""Chapters of a chat, and forking a chat at one of its messages."""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import routes.chat_helpers as chat_helpers
import routes.history_routes as history_routes
import src.session_fork as session_fork
from core.database import Base, ChatMessage
from core.database import Session as DbSession
from core.models import ChatMessage as MemoryMessage

SID = "chat-1"
AT = datetime(2026, 1, 1, 12, 0, 0)


class _Manager:
    """A single loaded chat; the router is registered once, so this stays one object."""

    def __init__(self):
        self.session = SimpleNamespace(
            id=SID, name="Report", owner="alice", endpoint_url="http://llm", model="m", headers={}, history=[]
        )

    def get_session(self, session_id):
        if session_id != SID:
            raise KeyError(session_id)
        return self.session


_MANAGER = _Manager()


@pytest.fixture
def env(monkeypatch, tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine)
    monkeypatch.setattr(history_routes, "SessionLocal", local)
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr(session_fork, "SessionLocal", local)
    monkeypatch.setattr(session_fork, "GENERATED_IMAGE_DIR", tmp_path)

    db = local()
    db.add(DbSession(id=SID, name="Report", endpoint_url="http://llm", model="m", owner="alice"))
    texts = [("m1", "user", "Wie tief ist der See?"), ("m2", "assistant", "Etwa 40 Meter."),
             ("m3", "user", "Und wie kalt?"), ("m4", "assistant", "Rund 4 Grad am Grund.")]
    for msg_id, role, content in texts:
        db.add(ChatMessage(id=msg_id, session_id=SID, role=role, content=content, timestamp=AT))
    db.commit()
    db.close()
    _MANAGER.session.history = [
        MemoryMessage(role, content, {"_db_id": msg_id}) for msg_id, role, content in texts
    ]

    calls = []

    async def title(sess, question, answer, lang=None):
        calls.append((question, answer, lang))
        return "Tiefe des Sees"

    monkeypatch.setattr(chat_helpers, "generate_chapter_title", title)

    async def no_files(**kwargs):
        return True

    monkeypatch.setattr(history_routes, "fork_workspace", no_files)
    app = FastAPI()
    app.include_router(history_routes.setup_history_routes(_MANAGER))
    return TestClient(app), local, calls


def _meta(local, msg_id):
    row = local().query(ChatMessage).filter(ChatMessage.id == msg_id).one()
    return json.loads(row.meta_data or "{}")


def _roles_and_text(local, session_id):
    rows = (
        local()
        .query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp, ChatMessage.id)
        .all()
    )
    return [r.content for r in rows]


def test_chapter_gets_a_title_from_the_exchange_and_is_stored(env):
    http, local, calls = env
    res = http.post(f"/api/session/{SID}/chapter", json={"message_id": "m4", "lang": "de"})
    assert res.status_code == 200 and res.json()["title"] == "Tiefe des Sees"
    # The question it answers comes along, not just any user message.
    assert calls == [("Und wie kalt?", "Rund 4 Grad am Grund.", "de")]
    assert _meta(local, "m4")["chapter"] == {"title": "Tiefe des Sees"}
    assert _MANAGER.session.history[3].metadata["chapter"] == {"title": "Tiefe des Sees"}


def test_removing_a_chapter_leaves_the_rest_of_the_metadata(env):
    http, local, _ = env
    http.post(f"/api/session/{SID}/chapter", json={"message_id": "m2"})
    res = http.post(f"/api/session/{SID}/chapter", json={"message_id": "m2", "remove": True})
    assert res.status_code == 200 and res.json()["title"] is None
    assert "chapter" not in _meta(local, "m2")
    assert _MANAGER.session.history[1].metadata == {"_db_id": "m2"}


@pytest.mark.parametrize("body", [{"message_id": "nope"}, {"message_id": "nope", "remove": True}])
def test_chapter_on_an_unknown_message_is_404(env, body):
    http, _, calls = env
    assert http.post(f"/api/session/{SID}/chapter", json=body).status_code == 404
    assert calls == []


def test_chapter_needs_a_message_id(env):
    http, _, _ = env
    assert http.post(f"/api/session/{SID}/chapter", json={}).status_code == 400


def test_chapter_on_an_unknown_chat_is_404(env):
    http, _, _ = env
    assert http.post("/api/session/other/chapter", json={"message_id": "m2"}).status_code == 404


def test_fork_at_an_answer_ends_with_that_answer(env):
    http, local, _ = env
    body = http.post(f"/api/session/{SID}/fork", json={"message_id": "m2"}).json()
    assert body["kept"] == 2
    assert _roles_and_text(local, body["id"]) == ["Wie tief ist der See?", "Etwa 40 Meter."]


def test_fork_at_a_user_message_stops_ahead_of_it(env):
    http, local, _ = env
    body = http.post(
        f"/api/session/{SID}/fork", json={"message_id": "m3", "before_message": True}
    ).json()
    assert _roles_and_text(local, body["id"]) == ["Wie tief ist der See?", "Etwa 40 Meter."]


def test_fork_at_the_first_user_message_is_an_empty_chat(env):
    http, local, _ = env
    body = http.post(
        f"/api/session/{SID}/fork", json={"message_id": "m1", "before_message": True}
    ).json()
    assert body["kept"] == 0 and _roles_and_text(local, body["id"]) == []


def test_fork_at_an_unknown_message_is_404_and_leaves_nothing(env):
    http, local, _ = env
    assert http.post(f"/api/session/{SID}/fork", json={"message_id": "nope"}).status_code == 404
    assert local().query(DbSession).count() == 1


def test_fork_keeps_a_chapter_it_reaches_and_not_one_past_it(env):
    http, local, _ = env
    http.post(f"/api/session/{SID}/chapter", json={"message_id": "m2"})
    http.post(f"/api/session/{SID}/chapter", json={"message_id": "m4"})
    new_id = http.post(f"/api/session/{SID}/fork", json={"message_id": "m2"}).json()["id"]
    rows = local().query(ChatMessage).filter(ChatMessage.session_id == new_id).all()
    chapters = [json.loads(r.meta_data)["chapter"] for r in rows if r.meta_data]
    assert chapters == [{"title": "Tiefe des Sees"}]


def test_fallback_title_is_the_first_words():
    assert chat_helpers._fallback_chapter_title("", "eins zwei drei vier fünf sechs sieben") == (
        "eins zwei drei vier fünf sechs"
    )
    assert chat_helpers._fallback_chapter_title("", "   ") == "Chat"


@pytest.mark.asyncio
async def test_title_falls_back_when_the_model_fails(monkeypatch):
    import src.endpoint_resolver as resolver
    import src.llm_core as llm_core

    monkeypatch.setattr(resolver, "resolve_endpoint", lambda *a, **k: ("http://u", "small", {}))
    monkeypatch.setattr(resolver, "resolve_utility_fallback_candidates", lambda **k: [])
    monkeypatch.setattr(chat_helpers, "_small_title_models", lambda *a: [])

    async def boom(*args, **kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(llm_core, "llm_call_async_with_fallback", boom)
    sess = SimpleNamespace(id="x", owner="a", endpoint_url="http://c", model="c", headers={})
    assert await chat_helpers.generate_chapter_title(sess, "Wie tief ist es", "40 m") == "Wie tief ist es"
