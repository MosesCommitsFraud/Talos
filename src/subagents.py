"""subagents.py — `delegate` / `continue_task`: parallel helper agents.

A question like "compare what the three manuals say about X" or "go through
the workshop recording and list every configuration step" is several
independent pieces of work. Doing them one after another in the main turn is
slow, and it fills the main context with raw material the answer only needs a
digest of. So the agent can hand each piece to a *subagent*:

* every subagent is a full nested agent turn (``stream_agent_loop``) with a
  fresh, small context — its assignment plus whatever context the main agent
  passes along (document names, passages it already found), no chat history;
* it has a *type* that fixes its tools: ``research`` (knowledge base, web,
  read-only SQL) or ``worker`` (research tools plus files and Python/bash in
  the chat's sandbox — analyses, conversions, drafts written to files). It
  never gets ``delegate`` itself, so it cannot fan out further;
* the main agent picks the model per task: ``small`` (default) runs on the
  configured subagent model (``subagent_endpoint_id`` / ``subagent_model``) —
  on a DGX Spark decode speed scales with model size, so a 4B helper writes
  several times faster than the 27B main model — and ``large`` on the chat's
  own model, for tasks that need judgement. Without a configured small model
  both run on the chat model;
* reasoning is off or low by default (``subagent_reasoning``);
* several run at once (``subagent_parallelism``);
* each registers as a ``kind="subagent"`` background job with a live step
  list — what the task tray shows — and stops individually from there;
* ``background: true`` returns at once; the reports come back later as a
  follow-up in the chat (a ``kind="delegate"`` job the bg monitor delivers);
* a finished subagent keeps its conversation, so ``continue_task`` can give it
  a follow-up instruction without re-reading everything.

Prefix caching: every subagent of one type gets the same system prompt and
the same instruction head; only the assignment at the end differs, so vLLM
reuses the shared prefix across the whole batch.

Subagents run under the parent's session id. In a waited-for call their
knowledge/web citations are numbered in the parent turn's citation table, so a
``[3]`` in a report is the same ``[3]`` the main answer can cite.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_TASKS = 6
_REPORT_CHARS = 8000
# Deep research asks for fuller reports (facts with citations, reliability).
_DEEP_REPORT_CHARS = 12000
# Background reports travel through the job log, whose reader keeps 16k chars.
_BACKGROUND_REPORT_BUDGET = 14000
_LIVE_WRITE_S = 0.8
_STEP_COMMAND_CHARS = 300
_CONTEXT_CHARS = 12000

# Lookups only: knowledge base, web, database. Never writes anything.
RESEARCH_TOOLS = frozenset(
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
# Research plus the chat's sandbox: files and one-shot Python/bash. Not the
# persistent kernel (run_cell) — parallel subagents would share its state.
WORKER_TOOLS = RESEARCH_TOOLS | frozenset(
    {"python", "bash", "read_file", "write_file", "edit_file", "ls", "glob", "grep"}
)
AGENT_TYPES: Dict[str, frozenset] = {"research": RESEARCH_TOOLS, "worker": WORKER_TOOLS}
# Kept for callers that only know the original read-only set.
SUBAGENT_TOOLS = RESEARCH_TOOLS

# Shared head of every subagent's first message. Constant text first, so the
# prefix cache covers it for every subagent; the assignment comes last.
_BASE = """\
You are a SUBAGENT: a helper the main assistant gave one specific assignment. \
Nobody reads your intermediate steps and nobody can answer questions — your \
final message is returned to the main assistant as your report.

- Do the assignment completely with your tools, then stop. Stay inside its scope.
- Use the context the main assistant passed along; do not search again for \
what it already gives you.
- Report only what your sources actually say, and say plainly what you could \
not find.
- Write the report as a compact, self-contained result (facts, steps, figures, \
quotes where the wording matters) — no preamble, no questions back.
"""

_TYPE_HEAD = {
    "research": """\
- Your tools are read-only lookups (knowledge base, web, database). Prefer \
reading the relevant document sections in full over guessing from snippets.
""",
    "worker": """\
- Besides lookups you can work in the chat's sandbox: run Python or shell \
commands and read/write files. Write every file you create into your working \
folder (given below) and list the files you created in your report. Check \
your result (run it, open it) before you report.
""",
}

_CITE_LIVE = (
    "Citations: keep the [n] numbers of the sources exactly as shown, right after each claim.\n"
)
_CITE_BACKGROUND = (
    "Citations: name the source after each claim — document and section/page, "
    "video time, or URL. Do not use [n] numbers.\n"
)

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
# Background delegate calls, kept referenced so they are not garbage-collected.
_background: set = set()


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


def _chat_target(ctx: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "endpoint_url": ctx["endpoint_url"],
        "model": ctx["model"],
        "headers": ctx.get("headers"),
        "context_length": ctx.get("context_length") or 0,
        "fallbacks": ctx.get("fallbacks"),
        "size": "large",
    }


def small_model_configured() -> bool:
    return bool(str(_setting("subagent_endpoint_id", "") or "").strip())


def _target(ctx: Dict[str, Any], size: str = "small") -> Dict[str, Any]:
    """Endpoint/model for one subagent. ``large`` is the chat's own model;
    ``small`` is the configured subagent model — or the chat model when none
    is set or it cannot be resolved."""
    if size == "large":
        return _chat_target(ctx)
    ep_id = str(_setting("subagent_endpoint_id", "") or "").strip()
    if ep_id:
        try:
            from src.endpoint_resolver import resolve_endpoint_by_id

            hit = resolve_endpoint_by_id(
                ep_id, str(_setting("subagent_model", "") or "").strip() or None, ctx.get("owner")
            )
        except Exception as e:
            logger.warning("subagent model could not be resolved: %s", e)
            hit = None
        if hit:
            url, model, headers = hit
            try:
                from src.model_context import get_context_length

                context_length = get_context_length(url, model)
            except Exception:
                context_length = 0
            return {
                "endpoint_url": url,
                "model": model,
                "headers": headers,
                "context_length": context_length,
                # The chat model's fallbacks belong to another model.
                "fallbacks": None,
                "size": "small",
            }
        logger.warning("subagent endpoint %s unavailable — using the chat model", ep_id)
    return _chat_target(ctx)


def _targets(ctx: Dict[str, Any], sizes) -> Dict[str, Dict[str, Any]]:
    """Resolve each needed size once per call (the small one costs a DB and a
    /v1/models lookup)."""
    return {size: _target(ctx, size) for size in set(sizes)}


def _args(content: Any) -> Dict[str, Any]:
    try:
        args = json.loads(content) if isinstance(content, str) and content.strip() else content
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON arguments: {e}")
    if isinstance(args, list):
        args = {"tasks": args}
    if not isinstance(args, dict):
        raise ValueError('Pass {"tasks": [{"title": "...", "prompt": "..."}]}.')
    return args


def parse_tasks(content: Any) -> List[Dict[str, str]]:
    """``{"tasks": [{"title", "prompt", "type"?, "model"?, "context"?}, ...]}`` → normalized list."""
    raw = _args(content).get("tasks")
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
        kind = str(item.get("type") or item.get("agent") or "research").strip().lower()
        if kind not in AGENT_TYPES:
            raise ValueError(f'Unknown subagent type "{kind}". Use "research" or "worker".')
        size = str(item.get("model") or item.get("size") or "small").strip().lower()
        if size not in ("small", "large"):
            raise ValueError(f'Unknown subagent model "{size}". Use "small" or "large".')
        context = item.get("context") or ""
        if isinstance(context, (list, dict)):
            context = json.dumps(context, ensure_ascii=False, indent=1)
        out.append(
            {
                "title": (title or prompt.split("\n")[0])[:120],
                "prompt": prompt,
                "type": kind,
                "model": size,
                "context": str(context).strip()[:_CONTEXT_CHARS],
            }
        )
    if not out:
        raise ValueError("Every task needs a `prompt` describing what to do.")
    if len(out) > MAX_TASKS:
        raise ValueError(f"At most {MAX_TASKS} tasks per call; group the rest or call again.")
    return out


def _first_message(task: Dict[str, str], job_id: str, background: bool, deep: bool = False) -> str:
    """Shared head (cacheable) → type head → citation rule → the assignment."""
    parts = [_BASE, _TYPE_HEAD[task["type"]]]
    if deep:
        from src.deep_research import SUBAGENT_HEAD

        parts.append(SUBAGENT_HEAD)
    parts.append(_CITE_BACKGROUND if background else _CITE_LIVE)
    parts.append("\nAssignment:\n\n" + task["prompt"])
    if task.get("context"):
        parts.append("\n\nContext from the main assistant:\n" + task["context"])
    if task["type"] == "worker":
        parts.append(f"\n\nYour working folder: subagents/{job_id}/")
    return "".join(parts)


def _history_path(rec: Dict[str, Any]) -> Path:
    return Path(rec["log_path"]).with_suffix(".history.json")


def _save_history(rec: Dict[str, Any], sink: Dict[str, Any], final_text: str) -> None:
    """Keep the subagent's conversation as sent (incl. tool calls and results)
    so continue_task can resume it with everything it has already read."""
    try:
        from core.atomic_io import atomic_write_json
        from src.history_replay import collect_turn_messages, make_turn_wire

        turn = collect_turn_messages(
            sink.get("messages") or [], final_text, bool(sink.get("compacted"))
        )
        wire = make_turn_wire(turn, "")
        if wire:
            atomic_write_json(str(_history_path(rec)), wire["messages"])
    except Exception as e:
        logger.debug("could not store subagent history %s: %s", rec.get("id"), e)


def _load_history(rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    try:
        data = json.loads(_history_path(rec).read_text(encoding="utf-8"))
    except Exception:
        return []
    return data if isinstance(data, list) else []


class _Run:
    """One subagent: its job record, live steps and collected output."""

    def __init__(
        self,
        rec: Dict[str, Any],
        title: str,
        kind: str,
        messages: List[Dict],
        target: Dict[str, Any],
    ):
        self.rec = rec
        self.target = target
        self.title = title
        self.kind = kind
        self.messages = messages
        self.text = ""
        self.steps: List[Dict[str, Any]] = []
        self.sources: List[Dict[str, Any]] = []
        self.stopped = False
        self.code = 1
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


async def _run_one(run: _Run, ctx: Dict[str, Any]) -> int:
    from src.agent_loop import stream_agent_loop

    sink: Dict[str, Any] = {}
    target = run.target
    max_rounds = _int_setting("subagent_max_rounds", 12, 2, 40)
    if ctx.get("deep_research"):
        # A research subagent searches broad, then narrow, then reads and
        # cross-checks — more rounds than a quick lookup.
        max_rounds = max(max_rounds, _int_setting("deep_research_subagent_max_rounds", 20, 2, 60))
    try:
        async for chunk in stream_agent_loop(
            target["endpoint_url"],
            target["model"],
            [dict(m) for m in run.messages],
            headers=target.get("headers"),
            context_length=target.get("context_length") or 0,
            max_rounds=max_rounds,
            max_tokens=ctx.get("max_tokens") or 4096,
            session_id=ctx.get("session_id"),
            disabled_tools=set(ctx.get("disabled_tools") or ()),
            owner=ctx.get("owner"),
            fallbacks=target.get("fallbacks"),
            force_db=bool(ctx.get("force_db")),
            use_rag=bool(ctx.get("use_rag")),
            tool_allowlist=AGENT_TYPES[run.kind],
            subagent=True,
            wire_sink=sink,
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
    finally:
        _save_history(run.rec, sink, run.text)
    return 0 if run.text.strip() else 1


async def _run_all(
    runs: List[_Run],
    ctx: Dict[str, Any],
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> None:
    """Run the subagents (bounded parallelism) and settle every job record."""
    from src import bg_jobs

    sem = asyncio.Semaphore(_int_setting("subagent_parallelism", 3, 1, MAX_TASKS))
    runtime = _int_setting("subagent_max_runtime_s", 900, 60, 3600)
    finished = 0

    async def _guarded(run: _Run) -> None:
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
                        asyncio.wait_for(_run_one(run, ctx), timeout=runtime)
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
        run.stopped = job_id in _user_stopped
        run.code = code
        _forget(job_id)
        run.flush(force=True)
        if run.stopped:
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

    await asyncio.gather(*(_guarded(r) for r in runs))


def _reports(runs: List[_Run], per_report: int) -> str:
    parts = []
    for i, run in enumerate(runs, 1):
        report = run.text.strip() or "(The subagent produced no report.)"
        if len(report) > per_report:
            report = report[:per_report] + "\n…[report truncated]…"
        status = "STOPPED BY THE USER" if run.stopped else ("done" if run.code == 0 else "FAILED")
        parts.append(f"## Task {i} — {run.title} ({status}) · task_id: {run.rec['id']}\n\n{report}")
    return "\n\n".join(parts)


def _summary_head(runs: List[_Run]) -> str:
    ok = sum(1 for r in runs if r.code == 0)
    return (
        f"{ok}/{len(runs)} subagent task(s) finished. Their reports follow. They are "
        "digests: check anything decisive yourself before stating it as fact, and say "
        "which parts a failed task left open. A task the user stopped was stopped on "
        "purpose: do not redo it, use what it reported. To ask a subagent a follow-up "
        "about the material it already read, use continue_task with its task_id."
    )


def _wrap(head: str, body: str) -> str:
    from src.prompt_security import UNTRUSTED_CONTEXT_HEADER

    return (
        f"{UNTRUSTED_CONTEXT_HEADER}\n{head}\n\n<<<SUPPLIED_CONTEXT>>>\n"
        f"{body}\n<<<END_SUPPLIED_CONTEXT>>>"
    )


def _check_turn(session_id: Optional[str]) -> Dict[str, Any]:
    if not enabled():
        raise ValueError("Subagents are switched off in the settings.")
    ctx = _turn.get()
    if not ctx or not ctx.get("endpoint_url") or not session_id:
        raise ValueError("Subagents are only available inside a chat turn.")
    if ctx.get("subagent"):
        raise ValueError("Subagents cannot delegate further.")
    return ctx


def _launch(
    session_id: str, title: str, task_text: str, kind: str, group: str, extra: Dict[str, Any]
) -> Dict[str, Any]:
    from src import bg_jobs

    runtime = _int_setting("subagent_max_runtime_s", 900, 60, 3600)
    rec = bg_jobs.launch_agent(
        task_text,
        session_id,
        label=title,
        # The run enforces `runtime` itself (wait_for). The store's reaper gets
        # a margin on top, so it only ever catches a job whose process died —
        # reaping a live one would cancel the whole call.
        max_runtime_s=runtime + 300,
        kind="subagent",
        extra={"group": group, "agent_type": kind, **extra},
    )
    _pending.add(rec["id"])
    return rec


async def _finish(
    runs: List[_Run],
    ctx: Dict[str, Any],
    background: bool,
    session_id: str,
    progress_cb,
) -> Dict[str, Any]:
    """Waited-for: run and return the reports. Background: start, register a
    `delegate` job that the bg monitor delivers once all runs are done, return."""
    from src import bg_jobs

    if not background:
        await _run_all(runs, ctx, progress_cb)
        sources = [s for r in runs for s in r.sources]
        ok = any(r.code == 0 for r in runs)
        per_report = _DEEP_REPORT_CHARS if ctx.get("deep_research") else _REPORT_CHARS
        return {
            "output": _wrap(_summary_head(runs), _reports(runs, per_report)),
            "rag_sources": sources,
            "label": f"{len(runs)} task(s)",
            "exit_code": 0 if ok else 1,
        }

    titles = " · ".join(r.title for r in runs)
    parallel = _int_setting("subagent_parallelism", 3, 1, MAX_TASKS)
    runtime = _int_setting("subagent_max_runtime_s", 900, 60, 3600)
    waves = -(-len(runs) // parallel)
    holder = bg_jobs.launch_agent(
        "\n\n".join(f"{r.title}: {r.rec.get('task') or ''}" for r in runs),
        session_id,
        label=f"Subagenten: {titles}"[:200],
        max_runtime_s=waves * runtime + 600,
        kind="delegate",
    )

    async def _deliver() -> None:
        try:
            await _run_all(runs, ctx)
            per = max(1500, _BACKGROUND_REPORT_BUDGET // max(1, len(runs)))
            body = _summary_head(runs) + "\n\n" + _reports(runs, per)
            bg_jobs.complete_agent(holder["id"], body, 0 if any(r.code == 0 for r in runs) else 1)
        except BaseException as e:  # noqa: BLE001 — every exit must settle the job
            bg_jobs.complete_agent(holder["id"], f"The subagents did not finish: {e!r}", 1)
            if isinstance(e, asyncio.CancelledError):
                raise

    task = asyncio.create_task(_deliver())
    _background.add(task)
    task.add_done_callback(_background.discard)
    ids = ", ".join(f"{r.title} → {r.rec['id']}" for r in runs)
    return {
        "output": (
            f"Started {len(runs)} subagent(s) in the background ({ids}). Their reports "
            "arrive automatically as a follow-up message once all are done — do not wait "
            "or poll for them. Tell the user briefly what is running, then continue "
            "with anything else or end your turn."
        ),
        "label": f"{len(runs)} task(s), background",
        "exit_code": 0,
    }


async def run_tasks(
    content: str,
    session_id: Optional[str],
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Dict[str, Any]:
    """Executor entry point for `delegate`."""
    try:
        ctx = _check_turn(session_id)
        args = _args(content)
        tasks = parse_tasks(args)
    except ValueError as e:
        return {"error": str(e), "exit_code": 1}
    background = bool(args.get("background"))
    targets = await asyncio.to_thread(_targets, ctx, [t["model"] for t in tasks])
    group = f"g{int(time.time() * 1000)}"
    runs: List[_Run] = []
    for task in tasks:
        target = targets[task["model"]]
        rec = _launch(
            session_id,
            task["title"],
            task["prompt"],
            task["type"],
            group,
            # What actually ran: "small" falls back to the chat model when no
            # subagent model is configured.
            {"model_size": target["size"], "model": target["model"]},
        )
        message = _first_message(task, rec["id"], background, bool(ctx.get("deep_research")))
        runs.append(
            _Run(rec, task["title"], task["type"], [{"role": "user", "content": message}], target)
        )
    return await _finish(runs, ctx, background, session_id, progress_cb)


async def continue_task(
    content: str,
    session_id: Optional[str],
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Dict[str, Any]:
    """Executor entry point for `continue_task`: give a finished subagent a
    follow-up instruction, with its whole previous conversation (everything it
    already read) still in context."""
    from src import bg_jobs

    try:
        ctx = _check_turn(session_id)
        args = _args(content)
    except ValueError as e:
        return {"error": str(e), "exit_code": 1}
    job_id = str(args.get("task_id") or args.get("id") or "").strip()
    prompt = str(args.get("prompt") or args.get("message") or "").strip()
    if not job_id or not prompt:
        return {"error": "Pass the subagent's `task_id` and a `prompt`.", "exit_code": 1}
    rec = bg_jobs.get(job_id)
    if not rec or rec.get("session_id") != session_id or rec.get("kind") != "subagent":
        return {"error": f"No subagent {job_id} in this chat.", "exit_code": 1}
    if rec.get("status") == "running":
        return {"error": "That subagent is still running; wait for its report.", "exit_code": 1}
    history = _load_history(rec)
    if not history:
        return {
            "error": "That subagent's conversation is no longer available; start a new "
            "one with delegate.",
            "exit_code": 1,
        }
    kind = rec.get("agent_type") if rec.get("agent_type") in AGENT_TYPES else "research"
    size = str(args.get("model") or rec.get("model_size") or "small").strip().lower()
    if size not in ("small", "large"):
        return {"error": 'Use "small" or "large" for `model`.', "exit_code": 1}
    background = bool(args.get("background"))
    title = (str(args.get("title") or "").strip() or f"{rec.get('command')} (+)")[:120]
    target = await asyncio.to_thread(_target, ctx, size)
    new = _launch(
        session_id,
        title,
        prompt,
        kind,
        f"g{int(time.time() * 1000)}",
        {"continues": job_id, "model_size": target["size"], "model": target["model"]},
    )
    messages = history + [{"role": "user", "content": prompt}]
    run = _Run(new, title, kind, messages, target)
    return await _finish([run], ctx, background, session_id, progress_cb)
