# routes/admin_usage_routes.py
"""Admin usage analytics and per-user storage management.

Two concerns, one router because the UI shows them on one screen:

  * `/api/admin/usage/*` — reads `usage_events` (see src/usage_tracking.py) to
    answer who used what, how much, and how that compares to everyone else.
  * `/api/admin/storage/*` — per-user footprint across every owner-scoped
    table, with per-category deletes. The existing Danger Zone
    (routes/admin_wipe_routes.py) only wipes globally; these are scoped.

Timestamps are stored naive-UTC, so the client passes its timezone offset and
day bucketing happens here in Python — identical behaviour on SQLite and
Postgres, matching routes/stats_routes.py.
"""

import logging
import os
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func

from core.database import (
    CalendarCal,
    CalendarEvent,
    Comparison,
    CrewMember,
    Document,
    DocumentVersion,
    EditorDraft,
    GalleryAlbum,
    GalleryImage,
    Note,
    SessionLocal,
    UsageDaily,
    UsageEvent,
    UserTool,
)
from core.database import ChatMessage as DbMessage
from core.database import Session as DbSession
from core.middleware import require_admin
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

# Daily series length for the per-user chart (~13 weeks).
SERIES_DAYS = 91

# Tools that answer "did they search the web" / "did they touch skills".
WEB_TOOLS = {"web_search", "web_fetch"}
SKILL_READ_TOOLS = {"read_skill", "browse_skills"}
SKILL_WRITE_TOOLS = {"create_skill", "manage_skills"}


def _median(values: list) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def _window(days: int, tz_offset: int):
    """(shift, today_local, cutoff_utc). cutoff is None for all-time."""
    shift = timedelta(minutes=tz_offset)
    today = (datetime.utcnow() + shift).date()
    if days <= 0:
        return shift, today, None
    start_local = today - timedelta(days=days - 1)
    # Back to naive UTC for the column comparison.
    cutoff = datetime.combine(start_local, datetime.min.time()) - shift
    return shift, today, cutoff


def _blank_agg() -> dict:
    return {
        "turns": 0,
        "tool_calls": 0,
        "tool_errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "web_searches": 0,
        "skill_loads": 0,
        "skills_created": 0,
        "sessions": set(),
        # Rollup rows only carry a session COUNT (the ids are gone), so they
        # add here instead of to the set above; the two are summed on output.
        "sessions_rolled": 0,
        "active_days": set(),
        "tools": {},
        "modes": {},
        "models": {},
        "skills": {},
        "hours": [0] * 24,
        "daily": {},
        "last_active": None,
    }


def _fold_event(agg: dict, ev, shift: timedelta) -> None:
    """Accumulate one raw UsageEvent row into a per-user aggregate."""
    local = ev.ts + shift
    day = local.date()
    agg["active_days"].add(day)
    if ev.session_id:
        agg["sessions"].add(ev.session_id)
    if agg["last_active"] is None or ev.ts > agg["last_active"]:
        agg["last_active"] = ev.ts
    bucket = agg["daily"].setdefault(day, {"turns": 0, "tokens": 0, "tools": 0})

    if ev.kind == "turn":
        agg["turns"] += 1
        agg["input_tokens"] += ev.input_tokens or 0
        agg["output_tokens"] += ev.output_tokens or 0
        agg["hours"][local.hour] += 1
        bucket["turns"] += 1
        bucket["tokens"] += (ev.input_tokens or 0) + (ev.output_tokens or 0)
        if ev.mode:
            agg["modes"][ev.mode] = agg["modes"].get(ev.mode, 0) + 1
        if ev.model:
            agg["models"][ev.model] = agg["models"].get(ev.model, 0) + 1
    elif ev.kind == "tool":
        agg["tool_calls"] += 1
        bucket["tools"] += 1
        if ev.ok is False:
            agg["tool_errors"] += 1
        tool = ev.tool or "?"
        slot = agg["tools"].setdefault(tool, {"count": 0, "errors": 0})
        slot["count"] += 1
        if ev.ok is False:
            slot["errors"] += 1
        if tool in WEB_TOOLS:
            agg["web_searches"] += 1
        if tool in SKILL_READ_TOOLS:
            agg["skill_loads"] += 1
            if ev.detail:
                agg["skills"][ev.detail] = agg["skills"].get(ev.detail, 0) + 1
        if tool in SKILL_WRITE_TOOLS:
            agg["skills_created"] += 1


def _fold_rollup(agg: dict, row) -> None:
    """Accumulate a UsageDaily rollup row (events already pruned).

    Rollups are day-granular, so they contribute to totals and the daily
    series but not to the hour histogram — that detail is gone by design.
    """
    agg["turns"] += row.turns or 0
    agg["tool_calls"] += row.tool_calls or 0
    agg["input_tokens"] += row.input_tokens or 0
    agg["output_tokens"] += row.output_tokens or 0
    agg["sessions_rolled"] += row.sessions or 0
    if row.turns:
        agg["active_days"].add(row.day)
    bucket = agg["daily"].setdefault(row.day, {"turns": 0, "tokens": 0, "tools": 0})
    bucket["turns"] += row.turns or 0
    bucket["tokens"] += (row.input_tokens or 0) + (row.output_tokens or 0)
    bucket["tools"] += row.tool_calls or 0
    for tool, n in (row.tools or {}).items():
        slot = agg["tools"].setdefault(tool, {"count": 0, "errors": 0})
        slot["count"] += n
        if tool in WEB_TOOLS:
            agg["web_searches"] += n
        if tool in SKILL_READ_TOOLS:
            agg["skill_loads"] += n
        if tool in SKILL_WRITE_TOOLS:
            agg["skills_created"] += n
    for mode, n in (row.modes or {}).items():
        agg["modes"][mode] = agg["modes"].get(mode, 0) + n


def _load_aggregates(db, shift: timedelta, cutoff, owner: str = None) -> dict:
    """{username: aggregate} across raw events + daily rollups."""
    aggs: dict = {}

    def bucket(name):
        # Not setdefault: it would build a throwaway aggregate on every one of
        # potentially 100k rows.
        key = name or ""
        got = aggs.get(key)
        if got is None:
            got = aggs[key] = _blank_agg()
        return got

    eq = db.query(UsageEvent)
    if cutoff is not None:
        eq = eq.filter(UsageEvent.ts >= cutoff)
    if owner is not None:
        eq = eq.filter(UsageEvent.owner == owner)
    for ev in eq.yield_per(5000):
        _fold_event(bucket(ev.owner), ev, shift)

    rq = db.query(UsageDaily)
    if cutoff is not None:
        rq = rq.filter(UsageDaily.day >= (cutoff + shift).date())
    if owner is not None:
        rq = rq.filter(UsageDaily.owner == owner)
    for row in rq.all():
        _fold_rollup(bucket(row.owner), row)

    return aggs


def setup_admin_usage_routes(auth_manager, session_manager):
    """`session_manager` is needed for the same reason the global wipe takes it:
    deleting a user's chats must also evict them from its in-memory cache."""
    router = APIRouter(prefix="/api/admin", tags=["admin-usage"])

    # ── Usage ──────────────────────────────────────────────────────────────

    @router.get("/usage/overview")
    def usage_overview(request: Request, tz_offset: int = 0, days: int = 30):
        """One summary row per known user, plus deployment totals and medians.

        Users with no activity in the window are included with zeroes — the
        list doubles as the user picker, so it must show everyone.
        """
        require_admin(request)
        shift, _today, cutoff = _window(days, tz_offset)
        db = SessionLocal()
        try:
            aggs = _load_aggregates(db, shift, cutoff)
            accounts = auth_manager.list_users() if auth_manager else []
            known = {a["username"] for a in accounts}
            # Activity from deleted accounts still occupies the window; surface
            # it rather than silently dropping tokens from the totals.
            for name in aggs:
                if name and name not in known:
                    accounts.append(
                        {
                            "username": name,
                            "display_name": None,
                            "is_admin": False,
                            "privileges": {},
                            "orphaned": True,
                        }
                    )

            rows = []
            for acc in accounts:
                a = aggs.get(acc["username"], _blank_agg())
                top = max(a["tools"].items(), key=lambda kv: kv[1]["count"], default=None)
                rows.append(
                    {
                        "username": acc["username"],
                        "display_name": acc.get("display_name"),
                        "is_admin": acc.get("is_admin", False),
                        "orphaned": acc.get("orphaned", False),
                        "turns": a["turns"],
                        "tool_calls": a["tool_calls"],
                        "tool_errors": a["tool_errors"],
                        "input_tokens": a["input_tokens"],
                        "output_tokens": a["output_tokens"],
                        "total_tokens": a["input_tokens"] + a["output_tokens"],
                        "sessions": len(a["sessions"]) + a["sessions_rolled"],
                        "active_days": len(a["active_days"]),
                        "web_searches": a["web_searches"],
                        "skill_loads": a["skill_loads"],
                        "skills_created": a["skills_created"],
                        "top_tool": top[0] if top else None,
                        "modes": a["modes"],
                        "last_active": a["last_active"].isoformat() if a["last_active"] else None,
                    }
                )

            rows.sort(key=lambda r: r["total_tokens"], reverse=True)
            for i, r in enumerate(rows):
                r["rank"] = i + 1

            models: dict = {}
            for a in aggs.values():
                for m, n in a["models"].items():
                    models[m] = models.get(m, 0) + n

            return {
                "days": days,
                "users": rows,
                "totals": {
                    "turns": sum(r["turns"] for r in rows),
                    "tool_calls": sum(r["tool_calls"] for r in rows),
                    "total_tokens": sum(r["total_tokens"] for r in rows),
                    "input_tokens": sum(r["input_tokens"] for r in rows),
                    "output_tokens": sum(r["output_tokens"] for r in rows),
                    "sessions": sum(r["sessions"] for r in rows),
                    "active_users": sum(1 for r in rows if r["turns"] > 0),
                },
                "median": {
                    "turns": _median([r["turns"] for r in rows]),
                    "total_tokens": _median([r["total_tokens"] for r in rows]),
                    "tool_calls": _median([r["tool_calls"] for r in rows]),
                },
                # The UI hides the model breakdown while this has one entry.
                "models": models,
            }
        finally:
            db.close()

    @router.get("/usage/user/{username}")
    def usage_user(username: str, request: Request, tz_offset: int = 0, days: int = 30):
        """Full detail for one user, including their standing against the rest."""
        require_admin(request)
        username = (username or "").strip().lower()
        shift, today, cutoff = _window(days, tz_offset)
        db = SessionLocal()
        try:
            # Everyone's aggregates: needed for rank/median, and it's the same
            # scan cost as loading one user on any realistic deployment.
            aggs = _load_aggregates(db, shift, cutoff)
            a = aggs.get(username, _blank_agg())

            start = today - timedelta(days=SERIES_DAYS - 1)
            daily = []
            for i in range(SERIES_DAYS):
                d = start + timedelta(days=i)
                b = a["daily"].get(d, {"turns": 0, "tokens": 0, "tools": 0})
                daily.append(
                    {
                        "date": d.isoformat(),
                        "turns": b["turns"],
                        "tokens": b["tokens"],
                        "tools": b["tools"],
                    }
                )

            tools = sorted(
                ({"tool": k, "count": v["count"], "errors": v["errors"]} for k, v in a["tools"].items()),
                key=lambda r: r["count"],
                reverse=True,
            )
            skills_used = sorted(
                ({"name": k, "count": v} for k, v in a["skills"].items()),
                key=lambda r: r["count"],
                reverse=True,
            )

            # Skills this user actually authored into the shared library —
            # counted from the library itself, not from tool calls, so it
            # reflects what still exists.
            from core.database import SharedSkill

            authored = [
                s.name
                for s in db.query(SharedSkill.name).filter(SharedSkill.uploaded_by == username).all()
            ]

            totals = [ag["input_tokens"] + ag["output_tokens"] for ag in aggs.values()]
            mine = a["input_tokens"] + a["output_tokens"]
            rank = sum(1 for t in totals if t > mine) + 1

            privileges = auth_manager.get_privileges(username) if auth_manager else {}
            daily_limit = int((privileges or {}).get("max_messages_per_day") or 0)
            limit_hit_days = (
                sum(1 for b in a["daily"].values() if b["turns"] >= daily_limit)
                if daily_limit > 0
                else 0
            )

            return {
                "username": username,
                "days": days,
                "tiles": {
                    "turns": a["turns"],
                    "tool_calls": a["tool_calls"],
                    "tool_errors": a["tool_errors"],
                    "input_tokens": a["input_tokens"],
                    "output_tokens": a["output_tokens"],
                    "total_tokens": mine,
                    "sessions": len(a["sessions"]) + a["sessions_rolled"],
                    "active_days": len(a["active_days"]),
                    "web_searches": a["web_searches"],
                    "skill_loads": a["skill_loads"],
                    "avg_tokens_per_turn": round(mine / a["turns"]) if a["turns"] else 0,
                    "peak_hour": max(range(24), key=lambda h: a["hours"][h])
                    if any(a["hours"])
                    else None,
                    "last_active": a["last_active"].isoformat() if a["last_active"] else None,
                },
                "daily": daily,
                "hours": a["hours"],
                "tools": tools,
                "modes": a["modes"],
                "models": a["models"],
                "skills": {"used": skills_used, "authored": authored},
                "comparison": {
                    "rank": rank,
                    "of": len(totals),
                    "median_tokens": _median(totals),
                    "median_turns": _median([ag["turns"] for ag in aggs.values()]),
                    "median_tools": _median([ag["tool_calls"] for ag in aggs.values()]),
                },
                "limit": {"max_messages_per_day": daily_limit, "hit_days": limit_hit_days},
            }
        finally:
            db.close()

    # ── Storage ────────────────────────────────────────────────────────────

    def _storage_categories(db, username: str) -> list:
        """Per-category footprint. `bytes` is an estimate for text-backed
        categories (sum of stored content length) and exact for gallery files
        (recorded file_size)."""
        msg_rows = (
            db.query(
                func.count(DbMessage.id),
                func.coalesce(func.sum(func.length(DbMessage.content)), 0),
            )
            .join(DbSession, DbMessage.session_id == DbSession.id)
            .filter(DbSession.owner == username)
            .one()
        )
        gallery = (
            db.query(
                func.count(GalleryImage.id),
                func.coalesce(func.sum(GalleryImage.file_size), 0),
            )
            .filter(GalleryImage.owner == username)
            .one()
        )
        docs = (
            db.query(
                func.count(Document.id),
                func.coalesce(func.sum(func.length(Document.current_content)), 0),
            )
            .filter(Document.owner == username)
            .one()
        )
        return [
            {
                "kind": "chats",
                "count": db.query(DbSession).filter(DbSession.owner == username).count(),
                "detail": f"{msg_rows[0]} messages",
                "bytes": int(msg_rows[1] or 0),
            },
            {
                "kind": "documents",
                "count": docs[0],
                "detail": None,
                "bytes": int(docs[1] or 0),
            },
            {
                "kind": "gallery",
                "count": gallery[0],
                "detail": None,
                "bytes": int(gallery[1] or 0),
            },
            {
                "kind": "notes",
                "count": db.query(Note).filter(Note.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
            {
                "kind": "tools",
                "count": db.query(UserTool).filter(UserTool.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
            {
                "kind": "drafts",
                "count": db.query(EditorDraft).filter(EditorDraft.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
            {
                "kind": "crew",
                "count": db.query(CrewMember).filter(CrewMember.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
            {
                "kind": "calendars",
                "count": db.query(CalendarCal).filter(CalendarCal.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
            {
                "kind": "comparisons",
                "count": db.query(Comparison).filter(Comparison.owner == username).count(),
                "detail": None,
                "bytes": 0,
            },
        ]

    @router.get("/storage/{username}")
    def storage_overview(username: str, request: Request):
        require_admin(request)
        username = (username or "").strip().lower()
        db = SessionLocal()
        try:
            cats = _storage_categories(db, username)
            return {
                "username": username,
                "categories": cats,
                "total_bytes": sum(c["bytes"] for c in cats),
                # Uploads live in a flat directory with no per-user subtree
                # (src/constants.py UPLOAD_DIR); they're only reachable through
                # the session that referenced them, so they are NOT attributed
                # here. Deleting a user's chats releases their attachments.
                "uploads_attributable": False,
            }
        finally:
            db.close()

    def _delete_gallery_files(filenames: list) -> None:
        """Best-effort removal of the image files behind gallery rows."""
        for base in ("gallery", "gallery_uploads"):
            root = os.path.join(DATA_DIR, base)
            for fn in filenames:
                if not fn:
                    continue
                # Guard against a stored filename escaping the gallery dir.
                path = os.path.realpath(os.path.join(root, os.path.basename(str(fn))))
                if not path.startswith(os.path.realpath(root) + os.sep):
                    continue
                try:
                    if os.path.isfile(path):
                        os.remove(path)
                except OSError as e:
                    logger.warning("Could not remove gallery file %s: %s", path, e)

    @router.delete("/storage/{username}/{kind}")
    def storage_delete(username: str, kind: str, request: Request):
        """Delete one category for one user. Usage history is intentionally
        untouched — the admin view must keep reporting on activity that
        happened, even after its artifacts are gone."""
        require_admin(request)
        username = (username or "").strip().lower()
        kind = (kind or "").strip().lower()
        db = SessionLocal()
        try:
            if kind == "chats":
                ids = [
                    s.id for s in db.query(DbSession.id).filter(DbSession.owner == username).all()
                ]
                count = len(ids)
                if ids:
                    db.query(DbMessage).filter(DbMessage.session_id.in_(ids)).delete(
                        synchronize_session=False
                    )
                    db.query(DbSession).filter(DbSession.owner == username).delete(
                        synchronize_session=False
                    )
                db.commit()
                # Drop the in-memory cache too, or the next /api/sessions
                # serves rows that no longer exist (same trap as the global wipe).
                for sid in ids:
                    try:
                        session_manager.sessions.pop(sid, None)
                    except Exception:
                        pass

            elif kind == "documents":
                doc_ids = [
                    d.id for d in db.query(Document.id).filter(Document.owner == username).all()
                ]
                count = len(doc_ids)
                if doc_ids:
                    db.query(DocumentVersion).filter(
                        DocumentVersion.document_id.in_(doc_ids)
                    ).delete(synchronize_session=False)
                    db.query(Document).filter(Document.owner == username).delete(
                        synchronize_session=False
                    )
                db.commit()

            elif kind == "gallery":
                files = [
                    r.filename
                    for r in db.query(GalleryImage.filename)
                    .filter(GalleryImage.owner == username)
                    .all()
                ]
                count = len(files)
                db.query(GalleryImage).filter(GalleryImage.owner == username).delete(
                    synchronize_session=False
                )
                db.query(GalleryAlbum).filter(GalleryAlbum.owner == username).delete(
                    synchronize_session=False
                )
                db.commit()
                _delete_gallery_files(files)

            elif kind == "calendars":
                cal_ids = [
                    c.id for c in db.query(CalendarCal.id).filter(CalendarCal.owner == username).all()
                ]
                count = len(cal_ids)
                if cal_ids:
                    db.query(CalendarEvent).filter(CalendarEvent.calendar_id.in_(cal_ids)).delete(
                        synchronize_session=False
                    )
                    db.query(CalendarCal).filter(CalendarCal.owner == username).delete(
                        synchronize_session=False
                    )
                db.commit()

            else:
                simple = {
                    "notes": Note,
                    "tools": UserTool,
                    "drafts": EditorDraft,
                    "crew": CrewMember,
                    "comparisons": Comparison,
                }
                model = simple.get(kind)
                if model is None:
                    raise HTTPException(400, f"Unknown storage kind: {kind!r}")
                count = db.query(model).filter(model.owner == username).count()
                db.query(model).filter(model.owner == username).delete(synchronize_session=False)
                db.commit()

            logger.info("Admin deleted %s for user %s (%d rows)", kind, username, count)
            return {"status": "deleted", "kind": kind, "username": username, "count": count}
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.exception("Per-user delete failed (%s/%s)", username, kind)
            raise HTTPException(500, f"Delete {kind} failed: {e}")
        finally:
            db.close()

    return router
