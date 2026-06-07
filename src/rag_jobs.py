from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict

from core.atomic_io import atomic_write_json


_STORE = Path("data") / "rag_jobs.json"
_WORKERS_STORE = Path("data") / "rag_workers.json"
_LOCK = threading.Lock()
_WORKERS_LOCK = threading.Lock()
_WORKER: threading.Thread | None = None
_WAKE = threading.Event()
_STOP = threading.Event()
_WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"
_WORKER_TTL_S = 20


def _load() -> Dict[str, Dict[str, Any]]:
    try:
        if _STORE.exists():
            data = json.loads(_STORE.read_text(encoding="utf-8")) or {}
            if isinstance(data, dict):
                return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    except Exception:
        pass
    return {}


def _save(jobs: Dict[str, Dict[str, Any]]) -> None:
    _STORE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(str(_STORE), jobs, indent=2)


def _load_workers() -> Dict[str, Dict[str, Any]]:
    try:
        if _WORKERS_STORE.exists():
            data = json.loads(_WORKERS_STORE.read_text(encoding="utf-8")) or {}
            if isinstance(data, dict):
                return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    except Exception:
        pass
    return {}


def _save_workers(workers: Dict[str, Dict[str, Any]]) -> None:
    _WORKERS_STORE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(str(_WORKERS_STORE), workers, indent=2)


def _heartbeat(status: str = "idle", job_id: str = "") -> None:
    now = time.time()
    with _WORKERS_LOCK:
        workers = _load_workers()
        workers[_WORKER_ID] = {
            "id": _WORKER_ID,
            "hostname": socket.gethostname(),
            "pid": os.getpid(),
            "status": status,
            "job_id": job_id,
            "last_seen": now,
        }
        # Keep the file compact and avoid stale warnings from old restarts.
        workers = {k: v for k, v in workers.items() if now - float(v.get("last_seen") or 0) <= 300}
        _save_workers(workers)


def _update(job_id: str, **fields) -> Dict[str, Any]:
    with _LOCK:
        jobs = _load()
        rec = jobs.get(job_id, {"id": job_id})
        rec.update(fields)
        jobs[job_id] = rec
        _save(jobs)
        return rec


def _recover_interrupted_locked(jobs: Dict[str, Dict[str, Any]]) -> bool:
    changed = False
    for rec in jobs.values():
        status = rec.get("status")
        if status == "running":
            rec["status"] = "queued"
            rec["message"] = "Queued after server restart"
            rec["current_file"] = ""
            changed = True
        elif status == "cancelling":
            rec["status"] = "cancelled"
            rec["ended_at"] = rec.get("ended_at") or time.time()
            rec["message"] = "Cancelled during server restart"
            changed = True
    return changed


def recover_interrupted_jobs() -> None:
    with _LOCK:
        jobs = _load()
        if _recover_interrupted_locked(jobs):
            _save(jobs)


def diagnostics() -> Dict[str, Any]:
    start_worker()
    now = time.time()
    workers = list(_load_workers().values())
    active = [w for w in workers if now - float(w.get("last_seen") or 0) <= _WORKER_TTL_S]
    active.sort(key=lambda w: str(w.get("id") or ""))
    return {
        "current_worker_id": _WORKER_ID,
        "active_worker_count": len(active),
        "active_workers": active,
        "multi_worker_warning": len(active) > 1,
        "message": "Multiple active RAG workers detected" if len(active) > 1 else "Single active RAG worker",
    }


def list_jobs(limit: int = 20) -> list[Dict[str, Any]]:
    start_worker()
    jobs = list(_load().values())
    jobs.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return jobs[:limit]


def get_job(job_id: str) -> Dict[str, Any] | None:
    start_worker()
    return _load().get(job_id)


def cancel_job(job_id: str) -> Dict[str, Any] | None:
    rec = get_job(job_id)
    if not rec:
        return None
    if rec.get("status") in {"completed", "failed", "cancelled"}:
        return rec
    rec = _update(job_id, cancel_requested=True, status="cancelling")
    _WAKE.set()
    return rec


def start_worker() -> None:
    global _WORKER
    with _LOCK:
        if _WORKER and _WORKER.is_alive():
            return
        jobs = _load()
        if _recover_interrupted_locked(jobs):
            _save(jobs)
        _STOP.clear()
        _WORKER = threading.Thread(target=_worker_loop, name="rag-jobs", daemon=True)
        _WORKER.start()


def _next_job() -> Dict[str, Any] | None:
    with _LOCK:
        jobs = _load()
        queued = [r for r in jobs.values() if r.get("status") in {"queued", "cancelling"}]
        queued.sort(key=lambda r: r.get("created_at", 0))
        return dict(queued[0]) if queued else None


def _worker_loop() -> None:
    while not _STOP.is_set():
        rec = _next_job()
        if not rec:
            _heartbeat("idle")
            _WAKE.wait(5)
            _WAKE.clear()
            continue
        if rec.get("status") == "cancelling" or rec.get("cancel_requested"):
            _update(rec["id"], status="cancelled", ended_at=time.time(), message="Cancelled before start")
            continue
        if rec.get("type") == "index_directory":
            _heartbeat("running", rec["id"])
            _run_index_directory(rec["id"], rec.get("directory") or "", rec.get("owner"))
        else:
            _update(rec["id"], status="failed", ended_at=time.time(), message=f"Unknown RAG job type: {rec.get('type')}")


def start_index_directory(directory: str, owner: str | None = None) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    rec = {
        "id": job_id,
        "type": "index_directory",
        "status": "queued",
        "directory": directory,
        "owner": owner,
        "created_at": now,
        "started_at": None,
        "ended_at": None,
        "indexed_count": 0,
        "failed_count": 0,
        "current_file": "",
        "message": "Queued",
        "cancel_requested": False,
    }
    with _LOCK:
        jobs = _load()
        jobs[job_id] = rec
        _save(jobs)
    start_worker()
    _WAKE.set()
    return rec


def _run_index_directory(job_id: str, directory: str, owner: str | None) -> None:
    rec = get_job(job_id) or {}
    if rec.get("cancel_requested"):
        _update(job_id, status="cancelled", ended_at=time.time(), message="Cancelled before start")
        return
    _update(
        job_id,
        status="running",
        started_at=rec.get("started_at") or time.time(),
        ended_at=None,
        current_file="",
        message="Indexing",
    )
    try:
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag:
            _update(job_id, status="failed", ended_at=time.time(), message="RAG system is not available")
            return

        def progress(info: Dict[str, Any]) -> None:
            _heartbeat("running", job_id)
            _update(
                job_id,
                current_file=info.get("file", ""),
                indexed_count=int(info.get("indexed_count") or 0),
                failed_count=int(info.get("failed_count") or 0),
                message="Indexing",
            )

        def cancel() -> bool:
            return bool((get_job(job_id) or {}).get("cancel_requested"))

        result = rag.index_personal_documents(directory, owner=owner, progress_cb=progress, cancel_cb=cancel)
        latest = get_job(job_id) or {}
        status = "cancelled" if result.get("cancelled") or latest.get("cancel_requested") else ("completed" if result.get("success") else "failed")
        _update(
            job_id,
            status=status,
            ended_at=time.time(),
            indexed_count=int(result.get("indexed_count") or 0),
            failed_count=int(result.get("failed_count") or 0),
            message=result.get("message") or status,
        )
    except Exception as e:
        _update(job_id, status="failed", ended_at=time.time(), message=str(e))
