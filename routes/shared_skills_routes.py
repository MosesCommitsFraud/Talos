# routes/shared_skills_routes.py
"""REST API for shared skills (Claude-style SKILL.md files).

The skill library is administered: only admins upload, delete, or switch a
skill on. Enabling is global — an enabled skill is what every user's agent
context advertises for `read_skill`.
"""

import logging
import os
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel

from services.memory import shared_skills
from src.auth_helpers import get_current_user

logger = logging.getLogger(__name__)


class SkillUploadRequest(BaseModel):
    content: str


class SkillToggleRequest(BaseModel):
    enabled: bool


def _is_admin(request: Request) -> bool:
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        return True
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    user = get_current_user(request)
    try:
        return bool(auth_mgr and user and auth_mgr.is_admin(user))
    except Exception:
        return False


def _require_admin(request: Request) -> Optional[str]:
    """Admin-only gate for every write on the shared skill library."""
    if not _is_admin(request):
        raise HTTPException(403, "Only admins can manage the skill library.")
    return get_current_user(request)


def setup_shared_skills_routes() -> APIRouter:
    router = APIRouter(prefix="/api/shared-skills", tags=["shared-skills"])

    @router.get("")
    async def list_skills(request: Request):
        user: Optional[str] = get_current_user(request)
        is_admin = _is_admin(request)
        out = []
        for s in shared_skills.list_skills():
            s["mine"] = user is None or s.get("uploaded_by") == user
            out.append(s)
        return {"skills": out, "count": len(out), "can_manage": is_admin}

    @router.post("")
    async def upload_skill(request: Request, body: SkillUploadRequest):
        user = _require_admin(request)
        try:
            meta = shared_skills.save_skill(body.content, uploader=user)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True, "skill": meta}

    @router.post("/upload")
    async def upload_skill_file(request: Request, file: UploadFile = File(...)):
        """Multipart upload: a single SKILL.md, or a .zip bundle whose root
        (or single top-level folder) contains SKILL.md plus references/scripts."""
        user = _require_admin(request)
        data = await file.read()
        fname = (file.filename or "").lower()
        try:
            if fname.endswith(".zip"):
                meta = shared_skills.save_bundle(data, uploader=user)
            else:
                meta = shared_skills.save_skill(data.decode("utf-8"), uploader=user)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except UnicodeDecodeError:
            raise HTTPException(400, "Skill file must be UTF-8 markdown (or a .zip bundle).")
        except ValueError as e:
            raise HTTPException(400, str(e))
        # A fresh upload stays OFF: rolling it out to every user is a separate,
        # deliberate flip of the switch next to it.
        return {"ok": True, "skill": meta}

    @router.get("/{name}")
    async def get_skill(name: str, request: Request):
        skill = shared_skills.get_skill(name)
        if skill is None:
            raise HTTPException(404, "Skill not found")
        return skill

    @router.delete("/{name}")
    async def delete_skill(name: str, request: Request):
        user = _require_admin(request)
        try:
            ok = shared_skills.delete_skill(name, user, is_admin=True)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        if not ok:
            raise HTTPException(404, "Skill not found")
        return {"ok": True}

    @router.put("/{name}/enabled")
    async def toggle_skill(name: str, request: Request, body: SkillToggleRequest):
        _require_admin(request)
        if not shared_skills.set_enabled(name, body.enabled):
            raise HTTPException(404, "Skill not found")
        return {"ok": True, "name": name, "enabled": body.enabled}

    return router
