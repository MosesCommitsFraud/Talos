"""
builtin_actions.py

Registry of built-in automation actions that can be executed by the task
scheduler without needing an LLM call.
"""

import logging
import os
from typing import Tuple

from core.platform_compat import IS_WINDOWS, find_bash

logger = logging.getLogger(__name__)


class TaskNoop(BaseException):
    """Raised by an action when it determined there's nothing to do.

    Inherits from BaseException (not Exception) so the standard
    `except Exception` wrappers each action uses for real error handling
    don't accidentally catch it. The scheduler explicitly catches TaskNoop,
    drops the queued TaskRun row, advances last_run / next_run, and exits
    silently. Nothing appears in the Activity log; the message is logged
    server-side only.
    """


class TaskDeferred(BaseException):
    """Raised when a task should run later without recording a skipped run."""

    def __init__(self, reason: str, delay_seconds: int = 20 * 60):
        super().__init__(reason)
        self.reason = reason
        self.delay_seconds = delay_seconds


async def action_tidy_sessions(owner: str, **kwargs) -> Tuple[str, bool]:
    """Delete empty sessions for the owner. Pure heuristic —
    the LLM folder-sort phase is skipped (user opted to keep this task
    LLM-free; sorting can be triggered manually via the Chats UI)."""
    try:
        import asyncio

        from src.session_actions import run_auto_sort

        result = await asyncio.wait_for(
            run_auto_sort(owner, skip_llm=True, delete_throwaway=False),
            timeout=60,
        )
        return result, True
    except asyncio.TimeoutError:
        logger.error("tidy_sessions action timed out")
        return "Chat session tidy timed out", False
    except Exception as e:
        logger.error(f"tidy_sessions action failed: {e}")
        return str(e), False


async def action_tidy_documents(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run tidy on documents for the owner."""
    try:
        from src.document_actions import run_document_tidy

        result = await run_document_tidy(owner)
        return result, True
    except Exception as e:
        logger.error(f"tidy_documents action failed: {e}")
        return str(e), False


async def action_consolidate_memory(owner: str, **kwargs) -> Tuple[str, bool]:
    """Consolidate/deduplicate memories for the owner."""
    try:
        import json
        import re

        from src.constants import DATA_DIR
        from src.endpoint_resolver import resolve_endpoint
        from src.llm_core import llm_call_async
        from src.memory import MemoryManager

        manager = MemoryManager(DATA_DIR)
        all_memories = manager.load_all()

        _owner_clean = (owner or "").strip()
        text_limit = 2000

        def _memory_owner(mem: dict) -> str:
            return (mem.get("owner") or "").strip()

        # Built-in housekeeping can run without an owner. In that case scan all
        # memories, but keep every AI prompt/apply step owner-local.
        if _owner_clean:
            memory_groups = {
                _owner_clean: [m for m in all_memories if _memory_owner(m) == _owner_clean]
            }
        else:
            memory_groups = {}
            for mem in all_memories:
                memory_groups.setdefault(_memory_owner(mem), []).append(mem)

        memory_groups = {
            group_owner: group for group_owner, group in memory_groups.items() if group
        }
        if not memory_groups:
            raise TaskNoop("no memories to consolidate")

        total_removed = 0
        total_cleaned = 0
        total_scanned = 0
        removed_examples = []
        ai_reasons = []
        ai_used = False

        async def _try_ai_tidy_group(group_owner: str, group_memories: list) -> bool:
            nonlocal all_memories, total_removed, total_cleaned, total_scanned, ai_used
            if len(group_memories) < 2:
                return False

            url, model, headers = resolve_endpoint("utility", owner=group_owner or None)
            if not url or not model:
                url, model, headers = resolve_endpoint("default", owner=group_owner or None)
            if not url or not model:
                return False

            try:
                items = [
                    {
                        "id": m.get("id"),
                        "category": m.get("category", "fact"),
                        "text": (m.get("text") or "").strip()[:text_limit],
                        "truncated": len((m.get("text") or "").strip()) > text_limit,
                    }
                    for m in group_memories
                    if m.get("id") and (m.get("text") or "").strip()
                ]
                if len(items) < 2:
                    return False
                truncated_ids = {item["id"] for item in items if item.get("truncated")}
                prompt = (
                    "You are tidying a user's saved personal memories. Return ONLY raw JSON, no markdown.\n"
                    "Remove memories that are empty, broken, trivial conversation filler, duplicates, or obsolete "
                    "because a clearer newer memory replaces them. Preserve useful personal facts, preferences, "
                    "contacts, project context, and instructions. If memories conflict, keep the clearest/latest "
                    "one and drop the obsolete one.\n\n"
                    "JSON shape:\n"
                    '{"keep":[{"id":"existing id","text":"cleaned text","category":"fact|preference|identity|event|contact|project|instruction"}],'
                    '"drop":[{"id":"existing id","reason":"short reason"}]}\n\n'
                    f"MEMORIES:\n{json.dumps(items, ensure_ascii=False)}"
                )
                raw = await llm_call_async(
                    url=url,
                    model=model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=4096,
                    headers=headers,
                    timeout=120,
                )
                from src.text_helpers import strip_think

                raw = strip_think(raw or "", prose=False, prompt_echo=False).strip()
                raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
                start = raw.find("{")
                end = raw.rfind("}")
                if start != -1 and end != -1 and end > start:
                    decision = json.loads(raw[start : end + 1])
                    keep_items = decision.get("keep") if isinstance(decision, dict) else None
                    drop_items = decision.get("drop") if isinstance(decision, dict) else None
                    if isinstance(keep_items, list) and isinstance(drop_items, list):
                        by_id = {m.get("id"): m for m in group_memories if m.get("id")}
                        keep_ids = set()
                        cleaned_by_id = {}
                        for item in keep_items:
                            if not isinstance(item, dict):
                                continue
                            mid = item.get("id")
                            if mid not in by_id:
                                continue
                            text = (item.get("text") or "").strip()
                            if not text:
                                continue
                            keep_ids.add(mid)
                            cleaned = {
                                "category": (
                                    item.get("category") or by_id[mid].get("category") or "fact"
                                ).strip(),
                            }
                            original_text = (by_id[mid].get("text") or "").strip()
                            if len(original_text) <= text_limit:
                                cleaned["text"] = text
                            cleaned_by_id[mid] = cleaned

                        # If the model only saw a truncated memory, do not let
                        # that partial view delete or rewrite the full memory.
                        keep_ids.update(mid for mid in truncated_ids if mid in by_id)

                        if keep_ids:
                            changed_text = 0
                            group_ref_ids = {id(m) for m in group_memories}
                            kept_all = []
                            for mem in all_memories:
                                if id(mem) not in group_ref_ids:
                                    kept_all.append(mem)
                                    continue
                                mid = mem.get("id")
                                if mid not in keep_ids:
                                    continue
                                cleaned = cleaned_by_id.get(mid) or {}
                                if mid in truncated_ids:
                                    cleaned.pop("text", None)
                                if cleaned.get("text") and cleaned["text"] != mem.get("text"):
                                    mem["text"] = cleaned["text"]
                                    changed_text += 1
                                if cleaned.get("category"):
                                    mem["category"] = cleaned["category"]
                                kept_all.append(mem)

                            removed = len(group_memories) - len(keep_ids)
                            total_scanned += len(group_memories)
                            if removed or changed_text:
                                all_memories = kept_all
                                total_removed += removed
                                total_cleaned += changed_text
                                ai_used = True
                                ai_reasons.extend(
                                    [
                                        (d.get("reason") or "").strip()
                                        for d in drop_items
                                        if isinstance(d, dict) and (d.get("reason") or "").strip()
                                    ]
                                )
                            return True
            except Exception as ai_err:
                logger.warning(
                    "AI memory tidy failed; falling back to duplicate cleanup: %s", ai_err
                )
            return False

        for group_owner, group_memories in memory_groups.items():
            if await _try_ai_tidy_group(group_owner, group_memories):
                continue

            seen = {}
            keep_refs = set()
            total_scanned += len(group_memories)
            for mem in group_memories:
                text = (mem.get("text") or "").strip()
                key = " ".join(text.lower().split())
                if not key:
                    if len(removed_examples) < 3:
                        removed_examples.append("(empty)")
                    continue
                if key in seen:
                    if len(removed_examples) < 3:
                        removed_examples.append(text[:60] + ("..." if len(text) > 60 else ""))
                    continue
                seen[key] = mem
                keep_refs.add(id(mem))

            group_removed = len(group_memories) - len(keep_refs)
            if group_removed == 0:
                continue

            group_ref_ids = {id(m) for m in group_memories}
            all_memories = [
                m for m in all_memories if id(m) not in group_ref_ids or id(m) in keep_refs
            ]
            total_removed += group_removed

        if total_removed or total_cleaned:
            manager.save(all_memories)
            if ai_used:
                reasons = ai_reasons[:3]
                reason_text = f": {'; '.join(reasons)}" if reasons else ""
                return (
                    f"AI tidied {total_scanned} memories: "
                    f"removed {total_removed}, cleaned {total_cleaned}{reason_text}",
                    True,
                )
            preview = "; ".join(removed_examples)
            extra = (
                f" (+{total_removed - len(removed_examples)} more)"
                if total_removed > len(removed_examples)
                else ""
            )
            return (
                f"Removed {total_removed} duplicate(s) of {total_scanned}: {preview}{extra}",
                True,
            )

        raise TaskNoop(f"scanned {total_scanned} memories, no duplicates")
    except Exception as e:
        logger.error(f"consolidate_memory action failed: {e}")
        return str(e), False


# Registry: action name -> async function(owner, **kwargs) -> (result_str, success_bool)


async def _run_subprocess(
    argv, *, shell: bool = False, timeout: int = 120, label: str = "Command"
) -> Tuple[str, bool]:
    """Shared subprocess runner. Wraps the blocking subprocess.run in
    asyncio.to_thread so the event loop stays responsive."""
    import asyncio
    import subprocess

    try:
        result = await asyncio.to_thread(
            subprocess.run,
            argv,
            shell=shell,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout or "").strip()
        if result.returncode != 0 and result.stderr:
            output += "\nSTDERR: " + result.stderr.strip()
        return output or "(no output)", result.returncode == 0
    except subprocess.TimeoutExpired:
        return f"{label} timed out ({timeout}s)", False
    except Exception as e:
        return str(e), False


async def action_ssh_command(
    owner: str, command: str = "", host: str = "localhost", **kwargs
) -> Tuple[str, bool]:
    """Run a shell command locally or on a remote host via SSH."""
    if not command:
        return "No command specified", False
    if host in ("localhost", "127.0.0.1", "local"):
        if IS_WINDOWS:
            bash = find_bash()
            if bash:
                return await _run_subprocess([bash, "-c", command], timeout=120, label="Command")
            return await _run_subprocess(command, shell=True, timeout=120, label="Command")
        return await _run_subprocess(["bash", "-c", command], timeout=120, label="Command")
    return await _run_subprocess(
        ["ssh", "-o", "ConnectTimeout=10", host, command],
        timeout=120,
        label="Command",
    )


async def action_run_script(
    owner: str, script: str = "", host: str = "", **kwargs
) -> Tuple[str, bool]:
    """Run a script locally, or via SSH when a host is configured."""
    if not script:
        return "No script specified", False
    target_host = (host or os.getenv("TALOS_SCRIPT_HOST", "localhost")).strip()
    if target_host in ("", "localhost", "127.0.0.1", "local"):
        if IS_WINDOWS and find_bash():
            return await _run_subprocess([find_bash(), "-c", script], timeout=300, label="Script")
        return await _run_subprocess(script, shell=True, timeout=300, label="Script")
    return await _run_subprocess(["ssh", target_host, script], timeout=300, label="Script")


async def action_run_local(owner: str, script: str = "", **kwargs) -> Tuple[str, bool]:
    """Run a script locally (no SSH)."""
    if not script:
        return "No script specified", False
    if IS_WINDOWS and find_bash():
        return await _run_subprocess([find_bash(), "-c", script], timeout=300, label="Script")
    return await _run_subprocess(script, shell=True, timeout=300, label="Script")


async def action_test_skills(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run the per-skill Test on every skill: agent runs the procedure in a
    sandbox, LLM judges the transcript, verdict is recorded on the skill.
    ADVISORY ONLY — only writes set_audit (never rewrites SKILL.md, never
    demotes status, never overrides confidence)."""
    try:
        from routes.skills_routes import _run_skill_test_once, _skill_test_task
        from services.memory.skills import SkillsManager
        from src.constants import DATA_DIR
        from src.endpoint_resolver import resolve_endpoint

        # #3 SCOPE GUARD: refuse to run on a None/empty owner — otherwise
        # `sm.load(owner=None)` returns every user's skills and we'd cross-
        # test (and write audit verdicts to) other users' data in a
        # multi-user deployment.
        if not owner:
            return (
                "test_skills requires an owner on the task — refusing to run without scope.",
                False,
            )

        sm = SkillsManager(DATA_DIR)
        skills = sm.load(owner=owner)
        names = [s.get("name") for s in skills if s.get("name")]
        if not names:
            raise TaskNoop("no skills to test")

        url, model, headers = resolve_endpoint("default", owner=owner)
        if not url or not model:
            return "No Default/Utility model configured — set one in Settings.", False

        # #2 NO SILENT MODEL SWAP: if the configured model isn't served by the
        # endpoint, try a basename match — but fail loudly instead of grabbing
        # `avail[0]` which could be an embedding-only model and produce 36
        # garbage transcripts → 36 'unknown' verdicts with no hint why.
        try:
            from src.llm_core import list_model_ids

            avail = list_model_ids(url, headers=headers)
            if avail and model not in avail:
                import os as _os

                base = _os.path.basename((model or "").rstrip("/"))
                m = next((a for a in avail if _os.path.basename(a.rstrip("/")) == base), None)
                if m:
                    model = m
                else:
                    return (
                        f"Default model '{model}' not served by endpoint {url}. "
                        f"Available: {', '.join(avail[:8])}{'…' if len(avail) > 8 else ''}. "
                        "Set a valid Default model in Settings."
                    ), False
        except Exception as _e:
            logger.warning(f"test_skills model resolve check failed (continuing): {_e}")

        logger.info(f"test_skills: starting on {len(names)} skills, model={model}, owner={owner!r}")

        from collections import Counter

        tally = Counter()
        per_skill_log = []
        for skill in skills:
            name = skill.get("name")
            if not name:
                continue
            md = sm.read_skill_md(name, owner=owner) or ""
            if not md:
                tally["skipped"] += 1
                per_skill_log.append(f"{name}: skipped (no SKILL.md)")
                continue
            task = _skill_test_task(skill)
            try:
                transcript, verdict = await _run_skill_test_once(
                    md, task, url, model, headers, owner
                )
                v = (verdict or {}).get("verdict") or "unknown"
                tally[v] += 1
                summary = (verdict or {}).get("summary") or ""
                tlen = len(transcript or "")
                detail = ""
                if v in ("unknown", "inconclusive", "fail", "needs_work"):
                    bits = []
                    if summary:
                        bits.append(summary[:160])
                    if tlen < 200:
                        bits.append(f"transcript {tlen}b")
                    if bits:
                        detail = " — " + "; ".join(bits)
                per_skill_log.append(f"{name}: {v}{detail}")
                # #4 + #8 + #12: ONLY persist a real verdict (pass / needs_work /
                # fail / inconclusive). Skip 'unknown' — that's the judge's
                # "couldn't parse" sentinel, not a real result, and persisting
                # it pollutes the verified-badge UI. Also skip the confidence
                # rewrite entirely — update_skill() re-serialises SKILL.md
                # (contradicts "advisory only" docstring) and overwriting a
                # user-set value (e.g. 1.0 → 0.95) is destructive.
                if v in ("pass", "needs_work", "fail", "inconclusive"):
                    try:
                        sm.set_audit(name, v, by_teacher=False, worker_model=model, owner=owner)
                    except Exception as _e:
                        logger.warning(f"test_skills set_audit({name}) failed: {_e}")
                if v == "unknown":
                    logger.warning(
                        f"test_skills: {name} → unknown — {summary[:200]}; transcript_len={tlen}"
                    )
            except Exception as e:
                logger.exception(f"test_skills: {name} errored")
                tally["error"] += 1
                per_skill_log.append(f"{name}: error — {str(e)[:200]}")

        parts = []
        for k in ("pass", "needs_work", "fail", "inconclusive", "unknown", "skipped", "error"):
            if tally.get(k):
                parts.append(f"{tally[k]} {k}")
        header = f"Tested {len(names)} skill(s): " + (" · ".join(parts) or "0")
        # Multi-line result: summary first, then per-skill detail. The Tasks
        # Activity feed renders this verbatim, so the user can see per-skill
        # outcomes + the judge's "why" without checking uvicorn stdout.
        body = "\n".join(per_skill_log)
        return f"{header}\nmodel={model}\n\n{body}", True
    except TaskNoop:
        raise
    except Exception as e:
        logger.error(f"test_skills action failed: {e}")
        return str(e), False


async def action_audit_skills(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run the real skills audit pipeline for skills that have not been audited.

    Unlike test_skills, this uses the same audit logic as the UI Audit all flow:
    metadata narrowing, self-edit/retry, optional teacher rewrite, necessity
    tagging, and publish/draft finalization from the user's confidence threshold.
    """
    try:
        from routes.skills_routes import (
            _resolve_audit_models,
            _run_audit_all_job,
            _skill_audit_jobs,
        )
        from services.memory.skills import SkillsManager
        from src.constants import DATA_DIR

        if not owner:
            return "audit_skills requires an owner — refusing to run without scope.", False

        key = (owner or "",)
        existing = _skill_audit_jobs.get(key)
        if existing and existing.get("status") == "running":
            raise TaskNoop("skill audit already running")

        sm = SkillsManager(DATA_DIR)
        skills = sm.load(owner=owner)
        names = [s.get("name") for s in skills if s.get("name") and not s.get("audit_verdict")]
        if not names:
            raise TaskNoop("no unaudited skills")

        url, model, headers, teacher = _resolve_audit_models()
        try:
            from src.llm_core import seconds_since_model_activity

            recent = seconds_since_model_activity(url, model)
        except Exception:
            recent = None
        if recent is not None and recent < (20 * 60):
            raise TaskDeferred(
                f"audit model {model} was used {int(recent)}s ago; waiting for quiet window",
                delay_seconds=20 * 60,
            )

        import time as _time

        _skill_audit_jobs[key] = {
            "status": "running",
            "scope": "scheduled-unchecked",
            "model": model,
            "teacher": teacher[1] if teacher else None,
            "total": len(names),
            "done": 0,
            "current": None,
            "results": [],
            "log": [
                f"Scheduled audit of {len(names)} unaudited skill(s) with {model}"
                + (f"; teacher {teacher[1]}" if teacher else "")
            ],
            "started": _time.time(),
            "cancel": False,
        }
        await _run_audit_all_job(key, sm, names, url, model, headers, teacher, owner)
        job = _skill_audit_jobs.get(key, {})
        counts = {}
        for r in job.get("results", []):
            k = r.get("result") or "unknown"
            counts[k] = counts.get(k, 0) + 1
        summary = " · ".join(f"{v} {k}" for k, v in sorted(counts.items())) or "0 results"
        return f"Audited {job.get('done', 0)}/{len(names)} unaudited skill(s): {summary}", True
    except TaskNoop:
        raise
    except Exception as e:
        logger.error(f"audit_skills action failed: {e}")
        return str(e), False


BUILTIN_ACTIONS = {
    "tidy_sessions": action_tidy_sessions,
    "tidy_documents": action_tidy_documents,
    "consolidate_memory": action_consolidate_memory,
    "ssh_command": action_ssh_command,
    "run_script": action_run_script,
    "run_local": action_run_local,
    "test_skills": action_test_skills,
    "audit_skills": action_audit_skills,
}

# Descriptions for the UI/API
BUILTIN_ACTION_INFO = {
    "tidy_sessions": "Clean up empty chat sessions and auto-sort into folders",
    "tidy_documents": "Remove junk/empty documents",
    "consolidate_memory": "Remove duplicate memories",
    "ssh_command": "Run a shell command on a local or remote host",
    "run_script": "Run a script locally or on TALOS_SCRIPT_HOST",
    "test_skills": "Run the per-skill Test on every skill: agent run + LLM judge → records verdict on the skill (pass/needs_work/fail/inconclusive). Advisory only — never rewrites or demotes anything.",
    "audit_skills": "Audit unaudited skills after enough new skills are added: test, narrow metadata, self-edit/retry, optional teacher rewrite, tag duplicates/trivial skills, and publish/draft using the auto-approve threshold.",
}
