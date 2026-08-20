"""rag_registry.py

The catalogue of RAG knowledge bases ("RAG DBs").

Talos used to have exactly one knowledge base — a single Qdrant collection
named ``talos_rag``. This module turns that into a registry of named bases,
each with its **own Qdrant collection**, so several can exist side by side and
be addressed individually from outside (see ``src/rag_api.py``).

Isolation is physical, not a metadata filter: one Qdrant collection per entry.
A filter bug can therefore never leak documents across bases, ``content_count``
is a cheap count on the collection, and deleting or rebuilding one base leaves
the others untouched.

Storage is a small JSON file next to the RAG data (``data/rag/registry.json``)
rather than the app DB: the ingest worker runs in a *separate* container that
does not share the app database, but does share the ``data/`` volume, so a file
is the one store both processes can read.

The ``default`` entry is seeded on first read and pinned to the historical
``talos_rag`` collection, so every existing document, route and chat call keeps
working with no migration.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# The base every pre-existing caller gets when it asks for no base in
# particular. Pinned to the historical collection name — do not change.
DEFAULT_ID = "default"
DEFAULT_COLLECTION = "talos_rag"

# Qdrant collection for a registered base. Namespaced so a Qdrant shared with
# other tools stays legible, and so ``talos_rag_visual`` (the pixel lane of the
# default base) can never be mistaken for a registered base's collection.
COLLECTION_PREFIX = "talos_kb_"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_lock = threading.RLock()


def registry_path() -> Path:
    """Where the catalogue lives. Follows the RAG data dir so app and worker
    (different containers, same volume) resolve the same file."""
    base = os.getenv("RAG_DATA_DIR", "").strip()
    if not base:
        base = str(Path(__file__).resolve().parent.parent / "data" / "rag")
    return Path(base) / "registry.json"


def slugify(value: str) -> str:
    """Derive a URL-safe id from a display name."""
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return slug[:63] or "kb"


def _default_entry() -> Dict[str, Any]:
    return {
        "id": DEFAULT_ID,
        "name": "Talos Knowledge Base",
        "description": (
            "The shared knowledge base Talos chat searches by default. "
            "Everything indexed before knowledge bases were split lives here."
        ),
        "language": "de",
        "collection": DEFAULT_COLLECTION,
        "created_at": 0.0,
        "updated_at": 0.0,
    }


def _read() -> Dict[str, Any]:
    path = registry_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        data = {}
    except Exception as e:
        # A corrupt catalogue must not take retrieval down: fall back to the
        # default base so chat keeps answering, and say so loudly.
        logger.error("RAG registry unreadable (%s) — falling back to default only", e)
        data = {}
    entries = data.get("bases") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        entries = []
    out: Dict[str, Any] = {}
    for e in entries:
        if isinstance(e, dict) and _ID_RE.match(str(e.get("id") or "")):
            out[str(e["id"])] = e
    out.setdefault(DEFAULT_ID, _default_entry())
    return out


def _write(entries: Dict[str, Any]) -> None:
    path = registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "bases": list(entries.values())}
    # Atomic replace — the worker container reads this file concurrently and
    # must never see a half-written catalogue.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".registry-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class RagNotFound(KeyError):
    """No knowledge base with that id."""


class RagConflict(ValueError):
    """The id is already taken."""


def list_bases() -> List[Dict[str, Any]]:
    """Every registered base, default first, then newest-created first."""
    with _lock:
        entries = _read()
    rows = list(entries.values())
    rows.sort(key=lambda e: (e.get("id") != DEFAULT_ID, -float(e.get("created_at") or 0)))
    return rows


def get_base(rag_id: Optional[str]) -> Dict[str, Any]:
    """One base by id. ``None``/empty resolves to the default base."""
    wanted = (rag_id or DEFAULT_ID).strip() or DEFAULT_ID
    with _lock:
        entries = _read()
    entry = entries.get(wanted)
    if entry is None:
        raise RagNotFound(wanted)
    return entry


def collection_for(rag_id: Optional[str]) -> str:
    """The Qdrant collection backing a base. Raises if the base is unknown."""
    return str(get_base(rag_id).get("collection") or DEFAULT_COLLECTION)


def create_base(
    name: str,
    description: str = "",
    language: str = "",
    rag_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Register a new knowledge base.

    Writes the catalogue entry only. The Qdrant collection is created the first
    time the base is opened (``rag_singleton.get_rag_manager`` → Haystack's
    document store), sized by the embedding model live at that moment — so a
    base registered while the embedder is down is still valid, it just reports
    ``available: false`` until the embedder is back.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("name is required")
    new_id = (rag_id or slugify(name)).strip().lower()
    if not _ID_RE.match(new_id):
        raise ValueError(
            "id must be lowercase letters, digits, '-' or '_', starting with a letter or digit"
        )
    now = time.time()
    entry = {
        "id": new_id,
        "name": name,
        "description": (description or "").strip(),
        "language": (language or "").strip(),
        "collection": COLLECTION_PREFIX + new_id.replace("-", "_"),
        "created_at": now,
        "updated_at": now,
    }
    with _lock:
        entries = _read()
        if new_id in entries:
            raise RagConflict(new_id)
        entries[new_id] = entry
        _write(entries)
    logger.info("RAG base created: %s (%s)", new_id, entry["collection"])
    return entry


def set_overrides(rag_id: str, overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Store the pipeline settings this base deliberately changes.

    Written into the catalogue file rather than settings.json so the ingest
    worker — a separate container that shares the data volume, not the app DB —
    resolves the same configuration the app does. See ``src/rag_config.py`` for
    what may be overridden.
    """
    with _lock:
        entries = _read()
        entry = entries.get((rag_id or "").strip())
        if entry is None:
            raise RagNotFound(rag_id)
        entry["overrides"] = dict(overrides or {})
        entry["updated_at"] = time.time()
        entries[entry["id"]] = entry
        _write(entries)
    return entry


def update_base(
    rag_id: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Edit a base's descriptive fields. Id and collection are immutable."""
    with _lock:
        entries = _read()
        entry = entries.get((rag_id or "").strip())
        if entry is None:
            raise RagNotFound(rag_id)
        if name is not None and name.strip():
            entry["name"] = name.strip()
        if description is not None:
            entry["description"] = description.strip()
        if language is not None:
            entry["language"] = language.strip()
        entry["updated_at"] = time.time()
        entries[entry["id"]] = entry
        _write(entries)
    return entry


def delete_base(rag_id: str, drop_collection: bool = True) -> Dict[str, Any]:
    """Unregister a base and (by default) drop its Qdrant collection.

    The default base cannot be deleted — it is what every un-targeted caller
    resolves to, and dropping it would silently disable Talos chat retrieval.
    """
    rag_id = (rag_id or "").strip()
    if rag_id == DEFAULT_ID:
        raise ValueError("the default knowledge base cannot be deleted")
    with _lock:
        entries = _read()
        entry = entries.pop(rag_id, None)
        if entry is None:
            raise RagNotFound(rag_id)
        _write(entries)
    invalidate_counts(rag_id)
    # Drop the cached VectorRAG too, so re-creating a base under the same id
    # doesn't hand callers an instance still pointing at the dropped collection.
    try:
        from src.rag_singleton import reset

        reset(rag_id)
    except Exception:
        pass
    if drop_collection:
        _drop_collections(str(entry.get("collection") or ""))
    logger.info("RAG base deleted: %s", rag_id)
    return entry


def _drop_collections(collection: str) -> None:
    """Best-effort removal of a base's Qdrant collections (text + pixel lane).

    Best-effort on purpose: the catalogue entry is already gone, so a Qdrant
    that is down must not leave the registry in a half-deleted state. The
    orphaned collection is inert (nothing addresses it) and is dropped by the
    next delete or by hand.
    """
    if not collection:
        return
    try:
        from qdrant_client import QdrantClient

        client = QdrantClient(
            url=os.getenv("QDRANT_URL", "").strip(),
            api_key=os.getenv("QDRANT_API_KEY") or None,
        )
        existing = {c.name for c in client.get_collections().collections}
        for name in (collection, collection + "_visual"):
            if name in existing:
                client.delete_collection(name)
                logger.info("dropped Qdrant collection %s", name)
    except Exception as e:
        logger.warning("could not drop Qdrant collection %s: %s", collection, e)


def describe(entry: Dict[str, Any], *, with_counts: bool = True) -> Dict[str, Any]:
    """The outward-facing view of a base: descriptive fields plus live counts.

    ``content_count`` is the number of indexed **documents** (source files);
    ``chunk_count`` is the number of embedded passages behind them. Counts come
    from Qdrant, not from a stored number, so they can't drift from reality.
    """
    row = {
        "id": entry.get("id"),
        "name": entry.get("name"),
        "description": entry.get("description") or "",
        "language": entry.get("language") or "",
        "collection": entry.get("collection"),
        "created_at": entry.get("created_at") or 0.0,
        "updated_at": entry.get("updated_at") or 0.0,
        # How many pipeline settings this base changes vs. the global defaults —
        # enough for the catalogue to show "inherits everything" without
        # shipping the whole (partly secret) config on a list call.
        "override_count": len(entry.get("overrides") or {}),
    }
    if not with_counts:
        return row
    row.update(_counts(entry))
    return row


# Counting documents means aggregating every chunk by source — a full scroll of
# the collection. The catalogue is meant to be polled (it is how the calling
# software refreshes its permission list), so the result is cached briefly.
# Ingest is asynchronous and takes far longer than this anyway, so a count that
# is a few seconds stale is never the surprising part.
_COUNT_TTL_SECONDS = 30.0
_count_cache: Dict[str, Any] = {}


def invalidate_counts(rag_id: Optional[str] = None) -> None:
    """Drop cached counts (all bases when ``rag_id`` is None)."""
    if rag_id is None:
        _count_cache.clear()
    else:
        _count_cache.pop(rag_id, None)


def _counts(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Document/chunk counts for one base, cached for `_COUNT_TTL_SECONDS`.

    A base whose collection holds nothing yet is healthy with zero content —
    that is not an error state.
    """
    from src.rag_singleton import get_rag_manager, last_init_error

    key = str(entry.get("id") or "")
    cached = _count_cache.get(key)
    if cached and time.monotonic() - cached[0] < _COUNT_TTL_SECONDS:
        return dict(cached[1])

    try:
        rag = get_rag_manager(entry.get("id"))
    except Exception as e:  # unreachable Qdrant / embedder
        return {"content_count": 0, "chunk_count": 0, "available": False, "error": str(e)}
    if rag is None or not getattr(rag, "healthy", False):
        return {
            "content_count": 0,
            "chunk_count": 0,
            "available": False,
            "error": last_init_error() or "RAG backend unavailable",
        }
    from src.rag_scopes import SCOPE_IDS, describe_scopes

    try:
        # Purpose-bound sub-indexes (the SQL schema files) are excluded: they
        # are not part of the corpus a user searches, and counting them makes
        # the base look bigger than what it can actually answer from. They are
        # reported separately as ``scopes``.
        docs = rag.list_documents(exclude_scopes=SCOPE_IDS)
        # ``list_documents`` returns one row per source file with a ``chunks``
        # tally, so the two counts come out of a single scroll.
        chunks = sum(int(d.get("chunks") or 0) for d in docs)
        row = {
            "content_count": len(docs),
            "chunk_count": chunks,
            "available": True,
            "scopes": describe_scopes(rag),
        }
        # Only successes are cached — a backend that just came back should show
        # up on the next poll, not 30 seconds later.
        _count_cache[key] = (time.monotonic(), dict(row))
        return row
    except Exception as e:
        return {"content_count": 0, "chunk_count": 0, "available": False, "error": str(e)}
