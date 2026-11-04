"""Forking a chat: a full, independent duplicate whose files exist once on disk."""

import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import src.session_fork as session_fork
from core.database import (
    ArtifactMeta,
    Base,
    ChatMessage,
    Document,
    DocumentVersion,
    GalleryImage,
)
from core.database import Session as DbSession

OWNER = "alice"
SOURCE = "source-session-id"
SAME_TIME = datetime(2026, 1, 1, 12, 0, 0)


@pytest.fixture
def env(monkeypatch, tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine)
    monkeypatch.setattr(session_fork, "SessionLocal", local)
    monkeypatch.setattr(session_fork, "GENERATED_IMAGE_DIR", tmp_path)

    (tmp_path / "aaaa1111.png").write_bytes(b"image-bytes")
    db = local()
    db.add(
        DbSession(
            id=SOURCE,
            name="Report",
            endpoint_url="http://llm",
            model="m",
            owner=OWNER,
            folder="Acme",
            section="Q1",
            is_important=True,
            unread=True,
            mode="agent",
            total_input_tokens=40,
            headers={"Authorization": "x"},
        )
    )
    db.add(Document(id="doc-1", session_id=SOURCE, title="Plan", current_content="v2", owner=OWNER))
    db.add(DocumentVersion(id="ver-1", document_id="doc-1", version_number=1, content="v1"))
    db.add(
        GalleryImage(
            id="img-live", filename="aaaa1111.png", prompt="p", session_id=SOURCE, owner=OWNER
        )
    )
    db.add(
        GalleryImage(
            id="img-gone",
            filename="bbbb2222.png",
            prompt="p",
            session_id=SOURCE,
            owner=OWNER,
            is_active=False,
        )
    )
    meta = {
        "_db_id": "m2",
        "tool_events": [
            {"image_id": "img-live", "image_url": "/api/generated-image/aaaa1111.png"},
            {"document_id": "doc-1", "url": f"/api/artifacts/{SOURCE}/download?path=a.txt"},
        ],
    }
    # Same timestamp on purpose: history order then depends on the ids alone.
    db.add(ChatMessage(id="z-first", session_id=SOURCE, role="user", content="hi", timestamp=SAME_TIME))
    db.add(
        ChatMessage(
            id="a-second",
            session_id=SOURCE,
            role="assistant",
            content=f"![x](/api/generated-image/aaaa1111.png) {SOURCE}",
            meta_data=json.dumps(meta),
            timestamp=SAME_TIME,
        )
    )
    db.add(ArtifactMeta(owner=OWNER, artifact_key=f"{SOURCE}/a.txt", title="T"))
    db.add(ArtifactMeta(owner=OWNER, artifact_key="document:doc-1"))
    db.add(ArtifactMeta(owner=OWNER, artifact_key="generated-image:img-live"))
    db.add(ArtifactMeta(owner=OWNER, artifact_key="other-chat/keep.txt"))
    db.commit()
    db.close()
    return local, tmp_path


def _history(db, session_id):
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp, ChatMessage.id)
        .all()
    )


def test_fork_copies_settings_but_starts_unpinned_and_read(env):
    local, _ = env
    forked = session_fork.fork_session_records(SOURCE)
    db = local()
    row = db.query(DbSession).filter(DbSession.id == forked["id"]).one()
    assert forked["id"] != SOURCE and forked["owner"] == OWNER
    assert row.forked_from == SOURCE
    assert (row.name, row.folder, row.section, row.mode) == ("Report", "Acme", "Q1", "agent")
    assert row.total_input_tokens == 40 and row.headers == {"Authorization": "x"}
    assert row.message_count == 2 and row.last_message_at is not None
    assert row.is_important is False and row.unread is False


def test_fork_keeps_message_order_and_rewrites_references(env):
    local, _ = env
    new_id = session_fork.fork_session_records(SOURCE)["id"]
    db = local()
    source_history = _history(db, SOURCE)
    history = _history(db, new_id)
    assert [m.role for m in history] == [m.role for m in source_history]
    assert all(m.timestamp == SAME_TIME for m in history)

    image = (
        db.query(GalleryImage)
        .filter(GalleryImage.session_id == new_id, GalleryImage.is_active == True)  # noqa: E712
        .one()
    )
    doc = db.query(Document).filter(Document.session_id == new_id).one()
    reply = next(m for m in history if m.role == "assistant")
    meta = json.loads(reply.meta_data)
    assert reply.content == f"![x](/api/generated-image/{image.filename}) {new_id}"
    assert meta["_db_id"] == reply.id
    assert meta["tool_events"][0] == {
        "image_id": image.id,
        "image_url": f"/api/generated-image/{image.filename}",
    }
    assert meta["tool_events"][1] == {
        "document_id": doc.id,
        "url": f"/api/artifacts/{new_id}/download?path=a.txt",
    }
    # The source chat is untouched.
    assert SOURCE in next(m for m in source_history if m.role == "assistant").content


def test_fork_copies_documents_with_their_versions(env):
    local, _ = env
    new_id = session_fork.fork_session_records(SOURCE)["id"]
    db = local()
    doc = db.query(Document).filter(Document.session_id == new_id).one()
    assert doc.id != "doc-1" and doc.current_content == "v2" and doc.owner == OWNER
    version = db.query(DocumentVersion).filter(DocumentVersion.document_id == doc.id).one()
    assert version.content == "v1" and version.id != "ver-1"


def test_generated_image_exists_once_on_disk_and_survives_either_delete(env):
    local, image_dir = env
    new_id = session_fork.fork_session_records(SOURCE)["id"]
    db = local()
    image = (
        db.query(GalleryImage)
        .filter(GalleryImage.session_id == new_id, GalleryImage.is_active == True)  # noqa: E712
        .one()
    )
    original = image_dir / "aaaa1111.png"
    copy = image_dir / image.filename
    assert copy.read_bytes() == b"image-bytes"
    assert original.stat().st_nlink == 2
    assert copy.stat().st_ino == original.stat().st_ino

    original.unlink()
    assert copy.read_bytes() == b"image-bytes"


def test_deleted_image_stays_hidden_in_the_fork(env):
    local, image_dir = env
    new_id = session_fork.fork_session_records(SOURCE)["id"]
    db = local()
    gone = (
        db.query(GalleryImage)
        .filter(GalleryImage.session_id == new_id, GalleryImage.is_active == False)  # noqa: E712
        .one()
    )
    assert gone.id != "img-gone"
    assert not (image_dir / gone.filename).exists()


def test_fork_carries_this_chats_artifact_state_only(env):
    local, _ = env
    new_id = session_fork.fork_session_records(SOURCE)["id"]
    db = local()
    doc = db.query(Document).filter(Document.session_id == new_id).one()
    image = (
        db.query(GalleryImage)
        .filter(GalleryImage.session_id == new_id, GalleryImage.is_active == True)  # noqa: E712
        .one()
    )
    keys = {m.artifact_key for m in db.query(ArtifactMeta).all()}
    assert {f"{new_id}/a.txt", f"document:{doc.id}", f"generated-image:{image.id}"} <= keys
    assert sum(k.endswith("keep.txt") for k in keys) == 1


def test_keep_count_copies_only_the_leading_messages(env):
    local, _ = env
    forked = session_fork.fork_session_records(SOURCE, keep_count=1)
    db = local()
    assert forked["message_count"] == 1
    assert [m.role for m in _history(db, forked["id"])] == [_history(db, SOURCE)[0].role]


def test_unknown_session_raises(env):
    with pytest.raises(KeyError):
        session_fork.fork_session_records("nope")


# ── The sandbox daemon's side: hard links, broken before anything overwrites ──

CP = shutil.which("cp")
needs_cp = pytest.mark.skipif(not CP, reason="needs coreutils cp")


@pytest.fixture
def daemon(monkeypatch, tmp_path):
    """sandboxd with its account handling removed: commands run as the current
    user instead of through gosu, on a plain directory tree."""
    monkeypatch.setenv("TALOS_SANDBOX_STATE", str(tmp_path / "state" / "state.json"))
    path = Path(__file__).resolve().parent.parent / "sandbox" / "sandboxd.py"
    spec = importlib.util.spec_from_file_location("sandboxd_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    def run_without_gosu(args):
        assert args[:2] == ["gosu", "acct"]
        subprocess.run(args[2:], check=True, capture_output=True, text=True)

    roots = {"source": tmp_path / "source", "fork": tmp_path / "fork"}
    for root in roots.values():
        root.mkdir()
    monkeypatch.setattr(module, "_run", run_without_gosu)
    monkeypatch.setattr(module, "workspace_path", lambda user, chat: roots[chat])
    monkeypatch.setattr(module, "_workspace", lambda user, chat: ("acct", roots[chat]))
    (roots["source"] / "output").mkdir()
    (roots["source"] / "output" / "report.txt").write_text("original")
    (roots["source"] / "data.csv").write_text("a,b")
    return module, roots


@needs_cp
def test_forked_workspace_is_hard_links_not_copies(daemon):
    module, roots = daemon
    result = module.fork_workspace_route("u", "source", module.ForkWorkspaceRequest(target_chat_id="fork"))
    assert result["forked"] is True
    original = roots["source"] / "output" / "report.txt"
    linked = roots["fork"] / "output" / "report.txt"
    assert linked.read_text() == "original"
    assert linked.stat().st_ino == original.stat().st_ino
    assert original.stat().st_nlink == 2


def test_chat_without_a_workspace_has_nothing_to_fork(daemon, tmp_path):
    module, roots = daemon
    shutil.rmtree(roots["source"])
    result = module.fork_workspace_route("u", "source", module.ForkWorkspaceRequest(target_chat_id="fork"))
    assert result["forked"] is False


@needs_cp
def test_unsharing_a_file_keeps_the_other_chats_copy(daemon):
    module, roots = daemon
    module.fork_workspace_route("u", "source", module.ForkWorkspaceRequest(target_chat_id="fork"))
    original = roots["source"] / "output" / "report.txt"
    linked = roots["fork"] / "output" / "report.txt"

    module._unshare_file("acct", linked)
    linked.write_text("changed in the fork")

    assert original.read_text() == "original"
    assert original.stat().st_nlink == 1
    assert sorted(p.name for p in linked.parent.iterdir()) == ["report.txt"]


@needs_cp
def test_code_naming_a_file_unshares_it_and_only_it(daemon):
    module, roots = daemon
    module.fork_workspace_route("u", "source", module.ForkWorkspaceRequest(target_chat_id="fork"))

    module._unshare_mentioned("acct", roots["fork"], "prs.save('output/report.txt')")

    assert (roots["source"] / "output" / "report.txt").stat().st_nlink == 1
    assert (roots["source"] / "data.csv").stat().st_nlink == 2


def test_unshare_leaves_an_unlinked_file_alone(daemon):
    module, roots = daemon
    # No command may run for a file that is not shared.
    module._run = lambda args: pytest.fail("nothing to unshare")
    module._unshare_file("acct", roots["source"] / "data.csv")
    module._unshare_file("acct", roots["source"] / "missing.csv")


# ── The HTTP routes ──


class _FakeSessionManager:
    """Only what the two routes under test touch."""

    def get_session(self, session_id):
        if session_id != SOURCE:
            raise KeyError(session_id)
        return SimpleNamespace(name="Report")


_MANAGER = _FakeSessionManager()


@pytest.fixture
def client(env, monkeypatch):
    import routes.history_routes as history_routes
    import routes.session_routes as session_routes

    local, _ = env
    monkeypatch.setattr(session_routes, "SessionLocal", local)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(history_routes.setup_history_routes(_MANAGER))
    app.include_router(session_routes.setup_session_routes(_MANAGER, {}))
    return TestClient(app), local, history_routes


def _workspace_fork_returning(result, calls=None):
    async def fork_workspace(*, owner, session_id, target_session_id):
        if calls is not None:
            calls.append((owner, session_id, target_session_id))
        return result

    return fork_workspace


def test_fork_route_needs_no_body_and_forks_the_workspace(client, monkeypatch):
    http, local, history_routes = client
    calls = []
    monkeypatch.setattr(history_routes, "fork_workspace", _workspace_fork_returning(True, calls))
    res = http.post(f"/api/session/{SOURCE}/fork")
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Report" and body["kept"] == 2 and body["files_forked"] is True
    assert calls == [(OWNER, SOURCE, body["id"])]
    assert local().query(DbSession).filter(DbSession.id == body["id"]).count() == 1


def test_fork_route_reports_a_workspace_it_could_not_carry_over(client, monkeypatch):
    http, _, history_routes = client
    monkeypatch.setattr(history_routes, "fork_workspace", _workspace_fork_returning(False))
    res = http.post(f"/api/session/{SOURCE}/fork")
    assert res.status_code == 200 and res.json()["files_forked"] is False


def test_fork_route_404s_on_an_unknown_chat(client):
    http, _, _ = client
    assert http.post("/api/session/nope/fork").status_code == 404


def test_patch_sets_and_clears_section_and_unread(client):
    http, local, _ = client

    def row():
        db = local()
        try:
            return db.query(DbSession).filter(DbSession.id == SOURCE).one()
        finally:
            db.close()

    assert http.patch(f"/api/session/{SOURCE}", data={"section": "Q2"}).json()["section"] == "Q2"
    assert row().section == "Q2" and row().folder == "Acme"

    assert http.patch(f"/api/session/{SOURCE}", data={"unread": "false"}).json()["unread"] is False
    assert row().unread is False and row().section == "Q2"
    assert http.patch(f"/api/session/{SOURCE}", data={"unread": "true"}).json()["unread"] is True
    assert row().unread is True

    res = http.patch(f"/api/session/{SOURCE}", data={"section": "", "clear_section": "true"})
    assert res.json()["section"] is None
    assert row().section is None and row().unread is True
