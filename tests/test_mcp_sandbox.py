"""The `sandbox` tool of the outward MCP server (src/mcp_sandbox.py).

The sandbox daemon is faked: these tests check what Talos sends it and what it
hands back to the MCP client, not that Python runs.
"""

import asyncio
import base64
import json
import types

import pytest

from src import mcp_public, mcp_sandbox

SANDBOX = mcp_public.SCOPE_SANDBOX_EXEC


class FakeResponse:
    def __init__(self, status=200, payload=None, content=b""):
        self.status_code = status
        self._payload = payload
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class FakeDaemon:
    """Records calls; answers /exec with `result` and downloads from `files`."""

    def __init__(self, result=None, files=None):
        self.calls = []
        self.result = result or {
            "stdout": "ok\n",
            "stderr": "",
            "exit_code": 0,
            "created_artifacts": [],
        }
        self.files = files or {}

    def client(self, timeout=60.0):
        daemon = self

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, url, **kw):
                daemon.calls.append(("POST", url, kw))
                if url.endswith("/exec"):
                    return FakeResponse(payload=daemon.result)
                return FakeResponse(payload={"ok": True})

            def get(self, url, params=None):
                daemon.calls.append(("GET", url, params))
                path = (params or {}).get("path")
                if path not in daemon.files:
                    return FakeResponse(status=404)
                return FakeResponse(content=daemon.files[path])

            def delete(self, url):
                daemon.calls.append(("DELETE", url, None))
                return FakeResponse(payload={"ok": True})

        return Client()

    def urls(self, method):
        return [u for m, u, _ in self.calls if m == method]


@pytest.fixture
def daemon(monkeypatch):
    fake = FakeDaemon()
    monkeypatch.setattr(mcp_sandbox, "_client", fake.client)
    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)
    monkeypatch.setattr(mcp_sandbox, "_sessions", {})
    return fake


def _text_of(blocks):
    return blocks[0]["text"]


# ---------------------------------------------------------------------------
# Running code
# ---------------------------------------------------------------------------


def test_code_runs_as_python_in_the_sessions_workspace(daemon):
    blocks, failed = mcp_sandbox.run({"code": "print('ok')"}, "session-abcdef12")
    assert not failed
    (exec_call,) = [c for c in daemon.calls if c[1].endswith("/exec")]
    assert exec_call[2]["json"]["kind"] == "python"
    assert exec_call[2]["json"]["code"] == "print('ok')"
    user = mcp_sandbox._user_id("session-abcdef12")
    assert f"/users/{user}/workspaces/workspace/exec" in exec_call[1]
    assert "ok" in _text_of(blocks)


def test_the_account_is_named_after_a_hash_not_the_session_id(daemon):
    mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert all("session-abcdef12" not in url for _, url, _ in daemon.calls)
    assert mcp_sandbox._user_id("session-abcdef12").startswith("mcp-")


def test_a_session_keeps_its_account_between_calls(daemon):
    mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    mcp_sandbox.run({"code": "2"}, "session-abcdef12")
    assert daemon.urls("DELETE") == []
    execs = [u for u in daemon.urls("POST") if u.endswith("/exec")]
    assert len(execs) == 2 and execs[0] == execs[1]


def test_a_call_without_session_gets_an_account_for_that_call_only(daemon):
    mcp_sandbox.run({"code": "1"}, None)
    (deleted,) = daemon.urls("DELETE")
    (executed,) = [u for u in daemon.urls("POST") if u.endswith("/exec")]
    user = deleted.rsplit("/users/", 1)[1]
    assert f"/users/{user}/workspaces/" in executed


def test_first_call_of_a_session_says_the_sandbox_is_new(daemon):
    first, _ = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    second, _ = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert "New sandbox" in _text_of(first)
    assert "New sandbox" not in _text_of(second)


def test_a_failing_run_is_an_error_result(daemon):
    daemon.result = {"stdout": "Traceback ...\nNameError", "exit_code": 1, "created_artifacts": []}
    blocks, failed = mcp_sandbox.run({"code": "x"}, "session-abcdef12")
    assert failed
    assert "NameError" in _text_of(blocks)
    assert "exit_code: 1" in _text_of(blocks)


def test_a_timeout_is_reported(daemon):
    daemon.result = {"stdout": "", "exit_code": 124, "timed_out": True, "created_artifacts": []}
    blocks, failed = mcp_sandbox.run({"code": "while True: pass", "timeout": 5}, "session-abcdef12")
    assert failed
    assert "Timed out after 5s" in _text_of(blocks)


def test_timeout_is_clamped(daemon):
    mcp_sandbox.run({"code": "1", "timeout": 99999}, "session-abcdef12")
    (call,) = [c for c in daemon.calls if c[1].endswith("/exec")]
    assert call[2]["json"]["timeout"] == mcp_sandbox.MAX_TIMEOUT


def test_code_is_required(daemon):
    blocks, failed = mcp_sandbox.run({"code": "  "}, "session-abcdef12")
    assert failed and "`code` is required" in _text_of(blocks)
    assert daemon.calls == []


def test_an_unreachable_sandbox_is_a_tool_error(monkeypatch):
    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)

    class Broken:
        def __enter__(self):
            raise ConnectionError("no route")

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(mcp_sandbox, "_client", lambda timeout=60.0: Broken())
    monkeypatch.setattr(mcp_sandbox, "_delete_account", lambda uid: None)
    blocks, failed = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert failed and "could not run" in _text_of(blocks)


# ---------------------------------------------------------------------------
# Files in
# ---------------------------------------------------------------------------


def _uploads(daemon):
    return [(u, kw["files"]["file"]) for m, u, kw in daemon.calls if u.endswith("/upload")]


def test_files_are_uploaded_before_the_code_runs(daemon):
    raw = b"\x00\x01binary"
    mcp_sandbox.run(
        {
            "code": "1",
            "files": [
                {"name": "data.csv", "content": "a,b\n1,2"},
                {
                    "name": "plan.xlsx",
                    "content": base64.b64encode(raw).decode(),
                    "encoding": "base64",
                },
            ],
        },
        "session-abcdef12",
    )
    uploads = _uploads(daemon)
    assert [(f[0], f[1]) for _, f in uploads] == [("data.csv", b"a,b\n1,2"), ("plan.xlsx", raw)]
    order = [u for _, u, _ in daemon.calls]
    assert max(i for i, u in enumerate(order) if u.endswith("/upload")) < next(
        i for i, u in enumerate(order) if u.endswith("/exec")
    )


def test_a_file_name_cannot_leave_the_workspace(daemon):
    mcp_sandbox.run(
        {"code": "1", "files": [{"name": "../../etc/passwd", "content": "x"}]}, "session-abcdef12"
    )
    assert [f[0] for _, f in _uploads(daemon)] == ["passwd"]


@pytest.mark.parametrize(
    "files, message",
    [
        ("data.csv", "must be a list"),
        ([{"content": "x"}], "needs a `name`"),
        ([{"name": "a.bin", "content": "%%%", "encoding": "base64"}], "not valid base64"),
        ([{"name": "a.txt", "content": "x", "encoding": "rot13"}], "'text' or 'base64'"),
    ],
)
def test_bad_files_are_refused_before_anything_runs(daemon, files, message):
    blocks, failed = mcp_sandbox.run({"code": "1", "files": files}, "session-abcdef12")
    assert failed and message in _text_of(blocks)
    assert daemon.calls == []


# ---------------------------------------------------------------------------
# Files out
# ---------------------------------------------------------------------------


def test_created_files_come_back_by_type(daemon):
    png = b"\x89PNG\r\n\x1a\nfake"
    xlsx = b"PK\x03\x04fake"
    daemon.files = {
        "output/chart.png": png,
        "output/summary.csv": b"k,v\na,1\n",
        "output/report.xlsx": xlsx,
    }
    daemon.result["created_artifacts"] = list(daemon.files)

    blocks, failed = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert not failed
    image, csv, blob = blocks[1:]
    assert image["type"] == "image" and image["mimeType"] == "image/png"
    assert base64.b64decode(image["data"]) == png
    assert image["_meta"]["path"] == "output/chart.png"
    assert csv["type"] == "resource" and csv["resource"]["text"] == "k,v\na,1\n"
    assert blob["type"] == "resource" and base64.b64decode(blob["resource"]["blob"]) == xlsx
    assert blob["_meta"]["path"] == "output/report.xlsx"
    summary = _text_of(blocks)
    assert "output/chart.png" in summary and "output/report.xlsx" in summary


def test_an_oversized_file_is_named_but_not_sent(daemon, monkeypatch):
    monkeypatch.setattr(mcp_sandbox, "MAX_OUTPUT_FILE_BYTES", 10)
    daemon.files = {"big.bin": b"x" * 50, "small.txt": b"hi"}
    daemon.result["created_artifacts"] = ["big.bin", "small.txt"]
    blocks, _ = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert [b["_meta"]["path"] for b in blocks[1:]] == ["small.txt"]
    assert "big.bin (50 B): not returned" in _text_of(blocks)


def test_the_total_output_is_capped(daemon, monkeypatch):
    monkeypatch.setattr(mcp_sandbox, "MAX_OUTPUT_TOTAL_BYTES", 15)
    daemon.files = {"a.txt": b"x" * 10, "b.txt": b"y" * 10}
    daemon.result["created_artifacts"] = ["a.txt", "b.txt"]
    blocks, _ = mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    assert [b["_meta"]["path"] for b in blocks[1:]] == ["a.txt"]
    assert "b.txt" in _text_of(blocks) and "the response is full" in _text_of(blocks)


def test_svg_comes_back_as_text_not_as_an_image():
    block = mcp_sandbox.file_block("output/chart.svg", b"<svg/>")
    assert block["type"] == "resource" and block["resource"]["text"] == "<svg/>"


# ---------------------------------------------------------------------------
# Session lifetime
# ---------------------------------------------------------------------------


def test_ending_a_session_deletes_its_account(daemon):
    mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    mcp_sandbox.end_session("session-abcdef12")
    (deleted,) = daemon.urls("DELETE")
    assert deleted.endswith("/users/" + mcp_sandbox._user_id("session-abcdef12"))


def test_ending_an_unknown_session_does_nothing(daemon):
    mcp_sandbox.end_session("never-used-1234")
    mcp_sandbox.end_session(None)
    assert daemon.calls == []


def test_idle_sessions_expire(daemon, monkeypatch):
    mcp_sandbox.run({"code": "1"}, "session-abcdef12")
    later = mcp_sandbox._sessions["session-abcdef12"] + mcp_sandbox.SESSION_IDLE_SECONDS + 1
    assert mcp_sandbox._expired(later) == ["session-abcdef12"]
    assert "session-abcdef12" not in mcp_sandbox._sessions


@pytest.mark.parametrize("value", ["short", "x" * 129, "with space here", "tab\there!!", 42, None])
def test_odd_session_ids_are_not_used_as_sessions(value):
    assert not mcp_sandbox.valid_session_id(value)


# ---------------------------------------------------------------------------
# Catalogue, scopes and settings
# ---------------------------------------------------------------------------


def test_the_tool_is_called_sandbox_and_needs_its_scope(monkeypatch):
    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)
    assert mcp_public.scope_for_tool("sandbox") == SANDBOX
    names = {t["name"] for t in mcp_public.list_tools({SANDBOX})}
    assert names == {"sandbox"}
    assert "sandbox" not in {t["name"] for t in mcp_public.list_tools({mcp_public.SCOPE_SQL_READ})}


def test_the_admin_can_switch_it_off(monkeypatch):
    from src import mcp_settings

    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)
    monkeypatch.setattr(
        mcp_settings,
        "_get",
        lambda key, default: False if key == "mcp_sandbox_enabled" else default,
    )
    assert mcp_public.list_tools({SANDBOX}) == []
    text, is_error = mcp_public.call_tool("sandbox", {"code": "1"}, granted_scopes={SANDBOX})
    assert is_error and "disabled" in text


def test_it_is_on_by_default(monkeypatch):
    from src import mcp_settings
    from src.settings import DEFAULT_SETTINGS

    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)
    monkeypatch.setattr(mcp_settings, "_get", lambda key, default: default)
    assert DEFAULT_SETTINGS["mcp_sandbox_enabled"] is True
    assert mcp_settings.tool_enabled("sandbox")


def test_it_is_gone_when_the_sandbox_is_off(monkeypatch):
    from src import mcp_settings

    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: False)
    assert not mcp_settings.tool_enabled("sandbox")


def test_the_scope_can_be_minted_onto_a_token():
    from routes.api_token_routes import ALLOWED_SCOPES, TOKEN_PROFILES

    assert SANDBOX in ALLOWED_SCOPES
    assert TOKEN_PROFILES["mcp_sandbox"] == [SANDBOX]


def test_call_tool_passes_the_session_and_returns_blocks(daemon):
    blocks, is_error = mcp_public.call_tool(
        "sandbox", {"code": "1"}, granted_scopes={SANDBOX}, session_id="session-abcdef12"
    )
    assert not is_error
    assert isinstance(blocks, list) and blocks[0]["type"] == "text"
    assert "session-abcdef12" in mcp_sandbox._sessions


# ---------------------------------------------------------------------------
# JSON-RPC layer
# ---------------------------------------------------------------------------


def _request(scopes, headers=None):
    state = types.SimpleNamespace(
        api_token=True, api_token_scopes=list(scopes), api_token_owner=None, api_token_id="t"
    )
    return types.SimpleNamespace(state=state, headers=headers or {})


def _handle(message, request):
    from routes.mcp_public_routes import _handle_message

    return asyncio.run(_handle_message(message, request, None))


def test_initialize_hands_out_a_session_when_the_sandbox_is_offered(monkeypatch):
    monkeypatch.setattr("src.sandbox_client.sandbox_enabled", lambda: True)
    request = _request({SANDBOX})
    _handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, request)
    assert mcp_sandbox.valid_session_id(request.state.mcp_session_id)


def test_initialize_stays_stateless_without_the_sandbox(monkeypatch):
    request = _request({mcp_public.SCOPE_RAG_READ})
    _handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, request)
    assert not hasattr(request.state, "mcp_session_id")


def test_the_session_header_is_attached_to_the_response():
    from fastapi.responses import JSONResponse

    from routes.mcp_public_routes import SESSION_HEADER, _with_session

    request = types.SimpleNamespace(state=types.SimpleNamespace(mcp_session_id="abc123def456"))
    response = _with_session(JSONResponse(content={}), request)
    assert response.headers[SESSION_HEADER] == "abc123def456"


def test_tools_call_passes_the_blocks_through(daemon, monkeypatch):
    from routes import mcp_public_routes

    monkeypatch.setattr(mcp_public_routes, "_rate_limited", lambda label: None)
    daemon.files = {"output/a.png": b"\x89PNG"}
    daemon.result["created_artifacts"] = ["output/a.png"]
    request = _request({SANDBOX}, headers={"Mcp-Session-Id": "session-abcdef12"})
    out = _handle(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "sandbox", "arguments": {"code": "1"}},
        },
        request,
    )
    content = out["result"]["content"]
    assert [c["type"] for c in content] == ["text", "image"]
    assert out["result"]["isError"] is False
    json.dumps(out)  # the whole result must stay JSON-serialisable
    assert "session-abcdef12" in mcp_sandbox._sessions
