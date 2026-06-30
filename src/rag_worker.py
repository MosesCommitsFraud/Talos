"""
rag_worker.py

Redis/RQ-backed async ingest for the RAG pipeline. Replaces the in-process
thread worker (``src/rag_jobs.py``).

The FastAPI app *enqueues* jobs (``start_index_directory`` / ``start_index_files``)
onto the ``ingest`` queue and reads their status back through the RQ job
registries. A **separate** ``rag-ingest-worker`` container actually runs the
jobs (``rq worker ingest``), so heavy Docling/embedding work never blocks the
web process.

Because the worker is a different process (and may not share the app DB), each
enqueued job carries a *snapshot* of the UI-configured ``rag_pipeline`` settings
(endpoints + model names). The job applies that snapshot to its env before
building the RAG manager — so the models entered in the UI are exactly what the
worker uses, with no hardcoding.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

QUEUE_NAME = "ingest"
_JOB_TIMEOUT = int(os.getenv("RAG_INGEST_JOB_TIMEOUT", "86400"))  # long ingests allowed

# Settings-key → env-var, mirrors ``rag_vector._apply_saved_rag_config`` so the
# worker resolves the same endpoints/models the admin set in the UI.
_ENV_MAP = {
    "embedding_url": "EMBEDDING_URL",
    "embedding_model": "EMBEDDING_MODEL",
    "qdrant_url": "QDRANT_URL",
    "qdrant_api_key": "QDRANT_API_KEY",
    "rerank_url": "RERANK_URL",
    "rerank_model": "RERANK_MODEL",
    "rerank_api_key": "RERANK_API_KEY",
    "sparse_model": "RAG_SPARSE_MODEL",
    # The Qwen instruction prefix is applied to the dense *query* at search time;
    # the worker must resolve it too so ingest and retrieval agree on it.
    "query_prefix": "RAG_QUERY_PREFIX",
    # Opt-in ASR lane endpoint (the toggle is applied separately, below).
    "video_asr_url": "VIDEO_ASR_URL",
    # Opt-in pixel image-embedding lane (toggle applied separately, below).
    "image_embed_url": "IMAGE_EMBED_URL",
    "image_embed_model": "IMAGE_EMBED_MODEL",
    # Ingest-time LLM for Contextual Retrieval (toggle applied separately, below).
    "llm_url": "RAG_LLM_URL",
    "llm_model": "RAG_LLM_MODEL",
    # Per-page VLM transcription endpoint for image-heavy PDFs (toggle below).
    "vlm_url": "VLM_URL",
    "vlm_model": "VLM_MODEL",
}

_STATUS_MAP = {
    "queued": "queued",
    "deferred": "queued",
    "scheduled": "queued",
    "started": "running",
    "finished": "completed",
    "failed": "failed",
    "stopped": "cancelled",
    "canceled": "cancelled",
}


# ---------------------------------------------------------------------------
# Redis / queue plumbing
# ---------------------------------------------------------------------------


def _redis():
    from redis import Redis

    return Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))


def _queue():
    from rq import Queue

    return Queue(QUEUE_NAME, connection=_redis())


def _snapshot() -> Dict[str, Any]:
    """Capture the current UI-configured RAG settings to hand to the worker."""
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _apply_snapshot(snap: Optional[Dict[str, Any]]) -> None:
    if not isinstance(snap, dict):
        return
    for key, env_name in _ENV_MAP.items():
        value = str(snap.get(key) or "").strip()
        if value:
            os.environ[env_name] = value
    # Boolean toggles set explicitly so a disabled snapshot clears any stale value.
    os.environ["VIDEO_ASR_ENABLED"] = "true" if snap.get("video_asr_enabled") else ""
    os.environ["IMAGE_PIXEL_ENABLED"] = "true" if snap.get("image_pixel_enabled") else ""
    os.environ["CODE_LANE_ENABLED"] = "true" if snap.get("code_lane_enabled") else ""
    os.environ["CONTEXTUAL_RETRIEVAL_ENABLED"] = (
        "true" if snap.get("contextual_retrieval_enabled") else ""
    )
    os.environ["RAG_AUTO_KEYWORDS_N"] = str(int(snap.get("auto_keywords_n") or 0))
    os.environ["RAG_AUTO_QUESTIONS_N"] = str(int(snap.get("auto_questions_n") or 0))
    os.environ["PDF_VLM_ENABLED"] = "true" if snap.get("pdf_vlm_enabled") else ""


def _fresh_rag():
    """Reset and rebuild the RAG singleton inside the worker process.

    Raises with the *actual* init failure (missing deps / Qdrant unreachable /
    embedding endpoint down) so the reason shows up in the job's error instead
    of a generic "RAG not available".
    """
    import src.rag_singleton as rs

    rs.rag_instance = None
    rs._last_attempt = 0
    rag = rs.get_rag_manager()
    if rag is None:
        raise RuntimeError(
            rs.last_init_error() or "RAG system is not available (check Qdrant / embedding config)"
        )
    return rag


# ---------------------------------------------------------------------------
# RQ tasks (executed inside the rag-ingest-worker container)
# ---------------------------------------------------------------------------


def _progress_saver(job):
    def progress(info: Dict[str, Any]) -> None:
        if not job:
            return
        job.meta.update(
            {
                "indexed_count": int(info.get("indexed_count") or 0),
                "failed_count": int(info.get("failed_count") or 0),
                "processed_count": int(info.get("processed") or 0),
                "total_count": int(info.get("total") or 0),
                # Sub-progress within the current file (VLM lanes: pages/images),
                # so the queue advances during a single large document.
                "sub_done": int(info.get("sub_done") or 0),
                "sub_total": int(info.get("sub_total") or 0),
                "current_file": info.get("file", ""),
                "errors": (info.get("errors") or [])[-10:],
                "message": "Indexing",
            }
        )
        try:
            job.save_meta()
        except Exception:
            pass

    return progress


def _finalize(job, result: Dict[str, Any]) -> None:
    if not job:
        return
    errors = (result.get("errors") or [])[-10:]
    message = result.get("message") or "Done"
    # Surface the first file error in the headline message so the queue row
    # shows *why* something failed without needing the worker logs.
    if errors:
        first = errors[0]
        message = f"{message} — {first.get('file', '')}: {first.get('error', '')}"
    total = int(result.get("total") or 0)
    job.meta.update(
        {
            "indexed_count": int(result.get("indexed_count") or 0),
            "failed_count": int(result.get("failed_count") or 0),
            # On success processed == total; carry both so the bar lands at 100%.
            "processed_count": int(result.get("processed") or total),
            "total_count": total,
            "sub_done": 0,
            "sub_total": 0,
            "current_file": "",
            "errors": errors,
            "message": message,
        }
    )
    try:
        job.save_meta()
    except Exception:
        pass


def ingest_directory_job(
    directory: str, owner: Optional[str], config_snapshot: Dict[str, Any]
) -> Dict[str, Any]:
    from rq import get_current_job

    _apply_snapshot(config_snapshot)
    job = get_current_job()
    rag = _fresh_rag()
    if not rag:
        raise RuntimeError("RAG system is not available (check Qdrant / embedding config)")
    result = rag.index_personal_documents(directory, owner=owner, progress_cb=_progress_saver(job))
    _finalize(job, result)
    return result


def ingest_files_job(
    files: List[Tuple[str, Dict[str, Any]]], config_snapshot: Dict[str, Any]
) -> Dict[str, Any]:
    from rq import get_current_job

    _apply_snapshot(config_snapshot)
    job = get_current_job()
    rag = _fresh_rag()
    if not rag:
        raise RuntimeError("RAG system is not available (check Qdrant / embedding config)")
    result = rag.index_files([(p, m) for p, m in files], progress_cb=_progress_saver(job))
    _finalize(job, result)
    return result


# ---------------------------------------------------------------------------
# Enqueue helpers (called by the FastAPI app)
# ---------------------------------------------------------------------------


def start_index_directory(directory: str, owner: Optional[str] = None) -> Dict[str, Any]:
    job = _queue().enqueue(
        "src.rag_worker.ingest_directory_job",
        directory,
        owner,
        _snapshot(),
        job_timeout=_JOB_TIMEOUT,
        meta={
            "type": "index_directory",
            "directory": directory,
            "owner": owner,
            "indexed_count": 0,
            "failed_count": 0,
            "current_file": "",
            "message": "Queued",
        },
    )
    return _job_to_dict(job)


def start_index_files(
    files: List[Tuple[str, Dict[str, Any]]], owner: Optional[str] = None
) -> Dict[str, Any]:
    job = _queue().enqueue(
        "src.rag_worker.ingest_files_job",
        list(files),
        _snapshot(),
        job_timeout=_JOB_TIMEOUT,
        meta={
            "type": "index_files",
            "directory": "",
            "owner": owner,
            "file_count": len(files),
            "indexed_count": 0,
            "failed_count": 0,
            "current_file": "",
            "message": "Queued",
        },
    )
    return _job_to_dict(job)


# ---------------------------------------------------------------------------
# Status / control (read by routes/rag_routes.py)
# ---------------------------------------------------------------------------


def _ts(dt) -> Optional[float]:
    return dt.timestamp() if dt else None


def _job_to_dict(job) -> Dict[str, Any]:
    try:
        status = job.get_status(refresh=True)
    except Exception:
        status = job.get_status()
    meta = job.meta or {}
    mapped = _STATUS_MAP.get(status, status)
    message = meta.get("message") or mapped
    if mapped == "failed" and job.exc_info:
        message = (job.exc_info.strip().splitlines() or [message])[-1]
    return {
        "id": job.id,
        "type": meta.get("type", "index_directory"),
        "status": mapped,
        "directory": meta.get("directory", ""),
        "owner": meta.get("owner"),
        "indexed_count": int(meta.get("indexed_count") or 0),
        "failed_count": int(meta.get("failed_count") or 0),
        # Files done / total (uploads carry a known total → a real % bar; dir
        # ingest has no upfront total → the UI shows an indeterminate state).
        "processed_count": int(meta.get("processed_count") or 0),
        "total_count": int(meta.get("total_count") or meta.get("file_count") or 0),
        "current_file": meta.get("current_file", ""),
        "message": message,
        "errors": meta.get("errors", []),
        "created_at": _ts(job.enqueued_at),
        "started_at": _ts(job.started_at),
        "ended_at": _ts(job.ended_at),
    }


def list_jobs(limit: int = 20) -> List[Dict[str, Any]]:
    try:
        from rq.job import Job
        from rq.registry import FailedJobRegistry, FinishedJobRegistry, StartedJobRegistry

        q = _queue()
        conn = q.connection
        ids: List[str] = list(q.get_job_ids())
        for reg_cls in (StartedJobRegistry, FinishedJobRegistry, FailedJobRegistry):
            try:
                ids.extend(reg_cls(queue=q).get_job_ids())
            except Exception:
                pass
        seen: set = set()
        jobs: List[Dict[str, Any]] = []
        for jid in ids:
            if jid in seen:
                continue
            seen.add(jid)
            try:
                jobs.append(_job_to_dict(Job.fetch(jid, connection=conn)))
            except Exception:
                continue
        jobs.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
        return jobs[:limit]
    except Exception as e:
        logger.warning("rag_worker.list_jobs failed: %s", e)
        return []


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        from rq.job import Job

        return _job_to_dict(Job.fetch(job_id, connection=_redis()))
    except Exception:
        return None


def cancel_job(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        from rq.job import Job

        conn = _redis()
        job = Job.fetch(job_id, connection=conn)
    except Exception:
        return None
    try:
        if job.get_status() == "started":
            from rq.command import send_stop_job_command

            send_stop_job_command(conn, job_id)
        else:
            job.cancel()
    except Exception as e:
        logger.warning("cancel_job %s failed: %s", job_id, e)
    try:
        job.meta["message"] = "Cancellation requested"
        job.save_meta()
    except Exception:
        pass
    return _job_to_dict(job)


def delete_job(job_id: str) -> bool:
    """Remove a single job (any state) from Redis + its registry."""
    try:
        from rq.job import Job

        Job.fetch(job_id, connection=_redis()).delete()
        return True
    except Exception as e:
        logger.warning("delete_job %s failed: %s", job_id, e)
        return False


def clear_jobs() -> int:
    """Drop all finished + failed jobs (keeps queued/running). Returns count."""
    removed = 0
    try:
        from rq.job import Job
        from rq.registry import FailedJobRegistry, FinishedJobRegistry

        q = _queue()
        conn = q.connection
        for reg in (FailedJobRegistry(queue=q), FinishedJobRegistry(queue=q)):
            for jid in list(reg.get_job_ids()):
                try:
                    Job.fetch(jid, connection=conn).delete()
                    removed += 1
                except Exception:
                    try:
                        reg.remove(jid, delete_job=True)
                        removed += 1
                    except Exception:
                        pass
    except Exception as e:
        logger.warning("clear_jobs failed: %s", e)
    return removed


def diagnostics() -> Dict[str, Any]:
    try:
        from rq import Worker

        conn = _redis()
        ingest_workers = [w for w in Worker.all(connection=conn) if QUEUE_NAME in w.queue_names()]
        count = len(ingest_workers)
        if count == 0:
            message = "No ingest worker running — start the rag-ingest-worker container"
        elif count > 1:
            message = "Multiple active ingest workers detected"
        else:
            message = "Single active ingest worker"
        return {
            "active_worker_count": count,
            "active_workers": [w.name for w in ingest_workers],
            "multi_worker_warning": count > 1,
            "message": message,
        }
    except Exception as e:
        return {
            "active_worker_count": 0,
            "active_workers": [],
            "multi_worker_warning": False,
            "message": f"Redis unavailable: {e}",
        }
