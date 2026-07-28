#!/usr/bin/env python3
"""Rebuild `usage_events` from historic chat message metadata.

Before the usage_events table existed, the only record of a turn's tool calls
was the `tool_events` list inside `chat_messages.metadata` — a JSON blob that
also carries every tool's full output. This walks that history once and
materializes the indexed rows the admin usage view reads.

What survives the trip: timestamps, owner, session, model, token counts, tool
names, exit codes, and skill identifiers. What does NOT: the knowledge mode
(chat/knowledge/sql/full). Those came from per-request `use_rag`/`use_db`
flags that were never persisted, so backfilled turns carry `mode = NULL` and
the mode chart only fills in from the day this ships.

Usage:
    python scripts/backfill_usage_events.py            # dry run, prints totals
    python scripts/backfill_usage_events.py --commit   # write rows
    python scripts/backfill_usage_events.py --commit --reset

`--reset` empties usage_events first. Only use it to re-run the backfill: it
discards live-recorded rows too, and with them the knowledge-mode data that
cannot be reconstructed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.database import ChatMessage as DbMessage  # noqa: E402
from core.database import Session as DbSession  # noqa: E402
from core.database import SessionLocal, UsageEvent, init_db  # noqa: E402
from src.usage_tracking import _detail_for  # noqa: E402

# Commit in batches so a multi-100k-message history doesn't build one giant
# transaction in memory.
BATCH = 2000


def backfill(commit: bool, reset: bool) -> dict:
    db = SessionLocal()
    stats = {"messages": 0, "turns": 0, "tools": 0, "skipped_no_meta": 0}
    try:
        existing = db.query(UsageEvent).count()
        if existing and not reset:
            print(
                f"usage_events already holds {existing} rows — refusing to "
                f"double-count.\nRe-run with --reset to rebuild from scratch "
                f"(discards live-recorded knowledge modes)."
            )
            return stats
        if reset and commit:
            db.query(UsageEvent).delete()
            db.commit()
            print(f"Cleared {existing} existing rows.")

        rows = (
            db.query(
                DbMessage.timestamp,
                DbMessage.session_id,
                DbMessage.meta_data,
                DbSession.owner,
                DbSession.model,
                DbSession.mode,
            )
            .join(DbSession, DbMessage.session_id == DbSession.id)
            .filter(DbMessage.role == "assistant")
            .yield_per(BATCH)
        )

        pending = 0
        for ts, session_id, meta_raw, owner, sess_model, sess_mode in rows:
            stats["messages"] += 1
            if not meta_raw or ts is None:
                stats["skipped_no_meta"] += 1
                continue
            try:
                meta = json.loads(meta_raw)
            except (TypeError, ValueError):
                stats["skipped_no_meta"] += 1
                continue
            if not isinstance(meta, dict):
                stats["skipped_no_meta"] += 1
                continue

            duration = meta.get("response_time")
            db.add(
                UsageEvent(
                    ts=ts,
                    owner=owner,
                    session_id=session_id,
                    kind="turn",
                    model=meta.get("model") or sess_model,
                    mode=None,  # unrecoverable — see the module docstring
                    session_mode=sess_mode,
                    input_tokens=int(meta.get("input_tokens") or 0),
                    output_tokens=int(meta.get("output_tokens") or 0),
                    duration_ms=int(float(duration) * 1000) if duration else None,
                )
            )
            stats["turns"] += 1
            pending += 1

            for ev in meta.get("tool_events") or []:
                if not isinstance(ev, dict):
                    continue
                tool = str(ev.get("tool") or "").strip()
                if not tool:
                    continue
                exit_code = ev.get("exit_code")
                db.add(
                    UsageEvent(
                        ts=ts,
                        owner=owner,
                        session_id=session_id,
                        kind="tool",
                        model=meta.get("model") or sess_model,
                        tool=tool,
                        ok=exit_code in (None, 0),
                        detail=_detail_for(tool, ev.get("command")),
                    )
                )
                stats["tools"] += 1
                pending += 1

            if commit and pending >= BATCH:
                db.commit()
                pending = 0

        if commit:
            db.commit()
        else:
            db.rollback()
        return stats
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--commit", action="store_true", help="actually write rows")
    ap.add_argument("--reset", action="store_true", help="empty usage_events first")
    args = ap.parse_args()

    init_db()
    stats = backfill(commit=args.commit, reset=args.reset)
    mode = "WROTE" if args.commit else "DRY RUN — nothing written"
    print(
        f"{mode}\n"
        f"  assistant messages scanned : {stats['messages']}\n"
        f"  without usable metadata    : {stats['skipped_no_meta']}\n"
        f"  turn rows                  : {stats['turns']}\n"
        f"  tool rows                  : {stats['tools']}"
    )
    if not args.commit:
        print("\nRe-run with --commit to persist.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
