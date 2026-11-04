"""rag_mini.py

Mini RAGs: one small knowledge base per SQL database from Settings → Integrations.

A mini RAG holds the schema and navigation files of its database and is retrieved
only while the SQL source is active, so the model can find its way around that
database. Apart from that it *is* a knowledge base: its own Qdrant collection, its
own pipeline settings, the same ingest (parsing, chunking, enrichment) and the same
document tools. All of that comes from being an ordinary entry in
``src/rag_registry.py``, so there is no second code path that could drift.

The binding is by construction: entries are created from the configured databases
(``sync``) and there is no way to create one otherwise. A database's id never
changes, so renaming it keeps the binding. An administrator can move a mini RAG to
another configured database (``rebind``), but never to none. Removing a database
does not delete its mini RAG, because uploaded files should not vanish as a side
effect of editing a connection list. The mini RAG then counts as orphaned: it takes
no new documents, is not retrieved, and can be moved to a database or deleted by hand.
"""

from __future__ import annotations

import logging
import os
import shutil
from typing import Any, Dict, List, Optional, Tuple

from src.rag_registry import (
    DEFAULT_ID,
    RagConflict,
    RagNotFound,
    create_base,
    delete_base,
    describe,
    get_base,
    is_mini,
    list_bases,
    set_connection,
    set_overrides,
    slugify,
    update_base,
)
from src.rag_scopes import SQL_SCOPE

logger = logging.getLogger(__name__)

# A connection configured through environment variables has no stored id.
ENV_CONNECTION_ID = "env"

# Where a new mini RAG starts. Its reference material is only ever looked at to
# navigate a database, so it differs from a corpus:
#
# * Schema files chunk into many small pieces (one table per chunk is typical) and
#   a question touches several, hence the wider top-k.
# * A chunk alone often lacks what explains it, the heading or the sentence next to
#   a table, hence a hit brings its neighbours. They stay small, or one hit would
#   take most of the context budget and leave no room for the other tables.
# * A question in German about tables named in English reranks low without being
#   irrelevant, hence no rerank floor, and generated keywords to connect the
#   business term to the technical name. The corpus is small enough to afford the
#   one LLM call per chunk, and without an ingest LLM the setting does nothing.
# * Redaction would rewrite identifiers (`AB1234567`, long numeric ids, the URLs in
#   sample values) into placeholders, hence off even if it is on globally.
#
# These are ordinary overrides: the base's settings show them and can change them.
SEED_OVERRIDES: Dict[str, Any] = {
    "chat_top_k": 12,
    "max_context_chars": 16000,
    "rerank_min_score": 0.0,
    "expand_to_parent_enabled": True,
    "parent_max_chars": 4000,
    "auto_keywords_n": 5,
    "redact_pii_enabled": False,
}

SECTION_SEPARATOR = "\n\n---\n\n"
_MAX_TOP_K = 20


def connections() -> List[Dict[str, Any]]:
    """Every configured database, enabled or not, as ``{id, name, enabled}``.

    Same sources as ``tool_implementations._sql_connections``, which only returns
    the enabled ones and needs no stable id.
    """
    from src.settings import get_setting

    try:
        dbs = get_setting("sql_databases", None)
        legacy = get_setting("sql_database", {})
    except Exception:
        dbs, legacy = None, {}

    rows: List[Dict[str, Any]] = []
    if isinstance(dbs, list) and dbs:
        for i, cfg in enumerate(dbs):
            if isinstance(cfg, dict):
                name = str(cfg.get("name") or "").strip() or f"db{i + 1}"
                rows.append(
                    {
                        "id": str(cfg.get("id") or name),
                        "name": name,
                        "enabled": bool(cfg.get("enabled")),
                    }
                )
    elif isinstance(legacy, dict) and (
        legacy.get("host") or legacy.get("database") or legacy.get("enabled")
    ):
        rows.append(
            {
                "id": str(legacy.get("id") or "default"),
                "name": str(legacy.get("name") or "").strip() or "default",
                "enabled": bool(legacy.get("enabled")),
            }
        )
    if not any(r["enabled"] for r in rows):
        from src.tool_implementations import _build_env_sql_url

        url, _ = _build_env_sql_url()
        if url:
            rows.append({"id": ENV_CONNECTION_ID, "name": "default", "enabled": True})
    return rows


def _mini_entries() -> List[Dict[str, Any]]:
    return [e for e in list_bases(include_mini=True) if is_mini(e)]


def _create(connection: Dict[str, Any]) -> Dict[str, Any]:
    language = str(get_base(DEFAULT_ID).get("language") or "")
    stem = "db-" + slugify(connection["id"])[:50]
    for attempt in range(100):
        rag_id = stem if attempt == 0 else f"{stem}-{attempt + 1}"
        try:
            entry = create_base(
                connection["name"],
                language=language,
                rag_id=rag_id,
                connection_id=connection["id"],
            )
        except RagConflict:
            continue
        # Stored as they are, not through rag_config.set_overrides, which drops a
        # value equal to today's global one: these must not follow a later global
        # change, or turning redaction on globally would reach the schema files.
        set_overrides(entry["id"], SEED_OVERRIDES)
        logger.info("Mini RAG %s created for database %s", entry["id"], connection["name"])
        return entry
    raise RagConflict(stem)


def sync() -> List[Dict[str, Any]]:
    """Give every configured database its mini RAG and keep the names in step.

    Writes only when something changed, so it is safe to run on every listing.
    Returns the configured connections.
    """
    conns = connections()
    existing = {e.get("connection_id"): e for e in _mini_entries()}
    for conn in conns:
        entry = existing.get(conn["id"])
        if entry is None:
            _create(conn)
        elif entry.get("name") != conn["name"]:
            update_base(entry["id"], name=conn["name"])
    return conns


def rebind(base_id: str, connection_id: str) -> None:
    """Move a mini RAG to another database from Integrations.

    Every database keeps exactly one mini RAG, and no documents are lost: if the
    target already has one, the two trade places. If the one that moved had no
    database left, the other is orphaned by the trade; that one is deleted when it
    is empty, since there is nothing in it to keep.
    """
    conns = connections()
    if not any(c["id"] == connection_id for c in conns):
        raise ValueError(f"Unknown database '{connection_id}'")
    displaced = set_connection(base_id, connection_id)
    sync()
    if displaced is None or any(c["id"] == displaced.get("connection_id") for c in conns):
        return
    row = describe(displaced)
    if row.get("available") and not row.get("content_count"):
        delete_base(str(displaced["id"]))


def annotate(row: Dict[str, Any], conns: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Add the bound database to a described mini RAG; ``None`` means orphaned."""
    if row.get("kind") == "mini":
        row["connection"] = next((c for c in conns if c["id"] == row.get("connection_id")), None)
    return row


def is_orphaned(base_id: Optional[str]) -> bool:
    """A mini RAG whose database is no longer in Integrations."""
    if not base_id:
        return False
    try:
        entry = get_base(base_id)
    except RagNotFound:
        return False
    if not is_mini(entry):
        return False
    return not any(c["id"] == entry.get("connection_id") for c in connections())


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


def search_targets() -> List[Tuple[str, Optional[str], Optional[str]]]:
    """What the SQL feature searches, as ``(database name, base id, scope)``.

    The mini RAG of every enabled database, plus the default base's old schema
    files for as long as they have not moved. Empty ones are skipped: searching
    them would only cost a query embedding each.
    """
    by_connection = {e.get("connection_id"): e for e in _mini_entries()}
    targets: List[Tuple[str, Optional[str], Optional[str]]] = []
    for conn in connections():
        entry = by_connection.get(conn["id"])
        if conn["enabled"] and entry and describe(entry).get("content_count"):
            targets.append((conn["name"], entry["id"], None))
    if describe(get_base(DEFAULT_ID)).get("legacy_sql_count"):
        targets.append(("", None, SQL_SCOPE))
    return targets


def _relevant(results: List[Dict[str, Any]], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The base's own relevance thresholds, nothing beyond them.

    Chat retrieval additionally demands lexical evidence, because it must stay
    silent on off-topic questions. This is reference material for a question
    already known to be about the database, and a table named ``orders`` shares no
    word with "Umsätze pro Monat".
    """

    def _threshold(key: str) -> float:
        try:
            return float(cfg.get(key) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    if any(r.get("rerank_score") is not None for r in results):
        floor = _threshold("rerank_min_score")
        return [r for r in results if float(r.get("rerank_score") or 0.0) >= floor]
    floor = _threshold("similarity_threshold")
    return [r for r in results if float(r.get("similarity") or 0.0) >= floor]


def _config(base_id: Optional[str], scope: Optional[str]) -> Dict[str, Any]:
    from src.rag_config import effective_config

    # Old schema files sit in the default base, whose settings tune the corpus
    # and say nothing about them: they keep running as they always did.
    return {**effective_config(base_id), **(SEED_OVERRIDES if scope else {})}


def _int(cfg: Dict[str, Any], key: str, fallback: int) -> int:
    try:
        return int(cfg.get(key) or fallback)
    except (TypeError, ValueError):
        return fallback


def retrieve_sections(query: str) -> List[str]:
    """Passages for ``query`` from every database's mini RAG, ready to inject.

    Each base runs on its own settings (top-k, candidates, thresholds, context
    budget, small-to-big expansion). With several databases the budget is shared
    and each passage names its database, which is what the model has to pass to
    ``query_sql``.
    """
    from src.rag_singleton import get_rag_manager
    from src.rag_structure import DEFAULT_CANDIDATE_TOP_K, budget_context, context_location

    targets = search_targets()
    if not targets:
        return []
    configs = [_config(base_id, scope) for _, base_id, scope in targets]
    limit = max(_int(cfg, "max_context_chars", 16000) for cfg in configs)
    share = limit // len(targets)
    named = sum(1 for name, _, _ in targets if name) > 1

    sections: List[str] = []
    for (name, base_id, scope), cfg in zip(targets, configs):
        rag = get_rag_manager(base_id)
        if not (rag and getattr(rag, "healthy", False)):
            continue
        k = max(1, min(_int(cfg, "chat_top_k", 12), _MAX_TOP_K))
        candidate_k = max(k, min(_int(cfg, "candidate_top_k", DEFAULT_CANDIDATE_TOP_K), 100))
        results = rag.search(
            query, k=k, owner=None, candidate_k=candidate_k, **({"scope": scope} if scope else {})
        )
        budget = min(share, _int(cfg, "max_context_chars", share))
        left = budget
        # Neighbouring hits share chunks once they bring their surroundings along.
        # Same handling as chat: each chunk is sent once, and a hit's neighbours
        # shrink to fit before the hit itself is given up.
        seen: set = set()

        def _section(hit: Dict[str, Any], label: str, body: str) -> str:
            return "\n".join(part for part in (label, context_location(hit), body) if part)

        for hit in _relevant(results or [], cfg):
            filename = (hit.get("metadata") or {}).get("filename") or "doc"
            label = f"[{name}: {filename}]" if named and name else f"[{filename}]"
            expandable = bool(hit.get("_context_documents") or hit.get("expanded"))
            body = hit.get("expanded") or hit.get("document") or ""
            if expandable:
                overhead = len(_section(hit, label, body)) - len(body)
                body = budget_context(hit, max(0, left - overhead), seen)
                if not body:
                    continue
            section = _section(hit, label, body)
            if len(section) > left:
                # Skipped rather than blocking smaller passages behind it. Only the
                # very first may be cut, so that some context reaches the model.
                if left == budget and not expandable:
                    sections.append(section[:budget])
                    left = 0
                continue
            sections.append(section)
            left -= len(section) + len(SECTION_SEPARATOR)
    return sections


# ---------------------------------------------------------------------------
# Moving the old schema files out of the default base
# ---------------------------------------------------------------------------


def plan_adoption(
    legacy_rag, upload_dir: str
) -> Tuple[List[Tuple[str, Dict[str, Any]]], List[Tuple[str, str]], List[str]]:
    """What it takes to move the default base's schema files into a mini RAG.

    Returns ``(files to ingest, (old, new) paths, names that can't move)``. Each
    stored file is copied into the mini RAG's upload folder now, so it belongs to
    that base from here on; the original goes once the copy has been indexed. A
    document unpacked from an archive isn't listed separately, because the archive
    brings it along. A document whose file is gone can't be re-indexed and stays.
    """
    files: List[Tuple[str, Dict[str, Any]]] = []
    moves: List[Tuple[str, str]] = []
    skipped: List[str] = []
    for doc in legacy_rag.list_documents(scope=SQL_SCOPE) or []:
        if doc.get("container"):
            continue
        source = str(doc.get("source") or "")
        name = str(doc.get("filename") or os.path.basename(source))
        if not os.path.isfile(source):
            skipped.append(name)
            continue
        meta: Dict[str, Any] = {"filename": name, "type": doc.get("type") or ""}
        if doc.get("doc_id"):
            try:
                _, meta = legacy_rag.requeue_spec(doc["doc_id"])
            except LookupError:
                skipped.append(name)
                continue
        target = os.path.join(upload_dir, os.path.basename(source))
        shutil.copy2(source, target)
        meta = {k: v for k, v in meta.items() if k != "scope"}
        meta.update({"source": target, "directory": upload_dir, "_force": True})
        files.append((target, meta))
        moves.append((source, target))
    return files, moves, skipped


def finish_adoption(target_rag, legacy_rag, moves: List[Tuple[str, str]]) -> int:
    """Drop the originals of everything that arrived. Returns how many moved.

    Anything the mini RAG did not take stays where it is and keeps being retrieved,
    so a failed ingest loses nothing and the move can simply be run again.
    """
    moved = 0
    for old, new in moves:
        row = target_rag.document_detail(source=new) or {}
        if row.get("status") not in ("indexed", "duplicate"):
            continue
        legacy_rag.delete_document(source=old)
        try:
            os.remove(old)
        except OSError as e:
            logger.warning("could not remove the moved upload %s: %s", old, e)
        moved += 1
    return moved
