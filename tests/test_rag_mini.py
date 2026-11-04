"""Mini RAGs: one small knowledge base per SQL database (src/rag_mini.py).

What matters: every database has exactly one, it can't exist without one, it runs
on its own settings, and nothing but the SQL feature ever reads it.
"""

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import rag_api, rag_config, rag_mini, rag_registry


class FakeRag:
    healthy = True

    def __init__(self, documents=None, results=None):
        self.documents = documents if documents is not None else []
        self.results = results if results is not None else []
        self.search_calls = []
        self.deleted = []
        self.details = {}

    def list_documents(self, scope=None, exclude_scopes=None):
        docs = list(self.documents)
        if scope is not None:
            return [d for d in docs if d.get("scope") == scope]
        if exclude_scopes:
            return [d for d in docs if d.get("scope") not in exclude_scopes]
        return docs

    def search(self, query, **kwargs):
        self.search_calls.append(kwargs)
        return self.results

    def requeue_spec(self, doc_id, **kwargs):
        doc = next(d for d in self.documents if d.get("doc_id") == doc_id)
        return doc["source"], {
            "scope": "sql",
            "source": doc["source"],
            "filename": doc["filename"],
            "logical_path": doc["filename"],
        }

    def document_detail(self, doc_id=None, source=None):
        return self.details.get(source)

    def delete_document(self, source=None, doc_id=None):
        self.deleted.append(source)
        return {"removed": 1}


def hit(text, filename="schema.md", score=0.9):
    return {
        "document": text,
        "metadata": {"filename": filename},
        "similarity": 0.5,
        "rerank_score": score,
    }


@pytest.fixture(autouse=True)
def tmp_registry(tmp_path, monkeypatch):
    import src.rag_singleton as rag_singleton

    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("RAG_API_KEY", raising=False)
    monkeypatch.setattr(rag_config, "global_config", lambda: {})
    rag_registry.invalidate_counts()
    rag_singleton.reset()
    yield tmp_path
    rag_registry.invalidate_counts()
    rag_singleton.reset()


@pytest.fixture
def conns(monkeypatch):
    """The databases in Integrations, editable by the test."""
    rows = [{"id": "abc123", "name": "ERP", "enabled": True}]
    monkeypatch.setattr(rag_mini, "connections", lambda: rows)
    return rows


@pytest.fixture
def rags(monkeypatch):
    """One fake RAG per base, created on demand."""
    instances = {}

    def _get(base_id=None, **_):
        key = rag_registry.get_base(base_id)["id"]
        return instances.setdefault(key, FakeRag())

    monkeypatch.setattr("src.rag_singleton.get_rag_manager", _get)
    monkeypatch.setattr("src.mcp_public._rag", _get)
    return instances


@pytest.fixture
def admin(rags):
    from core.middleware import require_admin
    from routes.rag_routes import setup_rag_routes

    app = FastAPI()
    app.include_router(setup_rag_routes())
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app)


def mini_of(connection_id="abc123"):
    return next(
        e
        for e in rag_registry.list_bases(include_mini=True)
        if e.get("connection_id") == connection_id
    )


# ---------------------------------------------------------------------------
# The binding
# ---------------------------------------------------------------------------


def test_every_database_gets_exactly_one_with_its_own_collection(conns):
    conns.append({"id": "def456", "name": "CRM", "enabled": False})
    rag_mini.sync()
    rag_mini.sync()
    minis = [e for e in rag_registry.list_bases(include_mini=True) if rag_registry.is_mini(e)]
    assert sorted(e["connection_id"] for e in minis) == ["abc123", "def456"]
    assert {e["collection"] for e in minis} & {rag_registry.DEFAULT_COLLECTION} == set()
    assert len({e["collection"] for e in minis}) == 2


def test_a_mini_rag_follows_its_database_when_renamed(conns):
    rag_mini.sync()
    before = mini_of()
    conns[0]["name"] = "ERP Produktion"
    rag_mini.sync()
    after = mini_of()
    assert after["name"] == "ERP Produktion"
    assert after["id"] == before["id"] and after["collection"] == before["collection"]


def test_an_id_taken_by_a_knowledge_base_does_not_hijack_it(conns):
    rag_registry.create_base("Mine", rag_id="db-abc123")
    rag_mini.sync()
    assert mini_of()["id"] == "db-abc123-2"
    assert not rag_registry.is_mini(rag_registry.get_base("db-abc123"))


def test_removing_a_database_keeps_the_files_but_orphans_the_mini_rag(conns):
    rag_mini.sync()
    rag_id = mini_of()["id"]
    assert not rag_mini.is_orphaned(rag_id)
    conns.clear()
    rag_mini.sync()
    assert rag_registry.get_base(rag_id)
    assert rag_mini.is_orphaned(rag_id)
    assert not rag_mini.is_orphaned(rag_registry.DEFAULT_ID)


def test_an_orphan_takes_no_new_documents(conns, rags, tmp_path, monkeypatch):
    import routes.personal_routes as personal
    from core.middleware import require_admin

    rag_mini.sync()
    rag_id = mini_of()["id"]
    conns.clear()
    monkeypatch.setattr(personal, "UPLOADS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(personal.setup_personal_routes(None, None, False))
    app.dependency_overrides[require_admin] = lambda: None
    res = TestClient(app).post(
        "/api/personal/upload",
        files=[("files", ("s.sql", b"x", "text/plain"))],
        data={"rag_id": rag_id},
    )
    assert res.status_code == 409


def test_it_can_only_be_deleted_once_its_database_is_gone(conns, admin):
    rag_mini.sync()
    rag_id = mini_of()["id"]
    assert (
        admin.delete(f"/api/rag/bases/{rag_id}", params={"drop_data": "false"}).status_code == 400
    )
    conns.clear()
    assert (
        admin.delete(f"/api/rag/bases/{rag_id}", params={"drop_data": "false"}).status_code == 200
    )


def test_the_connections_come_from_integrations(monkeypatch):
    settings = {
        "sql_databases": [
            {"id": "a1", "name": "ERP", "enabled": True},
            {"id": "b2", "name": "", "enabled": False},
        ]
    }
    monkeypatch.setattr("src.settings.get_setting", lambda k, d=None: settings.get(k, d))
    assert rag_mini.connections() == [
        {"id": "a1", "name": "ERP", "enabled": True},
        {"id": "b2", "name": "db2", "enabled": False},
    ]


def test_a_connection_from_the_environment_counts_too(monkeypatch):
    monkeypatch.setattr("src.settings.get_setting", lambda k, d=None: d)
    monkeypatch.setattr(
        "src.tool_implementations._build_env_sql_url", lambda: ("sqlite:///x.db", None)
    )
    assert rag_mini.connections() == [
        {"id": rag_mini.ENV_CONNECTION_ID, "name": "default", "enabled": True}
    ]


# ---------------------------------------------------------------------------
# Same as a knowledge base, only that nothing else reads it
# ---------------------------------------------------------------------------


def test_it_runs_on_its_own_settings_like_any_base(conns):
    rag_mini.sync()
    rag_id = mini_of()["id"]
    assert rag_config.effective_config(rag_id)["chat_top_k"] == 12
    rag_config.set_overrides(rag_id, {"chunk_max_chars": 900})
    assert rag_config.effective_config(rag_id)["chunk_max_chars"] == 900
    assert "chunk_max_chars" not in rag_config.effective_config(None)


def test_the_catalogue_of_the_workspace_shows_it_with_its_database(conns, admin):
    body = admin.get("/api/rag/bases").json()
    row = next(b for b in body["bases"] if b.get("kind") == "mini")
    assert row["connection"] == {"id": "abc123", "name": "ERP", "enabled": True}
    assert row["chat_enabled"] is False

    conns.clear()
    body = admin.get("/api/rag/bases").json()
    assert next(b for b in body["bases"] if b.get("kind") == "mini")["connection"] is None


def test_name_chat_and_access_are_not_editable(conns, admin):
    rag_mini.sync()
    rag_id = mini_of()["id"]
    res = admin.patch(
        f"/api/rag/bases/{rag_id}",
        json={"name": "Other", "description": "Tabellen", "chat_enabled": True},
    )
    assert res.status_code == 200
    entry = rag_registry.get_base(rag_id)
    assert entry["name"] == "ERP" and entry["description"] == "Tabellen"
    assert rag_registry.chat_enabled(entry) is False


def test_chat_never_walks_into_it(conns):
    rag_mini.sync()
    ids = [b["id"] for b in rag_registry.list_bases()]
    assert ids == [rag_registry.DEFAULT_ID]
    assert rag_registry.chat_enabled(mini_of()) is False


def test_the_outward_service_does_not_know_it(conns, rags):
    rag_mini.sync()
    rag_id = mini_of()["id"]
    client = TestClient(rag_api.create_app())
    assert rag_id not in [r["id"] for r in client.get("/v1/rags").json()["rags"]]
    assert client.get(f"/v1/rags/{rag_id}").status_code == 404
    assert client.get(f"/v1/rags/{rag_id}/documents").status_code == 404


def test_mcp_refuses_it_by_name(conns, rags):
    from src import mcp_public

    rag_mini.sync()
    with pytest.raises(mcp_public.ToolError):
        mcp_public._validate_collections([mini_of()["id"]])


def test_an_allowed_sql_scope_over_mcp_reaches_the_mini_rags(conns, rags):
    from src import mcp_public

    rag_mini.sync()
    rag_id = mini_of()["id"]
    rags[rag_id] = FakeRag(
        documents=[{"source": "s", "filename": "s.md", "chunks": 1}], results=[hit("orders table")]
    )
    text = mcp_public._tool_rag_query({"query": "orders", "scope": "sql"})
    assert "orders table" in text
    assert rags[rag_id].search_calls[0]["scope"] is None


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


def _filled(rags, connection_id="abc123", results=None):
    rag = FakeRag(documents=[{"source": "s", "filename": "s.md", "chunks": 1}], results=results)
    rags[mini_of(connection_id)["id"]] = rag
    return rag


def test_retrieval_uses_the_settings_of_the_mini_rag(conns, rags):
    rag_mini.sync()
    rag = _filled(rags, results=[hit("orders table")])
    rag_config.set_overrides(mini_of()["id"], {"chat_top_k": 3, "candidate_top_k": 25})
    assert rag_mini.retrieve_sections("umsatz") == ["[schema.md]\norders table"]
    assert rag.search_calls[0]["k"] == 3
    assert rag.search_calls[0]["candidate_k"] == 25


def test_a_new_mini_rag_keeps_a_question_that_shares_no_word_with_the_schema(conns, rags):
    """German question, English table names: a weak score isn't an irrelevant one."""
    rag_mini.sync()
    _filled(rags, results=[hit("orders table", score=0.02)])
    assert rag_mini.retrieve_sections("Umsätze pro Monat")


def test_its_rerank_floor_applies_once_someone_sets_one(conns, rags):
    rag_mini.sync()
    _filled(rags, results=[hit("strong", score=0.8), hit("weak", score=0.1)])
    rag_config.set_overrides(mini_of()["id"], {"rerank_min_score": 0.5})
    assert rag_mini.retrieve_sections("q") == ["[schema.md]\nstrong"]


def test_the_expanded_section_is_what_gets_injected(conns, rags):
    rag_mini.sync()
    _filled(rags, results=[{**hit("chunk"), "expanded": "the whole section"}])
    assert rag_mini.retrieve_sections("q") == ["[schema.md]\nthe whole section"]


def test_a_disabled_database_and_an_empty_mini_rag_are_not_searched(conns, rags):
    conns.append({"id": "off", "name": "Off", "enabled": False})
    conns.append({"id": "empty", "name": "Empty", "enabled": True})
    rag_mini.sync()
    live = _filled(rags, results=[hit("live")])
    off = _filled(rags, "off", results=[hit("off")])
    empty = FakeRag(results=[hit("empty")])
    rags[mini_of("empty")["id"]] = empty
    assert rag_mini.retrieve_sections("q") == ["[schema.md]\nlive"]
    assert live.search_calls and not off.search_calls and not empty.search_calls


def test_with_several_databases_each_passage_names_its_database(conns, rags):
    conns.append({"id": "def456", "name": "CRM", "enabled": True})
    rag_mini.sync()
    _filled(rags, results=[hit("orders")])
    _filled(rags, "def456", results=[hit("contacts", filename="crm.md")])
    assert sorted(rag_mini.retrieve_sections("q")) == [
        "[CRM: crm.md]\ncontacts",
        "[ERP: schema.md]\norders",
    ]


def test_the_budget_is_shared_and_cuts_between_passages(conns, rags):
    conns.append({"id": "def456", "name": "CRM", "enabled": True})
    rag_mini.sync()
    _filled(rags, results=[hit("a" * 700), hit("b" * 700)])
    _filled(rags, "def456", results=[hit("c" * 700)])
    rag_config.set_overrides(mini_of()["id"], {"max_context_chars": 2000})
    rag_config.set_overrides(mini_of("def456")["id"], {"max_context_chars": 2000})
    sections = rag_mini.retrieve_sections("q")
    assert len(sections) == 2
    assert not any("b" * 700 in s for s in sections)


def test_old_schema_files_keep_being_retrieved_until_they_moved(conns, rags):
    rag_mini.sync()
    legacy = FakeRag(
        documents=[{"source": "old", "filename": "old.md", "chunks": 1, "scope": "sql"}],
        results=[hit("old schema", filename="old.md", score=0.05)],
    )
    rags[rag_registry.DEFAULT_ID] = legacy
    assert rag_mini.retrieve_sections("q") == ["[old.md]\nold schema"]
    assert legacy.search_calls[0]["scope"] == "sql"
    assert legacy.search_calls[0]["k"] == 12


def test_nothing_configured_means_nothing_injected(conns, rags):
    conns.clear()
    assert rag_mini.retrieve_sections("q") == []


def test_the_agent_loop_joins_the_sections(conns, rags):
    from src.agent_loop import _SQL_KB_SEPARATOR, _retrieve_sql_knowledge

    rag_mini.sync()
    _filled(rags, results=[hit("a"), hit("b")])
    assert _retrieve_sql_knowledge("q") == _SQL_KB_SEPARATOR.join(
        ["[schema.md]\na", "[schema.md]\nb"]
    )
    assert _retrieve_sql_knowledge("") == ""


# ---------------------------------------------------------------------------
# Moving the old schema files out of the default base
# ---------------------------------------------------------------------------


def test_the_move_copies_what_it_can_and_names_what_it_cannot(tmp_path):
    old = tmp_path / "old"
    old.mkdir()
    new = tmp_path / "new"
    new.mkdir()
    (old / "a.md").write_text("a", encoding="utf-8")
    (old / "b.md").write_text("b", encoding="utf-8")
    legacy = FakeRag(
        documents=[
            {"source": str(old / "a.md"), "filename": "a.md", "doc_id": "d1", "scope": "sql"},
            {"source": str(old / "b.md"), "filename": "b.md", "type": ".md", "scope": "sql"},
            {"source": str(old / "gone.md"), "filename": "gone.md", "scope": "sql"},
            {"source": str(old / "x.md"), "filename": "x.md", "container": "z.zip", "scope": "sql"},
            {"source": "corpus.md", "filename": "corpus.md"},
        ]
    )
    files, moves, skipped = rag_mini.plan_adoption(legacy, str(new))
    assert skipped == ["gone.md"]
    assert [os.path.basename(path) for path, _ in files] == ["a.md", "b.md"]
    assert all(os.path.isfile(path) for path, _ in files)
    for path, meta in files:
        assert "scope" not in meta
        assert meta["source"] == path and meta["directory"] == str(new)
        assert meta["_force"] is True
    assert files[0][1]["logical_path"] == "a.md"
    assert moves[0] == (str(old / "a.md"), str(new / "a.md"))
    # The original stays until the copy has been indexed.
    assert (old / "a.md").exists()


def test_only_what_arrived_is_dropped_from_the_default_base(tmp_path):
    arrived = tmp_path / "arrived.md"
    failed = tmp_path / "failed.md"
    arrived.write_text("a", encoding="utf-8")
    failed.write_text("b", encoding="utf-8")
    target = FakeRag()
    target.details = {"new-a": {"status": "indexed"}, "new-b": {"status": "failed"}}
    legacy = FakeRag()
    moved = rag_mini.finish_adoption(
        target, legacy, [(str(arrived), "new-a"), (str(failed), "new-b")]
    )
    assert moved == 1
    assert legacy.deleted == [str(arrived)]
    assert not arrived.exists() and failed.exists()


def test_the_default_base_reports_old_files_until_they_moved(conns, rags):
    rags[rag_registry.DEFAULT_ID] = FakeRag(
        documents=[
            {"source": "a", "filename": "a", "chunks": 1},
            {"source": "s", "filename": "s", "chunks": 5, "scope": "sql"},
        ]
    )
    row = rag_registry.describe(rag_registry.get_base(None))
    assert row["legacy_sql_count"] == 1
    assert row["content_count"] == 1 and row["chunk_count"] == 1


def test_the_move_goes_through_the_worker(conns, admin, rags, tmp_path, monkeypatch):
    import routes.personal_routes as personal
    import src.rag_worker as worker

    monkeypatch.setattr(personal, "UPLOADS_DIR", str(tmp_path / "uploads"))
    source = tmp_path / "schema.md"
    source.write_text("tables", encoding="utf-8")
    rags[rag_registry.DEFAULT_ID] = FakeRag(
        documents=[{"source": str(source), "filename": "schema.md", "scope": "sql"}]
    )
    rag_mini.sync()
    rag_id = mini_of()["id"]
    queued = []
    monkeypatch.setattr(
        worker,
        "start_adopt_legacy_sql",
        lambda files, moves, base_id: queued.append((files, moves, base_id)) or {"id": "j1"},
    )
    body = admin.post(f"/api/rag/bases/{rag_id}/adopt-legacy-sql").json()
    assert body["queued"] == 1 and body["job_id"] == "j1"
    assert queued[0][2] == rag_id
    target = queued[0][0][0][0]
    assert os.path.dirname(target) == os.path.join(str(tmp_path / "uploads"), f"kb-{rag_id}")

    assert admin.post("/api/rag/bases/default/adopt-legacy-sql").status_code == 400
    assert admin.post("/api/rag/bases/nope/adopt-legacy-sql").status_code == 404


# ---------------------------------------------------------------------------
# Rebuilding one base leaves the others' files alone
# ---------------------------------------------------------------------------


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    import routes.personal_routes as personal

    root = tmp_path / "uploads"
    for folder in ("global", "sql_knowledge", "kb-db-abc123", "kb-manuals"):
        (root / folder).mkdir(parents=True)
        (root / folder / "f.txt").write_text("x", encoding="utf-8")
    monkeypatch.setattr(personal, "UPLOADS_DIR", str(root))
    return root


def test_a_named_base_only_purges_its_own_uploads(uploads):
    from routes.personal_routes import purge_managed_uploads

    assert purge_managed_uploads("db-abc123")["removed"] == 1
    assert not (uploads / "kb-db-abc123" / "f.txt").exists()
    assert (uploads / "kb-manuals" / "f.txt").exists()
    assert (uploads / "global" / "f.txt").exists()


def test_the_default_base_leaves_the_named_bases_alone(uploads):
    from routes.personal_routes import purge_managed_uploads

    assert purge_managed_uploads(None)["removed"] == 2
    assert not (uploads / "global" / "f.txt").exists()
    assert not (uploads / "sql_knowledge" / "f.txt").exists()
    assert (uploads / "kb-db-abc123" / "f.txt").exists()
    assert (uploads / "kb-manuals" / "f.txt").exists()
