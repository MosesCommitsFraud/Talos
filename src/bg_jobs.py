"""Background job execution for the agent's `bash` tool and for detached
agent tasks (`background_task`).

Long commands (installs, ffmpeg, model downloads) should NOT block the chat
stream — a multi-minute held SSE connection is fragile (model-stops-early,
timeouts, tab suspend). Instead we launch them **detached** and let an
always-on monitor re-invoke the agent when they finish ("auto-continue").

Two kinds of job share that machinery:
  * ``kind="shell"``  — a detached OS process (the original case).
  * ``kind="agent"``  — a whole nested agent turn ("research X and write it
    up", "port this module and run the tests"). It runs in-process as an
    asyncio task (it needs the session's endpoint/model and the tool stack),
    and reports back through exactly the same log/exit-file contract, so
    refresh() / pending_followups() / the monitor treat both identically.
    See src/bg_agent_task.py for the runner.

Design goals:
  * Restart-safe: status is derived from an on-disk exit-code file, not a live
    PID, so a uvicorn restart never loses a job or its result.
  * Idempotent follow-up: a job stays {done, followed_up: False} until the
    agent has actually been re-invoked, so completion can never silently
    "do nothing" — the monitor retries on the next tick.
  * Bounded: a hard max-runtime marks a runaway job failed and STILL triggers
    a follow-up ("timed out"), so you always hear back.

This module only owns launch + state. The monitor / agent re-invocation lives
in the caller (so this stays import-light and unit-testable).
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.atomic_io import atomic_write_json
from core.platform_compat import (
    detached_popen_kwargs,
    find_bash,
    git_bash_path,
    kill_process_tree,
    pid_alive,
)

logger = logging.getLogger(__name__)

_DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
_JOBS_DIR = _DATA_DIR / "bg_jobs"
_STORE = _DATA_DIR / "bg_jobs.json"

# A job that runs longer than this is presumed stuck and reaped (the agent
# still gets a "timed out" follow-up so nothing hangs forever).
DEFAULT_MAX_RUNTIME_S = 3600  # 1 hour
# Cap how much captured output we keep / feed back to the model.
_MAX_OUTPUT_CHARS = 16000
# How long a finished-and-followed-up job (record + its .sh/.cmd.sh/.log/.exit
# files) is kept before pruning, so neither the store nor data/bg_jobs/ grows
# without bound. The agent has already consumed the result by then.
_RETENTION_S = 3600  # 1 hour after follow-up


def _load() -> Dict[str, Dict[str, Any]]:
    try:
        if _STORE.exists():
            data = json.loads(_STORE.read_text(encoding="utf-8")) or {}
            if not isinstance(data, dict):
                return {}
            return {str(job_id): rec for job_id, rec in data.items() if isinstance(rec, dict)}
    except Exception:
        pass
    return {}


def _save(jobs: Dict[str, Dict[str, Any]]) -> None:
    atomic_write_json(str(_STORE), jobs, indent=2)


def _pid_alive(pid: Optional[int]) -> bool:
    # Delegates to the platform-safe probe. NB: a bare os.kill(pid, 0) is unsafe
    # on Windows — CPython routes it to TerminateProcess, which would KILL the
    # job we're only trying to check. core.platform_compat.pid_alive handles
    # both OSes correctly.
    return pid_alive(pid)


def launch(
    command: str,
    session_id: str,
    cwd: Optional[str] = None,
    max_runtime_s: int = DEFAULT_MAX_RUNTIME_S,
) -> Dict[str, Any]:
    """Launch `command` detached. Returns the job record (status='running').

    Output + the final exit code are written to files so status survives a
    server restart. The process is put in its own session (setsid) so it
    outlives the request/stream that started it.
    """
    _JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    log_path = _JOBS_DIR / f"{job_id}.log"
    exit_path = _JOBS_DIR / f"{job_id}.exit"

    # The user command goes in its OWN script file, run as a child `bash`. This
    # is what isolates it: an `exit` inside it only ends that child (so the
    # wrapper still records the exit code), and — unlike textually wrapping the
    # command in `( … )` — the wrapper can't be broken by an unbalanced paren or
    # a trailing line-continuation in the command. `$?` is the child's real
    # exit status.
    bash = find_bash()
    if bash:
        # POSIX, or Windows with Git Bash/WSL. The user command goes in its OWN
        # script file, run as a child `bash` — an `exit` inside it only ends
        # that child (so the wrapper still records the exit code), and an
        # unbalanced paren / trailing line-continuation in the command can't
        # break the wrapper. `$?` is the child's real exit status. Paths are
        # emitted as POSIX (forward-slash) + shell-quoted so Git Bash on Windows
        # handles drive paths and spaces correctly.
        cmd_path = _JOBS_DIR / f"{job_id}.cmd.sh"
        cmd_path.write_text(command + "\n", encoding="utf-8")
        lp, xp, cp = (shlex.quote(git_bash_path(p)) for p in (log_path, exit_path, cmd_path))
        script_path = _JOBS_DIR / f"{job_id}.sh"
        script_path.write_text(
            f"bash {cp} > {lp} 2>&1\necho $? > {xp}\n",
            encoding="utf-8",
        )
        argv = [bash, str(script_path)]
    else:
        # Windows without any bash installed: cmd.exe wrapper. The command runs
        # in its own child .cmd so %ERRORLEVEL% is the command's real exit code.
        child_path = _JOBS_DIR / f"{job_id}.child.cmd"
        child_path.write_text("@echo off\r\n" + command + "\r\n", encoding="utf-8")
        script_path = _JOBS_DIR / f"{job_id}.cmd"
        script_path.write_text(
            "@echo off\r\n"
            f'call "{child_path}" > "{log_path}" 2>&1\r\n'
            f'echo %ERRORLEVEL%> "{exit_path}"\r\n',
            encoding="utf-8",
        )
        argv = [os.environ.get("ComSpec", "cmd.exe"), "/c", str(script_path)]

    proc = subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        cwd=cwd or None,
        **detached_popen_kwargs(),  # detach from the request lifecycle (setsid / DETACHED_PROCESS)
    )

    rec = {
        "id": job_id,
        "session_id": session_id,
        "kind": "shell",
        "command": command,
        "status": "running",  # running | done | failed
        "pid": proc.pid,
        "started_at": time.time(),
        "ended_at": None,
        "exit_code": None,
        "max_runtime_s": max_runtime_s,
        "followed_up": False,  # has the agent been re-invoked with the result?
        "log_path": str(log_path),
        "exit_path": str(exit_path),
    }
    jobs = _load()
    jobs[job_id] = rec
    _save(jobs)
    return rec


def launch_agent(
    task: str,
    session_id: str,
    label: str = "",
    max_runtime_s: int = DEFAULT_MAX_RUNTIME_S,
) -> Dict[str, Any]:
    """Register an ``kind="agent"`` job and return its record (status='running').

    State only — the caller (src/bg_agent_task.py) starts the actual nested
    agent turn and calls complete_agent() when it finishes. The record uses
    the same log/exit-file contract as a shell job so refresh() needs no
    special case for completion.

    ``owner_pid`` is what makes this restart-safe: an agent job lives in THIS
    process's event loop, so if the store is later read by a process with a
    different pid, that job can never finish and is reaped as failed (the
    user still gets a follow-up saying so) instead of hanging on 'running'
    forever.
    """
    _JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    rec = {
        "id": job_id,
        "session_id": session_id,
        "kind": "agent",
        "command": (label or task.strip().split("\n")[0])[:200],
        "task": task,
        "status": "running",
        "pid": None,  # in-process asyncio task, not an OS process
        "owner_pid": os.getpid(),
        "started_at": time.time(),
        "ended_at": None,
        "exit_code": None,
        "max_runtime_s": max_runtime_s,
        "followed_up": False,
        "log_path": str(_JOBS_DIR / f"{job_id}.log"),
        "exit_path": str(_JOBS_DIR / f"{job_id}.exit"),
    }
    jobs = _load()
    jobs[job_id] = rec
    _save(jobs)
    return rec


def complete_agent(job_id: str, report: str, exit_code: int = 0) -> None:
    """Record an agent job's result. Writes the same log/exit files a shell
    job produces, so refresh() reconciles it through the identical path.

    Writing the log BEFORE the exit file matters: refresh() treats the exit
    file as the completion signal, so the reverse order would let the monitor
    observe a finished job whose output is still empty.
    """
    rec = _load().get(job_id)
    if not rec:
        logger.warning("complete_agent: unknown job %s", job_id)
        return
    try:
        Path(rec["log_path"]).write_text(report or "", encoding="utf-8")
    except Exception as e:
        logger.warning("complete_agent: could not write log for %s: %s", job_id, e)
    try:
        Path(rec["exit_path"]).write_text(str(int(exit_code)), encoding="utf-8")
    except Exception as e:
        logger.warning("complete_agent: could not write exit file for %s: %s", job_id, e)


def _read_output(rec: Dict[str, Any]) -> str:
    try:
        txt = Path(rec["log_path"]).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    if len(txt) > _MAX_OUTPUT_CHARS:
        # Keep head + tail — the interesting bits are usually at both ends.
        head = txt[: _MAX_OUTPUT_CHARS // 2]
        tail = txt[-_MAX_OUTPUT_CHARS // 2 :]
        txt = head + "\n…[truncated]…\n" + tail
    return txt


def _prune(jobs: Dict[str, Dict[str, Any]], now: float) -> bool:
    """Drop records (and their on-disk files) for jobs that finished, were
    followed up, and are older than the retention window. Mutates `jobs`."""
    stale = [
        jid
        for jid, rec in jobs.items()
        if rec.get("followed_up") and rec.get("ended_at") and (now - rec["ended_at"]) > _RETENTION_S
    ]
    for jid in stale:
        jobs.pop(jid, None)
        for p in _JOBS_DIR.glob(f"{jid}.*"):  # .sh .cmd.sh .log .exit
            try:
                p.unlink()
            except Exception:
                pass
    return bool(stale)


def refresh() -> Dict[str, Dict[str, Any]]:
    """Reconcile every running job against disk. Marks done/failed (incl.
    timeout). Idempotent — safe to call from a poll loop. Returns the store."""
    jobs = _load()
    changed = False
    now = time.time()
    for rec in jobs.values():
        if rec.get("status") != "running":
            continue
        exit_path = Path(rec.get("exit_path", ""))
        if exit_path.exists():
            try:
                code = int(exit_path.read_text(encoding="utf-8", errors="replace").strip() or "1")
            except Exception:
                code = 1
            rec["exit_code"] = code
            rec["status"] = "done" if code == 0 else "failed"
            rec["ended_at"] = now
            changed = True
        elif (now - rec.get("started_at", now)) > rec.get("max_runtime_s", DEFAULT_MAX_RUNTIME_S):
            # Runaway / stuck — reap it but STILL surface a follow-up.
            if rec.get("kind") == "agent":
                _cancel_agent(rec["id"])
            else:
                _kill(rec.get("pid"))
            rec["status"] = "failed"
            rec["exit_code"] = -1
            rec["ended_at"] = now
            rec["timed_out"] = True
            changed = True
        elif rec.get("kind") == "agent":
            # An agent job has no OS process to probe — it lives in the event
            # loop of the process that launched it. If that process is gone
            # (server restart, crash), nothing will ever write its exit file,
            # so reap it now rather than leave it 'running' forever. A live
            # job in THIS process is simply left alone until it completes.
            if rec.get("owner_pid") != os.getpid():
                rec["status"] = "failed"
                rec["exit_code"] = -1
                rec["ended_at"] = now
                rec["died"] = True
                rec["restarted"] = True
                changed = True
        elif not _pid_alive(rec.get("pid")) and not exit_path.exists():
            # Process vanished without writing an exit code (killed, OOM,
            # crash). Don't leave it "running" forever.
            rec["status"] = "failed"
            rec["exit_code"] = -1
            rec["ended_at"] = now
            rec["died"] = True
            changed = True
    if _prune(jobs, now):
        changed = True
    if changed:
        _save(jobs)
    return jobs


def _kill(pid: Optional[int]) -> None:
    # Cross-platform process-tree teardown (POSIX killpg / Windows taskkill /T).
    kill_process_tree(pid)


# Live agent-job asyncio tasks, by job id. Only populated in the process that
# launched them; used to actually stop a runaway job when refresh() reaps it.
_agent_tasks: Dict[str, Any] = {}


def register_agent_task(job_id: str, task: Any) -> None:
    _agent_tasks[job_id] = task


def unregister_agent_task(job_id: str) -> None:
    _agent_tasks.pop(job_id, None)


def _cancel_agent(job_id: str) -> None:
    task = _agent_tasks.pop(job_id, None)
    if task is not None and not task.done():
        task.cancel()


def pending_followups() -> List[Dict[str, Any]]:
    """Finished jobs the agent hasn't been re-invoked for yet. The monitor
    drains these; mark_followed_up() flips the flag only on success."""
    jobs = refresh()
    return [
        r
        for r in jobs.values()
        if r.get("status") in ("done", "failed") and not r.get("followed_up")
    ]


def mark_followed_up(job_id: str) -> None:
    jobs = _load()
    if job_id in jobs:
        jobs[job_id]["followed_up"] = True
        _save(jobs)


def get(job_id: str) -> Optional[Dict[str, Any]]:
    refresh()  # reconcile against disk so status/exit_code are current
    rec = _load().get(job_id)
    if rec:
        rec = dict(rec)
        rec["output"] = _read_output(rec)
    return rec


def list_for_session(session_id: str) -> List[Dict[str, Any]]:
    return [r for r in refresh().values() if r.get("session_id") == session_id]


def result_text(rec: Dict[str, Any]) -> str:
    """Human/agent-readable summary of a finished job, for the follow-up."""
    out = _read_output(rec)
    if rec.get("kind") == "agent":
        # An agent job's "output" is a written report, not a command's stdout;
        # exit codes and stderr framing would only mislead the reading model.
        if rec.get("timed_out"):
            head = (
                f"Background task ran past its {rec.get('max_runtime_s')}s limit and was stopped."
            )
        elif rec.get("restarted"):
            head = "Background task was lost when the server restarted and did not finish."
        elif rec.get("status") == "failed":
            head = "Background task failed."
        else:
            head = "Background task finished."
        return f"{head}\nTask: {rec.get('task') or rec.get('command')}\n\nReport:\n{out or '(no report)'}"
    if rec.get("timed_out"):
        head = f"Background job timed out after {rec.get('max_runtime_s')}s."
    elif rec.get("died"):
        head = "Background job process died unexpectedly (no exit code)."
    else:
        head = f"Background job finished with exit code {rec.get('exit_code')}."
    return f"{head}\nCommand: {rec.get('command')}\n\nOutput:\n{out or '(no output)'}"
