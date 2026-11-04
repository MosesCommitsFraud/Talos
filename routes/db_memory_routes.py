"""Admin page for the notes the model keeps on a database — /api/admin/memories.

Notes cross users and shape later answers, so admins can read and correct them.
Other users have no way to list them here; see src/db_memory.py.
"""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.middleware import require_admin
from src import db_memory
from src.auth_helpers import effective_user


class NoteIn(BaseModel):
    connection_id: str
    text: str


class NoteChange(BaseModel):
    text: str


def _answer(result: Dict[str, Any]) -> Dict[str, Any]:
    error = result.get("error")
    if not error:
        return {"ok": True, "message": result.get("output", "")}
    missing = error.startswith("There is no ")
    raise HTTPException(status_code=404 if missing else 400, detail=error)


def setup_db_memory_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin/memories", tags=["memories"])

    @router.get("")
    def list_notes(request: Request):
        require_admin(request)
        return db_memory.overview()

    @router.post("")
    def add_note(body: NoteIn, request: Request):
        require_admin(request)
        return _answer(db_memory.admin_add(body.connection_id, body.text, effective_user(request)))

    @router.patch("/{entry_id}")
    def change_note(entry_id: int, body: NoteChange, request: Request):
        require_admin(request)
        return _answer(db_memory.admin_edit(entry_id, body.text, effective_user(request)))

    @router.delete("/{entry_id}")
    def remove_note(entry_id: int, request: Request):
        require_admin(request)
        return _answer(db_memory.admin_remove(entry_id))

    return router
