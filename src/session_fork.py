"""Forking a chat: an independent duplicate with everything the chat holds.

Covers the database side — session settings, message history, documents with
their versions, generated images and the Artifacts page's per-item state. The
sandbox workspace is forked separately (sandbox_client.fork_workspace).

Files are never duplicated on disk: a generated image gets a second name for the
same data through a hard link, so either chat can delete its image without
touching the other's, and the bytes go away with the last one. References in the
copied messages are rewritten to the fork's own ids, so its history points at its
own copies and not back at the source chat.
"""

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import inspect

from core.database import (
    ArtifactMeta,
    ChatMessage,
    Document,
    DocumentVersion,
    GalleryImage,
    SessionLocal,
)
from core.database import Session as DbSession
from src.generated_images import GENERATED_IMAGE_DIR


def _clone(row: Any, **overrides: Any) -> Any:
    """A new unsaved row with the same column values, except `overrides`."""
    values = {attr.key: getattr(row, attr.key) for attr in inspect(type(row)).column_attrs}
    values.update(overrides)
    return type(row)(**values)


def _link_or_copy(source: Path, target: Path) -> None:
    """Give `source` a second name; a real copy only where links are impossible."""
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _replacer(mapping: Dict[str, str]):
    """A function swapping every old id in a text for its new one, in one pass so
    a replacement can never be replaced again."""
    pattern = re.compile("|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True)))
    return lambda text: pattern.sub(lambda m: mapping[m.group(0)], text)


def fork_session_records(
    session_id: str,
    keep_count: Optional[int] = None,
    message_id: Optional[str] = None,
    before_message: bool = False,
) -> Dict[str, Any]:
    """Duplicate one chat's records. Raises KeyError if the chat, or the message
    asked for, does not exist.

    `message_id` ends the copy at that message, or just ahead of it with
    `before_message`; `keep_count` limits it to that many leading messages. Returns
    the new session's id, name, owner and message count.
    """
    new_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    linked: List[Path] = []
    db = SessionLocal()
    try:
        source = db.query(DbSession).filter(DbSession.id == session_id).first()
        if source is None:
            raise KeyError(session_id)
        owner = source.owner
        mapping = {session_id: new_id}
        new_rows: List[Any] = []

        for doc in db.query(Document).filter(Document.session_id == session_id).all():
            new_doc_id = str(uuid.uuid4())
            mapping[doc.id] = new_doc_id
            new_rows.append(_clone(doc, id=new_doc_id, session_id=new_id))
            for version in db.query(DocumentVersion).filter(DocumentVersion.document_id == doc.id):
                new_rows.append(_clone(version, id=str(uuid.uuid4()), document_id=new_doc_id))

        for image in db.query(GalleryImage).filter(GalleryImage.session_id == session_id).all():
            new_image_id = str(uuid.uuid4())
            # The filename is unique and part of the image's URL, so the fork's
            # row needs its own. Deleted images keep a row with no file behind it:
            # that row is what hides them from the fork's history as well.
            new_filename = f"{uuid.uuid4().hex[:12]}{Path(image.filename).suffix}"
            source_file = GENERATED_IMAGE_DIR / image.filename
            if source_file.is_file():
                target_file = GENERATED_IMAGE_DIR / new_filename
                _link_or_copy(source_file, target_file)
                linked.append(target_file)
            mapping[image.id] = new_image_id
            mapping[image.filename] = new_filename
            new_rows.append(
                _clone(image, id=new_image_id, filename=new_filename, session_id=new_id)
            )

        rewrite = _replacer(mapping)
        query = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.timestamp, ChatMessage.id)
        )
        messages = query.all()
        if message_id is not None:
            index = next((i for i, m in enumerate(messages) if m.id == message_id), None)
            if index is None:
                raise KeyError(message_id)
            messages = messages[: index if before_message else index + 1]
        elif keep_count is not None:
            messages = messages[: max(0, keep_count)]
        for index, message in enumerate(messages):
            # History is ordered by (timestamp, id). Ids that sort like the
            # originals keep messages sharing a timestamp in their order.
            new_message_id = f"{new_id}-{index:06d}"
            raw_meta = message.meta_data
            if raw_meta:
                meta = json.loads(rewrite(raw_meta))
                if isinstance(meta, dict) and "_db_id" in meta:
                    meta["_db_id"] = new_message_id
                raw_meta = json.dumps(meta)
            new_rows.append(
                _clone(
                    message,
                    id=new_message_id,
                    session_id=new_id,
                    content=rewrite(message.content or ""),
                    meta_data=raw_meta,
                )
            )

        fork_name = source.name
        new_rows.insert(
            0,
            _clone(
                source,
                id=new_id,
                forked_from=session_id,
                # A fork is a new chat: it starts unpinned and read, and lands at
                # the top of the list instead of where the source's age puts it.
                is_important=False,
                unread=False,
                archived=False,
                message_count=len(messages),
                created_at=now,
                updated_at=now,
                last_accessed=now,
                last_message_at=now if messages else None,
            ),
        )

        if owner:
            for meta_row in db.query(ArtifactMeta).filter(ArtifactMeta.owner == owner).all():
                new_key = _forked_artifact_key(meta_row.artifact_key, session_id, new_id, mapping)
                if new_key:
                    new_rows.append(_clone(meta_row, id=None, artifact_key=new_key))

        # The session row goes first: messages and documents point at it.
        db.add(new_rows[0])
        db.flush()
        db.add_all(new_rows[1:])
        db.commit()
    except Exception:
        db.rollback()
        for path in linked:
            path.unlink(missing_ok=True)
        raise
    finally:
        db.close()
    return {"id": new_id, "name": fork_name, "owner": owner, "message_count": len(messages)}


def _forked_artifact_key(
    key: str, session_id: str, new_id: str, mapping: Dict[str, str]
) -> Optional[str]:
    """The fork's ArtifactMeta key for one of the source chat's, else None."""
    if key.startswith(f"{session_id}/"):
        return f"{new_id}/{key[len(session_id) + 1:]}"
    for prefix in ("document:", "generated-image:"):
        if key.startswith(prefix):
            new_item = mapping.get(key[len(prefix) :])
            return f"{prefix}{new_item}" if new_item else None
    return None
