"""
RAG singleton instance for the application.
"""
import os
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

rag_instance = None
_last_attempt = 0.0
_last_error = ""  # human-readable reason the last init failed (surfaced to UI/jobs)
_RETRY_INTERVAL = 30  # seconds between re-init attempts


def last_init_error() -> str:
    """Why the most recent RAG init attempt failed, for surfacing to the user."""
    return _last_error


def get_rag_manager():
    """Lazy Qdrant/Haystack-backed VectorRAG initializer.

    Returns the VectorRAG instance on first successful init, None if Qdrant /
    the Haystack RAG dependencies aren't reachable or installed. Failed init
    attempts are throttled to once per _RETRY_INTERVAL seconds so a missing
    Qdrant doesn't busy-retry on every request — callers (personal-doc routes
    etc.) get None back and return a clean 503 to the user instead.
    """
    global rag_instance, _last_attempt

    if rag_instance is not None:
        return rag_instance

    now = time.monotonic()
    if now - _last_attempt < _RETRY_INTERVAL:
        return None  # too soon to retry — last attempt failed

    _last_attempt = now

    global _last_error
    try:
        from src.rag_vector import VectorRAG

        base_dir = Path(__file__).parent.parent
        persist_dir = os.path.join(base_dir, "data", "rag")

        candidate = VectorRAG(persist_directory=persist_dir)
        if not candidate.healthy:
            _last_error = candidate.last_error or "RAG init failed (no detail)"
            logger.warning("VectorRAG not healthy: %s", _last_error)
            rag_instance = None
        else:
            _last_error = ""
            rag_instance = candidate
            logger.info("Initialized VectorRAG (Qdrant hybrid + Haystack)")

    except ImportError as e:
        _last_error = f"Haystack/Qdrant deps not installed — rebuild the image. ({e})"
        logger.warning(f"VectorRAG not available: {e}")
        rag_instance = None
    except Exception as e:
        _last_error = f"{type(e).__name__}: {e}"
        logger.error(f"Failed to initialize RAG: {e}")
        rag_instance = None

    return rag_instance
