"""Document register: stable identity, content hashes, versions, tombstones, parse cache."""

import os
from dataclasses import replace

import pytest
from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src import rag_documents as rd
from src.rag_vector import VectorRAG


class Embedder:
    def run(self, documents):
        return {"documents": [replace(d, embedding=[1.0, 0.0, 0.0]) for d in documents]}


@pytest.fixture
def env(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(rd, "managed_uploads_dir", lambda: str(uploads))
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

    rag = object.__new__(VectorRAG)
    rag._cfg = {"embedding_tokenizer": "", "embedding_max_tokens": 0}
    rag.persist_directory = str(tmp_path / "rag")
    rag.collection_name = "kb"
    rag._store = InMemoryDocumentStore()
    rag._healthy = True
    monkeypatch.setattr(rag, "_dense_doc_embedder", lambda: Embedder())
    monkeypatch.setattr(rag, "_sparse_doc_embedder", lambda: Embedder())
    monkeypatch.setattr(rag, "_delete_visual", lambda source: None)
    return rag, uploads, tmp_path


def upload(uploads, name, text, suffix):
    """What the upload route does: random stored name, identity from the user's name."""
    stem, ext = os.path.splitext(name)
    path = uploads / f"{stem}-{suffix}{ext}"
    path.write_text(text, encoding="utf-8")
    meta = {"source": str(path), "filename": name, "type": ext, **rd.upload_identity(name)}
    return str(path), meta


def contents(rag):
    return sorted(d.content for d in rag._read_documents())


def test_identical_reupload_is_unchanged_and_drops_the_redundant_copy(env):
    rag, uploads, _ = env
    first = rag.index_files([upload(uploads, "Richtlinie.md", "Reisekosten v1", "a")])
    assert first["outcomes"]["indexed"] == 1
    path, meta = upload(uploads, "richtlinie.md", "Reisekosten v1", "b")
    second = rag.index_files([(path, meta)])
    assert second["outcomes"]["unchanged"] == 1
    assert not os.path.exists(path)
    assert contents(rag) == ["Reisekosten v1"]
    [doc] = rag.list_documents()
    assert doc["registered"] and doc["version"] == 1
    assert doc["content_sha256"] == rd.text_sha256("Reisekosten v1")
    assert doc["doc_id"] == rd.make_doc_id("Richtlinie.md")


def test_new_content_under_same_name_replaces_previous_version(env):
    rag, uploads, _ = env
    old_path, meta = upload(uploads, "Richtlinie.md", "Reisekosten v1", "a")
    rag.index_files([(old_path, meta)])
    new_path, meta = upload(uploads, "Richtlinie.md", "Reisekosten v2", "b")
    result = rag.index_files([(new_path, meta)])
    assert result["outcomes"]["updated"] == 1
    assert contents(rag) == ["Reisekosten v2"]
    assert len(rag._store.filter_documents()) == 1
    detail = rag.document_detail(source=new_path)
    assert detail["version"] == 2
    assert [v["version"] for v in detail["versions"]] == [2, 1]
    assert detail["versions"][1]["status"] == "superseded"
    assert detail["versions"][1]["file_available"] is True
    # A directory reload of the upload folder must not index the old file again.
    reload = rag.index_personal_documents(str(uploads))
    assert reload["outcomes"]["skipped"] == 1
    assert reload["outcomes"]["unchanged"] == 1
    assert contents(rag) == ["Reisekosten v2"]


def test_old_version_files_beyond_retention_are_deleted(env, monkeypatch):
    rag, uploads, _ = env
    monkeypatch.setenv("RAG_KEEP_VERSIONS", "2")
    paths = []
    for n in range(3):
        path, meta = upload(uploads, "Plan.md", f"plan {n}", str(n))
        rag.index_files([(path, meta)])
        paths.append(path)
    assert not os.path.exists(paths[0])
    assert os.path.exists(paths[1]) and os.path.exists(paths[2])
    versions = rag.document_detail(source=paths[2])["versions"]
    assert [v["file_available"] for v in versions] == [True, True, False]


def test_failed_new_version_keeps_previous_version_searchable(env, monkeypatch):
    rag, uploads, _ = env
    rag.index_files([upload(uploads, "Notes.md", "good text", "a")])
    path, meta = upload(uploads, "Notes.md", "   ", "b")
    result = rag.index_files([(path, meta)])
    assert result["outcomes"]["failed"] == 1
    assert contents(rag) == ["good text"]
    [doc] = rag.list_documents()
    assert doc["status"] == "indexed" and doc["version"] == 1
    assert "Version 2 failed" in doc["error"]
    assert not os.path.exists(path)


def test_failed_first_ingest_is_listed_with_its_error(env):
    rag, uploads, _ = env
    path, meta = upload(uploads, "Empty.md", "", "a")
    rag.index_files([(path, meta)])
    [doc] = rag.list_documents()
    assert doc["status"] == "failed" and doc["chunks"] == 0
    assert "no extractable text" in doc["error"]


def test_same_bytes_under_another_name_is_a_duplicate_until_original_goes(env):
    rag, uploads, _ = env
    orig_path, meta = upload(uploads, "Vertrag.md", "Vertragstext", "a")
    rag.index_files([(orig_path, meta)])
    dup_path, meta = upload(uploads, "Vertrag Kopie.md", "Vertragstext", "b")
    result = rag.index_files([(dup_path, meta)])
    assert result["outcomes"]["duplicate"] == 1
    assert result["files"][0]["duplicate_of"] == "Vertrag.md"
    assert contents(rag) == ["Vertragstext"]
    rows = {d["filename"]: d for d in rag.list_documents()}
    assert rows["Vertrag Kopie.md"]["status"] == "duplicate"

    deleted = rag.delete_document(source=orig_path)
    assert deleted["promoted"] == ["Vertrag Kopie.md"]
    rows = {d["filename"]: d for d in rag.list_documents()}
    assert set(rows) == {"Vertrag Kopie.md"}
    assert rows["Vertrag Kopie.md"]["status"] == "indexed"
    assert contents(rag) == ["Vertragstext"]
    tomb = rd.DocumentRegister(rag.persist_directory).get("kb", rd.make_doc_id("Vertrag.md"))
    assert tomb["status"] == "deleted" and tomb["deleted_at"]


def test_directory_sync_skips_unchanged_and_tombstones_missing_files(env):
    rag, _, tmp_path = env
    share = tmp_path / "share"
    share.mkdir()
    (share / "a.md").write_text("alpha", encoding="utf-8")
    (share / "b.md").write_text("beta", encoding="utf-8")
    first = rag.index_personal_documents(str(share))
    assert first["outcomes"]["indexed"] == 2
    (share / "b.md").unlink()
    (share / "a.md").write_text("alpha two", encoding="utf-8")
    (share / "c.md").write_text("gamma", encoding="utf-8")
    second = rag.index_personal_documents(str(share))
    assert second["outcomes"] == {**second["outcomes"], "updated": 1, "indexed": 1, "deleted": 1}
    assert contents(rag) == ["alpha two", "gamma"]
    third = rag.index_personal_documents(str(share))
    assert third["outcomes"]["unchanged"] == 2
    assert third["indexed_count"] == 0


def test_pipeline_change_rederives_from_parse_cache(env, monkeypatch):
    rag, _, tmp_path = env
    calls = []

    def lane(path):
        calls.append(path)
        return [Document(content=open(path, encoding="utf-8").read())]

    monkeypatch.setattr(rag, "_route_lane", lambda path: "docling")
    monkeypatch.setattr(rag, "_lane_docling", lane)
    share = tmp_path / "docs"
    share.mkdir()
    (share / "r.docx").write_text("report body", encoding="utf-8")

    rag.index_personal_documents(str(share))
    assert len(calls) == 1
    rag._cfg = {**rag._cfg, "chunk_max_chars": 3000}
    result = rag.index_personal_documents(str(share))
    assert result["outcomes"]["reindexed"] == 1
    assert len(calls) == 1, "chunking change must not re-parse"
    [doc] = rag.list_documents()
    assert doc["parse_cached"] is True

    rag.index_files([(str(share / "r.docx"), {"_force": True, "_reparse": True})])
    assert len(calls) == 2


def test_parse_with_failed_extraction_calls_is_not_cached(env, monkeypatch):
    rag, _, tmp_path = env
    from src.rag_vector import _concurrent_map

    calls = []

    def lane(path):
        calls.append(path)

        def page(n):
            if n == 1:
                raise RuntimeError("VLM timeout")
            return f"page {n}"

        pages = _concurrent_map(page, [0, 1], 2)
        return [Document(content=p) for p in pages if p]

    monkeypatch.setattr(rag, "_route_lane", lambda path: "docling")
    monkeypatch.setattr(rag, "_lane_docling", lane)
    path = tmp_path / "scan.pdf"
    path.write_bytes(b"%PDF fake")
    rag.index_files([(str(path), {})])
    [doc] = rag.list_documents()
    assert doc["warnings"] and "VLM timeout" in doc["warnings"][0]
    rag.index_files([(str(path), {"_force": True})])
    assert len(calls) == 2


def test_sync_register_adopts_legacy_chunks_without_merging_same_names(env):
    rag, uploads, tmp_path = env
    older = uploads / "Protokoll-old.md"
    newer = uploads / "Protokoll-new.md"
    older.write_text("Sitzung Mai", encoding="utf-8")
    newer.write_text("Sitzung Juni", encoding="utf-8")
    os.utime(older, (1_000_000, 1_000_000))
    share = tmp_path / "share"
    share.mkdir()
    external = share / "handbuch.md"
    external.write_text("Handbuch", encoding="utf-8")
    rag._write_documents(
        [
            Document(
                content="Sitzung Mai", meta={"source": str(older), "filename": "Protokoll.md"}
            ),
            Document(
                content="Sitzung Juni", meta={"source": str(newer), "filename": "Protokoll.md"}
            ),
            Document(content="Handbuch", meta={"source": str(external), "filename": "handbuch.md"}),
        ],
        replace_sources=True,
    )
    assert not any(d["registered"] for d in rag.list_documents())

    result = rag.sync_register()
    assert result["registered"] == 3
    rows = {d["source"]: d for d in rag.list_documents()}
    assert all(r["registered"] for r in rows.values())
    assert rows[str(newer)]["doc_id"] == rd.make_doc_id("Protokoll.md")
    assert rows[str(older)]["doc_id"] != rows[str(newer)]["doc_id"]
    assert rows[str(external)]["content_sha256"] == rd.text_sha256("Handbuch")
    assert all(d.meta.get("doc_id") for d in rag._store.filter_documents())

    # The next upload of that name replaces only the newest legacy copy.
    path, meta = upload(uploads, "Protokoll.md", "Sitzung Juli", "c")
    assert rag.index_files([(path, meta)])["outcomes"]["updated"] == 1
    assert contents(rag) == ["Handbuch", "Sitzung Juli", "Sitzung Mai"]
    # And a directory sync of the share recognises the adopted file as unchanged.
    assert rag.index_personal_documents(str(share))["outcomes"]["unchanged"] == 1


def test_legacy_chunks_of_same_source_are_retired_on_first_registered_ingest(env):
    rag, _, tmp_path = env
    share = tmp_path / "share"
    share.mkdir()
    path = share / "a.md"
    path.write_text("fresh", encoding="utf-8")
    rag._write_documents(
        [Document(content="stale", meta={"source": str(path), "filename": "a.md"})],
        replace_sources=True,
    )
    rag.index_personal_documents(str(share))
    assert contents(rag) == ["fresh"]
    assert len(rag._store.filter_documents()) == 1


def test_doc_id_is_case_slash_and_unicode_insensitive():
    decomposed = "Prüfbericht.PDF"
    assert rd.make_doc_id(decomposed) == rd.make_doc_id("prüfbericht.pdf")
    assert rd.make_doc_id("a\\b.md") == rd.make_doc_id("A/B.md")
    assert rd.make_doc_id("x.md", scope="sql") != rd.make_doc_id("x.md")


def test_detail_reindex_and_restore_routes(env, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import src.rag_singleton as singleton
    import src.rag_worker as worker
    from core.middleware import require_admin
    from routes.rag_routes import setup_rag_routes

    rag, uploads, _ = env
    old_path, meta = upload(uploads, "Plan.md", "plan one", "a")
    rag.index_files([(old_path, meta)])
    new_path, meta = upload(uploads, "Plan.md", "plan two", "b")
    rag.index_files([(new_path, meta)])
    queued = []
    monkeypatch.setattr(singleton, "get_rag_manager", lambda rag_id=None, **kw: rag)
    monkeypatch.setattr(
        worker,
        "start_index_files",
        lambda files, owner=None, base_id=None: queued.append(files) or {"id": "j1"},
    )
    app = FastAPI()
    app.include_router(setup_rag_routes())
    app.dependency_overrides[require_admin] = lambda: None
    client = TestClient(app)

    doc_id = rd.make_doc_id("Plan.md")
    detail = client.get("/api/rag/documents/detail", params={"doc_id": doc_id}).json()
    assert detail["version"] == 2
    assert detail["content_sha256"] == rd.text_sha256("plan two")
    assert detail["source"] == new_path

    assert (
        client.post("/api/rag/documents/reindex", json={"doc_id": doc_id, "reparse": True}).json()[
            "job_id"
        ]
        == "j1"
    )
    path, spec = queued[-1][0]
    assert path == new_path and spec["_force"] and spec["_reparse"]

    client.post("/api/rag/documents/restore", json={"doc_id": doc_id, "version": 1})
    path, spec = queued[-1][0]
    assert path == old_path
    rag.index_files(queued[-1])
    assert contents(rag) == ["plan one"]
    assert rag.document_detail(doc_id=doc_id)["version"] == 3

    missing = client.get("/api/rag/documents/detail", params={"doc_id": "d_nope"})
    assert missing.status_code == 404
