"""One SQL connection per disposable process; secrets arrive only on stdin."""

import json
import sys


def validate_query(query):
    import sqlglot
    from sqlglot import exp

    statements = sqlglot.parse(query, read="tsql")
    if len(statements) != 1 or not isinstance(statements[0], (exp.Select, exp.Union, exp.Intersect, exp.Except)):
        raise ValueError("invalid_query")
    for node in statements[0].walk():
        if isinstance(node, (exp.DDL, exp.DML, exp.Into, exp.Command, exp.Lock)):
            raise ValueError("invalid_query")
        if type(node).__name__ == "NextValueFor":
            raise ValueError("invalid_query")
        # External row sources and arbitrary user functions aren't part of this tool.
        if isinstance(node, exp.Anonymous):
            raise ValueError("invalid_query")
        if isinstance(node, exp.Table) and not isinstance(node.this, exp.Identifier):
            raise ValueError("invalid_query")


def diagnose(stage, detail, payload):
    """One line to stderr for the operator; never part of the response.

    The fixed error codes are what the caller gets, and they are too coarse to
    debug with: "query_failed" covers a wrong password, an unreachable host and
    a typo in a column name alike. The sandbox reads this off stderr and logs
    it, so the detail stays on the server. The password is never in it.
    """
    print(
        f"sql_worker {stage}: {detail} "
        f"[host={payload.get('host')} db={payload.get('database')} user={payload.get('user')}]",
        file=sys.stderr,
    )


def execute(payload):
    try:
        validate_query(payload["query"])
    except Exception as exc:
        diagnose("invalid_query", f"{type(exc).__name__}: {exc}", payload)
        return {"error": "invalid_query"}
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
        if budget > 20_000:
            return {"error": "result_too_wide"}
        for _ in range(payload["max_rows"]):
            row = cursor.fetchone()
            if row is None:
                break
            values = [json_value(value) for value in row]
            size = len(json.dumps(values, ensure_ascii=False)) + 2
            if budget + size > 20_000:
                result["truncated"] = True
                break
            result["rows"].append(values)
            budget += size
        else:
            result["truncated"] = cursor.fetchone() is not None
        result["row_count"] = len(result["rows"])
        return result
    except Exception as exc:
        # Driver messages can carry the host, the login and the request body,
        # so they reach the operator's log and never the response.
        diagnose("query_failed", f"{type(exc).__name__}: {exc}", payload)
        return {"error": "query_failed"}
    finally:
        if connection is not None:
            try:
                connection.rollback()
            finally:
                connection.close()


def json_value(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        import math
        return value if math.isfinite(value) else str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


if __name__ == "__main__":
    try:
        result = execute(json.load(sys.stdin))
    except Exception:
        result = {"error": "query_failed"}
    print(json.dumps(result, ensure_ascii=False))
