"""
RAG instances for the application — one per knowledge base.

Historically this held a single global ``rag_instance``. It now caches one
``VectorRAG`` per registered knowledge base (``src/rag_registry.py``), keyed by
base id, because each base owns its own Qdrant collection. ``get_rag_manager()``
with no argument still returns the default base, so every existing caller
(chat, routes, MCP tools, the ingest worker) is unchanged.

The module-level ``rag_instance`` name is kept as an alias for the default
base, for code that reads it directly rather than calling ``get_rag_manager``.
Use ``reset()`` / ``set_instance()`` to change what is cached — the old
``rag_instance = None; _last_attempt = 0`` idiom no longer works, since the
throttle is now per base.
"""

import logging
import os
import time
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

rag_instance = None  # the default base's instance (legacy alias)
_instances: Dict[str, object] = {}
_last_attempt: Dict[str, float] = {}
_last_error = ""  # human-readable reason the last init failed (surfaced to UI/jobs)
_RETRY_INTERVAL = 30  # seconds between re-init attempts


def last_init_error() -> str:
    """Why the most recent RAG init attempt failed, for surfacing to the user."""
    return _last_error


def reset(base_id: Optional[str] = None) -> None:
    """Drop cached instances so the next call re-initializes.

    ``base_id=None`` clears every base — used by the ingest worker, which must
    build its RAG against the job's config snapshot rather than whatever the
    process happened to initialize with earlier.
    """
    global rag_instance
    if base_id is None:
        _instances.clear()
        _last_attempt.clear()
        rag_instance = None
        return
    _instances.pop(base_id, None)
    _last_attempt.pop(base_id, None)
    if base_id == _default_id():
        rag_instance = None


def set_instance(base_id: Optional[str], rag) -> None:
    """Install an already-built VectorRAG as one base's cached instance.

    Used by the rebuild route, which constructs the instance itself with
    ``recreate_index=True`` and then wants subsequent callers to get it.
    """
    global rag_instance
    key = (base_id or _default_id()).strip() or _default_id()
    _instances[key] = rag
    _last_attempt.pop(key, None)
    if key == _default_id():
        rag_instance = rag


def _default_id() -> str:
    from src.rag_registry import DEFAULT_ID

    return DEFAULT_ID


def get_rag_manager(base_id: Optional[str] = None, config: Optional[dict] = None):
    """Lazy Qdrant/Haystack-backed VectorRAG initializer for one knowledge base.

    Returns the VectorRAG instance on first successful init, None if Qdrant /
    the Haystack RAG dependencies aren't reachable or installed. Failed init
    attempts are throttled per base to once per _RETRY_INTERVAL seconds so a
    missing Qdrant doesn't busy-retry on every request — callers (personal-doc
    routes etc.) get None back and return a clean 503 to the user instead.

    ``base_id`` is a knowledge-base id from ``src/rag_registry.py``; omit it for
    the default base. An unknown id raises ``RagNotFound`` — that is a caller
    error (a bad URL), not a backend outage, and must not look like one.

    ``config`` overrides the resolved pipeline settings. The ingest worker
    passes the snapshot captured when the job was *enqueued*, so a job runs with
    the configuration it was queued under rather than whatever was saved while
    it sat in the queue.
    """
    global rag_instance, _last_error

    from src.rag_config import effective_config
    from src.rag_registry import DEFAULT_ID, collection_for

    key = (base_id or DEFAULT_ID).strip() or DEFAULT_ID
    # Raises RagNotFound for an unregistered id — deliberately not caught.
    collection = collection_for(key)

    existing = _instances.get(key)
    if existing is not None:
        return existing

    now = time.monotonic()
    if now - _last_attempt.get(key, 0.0) < _RETRY_INTERVAL:
        return None  # too soon to retry — last attempt failed

    _last_attempt[key] = now

    try:
        from src.rag_vector import VectorRAG

        base_dir = Path(__file__).parent.parent
        persist_dir = os.getenv("RAG_DATA_DIR", "").strip() or os.path.join(base_dir, "data", "rag")

        candidate = VectorRAG(
            persist_directory=persist_dir,
            collection_name=collection,
            config=config if config is not None else effective_config(key),
        )
        if not candidate.healthy:
            _last_error = candidate.last_error or "RAG init failed (no detail)"
            logger.warning("VectorRAG not healthy for base '%s': %s", key, _last_error)
            return None

        _last_error = ""
        _instances[key] = candidate
        if key == DEFAULT_ID:
            rag_instance = candidate
        logger.info(
            "Initialized VectorRAG for base '%s' (collection=%s)",
            key,
            collection,
        )
        return candidate

    except ImportError as e:
        _last_error = f"Haystack/Qdrant deps not installed — rebuild the image. ({e})"
        logger.warning(f"VectorRAG not available: {e}")
        return None
    except Exception as e:
        _last_error = f"{type(e).__name__}: {e}"
        logger.error(f"Failed to initialize RAG for base '{key}': {e}")
        return None
