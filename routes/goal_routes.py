"""A chat's goal — /api/session/{id}/goal.

The page sets, pauses, resumes and clears the goal here and reads it after a
reload. The rounds themselves are ordinary chat turns (see `goal_round` in
routes/chat_routes.py); the rules are in src/goals.py.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from routes.session_routes import _verify_session_owner
from src import goals


class GoalIn(BaseModel):
    objective: str


class GoalChange(BaseModel):
    action: str  # "pause" | "resume"


def _or_409(call, *args) -> Dict[str, Any]:
    try:
        return call(*args)
    except goals.GoalError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


def setup_goal_routes(session_manager=None) -> APIRouter:
    router = APIRouter(prefix="/api/session", tags=["goals"])

    def _owned(request: Request, session_id: str) -> None:
        _verify_session_owner(request, session_id, session_manager)

    @router.get("/{session_id}/goal")
    def read_goal(session_id: str, request: Request) -> Dict[str, Optional[Dict[str, Any]]]:
        _owned(request, session_id)
        return {"goal": goals.get(session_id)}

    @router.post("/{session_id}/goal")
    def set_goal(session_id: str, body: GoalIn, request: Request) -> Dict[str, Any]:
        _owned(request, session_id)
        return {"goal": _or_409(goals.create, session_id, body.objective)}

    @router.patch("/{session_id}/goal")
    def change_goal(session_id: str, body: GoalChange, request: Request) -> Dict[str, Any]:
        _owned(request, session_id)
        action = body.action.strip().lower()
        if action == "pause":
            return {"goal": _or_409(goals.pause, session_id)}
        if action == "resume":
            return {"goal": _or_409(goals.resume, session_id)}
        raise HTTPException(status_code=400, detail='action must be "pause" or "resume".')

    @router.delete("/{session_id}/goal")
    def clear_goal(session_id: str, request: Request) -> Dict[str, bool]:
        _owned(request, session_id)
        goals.clear(session_id)
        return {"ok": True}

    return router
