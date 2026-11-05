"""Projects — /api/projects, behind the project page. See src/projects.py.

Everyone in a project reads its chats and works in its files and memories. Only the
creator changes the project or who is in it. Someone outside gets the 404 of a project
that doesn't exist, so a guessed id says nothing.
"""

import logging
import os
import shutil
import tempfile
import uuid
from pathlib import PurePosixPath
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from core.database import Document, GalleryImage, SessionLocal
from core.database import Session as DbSession
from routes.document_routes import document_artifact, gallery_artifact
from routes.user_memory_routes import MemoryChange, MemoryIn, _answer
from src import projects, sandbox_client, user_memory
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 512 * 1024 * 1024


class ProjectIn(BaseModel):
    name: str
    description: str = ""


class ProjectChange(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class MemberIn(BaseModel):
    username: str


class FolderIn(BaseModel):
    path: str


def _user(request: Request) -> str:
    user = effective_user(request)
    if not user:
        raise HTTPException(403, "Authentication required")
    return user


def _member(request: Request, project_id: str) -> str:
    user = _user(request)
    if not projects.is_member(project_id, user):
        raise HTTPException(404, "Project not found")
    return user


def _creator(request: Request, project_id: str) -> str:
    user = _member(request, project_id)
    if not projects.is_creator(project_id, user):
        raise HTTPException(403, "Only the project's creator can do this")
    return user


def _display_names(request: Request) -> Dict[str, Optional[str]]:
    auth = getattr(request.app.state, "auth_manager", None)
    if auth is None:
        return {}
    return {u["username"]: u.get("display_name") for u in auth.list_users()}


def _unique_name(name: str, taken: set) -> str:
    """Upload next to a file of the same name rather than over someone's work."""
    if name not in taken:
        return name
    path = PurePosixPath(name)
    for n in range(2, 1000):
        candidate = f"{path.stem} ({n}){path.suffix}"
        if candidate not in taken:
            return candidate
    return f"{path.stem} ({uuid.uuid4().hex[:6]}){path.suffix}"


def setup_project_routes() -> APIRouter:
    router = APIRouter(prefix="/api/projects", tags=["projects"])

    # ---- The project ----

    @router.get("")
    def list_projects(request: Request):
        return {"projects": projects.list_for(_user(request))}

    @router.post("")
    def create_project(body: ProjectIn, request: Request):
        try:
            return projects.create(_user(request), body.name, body.description)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @router.get("/{project_id}")
    def get_project(project_id: str, request: Request):
        user = _member(request, project_id)
        project = projects.get(project_id, user)
        if project is None:
            raise HTTPException(404, "Project not found")
        return project

    @router.patch("/{project_id}")
    def change_project(project_id: str, body: ProjectChange, request: Request):
        user = _creator(request, project_id)
        try:
            return projects.update(project_id, user, body.model_dump())
        except ValueError as e:
            raise HTTPException(400, str(e))

    @router.delete("/{project_id}")
    def delete_project(project_id: str, request: Request):
        _creator(request, project_id)
        released = projects.delete(project_id)
        sandbox_client.delete_project_workspace(project_id)
        return {"ok": True, "chats_released": len(released)}

    # ---- Who is in it ----

    @router.get("/{project_id}/members")
    def list_members(project_id: str, request: Request):
        _member(request, project_id)
        names = _display_names(request)
        return {
            "members": [
                {**m, "display_name": names.get(m["username"])}
                for m in projects.members(project_id)
            ]
        }

    @router.get("/{project_id}/candidates")
    def list_candidates(project_id: str, request: Request):
        """Who the creator could add. Creators need not be admins, so this is the one
        place they learn who else has an account: names only."""
        _creator(request, project_id)
        taken = {m["username"] for m in projects.members(project_id)}
        return {
            "users": [
                {"username": username, "display_name": display}
                for username, display in sorted(_display_names(request).items())
                if username not in taken
            ]
        }

    @router.post("/{project_id}/members")
    def add_member(project_id: str, body: MemberIn, request: Request):
        _creator(request, project_id)
        username = body.username.strip().lower()
        if username not in _display_names(request):
            raise HTTPException(404, "User not found")
        if not projects.add_member(project_id, username):
            raise HTTPException(409, "Already in this project")
        return {"ok": True}

    @router.delete("/{project_id}/members/{username}")
    def remove_member(project_id: str, username: str, request: Request):
        """The creator removes anyone, everyone else only themselves."""
        user = _member(request, project_id)
        target = username.strip().lower()
        if target != user:
            _creator(request, project_id)
        if projects.is_creator(project_id, target):
            raise HTTPException(400, "The creator can't leave the project, only delete it")
        if not projects.remove_member(project_id, target):
            raise HTTPException(404, "Not in this project")
        # Their chats stay with the project, but nothing runs in them any more.
        for chat in projects.chats(project_id):
            if chat["owner"] == target:
                sandbox_client.stop_project_chat_kernel(project_id, chat["id"])
        return {"ok": True}

    # ---- Its chats ----

    @router.get("/{project_id}/chats")
    def list_chats(project_id: str, request: Request):
        _member(request, project_id)
        names = _display_names(request)
        return {
            "chats": [
                {**c, "owner_display_name": names.get(c["owner"])}
                for c in projects.chats(project_id)
            ]
        }

    # ---- Its workspace ----

    @router.get("/{project_id}/files")
    async def list_files(project_id: str, request: Request):
        """The shared workspace, plus the documents and images its chats created.
        `ref` stands in for a chat id at the artifact routes (download, preview,
        rename, delete); documents and images carry the chat they belong to."""
        user = _member(request, project_id)
        ref = projects.workspace_ref(project_id)
        db = SessionLocal()
        try:
            chat_ids = [
                r[0] for r in db.query(DbSession.id).filter(DbSession.project_id == project_id)
            ]
            artifacts = [
                {**document_artifact(d), "session_id": d.session_id, "owner": d.owner}
                for d in db.query(Document)
                .filter(Document.session_id.in_(chat_ids), Document.is_active == True)  # noqa: E712
                .all()
            ]
            artifacts.extend(
                {**gallery_artifact(i), "session_id": i.session_id, "owner": i.owner}
                for i in db.query(GalleryImage)
                .filter(
                    GalleryImage.session_id.in_(chat_ids),
                    GalleryImage.is_active == True,  # noqa: E712
                )
                .all()
            )
        finally:
            db.close()
        result: Dict[str, Any] = {"ref": ref, "dirs": []}
        if sandbox_client.sandbox_enabled():
            try:
                workspace = await sandbox_client.list_workspace(owner=user, session_id=ref)
                result["dirs"] = workspace["dirs"]
                artifacts = [
                    *({**a, "source": "workspace", "session_id": ref} for a in workspace["artifacts"]),
                    *artifacts,
                ]
            except Exception as e:
                logger.warning("project workspace listing failed for %s: %s", project_id, e)
                result["error"] = "sandbox unavailable"
        artifacts.sort(key=lambda a: float(a.get("mtime") or 0), reverse=True)
        result["artifacts"] = artifacts
        return result

    @router.post("/{project_id}/folders")
    async def create_folder(project_id: str, body: FolderIn, request: Request):
        user = _member(request, project_id)
        path = body.path.strip().strip("/")
        if not path:
            raise HTTPException(400, "A folder needs a name")
        try:
            result = await sandbox_client.file_tool_in_sandbox(
                owner=user,
                session_id=projects.workspace_ref(project_id),
                operation="mkdir",
                payload={"path": path},
            )
        except Exception as e:
            logger.warning("creating folder failed in %s: %s", project_id, e)
            raise HTTPException(502, "The sandbox is not available")
        if result.get("exit_code", 1) != 0:
            raise HTTPException(400, result.get("error") or "The folder could not be created")
        return {"ok": True, "path": path}

    @router.post("/{project_id}/files")
    async def upload_file(
        project_id: str,
        request: Request,
        file: UploadFile = File(...),
        folder: str = Form(""),
    ):
        user = _member(request, project_id)
        ref = projects.workspace_ref(project_id)
        folder = folder.strip().strip("/")
        name = PurePosixPath((file.filename or "upload.bin").replace("\\", "/")).name or "upload.bin"
        tmp_dir = tempfile.mkdtemp(prefix="talos-project-upload-")
        tmp_path = os.path.join(tmp_dir, "upload.bin")
        try:
            size = 0
            with open(tmp_path, "wb") as out:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "The file is too large")
                    out.write(chunk)
            prefix = f"{folder}/" if folder else ""
            existing = await sandbox_client.list_artifacts(owner=user, session_id=ref)
            taken = {
                str(a.get("path") or "")[len(prefix) :]
                for a in existing
                if str(a.get("path") or "").startswith(prefix)
            }
            final = _unique_name(name, taken)
            # The sandbox only takes uploads into the workspace's top level, and one
            # bound for a folder must not touch a file of that name up there.
            staged = f".upload-{uuid.uuid4().hex}-{final}" if folder else final
            await sandbox_client.upload_file_to_sandbox(
                owner=user, session_id=ref, path=tmp_path, display_name=staged
            )
            if folder:
                moved = await sandbox_client.move_artifact(
                    owner=user, session_id=ref, src=staged, dst=f"{folder}/{final}"
                )
                if not moved:
                    await sandbox_client.delete_artifact(owner=user, session_id=ref, path=staged)
                    raise HTTPException(400, "The file could not be put in that folder")
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("project upload failed in %s: %s", project_id, e)
            raise HTTPException(502, "The sandbox is not available")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"ok": True, "path": f"{prefix}{final}"}

    # ---- Its memory ----

    @router.get("/{project_id}/memories")
    def list_memories(project_id: str, request: Request):
        _member(request, project_id)
        return user_memory.listing(projects.workspace_ref(project_id))

    @router.post("/{project_id}/memories")
    def add_memory(project_id: str, body: MemoryIn, request: Request):
        _member(request, project_id)
        return _answer(user_memory.add(projects.workspace_ref(project_id), body.title, body.text))

    @router.patch("/{project_id}/memories/{entry_id}")
    def change_memory(project_id: str, entry_id: int, body: MemoryChange, request: Request):
        _member(request, project_id)
        key = projects.workspace_ref(project_id)
        return _answer(user_memory.edit(key, entry_id, body.title, body.text))

    @router.delete("/{project_id}/memories/{entry_id}")
    def remove_memory(project_id: str, entry_id: int, request: Request):
        _member(request, project_id)
        return _answer(user_memory.remove(projects.workspace_ref(project_id), entry_id))

    return router
