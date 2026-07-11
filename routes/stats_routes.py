# routes/stats_routes.py
"""Usage statistics for the empty-chat home screen.

Aggregates the requesting user's chat activity (sessions, messages, tokens,
streaks, activity heatmap) into one payload. Message timestamps are stored
naive-UTC; the client passes its timezone offset so day/hour buckets land on
the user's local calendar.
"""

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Request

from core.database import ChatMessage as DbMessage
from core.database import Session as DbSession
from core.database import SessionLocal
from src.auth_helpers import effective_user

# Days of daily counts returned for the activity heatmap (~26 weeks).
HEATMAP_DAYS = 26 * 7


def _streaks(days: set, today: date) -> tuple:
    """(current, longest) run of consecutive active days. The current streak
    is anchored to today, falling back to yesterday so it doesn't read 0
    before the first message of the day."""
    if not days:
        return 0, 0
    longest = run = 1
    ordered = sorted(days)
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if (cur - prev).days == 1 else 1
        longest = max(longest, run)
    anchor = today if today in days else today - timedelta(days=1)
    current = 0
    while anchor in days:
        current += 1
        anchor -= timedelta(days=1)
    return current, longest


def setup_stats_routes():
    router = APIRouter(prefix="/api", tags=["stats"])

    @router.get("/stats")
    def usage_stats(request: Request, tz_offset: int = 0, days: int = 0):
        """tz_offset: minutes east of UTC (JS `-getTimezoneOffset()`).
        days: restrict the tile stats to the last N local days (0 = all
        time). The heatmap is a calendar, so it always covers the full
        HEATMAP_DAYS window regardless of the filter.
        """
        user = effective_user(request)
        db = SessionLocal()
        try:
            sq = db.query(
                DbSession.id,
                DbSession.model,
                DbSession.message_count,
                DbSession.total_input_tokens,
                DbSession.total_output_tokens,
            )
            if user:
                sq = sq.filter(DbSession.owner == user)
            sessions = sq.all()
            tokens_by_session = {
                sid: (tin or 0) + (tout or 0) for sid, _m, _c, tin, tout in sessions
            }

            # Timestamps only — day/hour bucketing happens here in Python so
            # it works identically on SQLite and Postgres.
            mq = db.query(DbMessage.timestamp, DbMessage.session_id, DbSession.model).join(
                DbSession, DbMessage.session_id == DbSession.id
            )
            if user:
                mq = mq.filter(DbSession.owner == user)

            shift = timedelta(minutes=tz_offset)
            today = (datetime.utcnow() + shift).date()
            range_start = today - timedelta(days=days - 1) if days > 0 else None

            heat_counts = {}  # full window, filter-independent
            day_counts = {}  # within the requested range
            hour_counts = [0] * 24
            range_sessions = set()
            by_model = {}
            in_range_messages = 0
            for ts, sid, model in mq.all():
                if ts is None:
                    continue
                local = ts + shift
                d = local.date()
                heat_counts[d] = heat_counts.get(d, 0) + 1
                if range_start and d < range_start:
                    continue
                day_counts[d] = day_counts.get(d, 0) + 1
                hour_counts[local.hour] += 1
                in_range_messages += 1
                range_sessions.add(sid)
                if model:
                    by_model[model] = by_model.get(model, 0) + 1

            if range_start:
                # Token totals only exist per session, so a ranged view sums
                # the sessions active in the range (approximate by design).
                session_count = len(range_sessions)
                total_tokens = sum(tokens_by_session.get(sid, 0) for sid in range_sessions)
            else:
                session_count = len(sessions)
                total_tokens = sum(tokens_by_session.values())

            current_streak, longest_streak = _streaks(set(day_counts), today)

            start = today - timedelta(days=HEATMAP_DAYS - 1)
            daily = [
                {
                    "date": (start + timedelta(days=i)).isoformat(),
                    "count": heat_counts.get(start + timedelta(days=i), 0),
                }
                for i in range(HEATMAP_DAYS)
            ]

            return {
                "sessions": session_count,
                "messages": in_range_messages,
                "total_tokens": total_tokens,
                "active_days": len(day_counts),
                "current_streak": current_streak,
                "longest_streak": longest_streak,
                "peak_hour": max(range(24), key=lambda h: hour_counts[h])
                if any(hour_counts)
                else None,
                "favorite_model": max(by_model, key=by_model.get) if by_model else None,
                "daily": daily,
            }
        finally:
            db.close()

    return router
