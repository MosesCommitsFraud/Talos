"""Lightweight capability flags for the chat UI.

Tells the composer which knowledge sources are configured so it can show the
right control: a RAG+SQL mode dropdown when both are set up, a single toggle
when only one is, or nothing when neither is. User-level (not admin) — every
signed-in user needs it to render the composer.
"""

import logging

from fastapi import APIRouter, Query, Request

from src.auth_helpers import get_current_user

logger = logging.getLogger(__name__)


def _rag_configured() -> bool:
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
        if not isinstance(cfg, dict) or cfg.get("enabled") is False:
            return False
        if str(cfg.get("provider") or "internal").strip().lower() == "external":
            return bool(
                str(cfg.get("external_url") or "").strip()
                and str(cfg.get("external_dataset_id") or "").strip()
            )
        return bool(
            str(cfg.get("qdrant_url") or "").strip() and str(cfg.get("embedding_url") or "").strip()
        )
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
        from routes.voice_routes import voice_configured, voice_streaming_available

        get_current_user(request)  # ensures auth context; value unused
        return {
            "rag": _rag_configured(),
            "sql": _sql_configured(),
            # Live values, not just config: `voice` hides the mic entirely when
            # no working transport exists; `voice_streaming` falls back to the
            # batch path while the dictation sidecar is down or still loading.
            "voice": voice_configured(),
            "voice_streaming": voice_streaming_available(),
        }

    @router.get("/capabilities/reasoning")
    def reasoning_capabilities(
        request: Request,
        endpoint_id: str = Query(""),
        model: str = Query(""),
        refresh: bool = Query(False),
    ):
        """Effort levels the given model honours — `[]` when it only has the
        thinking on/off switch, so the composer can drop the slider.

        Per model, not global: the same endpoint alias has served both a
        generation with the effort knob and one without.
        """
        user = get_current_user(request)  # username, used for endpoint ownership
        efforts: list = []
        try:
            from src.endpoint_resolver import resolve_endpoint_by_id
            from src.llm_core import supported_reasoning_efforts

            resolved = resolve_endpoint_by_id(endpoint_id, model, owner=user)
            if resolved:
                url, resolved_model, headers = resolved
                efforts = list(
                    supported_reasoning_efforts(url, resolved_model, headers, refresh=refresh)
                )
        except Exception as e:
            # A probe that can't run must not break the composer: no levels
            # means the binary toggle, which every model understands.
            logger.debug("reasoning capability probe failed: %s", e)
        return {"efforts": efforts}

    return router
