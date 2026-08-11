"""Support ticket routes — /api/tickets/*.

Users file a ticket (title + free text + any number of their own chats) from the
sidebar; admins triage them in the /tickets workspace. Attached chats are frozen
snapshots taken at submit time, so an admin reads exactly what the reporter sent
and nothing else out of that user's history.

A snapshot is the WHOLE chat as the reporter saw it: not just the words, but the
model's reasoning, every tool call with its command/output/diff, RAG citations,
the files the user attached and the artifacts the chat produced. Triaging a bug
report about an agent run is impossible from the prose alone — what went wrong is
almost always in the tool rows.

Everything the transcript points at (generated images, workspace files) is served
back through this router under an opaque per-attachment ref, validated against the
map frozen at submit time. That keeps the reach of an admin's read exactly equal
to what the ticket froze: no other route's ownership rules are widened, and a
ticket can never become a handle on the rest of a user's data.
"""

import json
import logging
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import func

from core.database import ChatMessage as DbChatMessage
from core.database import Document, GalleryImage, Ticket, TicketAttachment, get_db_session
from core.database import Session as DbSession
from core.middleware import require_admin
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

MAX_TITLE_LEN = 200
MAX_BODY_LEN = 20000
MAX_ATTACHMENTS = 20
THINK_RE = re.compile(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", re.IGNORECASE)
THINK_CAPTURE_RE = re.compile(r"<think(?:ing)?>([\s\S]*?)</think(?:ing)?>", re.IGNORECASE)

# The current snapshot format: full {role, content, metadata} messages. Format 1
# rows (flat {role, content, timestamp}) predate it and are still readable.
SNAPSHOT_FORMAT = 2

# Metadata keys carried into a snapshot. An allow-list rather than the whole blob:
# the metadata a message accumulates also holds internal bookkeeping that has no
# business in an admin's read, and a new writer adding a key should not silently
# widen what a ticket exposes.
SNAPSHOT_META_KEYS = (
    "timestamp",
    # What the turn produced, round by round: reasoning, interim text, tool calls.
    "thinking",
    "thinking_time",
    "round_texts",
    "tool_events",
    # What it drew on, and what the user put in.
    "rag_sources",
    "research_sources",
    "research_clarification",
    "attachments",
    "artifact_selection",
    # How it ran — the numbers the message-metrics row shows.
    "model",
    "character_name",
    "response_time",
    "tokens_per_second",
    "input_tokens",
    "output_tokens",
    "context_percent",
    "context_length",
    "context_tokens",
    "usage_source",
    "edited",
)

# URLs inside a transcript that an admin cannot fetch directly — the routes that
# serve them are scoped to the file's owner, by design. Each match is rewritten to
# a ticket-scoped ref (see the module docstring).
_MEDIA_URL_PATTERNS = (
    (re.compile(r"/api/generated-image/([A-Za-z0-9._\-]+)"), "generated_image"),
    (re.compile(r"/api/artifacts/[^/\s\"'()]+/download\?path=([^\s\"'()&]+)"), "artifact"),
)


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


class _MediaMap:
    """Collects the resources a snapshot references, keyed by opaque ref.

    Refs are per-attachment and mean nothing outside it, so a URL copied out of
    one ticket cannot be replayed against another."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.entries: dict[str, dict[str, str]] = {}
        self._by_value: dict[tuple[str, str], str] = {}

    def ref(self, kind: str, value: str) -> str:
        key = (kind, value)
        existing = self._by_value.get(key)
        if existing:
            return existing
        ref = f"m{len(self.entries) + 1}"
        self.entries[ref] = {"kind": kind, "value": value}
        self._by_value[key] = ref
        return ref

    def url(self, kind: str, value: str) -> str:
        return f"{self.base_url}?ref={self.ref(kind, value)}"


def _rewrite_media(payload: Any, media: _MediaMap) -> Any:
    """Point every owner-scoped URL in the snapshot at this attachment's proxy.

    Runs over the serialized snapshot rather than walking it field by field:
    these URLs turn up in markdown answers, tool output, image fields and RAG
    citations alike, and a walker that knew only today's fields would quietly
    miss tomorrow's."""
    raw = json.dumps(payload, ensure_ascii=False)
    for pattern, kind in _MEDIA_URL_PATTERNS:
        raw = pattern.sub(lambda m, k=kind: media.url(k, m.group(1)), raw)
    return json.loads(raw)


def _workspace_owners(session_row: DbSession, caller: str | None) -> list[str]:
    """Sandbox owners to try for a chat's workspace — mirrors the artifacts route,
    including its legacy null-owner fallback."""
    owner = session_row.owner or caller or "anonymous"
    owners = [owner]
    if not session_row.owner and owner != "anonymous":
        owners.append("anonymous")
    return owners


async def _list_session_artifacts(db, session_id: str, owners: list[str]) -> list[dict[str, Any]]:
    """The chat's output files: living documents, generated images and whatever
    is in its sandbox workspace. Same shape the artifacts panel renders from.

    Sandbox failures degrade to the DB-backed rows instead of failing the ticket:
    a snapshot missing some files is far better than a bug report the user could
    not file at all."""
    from routes.document_routes import document_artifact, gallery_artifact

    artifacts: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        from src.sandbox_client import list_artifacts, sandbox_enabled

        if sandbox_enabled():
            for owner in owners:
                try:
                    for artifact in await list_artifacts(owner=owner, session_id=session_id):
                        path = str(artifact.get("path") or "")
                        if path and path not in seen:
                            seen.add(path)
                            artifact.setdefault("source", "workspace")
                            artifacts.append(artifact)
                    break
                except Exception as e:
                    logger.warning("ticket artifact list failed (%s): %s", owner, e)
    except Exception as e:  # sandbox client unavailable entirely
        logger.warning("ticket artifact list unavailable for %s: %s", session_id, e)

    for doc in db.query(Document).filter(Document.session_id == session_id).all():
        artifacts.append(document_artifact(doc))
    for image in db.query(GalleryImage).filter(GalleryImage.session_id == session_id).all():
        artifacts.append(gallery_artifact(image))
    artifacts.sort(key=lambda item: float(item.get("mtime") or 0), reverse=True)
    return artifacts


def _partial_turn(session_id: str) -> dict[str, Any] | None:
    """The in-flight assistant turn, in the shape a finished one is stored in.

    A turn's assistant row is written only when the run FINISHES. Reporting a
    problem while the agent is still working — the most common moment to file a
    ticket — would otherwise attach the question with no answer under it, even
    though the reporter was looking at a screen full of streamed text, tool rows
    and reasoning. Everything the run buffer has is taken and marked partial."""
    try:
        from src import agent_runs

        if not agent_runs.is_active(session_id):
            return None
        snapshot = agent_runs.partial_snapshot(session_id) or {}
    except Exception as e:  # never let a snapshot fail over the live extra
        logger.warning("could not attach in-flight turn for %s: %s", session_id, e)
        return None

    round_texts = snapshot.get("round_texts") or []
    tool_events = snapshot.get("tool_events") or []
    if not snapshot.get("content") and not round_texts and not tool_events:
        return None
    metadata: dict[str, Any] = {"timestamp": datetime.now(timezone.utc).isoformat()}
    if len(round_texts) > 1:
        metadata["round_texts"] = round_texts
    if snapshot.get("thinking"):
        metadata["thinking"] = snapshot["thinking"]
    if tool_events:
        metadata["tool_events"] = tool_events
    return {
        "role": "assistant",
        "content": snapshot.get("content") or "",
        "metadata": metadata,
        "partial": True,
    }


async def _snapshot_session(
    db,
    session_id: str,
    owner: str | None,
    media: _MediaMap,
) -> dict[str, Any]:
    """Freeze one chat the caller owns — messages, reasoning, tool calls and the
    files it produced — into a self-contained record."""
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
        # Hidden rows are the compaction summaries written for the model's
        # context. The reporter never saw them, so neither does the admin.
        if meta.get("hidden"):
            continue
        snapshot_meta = {k: meta[k] for k in SNAPSHOT_META_KEYS if k in meta}
        if m.timestamp and "timestamp" not in snapshot_meta:
            snapshot_meta["timestamp"] = m.timestamp.isoformat() + "Z"
        transcript.append(
            {"role": m.role, "content": m.content or "", "metadata": snapshot_meta}
        )

    partial = _partial_turn(session_id)
    if partial:
        transcript.append(partial)

    owners = _workspace_owners(row, owner)
    artifacts = await _list_session_artifacts(db, session_id, owners)
    for artifact in artifacts:
        path = str(artifact.get("path") or "")
        if path:
            artifact["media_ref"] = media.ref("artifact", path)

    return {
        "session_id": session_id,
        "session_name": row.name or "",
        "owner": row.owner,
        "transcript": _rewrite_media(transcript, media),
        "artifacts": artifacts,
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
                "artifact_count": len(_json_list(a.artifacts)),
                "format_version": a.format_version or 1,
            }
            for a in attachments
        ],
    }


def _json_list(raw: str | None) -> list:
    try:
        value = json.loads(raw or "[]")
    except (json.JSONDecodeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _json_obj(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (json.JSONDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _rounds_for_export(msg: dict) -> list[str]:
    """Per-round text of one assistant message, reasoning still inline."""
    meta = msg.get("metadata") or {}
    rounds = meta.get("round_texts")
    if isinstance(rounds, list) and rounds:
        return [str(r or "") for r in rounds]
    thinking = meta.get("thinking")
    prefix = f"<think>{thinking}</think>\n\n" if thinking else ""
    return [prefix + str(msg.get("content") or "")]


def _tool_markdown(events: list, round_num: int | None = None) -> list[str]:
    """Tool calls as fenced blocks — command, exit code, output, diff."""
    lines: list[str] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        if round_num is not None and event.get("round") not in (None, round_num):
            continue
        exit_code = event.get("exit_code")
        header = f"**{event.get('tool', 'tool')}**"
        if exit_code not in (None, 0):
            header += f" — exit {exit_code}"
        lines.extend(["", header, ""])
        if event.get("command"):
            lines.extend(["```", str(event["command"]).strip(), "```", ""])
        if event.get("output"):
            lines.extend(["```", str(event["output"]).strip(), "```", ""])
        if event.get("diff"):
            lines.extend(["```diff", str(event["diff"]).strip(), "```", ""])
        if event.get("image_url"):
            lines.extend([f"![{event.get('image_prompt') or 'image'}]({event['image_url']})", ""])
    return lines


def _transcript_markdown(ticket: Ticket, attachment: TicketAttachment) -> str:
    """The whole snapshot as one readable file — the same detail the viewer
    shows, so a ticket can be forwarded or archived outside the app."""
    transcript = _json_list(attachment.transcript)
    artifacts = _json_list(attachment.artifacts)
    lines = [
        f"# {attachment.session_name or 'Chat'}",
        "",
        f"Ticket: {ticket.title} ({ticket.id})",
        f"Reported by: {ticket.created_by or 'unknown'}",
        "",
        "---",
        "",
    ]
    legacy = (attachment.format_version or 1) < SNAPSHOT_FORMAT
    for msg in transcript:
        role = str(msg.get("role", "")).capitalize() or "Message"
        meta = msg.get("metadata") or {}
        stamp = meta.get("timestamp") or msg.get("timestamp")
        lines.append(f"## {role}" + (f" — {stamp}" if stamp else ""))
        lines.append("")
        if msg.get("partial"):
            lines.append(
                "> Still being generated when the ticket was filed — "
                "this is the turn as far as it had streamed."
            )
            lines.append("")
        if legacy:
            text = _display_text(str(msg.get("role") or ""), str(msg.get("content") or ""), meta)
            lines.extend([text.strip(), ""])
            continue

        attached = meta.get("attachments")
        if isinstance(attached, list) and attached:
            names = [str((f or {}).get("name") or (f or {}).get("id") or "") for f in attached]
            lines.extend(["_Attached: " + ", ".join(n for n in names if n) + "_", ""])

        if msg.get("role") != "assistant":
            lines.extend([str(msg.get("content", "")).strip(), ""])
            continue

        tool_events = meta.get("tool_events") if isinstance(meta.get("tool_events"), list) else []
        rounds = _rounds_for_export(msg)
        for i, round_text in enumerate(rounds, start=1):
            if len(rounds) > 1:
                lines.extend([f"### Round {i}", ""])
            for thought in THINK_CAPTURE_RE.findall(round_text):
                thought = thought.strip()
                if thought:
                    lines.extend(["**Reasoning**", "", "> " + thought.replace("\n", "\n> "), ""])
            text = THINK_RE.sub("", round_text).strip()
            if text:
                lines.extend([text, ""])
            lines.extend(_tool_markdown(tool_events, i if len(rounds) > 1 else None))
        sources = meta.get("rag_sources")
        if isinstance(sources, list) and sources:
            lines.extend(["**Knowledge sources**", ""])
            for source in sources:
                if isinstance(source, dict):
                    lines.append(f"- {source.get('filename') or source.get('source') or 'unknown'}")
            lines.append("")

    if artifacts:
        lines.extend(["---", "", "## Files produced by this chat", ""])
        for artifact in artifacts:
            if isinstance(artifact, dict):
                size = artifact.get("size")
                suffix = f" ({size} bytes)" if isinstance(size, int) else ""
                lines.append(f"- {artifact.get('name') or artifact.get('path')}{suffix}")
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
            snapshots = []
            for sid in session_ids:
                attachment_id = str(uuid.uuid4())[:12]
                media = _MediaMap(f"/api/tickets/{ticket_id}/attachments/{attachment_id}/media")
                snapshot = await _snapshot_session(db, sid, user, media)
                snapshot["id"] = attachment_id
                snapshot["media"] = media.entries
                snapshots.append(snapshot)
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
                        id=snap["id"],
                        ticket_id=ticket_id,
                        session_id=snap["session_id"],
                        session_name=snap["session_name"],
                        message_count=len(snap["transcript"]),
                        transcript=json.dumps(snap["transcript"], ensure_ascii=False),
                        format_version=SNAPSHOT_FORMAT,
                        owner=snap["owner"],
                        artifacts=json.dumps(snap["artifacts"], ensure_ascii=False),
                        media=json.dumps(snap["media"], ensure_ascii=False),
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
        """The frozen chat, for the in-app viewer: messages with their reasoning
        and tool calls, plus the files the chat produced."""
        require_admin(request)
        with get_db_session() as db:
            attachment = _load_attachment(db, ticket_id, attachment_id)
            return {
                "id": attachment.id,
                "session_id": attachment.session_id,
                "session_name": attachment.session_name or "",
                "message_count": attachment.message_count or 0,
                "format_version": attachment.format_version or 1,
                "transcript": _json_list(attachment.transcript),
                "artifacts": _json_list(attachment.artifacts),
            }

    @router.get("/{ticket_id}/attachments/{attachment_id}/media")
    async def get_attachment_media(
        request: Request, ticket_id: str, attachment_id: str, ref: str, mode: str = "inline"
    ):
        """Serve one resource this snapshot froze a reference to.

        `ref` is only ever a key into this attachment's own map — nothing the
        caller passes is used as a path, so an admin reading a ticket cannot
        reach past what the reporter attached."""
        require_admin(request)
        if mode not in ("inline", "render", "download"):
            raise HTTPException(400, "Unknown mode")
        with get_db_session() as db:
            attachment = _load_attachment(db, ticket_id, attachment_id)
            entry = _json_obj(attachment.media).get(ref)
            if not isinstance(entry, dict):
                raise HTTPException(404, "Not found")
            kind = entry.get("kind")
            value = str(entry.get("value") or "")
            owner = attachment.owner
            session_id = attachment.session_id

            if kind == "generated_image":
                from src.generated_images import resolve_generated_image_path

                try:
                    content = resolve_generated_image_path(value).read_bytes()
                except OSError:
                    raise HTTPException(404, "Not found")
                mime = mimetypes.guess_type(value)[0] or "image/png"
                return _media_response(content, mime, value, mode)

            if kind != "artifact":
                raise HTTPException(404, "Not found")

            # Documents and gallery images live in the database; everything else
            # is a file in the chat's sandbox workspace.
            if value.startswith("document:"):
                from routes.document_routes import document_artifact

                doc = (
                    db.query(Document)
                    .filter(Document.id == value.split(":", 1)[1], Document.session_id == session_id)
                    .first()
                )
                if not doc:
                    raise HTTPException(404, "Not found")
                info = document_artifact(doc)
                return _media_response(
                    (doc.current_content or "").encode("utf-8"), info["mime"], info["name"], mode
                )
            if value.startswith("generated-image:"):
                from src.generated_images import resolve_generated_image_path

                image = (
                    db.query(GalleryImage)
                    .filter(
                        GalleryImage.id == value.split(":", 1)[1],
                        GalleryImage.session_id == session_id,
                    )
                    .first()
                )
                if not image:
                    raise HTTPException(404, "Not found")
                try:
                    content = resolve_generated_image_path(image.filename).read_bytes()
                except OSError:
                    raise HTTPException(404, "Not found")
                mime = mimetypes.guess_type(image.filename)[0] or "image/png"
                return _media_response(content, mime, image.filename, mode)

        from src.sandbox_client import download_artifact, sandbox_enabled

        if not sandbox_enabled():
            raise HTTPException(404, "Sandbox not available")
        owners = [owner] if owner else ["anonymous"]
        if owner:
            owners.append("anonymous")
        last_error: Exception | None = None
        for candidate in owners:
            try:
                content, ctype, fname = await download_artifact(
                    owner=candidate, session_id=session_id, path=value
                )
                return _media_response(content, ctype, fname, mode)
            except Exception as e:
                last_error = e
        logger.warning("ticket media fetch failed for %s (%s): %s", ticket_id, value, last_error)
        raise HTTPException(404, "File no longer available")

    def _media_response(content: bytes, mime: str, filename: str, mode: str) -> Response:
        """Serve frozen bytes. `render` is for HTML artifacts opened as a page —
        model-generated markup, so it runs under the same no-network CSP the
        chat's own preview uses."""
        if mode == "render":
            return Response(
                content=content,
                media_type="text/html; charset=utf-8",
                headers={
                    "Content-Disposition": "inline",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": (
                        "default-src 'none'; "
                        "script-src 'unsafe-inline' 'unsafe-eval'; "
                        "style-src 'unsafe-inline'; "
                        "img-src data: blob:; "
                        "font-src data:; "
                        "connect-src 'none'; "
                        "form-action 'none'; "
                        "base-uri 'none'"
                    ),
                },
            )
        # Viewable types open in place; anything else downloads, so a click on an
        # .xlsx doesn't dump binary into the browser.
        viewable = (mime or "").startswith(("image/", "text/")) or mime == "application/pdf"
        disp = "inline" if mode == "inline" and viewable else "attachment"
        safe = re.sub(r"[^\w.\-]+", "_", filename or "file").strip("_") or "file"
        return Response(
            content=content,
            media_type=mime or "application/octet-stream",
            headers={
                "Content-Disposition": f'{disp}; filename="{safe}"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

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
                content = json.dumps(
                    {
                        "session_id": attachment.session_id,
                        "session_name": attachment.session_name or "",
                        "format_version": attachment.format_version or 1,
                        "transcript": _json_list(attachment.transcript),
                        "artifacts": _json_list(attachment.artifacts),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
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
