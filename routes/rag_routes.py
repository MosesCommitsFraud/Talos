import os
from datetime import datetime
from urllib.parse import quote

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
    rerank_min_score: float = 0.30
    max_context_chars: int = 10000
    query_prefix: str = ""
    context_prompt: str = ""
    # Advanced — opt-in audio/video transcription lane (off by default).
    video_asr_enabled: bool = False
    video_asr_url: str = ""
    # ASR language: a code/name pins recognition; "auto" lets the model detect
    # (better for code-switched audio). Optional context biases domain terms.
    video_asr_language: str = "auto"
    video_asr_prompt: str = ""
    # Opt-in LLM cleanup of the ASR transcript (fixes English terms); uses the
    # ingest LLM endpoint (llm_url/llm_model).
    video_asr_correct_enabled: bool = False
    # Opt-in video keyframe lane: crop to the VLM-detected shared-desktop
    # region and index scene-change keyframes (needs vlm_url).
    video_frames_enabled: bool = False
    video_frames_interval_sec: int = 8
    video_frames_max: int = 300
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
    # Advanced — per-page VLM transcription for image-heavy PDFs (slide decks,
    # screenshots). Renders each page to an image and asks a vision model to
    # transcribe it to Markdown, so screenshot content becomes searchable text.
    pdf_vlm_enabled: bool = False
    vlm_url: str = ""
    vlm_model: str = ""
    # Advanced — redact PII (emails, phones, card/account numbers, IPs, URLs)
    # from extracted text before chunks are embedded and indexed. Off by
    # default: local deployments usually want this data searchable. Can be
    # overridden per upload (see routes/personal_routes.py upload endpoint).
    redact_pii_enabled: bool = False
    # Advanced — auto keyword/question generation per chunk (0 = off).
    auto_keywords_n: int = 0
    auto_questions_n: int = 0
    # Advanced — small-to-big: inject the matched chunk's whole section.
    expand_to_parent_enabled: bool = False
    parent_max_chars: int = 2000


class RagEndpointTest(BaseModel):
    """One endpoint probe from the settings UI. `api_key` may be empty even
    when a key is saved (keys are never echoed to the client), so the route
    falls back to the stored key for that kind."""

    kind: str
    url: str = ""
    model: str = ""
    api_key: str = ""
    dataset_id: str = ""


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


def _clamp_aux(value, default: int = 0) -> int:
    """0–20, where 0 = off (unlike _clamp_k which forces a minimum of 1)."""
    try:
        return max(0, min(int(value), 20))
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
        "rerank_min_score": _clamp_float(cfg.get("rerank_min_score", 0.30), 0.30),
        "max_context_chars": _clamp_chars(cfg.get("max_context_chars", 10000)),
        "query_prefix": cfg.get("query_prefix", ""),
        "context_prompt": cfg.get("context_prompt", ""),
        "video_asr_enabled": bool(cfg.get("video_asr_enabled", False)),
        "video_asr_url": cfg.get("video_asr_url", ""),
        "video_asr_language": cfg.get("video_asr_language", "auto") or "auto",
        "video_asr_prompt": cfg.get("video_asr_prompt", ""),
        "video_asr_correct_enabled": bool(cfg.get("video_asr_correct_enabled", False)),
        "image_pixel_enabled": bool(cfg.get("image_pixel_enabled", False)),
        "image_embed_url": cfg.get("image_embed_url", ""),
        "image_embed_model": cfg.get("image_embed_model", ""),
        "code_lane_enabled": bool(cfg.get("code_lane_enabled", False)),
        "query_rewrite_enabled": bool(cfg.get("query_rewrite_enabled", False)),
        "contextual_retrieval_enabled": bool(cfg.get("contextual_retrieval_enabled", False)),
        "llm_url": cfg.get("llm_url", ""),
        "llm_model": cfg.get("llm_model", ""),
        "pdf_vlm_enabled": bool(cfg.get("pdf_vlm_enabled", False)),
        "vlm_url": cfg.get("vlm_url", ""),
        "vlm_model": cfg.get("vlm_model", ""),
        "redact_pii_enabled": bool(cfg.get("redact_pii_enabled", False)),
        "auto_keywords_n": _clamp_aux(cfg.get("auto_keywords_n", 0)),
        "auto_questions_n": _clamp_aux(cfg.get("auto_questions_n", 0)),
        "expand_to_parent_enabled": bool(cfg.get("expand_to_parent_enabled", False)),
        "parent_max_chars": max(0, min(int(cfg.get("parent_max_chars") or 2000), 20000)),
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
            "rerank_min_score": _clamp_float(body.rerank_min_score, 0.30),
            "max_context_chars": _clamp_chars(body.max_context_chars),
            "query_prefix": body.query_prefix.strip(),
            "context_prompt": body.context_prompt.strip(),
            "video_asr_enabled": bool(body.video_asr_enabled),
            "video_asr_url": body.video_asr_url.strip(),
            "video_asr_language": (body.video_asr_language or "auto").strip(),
            "video_asr_prompt": body.video_asr_prompt.strip(),
            "video_asr_correct_enabled": bool(body.video_asr_correct_enabled),
            "image_pixel_enabled": bool(body.image_pixel_enabled),
            "image_embed_url": body.image_embed_url.strip(),
            "image_embed_model": body.image_embed_model.strip(),
            "code_lane_enabled": bool(body.code_lane_enabled),
            "query_rewrite_enabled": bool(body.query_rewrite_enabled),
            "contextual_retrieval_enabled": bool(body.contextual_retrieval_enabled),
            "llm_url": body.llm_url.strip(),
            "llm_model": body.llm_model.strip(),
            "pdf_vlm_enabled": bool(body.pdf_vlm_enabled),
            "vlm_url": body.vlm_url.strip(),
            "vlm_model": body.vlm_model.strip(),
            "redact_pii_enabled": bool(body.redact_pii_enabled),
            "auto_keywords_n": _clamp_aux(body.auto_keywords_n),
            "auto_questions_n": _clamp_aux(body.auto_questions_n),
            "expand_to_parent_enabled": bool(body.expand_to_parent_enabled),
            "parent_max_chars": max(0, min(int(body.parent_max_chars or 2000), 20000)),
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

    @router.post("/test-endpoint")
    def test_endpoint(body: RagEndpointTest):
        """Probe a single configured endpoint with the (possibly unsaved)
        values from the settings form. Each kind gets a minimal real request;
        failures surface as HTTP errors so the UI shows the actual cause."""
        import httpx

        kind = (body.kind or "").strip().lower()
        url = (body.url or "").strip()
        if not url:
            raise HTTPException(400, "URL is required")
        settings = load_settings()
        cfg = (
            settings.get("rag_pipeline", {})
            if isinstance(settings.get("rag_pipeline"), dict)
            else {}
        )
        key_field = {
            "external": "external_api_key",
            "qdrant": "qdrant_api_key",
            "rerank": "rerank_api_key",
        }.get(kind)
        api_key = (body.api_key or "").strip() or (
            str(cfg.get(key_field) or "") if key_field else ""
        )
        model = (body.model or "").strip()
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        try:
            if kind == "external":
                from src.rag_external import ExternalRagClient

                client = ExternalRagClient(
                    {
                        "external_url": url,
                        "external_api_key": api_key,
                        "external_dataset_id": (body.dataset_id or "").strip()
                        or str(cfg.get("external_dataset_id") or ""),
                    }
                )
                if not client.configured:
                    raise HTTPException(400, "External retrieval URL and dataset id are required")
                results = client.search("ping", k=1)
                return {"ok": True, "detail": f"{len(results)} result(s)"}
            if kind == "qdrant":
                r = httpx.get(
                    url.rstrip("/") + "/collections",
                    headers={"api-key": api_key} if api_key else {},
                    timeout=10,
                )
                r.raise_for_status()
                n = len((r.json().get("result") or {}).get("collections") or [])
                return {"ok": True, "detail": f"{n} collection(s)"}
            if kind in ("embedding", "image_embed"):
                r = httpx.post(
                    url, json={"model": model, "input": ["ping"]}, headers=headers, timeout=20
                )
                r.raise_for_status()
                data = r.json().get("data") or []
                dim = len((data[0] or {}).get("embedding") or []) if data else 0
                return {"ok": True, "detail": f"dim {dim}"}
            if kind == "rerank":
                r = httpx.post(
                    url,
                    json={"model": model, "query": "ping", "documents": ["ping"]},
                    headers=headers,
                    timeout=20,
                )
                r.raise_for_status()
                return {"ok": True}
            if kind in ("llm", "vlm"):
                r = httpx.post(
                    url,
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                    },
                    headers=headers,
                    timeout=30,
                )
                r.raise_for_status()
                return {"ok": True}
            if kind == "asr":
                # No sample audio to send — probe the route instead. A 4xx
                # validation error still proves the endpoint exists; only a
                # missing route or a transport/server error fails.
                r = httpx.post(url, headers=headers, timeout=10)
                if r.status_code == 404 or r.status_code >= 500:
                    raise HTTPException(503, f"ASR endpoint returned HTTP {r.status_code}")
                return {"ok": True, "detail": f"HTTP {r.status_code}"}
            raise HTTPException(400, f"Unknown endpoint kind: {kind}")
        except HTTPException:
            raise
        except httpx.HTTPStatusError as e:
            detail = (e.response.text or "")[:300]
            raise HTTPException(503, f"HTTP {e.response.status_code}: {detail}")
        except Exception as e:
            raise HTTPException(503, str(e) or e.__class__.__name__)

    @router.post("/rebuild")
    def rebuild_index():
        """Recreate the Qdrant collection (drops all vectors) AND delete the
        stored RAG uploads so no orphaned big files (videos/PDFs) linger.

        Needed after an embedding-model change alters the vector dimension — the
        `/rag` workspace exposes this as a "Rebuild index" button so the admin
        never has to touch Qdrant directly. The text + visual collections are
        recreated and every managed upload file is removed (external indexed
        directories are left untouched); re-upload to re-ingest.
        """
        _reset_rag()
        from src.rag_singleton import get_rag_manager, last_init_error

        rag = get_rag_manager()
        if not rag or not hasattr(rag, "rebuild_index"):
            from pathlib import Path

            import src.rag_singleton as _rs
            from src.rag_vector import VectorRAG

            base_dir = Path(__file__).parent.parent
            rag = VectorRAG(
                persist_directory=str(base_dir / "data" / "rag"),
                recreate_index=True,
            )
            if not getattr(rag, "healthy", False):
                detail = rag.last_error or last_init_error()
                raise HTTPException(
                    503,
                    f"RAG rebuild failed: {detail or 'check embedding, Qdrant, and dependencies.'}",
                )
            _rs.rag_instance = rag
            _rs._last_error = ""
        else:
            ok = rag.rebuild_index()
            if not ok:
                raise HTTPException(
                    503, f"Rebuild failed: {getattr(rag, 'last_error', 'unknown error')}"
                )
        # Purge the stored uploads so the rebuild is a true clean slate (no big
        # orphaned media/docs). External indexed directories are left intact.
        purged = {"removed": 0, "freed_bytes": 0}
        try:
            from routes.personal_routes import purge_managed_uploads

            purged = purge_managed_uploads()
        except Exception as e:
            import logging

            logging.getLogger(__name__).warning("upload purge failed: %s", e)
        freed_mb = round(purged.get("freed_bytes", 0) / (1024 * 1024), 1)
        return {
            "ok": True,
            "removed_files": purged.get("removed", 0),
            "freed_mb": freed_mb,
            "message": (
                f"Index recreated. Removed {purged.get('removed', 0)} uploaded file(s) "
                f"({freed_mb} MB freed). Re-upload to re-ingest."
            ),
        }

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
                    "modality": (r.get("metadata") or {}).get("modality") or "text",
                    "image_url": (r.get("metadata") or {}).get("image_url"),
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

    @router.get("/documents/chunks")
    def list_document_chunks(source: str):
        """Every indexed chunk for one source file (explorer/debug view)."""
        from src.rag_singleton import get_rag_manager, last_init_error

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            return {"available": False, "chunks": [], "error": last_init_error()}
        return {"available": True, "source": source, "chunks": rag.get_document_chunks(source)}

    @router.get("/documents/export")
    def export_document(source: str):
        """Download everything indexed for one source file as a Markdown dump.

        Ingest-quality audit: the file shows, chunk by chunk and in ``seq``
        order, exactly the text the retriever sees — including modality/page
        provenance and the embedded-but-hidden enrichment (context blurbs,
        aux terms) — so two ingests of the same document can be diffed.
        """
        from fastapi.responses import PlainTextResponse

        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available")
        chunks = rag.get_document_chunks(source)
        if not chunks:
            raise HTTPException(404, "No indexed chunks for this source")

        base = os.path.basename(source) or "document"
        lines = [
            f"# Ingest dump: {base}",
            "",
            f"- source: `{source}`",
            f"- chunks: {len(chunks)}",
            f"- exported: {datetime.now().isoformat(timespec='seconds')}",
            "",
        ]
        for c in chunks:
            meta = c.get("metadata") or {}
            prov = [f"chunk #{c.get('seq', 0)}"]
            if c.get("modality"):
                prov.append(str(c["modality"]))
            if meta.get("page"):
                prov.append(f"page {meta['page']}")
            prov.append(f"{len(c.get('content') or '')} chars")
            lines.append(f"## {' · '.join(prov)}")
            lines.append("")
            if c.get("context"):
                lines.append(f"> context: {c['context']}")
            if c.get("aux_terms"):
                lines.append(f"> aux_terms: {c['aux_terms']}")
            if c.get("context") or c.get("aux_terms"):
                lines.append("")
            lines.append(c.get("content") or "")
            lines.append("")
        # RFC 5987 filename* so non-ASCII upload names survive the header.
        fname = f"{base}.ingested.md"
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"
        }
        return PlainTextResponse(
            "\n".join(lines), media_type="text/markdown; charset=utf-8", headers=headers
        )

    class ChunkUpdate(BaseModel):
        source: str
        content: str

    @router.put("/documents/chunks/{chunk_id}")
    def update_document_chunk(chunk_id: str, body: ChunkUpdate):
        """Edit one chunk's text and re-embed it in place (same id + meta)."""
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available")
        if not body.content.strip():
            raise HTTPException(400, "Chunk content cannot be empty")
        ok = rag.update_chunk(body.source, chunk_id, body.content)
        if not ok:
            raise HTTPException(404, "Chunk not found or could not be re-embedded")
        return {"ok": True, "id": chunk_id}

    @router.delete("/documents/chunks/{chunk_id}")
    def delete_document_chunk(chunk_id: str, source: str):
        """Delete a single indexed chunk (explorer debug action)."""
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available")
        ok = rag.delete_chunk(source, chunk_id)
        if not ok:
            raise HTTPException(404, "Chunk not found")
        return {"ok": True, "id": chunk_id}

    @router.delete("/documents")
    def delete_document(source: str):
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            raise HTTPException(503, "RAG is not available")
        removed = rag.delete_by_source(source)
        # Also drop the stored upload file so deleting a document actually frees
        # disk (big videos/PDFs). Only managed uploads — never external dirs.
        file_deleted = False
        try:
            from routes.personal_routes import delete_managed_upload

            file_deleted = delete_managed_upload(source)
        except Exception as e:
            import logging

            logging.getLogger(__name__).warning("upload file cleanup failed: %s", e)
        return {
            "deleted": removed > 0,
            "removed_count": removed,
            "file_deleted": file_deleted,
            "source": source,
        }

    return router
