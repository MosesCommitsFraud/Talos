# src/usage_tracking.py
"""Writes the per-turn / per-tool rows the admin usage view reads.

One call at the end of a turn (`record_turn`) fans out into a single "turn"
row plus one "tool" row per executed tool. Everything here is best-effort:
usage accounting must never break or slow a chat, so every failure is logged
and swallowed.

Privacy contract — enforced in `_detail_for`:
  tool NAMES and counts always; tool ARGUMENTS only for the whitelist below,
  whose arguments are library identifiers rather than user content. A
  `web_search` row records that a search happened, never what was searched.
"""

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from core.database import SessionLocal, UsageDaily, UsageEvent

logger = logging.getLogger(__name__)

# Tools whose first argument is an identifier in a shared library, not user
# content. Anything not listed here stores `detail = None`.
_DETAIL_WHITELIST = {"read_skill", "create_skill", "manage_skills"}

# How long raw per-event rows are kept before being folded into UsageDaily.
RAW_RETENTION_DAYS = 90


def knowledge_mode(use_rag: bool, use_db: bool) -> str:
    """The composer's four-way mode (web/src/state/prefs.ts `ChatMode`),
    reconstructed from the request flags that drive it."""
    if use_rag and use_db:
        return "full"
    if use_rag:
        return "knowledge"
    if use_db:
        return "sql"
    return "chat"


def _detail_for(tool: str, command) -> Optional[str]:
    """Whitelisted identifier for a tool call, or None. See the privacy note."""
    if tool not in _DETAIL_WHITELIST or not command:
        return None
    return str(command).strip().splitlines()[0][:120] or None


def record_turn(
    *,
    owner: Optional[str],
    session_id: Optional[str],
    model: Optional[str],
    metrics: Optional[dict],
    use_rag: bool = False,
    use_db: bool = False,
    session_mode: Optional[str] = None,
    rounds: int = 0,
    incognito: bool = False,
    ts: Optional[datetime] = None,
) -> None:
    """Persist one turn and its tool calls. Never raises.

    Incognito turns are skipped entirely — they aren't persisted as messages
    either, so counting them would leak the existence of hidden activity.
    """
    if incognito:
        return
    metrics = metrics or {}
    db = None
    try:
        db = SessionLocal()
        stamp = ts or datetime.utcnow()
        duration = metrics.get("response_time")
        db.add(
            UsageEvent(
                ts=stamp,
                owner=owner,
                session_id=session_id,
                kind="turn",
                model=model or metrics.get("model"),
                mode=knowledge_mode(use_rag, use_db),
                session_mode=session_mode,
                input_tokens=int(metrics.get("input_tokens") or 0),
                output_tokens=int(metrics.get("output_tokens") or 0),
                duration_ms=int(float(duration) * 1000) if duration else None,
                rounds=rounds or None,
            )
        )
        for ev in metrics.get("tool_events") or []:
            if not isinstance(ev, dict):
                continue
            tool = str(ev.get("tool") or "").strip()
            if not tool:
                continue
            exit_code = ev.get("exit_code")
            db.add(
                UsageEvent(
                    ts=stamp,
                    owner=owner,
                    session_id=session_id,
                    kind="tool",
                    model=model,
                    tool=tool,
                    # Non-shell tools report no exit code; absent means success.
                    ok=exit_code in (None, 0),
                    detail=_detail_for(tool, ev.get("command")),
                )
            )
        db.commit()
    except Exception as e:
        logger.warning("Usage tracking failed for owner=%r: %s", owner, e)
        if db is not None:
            try:
                db.rollback()
            except Exception:
                pass
    finally:
        if db is not None:
            db.close()


def rollup_and_prune(retention_days: int = RAW_RETENTION_DAYS) -> dict:
    """Fold raw events older than the retention window into UsageDaily, then
    delete them. Idempotent: a day already rolled up is merged, not doubled,
    because its raw rows are gone once counted."""
    cutoff = (datetime.utcnow() - timedelta(days=retention_days)).date()
    db = SessionLocal()
    try:
        stale = (
            db.query(UsageEvent)
            .filter(UsageEvent.ts < datetime.combine(cutoff, datetime.min.time()))
            .all()
        )
        if not stale:
            return {"rolled_days": 0, "pruned_events": 0}

        buckets: dict = {}
        for ev in stale:
            key = (ev.owner, ev.ts.date())
            b = buckets.setdefault(
                key,
                {
                    "turns": 0,
                    "tool_calls": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "sessions": set(),
                    "tools": {},
                    "modes": {},
                },
            )
            if ev.session_id:
                b["sessions"].add(ev.session_id)
            if ev.kind == "turn":
                b["turns"] += 1
                b["input_tokens"] += ev.input_tokens or 0
                b["output_tokens"] += ev.output_tokens or 0
                if ev.mode:
                    b["modes"][ev.mode] = b["modes"].get(ev.mode, 0) + 1
            elif ev.kind == "tool":
                b["tool_calls"] += 1
                if ev.tool:
                    b["tools"][ev.tool] = b["tools"].get(ev.tool, 0) + 1

        for (owner, day), b in buckets.items():
            row = (
                db.query(UsageDaily)
                .filter(UsageDaily.owner == owner, UsageDaily.day == day)
                .one_or_none()
            )
            if row is None:
                row = UsageDaily(owner=owner, day=day, tools={}, modes={})
                db.add(row)
            row.turns = (row.turns or 0) + b["turns"]
            row.tool_calls = (row.tool_calls or 0) + b["tool_calls"]
            row.input_tokens = (row.input_tokens or 0) + b["input_tokens"]
            row.output_tokens = (row.output_tokens or 0) + b["output_tokens"]
            row.sessions = (row.sessions or 0) + len(b["sessions"])
            merged_tools = dict(row.tools or {})
            for k, v in b["tools"].items():
                merged_tools[k] = merged_tools.get(k, 0) + v
            row.tools = merged_tools
            merged_modes = dict(row.modes or {})
            for k, v in b["modes"].items():
                merged_modes[k] = merged_modes.get(k, 0) + v
            row.modes = merged_modes

        pruned = (
            db.query(UsageEvent)
            .filter(UsageEvent.ts < datetime.combine(cutoff, datetime.min.time()))
            .delete(synchronize_session=False)
        )
        db.commit()
        logger.info("Usage rollup: %d day-buckets, %d raw events pruned", len(buckets), pruned)
        return {"rolled_days": len(buckets), "pruned_events": pruned}
    except Exception as e:
        db.rollback()
        logger.exception("Usage rollup failed")
        return {"error": str(e), "rolled_days": 0, "pruned_events": 0}
    finally:
        db.close()


def earliest_raw_day() -> Optional[date]:
    """First day still covered by raw events — the API uses it to decide where
    to switch over to the daily rollups."""
    db = SessionLocal()
    try:
        row = db.query(UsageEvent.ts).order_by(UsageEvent.ts.asc()).first()
        return row[0].date() if row and row[0] else None
    finally:
        db.close()
