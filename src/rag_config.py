"""rag_config.py

Resolves the RAG pipeline configuration **for one knowledge base**.

Talos has one `rag_pipeline` settings block. With several knowledge bases
(``src/rag_registry.py``) that block became the *defaults*: each base stores
only the keys it deliberately changes, and everything else is inherited. Change
the global reranker and every base that never overrode it follows along.

Two kinds of keys:

* ``GLOBAL_KEYS`` — infrastructure shared by every base (the Qdrant instance,
  the external-provider switch, the global kill-switch). A base cannot override
  these: there is one vector store, and letting a base point at a different one
  would turn a settings mistake into a silent split-brain index.
* everything else — per base. Embedding model, reranker, the retrieval tuning
  and all ingest lanes. Different bases legitimately want different pipelines:
  a base of scanned PDFs wants the VLM lane that a base of Markdown notes would
  only be slowed down by.

Overrides live in the registry entry (``data/rag/registry.json``) rather than in
settings.json, because the ingest worker runs in a separate container that
shares the data volume but not the app database — the same reason the catalogue
itself lives there.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Set

logger = logging.getLogger(__name__)

# Infrastructure — one per deployment, never per base.
GLOBAL_KEYS: Set[str] = {
    "enabled",
    "provider",
    "qdrant_url",
    "qdrant_api_key",
    "external_url",
    "external_api_key",
    "external_dataset_id",
    "external_top_k",
}

# Secrets are stored but never echoed back to a client; the UI shows a
# "…_set" boolean instead (mirrors routes/rag_routes.py `_public`).
SECRET_KEYS: Set[str] = {"qdrant_api_key", "rerank_api_key", "external_api_key"}


def global_config() -> Dict[str, Any]:
    """The saved `rag_pipeline` block — the defaults every base inherits."""
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
    except Exception as e:
        logger.warning("could not read rag_pipeline settings: %s", e)
        return {}
    return dict(cfg) if isinstance(cfg, dict) else {}


def overrides_for(base_id: Optional[str]) -> Dict[str, Any]:
    """The keys this base deliberately sets. Empty for a base that inherits all."""
    try:
        from src.rag_registry import get_base

        raw = get_base(base_id).get("overrides")
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    # A stored global key would silently do nothing; drop it so the effective
    # config can never disagree with what the UI shows.
    return {k: v for k, v in raw.items() if k not in GLOBAL_KEYS}


def effective_config(base_id: Optional[str] = None) -> Dict[str, Any]:
    """The configuration one knowledge base actually runs with.

    Global defaults with the base's overrides layered on top. Callers can treat
    the result exactly like the old flat `rag_pipeline` dict — that is the point,
    so every existing consumer keeps working by passing a base id.
    """
    cfg = global_config()
    cfg.update(overrides_for(base_id))
    return cfg


def set_overrides(base_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Replace a base's overrides with `patch` and return the stored result.

    Only non-global keys are kept. A key whose value equals the global default
    is dropped rather than stored, so "inherited" stays the honest default and a
    later change to the global value still propagates.
    """
    from src.rag_registry import set_overrides as _store

    defaults = global_config()
    clean: Dict[str, Any] = {}
    for key, value in (patch or {}).items():
        if key in GLOBAL_KEYS:
            continue
        if key in defaults and defaults[key] == value:
            continue
        clean[key] = value
    return _store(base_id, clean)


def is_overridden(base_id: Optional[str], key: str) -> bool:
    return key in overrides_for(base_id)
