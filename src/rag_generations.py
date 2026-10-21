"""Publish complete source generations without deleting the working index first.

The small manifest lives on the shared RAG data volume, alongside the knowledge
base registry. Atomic replacement is the commit point; Qdrant writes are staged
and verified before it. All readers must apply visibility_filter().
"""

import hashlib
import json
import logging
import os
import tempfile
import uuid
from dataclasses import replace
from pathlib import Path

logger = logging.getLogger(__name__)


def combine(*filters):
    items = [f for f in filters if f]
    if any(not isinstance(f, dict) for f in items):
        from qdrant_client.http import models

        return models.Filter(must=[qdrant_filter(f) for f in items])
    return (
        {"operator": "AND", "conditions": items} if len(items) > 1 else items[0] if items else None
    )


def qdrant_filter(filters):
    """Preserve exact identity matching and missing fields in Qdrant filters."""
    from haystack_integrations.document_stores.qdrant.filters import convert_filters_to_qdrant
    from qdrant_client.http import models

    if not isinstance(filters, dict):
        return filters
    operator = filters["operator"]
    if operator in ("AND", "OR", "NOT"):
        field = {"AND": "must", "OR": "should", "NOT": "must_not"}[operator]
        return models.Filter(**{field: [qdrant_filter(f) for f in filters["conditions"]]})
    key, value = filters["field"], filters.get("value")
    if value is None and operator == "==":
        return models.Filter(must=[models.IsEmptyCondition(is_empty=models.PayloadField(key=key))])
    if operator == "==":
        return models.Filter(
            must=[models.FieldCondition(key=key, match=models.MatchValue(value=value))]
        )
    if operator == "in":
        return models.Filter(
            should=[qdrant_filter({"field": key, "operator": "==", "value": v}) for v in value]
        )
    return convert_filters_to_qdrant(filters)


def store_filter(store, filters):
    if type(store).__module__.startswith("haystack_integrations.document_stores.qdrant"):
        return qdrant_filter(filters)
    return filters


def identity(meta):
    """What one publication replaces.

    Registered documents are identified by their stable ``doc_id`` (see
    src/rag_documents.py), so a new version stored under a different file path
    still retires the old one. Unregistered chunks keep the historical
    source/owner/scope identity.
    """
    key = "doc_id" if meta.get("doc_id") else "source"
    return {key: meta.get(key), "owner": meta.get("owner"), "scope": meta.get("scope")}


def identity_filter(value):
    keys = ("doc_id" if "doc_id" in value else "source", "owner", "scope")
    return {
        "operator": "AND",
        "conditions": [
            {"field": f"meta.{key}", "operator": "==", "value": value.get(key)} for key in keys
        ],
    }


class GenerationCatalog:
    def __init__(self, directory, collection):
        key = hashlib.sha256(collection.encode()).hexdigest()[:24]
        self.path = Path(directory) / "generations" / f"{key}.json"

    def read(self):
        try:
            with self.path.open(encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return {"active": {}, "pending": []}
        # Corruption must fail closed, not expose incomplete generations.

    def save(self, state):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            dir=self.path.parent, prefix=".generation-", suffix=".json"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def visibility_filter(self, filters=None):
        state = self.read()
        active = list(state["active"].values())
        clauses = [filters]
        if active:
            clauses.append(
                {
                    "operator": "OR",
                    "conditions": [
                        {
                            "field": "meta.ingest_generation",
                            "operator": "in",
                            "value": [r["generation"] for r in active],
                        },
                        {
                            "operator": "NOT",
                            "conditions": [
                                {
                                    "operator": "OR",
                                    "conditions": [identity_filter(r["identity"]) for r in active],
                                }
                            ],
                        },
                    ],
                }
            )
        if state["pending"]:
            clauses.append(
                {
                    "operator": "NOT",
                    "conditions": [
                        {
                            "field": "meta.ingest_generation",
                            "operator": "in",
                            "value": state["pending"],
                        }
                    ],
                }
            )
        return combine(*clauses)

    def publish(self, documents, store, writer):
        """Write one complete source, atomically activate, then retire old chunks."""
        from filelock import FileLock

        source = identity(documents[0].meta)
        if not (source.get("doc_id") or source.get("source")) or any(
            identity(d.meta) != source for d in documents
        ):
            raise ValueError("Generation publication requires one complete source/owner/scope.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path) + ".lock", timeout=300):
            previous = store.filter_documents(filters=store_filter(store, identity_filter(source)))
            if source.get("doc_id") and documents[0].meta.get("source"):
                # Chunks written before documents were registered carry no
                # doc_id; same file, same owner/scope means same document.
                legacy = identity_filter({**identity({**documents[0].meta, "doc_id": None})})
                legacy["conditions"].append(
                    {"field": "meta.doc_id", "operator": "==", "value": None}
                )
                seen = {d.id for d in previous}
                previous += [
                    d
                    for d in store.filter_documents(filters=store_filter(store, legacy))
                    if d.id not in seen
                ]
            state = self.read()
            token = uuid.uuid4().hex
            id_map = {
                d.id: hashlib.sha256(f"{token}:{d.id}".encode()).hexdigest() for d in documents
            }
            staged = []
            for document in documents:
                meta = dict(document.meta, ingest_generation=token)
                for field in ("prev_chunk_id", "next_chunk_id"):
                    if meta.get(field) in id_map:
                        meta[field] = id_map[meta[field]]
                staged.append(replace(document, id=id_map[document.id], meta=meta))
            state["pending"].append(token)
            self.save(state)
            try:
                writer(staged)
                verified = store.filter_documents(
                    filters=store_filter(
                        store,
                        combine(
                            identity_filter(source),
                            {"field": "meta.ingest_generation", "operator": "==", "value": token},
                        ),
                    )
                )
                if {d.id for d in verified} != {d.id for d in staged}:
                    raise RuntimeError("Incomplete RAG generation; old document remains active.")
                key = json.dumps(source, sort_keys=True)
                # Entries whose chunks this publication retires (an older
                # source-keyed generation of the same document) are dropped,
                # so a failed retirement can never keep them visible.
                retired = {d.meta.get("ingest_generation") for d in previous}
                state["active"] = {
                    k: r
                    for k, r in state["active"].items()
                    if k == key or r.get("generation") not in retired
                }
                state["active"][key] = {"identity": source, "generation": token}
                state["pending"].remove(token)
                self.save(state)
            except Exception:
                # If cleanup fails, retain the pending marker so partial writes
                # remain hidden even after a process restart.
                try:
                    store.delete_documents([d.id for d in staged])
                    clean = self.read()
                    if token in clean["pending"]:
                        clean["pending"].remove(token)
                    self.save(clean)
                except Exception:
                    logger.exception(
                        "Staged RAG generation cleanup failed; generation stays hidden"
                    )
                raise
            try:
                if previous:
                    store.delete_documents([d.id for d in previous])
            except Exception:
                logger.exception("Retired RAG chunks remain stored but are excluded from retrieval")
            return len(staged)

    def reset(self):
        from filelock import FileLock

        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path) + ".lock", timeout=300):
            self.save({"active": {}, "pending": []})
