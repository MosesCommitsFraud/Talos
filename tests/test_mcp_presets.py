"""Shipped connectors: added with one click, never with the app's secrets."""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")

from fastapi import HTTPException  # noqa: E402

from routes import mcp_routes  # noqa: E402


class _FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *_):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return self.rows


class _FakeDb:
    def __init__(self, rows):
        self.rows = rows

    def query(self, _):
        return _FakeQuery(self.rows)

    def add(self, row):
        self.rows.append(row)

    def commit(self):
        pass

    def close(self):
        pass


class _FakeManager:
    def __init__(self):
        self.calls = []

    async def connect_server(self, **kwargs):
        self.calls.append(kwargs)
        return True

    def get_server_status(self, _):
        return {"status": "connected", "tool_count": 2}


@pytest.fixture
def routes(monkeypatch):
    rows, manager = [], _FakeManager()
    monkeypatch.setattr(mcp_routes, "SessionLocal", lambda: _FakeDb(rows))
    monkeypatch.setattr(mcp_routes, "require_admin", lambda _: None)
    router = mcp_routes.setup_mcp_routes(manager)
    by_path = {r.path: r.endpoint for r in router.routes if hasattr(r, "endpoint")}
    return SimpleNamespace(
        rows=rows,
        manager=manager,
        list=by_path["/api/mcp/presets"],
        add=by_path["/api/mcp/presets/{preset_id}"],
    )


def _installed(monkeypatch, yes):
    monkeypatch.setattr(mcp_routes.importlib.util, "find_spec", lambda _: object() if yes else None)


def test_adding_runs_the_shipped_script_without_extra_environment(routes, monkeypatch):
    _installed(monkeypatch, True)
    out = asyncio.run(routes.add("autots", None))
    assert out["connected"] and out["tool_count"] == 2

    call = routes.manager.calls[0]
    assert call["server_id"] == "autots"
    assert call["command"] == sys.executable
    assert call["args"][0].replace("\\", "/").endswith("mcp_servers/autots_server.py")
    # An empty env is what keeps the app's secrets out (src/mcp_manager.py).
    assert call["env"] == {}
    assert json.loads(routes.rows[0].env) == {}


def test_listing_shows_availability_and_what_is_added(routes, monkeypatch):
    _installed(monkeypatch, True)
    assert routes.list(None) == [
        {"id": "autots", "name": "AutoTS", "available": True, "added": False}
    ]
    asyncio.run(routes.add("autots", None))
    assert routes.list(None)[0]["added"] is True


def test_refuses_a_second_copy_a_missing_package_and_unknown_ids(routes, monkeypatch):
    _installed(monkeypatch, True)
    asyncio.run(routes.add("autots", None))
    with pytest.raises(HTTPException) as again:
        asyncio.run(routes.add("autots", None))
    assert again.value.status_code == 409

    with pytest.raises(HTTPException) as unknown:
        asyncio.run(routes.add("rm-rf", None))
    assert unknown.value.status_code == 404

    routes.rows.clear()
    _installed(monkeypatch, False)
    with pytest.raises(HTTPException) as missing:
        asyncio.run(routes.add("autots", None))
    assert missing.value.status_code == 409
    assert routes.rows == []


def test_every_route_needs_an_admin(routes, monkeypatch):
    def deny(_):
        raise HTTPException(403, "Admin only")

    monkeypatch.setattr(mcp_routes, "require_admin", deny)
    with pytest.raises(HTTPException):
        routes.list(None)
    with pytest.raises(HTTPException):
        asyncio.run(routes.add("autots", None))
