import asyncio
import json
import types
from decimal import Decimal

import httpx
import pytest

from sandbox import sql_sandbox, sql_worker
from src import mcp_public, mcp_sql


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("TALOS_SQL_SANDBOX_URL", "http://sql-sandbox:7800")
    monkeypatch.setenv("TALOS_SQL_SANDBOX_KEY", "test-secret")
    monkeypatch.setenv("TALOS_SQL_ALLOWED_HOSTS", "db.example")
    return {"macs-sql-host": "db.example", "macs-sql-database": "db", "macs-sql-user": "reader", "macs-sql-password": "secret+';"}


def test_scope_and_credentials_not_in_schema():
    from routes.api_token_routes import ALLOWED_SCOPES, TOKEN_PROFILES

    assert "sql:read" in ALLOWED_SCOPES
    assert TOKEN_PROFILES["mcp_sql"] == ["sql:read"]
    assert "sql_query" not in {t["name"] for t in mcp_public.list_tools({"web:read"})}
    tool, = mcp_public.list_tools({"sql:read"})
    assert set(tool["inputSchema"]["properties"]) == {"query", "max_rows"}
    text, failed = mcp_public.call_tool("sql_query", {"query": "SELECT 1"}, granted_scopes=[])
    assert failed and "sql:read" in text


@pytest.mark.parametrize("query", [
    "SELECT 1", "SELECT TOP 5 name FROM dbo.customers",
    "WITH c AS (SELECT 1 AS n) SELECT n FROM c", "SELECT COUNT(*) FROM dbo.customers",
    "SELECT '; DROP TABLE t' AS literal", "SELECT 1 UNION ALL SELECT 2",
])
def test_read_queries(query):
    sql_worker.validate_query(query)


@pytest.mark.parametrize("query", [
    "DELETE FROM t", "SELECT * INTO copy FROM t", "SELECT 1; DROP TABLE t",
    "WITH c AS (SELECT 1 AS n) DELETE FROM t", "EXEC xp_cmdshell 'whoami'",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'host', 'SELECT 1')",
    "SELECT dbo.side_effect()", "", "SELECT 1; EXEC p",
    "SELECT NEXT VALUE FOR dbo.sequence_name",
])
def test_reject_unsafe_queries(query):
    with pytest.raises(Exception):
        sql_worker.validate_query(query)


def test_header_mapping_and_secret_safe_failure(configured, monkeypatch):
    monkeypatch.setenv("TALOS_MCP_SQL_HEADER_PASSWORD", "MAF-Password")
    configured["MAF-Password"] = configured.pop("macs-sql-password")
    captured = []

    def handle(request):
        captured.append(json.loads(request.content))
        assert request.headers["X-Talos-Sandbox-Key"] == "test-secret"
        raise RuntimeError(configured["MAF-Password"])

    client = httpx.AsyncClient
    monkeypatch.setattr(mcp_sql.httpx, "AsyncClient", lambda **kw: client(transport=httpx.MockTransport(handle), **kw))
    text, failed = asyncio.run(mcp_sql.query_sql({"query": "SELECT 1"}, configured))
    assert failed and configured["MAF-Password"] not in text
    assert captured[0]["password"] == configured["MAF-Password"]
    assert captured[0]["host"] == "db.example"
    text, failed = asyncio.run(mcp_sql.query_sql({"query": "SELECT 1"}, {}))
    assert failed and len(captured) == 1  # no credential reuse


def test_route_propagates_request_headers(configured, monkeypatch):
    from routes.mcp_public_routes import _handle_message

    async def fake_query(args, headers):
        assert headers["macs-sql-password"] == configured["macs-sql-password"]
        return '{"columns":["n"],"rows":[[1]]}', False

    monkeypatch.setattr(mcp_sql, "query_sql", fake_query)
    request = types.SimpleNamespace(headers=configured, state=types.SimpleNamespace(
        api_token=True, api_token_scopes=["sql:read"], api_token_owner="reader", api_token_id="sql-test"
    ))
    response = asyncio.run(_handle_message({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "sql_query", "arguments": {"query": "SELECT 1"}
    }}, request, None))
    assert response["result"]["isError"] is False


def test_sandbox_auth_host_and_malformed_body(configured):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=sql_sandbox.app), base_url="http://test") as client:
            payload = {"host": "other", "database": "db", "user": "u", "password": "secret", "query": "SELECT 1", "max_rows": 10}
            response = await client.post("/query", json=payload)
            assert response.status_code == 401
            response = await client.post("/query", json=payload, headers={"X-Talos-Sandbox-Key": "test-secret"})
            assert response.json() == {"error": "host_denied"}
            payload["host"] = "db.example;port=123"
            response = await client.post("/query", json=payload, headers={"X-Talos-Sandbox-Key": "test-secret"})
            assert response.status_code == 400 and "secret" not in response.text
    asyncio.run(run())


def test_worker_results_rollback_and_limits(monkeypatch):
    calls = []
    class Connection:
        description = [("value",)]
        def cursor(self): return self
        def execute(self, query): calls.append(query)
        def fetchone(self): return (Decimal("1.25"),)
        def rollback(self): calls.append("rollback")
        def close(self): calls.append("close")
    monkeypatch.setitem(__import__("sys").modules, "pymssql", types.SimpleNamespace(connect=lambda **kw: Connection()))
    result = sql_worker.execute({"host": "db", "database": "db", "user": "u", "password": "p", "port": 1433, "query": "SELECT 1", "max_rows": 2})
    assert result == {"columns": ["value"], "rows": [["1.25"], ["1.25"]], "row_count": 2, "truncated": True}
    assert calls[-2:] == ["rollback", "close"]


def test_sandbox_worker_stdin_and_timeout_cleanup(configured, monkeypatch):
    captured = []

    class Process:
        returncode = None
        killed = False
        async def communicate(self, data):
            captured.append(json.loads(data))
            raise asyncio.TimeoutError()
        def kill(self): self.killed = True
        async def wait(self): self.returncode = -9

    process = Process()
    async def spawn(*args, **kwargs):
        assert "secret" not in str(args)
        assert "TALOS_SQL_SANDBOX_KEY" not in kwargs["env"]
        return process

    monkeypatch.setattr(sql_sandbox.asyncio, "create_subprocess_exec", spawn)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=sql_sandbox.app), base_url="http://test") as client:
            response = await client.post("/query", json={"host": "db.example", "database": "db", "user": "u", "password": "secret", "query": "SELECT 1", "max_rows": 10}, headers={"X-Talos-Sandbox-Key": "test-secret"})
            assert response.json() == {"error": "timeout"}
    asyncio.run(run())
    assert process.killed and process.returncode == -9
    assert captured[0]["password"] == "secret"


def test_a_missing_header_is_reported_as_a_missing_header(configured):
    """Reading the credentials before looking up the sandbox is what makes this
    message possible. The other order blamed the deployment for a client's
    forgotten header, which cost a real debugging session."""
    headers = {**configured}
    headers.pop("macs-sql-host")
    text, failed = asyncio.run(mcp_sql.query_sql({"query": "SELECT 1"}, headers))
    assert failed and "macs-sql-host" in text

    # A host smuggling a port or a connection-string fragment never reaches the
    # sandbox; it is refused here with something the caller can act on.
    text, failed = asyncio.run(mcp_sql.query_sql(
        {"query": "SELECT 1"}, {**configured, "macs-sql-host": "db.example:1433;trusted=yes"}
    ))
    assert failed and "bare hostname" in text


def test_without_the_sandbox_there_is_no_second_path_to_the_database(monkeypatch, configured):
    """The isolation is the point of this tool: an undeployed sandbox means no
    SQL at all, never a quieter in-process route to the same database."""
    monkeypatch.delenv("TALOS_SQL_SANDBOX_URL", raising=False)
    monkeypatch.delenv("TALOS_SQL_SANDBOX_KEY", raising=False)
    monkeypatch.setattr(mcp_sql.httpx, "AsyncClient", lambda **kw: pytest.fail("must not connect"))

    text, failed = asyncio.run(mcp_sql.query_sql({"query": "SELECT 1"}, configured))
    assert failed and "not deployed" in text


@pytest.mark.parametrize("configured_hosts,host,expected", [
    ("", "anything.example", True),          # unset: the caller names the host
    ("*", "anything.example", True),
    ("db.example", "db.example", True),
    ("db.example", "other.example", False),
    ("*.macs.local", "laptop7.macs.local", True),
    ("*.macs.local", "macs.local", False),   # the suffix needs a label in front
    ("*.macs.local", "evil-macs.local", False),
    ("a.example, *.b.example", "x.b.example", True),
    ("DB.Example", "db.example", True),      # case-insensitive both ways
])
def test_host_allow_list_rules(monkeypatch, configured_hosts, host, expected):
    """Unset means no list is configured, so a client that knows its database's
    credentials may name its host — an operator who cannot enumerate the hosts
    in advance would otherwise have to write `*` anyway."""
    monkeypatch.setenv("TALOS_SQL_ALLOWED_HOSTS", configured_hosts)
    assert sql_sandbox.host_allowed(host) is expected
