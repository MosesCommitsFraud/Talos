"""A stdio MCP child must not inherit the app's secrets unless it is Talos' own.

User-added servers are third party code. The tests start a real child process
that reports its environment, so they check what the child actually receives.
"""

import asyncio
import json
import os
import sys

import pytest

pytest.importorskip("mcp")

from src import builtin_mcp  # noqa: E402
from src.mcp_manager import McpManager  # noqa: E402

SECRET = "TALOS_TEST_PLANTED_SECRET"

_DUMP_ENV_SERVER = """
import asyncio, json, os
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

server = Server("dump-env")

@server.list_tools()
async def list_tools():
    return [Tool(name="dump_env", description="", inputSchema={"type": "object", "properties": {}})]

@server.call_tool()
async def call_tool(name, arguments):
    return [TextContent(type="text", text=json.dumps(dict(os.environ)))]

async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

asyncio.run(main())
"""


@pytest.fixture
def dump_env_script(tmp_path, monkeypatch):
    monkeypatch.setenv(SECRET, "hunter2")
    script = tmp_path / "dump_env_server.py"
    script.write_text(_DUMP_ENV_SERVER, encoding="utf-8")
    return str(script)


async def _child_env(script, **connect_kwargs):
    """Connect a real stdio child and return the environment it reports."""
    manager = McpManager()
    ok = await manager.connect_server(
        server_id="abc12345",
        name="Test",
        transport="stdio",
        command=sys.executable,
        args=[script],
        **connect_kwargs,
    )
    try:
        assert ok, manager.get_server_status("abc12345")
        result = await manager.call_tool("mcp__abc12345__dump_env", {})
        return json.loads(result["stdout"])
    finally:
        await manager.disconnect_server("abc12345")


async def test_user_server_gets_its_env_but_not_the_app_secret(dump_env_script):
    child = await _child_env(dump_env_script, env={"MY_SERVER_TOKEN": "configured"})

    assert SECRET not in child
    assert child["MY_SERVER_TOKEN"] == "configured"
    # The SDK's safe defaults stay, or npx/uvx servers could not start at all.
    assert child["PATH"]


async def test_user_server_without_env_does_not_get_the_app_secret(dump_env_script):
    child = await _child_env(dump_env_script)

    assert SECRET not in child
    assert child["PATH"]


async def test_builtin_flag_keeps_the_app_environment(dump_env_script):
    child = await _child_env(
        dump_env_script, env={"PYTHONPATH": "talos-root"}, inherit_app_env=True
    )

    assert child[SECRET] == "hunter2"
    assert child["PYTHONPATH"] == "talos-root"


class _RecordingManager:
    def __init__(self):
        self.calls = {}

    async def connect_server(self, server_id, **kwargs):
        self.calls[server_id] = kwargs
        return True


async def test_startup_gives_the_app_env_to_talos_scripts_only(monkeypatch):
    async def _cached(*_args, **_kwargs):
        return True

    real_sleep = asyncio.sleep

    async def _no_delay(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(builtin_mcp, "MCP_DISABLED", False)
    monkeypatch.setattr(builtin_mcp, "_is_npx_package_cached", _cached)
    monkeypatch.setattr(asyncio, "sleep", _no_delay)

    manager = _RecordingManager()
    await builtin_mcp.register_builtin_servers(manager)
    for _ in range(20):
        await real_sleep(0)

    assert manager.calls["image_gen"]["inherit_app_env"] is True
    assert manager.calls["rag"]["inherit_app_env"] is True
    # The browser is a third party npm package, so it stays on the safe defaults.
    assert "builtin_browser" in manager.calls
    assert not manager.calls["builtin_browser"].get("inherit_app_env")


async def test_npx_cache_probe_does_not_get_the_app_secret(monkeypatch):
    monkeypatch.setenv(SECRET, "hunter2")
    real_exec = asyncio.create_subprocess_exec
    # Stands in for the npx package: it prints a version only if the secret is
    # absent, so the probe reports "cached" only when nothing leaked.
    fake_package = f"import os; print('' if {SECRET!r} in os.environ else '1.0.0')"

    async def _run_fake_package(_npx, *_args, **kwargs):
        return await real_exec(sys.executable, "-c", fake_package, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _run_fake_package)

    assert await builtin_mcp._is_npx_package_cached("npx", "@playwright/mcp@latest")


async def test_reconnecting_a_builtin_keeps_the_app_environment(monkeypatch):
    manager = McpManager()
    calls = {}

    async def _record(server_id, **kwargs):
        calls[server_id] = kwargs
        return True

    monkeypatch.setattr(manager, "connect_server", _record)

    assert await manager._reconnect_builtin("rag")
    assert calls["rag"]["inherit_app_env"] is True
    assert calls["rag"]["env"]["PYTHONPATH"] == os.path.dirname(
        os.path.dirname(os.path.abspath(builtin_mcp.__file__))
    )
