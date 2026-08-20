"""rag_scopes.py

Purpose-bound sub-indexes ("mini RAGs") inside a knowledge base.

A knowledge base normally holds documents someone uploaded to answer questions
from. A *scope* is different: a small set of documents a Talos feature manages
for its own use, living in the same Qdrant collection but tagged with
``meta.scope`` so ordinary retrieval never sees them.

Today there is exactly one — the SQL schema files, which are injected only when
the SQL source is active (``routes/sql_routes.py``, ``src/agent_loop.py``).
They were being counted and listed as if a user had put them in the knowledge
base, which is misleading in both directions: the base looks bigger than the
corpus a user can search, and the schema files look deletable from a screen that
is not where they are managed.

Adding a scope means adding an entry here and tagging the documents on ingest.
Nothing else in the knowledge-base UI has to know about it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# One entry per purpose-bound sub-index.
#
# ``managed_at`` is where the feature that owns it is actually administered —
# the knowledge-base UI shows the scope read-only and points there, rather than
# offering an upload/delete that would bypass the owning feature.
SCOPES: List[Dict[str, str]] = [
    {
        "id": "sql",
        "name": "SQL schema",
        "purpose": (
            "Schema files for the connected SQL databases. Retrieved only while "
            "the SQL knowledge source is active, so the model can navigate the "
            "database — never mixed into ordinary knowledge-base answers."
        ),
        "managed_at": "sql-settings",
    },
]

SCOPE_IDS: List[str] = [s["id"] for s in SCOPES]


def scope(scope_id: str) -> Optional[Dict[str, str]]:
    return next((s for s in SCOPES if s["id"] == scope_id), None)


def describe_scopes(rag) -> List[Dict[str, Any]]:
    """Every known scope with its live document/chunk counts for one base.

    A scope with nothing in it is still listed: "the SQL schema index is empty"
    is exactly the answer someone wondering why SQL answers are thin needs.
    Counting failures degrade to zero rather than raising — the scope panel is
    informational and must not take the page down with it.
    """
    rows: List[Dict[str, Any]] = []
    for meta in SCOPES:
        docs: List[Dict[str, Any]] = []
        try:
            docs = rag.list_documents(scope=meta["id"]) or []
        except Exception:
            docs = []
        rows.append(
            {
                **meta,
                "content_count": len(docs),
                "chunk_count": sum(int(d.get("chunks") or 0) for d in docs),
            }
        )
    return rows
