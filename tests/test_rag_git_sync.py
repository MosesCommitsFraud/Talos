"""Git sync: a real repository on disk, a real register, the real ingest path."""

import base64
import os
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src import rag_documents as rd
from src import rag_git_sync as gs
from src.rag_vector import VectorRAG


class Embedder:
    def run(self, documents):
        return {"documents": [replace(d, embedding=[1.0, 0.0, 0.0]) for d in documents]}


def git(cwd, *args):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.invalid",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.invalid",
    }
    subprocess.run(["git", *args], cwd=str(cwd), env=env, check=True, capture_output=True)


class Repo:
    """A repository the sync can fetch, with the same layout as the real one."""

    def __init__(self, path: Path, name: str = "ai-context"):
        self.path = path / name
        self.path.mkdir()
        git(self.path, "init", "--quiet", "--initial-branch", "master")
        self.url = self.path.as_uri()
        self.write("readme.md", "about this repository")
        self.write("Knowledge/readme.txt", "Nur MD-Dateien!")
        self.write("SQL/readme.txt", "Nur SQL-Skripte!")

    def write(self, rel, text):
        target = self.path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def remove(self, rel):
        (self.path / rel).unlink()

    def commit(self):
        git(self.path, "add", "-A")
        git(self.path, "commit", "--quiet", "--allow-empty", "-m", "change")


def make_rag(tmp_path, monkeypatch, collection):
    rag = object.__new__(VectorRAG)
    rag._cfg = {"embedding_tokenizer": "", "embedding_max_tokens": 0}
    rag.persist_directory = str(tmp_path / "rag")
    rag.collection_name = collection
    rag._store = InMemoryDocumentStore()
    rag._healthy = True
    monkeypatch.setattr(rag, "_dense_doc_embedder", lambda: Embedder())
    monkeypatch.setattr(rag, "_sparse_doc_embedder", lambda: Embedder())
    monkeypatch.setattr(rag, "_delete_visual", lambda source: None)
    return rag


@pytest.fixture
def env(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(rd, "managed_uploads_dir", lambda: str(uploads))
    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path / "rag"))
    # Tests fetch from disk; every other protocol stays as refused as in production.
    monkeypatch.setattr(gs, "GIT_PROTOCOLS", "file")
    monkeypatch.setattr(gs, "_token_for", lambda repo_id: "")
    for name in (
        "RAG_EMBEDDING_TOKENIZER",
        "CONTEXTUAL_RETRIEVAL_ENABLED",
        "IMAGE_PIXEL_ENABLED",
        "RAG_REDACT_PII",
        "RAG_AUTO_KEYWORDS_N",
        "RAG_AUTO_QUESTIONS_N",
    ):
        monkeypatch.delenv(name, raising=False)

    import src.rag_worker as worker

    def no_queue(*args, **kwargs):
        raise RuntimeError("no redis in tests")

    monkeypatch.setattr(worker, "start_index_files", no_queue)

    # Two bases, as registered: default plus a database's mini RAG.
    bases = {
        "default": make_rag(tmp_path, monkeypatch, "kb-default"),
        "db-main": make_rag(tmp_path, monkeypatch, "kb-db-main"),
    }
    monkeypatch.setattr(
        gs,
        "base_for_collection",
        lambda c: {"kb-default": None, "kb-db-main": "db-main"}.get(c),
    )
    return bases, tmp_path


def plan_for(repo, mappings=(("knowledge", "default"), ("sql", "db-main")), **extra):
    return {
        "repo_id": gs.repo_id_for(repo.url),
        "url": repo.url,
        "branch": "",
        "exclude": list(gs.DEFAULT_EXCLUDE),
        "mappings": [{"folder": f, "base": b} for f, b in mappings],
        "problems": [],
        "only_base": None,
        **extra,
    }


def names(rag):
    return sorted(d["filename"] for d in rag.list_documents())


def contents(rag):
    return sorted(d.content for d in rag._read_documents())


def upload(rag, tmp_path, name, text):
    path = tmp_path / "uploads" / f"stored-{name}"
    path.write_text(text, encoding="utf-8")
    meta = {"source": str(path), "filename": name, "type": ".md", **rd.upload_identity(name)}
    rag.index_files([(str(path), meta)])
    return path


# ---------------------------------------------------------------------------
# The folders land where the mapping says
# ---------------------------------------------------------------------------


def test_folders_land_in_their_bases_and_readmes_stay_out(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.write("SQL/schema.md", "Die Tabelle orders enthält alle Aufträge.")
    repo.write("SQL/views.sql", "CREATE VIEW v_orders AS SELECT id FROM orders;")
    repo.commit()

    result = gs.run(plan_for(repo), bases.__getitem__)

    assert result["success"] is True
    assert names(bases["default"]) == ["handbuch.md"]
    assert names(bases["db-main"]) == ["schema.md", "views.sql"]
    assert result["outcomes"]["indexed"] == 3
    assert len(result["commit"]) == 40


def test_documents_are_marked_with_their_repository(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    [row] = bases["default"]._register().list("kb-default")
    assert row["origin"] == rd.ORIGIN_GIT
    assert row["ingest_meta"][rd.GIT_REPO_META] == gs.repo_id_for(repo.url)
    assert row["logical_path"] == f"git/{gs.repo_id_for(repo.url)}/Knowledge/handbuch.md"


def test_a_second_run_changes_nothing(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)
    before = bases["default"]._store.filter_documents()

    result = gs.run(plan_for(repo), bases.__getitem__)

    assert result["outcomes"]["unchanged"] == 1
    assert result["outcomes"].get("indexed", 0) == 0
    assert len(bases["default"]._store.filter_documents()) == len(before)


def test_a_changed_file_gets_a_new_version_and_a_removed_one_leaves(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/bleibt.md", "Version eins des Handbuchs.")
    repo.write("Knowledge/geht.md", "Dieser Text verschwindet bald.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    repo.write("Knowledge/bleibt.md", "Version zwei des Handbuchs.")
    repo.remove("Knowledge/geht.md")
    repo.commit()
    result = gs.run(plan_for(repo), bases.__getitem__)

    assert result["outcomes"]["updated"] == 1
    assert result["outcomes"]["deleted"] == 1
    assert contents(bases["default"]) == ["Version zwei des Handbuchs."]
    assert names(bases["default"]) == ["bleibt.md"]


def test_a_renamed_file_is_not_indexed_next_to_itself(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/alt.md", "Der Inhalt bleibt beim Umbenennen gleich.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    repo.remove("Knowledge/alt.md")
    repo.write("Knowledge/neu.md", "Der Inhalt bleibt beim Umbenennen gleich.")
    repo.commit()
    result = gs.run(plan_for(repo), bases.__getitem__)

    assert names(bases["default"]) == ["neu.md"]
    assert contents(bases["default"]) == ["Der Inhalt bleibt beim Umbenennen gleich."]
    assert result["outcomes"]["replaced"] == 1


def test_pointing_a_folder_at_another_base_moves_its_documents(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("SQL/schema.md", "Die Tabelle orders enthält alle Aufträge.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)
    assert names(bases["db-main"]) == ["schema.md"]

    gs.run(plan_for(repo, mappings=[("sql", "default")]), bases.__getitem__)

    assert names(bases["default"]) == ["schema.md"]
    assert names(bases["db-main"]) == []


# ---------------------------------------------------------------------------
# Other documents are out of reach
# ---------------------------------------------------------------------------


def test_uploads_are_not_touched(env):
    bases, tmp = env
    stored = upload(bases["default"], tmp, "manuell.md", "Von Hand hochgeladenes Wissen.")
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    repo.remove("Knowledge/handbuch.md")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    assert names(bases["default"]) == ["manuell.md"]
    assert stored.is_file()


def test_another_repository_keeps_its_documents(env):
    bases, tmp = env
    first, second = Repo(tmp, "first"), Repo(tmp, "second")
    first.write("Knowledge/a.md", "Wissen aus dem ersten Repository.")
    first.commit()
    second.write("Knowledge/b.md", "Wissen aus dem zweiten Repository.")
    second.commit()
    gs.run(plan_for(first), bases.__getitem__)
    gs.run(plan_for(second), bases.__getitem__)
    assert names(bases["default"]) == ["a.md", "b.md"]

    first.remove("Knowledge/a.md")
    first.commit()
    gs.run(plan_for(first), bases.__getitem__)

    assert names(bases["default"]) == ["b.md"]


def test_equal_names_from_two_repositories_stay_two_documents(env):
    bases, tmp = env
    first, second = Repo(tmp, "first"), Repo(tmp, "second")
    first.write("Knowledge/same.md", "Text aus dem ersten Repository.")
    first.commit()
    second.write("Knowledge/same.md", "Text aus dem zweiten Repository.")
    second.commit()
    gs.run(plan_for(first), bases.__getitem__)
    gs.run(plan_for(second), bases.__getitem__)
    assert contents(bases["default"]) == [
        "Text aus dem ersten Repository.",
        "Text aus dem zweiten Repository.",
    ]


# ---------------------------------------------------------------------------
# No duplicates
# ---------------------------------------------------------------------------


def test_content_already_uploaded_is_not_indexed_twice(env):
    bases, tmp = env
    text = "Dieses Dokument wurde schon einmal hochgeladen."
    upload(bases["default"], tmp, "manuell.md", text)
    repo = Repo(tmp)
    repo.write("Knowledge/kopie.md", text)
    repo.commit()

    result = gs.run(plan_for(repo), bases.__getitem__)

    assert result["outcomes"]["duplicate"] == 1
    assert contents(bases["default"]) == [text]


def test_the_same_file_twice_in_a_repository_is_indexed_once(env):
    bases, tmp = env
    text = "Dieselbe Datei liegt in zwei Ordnern."
    repo = Repo(tmp)
    repo.write("Knowledge/a.md", text)
    repo.write("Knowledge/unter/a.md", text)
    repo.commit()

    gs.run(plan_for(repo), bases.__getitem__)

    assert contents(bases["default"]) == [text]


def test_deleting_the_upload_lets_the_git_copy_take_over(env):
    """How an instance hands manually uploaded files over to the repository."""
    bases, tmp = env
    text = "Dieses Dokument wurde schon einmal hochgeladen."
    upload(bases["default"], tmp, "manuell.md", text)
    repo = Repo(tmp)
    repo.write("Knowledge/kopie.md", text)
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    rag = bases["default"]
    upload_id = rd.make_doc_id("manuell.md")
    rag.delete_document(doc_id=upload_id)

    assert contents(rag) == [text]
    [row] = rag._register().list("kb-default")
    assert row["origin"] == rd.ORIGIN_GIT and row["status"] == rd.INDEXED


# ---------------------------------------------------------------------------
# Nothing is removed on an incomplete picture
# ---------------------------------------------------------------------------


def test_a_missing_folder_removes_nothing_and_says_so(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.write("SQL/schema.md", "Die Tabelle orders enthält alle Aufträge.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    git(repo.path, "mv", "SQL", "Datenbank")
    repo.write("Knowledge/neu.md", "Ein neues Kapitel im Handbuch.")
    repo.remove("Knowledge/handbuch.md")
    repo.commit()
    result = gs.run(plan_for(repo), bases.__getitem__)

    assert result["success"] is False
    assert "'sql' is not in the repository" in result["message"]
    assert names(bases["db-main"]) == ["schema.md"]
    # What could be added still was; what left waits for a complete run.
    assert names(bases["default"]) == ["handbuch.md", "neu.md"]


def test_a_problem_found_when_planning_removes_nothing(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    repo.remove("Knowledge/handbuch.md")
    repo.commit()
    plan = plan_for(repo, problems=["Folder 'sql': no SQL database is enabled"])
    result = gs.run(plan, bases.__getitem__)

    assert result["success"] is False
    assert names(bases["default"]) == ["handbuch.md"]


def test_a_failed_fetch_touches_nothing_and_is_recorded(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    plan = plan_for(repo)
    gs.run(plan, bases.__getitem__)

    plan = {**plan, "url": (tmp / "gone").as_uri()}
    with pytest.raises(gs.GitSyncError):
        gs.run(plan, bases.__getitem__)

    assert names(bases["default"]) == ["handbuch.md"]
    state = gs._read_state(plan["repo_id"])
    assert state["ok"] is False and "git fetch failed" in state["message"]


def test_one_base_collection_filter_leaves_the_others_alone(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.write("SQL/schema.md", "Die Tabelle orders enthält alle Aufträge.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)

    repo.remove("SQL/schema.md")
    repo.remove("Knowledge/handbuch.md")
    repo.commit()
    plan = plan_for(repo, mappings=[("knowledge", "default")], only_base="default")
    gs.run(plan, bases.__getitem__)

    assert names(bases["default"]) == []
    assert names(bases["db-main"]) == ["schema.md"]


# ---------------------------------------------------------------------------
# What gets read
# ---------------------------------------------------------------------------


def test_branch_is_honoured(env):
    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/master.md", "Stand auf dem Hauptbranch.")
    repo.commit()
    git(repo.path, "checkout", "--quiet", "-b", "release")
    repo.write("Knowledge/release.md", "Stand auf dem Release-Branch.")
    repo.commit()
    git(repo.path, "checkout", "--quiet", "master")

    gs.run(plan_for(repo, branch="release"), bases.__getitem__)

    assert names(bases["default"]) == ["master.md", "release.md"]


def test_folder_lookup_ignores_case_but_stays_inside_the_checkout(tmp_path):
    (tmp_path / "Knowledge" / "Sub").mkdir(parents=True)
    assert gs._find_folder(tmp_path, "knowledge/SUB") == tmp_path / "Knowledge" / "Sub"
    assert gs._find_folder(tmp_path, "") == tmp_path
    assert gs._find_folder(tmp_path, "missing") is None
    assert gs._find_folder(tmp_path, ".git") is None


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_a_symlink_never_reaches_a_file_outside_the_repository(env):
    bases, tmp = env
    secret = tmp / "secret.md"
    secret.write_text("Geheimnis außerhalb des Repositorys.", encoding="utf-8")
    repo = Repo(tmp)
    repo.write("Knowledge/echt.md", "Echtes Wissen aus dem Repository.")
    (repo.path / "Knowledge" / "link.md").symlink_to(secret)
    repo.commit()

    gs.run(plan_for(repo), bases.__getitem__)

    assert "Geheimnis außerhalb des Repositorys." not in contents(bases["default"])


def test_excluded_and_unsupported_files_are_skipped(tmp_path):
    (tmp_path / "docs").mkdir()
    for name in ("a.md", "README.MD", "readme.txt", "tool.exe", "paket.zip", "skript.sql"):
        (tmp_path / "docs" / name).write_text("x", encoding="utf-8")
    found = [
        rel for _, rel in gs._repo_files(tmp_path, tmp_path, gs.DEFAULT_EXCLUDE, gs._extensions())
    ]
    assert found == ["docs/a.md", "docs/skript.sql"]


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def test_exactly_one_repository_is_the_default():
    repos = gs.normalize_repos(
        [{"url": "https://git.example/a"}, {"url": "https://git.example/b", "default": True}]
    )
    assert [r["default"] for r in repos] == [False, True]
    repos = gs.normalize_repos([{"url": "https://git.example/a"}, {"url": "https://git.example/b"}])
    assert [r["default"] for r in repos] == [True, False]


@pytest.mark.parametrize(
    "url",
    [
        "",
        "file:///etc",
        "ssh://git@git.example/a",
        "ext::sh -c id",
        "--upload-pack=x",
        "https://",
        "https://user:secret@git.example/a",
        "https://git.example/a b",
    ],
)
def test_only_plain_https_urls_can_be_saved(url):
    with pytest.raises(ValueError):
        gs.normalize_repos([{"url": url}])


@pytest.mark.parametrize("branch", ["--upload-pack=x", "-x", "a..b", "a b"])
def test_a_branch_cannot_smuggle_an_option(branch):
    with pytest.raises(ValueError):
        gs.normalize_repos([{"url": "https://git.example/a", "branch": branch}])


def test_the_same_repository_cannot_be_listed_twice():
    with pytest.raises(ValueError, match="twice"):
        gs.normalize_repos([{"url": "https://git.example/a"}, {"url": "https://git.example/a.git"}])


def test_a_folder_needs_a_target_and_cannot_climb_out():
    with pytest.raises(ValueError, match="no target"):
        gs.normalize_repos(
            [{"url": "https://git.example/a", "mappings": [{"folder": "sql", "base": ""}]}]
        )
    [repo] = gs.normalize_repos(
        [{"url": "https://git.example/a", "mappings": [{"folder": "../../etc", "base": "x"}]}]
    )
    assert repo["mappings"] == [{"folder": "etc", "base": "x"}]


def test_repo_id_is_readable_and_stable():
    url = "https://devops.example/Csharp/_git/ai-context"
    assert gs.repo_id_for(url).startswith("ai-context-")
    assert gs.repo_id_for(url + "/") == gs.repo_id_for(url.upper() + ".git")
    assert gs.repo_id_for(url) != gs.repo_id_for(url + "2")


def test_token_stays_out_of_the_plan_and_the_saved_public_view(monkeypatch, tmp_path):
    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    repos = gs.normalize_repos(
        [
            {
                "url": "https://git.example/a",
                "token": "s3cret",
                "mappings": [{"folder": "sql", "base": "x"}],
            }
        ]
    )
    monkeypatch.setattr(gs, "configured_repos", lambda: repos)
    monkeypatch.setattr(gs, "_resolve_mappings", lambda repo: (repo["mappings"], []))
    import src.rag_worker as worker

    monkeypatch.setattr(worker, "list_jobs", lambda limit=20: [])

    assert "s3cret" not in repr(gs.plan_sync())
    assert "s3cret" not in repr(gs.status())


def test_token_is_never_on_the_command_line_and_is_scrubbed_from_errors(monkeypatch, tmp_path):
    calls = []

    class Done:
        returncode = 128
        stdout = ""
        stderr = "fatal: could not read from https://x with s3cret"

    def fake_run(args, **kwargs):
        calls.append((args, kwargs["env"]))
        return Done()

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(gs.GitSyncError) as caught:
        gs._git(["fetch", "https://x"], tmp_path, "s3cret")

    assert "s3cret" not in str(caught.value)
    args, env = calls[0]
    assert not any("s3cret" in a for a in args)
    header = next(
        env[k.replace("KEY", "VALUE")]
        for k, v in env.items()
        if k.startswith("GIT_CONFIG_KEY_") and v == "http.extraHeader"
    )
    encoded = header.rsplit(" ", 1)[-1]
    assert base64.b64decode(encoded).decode() == "git:s3cret"


def test_the_host_git_environment_is_not_inherited(monkeypatch):
    monkeypatch.setenv("GIT_SSH_COMMAND", "evil")
    env = gs._git_env("")
    assert "GIT_SSH_COMMAND" not in env
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GIT_ALLOW_PROTOCOL"] == gs.GIT_PROTOCOLS
    assert "http.extraHeader" not in env.values()


def test_no_repository_configured_is_a_readable_error(monkeypatch):
    monkeypatch.setattr(gs, "configured_repos", lambda: [])
    with pytest.raises(gs.GitSyncError, match="No Git repository"):
        gs.find_repo()


def test_a_repository_without_folders_refuses_to_run(monkeypatch):
    repos = gs.normalize_repos([{"url": "https://git.example/a"}])
    monkeypatch.setattr(gs, "configured_repos", lambda: repos)
    monkeypatch.setattr(gs, "_resolve_mappings", lambda repo: ([], []))
    with pytest.raises(gs.GitSyncError, match="No folder"):
        gs.plan_sync()


def test_a_token_is_scrubbed_for_everyone_but_admins():
    from src.settings_scrub import scrub_settings

    saved = {"rag_git_repos": [{"url": "https://git.example/a", "token": "s3cret"}]}
    assert scrub_settings(saved)["rag_git_repos"][0]["token"] == ""


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------


class FakeJob:
    id = "job-1"

    def __init__(self, meta):
        self.meta = meta
        self.enqueued_at = self.started_at = self.ended_at = self.exc_info = None

    def get_status(self, refresh=False):
        return "queued"


class FakeQueue:
    def __init__(self):
        self.jobs = []
        self.enqueued = []

    def enqueue(self, name, *args, **kwargs):
        self.enqueued.append((name, args))
        job = FakeJob(kwargs["meta"])
        self.jobs.append(job)
        return job


@pytest.fixture
def queue(monkeypatch, tmp_path):
    import src.rag_worker as worker

    fake = FakeQueue()
    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(worker, "_queue", lambda: fake)
    monkeypatch.setattr(worker, "_snapshot", lambda base_id=None: {"base": base_id})
    return fake


def queued_plan(**extra):
    return {
        "repo_id": "a-1",
        "url": "https://git.example/a",
        "branch": "",
        "exclude": [],
        "mappings": [],
        "problems": [],
        "only_base": None,
        **extra,
    }


def test_triggering_in_a_loop_adds_one_job(queue):
    import src.rag_worker as worker

    first = worker.start_git_sync(queued_plan())
    second = worker.start_git_sync(queued_plan())

    assert len(queue.enqueued) == 1
    assert "already_queued" not in first
    assert second["already_queued"] is True
    assert first["type"] == "git_sync" and first["repo_id"] == "a-1"


def test_another_target_gets_its_own_job(queue):
    import src.rag_worker as worker

    worker.start_git_sync(queued_plan())
    worker.start_git_sync(queued_plan(repo_id="b-2"))
    worker.start_git_sync(queued_plan(only_base="default"))

    assert len(queue.enqueued) == 3


def test_a_job_that_has_started_does_not_swallow_the_next_trigger(queue):
    """It may have fetched before the commit this call is about."""
    import src.rag_worker as worker

    worker.start_git_sync(queued_plan())
    queue.jobs.clear()  # the worker took it

    assert "already_queued" not in worker.start_git_sync(queued_plan())
    assert len(queue.enqueued) == 2


def test_the_job_gets_the_settings_of_every_base_and_no_token(queue, monkeypatch):
    import src.rag_worker as worker

    monkeypatch.setattr(gs, "_token_for", lambda repo_id: "s3cret")
    worker.start_git_sync(queued_plan())

    [(name, args)] = queue.enqueued
    assert name == "src.rag_worker.git_sync_job"
    assert "default" in args[1]
    assert "s3cret" not in repr(args)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def test_a_git_document_cannot_be_replaced_by_an_upload(env, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import src.rag_singleton as singleton
    from core.middleware import require_admin
    from routes.rag_routes import setup_rag_routes

    bases, tmp = env
    repo = Repo(tmp)
    repo.write("Knowledge/handbuch.md", "Reisekosten werden monatlich abgerechnet.")
    repo.commit()
    gs.run(plan_for(repo), bases.__getitem__)
    monkeypatch.setattr(singleton, "get_rag_manager", lambda rag_id=None, **kw: bases["default"])
    app = FastAPI()
    app.include_router(setup_rag_routes())
    app.dependency_overrides[require_admin] = lambda: None
    [row] = bases["default"]._register().list("kb-default")

    refused = TestClient(app).post(
        "/api/rag/documents/replace",
        data={"doc_id": row["doc_id"]},
        files={"file": ("y.md", b"new", "text/markdown")},
    )

    assert refused.status_code == 400
    assert "Git repository" in refused.json()["detail"]


def test_sync_routes_start_and_report(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from core.middleware import require_admin
    from routes.rag_routes import setup_rag_routes

    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    repos = gs.normalize_repos(
        [{"url": "https://git.example/a", "token": "s3cret", "mappings": []}]
    )
    monkeypatch.setattr(gs, "configured_repos", lambda: repos)
    import src.rag_worker as worker

    monkeypatch.setattr(
        worker,
        "list_jobs",
        lambda limit=20: [{"type": "git_sync", "status": "running", "repo_id": repos[0]["id"]}],
    )
    started = []

    def start(repo_id=None, only_base=None):
        if repo_id != repos[0]["id"]:
            raise gs.GitSyncError(f"Unknown repository {repo_id!r}.")
        started.append(repo_id)
        return {"id": "job-1", "status": "queued"}

    monkeypatch.setattr(gs, "start", start)
    app = FastAPI()
    app.include_router(setup_rag_routes())
    app.dependency_overrides[require_admin] = lambda: None
    client = TestClient(app)

    report = client.get("/api/rag/git-sync")
    assert report.status_code == 200
    assert "s3cret" not in report.text
    assert report.json()["repos"][0]["job"]["status"] == "running"

    assert client.post(f"/api/rag/git-sync/{repos[0]['id']}").json()["job_id"] == "job-1"
    assert started == [repos[0]["id"]]
    assert client.post("/api/rag/git-sync/nope").status_code == 400


def test_saving_settings_normalizes_repositories_and_refuses_bad_ones(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routes import auth_routes

    class Auth:
        def get_username_for_token(self, token):
            return "admin"

        def is_admin(self, user):
            return True

    saved = {}
    monkeypatch.setattr(auth_routes, "_load_settings", lambda: dict(saved))
    monkeypatch.setattr(auth_routes, "_save_settings", lambda s: saved.update(s))
    monkeypatch.setattr(auth_routes, "migrate_from_settings", lambda: None)
    app = FastAPI()
    app.include_router(auth_routes.setup_auth_routes(Auth()))
    client = TestClient(app)

    good = client.post(
        "/api/auth/settings",
        json={
            "rag_git_repos": [
                {
                    "url": "https://git.example/ai-context/",
                    "mappings": [{"folder": "sql", "base": "@default-db"}],
                }
            ]
        },
    )
    assert good.status_code == 200
    [repo] = saved["rag_git_repos"]
    assert repo["url"] == "https://git.example/ai-context"
    assert repo["id"].startswith("ai-context-") and repo["default"] is True

    bad = client.post("/api/auth/settings", json={"rag_git_repos": [{"url": "file:///etc"}]})
    assert bad.status_code == 400
    assert "file:///etc" in bad.json()["detail"]
    assert saved["rag_git_repos"] == [repo]
