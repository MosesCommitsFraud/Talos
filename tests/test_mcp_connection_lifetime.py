"""A connector added from a web request has to outlive that request.

Connecting used to enter the SDK's anyio contexts inside the request. Behind
Starlette's BaseHTTPMiddleware they broke when the response finished, while the
server kept showing as connected and every tool call came back with an empty error.
"""

import asyncio
import sys

import pytest

pytest.importorskip("mcp")
httpx = pytest.importorskip("httpx")
fastapi = pytest.importorskip("fastapi")

from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402

from src.mcp_manager import McpManager  # noqa: E402

SERVER = """
import asyncio, os
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

app = Server("t")
EMPTY = {"type": "object", "properties": {}}

@app.list_tools()
async def list_tools():
    return [
        Tool(name="ping", description="ping", inputSchema=EMPTY),
        Tool(name="die", description="die", inputSchema=EMPTY),
    ]

@app.call_tool()
async def call_tool(name, arguments):
    if name == "die":
        os._exit(1)
    return [TextContent(type="text", text=f"pong {os.getpid()}")]

async def main():
    async with stdio_server() as (r, w):
        await app.run(r, w, app.create_initialization_options())

asyncio.run(main())
"""


class _Passthrough(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        return await call_next(request)


@pytest.fixture
def script(tmp_path):
    path = tmp_path / "server.py"
    path.write_text(SERVER, encoding="utf-8")
    return str(path)


def _connect_args(script):
    return {
        "server_id": "s",
        "name": "S",
        "transport": "stdio",
        "command": sys.executable,
        "args": [script],
        "env": {},
    }


def _app(manager, script):
    app = fastapi.FastAPI()
    app.add_middleware(_Passthrough)

    @app.post("/connect")
    async def connect():
        return {"ok": await manager.connect_server(**_connect_args(script))}

    @app.post("/disconnect")
    async def disconnect():
        await manager.disconnect_server("s")
        return {"ok": True}

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


@pytest.mark.asyncio
async def test_connected_in_a_request_still_answers_and_disconnects_in_another(script):
    manager = McpManager()
    async with _app(manager, script) as client:
        assert (await client.post("/connect")).json() == {"ok": True}
        await asyncio.sleep(0.2)

        result = await asyncio.wait_for(manager.call_tool("mcp__s__ping", {}), 20)
        assert result["exit_code"] == 0
        assert result["stdout"].startswith("pong")

        assert (await client.post("/disconnect")).json() == {"ok": True}
    assert manager.get_server_status("s") == {"status": "disconnected"}
    assert not manager._holders


@pytest.mark.asyncio
async def test_a_failed_start_is_reported():
    manager = McpManager()
    args = {**_connect_args("x"), "command": "no-such-command-anywhere", "args": []}
    assert await manager.connect_server(**args) is False
    status = manager.get_server_status("s")
    assert status["status"] == "error"
    assert status["error"]


@pytest.mark.asyncio
async def test_connecting_again_replaces_the_old_connection(script):
    manager = McpManager()
    await manager.connect_server(**_connect_args(script))
    first = (await manager.call_tool("mcp__s__ping", {}))["stdout"]
    await manager.connect_server(**_connect_args(script))
    second = (await manager.call_tool("mcp__s__ping", {}))["stdout"]
    assert first != second
    await manager.disconnect_all()
    assert not manager._holders


@pytest.mark.asyncio
async def test_a_dead_server_stops_claiming_to_be_connected(script):
    manager = McpManager()
    await manager.connect_server(**_connect_args(script))

    died = await asyncio.wait_for(manager.call_tool("mcp__s__die", {}), 20)
    assert died["exit_code"] == 1
    assert died["error"]

    status = manager.get_server_status("s")
    assert status["status"] == "error"
    assert "lost" in status["error"]
    await manager.disconnect_all()


@pytest.mark.asyncio
async def test_a_call_that_fails_without_a_message_still_says_something():
    class _Silent:
        async def call_tool(self, *_):
            raise TimeoutError()

    manager = McpManager()
    manager._sessions["s"] = _Silent()
    result = await manager.call_tool("mcp__s__ping", {})
    assert result == {"error": "TimeoutError", "exit_code": 1}
