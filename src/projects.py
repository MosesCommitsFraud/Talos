"""projects.py — a shared place for chats.

A project has a creator and members. Every member sees every chat in it, whoever
started it, and can read them; only a chat's owner can write in it. All its chats
work in one sandbox workspace and with one memory, so what one chat creates is there
for the next. The creator alone manages the members and the project itself.

The workspace belongs to a sandbox account of its own (`project:<id>`, which no
username can collide with, see routes/auth_routes.py), and src/sandbox_client.py
sends every call for a project chat there. `project:<id>` also works in place of a
chat id at the artifact routes, for files nobody's chat can be named for.

Someone who leaves or is removed loses the project, their own chats in it included:
those chats would otherwise keep running in its workspace. The chats stay listed for
the others, and return to their owner when they are added again.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func

from core.database import Project, ProjectMember, SessionLocal
from core.database import Session as DbSession

logger = logging.getLogger(__name__)

REF_PREFIX = "project:"
WORKSPACE_CHAT_ID = "workspace"
MAX_NAME_CHARS = 120
MAX_DESCRIPTION_CHARS = 4000
# How much of the description each turn carries.
_TURN_DESCRIPTION_CHARS = 1500


def workspace_ref(project_id: str) -> str:
    """The stand-in for a chat id that names a project's workspace."""
    return f"{REF_PREFIX}{project_id}"


def project_of_ref(ref: Optional[str]) -> Optional[str]:
    if ref and ref.startswith(REF_PREFIX):
        return ref[len(REF_PREFIX) :] or None
    return None


def project_of_session(session_id: Optional[str]) -> Optional[str]:
    if not session_id:
        return None
    db = SessionLocal()
    try:
        row = db.query(DbSession.project_id).filter(DbSession.id == session_id).first()
        return row.project_id if row else None
    finally:
        db.close()


def sandbox_location(owner: Optional[str], session_id: str) -> Tuple[str, str]:
    """(sandbox user, sandbox chat) a chat's workspace lives under."""
    project_id = project_of_ref(session_id) or project_of_session(session_id)
    if project_id:
        return workspace_ref(project_id), WORKSPACE_CHAT_ID
    return owner or "anonymous", session_id


def memory_key(owner: Optional[str], session_id: Optional[str]) -> Optional[str]:
    """Whose memory a chat uses: its project's if it has one, else its owner's."""
    project_id = project_of_session(session_id)
    return workspace_ref(project_id) if project_id else owner


# ---------------------------------------------------------------------------
# Who may do what
# ---------------------------------------------------------------------------


def is_member(project_id: Optional[str], user: Optional[str]) -> bool:
    """The creator counts as a member."""
    if not project_id or not user:
        return False
    db = SessionLocal()
    try:
        if db.query(Project.id).filter(Project.id == project_id, Project.owner == user).first():
            return True
        return (
            db.query(ProjectMember.username)
            .filter(ProjectMember.project_id == project_id, ProjectMember.username == user)
            .first()
            is not None
        )
    finally:
        db.close()


def is_creator(project_id: Optional[str], user: Optional[str]) -> bool:
    if not project_id or not user:
        return False
    db = SessionLocal()
    try:
        return (
            db.query(Project.id).filter(Project.id == project_id, Project.owner == user).first()
            is not None
        )
    finally:
        db.close()


def ids_for(user: Optional[str]) -> set:
    """The projects this user is in."""
    if not user:
        return set()
    db = SessionLocal()
    try:
        created = db.query(Project.id).filter(Project.owner == user).all()
        joined = db.query(ProjectMember.project_id).filter(ProjectMember.username == user).all()
        return {r[0] for r in created} | {r[0] for r in joined}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# The projects themselves
# ---------------------------------------------------------------------------


def _clean_name(name: Any) -> str:
    cleaned = " ".join(str(name or "").split())
    if not cleaned:
        raise ValueError("A project needs a name.")
    if len(cleaned) > MAX_NAME_CHARS:
        raise ValueError(f"A project name holds at most {MAX_NAME_CHARS} characters.")
    return cleaned


def _clean_description(description: Any) -> str:
    cleaned = str(description or "").strip()
    if len(cleaned) > MAX_DESCRIPTION_CHARS:
        raise ValueError(f"A description holds at most {MAX_DESCRIPTION_CHARS} characters.")
    return cleaned


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value else None


def _summary(db, project: Project, user: Optional[str]) -> Dict[str, Any]:
    members = db.query(ProjectMember).filter(ProjectMember.project_id == project.id).count()
    chats, last_message = (
        db.query(func.count(DbSession.id), func.max(DbSession.last_message_at))
        .filter(DbSession.project_id == project.id, DbSession.archived == False)  # noqa: E712
        .one()
    )
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description or "",
        "owner": project.owner,
        "is_creator": project.owner == user,
        "member_count": members + 1,
        "chat_count": chats or 0,
        "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at),
        "last_active_at": _iso(last_message) or _iso(project.updated_at),
    }


def list_for(user: Optional[str]) -> List[Dict[str, Any]]:
    ids = ids_for(user)
    if not ids:
        return []
    db = SessionLocal()
    try:
        rows = db.query(Project).filter(Project.id.in_(ids)).all()
        return [_summary(db, p, user) for p in rows]
    finally:
        db.close()


def get(project_id: str, user: Optional[str]) -> Optional[Dict[str, Any]]:
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        return _summary(db, project, user) if project else None
    finally:
        db.close()


def create(user: Optional[str], name: Any, description: Any = "") -> Dict[str, Any]:
    project = Project(
        id=str(uuid.uuid4()),
        name=_clean_name(name),
        description=_clean_description(description),
        owner=user,
    )
    db = SessionLocal()
    try:
        db.add(project)
        db.commit()
        return _summary(db, project, user)
    finally:
        db.close()


def update(project_id: str, user: Optional[str], changes: Dict[str, Any]) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).one()
        if changes.get("name") is not None:
            project.name = _clean_name(changes["name"])
        if changes.get("description") is not None:
            project.description = _clean_description(changes["description"])
        db.commit()
        return _summary(db, project, user)
    finally:
        db.close()


def delete(project_id: str) -> List[str]:
    """Remove the project and hand its chats back to their owners. Their shared
    files and memories go with it; the caller drops the workspace."""
    db = SessionLocal()
    try:
        chats = db.query(DbSession).filter(DbSession.project_id == project_id).all()
        ids = [c.id for c in chats]
        for chat in chats:
            chat.project_id = None
            chat.workspace_merged = True
        db.query(ProjectMember).filter(ProjectMember.project_id == project_id).delete()
        db.query(Project).filter(Project.id == project_id).delete()
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    from src import user_memory

    user_memory.remove_all(workspace_ref(project_id))
    return ids


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


def members(project_id: str) -> List[Dict[str, Any]]:
    """The creator first, then everyone else in the order they joined."""
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            return []
        rows = (
            db.query(ProjectMember)
            .filter(ProjectMember.project_id == project_id)
            .order_by(ProjectMember.added_at, ProjectMember.username)
            .all()
        )
        return [
            {"username": project.owner, "is_creator": True, "added_at": _iso(project.created_at)},
            *(
                {"username": m.username, "is_creator": False, "added_at": _iso(m.added_at)}
                for m in rows
            ),
        ]
    finally:
        db.close()


def add_member(project_id: str, username: str) -> bool:
    """False if they are in already."""
    if is_member(project_id, username):
        return False
    db = SessionLocal()
    try:
        db.add(ProjectMember(project_id=project_id, username=username))
        db.commit()
        return True
    finally:
        db.close()


def remove_member(project_id: str, username: str) -> bool:
    db = SessionLocal()
    try:
        removed = (
            db.query(ProjectMember)
            .filter(ProjectMember.project_id == project_id, ProjectMember.username == username)
            .delete()
        )
        db.commit()
        return bool(removed)
    finally:
        db.close()


def rename_user(old: str, new: str) -> None:
    """`Project.owner` follows through the rename of every owner column; this column
    goes by another name."""
    db = SessionLocal()
    try:
        db.query(ProjectMember).filter(ProjectMember.username == old).update(
            {"username": new}, synchronize_session=False
        )
        db.commit()
    finally:
        db.close()


def forget_user(username: str) -> List[str]:
    """A deleted account leaves its projects. What it created passes to whoever
    joined first; with nobody left the project goes too. Returns those deleted, for
    the caller to drop their workspaces."""
    deleted: List[str] = []
    db = SessionLocal()
    try:
        db.query(ProjectMember).filter(ProjectMember.username == username).delete()
        created = db.query(Project).filter(Project.owner == username).all()
        for project in created:
            heir = (
                db.query(ProjectMember)
                .filter(ProjectMember.project_id == project.id)
                .order_by(ProjectMember.added_at, ProjectMember.username)
                .first()
            )
            if heir is None:
                deleted.append(project.id)
                continue
            project.owner = heir.username
            db.delete(heir)
        db.commit()
    finally:
        db.close()
    for project_id in deleted:
        delete(project_id)
    return deleted


# ---------------------------------------------------------------------------
# Its chats
# ---------------------------------------------------------------------------


def chats(project_id: str) -> List[Dict[str, Any]]:
    """Every chat in the project, whoever started it, newest first."""
    db = SessionLocal()
    try:
        rows = (
            db.query(DbSession)
            .filter(DbSession.project_id == project_id, DbSession.archived == False)  # noqa: E712
            .all()
        )
        result = [
            {
                "id": s.id,
                "name": s.name,
                "owner": s.owner,
                "message_count": s.message_count or 0,
                "created_at": _iso(s.created_at),
                "updated_at": _iso(s.updated_at),
                "last_message_at": _iso(s.last_message_at) or _iso(s.updated_at),
            }
            for s in rows
        ]
    finally:
        db.close()
    result.sort(key=lambda c: c["last_message_at"] or "", reverse=True)
    return result


def set_session_project(session_id: str, project_id: Optional[str]) -> None:
    """Move a chat in or out. In, its files still have to reach the shared workspace;
    out, it goes back to the private one those were copied from."""
    db = SessionLocal()
    try:
        row = db.query(DbSession).filter(DbSession.id == session_id).first()
        if row is None or row.project_id == project_id:
            return
        row.project_id = project_id
        row.folder = None
        row.workspace_merged = project_id is None
        db.commit()
    finally:
        db.close()


def turn_context(session_id: Optional[str]) -> str:
    """What a turn in a project chat has to know about the project. For the turn
    context: it changes when the project does, and the prompt's head must not."""
    project_id = project_of_session(session_id)
    if not project_id:
        return ""
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            return ""
        name, description = project.name, (project.description or "").strip()
    finally:
        db.close()
    lines = [
        f'This chat belongs to the project "{name}". Everyone in the project sees this chat. '
        "Your workspace is the project's and shared by all its chats, so files and folders "
        "from other chats are there: look before you create something, and don't overwrite "
        "or delete what others made unless asked to.",
    ]
    if description:
        lines.append(f"What the project is about: {description[:_TURN_DESCRIPTION_CHARS]}")
    return "\n".join(lines)
