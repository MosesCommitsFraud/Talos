"""Request-local SQL credentials and the dedicated SQL sandbox transport."""

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

# Same shape the sandbox enforces (sandbox/sql_sandbox.py): a bare hostname, so
# a FreeTDS alias, an embedded port or a connection-string fragment can't ride
# in on the header. Checked here too, only to answer with something a client can
# act on — the sandbox's own refusal is a bare 400.
_HOST_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9.-]*")

# The model can't tell which engine sits behind sql_query and defaults to
# MySQL/PostgreSQL habits (LIMIT, NOW(), backticks), each a hard syntax error on
# SQL Server. Named in the tool description and repeated on every failure —
# like the in-app SQL integration's dialect notes (src/tool_implementations.py).
TSQL_GUIDE = (
    "The database is Microsoft SQL Server — write T-SQL, not MySQL/PostgreSQL: "
    "row limit `SELECT TOP n …` (never LIMIT; paging is ORDER BY … OFFSET n ROWS FETCH NEXT m ROWS ONLY); "
    "GETDATE() not NOW(); DATEADD(day, -30, GETDATE()), DATEDIFF(day, a, b); "
    "YEAR(d), MONTH(d), DATENAME(month, d), FORMAT(d, 'yyyy-MM'); CAST(d AS date); "
    "ISNULL(x, 0) / COALESCE; LEN() not LENGTH(); CONCAT() or +; "
    "quote identifiers with [brackets], never backticks; string literals N'…'; "
    "schema-qualify tables (dbo.Table)."
)
_TSQL_REMINDER = (
    " Remember: Microsoft SQL Server / T-SQL syntax (SELECT TOP n, GETDATE(), [brackets])."
)


def _is_loopback(host: str) -> bool:
    """`localhost`, `*.localhost` or anything in 127.0.0.0/8.

    Only names the bare-hostname check lets through need handling — `::1`
    already fails it on the colon.
    """
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    parts = host.split(".")
    return len(parts) == 4 and parts[0] == "127" and all(p.isdigit() for p in parts)


async def query_sql(arguments, headers):
    from src.sandbox_client import sandbox_enabled

    if not sandbox_enabled():
        return "Sandbox tools are disabled.", True
    args = arguments if isinstance(arguments, dict) else {}
    if set(args) - {"query", "max_rows"}:
        return "Only query and max_rows are accepted; credentials belong in HTTP headers.", True
    query = args.get("query")
    limit = args.get("max_rows", 100)
    if not isinstance(query, str) or not query.strip() or len(query) > 50_000:
        return "query must contain 1–50000 characters.", True
    if type(limit) is not int or not 1 <= limit <= 1000:
        return "max_rows must be an integer between 1 and 1000.", True
    # The credentials are read before the sandbox is looked up, so a client that
    # forgot a header is told exactly that. The other order reports a missing
    # header as a server configuration problem, which sends the caller — or the
    # model driving it — hunting in the wrong place.
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    # Same safety net as the in-app query_sql: a plain trailing `LIMIT n` becomes
    # `TOP n` instead of costing the caller a round trip.
    from src.tool_implementations import _adapt_sql_dialect

    query, rewrite_note = _adapt_sql_dialect(query, "mssql")
    payload = {"query": query, "max_rows": limit}
    names = {}
    for field, default in {
        "host": "macs-sql-host",
        "database": "macs-sql-database",
        "user": "macs-sql-user",
        "password": "macs-sql-password",
    }.items():
        header = os.getenv(f"TALOS_MCP_SQL_HEADER_{field.upper()}", default)
        names[field] = header
        value = headers.get(header.lower())
        if not isinstance(value, str) or not value or len(value) > 4096:
            # Names only, never values: tells "missing" from "empty" from
            # "arrived under another spelling" without logging a password.
            seen = sorted(k for k in headers if "sql" in k or k.startswith("macs"))
            logger.warning(
                "sql_query rejected: %s header %s; SQL-looking headers received: %s",
                header,
                "missing" if value is None else "empty or oversized",
                seen or "none",
            )
            return f"Missing or invalid SQL connection header: {header}.", True
        payload[field] = value
    if not _HOST_RE.fullmatch(payload["host"]):
        logger.warning(
            "sql_query rejected: %s=%r is not a bare hostname", names["host"], payload["host"]
        )
        return f"SQL connection header {names['host']} must be a bare hostname.", True
    if _is_loopback(payload["host"]):
        # The connection is opened inside the SQL sandbox on the Talos server,
        # so a loopback name resolves to that container — never to the machine
        # the client runs on. Without this the caller only sees a refused
        # connection, which reads like a wrong password or a down server.
        logger.warning("sql_query rejected: %s=%s is loopback", names["host"], payload["host"])
        return (
            f"SQL connection header {names['host']}={payload['host']} points at the Talos "
            "server itself, not at the machine the client runs on. Send the database's "
            "hostname or IP address as reachable from the Talos server.",
            True,
        )
    url = os.getenv("TALOS_SQL_SANDBOX_URL", "").rstrip("/")
    key = os.getenv("TALOS_SQL_SANDBOX_KEY", "")
    if not url or not key:
        # Deliberately no in-process fallback: the isolation is the point of
        # this tool, so an undeployed sandbox means no SQL, not a quieter path
        # to the same database. Both come from docker-compose.sql.yml.
        logger.warning(
            "sql_query unavailable: %s unset — start the stack with -f docker-compose.sql.yml",
            "TALOS_SQL_SANDBOX_URL" if not url else "TALOS_SQL_SANDBOX_KEY",
        )
        return (
            "SQL sandbox is not deployed on this Talos instance. This is a "
            "server-side deployment issue, not a problem with your request.",
            True,
        )
    try:
        async with httpx.AsyncClient(timeout=55.0) as client:
            response = await client.post(
                f"{url}/query", json=payload, headers={"X-Talos-Sandbox-Key": key}
            )
            response.raise_for_status()
            result = response.json()
        if result.get("error"):
            # Only fixed error codes cross the public boundary, never driver
            # messages. That makes the caller's view too coarse to debug with,
            # so the same event is logged here with the connection it was for —
            # and the sandbox's own log carries the driver's reason.
            logger.warning(
                "sql_query failed (%s) for host=%s db=%s user=%s query=%.200s",
                result["error"],
                payload["host"],
                payload["database"],
                payload["user"],
                query,
            )
            messages = {
                # The sandbox parses as T-SQL and refuses unknown functions, so
                # MySQL/PostgreSQL syntax (NOW(), LENGTH(), backticks) lands here
                # as well as genuinely non-SELECT statements.
                "invalid_query": "Rejected: only a single read-only SELECT is allowed, "
                "and it must parse as T-SQL using SQL Server built-in functions." + _TSQL_REMINDER,
                "host_denied": "Database host is not allowed by the SQL sandbox configuration.",
                "timeout": "SQL query timed out.",
                "busy": "SQL sandbox is busy. Retry later.",
                "result_too_wide": "The result's columns alone exceed the output budget. Select fewer columns.",
            }
            # A syntax error from the server itself also arrives as the generic
            # query_failed, so it carries the dialect reminder too.
            return messages.get(
                result["error"], "SQL connection or query failed." + _TSQL_REMINDER
            ), True
        logger.info(
            "sql_query ok: %s row(s)%s from host=%s db=%s",
            result.get("row_count"),
            " (truncated)" if result.get("truncated") else "",
            payload["host"],
            payload["database"],
        )
        if rewrite_note:
            result["note"] = rewrite_note
        return json.dumps(result, ensure_ascii=False), False
    except Exception:
        # Driver/proxy exceptions can include credentials or the request body,
        # so the message is logged without them and never returned.
        logger.exception(
            "sql_query could not reach the SQL sandbox at %s (host=%s db=%s)",
            url,
            payload["host"],
            payload["database"],
        )
        return "SQL sandbox request failed. Check its configuration and availability.", True
