# routes/shared_skills_routes.py
"""REST API for shared, user-uploaded skills (Claude-style SKILL.md files).

Any authenticated user can upload a skill; it becomes visible to everyone.
Each user chooses which skills are active for them (per-user pref); the
enabled set is what the agent's context advertises for `read_skill`.
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


def setup_shared_skills_routes() -> APIRouter:
    router = APIRouter(prefix="/api/shared-skills", tags=["shared-skills"])

    @router.get("")
    async def list_skills(request: Request):
        user: Optional[str] = get_current_user(request)
        disabled = shared_skills._disabled_for(user)
        out = []
        for s in shared_skills.list_skills():
            s["enabled"] = s["name"] not in disabled
            s["mine"] = user is None or s.get("uploaded_by") == user
            out.append(s)
        return {"skills": out, "count": len(out)}

    @router.post("")
    async def upload_skill(request: Request, body: SkillUploadRequest):
        user = get_current_user(request)
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
        user = get_current_user(request)
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
        return {"ok": True, "skill": meta}

    @router.get("/{name}")
    async def get_skill(name: str, request: Request):
        skill = shared_skills.get_skill(name)
        if skill is None:
            raise HTTPException(404, "Skill not found")
        return skill

    @router.delete("/{name}")
    async def delete_skill(name: str, request: Request):
        user = get_current_user(request)
        try:
            ok = shared_skills.delete_skill(name, user, is_admin=_is_admin(request))
        except PermissionError as e:
            raise HTTPException(403, str(e))
        if not ok:
            raise HTTPException(404, "Skill not found")
        return {"ok": True}

    @router.put("/{name}/enabled")
    async def toggle_skill(name: str, request: Request, body: SkillToggleRequest):
        user = get_current_user(request)
        if shared_skills.get_skill(name) is None:
            raise HTTPException(404, "Skill not found")
        shared_skills.set_enabled(user, name, body.enabled)
        return {"ok": True, "name": name, "enabled": body.enabled}

    return router
