from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.middleware import require_admin
from src.settings import load_settings, save_settings


class RagPipelineConfig(BaseModel):
    enabled: bool = True
    provider: str = "internal"
    external_url: str = ""
    external_api_key: str = ""
    external_dataset_id: str = ""
    external_top_k: int = 5
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
    similarity_threshold: float = 0.0
    rerank_min_score: float = 0.10
    max_context_chars: int = 10000
    query_prefix: str = ""
    context_prompt: str = ""
    # Advanced — opt-in audio/video transcription lane (off by default).
    video_asr_enabled: bool = False
    video_asr_url: str = ""
    # Advanced — opt-in pixel image embedding lane (off by default).
    image_pixel_enabled: bool = False
    image_embed_url: str = ""
    image_embed_model: str = ""
    # Advanced — opt-in tree-sitter AST code chunking (off by default).
    code_lane_enabled: bool = False
    # Advanced — conversation-aware query rewrite before retrieval (off by default).
    query_rewrite_enabled: bool = False
    # Advanced — ingest-time Contextual Retrieval + the LLM endpoint it uses.
    contextual_retrieval_enabled: bool = False
    llm_url: str = ""
    llm_model: str = ""


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


def _clamp_float(value, default: float, lo: float = 0.0, hi: float = 1.0) -> float:
    try:
        return round(max(lo, min(float(value), hi)), 4)
    except Exception:
        return default


def _clamp_chars(value, default: int = 10000) -> int:
    try:
        return max(500, min(int(value), 100000))
    except Exception:
        return default


def _public(cfg: dict) -> dict:
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "provider": str(cfg.get("provider") or "internal").strip().lower(),
        "external_url": cfg.get("external_url", ""),
        "external_api_key_set": bool(cfg.get("external_api_key")),
        "external_dataset_id": cfg.get("external_dataset_id", ""),
        "external_top_k": _clamp_k(cfg.get("external_top_k", 5)),
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
        "similarity_threshold": _clamp_float(cfg.get("similarity_threshold", 0.0), 0.0),
        "rerank_min_score": _clamp_float(cfg.get("rerank_min_score", 0.10), 0.10),
        "max_context_chars": _clamp_chars(cfg.get("max_context_chars", 10000)),
        "query_prefix": cfg.get("query_prefix", ""),
        "context_prompt": cfg.get("context_prompt", ""),
        "video_asr_enabled": bool(cfg.get("video_asr_enabled", False)),
        "video_asr_url": cfg.get("video_asr_url", ""),
        "image_pixel_enabled": bool(cfg.get("image_pixel_enabled", False)),
        "image_embed_url": cfg.get("image_embed_url", ""),
        "image_embed_model": cfg.get("image_embed_model", ""),
        "code_lane_enabled": bool(cfg.get("code_lane_enabled", False)),
        "query_rewrite_enabled": bool(cfg.get("query_rewrite_enabled", False)),
        "contextual_retrieval_enabled": bool(cfg.get("contextual_retrieval_enabled", False)),
        "llm_url": cfg.get("llm_url", ""),
        "llm_model": cfg.get("llm_model", ""),
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
        cfg = (
            settings.get("rag_pipeline", {})
            if isinstance(settings.get("rag_pipeline"), dict)
            else {}
        )
        return _public(cfg)

    @router.put("/config")
    def set_config(body: RagPipelineConfig):
        settings = load_settings()
        current = (
            settings.get("rag_pipeline", {})
            if isinstance(settings.get("rag_pipeline"), dict)
            else {}
        )
        cfg = {
            "enabled": bool(body.enabled),
            "provider": (body.provider or "internal").strip().lower(),
            "external_url": body.external_url.strip(),
            "external_api_key": body.external_api_key or current.get("external_api_key", ""),
            "external_dataset_id": body.external_dataset_id.strip(),
            "external_top_k": _clamp_k(body.external_top_k),
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
            "similarity_threshold": _clamp_float(body.similarity_threshold, 0.0),
            "rerank_min_score": _clamp_float(body.rerank_min_score, 0.10),
            "max_context_chars": _clamp_chars(body.max_context_chars),
            "query_prefix": body.query_prefix.strip(),
            "context_prompt": body.context_prompt.strip(),
            "video_asr_enabled": bool(body.video_asr_enabled),
            "video_asr_url": body.video_asr_url.strip(),
            "image_pixel_enabled": bool(body.image_pixel_enabled),
            "image_embed_url": body.image_embed_url.strip(),
            "image_embed_model": body.image_embed_model.strip(),
            "code_lane_enabled": bool(body.code_lane_enabled),
            "query_rewrite_enabled": bool(body.query_rewrite_enabled),
            "contextual_retrieval_enabled": bool(body.contextual_retrieval_enabled),
            "llm_url": body.llm_url.strip(),
            "llm_model": body.llm_model.strip(),
        }
        if not cfg["enabled"]:
            settings["rag_pipeline"] = cfg
            save_settings(settings)
            _reset_rag()
            return _public(cfg)
        if cfg["provider"] == "external":
            if not cfg["external_url"]:
                raise HTTPException(400, "External retrieval URL is required")
            if not cfg["external_dataset_id"]:
                raise HTTPException(400, "External dataset/knowledge-base id is required")
        else:
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
        settings = load_settings()
        cfg = (
            settings.get("rag_pipeline", {})
            if isinstance(settings.get("rag_pipeline"), dict)
            else {}
        )
        if str(cfg.get("provider") or "internal").strip().lower() == "external":
            from src.rag_external import ExternalRagClient

            client = ExternalRagClient(cfg)
            if not client.configured:
                raise HTTPException(400, "External retrieval URL and dataset id are required.")
            try:
                results = client.search("test", k=1)
            except Exception as e:
                raise HTTPException(503, f"External RAG service is not reachable: {e}")
            return {"ok": True, "provider": "external", "sample_count": len(results)}

        _reset_rag()
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(
                503, "RAG is not available. Check embedding, Qdrant, and dependencies."
            )
        stats = rag.get_stats()
        reranker = (
            rag.test_reranker()
            if hasattr(rag, "test_reranker")
            else {"configured": False, "ok": False}
        )
        return {"ok": True, "stats": stats, "reranker": reranker}

    @router.post("/rebuild")
    def rebuild_index():
        """Recreate the Qdrant collection (drops all vectors, keeps uploaded files).

        Needed after an embedding-model change alters the vector dimension — the
        `/rag` workspace exposes this as a "Rebuild index" button so the admin
        never has to touch Qdrant directly. Uploaded files persist in the uploads
        volume and can be re-ingested afterwards.
        """
        _reset_rag()
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not hasattr(rag, "rebuild_index"):
            raise HTTPException(
                503, "RAG is not available. Check embedding, Qdrant, and dependencies."
            )
        ok = rag.rebuild_index()
        if not ok:
            raise HTTPException(
                503, f"Rebuild failed: {getattr(rag, 'last_error', 'unknown error')}"
            )
        return {"ok": True, "message": "Index recreated. Re-ingest your documents."}

    @router.get("/search")
    def test_search(q: str, k: int | None = None):
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(
                503, "RAG is not available. Check embedding, Qdrant, and dependencies."
            )
        settings = load_settings()
        cfg = (
            settings.get("rag_pipeline", {})
            if isinstance(settings.get("rag_pipeline"), dict)
            else {}
        )
        final_k = _clamp_k(k if k is not None else cfg.get("search_top_k", 5))
        candidate_k = max(final_k, _clamp_candidate_k(cfg.get("candidate_top_k", 40)))
        results = rag.search(q, k=final_k, owner=None, candidate_k=candidate_k)
        return {
            "ok": True,
            "count": len(results),
            "results": [
                {
                    "filename": (r.get("metadata") or {}).get("filename")
                    or (r.get("metadata") or {}).get("source")
                    or "unknown",
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

    @router.post("/jobs/clear")
    def clear_rag_jobs():
        from src import rag_worker

        return {"removed": rag_worker.clear_jobs()}

    @router.post("/jobs/{job_id}/cancel")
    def cancel_rag_job(job_id: str):
        from src import rag_worker

        job = rag_worker.cancel_job(job_id)
        if not job:
            raise HTTPException(404, "RAG job not found")
        return job

    @router.delete("/jobs/{job_id}")
    def delete_rag_job(job_id: str):
        from src import rag_worker

        return {"deleted": rag_worker.delete_job(job_id)}

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
