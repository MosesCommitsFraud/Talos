"""Runner for detached agent tasks (`background_task`).

A background task is a whole nested agent turn — "research X and write it
up", "port this module and run the tests", "build the Q3 revenue query and
sanity-check the numbers". It runs with its own round budget and its own
tool stack, entirely off the chat stream, and reports back through
src/bg_jobs.py's log/exit-file contract. From there the existing
src/bg_monitor.py picks it up and auto-continues the conversation, exactly
as it already does for detached `bash` jobs.

Why in-process (an asyncio task) rather than a detached OS process like a
shell job: the turn needs the session's endpoint, model, headers and the
whole tool stack, none of which survive a fork cheaply. The cost is that a
server restart kills it — handled honestly in bg_jobs.refresh(), which reaps
an agent job whose owner process is gone and still fires a follow-up saying
it did not finish, so the user always hears back either way.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from src import bg_jobs

logger = logging.getLogger(__name__)

# A background task is doing real work unattended, so it gets a deeper round
# budget than a follow-up continuation — but still bounded, and additionally
# wall-clock capped by the job's max_runtime_s.
_TASK_MAX_ROUNDS = 30

# How much of the task's own prose is kept as the report. The follow-up feeds
# this into the parent conversation, where it costs context, so it is capped
# well below bg_jobs' generic 16k output ceiling.
_MAX_REPORT_CHARS = 12000

_INSTRUCTIONS = """\
You are running as a BACKGROUND TASK. The user is not watching this run and \
cannot answer questions — nobody will see anything except your final message, \
which is delivered back into the conversation as your report.

Therefore:
- Do the work end to end. Use whatever tools you need.
- NEVER ask a question or wait for input; there is no one to answer. If \
something is ambiguous, choose the most reasonable interpretation, proceed, \
and note the assumption in your report.
- Your final message IS the report. Make it complete and self-contained: what \
you did, what you found, and the actual deliverable (the findings, the \
numbers, the code, the file paths you wrote). Do not refer back to earlier \
steps the reader cannot see.

The task:

"""


async def _drain(sess, messages) -> str:
    """Run the agent loop headless and return its final prose."""
    from src.agent_loop import stream_agent_loop

    full = ""
    async for chunk in stream_agent_loop(
        sess.endpoint_url,
        sess.model,
        messages,
        headers=getattr(sess, "headers", None),
        context_length=getattr(sess, "context_length", 0) or 0,
        session_id=sess.id,
        max_rounds=_TASK_MAX_ROUNDS,
        owner=getattr(sess, "owner", None),
    ):
        if not chunk.startswith("data: "):
            continue
        body = chunk[6:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            d = json.loads(body)
        except (ValueError, TypeError):
            continue
        if isinstance(d, dict) and isinstance(d.get("delta"), str):
            full += d["delta"]
    return full


async def _run(job_id: str, task: str, session_id: str) -> None:
    """Execute the task, then record its result. Never raises — every exit
    path must write a result, or the job hangs on 'running' until its
    max_runtime_s reaps it and the user waits an hour for nothing."""
    report, code = "", 0
    try:
        from src.ai_interaction import get_session_manager

        sm = get_session_manager()
        sess = sm.get_session(session_id) if sm else None
        if not sess:
            report, code = "The originating chat no longer exists.", 1
        else:
            # Seed with the conversation so far so the task inherits the
            # context it was spawned from ("summarise THAT table", "fix the
            # bug we just discussed"), then state the task itself last.
            messages = sess.get_context_messages()
            messages.append({"role": "user", "content": _INSTRUCTIONS + task})
            report = (await _drain(sess, messages)).strip()
            if not report:
                report, code = "The task produced no report.", 1
    except asyncio.CancelledError:
        # Reaped by refresh() for running past max_runtime_s. Record what we
        # can and let the follow-up explain — then re-raise so the task ends
        # as genuinely cancelled.
        bg_jobs.complete_agent(job_id, "The task was stopped before it finished.", 1)
        bg_jobs.unregister_agent_task(job_id)
        raise
    except Exception as e:
        logger.warning("background task %s failed: %s", job_id, e)
        report, code = f"The task failed with an error: {e}", 1

    if len(report) > _MAX_REPORT_CHARS:
        report = report[:_MAX_REPORT_CHARS] + "\n…[report truncated]…"
    bg_jobs.complete_agent(job_id, report, code)
    bg_jobs.unregister_agent_task(job_id)
    logger.info("background task %s finished (%d chars, exit %d)", job_id, len(report), code)


def start(
    task: str,
    session_id: str,
    label: str = "",
    max_runtime_s: Optional[int] = None,
) -> Dict[str, Any]:
    """Launch `task` as a detached agent turn. Returns the job record."""
    rec = bg_jobs.launch_agent(
        task,
        session_id,
        label=label,
        max_runtime_s=max_runtime_s or bg_jobs.DEFAULT_MAX_RUNTIME_S,
    )
    t = asyncio.create_task(_run(rec["id"], task, session_id))
    bg_jobs.register_agent_task(rec["id"], t)
    logger.info("background task %s started for session %s: %s", rec["id"], session_id, rec["command"])
    return rec
