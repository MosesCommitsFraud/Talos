"""rag_scopes.py

Namespaces that used to live inside a knowledge base's collection.

SQL schema files were once indexed into the default base, tagged with
``meta.scope == "sql"``. They now live in mini RAGs, one per database
(``src/rag_mini.py``), but a deployment that has not moved them yet still holds
such documents. So every ordinary read keeps excluding these namespaces, and this
list is the one place that says which they are.
"""

from __future__ import annotations

from typing import List

SQL_SCOPE = "sql"

SCOPE_IDS: List[str] = [SQL_SCOPE]


def legacy_document_count(rag) -> int:
    """Schema files still waiting in this base. Informational, so a failure is 0."""
    try:
        return len(rag.list_documents(scope=SQL_SCOPE) or [])
    except Exception:
        return 0
