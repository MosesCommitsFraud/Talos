"""Tests for the multi-knowledge-base registry and the outward REST service.

No Qdrant and no network: the registry writes to a tmp dir, and the RAG
instances are faked. What matters here is the contract the *calling software*
sees — the catalogue it reads to build its permissions, the isolation between
bases, and the fact that an unknown base is a 404 rather than a 503.
"""

import pytest
from fastapi.testclient import TestClient

from src import rag_api, rag_registry


# ---------------------------------------------------------------------------
# Fakes / fixtures
# ---------------------------------------------------------------------------


class FakeRag:
    healthy = True

    def __init__(self, collection="talos_rag", documents=None, results=None):
        self.collection_name = collection
        self._documents = documents if documents is not None else []
        self._results = results if results is not None else []
        self.search_calls = []

    def search(self, query, k=5, owner=None, candidate_k=None, scope=None, exclude_scopes=None):
        self.search_calls.append({"query": query, "k": k, "exclude_scopes": exclude_scopes})
        return self._results

    def list_documents(self, scope=None, exclude_scopes=None):
        return list(self._documents)

    def get_document_chunks(self, source):
        return [{"content": f"body of {source}"}] if source == "a.pdf" else []


@pytest.fixture(autouse=True)
def tmp_registry(tmp_path, monkeypatch):
    """Point the catalogue at a scratch dir so tests never touch data/rag."""
    import src.rag_singleton as rag_singleton

    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("RAG_API_KEY", raising=False)
    monkeypatch.delenv("RAG_API_INGEST_DIRS", raising=False)
    # Both caches are module-level and would otherwise leak between tests.
    rag_registry.invalidate_counts()
    rag_singleton.reset()
    yield tmp_path
    rag_registry.invalidate_counts()
    rag_singleton.reset()


@pytest.fixture
def bases(monkeypatch):
    """One fake RAG per base id, so isolation is observable."""
    instances = {}

    def _get(base_id=None):
        entry = rag_registry.get_base(base_id)  # raises RagNotFound for unknown ids
        return instances.setdefault(
            entry["id"],
            FakeRag(
                collection=entry["collection"],
                documents=[{"filename": f"{entry['id']}.pdf", "source": "a.pdf", "chunks": 3}],
                results=[
                    {
                        "document": f"passage from {entry['id']}",
                        "metadata": {"source": "a.pdf", "filename": "a.pdf"},
                        "similarity": 0.5,
                        "rerank_score": 0.9,
                    }
                ],
            ),
        )

    monkeypatch.setattr("src.rag_singleton.get_rag_manager", _get)
    monkeypatch.setattr("src.mcp_public._rag", lambda base_id=None: _get(base_id))
    return instances


@pytest.fixture
def client(bases):
    return TestClient(rag_api.create_app())


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_default_base_exists_without_any_file():
    """A fresh install answers as it always did — no migration step."""
    entry = rag_registry.get_base(None)
    assert entry["id"] == rag_registry.DEFAULT_ID
    assert entry["collection"] == "talos_rag"


def test_each_base_gets_its_own_collection():
    a = rag_registry.create_base("Service Manuals", language="de")
    b = rag_registry.create_base("HR Policies", language="en")
    assert a["collection"] != b["collection"]
    assert a["collection"].startswith(rag_registry.COLLECTION_PREFIX)
    assert rag_registry.collection_for(a["id"]) == a["collection"]


def test_ids_are_derived_from_the_name_and_unique():
    first = rag_registry.create_base("Service Manuals")
    assert first["id"] == "service-manuals"
    with pytest.raises(rag_registry.RagConflict):
        rag_registry.create_base("Service Manuals")


def test_unknown_base_raises_rather_than_falling_back_to_default():
    """Silently answering from the default base would leak the wrong corpus."""
    with pytest.raises(rag_registry.RagNotFound):
        rag_registry.get_base("nope")


def test_the_default_base_cannot_be_deleted():
    with pytest.raises(ValueError):
        rag_registry.delete_base(rag_registry.DEFAULT_ID)


def test_update_changes_description_but_not_identity():
    entry = rag_registry.create_base("Docs", description="old", language="de")
    updated = rag_registry.update_base(entry["id"], description="new", language="en")
    assert updated["description"] == "new"
    assert updated["language"] == "en"
    assert updated["collection"] == entry["collection"]


def test_registry_survives_a_corrupt_file(tmp_registry):
    """A broken catalogue must not take retrieval down with it."""
    path = rag_registry.registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    assert [b["id"] for b in rag_registry.list_bases()] == [rag_registry.DEFAULT_ID]


# ---------------------------------------------------------------------------
# Catalogue endpoint — what the calling software reads
# ---------------------------------------------------------------------------


def test_catalogue_reports_name_description_language_and_count(client):
    client.post(
        "/v1/rags",
        json={"name": "Service Manuals", "description": "Machine docs", "language": "de"},
    )
    rows = client.get("/v1/rags").json()["rags"]
    row = next(r for r in rows if r["id"] == "service-manuals")
    assert row["name"] == "Service Manuals"
    assert row["description"] == "Machine docs"
    assert row["language"] == "de"
    assert row["content_count"] == 1  # one fake document
    assert row["url"].endswith("/v1/rags/service-manuals")


def test_catalogue_can_skip_the_count_round_trip(client):
    rows = client.get("/v1/rags?counts=false").json()["rags"]
    assert "content_count" not in rows[0]


def test_creating_a_duplicate_is_a_conflict(client):
    payload = {"name": "Docs"}
    assert client.post("/v1/rags", json=payload).status_code == 201
    assert client.post("/v1/rags", json=payload).status_code == 409


def test_deleting_the_default_base_is_refused(client):
    assert client.delete("/v1/rags/default").status_code == 400


# ---------------------------------------------------------------------------
# Retrieval endpoints — the tool-calls over HTTP
# ---------------------------------------------------------------------------


def test_search_returns_both_rendered_text_and_structured_hits(client):
    body = client.post("/v1/rags/default/search", json={"query": "gearbox"}).json()
    assert body["count"] == 1
    assert body["results"][0]["source"] == "a.pdf"
    # The same block an MCP client would get, so a caller can hand it to a model.
    assert "passage from default" in body["text"]


def test_search_hits_only_the_named_base(client, bases):
    client.post("/v1/rags", json={"name": "HR"})
    client.post("/v1/rags/hr/search", json={"query": "holiday"})
    assert bases["hr"].search_calls
    assert "default" not in bases or not bases["default"].search_calls


def test_search_on_an_unknown_base_is_404_not_503(client):
    """A bad URL is a caller error; 503 would send them hunting for a dead Qdrant."""
    resp = client.post("/v1/rags/ghost/search", json={"query": "x"})
    assert resp.status_code == 404


def test_empty_query_is_rejected(client):
    assert client.post("/v1/rags/default/search", json={"query": "  "}).status_code == 400


def test_document_listing_and_reading(client):
    docs = client.get("/v1/rags/default/documents").json()
    assert docs["total"] == 1
    body = client.get("/v1/rags/default/document", params={"source": "a.pdf"}).json()
    assert "body of a.pdf" in body["text"]


def test_reading_an_unindexed_source_is_a_client_error(client):
    resp = client.get("/v1/rags/default/document", params={"source": "missing.pdf"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Optional service key
# ---------------------------------------------------------------------------


def test_no_key_configured_means_open(client):
    assert client.get("/v1/rags").status_code == 200


def test_key_is_enforced_once_configured(monkeypatch, bases):
    monkeypatch.setenv("RAG_API_KEY", "s3cret")
    c = TestClient(rag_api.create_app())
    assert c.get("/v1/rags").status_code == 401
    assert c.get("/v1/rags", headers={"X-API-Key": "s3cret"}).status_code == 200
    assert c.get("/v1/rags", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/v1/rags", headers={"X-API-Key": "wrong"}).status_code == 401


def test_health_stays_reachable_without_the_key(monkeypatch, bases):
    monkeypatch.setenv("RAG_API_KEY", "s3cret")
    c = TestClient(rag_api.create_app())
    assert c.get("/health").json()["ok"] is True


# ---------------------------------------------------------------------------
# Server-side directory ingest — an arbitrary-path read if left unguarded
# ---------------------------------------------------------------------------


def test_directory_ingest_is_off_unless_roots_are_configured(client, tmp_path):
    resp = client.post("/v1/rags/default/directory", data={"directory": str(tmp_path)})
    assert resp.status_code == 403


def test_directory_ingest_refuses_paths_outside_the_allowed_roots(
    client, tmp_path, monkeypatch
):
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    allowed.mkdir()
    outside.mkdir()
    monkeypatch.setenv("RAG_API_INGEST_DIRS", str(allowed))
    resp = client.post("/v1/rags/default/directory", data={"directory": str(outside)})
    assert resp.status_code == 403
