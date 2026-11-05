"""Projects (src/projects.py): who gets in, and what the chats in one share."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import Base, Document, Project, ProjectMember
from core.database import Session as DbSession
from routes import document_helpers, project_routes, session_routes
from src import projects, sandbox_client, user_memory


@pytest.fixture
def db(monkeypatch, tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine)
    monkeypatch.setattr(projects, "SessionLocal", local)
    monkeypatch.setattr(session_routes, "SessionLocal", local)
    monkeypatch.setattr(project_routes, "SessionLocal", local)
    monkeypatch.setattr(user_memory, "_PROJECT_DIR", str(tmp_path / "project"))
    monkeypatch.setattr(user_memory, "_DIR", str(tmp_path / "users"))
    return local


def _chat(local, chat_id, owner, project_id=None, name="Chat"):
    db = local()
    db.add(
        DbSession(
            id=chat_id, name=name, endpoint_url="", model="m", owner=owner, project_id=project_id
        )
    )
    db.commit()
    db.close()


class _Request:
    """What the access helpers read off a request."""

    def __init__(self, user):
        self.state = type("State", (), {"current_user": user})()


class _Auth:
    def list_users(self):
        return [
            {"username": u, "display_name": u.title()} for u in ("anna", "ben", "cara")
        ]


@pytest.fixture
def client(db):
    app = FastAPI()
    app.state.auth_manager = _Auth()
    user = {"name": "anna"}

    @app.middleware("http")
    async def as_user(request, call_next):
        request.state.current_user = user["name"]
        return await call_next(request)

    app.include_router(project_routes.setup_project_routes())
    test_client = TestClient(app)
    test_client.user = user
    return test_client


def test_project_workspace_is_shared_and_private_chats_stay_private(db):
    project = projects.create("anna", "Website")
    _chat(db, "in-project", "anna", project["id"])
    _chat(db, "own", "anna")

    assert projects.sandbox_location("anna", "in-project") == (
        f"project:{project['id']}",
        "workspace",
    )
    # Whoever's chat it is: the same place.
    assert projects.sandbox_location("ben", "in-project") == projects.sandbox_location(
        "anna", "in-project"
    )
    assert projects.sandbox_location("anna", "own") == ("anna", "own")
    assert projects.sandbox_location("anna", f"project:{project['id']}") == (
        f"project:{project['id']}",
        "workspace",
    )


def test_a_sandbox_account_of_a_project_cannot_be_a_username():
    # routes/auth_routes.py keeps usernames to these characters.
    import re

    assert not re.fullmatch(r"[a-z0-9._-]{1,64}", projects.workspace_ref("abc"))


async def test_deleting_a_project_chat_leaves_the_workspace(db, monkeypatch):
    project = projects.create("anna", "Website")
    _chat(db, "in-project", "anna", project["id"])

    def explode(*a, **k):
        raise AssertionError("deleted the shared workspace")

    monkeypatch.setattr(sandbox_client.httpx, "Client", explode)
    monkeypatch.setattr(sandbox_client.httpx, "AsyncClient", explode)
    assert sandbox_client.delete_workspace_sync("anna", "in-project") is False
    assert await sandbox_client.delete_workspace(owner="anna", session_id="in-project") is False
    # The fork shares that workspace and has nothing to carry over.
    assert await sandbox_client.fork_workspace(
        owner="anna", session_id="in-project", target_session_id="fork"
    )


async def test_memory_of_a_project_chat_is_the_projects_alone(db):
    project = projects.create("anna", "Website")
    _chat(db, "in-project", "anna", project["id"])
    _chat(db, "own", "anna")

    key = projects.memory_key("anna", "in-project")
    assert key == f"project:{project['id']}"
    assert projects.memory_key("anna", "own") == "anna"

    await user_memory.do_memory(
        json.dumps({"action": "add", "title": "Domain", "text": "Launch is in May"}), owner=key
    )
    assert "Launch is in May" in (
        await user_memory.do_memory(json.dumps({"action": "view"}), owner=key)
    )["output"]
    assert user_memory.listing("anna")["entries"] == []
    assert "Domain" in user_memory.turn_index(key)
    assert "shared" in user_memory.turn_index(key)
    # Even before the first note the model has to know whose memory this is.
    other = projects.create("anna", "Empty")
    assert "shared" in user_memory.turn_index(projects.workspace_ref(other["id"]))
    assert user_memory.turn_index("anna") == ""


def test_deleting_a_project_hands_chats_back(db):
    project = projects.create("anna", "Website")
    projects.add_member(project["id"], "ben")
    _chat(db, "c1", "ben", project["id"])
    user_memory.add(projects.workspace_ref(project["id"]), "T", "text")

    assert projects.delete(project["id"]) == ["c1"]

    session = db()
    assert session.query(DbSession).filter_by(id="c1").one().project_id is None
    assert session.query(Project).count() == 0
    assert session.query(ProjectMember).count() == 0
    session.close()
    assert user_memory.listing(projects.workspace_ref(project["id"]))["entries"] == []
    assert projects.sandbox_location("ben", "c1") == ("ben", "c1")


def test_a_deleted_creator_passes_the_project_on(db):
    shared = projects.create("anna", "Shared")
    projects.add_member(shared["id"], "ben")
    alone = projects.create("anna", "Alone")

    assert projects.forget_user("anna") == [alone["id"]]

    assert projects.is_creator(shared["id"], "ben")
    assert not projects.is_member(shared["id"], "anna")
    assert projects.get(alone["id"], "anna") is None


def test_a_renamed_member_stays_in(db):
    project = projects.create("anna", "Shared")
    projects.add_member(project["id"], "ben")
    projects.rename_user("ben", "benjamin")
    assert projects.is_member(project["id"], "benjamin")
    assert not projects.is_member(project["id"], "ben")


def test_moving_a_chat_in_leaves_its_files_to_copy(db):
    project = projects.create("anna", "Shared")
    _chat(db, "c1", "anna")
    projects.set_session_project("c1", project["id"])

    session = db()
    assert session.query(DbSession).filter_by(id="c1").one().workspace_merged is False
    session.close()

    projects.set_session_project("c1", None)
    session = db()
    assert session.query(DbSession).filter_by(id="c1").one().workspace_merged is True
    session.close()


def test_pending_workspaces_are_retried_until_the_sandbox_takes_them(db, monkeypatch):
    project = projects.create("anna", "Shared")
    _chat(db, "c1", "anna")
    projects.set_session_project("c1", project["id"])
    calls = []
    answer = {"ok": False}

    def copy(*, owner, session_id, project_id):
        calls.append((owner, session_id, project_id))
        return answer["ok"]

    monkeypatch.setattr(sandbox_client, "copy_workspace_into_project", copy)
    session_routes.merge_pending_workspaces()
    answer["ok"] = True
    session_routes.merge_pending_workspaces()
    session_routes.merge_pending_workspaces()

    assert calls == [("anna", "c1", project["id"])] * 2


def test_read_access_to_chats(db):
    project = projects.create("anna", "Shared")
    projects.add_member(project["id"], "ben")
    _chat(db, "annas", "anna", project["id"])
    _chat(db, "bens", "ben", project["id"])
    _chat(db, "private", "anna")

    assert session_routes._session_read_access(_Request("ben"), "annas") is True
    assert session_routes._session_read_access(_Request("anna"), "annas") is False

    # Writing stays with the chat's owner.
    with pytest.raises(HTTPException) as e:
        session_routes._verify_session_owner(_Request("ben"), "annas")
    assert e.value.status_code == 404
    # A member's other chats are none of the project's business.
    with pytest.raises(HTTPException):
        session_routes._session_read_access(_Request("ben"), "private")
    with pytest.raises(HTTPException):
        session_routes._session_read_access(_Request("cara"), "annas")


def test_someone_removed_loses_their_own_chats_in_the_project(db):
    project = projects.create("anna", "Shared")
    projects.add_member(project["id"], "ben")
    _chat(db, "bens", "ben", project["id"])
    session_routes._verify_session_owner(_Request("ben"), "bens")

    projects.remove_member(project["id"], "ben")

    with pytest.raises(HTTPException):
        session_routes._verify_session_owner(_Request("ben"), "bens")
    # The others still see it.
    assert session_routes._session_read_access(_Request("anna"), "bens") is True


def test_documents_of_a_project_are_open_to_its_members(db):
    project = projects.create("anna", "Shared")
    projects.add_member(project["id"], "ben")
    _chat(db, "annas", "anna", project["id"])
    _chat(db, "private", "anna")
    session = db()
    shared = Document(id="d1", session_id="annas", owner="anna", title="Spec")
    private = Document(id="d2", session_id="private", owner="anna", title="Mine")

    document_helpers._verify_doc_owner(session, shared, "ben")
    with pytest.raises(HTTPException):
        document_helpers._verify_doc_owner(session, private, "ben")
    with pytest.raises(HTTPException):
        document_helpers._verify_doc_owner(session, shared, "cara")
    session.close()


def test_the_page_lists_every_members_chats(client, db):
    project = client.post("/api/projects", json={"name": "Shared", "description": "Goal"}).json()
    assert project["is_creator"] is True
    client.post(f"/api/projects/{project['id']}/members", json={"username": "ben"})
    _chat(db, "annas", "anna", project["id"], name="By Anna")
    _chat(db, "bens", "ben", project["id"], name="By Ben")

    client.user["name"] = "ben"
    chats = client.get(f"/api/projects/{project['id']}/chats").json()["chats"]
    assert {(c["name"], c["owner"], c["owner_display_name"]) for c in chats} == {
        ("By Anna", "anna", "Anna"),
        ("By Ben", "ben", "Ben"),
    }
    listed = client.get("/api/projects").json()["projects"]
    assert [(p["name"], p["is_creator"], p["member_count"], p["chat_count"]) for p in listed] == [
        ("Shared", False, 2, 2)
    ]


def test_only_the_creator_manages_the_project(client):
    project = client.post("/api/projects", json={"name": "Shared"}).json()
    url = f"/api/projects/{project['id']}"
    assert [u["username"] for u in client.get(f"{url}/candidates").json()["users"]] == [
        "ben",
        "cara",
    ]
    assert client.post(f"{url}/members", json={"username": "nobody"}).status_code == 404
    assert client.post(f"{url}/members", json={"username": "ben"}).status_code == 200
    assert client.post(f"{url}/members", json={"username": "ben"}).status_code == 409

    client.user["name"] = "ben"
    assert client.get(url).status_code == 200
    assert client.patch(url, json={"name": "Mine"}).status_code == 403
    assert client.delete(url).status_code == 403
    assert client.get(f"{url}/candidates").status_code == 403
    assert client.post(f"{url}/members", json={"username": "cara"}).status_code == 403
    assert client.delete(f"{url}/members/anna").status_code == 403

    # Outsiders can't even tell it exists.
    client.user["name"] = "cara"
    for response in (
        client.get(url),
        client.get(f"{url}/chats"),
        client.get(f"{url}/memories"),
        client.get(f"{url}/files"),
        client.post(f"{url}/memories", json={"text": "x"}),
    ):
        assert response.status_code == 404

    # A member can leave, the creator can't.
    client.user["name"] = "ben"
    assert client.delete(f"{url}/members/ben").status_code == 200
    assert client.get(url).status_code == 404
    client.user["name"] = "anna"
    assert client.delete(f"{url}/members/anna").status_code == 400


def test_members_share_the_project_memory(client):
    project = client.post("/api/projects", json={"name": "Shared"}).json()
    url = f"/api/projects/{project['id']}"
    client.post(f"{url}/members", json={"username": "ben"})
    assert client.post(f"{url}/memories", json={"title": "T", "text": "Noted"}).status_code == 200

    client.user["name"] = "ben"
    entries = client.get(f"{url}/memories").json()["entries"]
    assert [e["text"] for e in entries] == ["Noted"]
    assert client.patch(f"{url}/memories/1", json={"text": "Changed"}).status_code == 200
    assert client.delete(f"{url}/memories/1").status_code == 200
    assert client.get(f"{url}/memories").json()["entries"] == []


def test_files_list_workspace_and_documents(client, db, monkeypatch):
    project = client.post("/api/projects", json={"name": "Shared"}).json()
    url = f"/api/projects/{project['id']}"
    _chat(db, "annas", "anna", project["id"])
    session = db()
    session.add(Document(id="d1", session_id="annas", owner="anna", title="Spec"))
    session.commit()
    session.close()

    async def workspace(*, owner, session_id):
        assert session_id == f"project:{project['id']}"
        return {
            "artifacts": [{"path": "out/a.txt", "name": "a.txt", "mtime": 1}],
            "dirs": ["out", "empty"],
        }

    monkeypatch.setattr(sandbox_client, "sandbox_enabled", lambda: True)
    monkeypatch.setattr(sandbox_client, "list_workspace", workspace)

    data = client.get(f"{url}/files").json()
    assert data["ref"] == f"project:{project['id']}"
    assert data["dirs"] == ["out", "empty"]
    by_source = {a["source"]: a for a in data["artifacts"]}
    assert by_source["workspace"]["session_id"] == data["ref"]
    assert by_source["document"]["session_id"] == "annas"


def test_an_upload_never_overwrites_someones_file():
    assert project_routes._unique_name("a.txt", {"b.txt"}) == "a.txt"
    assert project_routes._unique_name("a.txt", {"a.txt"}) == "a (2).txt"
    assert project_routes._unique_name("a.txt", {"a.txt", "a (2).txt"}) == "a (3).txt"


def test_folder_labels_become_projects_once(monkeypatch, tmp_path):
    import sqlite3

    from core import database

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, owner TEXT, folder TEXT)"
    )
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, owner TEXT, "
        "created_at TEXT, updated_at TEXT)"
    )
    conn.executemany(
        "INSERT INTO sessions VALUES (?, 'c', ?, ?)",
        [
            ("a1", "anna", "Web"),
            ("a2", "anna", "Web"),
            ("b1", "ben", "Web"),
            ("a3", "anna", None),
        ],
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(database, "DATABASE_URL", f"sqlite:///{path}")

    database._migrate_folders_to_projects()
    database._migrate_folders_to_projects()

    conn = sqlite3.connect(path)
    # One project per owner: the same label meant two things to two people.
    assert sorted(r[0] for r in conn.execute("SELECT owner FROM projects")) == ["anna", "ben"]
    rows = dict(conn.execute("SELECT id, project_id FROM sessions").fetchall())
    assert rows["a1"] == rows["a2"] != rows["b1"]
    assert rows["a3"] is None
    assert conn.execute("SELECT workspace_merged FROM sessions WHERE id = 'a1'").fetchone()[0] == 0
    assert conn.execute("SELECT workspace_merged FROM sessions WHERE id = 'a3'").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM sessions WHERE folder IS NOT NULL").fetchone()[0] == 0
    conn.close()


@pytest.mark.skipif(os.name == "nt" or not shutil.which("tar"), reason="needs GNU tar")
def test_copying_a_workspace_keeps_what_the_project_has(monkeypatch, tmp_path):
    monkeypatch.setenv("TALOS_SANDBOX_STATE", str(tmp_path / "state" / "state.json"))
    path = Path(__file__).resolve().parent.parent / "sandbox" / "sandboxd.py"
    spec = importlib.util.spec_from_file_location("sandboxd_copy_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    roots = {"chat": tmp_path / "chat", "workspace": tmp_path / "workspace"}
    for root in roots.values():
        root.mkdir()
    (roots["chat"] / "sub").mkdir()
    (roots["chat"] / "sub" / "new.txt").write_text("from the chat")
    (roots["chat"] / "both.txt").write_text("from the chat")
    (roots["chat"] / ".talos-home").mkdir()
    (roots["chat"] / ".talos-home" / "private").write_text("secret")
    (roots["workspace"] / "both.txt").write_text("from the project")

    real_popen, real_run = subprocess.Popen, subprocess.run

    class Without:
        PIPE, DEVNULL = subprocess.PIPE, subprocess.DEVNULL

        @staticmethod
        def Popen(args, **kw):
            assert args[:2] == ["gosu", "chat-acct"]
            return real_popen(args[2:], **kw)

        @staticmethod
        def run(args, **kw):
            assert args[:2] == ["gosu", "workspace-acct"]
            return real_run(args[2:], **kw)

    monkeypatch.setattr(module, "subprocess", Without)
    monkeypatch.setattr(module, "workspace_path", lambda user, chat: roots[chat])
    monkeypatch.setattr(module, "_workspace", lambda user, chat: (f"{chat}-acct", roots[chat]))

    result = module.copy_workspace_route(
        "anna",
        "chat",
        module.CopyWorkspaceRequest(target_user_id="project:x", target_chat_id="workspace"),
    )

    assert result["copied"] is True
    assert (roots["workspace"] / "sub" / "new.txt").read_text() == "from the chat"
    assert (roots["workspace"] / "both.txt").read_text() == "from the project"
    assert not (roots["workspace"] / ".talos-home").exists()
    assert (roots["chat"] / "both.txt").read_text() == "from the chat"
