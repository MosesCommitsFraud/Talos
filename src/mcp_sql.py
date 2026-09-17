"""Request-local SQL credentials and the dedicated SQL sandbox transport."""

import json
import os

import httpx


async def query_sql(arguments, headers):
    from src.sandbox_client import sandbox_enabled

    if not sandbox_enabled():
        return "Sandbox tools are disabled.", True
    url = os.getenv("TALOS_SQL_SANDBOX_URL", "").rstrip("/")
    key = os.getenv("TALOS_SQL_SANDBOX_KEY", "")
    if not url or not key:
        return "SQL sandbox is not configured.", True
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
    for field, default in {
        "host": "macs-sql-host", "database": "macs-sql-database",
        "user": "macs-sql-user", "password": "macs-sql-password",
    }.items():
        header = os.getenv(f"TALOS_MCP_SQL_HEADER_{field.upper()}", default)
        value = headers.get(header.lower())
        if not isinstance(value, str) or not value or len(value) > 4096:
            return f"Missing or invalid SQL connection header: {header}.", True
        payload[field] = value
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
