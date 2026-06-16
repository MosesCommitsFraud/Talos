from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.middleware import require_admin
from src.settings import load_settings, save_settings


class RagPipelineConfig(BaseModel):
    enabled: bool = True
    embedding_url: str = ""
    embedding_model: str = ""
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    rerank_url: str = ""
    rerank_model: str = ""
    rerank_api_key: str = ""
    sparse_model: str = ""
    chat_top_k: int = 5
    search_top_k: int = 5
    candidate_top_k: int = 40


def _clamp_k(value: int, default: int = 5) -> int:
    try:
        return max(1, min(int(value), 20))
    except Exception:
        return default


def _clamp_candidate_k(value: int, default: int = 40) -> int:
    try:
        return max(1, min(int(value), 100))
    except Exception:
        return default


def _public(cfg: dict) -> dict:
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "embedding_url": cfg.get("embedding_url", ""),
        "embedding_model": cfg.get("embedding_model", ""),
        "qdrant_url": cfg.get("qdrant_url", ""),
        "qdrant_api_key_set": bool(cfg.get("qdrant_api_key")),
        "rerank_url": cfg.get("rerank_url", ""),
        "rerank_model": cfg.get("rerank_model", ""),
        "rerank_api_key_set": bool(cfg.get("rerank_api_key")),
        "sparse_model": cfg.get("sparse_model", ""),
        "chat_top_k": _clamp_k(cfg.get("chat_top_k", 5)),
        "search_top_k": _clamp_k(cfg.get("search_top_k", 5)),
        "candidate_top_k": _clamp_candidate_k(cfg.get("candidate_top_k", 40)),
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
    # Ingest runs in the separate rag-ingest-worker container (RQ). No in-process
    # worker to start here — the app only enqueues and reads job status.

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
            "enabled": bool(body.enabled),
            "embedding_url": body.embedding_url.strip(),
            "embedding_model": body.embedding_model.strip(),
            "qdrant_url": body.qdrant_url.strip(),
            "qdrant_api_key": body.qdrant_api_key or current.get("qdrant_api_key", ""),
            "rerank_url": body.rerank_url.strip(),
            "rerank_model": body.rerank_model.strip(),
            "rerank_api_key": body.rerank_api_key or current.get("rerank_api_key", ""),
            "sparse_model": body.sparse_model.strip(),
            "chat_top_k": _clamp_k(body.chat_top_k),
            "search_top_k": _clamp_k(body.search_top_k),
            "candidate_top_k": _clamp_candidate_k(body.candidate_top_k),
        }
        if not cfg["enabled"]:
            settings["rag_pipeline"] = cfg
            save_settings(settings)
            _reset_rag()
            return _public(cfg)
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
        reranker = rag.test_reranker() if hasattr(rag, "test_reranker") else {"configured": False, "ok": False}
        return {"ok": True, "stats": stats, "reranker": reranker}

    @router.get("/search")
    def test_search(q: str, k: int | None = None):
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available. Check embedding, Qdrant, and dependencies.")
        settings = load_settings()
        cfg = settings.get("rag_pipeline", {}) if isinstance(settings.get("rag_pipeline"), dict) else {}
        final_k = _clamp_k(k if k is not None else cfg.get("search_top_k", 5))
        candidate_k = max(final_k, _clamp_candidate_k(cfg.get("candidate_top_k", 40)))
        results = rag.search(q, k=final_k, owner=None, candidate_k=candidate_k)
        return {
            "ok": True,
            "count": len(results),
            "results": [
                {
                    "filename": (r.get("metadata") or {}).get("filename") or (r.get("metadata") or {}).get("source") or "unknown",
                    "similarity": r.get("similarity"),
                    "rerank_score": r.get("rerank_score"),
                    "snippet": (r.get("document") or "")[:500],
                }
                for r in results
            ],
        }

    @router.get("/jobs")
    def list_rag_jobs():
        from src import rag_worker

        return {"jobs": rag_worker.list_jobs()}

    @router.get("/jobs/diagnostics")
    def rag_jobs_diagnostics():
        from src import rag_worker

        return rag_worker.diagnostics()

    @router.get("/jobs/{job_id}")
    def get_rag_job(job_id: str):
        from src import rag_worker

        job = rag_worker.get_job(job_id)
        if not job:
            raise HTTPException(404, "RAG job not found")
        return job

    @router.post("/jobs/{job_id}/cancel")
    def cancel_rag_job(job_id: str):
        from src import rag_worker

        job = rag_worker.cancel_job(job_id)
        if not job:
            raise HTTPException(404, "RAG job not found")
        return job

    @router.get("/documents")
    def list_documents():
        from src.rag_singleton import get_rag_manager, last_init_error

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            # Don't 503 — the UI shows a friendly state with the real reason.
            return {"available": False, "documents": [], "error": last_init_error()}
        return {"available": True, "documents": rag.list_documents()}

    @router.delete("/documents")
    def delete_document(source: str):
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available")
        removed = rag.delete_by_source(source)
        return {"deleted": removed > 0, "removed_count": removed, "source": source}

    return router
