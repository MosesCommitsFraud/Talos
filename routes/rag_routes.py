from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.middleware import require_admin
from src.settings import load_settings, save_settings


class RagPipelineConfig(BaseModel):
    embedding_url: str = ""
    embedding_model: str = ""
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    rerank_url: str = ""
    rerank_model: str = ""
    rerank_api_key: str = ""


def _public(cfg: dict) -> dict:
    return {
        "embedding_url": cfg.get("embedding_url", ""),
        "embedding_model": cfg.get("embedding_model", ""),
        "qdrant_url": cfg.get("qdrant_url", ""),
        "qdrant_api_key_set": bool(cfg.get("qdrant_api_key")),
        "rerank_url": cfg.get("rerank_url", ""),
        "rerank_model": cfg.get("rerank_model", ""),
        "rerank_api_key_set": bool(cfg.get("rerank_api_key")),
    }


def _reset_rag():
    import src.rag_singleton as _rs
    _rs.rag_instance = None
    _rs._last_attempt = 0
    try:
        from src.embeddings import reset_http_embed_state
        reset_http_embed_state()
    except Exception:
        pass


def setup_rag_routes():
    router = APIRouter(prefix="/api/rag", tags=["rag"], dependencies=[Depends(require_admin)])

    @router.get("/config")
    def get_config():
        settings = load_settings()
        cfg = settings.get("rag_pipeline", {}) if isinstance(settings.get("rag_pipeline"), dict) else {}
        return _public(cfg)

    @router.put("/config")
    def set_config(body: RagPipelineConfig):
        settings = load_settings()
        current = settings.get("rag_pipeline", {}) if isinstance(settings.get("rag_pipeline"), dict) else {}
        cfg = {
            "embedding_url": body.embedding_url.strip(),
            "embedding_model": body.embedding_model.strip(),
            "qdrant_url": body.qdrant_url.strip(),
            "qdrant_api_key": body.qdrant_api_key or current.get("qdrant_api_key", ""),
            "rerank_url": body.rerank_url.strip(),
            "rerank_model": body.rerank_model.strip(),
            "rerank_api_key": body.rerank_api_key or current.get("rerank_api_key", ""),
        }
        if not cfg["embedding_url"]:
            raise HTTPException(400, "Embedding URL is required")
        if not cfg["embedding_model"]:
            raise HTTPException(400, "Embedding model is required")
        if not cfg["qdrant_url"]:
            raise HTTPException(400, "Qdrant URL is required")
        settings["rag_pipeline"] = cfg
        save_settings(settings)
        _reset_rag()
        return _public(cfg)

    @router.post("/test")
    def test_config():
        _reset_rag()
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available. Check embedding, Qdrant, and dependencies.")
        stats = rag.get_stats()
        return {"ok": True, "stats": stats}

    return router
