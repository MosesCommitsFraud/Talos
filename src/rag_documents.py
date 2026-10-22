"""Document register and parse cache for the RAG ingest pipeline.

Qdrant holds *chunks*; nothing used to know about *documents*. This module is
that missing layer:

* **Stable identity.** Every ingested file gets a ``doc_id`` derived from its
  *logical* path (the original upload name, or the absolute path of a file in
  an indexed directory) plus owner and scope — not from the stored file path,
  which carries a random suffix for uploads. Uploading "Richtlinie.pdf" again
  therefore addresses the same document instead of adding a second one.
* **Content hash + version.** The register keeps ``content_sha256``, size and a
  version counter per document, plus a version history. Same hash and same
  pipeline → the file is skipped as unchanged; new hash under the same logical
  path → a new version replaces the old one; same hash under another upload
  name → recorded as a duplicate instead of being indexed twice.
* **Tombstones.** Deleted documents keep their row (``status='deleted'``) so the
  UI and directory sync can tell "removed" from "never seen".
* **Parse cache.** Expensive extraction results (Docling, VLM page
  transcription, ASR) are stored by content hash + lane fingerprint, so a
  re-index after a chunking or embedding change never re-pays OCR/VLM/ASR.

Storage is SQLite + files under the shared RAG data directory, next to the
generation manifests: the app and the ingest worker run in different containers
but share that volume, and neither shares the app database.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import tempfile
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

logger = logging.getLogger(__name__)

REGISTER_FILE = "documents.sqlite3"
PARSE_CACHE_DIR = "parse_cache"

# Bump when extraction output changes shape for the same input and config
# (a lane fix that should invalidate cached parses).
LANE_CACHE_VERSION = 1
# Bump when chunking/enrichment/embedding-input semantics change so stored
# documents with an older fingerprint are re-derived instead of skipped.
DERIVE_VERSION = 1

# Statuses a register row can have.
INDEXED = "indexed"
FAILED = "failed"
DUPLICATE = "duplicate"
DELETED = "deleted"
# An archive whose files were unpacked into documents of their own.
CONTAINER = "container"
LIVE_STATUSES = (INDEXED, FAILED, DUPLICATE, CONTAINER)

# Origins: how a document entered the base.
ORIGIN_UPLOAD = "upload"
ORIGIN_DIRECTORY = "directory"
ORIGIN_TEXT = "text"
ORIGIN_LEGACY = "legacy"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    collection TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    logical_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    origin TEXT NOT NULL,
    owner TEXT,
    scope TEXT,
    source TEXT NOT NULL,
    content_sha256 TEXT,
    text_sha256 TEXT,
    size_bytes INTEGER,
    mtime REAL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    duplicate_of TEXT,
    pipeline_fingerprint TEXT,
    lane TEXT,
    parse_cached INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    warnings TEXT,
    ingest_meta TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    indexed_at REAL,
    deleted_at REAL,
    PRIMARY KEY (collection, doc_id)
);
CREATE INDEX IF NOT EXISTS documents_source ON documents (collection, source);
CREATE INDEX IF NOT EXISTS documents_sha ON documents (collection, content_sha256);
CREATE TABLE IF NOT EXISTS collection_meta (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (collection, key)
);
CREATE TABLE IF NOT EXISTS versions (
    collection TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content_sha256 TEXT,
    source TEXT NOT NULL,
    size_bytes INTEGER,
    status TEXT NOT NULL,
    file_retained INTEGER NOT NULL DEFAULT 1,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    PRIMARY KEY (collection, doc_id, version)
);
"""

_DOC_COLUMNS = (
    "collection",
    "doc_id",
    "logical_path",
    "display_name",
    "origin",
    "owner",
    "scope",
    "source",
    "content_sha256",
    "text_sha256",
    "size_bytes",
    "mtime",
    "version",
    "status",
    "duplicate_of",
    "pipeline_fingerprint",
    "lane",
    "parse_cached",
    "chunk_count",
    "error",
    "warnings",
    "ingest_meta",
    "created_at",
    "updated_at",
    "indexed_at",
    "deleted_at",
)


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


def file_sha256(path: str) -> str:
    """Streamed SHA-256 of a file (large media never loaded whole)."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def text_sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def normalize_logical_path(value: str) -> str:
    """Case-, slash- and Unicode-insensitive key for a logical path.

    Windows users and file shares do not distinguish ``Bericht.PDF`` from
    ``bericht.pdf``; composed and decomposed umlauts must not split one
    document into two either.
    """
    text = unicodedata.normalize("NFC", str(value or "")).strip().replace("\\", "/")
    while "//" in text:
        text = text.replace("//", "/")
    return text.lower()


def make_doc_id(logical_path: str, owner: Optional[str] = None, scope: Optional[str] = None) -> str:
    key = "\x00".join((scope or "", owner or "", normalize_logical_path(logical_path)))
    return "d_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def clean_relative_path(value: Optional[str]) -> str:
    """A browser-supplied relative path ("Projekte/Nord/x.pdf"), made safe:
    forward slashes, no empty/./.. segments, no drive or root prefix."""
    parts = []
    for part in str(value or "").replace("\\", "/").split("/"):
        part = part.strip()
        if not part or part in (".", "..") or part.endswith(":"):
            continue
        parts.append(part)
    return "/".join(parts[-20:])


def upload_identity(
    original_name: Optional[str], relative_path: Optional[str] = None
) -> Dict[str, str]:
    """Identity metadata for an uploaded file, from the name the user chose.

    The stored file gets a random suffix (collision-free storage), so the
    logical path — what makes a re-upload the *same* document — is the
    original base name, not the stored one. A file from an uploaded folder
    keeps its path inside that folder, so equal names in different folders
    stay different documents.
    """
    name = os.path.basename(str(original_name or "").replace("\\", "/")).strip() or "upload"
    rel = clean_relative_path(relative_path)
    if rel and "/" in rel:
        return {"logical_path": rel, "origin": ORIGIN_UPLOAD, "folder": rel.rsplit("/", 1)[0]}
    return {"logical_path": name, "origin": ORIGIN_UPLOAD}


def stamp_identity(meta: Dict[str, Any], path: str) -> Dict[str, Any]:
    """Fill ``logical_path``/``origin``/``doc_id`` on caller metadata (in place)."""
    if not meta.get("logical_path"):
        meta["logical_path"] = os.path.abspath(meta.get("source") or path)
    meta.setdefault("origin", ORIGIN_DIRECTORY)
    meta["doc_id"] = make_doc_id(meta["logical_path"], meta.get("owner"), meta.get("scope"))
    return meta


def fingerprint(values: Dict[str, Any]) -> str:
    blob = json.dumps(values, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def is_within(path: str, root: str) -> bool:
    try:
        p = os.path.abspath(path)
        r = os.path.abspath(root)
        return os.path.commonpath([p, r]) == r
    except Exception:
        return False


def managed_uploads_dir() -> str:
    from core.constants import BASE_DIR

    return os.path.join(BASE_DIR, "data", "personal_uploads")


def delete_managed_file(path: Optional[str]) -> bool:
    """Delete a stored upload, never a file in a user's indexed directory."""
    if not path or not is_within(path, managed_uploads_dir()):
        return False
    try:
        if os.path.isfile(path):
            os.remove(path)
            return True
    except OSError as e:
        logger.warning("could not delete stored upload %s: %s", path, e)
    return False


def keep_versions() -> int:
    """How many stored upload files (current included) a document retains."""
    try:
        return max(1, int(os.getenv("RAG_KEEP_VERSIONS", "3") or 3))
    except ValueError:
        return 3


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------


class DocumentRegister:
    """One SQLite file for every knowledge base, keyed by Qdrant collection."""

    def __init__(self, directory: str):
        self.path = Path(directory) / REGISTER_FILE
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(_SCHEMA)
            # Columns added after the first release of the register.
            have = {r["name"] for r in db.execute("PRAGMA table_info(documents)")}
            for column, kind in (("text_sha256", "TEXT"),):
                if column not in have:
                    db.execute(f"ALTER TABLE documents ADD COLUMN {column} {kind}")

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(str(self.path), timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        data = dict(row)
        try:
            data["warnings"] = json.loads(data.get("warnings") or "[]")
        except ValueError:
            data["warnings"] = []
        data["parse_cached"] = bool(data.get("parse_cached"))
        try:
            data["ingest_meta"] = json.loads(data.get("ingest_meta") or "{}")
        except ValueError:
            data["ingest_meta"] = {}
        return data

    # -- reads ---------------------------------------------------------------

    def get(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM documents WHERE collection=? AND doc_id=?", (collection, doc_id)
            ).fetchone()
        return self._row(row)

    def by_source(self, collection: str, source: str) -> Optional[Dict[str, Any]]:
        """The live document a stored file belongs to (current or retained version)."""
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM documents WHERE collection=? AND source=? "
                "ORDER BY status='deleted', updated_at DESC LIMIT 1",
                (collection, source),
            ).fetchone()
        return self._row(row)

    def find_by_sha(
        self,
        collection: str,
        sha: str,
        *,
        scope: Optional[str] = None,
        exclude_doc_id: Any = None,
        column: str = "content_sha256",
    ) -> Optional[Dict[str, Any]]:
        """An *indexed* document with this exact content in the same scope.

        ``column`` is ``content_sha256`` (same bytes) or ``text_sha256`` (same
        extracted text). ``exclude_doc_id`` is one id or a collection of ids
        to ignore.
        """
        if column not in ("content_sha256", "text_sha256"):
            raise ValueError(column)
        excluded = (
            {exclude_doc_id}
            if isinstance(exclude_doc_id, str) or exclude_doc_id is None
            else set(exclude_doc_id)
        )
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM documents WHERE collection=? AND {column}=? AND status=? "
                "ORDER BY created_at",
                (collection, sha, INDEXED),
            ).fetchall()
        for row in rows:
            data = self._row(row)
            if data["doc_id"] in excluded or (data.get("scope") or None) != (scope or None):
                continue
            return data
        return None

    def list(self, collection: str, include_deleted: bool = False) -> List[Dict[str, Any]]:
        query = "SELECT * FROM documents WHERE collection=?"
        if not include_deleted:
            query += " AND status != 'deleted'"
        with self._connect() as db:
            rows = db.execute(query + " ORDER BY display_name COLLATE NOCASE", (collection,))
            return [self._row(r) for r in rows.fetchall()]

    def duplicates_of(self, collection: str, doc_id: str) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM documents WHERE collection=? AND duplicate_of=? AND status=?",
                (collection, doc_id, DUPLICATE),
            ).fetchall()
        return [self._row(r) for r in rows]

    def versions(self, collection: str, doc_id: str) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM versions WHERE collection=? AND doc_id=? ORDER BY version DESC",
                (collection, doc_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def retained_version(self, collection: str, source: str) -> Optional[Dict[str, Any]]:
        """A superseded (not current) version stored at ``source``, if any."""
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM versions WHERE collection=? AND source=? AND status='superseded' "
                "ORDER BY version DESC LIMIT 1",
                (collection, source),
            ).fetchone()
        return dict(row) if row else None

    def version(self, collection: str, doc_id: str, version: int) -> Optional[Dict[str, Any]]:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM versions WHERE collection=? AND doc_id=? AND version=?",
                (collection, doc_id, version),
            ).fetchone()
        return dict(row) if row else None

    def sha_referenced(self, sha: str) -> bool:
        """Whether any live document or retained version still uses this content."""
        if not sha:
            return False
        with self._connect() as db:
            live = db.execute(
                "SELECT 1 FROM documents WHERE content_sha256=? AND status != 'deleted' LIMIT 1",
                (sha,),
            ).fetchone()
            kept = db.execute(
                "SELECT 1 FROM versions v JOIN documents d "
                "ON d.collection=v.collection AND d.doc_id=v.doc_id "
                "WHERE v.content_sha256=? AND v.file_retained=1 AND d.status != 'deleted' "
                "LIMIT 1",
                (sha,),
            ).fetchone()
        return bool(live or kept)

    # -- writes --------------------------------------------------------------

    def upsert(self, collection: str, doc_id: str, **fields: Any) -> Dict[str, Any]:
        now = time.time()
        if "warnings" in fields and not isinstance(fields["warnings"], str):
            fields["warnings"] = json.dumps(list(fields["warnings"] or []))
        if "ingest_meta" in fields and not isinstance(fields["ingest_meta"], str):
            fields["ingest_meta"] = json.dumps(fields["ingest_meta"] or {}, default=str)
        if "parse_cached" in fields:
            fields["parse_cached"] = 1 if fields["parse_cached"] else 0
        unknown = set(fields) - set(_DOC_COLUMNS)
        if unknown:
            raise ValueError(f"Unknown register fields: {sorted(unknown)}")
        with self._connect() as db:
            exists = db.execute(
                "SELECT 1 FROM documents WHERE collection=? AND doc_id=?", (collection, doc_id)
            ).fetchone()
            if exists:
                fields["updated_at"] = now
                assignments = ", ".join(f"{k}=?" for k in fields)
                db.execute(
                    f"UPDATE documents SET {assignments} WHERE collection=? AND doc_id=?",
                    (*fields.values(), collection, doc_id),
                )
            else:
                row = {
                    "logical_path": fields.get("source") or doc_id,
                    "display_name": os.path.basename(str(fields.get("source") or doc_id)),
                    "origin": ORIGIN_LEGACY,
                    "source": "",
                    "version": 1,
                    "status": INDEXED,
                    "created_at": now,
                    **fields,
                    "collection": collection,
                    "doc_id": doc_id,
                    "updated_at": now,
                }
                columns = ", ".join(row)
                marks = ", ".join("?" for _ in row)
                db.execute(
                    f"INSERT INTO documents ({columns}) VALUES ({marks})", tuple(row.values())
                )
        return self.get(collection, doc_id)

    def record_version(
        self,
        collection: str,
        doc_id: str,
        version: int,
        *,
        sha: Optional[str],
        source: str,
        size_bytes: Optional[int],
        chunk_count: int,
    ) -> List[str]:
        """Store a version as current and supersede the others.

        Returns the stored upload files that fell out of the retention window
        and should be deleted by the caller (only managed uploads are listed).
        """
        now = time.time()
        with self._connect() as db:
            db.execute(
                "UPDATE versions SET status='superseded' WHERE collection=? AND doc_id=? "
                "AND version != ? AND status='current'",
                (collection, doc_id, version),
            )
            db.execute(
                "INSERT INTO versions (collection, doc_id, version, content_sha256, source, "
                "size_bytes, status, file_retained, chunk_count, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'current', 1, ?, ?) "
                "ON CONFLICT(collection, doc_id, version) DO UPDATE SET "
                "content_sha256=excluded.content_sha256, source=excluded.source, "
                "size_bytes=excluded.size_bytes, status='current', file_retained=1, "
                "chunk_count=excluded.chunk_count",
                (collection, doc_id, version, sha, source, size_bytes, chunk_count, now),
            )
            rows = db.execute(
                "SELECT version, source FROM versions WHERE collection=? AND doc_id=? "
                "AND file_retained=1 ORDER BY version DESC",
                (collection, doc_id),
            ).fetchall()
            expired: List[str] = []
            current_sources = {source}
            for row in rows[keep_versions() :]:
                db.execute(
                    "UPDATE versions SET file_retained=0 WHERE collection=? AND doc_id=? "
                    "AND version=?",
                    (collection, doc_id, row["version"]),
                )
                if row["source"] not in current_sources:
                    expired.append(row["source"])
        return [p for p in expired if is_within(p, managed_uploads_dir())]

    def mark_deleted(self, collection: str, doc_id: str) -> List[str]:
        """Tombstone a document; return its retained managed upload files."""
        now = time.time()
        with self._connect() as db:
            db.execute(
                "UPDATE documents SET status='deleted', deleted_at=?, updated_at=?, "
                "chunk_count=0 WHERE collection=? AND doc_id=?",
                (now, now, collection, doc_id),
            )
            rows = db.execute(
                "SELECT source FROM versions WHERE collection=? AND doc_id=? AND file_retained=1",
                (collection, doc_id),
            ).fetchall()
            db.execute(
                "UPDATE versions SET file_retained=0, status=CASE WHEN status='current' "
                "THEN 'deleted' ELSE status END WHERE collection=? AND doc_id=?",
                (collection, doc_id),
            )
        return [r["source"] for r in rows if is_within(r["source"], managed_uploads_dir())]

    def live_under(self, collection: str, directory: str, origin: str) -> List[Dict[str, Any]]:
        """Live rows of one origin whose stored file sits under ``directory``."""
        return [
            row
            for row in self.list(collection)
            if row["origin"] == origin and is_within(row["source"], directory)
        ]

    def get_meta(self, collection: str, key: str) -> Optional[str]:
        """A fact about a collection as a whole (e.g. its sparse-vector language)."""
        with self._connect() as db:
            row = db.execute(
                "SELECT value FROM collection_meta WHERE collection=? AND key=?",
                (collection, key),
            ).fetchone()
        return row["value"] if row else None

    def set_meta(self, collection: str, key: str, value: Optional[str]) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO collection_meta (collection, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(collection, key) DO UPDATE SET value=excluded.value",
                (collection, key, value),
            )

    def children(self, collection: str, doc_id: str) -> List[Dict[str, Any]]:
        """Live documents unpacked from a container (archive or e-mail)."""
        return [
            r
            for r in self.list(collection)
            if (r.get("ingest_meta") or {}).get("container_doc_id") == doc_id
        ]

    def drop_collection(self, collection: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM documents WHERE collection=?", (collection,))
            db.execute("DELETE FROM versions WHERE collection=?", (collection,))
            db.execute("DELETE FROM collection_meta WHERE collection=?", (collection,))


# ---------------------------------------------------------------------------
# Parse cache
# ---------------------------------------------------------------------------


class ParseCache:
    """Content-addressed store of lane output (pre-split Haystack Documents).

    Keyed by file SHA-256 and the lane fingerprint, so the same bytes parsed
    with the same extraction settings are never parsed twice — across
    re-indexes, versions that revert to old content, and knowledge bases.
    Cached output may reference figure/keyframe assets on disk; whoever
    purges those assets must clear the cache too.
    """

    def __init__(self, directory: str):
        self.root = Path(directory) / PARSE_CACHE_DIR

    def _dir(self, sha: str) -> Path:
        return self.root / sha[:2] / sha

    def _file(self, sha: str, lane_fp: str) -> Path:
        return self._dir(sha) / f"{lane_fp}.json.gz"

    def get(self, sha: str, lane_fp: str):
        if not sha or not lane_fp:
            return None
        path = self._file(sha, lane_fp)
        if not path.is_file():
            return None
        try:
            from haystack import Document

            with gzip.open(path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            return [Document.from_dict(item) for item in payload["documents"]]
        except Exception as e:
            logger.warning("parse cache entry %s unreadable, ignoring: %s", path, e)
            return None

    def put(self, sha: str, lane_fp: str, documents: Iterable[Any]) -> bool:
        if not sha or not lane_fp:
            return False
        items = []
        for document in documents:
            data = document.to_dict(flatten=False)
            data.pop("embedding", None)
            data.pop("sparse_embedding", None)
            items.append(data)
        path = self._file(sha, lane_fp)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".parse-", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb") as handle:
                    handle.write(json.dumps({"documents": items}, default=str).encode("utf-8"))
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return True
        except Exception as e:
            logger.warning("parse cache write failed for %s: %s", sha[:12], e)
            return False

    def drop(self, sha: str) -> None:
        if sha:
            shutil.rmtree(self._dir(sha), ignore_errors=True)

    def clear(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def stats(self) -> Dict[str, int]:
        files = 0
        size = 0
        if self.root.is_dir():
            for path in self.root.rglob("*.json.gz"):
                files += 1
                try:
                    size += path.stat().st_size
                except OSError:
                    pass
        return {"entries": files, "bytes": size}
