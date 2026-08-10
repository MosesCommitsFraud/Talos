"""Support ticket routes — /api/tickets/*.

Users file a ticket (title + free text + any number of their own chats) from the
sidebar; admins triage them in the /tickets workspace. Attached chats are frozen
snapshots taken at submit time, so an admin reads exactly what the reporter sent
and nothing else out of that user's history.
"""

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import func

from core.database import ChatMessage as DbChatMessage
from core.database import Session as DbSession
from core.database import Ticket, TicketAttachment, get_db_session
from core.middleware import require_admin
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

MAX_TITLE_LEN = 200
MAX_BODY_LEN = 20000
MAX_ATTACHMENTS = 20
THINK_RE = re.compile(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", re.IGNORECASE)


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _display_text(role: str, content: str, meta: dict) -> str:
    """The text a reader should see for one persisted message.

    A multi-round agent turn is stored as a single assistant row whose `content`
    is only the final answer; the per-round text lives in `round_texts`. Mirror
    the chat UI and join the rounds, dropping inline `<think>` blocks.
    """
    if role == "assistant":
        rounds = meta.get("round_texts")
        if isinstance(rounds, list) and len(rounds) > 1:
            parts = [THINK_RE.sub("", str(r or "")).strip() for r in rounds]
            joined = "\n\n".join(p for p in parts if p)
            if joined:
                return joined
    return content or ""


def _snapshot_session(db, session_id: str, owner: str | None) -> dict[str, Any]:
    """Freeze one chat the caller owns into a plain transcript."""
    row = db.query(DbSession).filter(DbSession.id == session_id).first()
    if row is None:
        raise HTTPException(404, f"Chat {session_id} not found")
    # Ownership is checked here rather than trusting the client's list: a ticket
    # must never become a way to pull someone else's chat into an admin's view.
    if owner is not None and row.owner != owner:
        raise HTTPException(404, f"Chat {session_id} not found")

    messages = (
        db.query(DbChatMessage)
        .filter(DbChatMessage.session_id == session_id)
        .order_by(DbChatMessage.timestamp, DbChatMessage.id)
        .all()
    )
    transcript = []
    for m in messages:
        meta = {}
        if m.meta_data:
            try:
                meta = json.loads(m.meta_data) or {}
            except (json.JSONDecodeError, ValueError):
                meta = {}
        if meta.get("hidden"):
            continue
        transcript.append(
            {
                "role": m.role,
                "content": _display_text(m.role, m.content, meta),
                "timestamp": _iso(m.timestamp),
            }
        )

    # A turn's assistant row is written only when the run FINISHES. Reporting a
    # problem while the agent is still working — the most common moment to file
    # a ticket — would otherwise attach the question with no answer under it,
    # even though the reporter was looking at a screen full of streamed text.
    # Take the in-flight answer from the run buffer and mark it as partial.
    try:
        from src import agent_runs

        if agent_runs.is_active(session_id):
            partial = agent_runs.partial_text(session_id)
            if partial:
                transcript.append(
                    {
                        "role": "assistant",
                        "content": partial,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "partial": True,
                    }
                )
    except Exception as e:  # never let a snapshot fail over the live extra
        logger.warning("could not attach in-flight answer for %s: %s", session_id, e)

    return {
        "session_id": session_id,
        "session_name": row.name or "",
        "transcript": transcript,
    }


def _ticket_dict(ticket: Ticket, attachments: list[TicketAttachment]) -> dict[str, Any]:
    return {
        "id": ticket.id,
        "title": ticket.title,
        "body": ticket.body or "",
        "status": ticket.status,
        "created_by": ticket.created_by,
        "created_at": _iso(ticket.created_at),
        "updated_at": _iso(ticket.updated_at),
        "resolved_at": _iso(ticket.resolved_at),
        "resolved_by": ticket.resolved_by,
        "attachments": [
            {
                "id": a.id,
                "session_id": a.session_id,
                "session_name": a.session_name or "",
                "message_count": a.message_count or 0,
            }
            for a in attachments
        ],
    }


def _transcript_markdown(ticket: Ticket, attachment: TicketAttachment) -> str:
    try:
        transcript = json.loads(attachment.transcript or "[]")
    except (json.JSONDecodeError, ValueError):
        transcript = []
    lines = [
        f"# {attachment.session_name or 'Chat'}",
        "",
        f"Ticket: {ticket.title} ({ticket.id})",
        f"Reported by: {ticket.created_by or 'unknown'}",
        "",
        "---",
        "",
    ]
    for msg in transcript:
        role = str(msg.get("role", "")).capitalize() or "Message"
        stamp = msg.get("timestamp")
        lines.append(f"## {role}" + (f" — {stamp}" if stamp else ""))
        lines.append("")
        if msg.get("partial"):
            lines.append(
                "> Still being generated when the ticket was filed — "
                "this is the answer as far as it had streamed."
            )
            lines.append("")
        lines.append(str(msg.get("content", "")).strip())
        lines.append("")
    return "\n".join(lines)


def setup_ticket_routes() -> APIRouter:
    router = APIRouter(prefix="/api/tickets", tags=["tickets"])

    @router.post("")
    async def create_ticket(request: Request):
        user = effective_user(request)
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        title = str(payload.get("title") or "").strip()[:MAX_TITLE_LEN]
        if not title:
            raise HTTPException(400, "A title is required")
        body = str(payload.get("body") or "").strip()[:MAX_BODY_LEN]
        raw_ids = payload.get("session_ids")
        session_ids: list[str] = []
        if isinstance(raw_ids, list):
            for sid in raw_ids:
                sid = str(sid or "").strip()
                if sid and sid not in session_ids:
                    session_ids.append(sid)
        if len(session_ids) > MAX_ATTACHMENTS:
            raise HTTPException(400, f"At most {MAX_ATTACHMENTS} chats can be attached")

        ticket_id = str(uuid.uuid4())[:8]
        with get_db_session() as db:
            snapshots = [_snapshot_session(db, sid, user) for sid in session_ids]
            db.add(
                Ticket(
                    id=ticket_id,
                    title=title,
                    body=body,
                    status="open",
                    created_by=user,
                )
            )
            for snap in snapshots:
                db.add(
                    TicketAttachment(
                        id=str(uuid.uuid4())[:12],
                        ticket_id=ticket_id,
                        session_id=snap["session_id"],
                        session_name=snap["session_name"],
                        message_count=len(snap["transcript"]),
                        transcript=json.dumps(snap["transcript"], ensure_ascii=False),
                    )
                )
        return {"id": ticket_id, "status": "open", "attachments": len(session_ids)}

    @router.get("")
    def list_tickets(request: Request, status: str = "open"):
        require_admin(request)
        if status not in ("open", "archived", "all"):
            raise HTTPException(400, "Unknown status filter")
        with get_db_session() as db:
            query = db.query(Ticket)
            if status != "all":
                query = query.filter(Ticket.status == status)
            tickets = query.order_by(Ticket.created_at.desc()).all()
            counts = dict(
                db.query(TicketAttachment.ticket_id, func.count(TicketAttachment.id))
                .group_by(TicketAttachment.ticket_id)
                .all()
            )
            return [
                {
                    "id": t.id,
                    "title": t.title,
                    "body": t.body or "",
                    "status": t.status,
                    "created_by": t.created_by,
                    "created_at": _iso(t.created_at),
                    "resolved_at": _iso(t.resolved_at),
                    "resolved_by": t.resolved_by,
                    "attachment_count": counts.get(t.id, 0),
                }
                for t in tickets
            ]

    @router.get("/{ticket_id}")
    def get_ticket(request: Request, ticket_id: str):
        require_admin(request)
        with get_db_session() as db:
            ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
            if not ticket:
                raise HTTPException(404, "Ticket not found")
            attachments = (
                db.query(TicketAttachment)
                .filter(TicketAttachment.ticket_id == ticket_id)
                .order_by(TicketAttachment.created_at)
                .all()
            )
            return _ticket_dict(ticket, attachments)

    def _load_attachment(db, ticket_id: str, attachment_id: str):
        attachment = (
            db.query(TicketAttachment)
            .filter(
                TicketAttachment.id == attachment_id,
                TicketAttachment.ticket_id == ticket_id,
            )
            .first()
        )
        if not attachment:
            raise HTTPException(404, "Attachment not found")
        return attachment

    @router.get("/{ticket_id}/attachments/{attachment_id}")
    def get_attachment(request: Request, ticket_id: str, attachment_id: str):
        """The frozen transcript, for the in-app chat viewer."""
        require_admin(request)
        with get_db_session() as db:
            attachment = _load_attachment(db, ticket_id, attachment_id)
            try:
                transcript = json.loads(attachment.transcript or "[]")
            except (json.JSONDecodeError, ValueError):
                transcript = []
            return {
                "id": attachment.id,
                "session_id": attachment.session_id,
                "session_name": attachment.session_name or "",
                "message_count": attachment.message_count or 0,
                "transcript": transcript,
            }

    @router.get("/{ticket_id}/attachments/{attachment_id}/download")
    def download_attachment(
        request: Request, ticket_id: str, attachment_id: str, format: str = "md"
    ):
        require_admin(request)
        if format not in ("md", "json"):
            raise HTTPException(400, "Unknown format")
        with get_db_session() as db:
            ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
            if not ticket:
                raise HTTPException(404, "Ticket not found")
            attachment = _load_attachment(db, ticket_id, attachment_id)
            if format == "json":
                content = attachment.transcript or "[]"
                media = "application/json"
            else:
                content = _transcript_markdown(ticket, attachment)
                media = "text/markdown; charset=utf-8"
            stem = re.sub(r"[^\w.-]+", "_", attachment.session_name or "chat").strip("_") or "chat"
            filename = f"{stem}-{attachment.id}.{format}"
        return Response(
            content=content,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @router.patch("/{ticket_id}")
    async def update_ticket(request: Request, ticket_id: str):
        """Mark a ticket done (status='archived') or put it back on the pile."""
        require_admin(request)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        status = str(payload.get("status") or "").strip()
        if status not in ("open", "archived"):
            raise HTTPException(400, "status must be 'open' or 'archived'")
        admin = effective_user(request)
        with get_db_session() as db:
            ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
            if not ticket:
                raise HTTPException(404, "Ticket not found")
            ticket.status = status
            if status == "archived":
                ticket.resolved_at = datetime.now(timezone.utc).replace(tzinfo=None)
                ticket.resolved_by = admin
            else:
                ticket.resolved_at = None
                ticket.resolved_by = None
            db.add(ticket)
            attachments = (
                db.query(TicketAttachment)
                .filter(TicketAttachment.ticket_id == ticket_id)
                .order_by(TicketAttachment.created_at)
                .all()
            )
            return _ticket_dict(ticket, attachments)

    @router.delete("/{ticket_id}")
    def delete_ticket(request: Request, ticket_id: str):
        require_admin(request)
        with get_db_session() as db:
            deleted = db.query(Ticket).filter(Ticket.id == ticket_id).delete()
            if not deleted:
                raise HTTPException(404, "Ticket not found")
        return {"status": "deleted"}

    return router
