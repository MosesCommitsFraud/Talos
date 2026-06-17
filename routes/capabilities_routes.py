"""Lightweight capability flags for the chat UI.

Tells the composer which knowledge sources are configured so it can show the
right control: a RAG+SQL mode dropdown when both are set up, a single toggle
when only one is, or nothing when neither is. User-level (not admin) — every
signed-in user needs it to render the composer.
"""

from fastapi import APIRouter, Request

from src.auth_helpers import get_current_user


def _rag_configured() -> bool:
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
        if not isinstance(cfg, dict) or cfg.get("enabled") is False:
            return False
        return bool(str(cfg.get("qdrant_url") or "").strip() and str(cfg.get("embedding_url") or "").strip())
    except Exception:
        return False


def _sql_configured() -> bool:
    try:
        from src.tool_implementations import _build_external_sql_url

        url, _ = _build_external_sql_url()
        return bool(url)
    except Exception:
        return False


def setup_capabilities_routes():
    router = APIRouter(prefix="/api", tags=["capabilities"])

    @router.get("/capabilities")
    def capabilities(request: Request):
        get_current_user(request)  # ensures auth context; value unused
        return {"rag": _rag_configured(), "sql": _sql_configured()}

    return router
