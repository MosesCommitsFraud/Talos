"""The Artifacts page library: listing across chats, pin, rename, delete."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import routes.document_routes as document_routes
from core.database import Base, ChatMessage, Document, GalleryImage
from core.database import Session as DbSession

USER = "alice"


@pytest.fixture
def env(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Local = sessionmaker(bind=engine)
    monkeypatch.setattr(document_routes, "SessionLocal", Local)
    monkeypatch.setattr(document_routes, "effective_user", lambda request: USER)
    monkeypatch.setattr(document_routes, "get_current_user", lambda request: USER)

    workspaces = {
        "s1": [
            {"path": "output/report.pptx", "name": "report.pptx", "size": 10, "mtime": 300.0,
             "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
            {"path": "upload.pdf", "name": "upload.pdf", "size": 5, "mtime": 100.0,
             "mime": "application/pdf"},
        ]
    }
    calls = {"moved": [], "deleted": [], "workspaces": workspaces}

    import src.sandbox_client as sc

    async def bulk(*, owner, session_ids):
        assert owner == USER
        return {k: [dict(f) for f in v] for k, v in workspaces.items() if k in session_ids}

    async def list_one(*, owner, session_id):
        return [dict(f) for f in workspaces.get(session_id, [])]

    async def move(*, owner, session_id, src, dst):
        calls["moved"].append((src, dst))
        for f in workspaces[session_id]:
            if f["path"] == src:
                f["path"] = dst
                f["name"] = dst.rsplit("/", 1)[-1]
        return True

    async def delete(*, owner, session_id, path):
        calls["deleted"].append(path)
        workspaces[session_id] = [f for f in workspaces[session_id] if f["path"] != path]
        return True

    monkeypatch.setattr(sc, "sandbox_enabled", lambda: True)
    monkeypatch.setattr(sc, "list_artifacts_bulk", bulk)
    monkeypatch.setattr(sc, "list_artifacts", list_one)
    monkeypatch.setattr(sc, "move_artifact", move)
    monkeypatch.setattr(sc, "delete_artifact", delete)

    db = Local()
    db.add(DbSession(id="s1", name="Quarterly", owner=USER, endpoint_url="x", model="m"))
    db.add(DbSession(id="s2", name="Other user", owner="bob", endpoint_url="x", model="m"))
    db.add(Document(id="d1", session_id="s1", title="Notes", language="markdown",
                    current_content="# Notes\nhello", owner=USER, is_active=True))
    db.add(GalleryImage(id="g1", filename="gen_abc.png", owner=USER, session_id="s1",
                        is_active=True))
    db.add(ChatMessage(id="m1", session_id="s1", role="user", content="see file",
                       meta_data=json.dumps({"attachments": [{"sandbox_path": "upload.pdf"}]})))
    db.commit()
    db.close()

    app = FastAPI()
    app.include_router(document_routes.setup_document_routes(session_manager=None))
    return TestClient(app), calls


def _library(client):
    res = client.get("/api/artifacts")
    assert res.status_code == 200
    return {a["path"]: a for a in res.json()["artifacts"]}


def test_lists_documents_images_and_created_workspace_files(env):
    client, _ = env
    rows = _library(client)
    assert set(rows) == {"document:d1", "generated-image:g1", "output/report.pptx"}
    assert rows["output/report.pptx"]["session_name"] == "Quarterly"
    assert rows["output/report.pptx"]["source"] == "workspace"
    assert rows["document:d1"]["snippet"].startswith("# Notes")
    assert not any(r["pinned"] for r in rows.values())


def test_pin_and_unpin(env):
    client, _ = env
    for path, sid in [("document:d1", None), ("output/report.pptx", "s1")]:
        res = client.patch("/api/artifacts", json={"path": path, "session_id": sid, "pinned": True})
        assert res.status_code == 200
    rows = _library(client)
    assert rows["document:d1"]["pinned"] and rows["output/report.pptx"]["pinned"]
    assert not rows["generated-image:g1"]["pinned"]

    client.patch("/api/artifacts", json={"path": "document:d1", "pinned": False})
    assert not _library(client)["document:d1"]["pinned"]


def test_rename_each_kind(env):
    client, calls = env
    assert client.patch("/api/artifacts", json={"path": "document:d1", "name": "Plan"}).status_code == 200
    assert client.patch("/api/artifacts", json={"path": "generated-image:g1", "name": "Logo"}).status_code == 200
    client.patch("/api/artifacts", json={"path": "output/report.pptx", "session_id": "s1", "pinned": True})
    res = client.patch(
        "/api/artifacts", json={"path": "output/report.pptx", "session_id": "s1", "name": "Q3 deck"}
    )
    assert res.json()["path"] == "output/Q3 deck.pptx"
    assert calls["moved"] == [("output/report.pptx", "output/Q3 deck.pptx")]

    rows = _library(client)
    assert rows["document:d1"]["name"] == "Plan.md"
    assert rows["generated-image:g1"]["name"] == "Logo.png"
    # The pin follows the file to its new path.
    assert rows["output/Q3 deck.pptx"]["pinned"]


def test_rename_keeps_folder_and_refuses_clashes(env):
    client, calls = env
    calls["workspaces"]["s1"].append(
        {"path": "output/final.pptx", "name": "final.pptx", "size": 1, "mtime": 1.0, "mime": "x"}
    )
    res = client.patch(
        "/api/artifacts", json={"path": "output/report.pptx", "session_id": "s1", "name": "final"}
    )
    assert res.status_code == 409
    # Slashes are flattened, so a name cannot move the file out of its folder.
    res = client.patch(
        "/api/artifacts", json={"path": "output/report.pptx", "session_id": "s1", "name": "../x"}
    )
    assert res.json()["path"] == "output/.._x.pptx"


def test_delete_each_kind(env):
    client, calls = env
    assert client.delete("/api/artifacts", params={"path": "document:d1"}).status_code == 200
    assert client.delete("/api/artifacts", params={"path": "generated-image:g1"}).status_code == 200
    res = client.delete("/api/artifacts", params={"path": "output/report.pptx", "session_id": "s1"})
    assert res.status_code == 200
    assert calls["deleted"] == ["output/report.pptx"]
    assert _library(client) == {}


def test_cannot_touch_another_users_chat(env):
    client, calls = env
    res = client.delete("/api/artifacts", params={"path": "x.txt", "session_id": "s2"})
    assert res.status_code in (403, 404)
    assert calls["deleted"] == []


def test_deleted_artifacts_leave_the_chat_too(env, monkeypatch):
    client, _ = env
    client.delete("/api/artifacts", params={"path": "document:d1"})
    client.delete("/api/artifacts", params={"path": "generated-image:g1"})

    # The chat's file cards come from the per-chat list.
    paths = {a["path"] for a in client.get("/api/artifacts/s1").json()["artifacts"]}
    assert "document:d1" not in paths and "generated-image:g1" not in paths

    # The image also leaves the chat history it was generated in.
    import routes.history_routes as history_routes

    monkeypatch.setattr(history_routes, "SessionLocal", document_routes.SessionLocal)
    history = [
        {"role": "assistant", "content": "here", "metadata": {"tool_events": [
            {"tool": "generate_image", "image_id": "g1", "image_url": "/api/generated-image/gen_abc.png"},
            {"tool": "bash", "output": "ok"},
        ]}},
        {"role": "user", "content": "hi"},
    ]
    cleaned = history_routes._without_deleted_images(history, "s1")
    first = cleaned[0]["metadata"]["tool_events"][0]
    assert "image_url" not in first and first["tool"] == "generate_image"
    assert cleaned[0]["metadata"]["tool_events"][1] == {"tool": "bash", "output": "ok"}
    # The stored history is not mutated.
    assert history[0]["metadata"]["tool_events"][0]["image_url"]
