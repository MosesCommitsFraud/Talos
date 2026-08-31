"""Background-task API — what the chat's task tray polls.

`src/bg_jobs.py` already owns detached shell jobs and nested agent turns, but
until now the only consumer was the monitor that re-invokes the agent when one
finishes. The UI had no way to see that anything was running: the turn ended,
the indicator went quiet, and a ten-minute build was invisible until its
follow-up landed. This exposes the same store read-only, per session.
"""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query, Request

from routes.session_routes import _verify_session_owner
from src import bg_jobs

logger = logging.getLogger(__name__)

# How much of a job's log the tray gets per poll. A tail, not the whole file:
# the panel renders a scrollback, not an archive, and a chatty build can write
# megabytes that nobody scrolls back through.
_TAIL_CHARS = 8000


def _public(rec: Dict[str, Any]) -> Dict[str, Any]:
    """The subset of a job record the browser may see.

    Deliberately not `dict(rec)`: the record carries absolute log/exit paths and
    a host pid, none of which the UI needs and all of which describe the server
    filesystem.
    """
    return {
        "id": rec.get("id"),
        "kind": rec.get("kind") or "shell",
        # For a shell job this is the command line; for an agent job the label
        # or the task's first line. Either way it is what the row is titled.
        "label": rec.get("command") or "",
        "status": rec.get("status") or "running",
        "started_at": rec.get("started_at"),
        "ended_at": rec.get("ended_at"),
        "exit_code": rec.get("exit_code"),
        "timed_out": bool(rec.get("timed_out")),
        "output": bg_jobs.output_tail(rec, _TAIL_CHARS),
    }


def setup_bg_task_routes():
    router = APIRouter(prefix="/api/bg-tasks", tags=["bg-tasks"])

    @router.get("")
    def list_tasks(request: Request, session_id: str = Query(...)):
        """Every background job belonging to `session_id`, oldest first.

        Includes finished ones: they stay in the store for an hour after their
        follow-up, and a job that failed two minutes ago is exactly what someone
        opens the tray to read.
        """
        session_id = (session_id or "").strip()
        if not session_id:
            raise HTTPException(400, "session_id is required")
        _verify_session_owner(request, session_id)
        try:
            records: List[Dict[str, Any]] = bg_jobs.list_for_session(session_id)
        except Exception as e:
            logger.warning("bg-tasks: could not read the job store: %s", e)
            records = []
        records.sort(key=lambda r: r.get("started_at") or 0)
        return {"tasks": [_public(rec) for rec in records]}

    return router
