"""A library skill's bundle has to reach the place where the agent runs code.

With the sandbox on, bash and python run in the talos-sandbox container, which
cannot see the app's disk. The bundle used to be written to the app's workspace
folder only, so scripts like the xlsx skill's recalc.py were never there for
the agent (model test 2026-11-12: `find / -name recalc.py` found nothing)."""

import asyncio
import base64
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import SharedSkill, SharedSkillFile
from services.memory import shared_skills
from src import sandbox_client
from src import tool_implementations as ti

SKILL_MD = "---\nname: tabellen\ndescription: Make spreadsheets\n---\n\nRun scripts/recalc.py.\n"
BUNDLE = {"scripts/recalc.py": b"print('recalc')\n", "templates/leer.xlsx": b"PK\x03\x04\x00\xff"}


@pytest.fixture
def library(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SharedSkill.__table__.create(engine)
    SharedSkillFile.__table__.create(engine)
    monkeypatch.setattr(shared_skills, "SessionLocal", sessionmaker(bind=engine))
    shared_skills.save_skill(SKILL_MD, uploader="anna", bundle_files=dict(BUNDLE))
    shared_skills.set_enabled("tabellen", True)
    return tmp_path


def _fake_sandbox(monkeypatch, *, fail=False):
    calls = []

    async def unpack(*, owner, session_id, dest, zip_bytes):
        calls.append({"owner": owner, "session_id": session_id, "dest": dest, "zip": zip_bytes})
        if fail:
            raise RuntimeError("404 Not Found")
        return {"exit_code": 0, "path": "/home/talos/u/workspaces/chat-1/skills"}

    monkeypatch.setenv("TALOS_SANDBOX_TOOLS", "true")
    monkeypatch.setattr(sandbox_client, "unpack_zip_in_sandbox", unpack)
    return calls


def test_read_skill_puts_the_bundle_into_the_sandbox_workspace(library, monkeypatch):
    calls = _fake_sandbox(monkeypatch)
    local = library / "app-workspace"

    out = asyncio.run(
        ti.do_read_skill("tabellen", owner="anna", workspace=str(local), session_id="chat-1")
    )

    assert len(calls) == 1
    call = calls[0]
    assert (call["owner"], call["session_id"], call["dest"]) == ("anna", "chat-1", "skills")
    with zipfile.ZipFile(io.BytesIO(call["zip"])) as zf:
        assert zf.read("tabellen/scripts/recalc.py") == BUNDLE["scripts/recalc.py"]
        assert zf.read("tabellen/templates/leer.xlsx") == BUNDLE["templates/leer.xlsx"]
    # The path the model is told is the sandbox one, not the app's disk.
    assert "/home/talos/u/workspaces/chat-1/skills/tabellen" in out["results"]
    assert not local.exists()


def test_browse_skills_puts_matched_bundles_into_the_sandbox(library, monkeypatch):
    calls = _fake_sandbox(monkeypatch)

    out = asyncio.run(
        ti.do_browse_skills(
            json.dumps({"query": "spreadsheets"}), owner="anna", session_id="chat-1"
        )
    )

    assert [c["dest"] for c in calls] == ["skills"]
    assert (
        "python /home/talos/u/workspaces/chat-1/skills/tabellen/scripts/recalc.py"
        in (out["results"])
    )


def test_a_failed_copy_still_returns_the_skill_and_says_so(library, monkeypatch):
    _fake_sandbox(monkeypatch, fail=True)

    out = asyncio.run(ti.do_read_skill("tabellen", owner="anna", session_id="chat-1"))

    assert "Run scripts/recalc.py." in out["results"]
    assert "could not be copied into the workspace" in out["results"]
    assert "is on disk at" not in out["results"]


def test_without_the_sandbox_the_bundle_goes_to_the_app_workspace(library, monkeypatch):
    monkeypatch.setenv("TALOS_SANDBOX_TOOLS", "false")
    local = library / "app-workspace"

    out = asyncio.run(
        ti.do_read_skill("tabellen", owner="anna", workspace=str(local), session_id="chat-1")
    )

    assert (local / "skills" / "tabellen" / "scripts" / "recalc.py").read_bytes() == (
        BUNDLE["scripts/recalc.py"]
    )
    assert str(local / "skills" / "tabellen") in out["results"]


@pytest.fixture
def sandboxd(monkeypatch, tmp_path):
    monkeypatch.setenv("TALOS_SANDBOX_STATE", str(tmp_path / "state" / "state.json"))
    path = Path(__file__).resolve().parent.parent / "sandbox" / "sandboxd.py"
    spec = importlib.util.spec_from_file_location("sandboxd_unpack_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setattr(module, "_workspace", lambda user, chat: ("acct", workspace))
    monkeypatch.setattr(module, "_unshare_file", lambda name, path: None)
    monkeypatch.setattr(module, "_chown_user_chain", lambda name, ws, path: None)
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **kw: None)
    return module, workspace


def _zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_the_daemon_unpacks_nested_binary_files(sandboxd):
    module, workspace = sandboxd
    req = module.FileUnpackRequest(
        path="skills",
        zip_b64=_zip({f"tabellen/{k}": v for k, v in BUNDLE.items()}),
    )

    result = module.unpack_route("anna", "chat-1", req)

    assert result["exit_code"] == 0
    target = workspace / "skills" / "tabellen"
    assert (target / "scripts" / "recalc.py").read_bytes() == BUNDLE["scripts/recalc.py"]
    assert (target / "templates" / "leer.xlsx").read_bytes() == BUNDLE["templates/leer.xlsx"]


def test_the_daemon_refuses_entries_that_leave_the_folder(sandboxd):
    module, workspace = sandboxd
    req = module.FileUnpackRequest(path="skills", zip_b64=_zip({"../../boese.txt": b"x"}))

    result = module.unpack_route("anna", "chat-1", req)

    assert result["exit_code"] == 1
    assert not (workspace.parent / "boese.txt").exists()


def test_the_daemon_refuses_something_that_is_not_a_zip(sandboxd):
    module, _workspace = sandboxd
    req = module.FileUnpackRequest(path="skills", zip_b64=base64.b64encode(b"nope").decode())

    assert module.unpack_route("anna", "chat-1", req)["exit_code"] == 1


@pytest.mark.skipif(sys.platform == "win32", reason="PtyRunner needs a POSIX pty")
def test_commands_keep_the_writable_home_through_gosu(sandboxd, monkeypatch, tmp_path):
    """gosu resets HOME to the root-owned account home; LibreOffice then could
    not create its profile. The command line has to set HOME again after gosu."""
    module, _workspace = sandboxd
    seen = {}

    class FakePopen:
        def __init__(self, args, **kw):
            seen["args"] = args
            self.pid = 0

    monkeypatch.setattr(module.subprocess, "Popen", FakePopen)
    home = str(tmp_path / "ws" / ".talos-home")
    module.PtyRunner(
        linux_user="acct", command="soffice --version", cwd=tmp_path, env={"HOME": home}
    )

    args = seen["args"]
    assert args[:2] == ["gosu", "acct"]
    assert args[2:4] == ["env", f"HOME={home}"]
