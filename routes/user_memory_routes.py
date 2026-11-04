"""A user's own memories — /api/memories, behind Settings → Memory.

Every route works on the caller's memories and takes no owner, so nobody can reach
someone else's, admins included. See src/user_memory.py.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from src import user_memory
from src.auth_helpers import effective_user


class MemoryIn(BaseModel):
    title: str = ""
    text: str


class MemoryChange(BaseModel):
    title: Optional[str] = None
    text: Optional[str] = None


def _answer(result: Dict[str, Any]) -> Dict[str, Any]:
    error = result.get("error")
    if not error:
        return {"ok": True, "message": result.get("output", "")}
    missing = error.startswith("There is no ")
    raise HTTPException(status_code=404 if missing else 400, detail=error.split("\n", 1)[0])


def setup_user_memory_routes() -> APIRouter:
    router = APIRouter(prefix="/api/memories", tags=["memories"])

    @router.get("")
    def list_memories(request: Request):
        return user_memory.listing(effective_user(request))

    @router.post("")
    def add_memory(body: MemoryIn, request: Request):
        return _answer(user_memory.add(effective_user(request), body.title, body.text))

    @router.patch("/{entry_id}")
    def change_memory(entry_id: int, body: MemoryChange, request: Request):
        return _answer(user_memory.edit(effective_user(request), entry_id, body.title, body.text))

    @router.delete("/{entry_id}")
    def remove_memory(entry_id: int, request: Request):
        return _answer(user_memory.remove(effective_user(request), entry_id))

    @router.delete("")
    def remove_all_memories(request: Request):
        return {"ok": True, "removed": user_memory.remove_all(effective_user(request))}

    return router
