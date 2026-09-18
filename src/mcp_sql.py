"""Request-local SQL credentials, the SQL sandbox transport, and its in-process fallback."""

import asyncio
import json
import math
import os
import re

import httpx

# Same shape the sandbox enforces (sandbox/sql_sandbox.py): a bare hostname, so
# a FreeTDS alias, an embedded port or a connection-string fragment can't ride
# in on the header.
_HOST_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9.-]*")
# Mirrors sandbox/sql_worker.py so both paths answer with the same budget.
_RESULT_BUDGET = 20_000


async def query_sql(arguments, headers):
    from src.sandbox_client import sandbox_enabled

    if not sandbox_enabled():
        return "Sandbox tools are disabled.", True
    url = os.getenv("TALOS_SQL_SANDBOX_URL", "").rstrip("/")
    key = os.getenv("TALOS_SQL_SANDBOX_KEY", "")
    args = arguments if isinstance(arguments, dict) else {}
    if set(args) - {"query", "max_rows"}:
        return "Only query and max_rows are accepted; credentials belong in HTTP headers.", True
    query = args.get("query")
    limit = args.get("max_rows", 100)
    if not isinstance(query, str) or not query.strip() or len(query) > 50_000:
        return "query must contain 1–50000 characters.", True
    if type(limit) is not int or not 1 <= limit <= 1000:
        return "max_rows must be an integer between 1 and 1000.", True
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    payload = {"query": query, "max_rows": limit}
    names = {}
    for field, default in {
        "host": "macs-sql-host", "database": "macs-sql-database",
        "user": "macs-sql-user", "password": "macs-sql-password",
    }.items():
        header = os.getenv(f"TALOS_MCP_SQL_HEADER_{field.upper()}", default)
        names[field] = header
        value = headers.get(header.lower())
        if not isinstance(value, str) or not value or len(value) > 4096:
            return f"Missing or invalid SQL connection header: {header}.", True
        payload[field] = value
    if not _HOST_RE.fullmatch(payload["host"]):
        return f"SQL connection header {names['host']} must be a bare hostname.", True
    if not url or not key:
        # No dedicated SQL sandbox deployed. The credentials still come from
        # this request's headers — only the transport differs: pymssql in this
        # process instead of a POST to the isolated container.
        return await _query_direct(payload)
    try:
        async with httpx.AsyncClient(timeout=55.0) as client:
            response = await client.post(
                f"{url}/query", json=payload, headers={"X-Talos-Sandbox-Key": key}
            )
            response.raise_for_status()
            result = response.json()
        if result.get("error"):
            # Only fixed error codes cross the public boundary, never driver messages.
            messages = {
                "invalid_query": "Only a single read-only SELECT query is allowed.",
                "host_denied": "Database host is not allowed by the SQL sandbox configuration.",
                "timeout": "SQL query timed out.",
                "busy": "SQL sandbox is busy. Retry later.",
            }
            return messages.get(result["error"], "SQL connection or query failed."), True
        return json.dumps(result, ensure_ascii=False), False
    except Exception:
        # Driver/proxy exceptions can include credentials or the request body.
        return "SQL sandbox request failed. Check its configuration and availability.", True


def _host_allowed(host: str) -> bool:
    """TALOS_SQL_ALLOWED_HOSTS, same rules as sandbox/sql_sandbox.py host_allowed.

    Deliberately duplicated rather than imported: the sandbox ships as its own
    image and the two must not depend on each other. Change one, change both —
    tests/test_mcp_sql.py checks that they agree.
    """
    allowed = {h.strip().lower() for h in os.getenv("TALOS_SQL_ALLOWED_HOSTS", "").split(",") if h.strip()}
    if not allowed or "*" in allowed:
        return True
    host = host.lower()
    return any(
        host == entry or (entry.startswith("*.") and host.endswith(entry[1:]))
        for entry in allowed
    )


def _json_value(value):
    """Mirror of sandbox/sql_worker.py json_value — Decimals stay exact as strings."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def _run_direct(payload):
    """Blocking pymssql round trip. Never commits; always rolls back and closes."""
    import pymssql

    connection = None
    try:
        connection = pymssql.connect(
            server=payload["host"], database=payload["database"],
            user=payload["user"], password=payload["password"],
            port=str(payload["port"]), login_timeout=10, timeout=30,
            encryption="require", autocommit=False,
        )
        cursor = connection.cursor()
        cursor.execute(payload["query"])
        columns = [column[0] for column in (cursor.description or [])]
        result = {"columns": columns, "rows": [], "row_count": 0, "truncated": False}
        budget = len(json.dumps(result, ensure_ascii=False))
        if budget > _RESULT_BUDGET:
            return {"error": "result_too_wide"}
        for _ in range(payload["max_rows"]):
            row = cursor.fetchone()
            if row is None:
                break
            values = [_json_value(value) for value in row]
            size = len(json.dumps(values, ensure_ascii=False)) + 2
            if budget + size > _RESULT_BUDGET:
                result["truncated"] = True
                break
            result["rows"].append(values)
            budget += size
        else:
            result["truncated"] = cursor.fetchone() is not None
        result["row_count"] = len(result["rows"])
        return result
    except Exception:
        # Driver messages can carry the host, the login and the request body.
        return {"error": "query_failed"}
    finally:
        if connection is not None:
            try:
                connection.rollback()
            finally:
                connection.close()


async def _query_direct(payload):
    """The sandbox-free path: same headers, same contract, connection in-process.

    The isolation the sandbox buys is real — a separate process, no shell, no
    filesystem, its own network — so this is the fallback, not the default. It
    exists because requiring the extra container turns a working MCP client into
    a deployment project. The read-only guard is the one the chat SQL tool
    already uses, so a write statement is refused here exactly as it is there.
    """
    from src.tool_implementations import _validate_readonly_sql

    complaint = _validate_readonly_sql(payload["query"])
    if complaint:
        return complaint, True
    if not _host_allowed(payload["host"]):
        return "Database host is not allowed by the SQL configuration.", True
    payload = {**payload, "port": int(os.getenv("TALOS_SQL_PORT", "1433"))}
    result = await asyncio.to_thread(_run_direct, payload)
    if result.get("error"):
        messages = {
            "result_too_wide": "The result's columns alone exceed the output budget. Select fewer columns.",
            "query_failed": "SQL connection or query failed. Check the connection headers and the query.",
        }
        return messages.get(result["error"], "SQL connection or query failed."), True
    return json.dumps(result, ensure_ascii=False), False
