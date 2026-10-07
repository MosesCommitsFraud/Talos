"""subagents.py — `delegate`: parallel helper agents inside one turn.

A question like "compare what the three manuals say about X" or "go through
the workshop recording and list every configuration step" is several
independent pieces of reading. Doing them one after another in the main turn
is slow, and it fills the main context with raw document text the answer only
needs a digest of. So the agent can hand each piece to a *subagent*:

* every subagent is a full nested agent turn (``stream_agent_loop``) with a
  fresh, small context — just its assignment, no chat history;
* it runs with a read-only tool allowlist (knowledge base, web, read-only SQL)
  and without ``delegate`` itself, so it cannot fan out further;
* reasoning is off or low by default (``subagent_reasoning``) — these are
  reading/extraction jobs, and on a DGX Spark a thinking pass per subagent
  costs more wall-clock than the parallelism saves;
* several run at once (``subagent_parallelism``, default 3 — vLLM batches the
  requests, decode bandwidth is the limit);
* each registers as a ``kind="subagent"`` background job and writes its live
  step list and prose there, which is what the task tray beside the working
  indicator shows ("Aufgaben laufen" → side panel);
* the delegating tool call waits for all of them and returns their reports.

Subagents run under the parent's session id. Their knowledge/web citations are
therefore numbered in the parent turn's citation table, so a ``[3]`` in a
report is the same ``[3]`` the main answer can cite.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_TASKS = 6
_REPORT_CHARS = 8000
_LIVE_WRITE_S = 0.8
_STEP_COMMAND_CHARS = 300

# What a subagent may use. Read-only by construction: it can look things up
# but never write files, run code, change settings, ask the user or delegate.
SUBAGENT_TOOLS = frozenset(
    {
        "search_knowledge",
        "list_knowledge",
        "read_knowledge",
        "grep_knowledge",
        "web_search",
        "web_fetch",
        "get_news",
        "query_sql",
        "expand_output",
    }
)

_INSTRUCTIONS = """\
You are a SUBAGENT: a helper the main assistant gave one specific assignment. \
Nobody reads your intermediate steps and nobody can answer questions — your \
final message is returned to the main assistant as your report.

- Do the assignment completely with your tools, then stop. Stay inside its scope.
- Your tools are read-only lookups (knowledge base, web, database). Prefer \
reading the relevant document sections in full over guessing from snippets.
- Report only what your sources actually say. Keep the [n] citation numbers of \
the sources exactly as shown, right after each claim. Say plainly what you \
could not find.
- Write the report as a compact, self-contained result (facts, steps, figures, \
quotes where the wording matters) — no preamble, no questions back.

Assignment:

"""

# Set by stream_agent_loop for the turn it runs, so the delegate tool can
# start subagents against the same endpoint, model and modes. Tool tasks the
# loop spawns inherit it.
_turn: ContextVar[Optional[Dict[str, Any]]] = ContextVar("subagent_turn", default=None)


def set_turn_context(ctx: Optional[Dict[str, Any]]) -> None:
    _turn.set(ctx)


# Subagents of this process that have not finished yet (queued or running),
# the asyncio task of each running one, and those the user stopped from the
# task tray. Process-local by nature: the runs live in this event loop.
_pending: set = set()
_live: Dict[str, asyncio.Task] = {}
_user_stopped: set = set()


def _forget(job_id: str) -> None:
    _pending.discard(job_id)
    _live.pop(job_id, None)
    _user_stopped.discard(job_id)


def stop(job_id: str) -> bool:
    """Stop one subagent (tray button). Its siblings and the delegating turn
    carry on; the turn receives whatever this one had written so far, marked
    as stopped. False when the job is not an unfinished subagent of this
    process."""
    if job_id not in _pending:
        return False
    _user_stopped.add(job_id)
    task = _live.get(job_id)
    if task is not None and not task.done():
        task.cancel()
    return True


def _setting(key: str, default: Any) -> Any:
    try:
        from src.settings import get_setting

        value = get_setting(key, default)
        return default if value is None else value
    except Exception:
        return default


def enabled() -> bool:
    return bool(_setting("subagents_enabled", True))


def _reasoning() -> Dict[str, Any]:
    mode = str(_setting("subagent_reasoning", "off") or "off").strip().lower()
    if mode in ("off", "none", "false", "0", ""):
        return {"reasoning": False, "reasoning_effort": None}
    if mode in ("low", "medium", "high"):
        return {"reasoning": True, "reasoning_effort": mode}
    return {"reasoning": True, "reasoning_effort": None}


def _int_setting(key: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(_setting(key, default))))
    except (TypeError, ValueError):
        return default


def parse_tasks(content: str) -> List[Dict[str, str]]:
    """``{"tasks": [{"title": ..., "prompt": ...}, ...]}`` → normalized list."""
    try:
        args = json.loads(content) if isinstance(content, str) and content.strip() else content
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON arguments: {e}")
    if isinstance(args, list):
        args = {"tasks": args}
    if not isinstance(args, dict):
        raise ValueError('Pass {"tasks": [{"title": "...", "prompt": "..."}]}.')
    raw = args.get("tasks")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise ValueError('`tasks` must be a non-empty list of {"title", "prompt"} objects.')
    out = []
    for item in raw:
        if isinstance(item, str):
            item = {"prompt": item}
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or item.get("task") or item.get("description") or "")
        prompt = prompt.strip()
        if not prompt:
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        out.append({"title": (title or prompt.split("\n")[0])[:120], "prompt": prompt})
    if not out:
        raise ValueError("Every task needs a `prompt` describing what to do.")
    if len(out) > MAX_TASKS:
        raise ValueError(f"At most {MAX_TASKS} tasks per call; group the rest or call again.")
    return out


class _Run:
    """One subagent: its job record, live steps and collected output."""

    def __init__(self, rec: Dict[str, Any], title: str):
        self.rec = rec
        self.title = title
        self.text = ""
        self.steps: List[Dict[str, Any]] = []
        self.sources: List[Dict[str, Any]] = []
        self.stopped = False
        self._last_write = 0.0

    def flush(self, force: bool = False) -> None:
        from src import bg_jobs

        now = time.monotonic()
        if force or now - self._last_write >= _LIVE_WRITE_S:
            self._last_write = now
            bg_jobs.write_live(self.rec, self.text, self.steps)

    def on_event(self, data: Dict[str, Any]) -> None:
        if isinstance(data.get("delta"), str):
            if data.get("thinking"):
                return
            self.text += data["delta"]
            self.flush()
            return
        kind = data.get("type")
        if kind == "tool_start":
            self.steps.append(
                {
                    "tool": str(data.get("tool") or ""),
                    "command": str(data.get("command") or "")[:_STEP_COMMAND_CHARS],
                    "status": "running",
                    "at": time.time(),
                }
            )
            self.flush(force=True)
        elif kind == "tool_output":
            for step in reversed(self.steps):
                if step["status"] == "running":
                    step["status"] = "done" if (data.get("exit_code") or 0) == 0 else "error"
                    break
            self.flush(force=True)
        elif kind == "rag_sources_partial" and isinstance(data.get("data"), list):
            self.sources.extend(s for s in data["data"] if isinstance(s, dict))
        elif kind == "agent_step":
            # A new round: the prose so far was a preamble to tool calls; keep
            # it visible in the tray but separate it from what follows.
            if self.text and not self.text.endswith("\n\n"):
                self.text += "\n\n"


async def _run_one(run: _Run, prompt: str, ctx: Dict[str, Any]) -> int:
    from src.agent_loop import stream_agent_loop

    messages = [{"role": "user", "content": _INSTRUCTIONS + prompt}]
    max_rounds = _int_setting("subagent_max_rounds", 12, 2, 40)
    async for chunk in stream_agent_loop(
        ctx["endpoint_url"],
        ctx["model"],
        messages,
        headers=ctx.get("headers"),
        context_length=ctx.get("context_length") or 0,
        max_rounds=max_rounds,
        max_tokens=ctx.get("max_tokens") or 4096,
        session_id=ctx.get("session_id"),
        disabled_tools=set(ctx.get("disabled_tools") or ()),
        owner=ctx.get("owner"),
        fallbacks=ctx.get("fallbacks"),
        force_db=bool(ctx.get("force_db")),
        use_rag=bool(ctx.get("use_rag")),
        tool_allowlist=SUBAGENT_TOOLS,
        subagent=True,
        **_reasoning(),
    ):
        if not chunk.startswith("data: "):
            continue
        body = chunk[6:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            run.on_event(data)
    return 0 if run.text.strip() else 1


async def run_tasks(
    content: str,
    session_id: Optional[str],
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Dict[str, Any]:
    """Executor entry point for `delegate`."""
    from src import bg_jobs

    if not enabled():
        return {"error": "Subagents are switched off in the settings.", "exit_code": 1}
    ctx = _turn.get()
    if not ctx or not ctx.get("endpoint_url") or not session_id:
        return {"error": "delegate is only available inside a chat turn.", "exit_code": 1}
    if ctx.get("subagent"):
        return {"error": "Subagents cannot delegate further.", "exit_code": 1}
    try:
        tasks = parse_tasks(content)
    except ValueError as e:
        return {"error": str(e), "exit_code": 1}

    group = f"g{int(time.time() * 1000)}"
    runs: List[_Run] = []
    runtime = _int_setting("subagent_max_runtime_s", 900, 60, 3600)
    for task in tasks:
        rec = bg_jobs.launch_agent(
            task["prompt"],
            session_id,
            label=task["title"],
            # The run enforces `runtime` itself (wait_for below). The store's
            # reaper gets a margin on top, so it only ever catches a job whose
            # process died — reaping a live one would cancel the whole call.
            max_runtime_s=runtime + 300,
            kind="subagent",
            extra={"group": group},
        )
        runs.append(_Run(rec, task["title"]))
        _pending.add(rec["id"])

    sem = asyncio.Semaphore(_int_setting("subagent_parallelism", 3, 1, MAX_TASKS))
    finished = 0

    async def _guarded(run: _Run, prompt: str) -> int:
        nonlocal finished
        job_id = run.rec["id"]
        code = 1
        inner: Optional[asyncio.Task] = None
        try:
            async with sem:
                if job_id in _user_stopped:
                    # Stopped from the tray while still queued: never start it.
                    run.text = "[Stopped by the user before it started.]"
                else:
                    run.flush(force=True)
                    # Its own task, so the tray can stop THIS subagent (stop())
                    # without cancelling the delegate call and its siblings.
                    inner = asyncio.create_task(
                        asyncio.wait_for(_run_one(run, prompt, ctx), timeout=runtime)
                    )
                    _live[job_id] = inner
                    code = await inner
        except asyncio.TimeoutError:
            run.text = (run.text + f"\n\n[Stopped after the {runtime}s time limit.]").strip()
            code = 1
        except asyncio.CancelledError:
            if job_id in _user_stopped and inner is not None and inner.cancelled():
                run.text = (run.text + "\n\n[Stopped by the user.]").strip()
                code = 1
            else:
                # The delegating turn was stopped: end the run, record it, and
                # let the cancellation propagate.
                if inner is not None:
                    inner.cancel()
                run.text = (run.text + "\n\n[Stopped before it finished.]").strip()
                bg_jobs.complete_agent(job_id, run.text, 1)
                _forget(job_id)
                raise
        except Exception as e:
            logger.warning("subagent %s failed: %s", job_id, e)
            run.text = (run.text + f"\n\n[Failed: {e}]").strip()
            code = 1
        stopped = job_id in _user_stopped
        run.stopped = stopped
        _forget(job_id)
        run.flush(force=True)
        if stopped:
            bg_jobs.update(job_id, stopped=True)
        bg_jobs.complete_agent(job_id, run.text or "(no report)", code)
        finished += 1
        if progress_cb:
            try:
                await progress_cb(
                    {"elapsed_s": 0, "tail": f"{finished}/{len(runs)} done: {run.title}"}
                )
            except Exception:
                pass
        return code

    codes = await asyncio.gather(*(_guarded(r, t["prompt"]) for r, t in zip(runs, tasks)))

    parts, sources = [], []
    for i, (run, code) in enumerate(zip(runs, codes), 1):
        report = run.text.strip() or "(The subagent produced no report.)"
        if len(report) > _REPORT_CHARS:
            report = report[:_REPORT_CHARS] + "\n…[report truncated]…"
        status = "STOPPED BY THE USER" if run.stopped else ("done" if code == 0 else "FAILED")
        parts.append(f"## Task {i} — {run.title} ({status})\n\n{report}")
        sources.extend(run.sources)
    ok = sum(1 for c in codes if c == 0)
    head = (
        f"{ok}/{len(runs)} subagent task(s) finished. Their reports follow. They are "
        "digests: the [n] numbers are real sources of this turn and may be cited. "
        "Check anything decisive yourself (e.g. read_knowledge) before stating it "
        "as fact, and say which parts a failed task left open. A task the user "
        "stopped was stopped on purpose: do not redo it, use what it reported."
    )
    from src.prompt_security import UNTRUSTED_CONTEXT_HEADER

    return {
        "output": (
            f"{UNTRUSTED_CONTEXT_HEADER}\n{head}\n\n<<<SUPPLIED_CONTEXT>>>\n"
            + "\n\n".join(parts)
            + "\n<<<END_SUPPLIED_CONTEXT>>>"
        ),
        "rag_sources": sources,
        "label": f"{len(runs)} task(s)",
        "exit_code": 0 if ok else 1,
    }
