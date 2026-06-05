import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from core.middleware import require_admin


SANDBOX_URL = os.getenv("TALOS_SANDBOX_URL", "http://talos-sandbox:7800").rstrip("/")


def setup_sandbox_routes() -> APIRouter:
    router = APIRouter(prefix="/api/sandbox", tags=["sandbox"])

    async def call(method: str, path: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.request(method, f"{SANDBOX_URL}{path}")
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, dict) else {"data": data}
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Sandbox unavailable: {exc}") from exc

    @router.get("/health")
    async def health(request: Request):
        require_admin(request)
        return await call("GET", "/health")

    @router.post("/users/{user_id}/ensure")
    async def ensure_user(request: Request, user_id: str):
        require_admin(request)
        return await call("POST", f"/users/{user_id}/ensure")

    @router.post("/users/{user_id}/opencode/start")
    async def start_opencode(request: Request, user_id: str):
        require_admin(request)
        return await call("POST", f"/users/{user_id}/opencode/start")

    @router.post("/users/{user_id}/opencode/stop")
    async def stop_opencode(request: Request, user_id: str):
        require_admin(request)
        return await call("POST", f"/users/{user_id}/opencode/stop")

    return router
