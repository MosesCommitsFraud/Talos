"""
tool_implementations.py

Extracted tool implementation functions (do_* and helpers) from agent_tools.py.
These handle the actual execution logic for each tool type.
"""

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

MAX_OUTPUT_CHARS = 10_000
MAX_READ_CHARS = 20_000


def get_mcp_manager():
    from src import agent_tools

    return agent_tools.get_mcp_manager()


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars total)"
    return text


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Read-only external SQL tool
# ---------------------------------------------------------------------------

_SQL_MAX_ROWS_DEFAULT = 100
_SQL_ALLOWED_START = {"select", "with", "show", "describe", "desc", "explain", "pragma"}
_SQL_FORBIDDEN_WORDS = re.compile(
    r"\b(insert|update|delete|merge|replace|upsert|drop|alter|create|truncate|grant|revoke|vacuum|attach|detach|copy|load|call|exec|execute)\b",
    re.IGNORECASE,
)


def _sql_env(*names: str) -> str:
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _build_sql_url_from_cfg(cfg: dict) -> tuple[Optional[str], Optional[str]]:
    """Build a SQLAlchemy URL from a single saved SQL connection dict.

    Returns (url, error). Credentials stay in process and are never returned.
    """
    from urllib.parse import quote_plus

    db_type = str(cfg.get("db_type") or "mssql").strip().lower()
    host = str(cfg.get("host") or "").strip()
    port = str(cfg.get("port") or "").strip()
    name = str(cfg.get("database") or "").strip()
    user = str(cfg.get("username") or "").strip()
    password = str(cfg.get("password") or "")
    if db_type == "sqlite":
        if not name:
            return None, "Configured SQLite database path is empty."
        return f"sqlite:///{name}", None
    if not host or not name or not user:
        return None, "Saved SQL configuration is incomplete."
    port_part = f":{port}" if port else ""
    if db_type in {"postgres", "postgresql", "pg"}:
        return (
            f"postgresql+psycopg://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    if db_type in {"mysql", "mariadb"}:
        return (
            f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    if db_type in {"mssql", "sqlserver", "sql_server"}:
        return (
            f"mssql+pymssql://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    return None, f"Unsupported saved SQL database type '{db_type}'."


def _sql_connections() -> list[dict]:
    """Return normalized, enabled SQL connections, each carrying a 'name'.

    Sources, in order: the new ``sql_databases`` list, the legacy single
    ``sql_database`` dict, then the env-var fallback (name ``default``).
    """
    try:
        from src.settings import get_setting

        dbs = get_setting("sql_databases", None)
        legacy = get_setting("sql_database", {})
    except Exception:
        dbs, legacy = None, {}

    conns: list[dict] = []
    if isinstance(dbs, list) and dbs:
        for i, cfg in enumerate(dbs):
            if isinstance(cfg, dict) and cfg.get("enabled"):
                name = str(cfg.get("name") or "").strip() or f"db{i + 1}"
                conns.append({**cfg, "name": name})
    elif isinstance(legacy, dict) and legacy.get("enabled"):
        name = str(legacy.get("name") or "").strip() or "default"
        conns.append({**legacy, "name": name})

    if conns:
        return conns

    url, _ = _build_env_sql_url()
    if url:
        return [{"name": "default", "_url": url}]
    return []


def _resolve_conn_url(conn: dict) -> tuple[Optional[str], Optional[str]]:
    """URL for a connection from ``_sql_connections`` (prebuilt env url or cfg)."""
    if conn.get("_url"):
        return conn["_url"], None
    return _build_sql_url_from_cfg(conn)


def _build_external_sql_url() -> tuple[Optional[str], Optional[str]]:
    """Back-compat: URL for the first configured connection (or env fallback).

    Used by the capability/status checks, which only need to know whether *any*
    SQL database is reachable.
    """
    conns = _sql_connections()
    if conns:
        return _resolve_conn_url(conns[0])
    return _build_env_sql_url()


def _build_env_sql_url() -> tuple[Optional[str], Optional[str]]:
    """Return (url, error) from backend environment variables only."""
    explicit = _sql_env(
        "TALOS_SQL_DATABASE_URL",
        "SQL_DATABASE_URL",
        "READONLY_DATABASE_URL",
        "EXTERNAL_DATABASE_URL",
    )
    if explicit:
        return explicit, None

    db_type = _sql_env("TALOS_SQL_DB_TYPE", "SQL_DB_TYPE", "DB_TYPE", "DATABASE_TYPE").lower()
    sqlite_path = _sql_env("TALOS_SQLITE_PATH", "SQLITE_PATH", "SQL_DATABASE_PATH")
    if db_type == "sqlite" or sqlite_path:
        path = sqlite_path or _sql_env("TALOS_SQL_DB_NAME", "SQL_DB_NAME", "DB_NAME")
        if not path:
            return None, "SQLite is selected but no SQLITE_PATH/SQL_DATABASE_PATH/DB_NAME is set."
        return f"sqlite:///{path}", None

    host = _sql_env("TALOS_SQL_DB_HOST", "SQL_DB_HOST", "DB_HOST", "DATABASE_HOST", "MSSQL_HOST")
    name = _sql_env(
        "TALOS_SQL_DB_NAME", "SQL_DB_NAME", "DB_NAME", "DB_DATABASE", "DATABASE_NAME", "MSSQL_DB"
    )
    user = _sql_env(
        "TALOS_SQL_DB_USER",
        "SQL_DB_USER",
        "DB_USER",
        "DB_USERNAME",
        "DATABASE_USER",
        "MSSQL_READONLY_USER",
    )
    password = _sql_env(
        "TALOS_SQL_DB_PASSWORD",
        "SQL_DB_PASSWORD",
        "DB_PASSWORD",
        "DATABASE_PASSWORD",
        "MSSQL_READONLY_PASSWORD",
    )
    port = _sql_env("TALOS_SQL_DB_PORT", "SQL_DB_PORT", "DB_PORT", "DATABASE_PORT", "MSSQL_PORT")
    if not host or not name or not user:
        return None, (
            "No external SQL database is configured. Set TALOS_SQL_DATABASE_URL or "
            "DB_HOST, DB_NAME, DB_USER, DB_PASSWORD (optionally DB_PORT, DB_TYPE) in the backend environment/.env."
        )

    from urllib.parse import quote_plus

    if not db_type:
        if _sql_env("MSSQL_HOST") or _sql_env("MSSQL_DB"):
            db_type = "mssql"
        elif port == "3306":
            db_type = "mysql"
        elif port == "1433":
            db_type = "mssql"
        else:
            db_type = "postgresql"

    if db_type in {"postgres", "postgresql", "pg"}:
        driver = "postgresql+psycopg"
        port_part = f":{port}" if port else ""
        return (
            f"{driver}://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    if db_type in {"mysql", "mariadb"}:
        driver = "mysql+pymysql"
        port_part = f":{port}" if port else ""
        return (
            f"{driver}://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    if db_type in {"mssql", "sqlserver", "sql_server"}:
        port_part = f":{port}" if port else ""
        return (
            f"mssql+pymssql://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )
    if "+" in db_type:
        port_part = f":{port}" if port else ""
        return (
            f"{db_type}://{quote_plus(user)}:{quote_plus(password)}@{host}{port_part}/{quote_plus(name)}",
            None,
        )

    return (
        None,
        f"Unsupported DB_TYPE '{db_type}'. Use postgresql, mysql, mariadb, mssql, sqlite, or TALOS_SQL_DATABASE_URL.",
    )


def _clean_sql_for_validation(query: str) -> str:
    query = re.sub(r"/\*.*?\*/", " ", query or "", flags=re.DOTALL)
    query = re.sub(r"--[^\n\r]*", " ", query)
    return query.strip()


def _validate_readonly_sql(query: str) -> Optional[str]:
    cleaned = _clean_sql_for_validation(query)
    if not cleaned:
        return "Query is empty."
    if ";" in cleaned.rstrip(";"):
        return "Multiple SQL statements are not allowed."
    cleaned = cleaned.rstrip(";").strip()
    first = re.match(r"^([a-zA-Z_]+)", cleaned)
    if not first or first.group(1).lower() not in _SQL_ALLOWED_START:
        return (
            "Only read-only SQL statements are allowed (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/PRAGMA)."
        )
    if _SQL_FORBIDDEN_WORDS.search(cleaned):
        return "Write/admin SQL keywords are not allowed."
    return None


def _format_sql_rows(rows: List[Dict[str, Any]], max_chars: int = MAX_OUTPUT_CHARS) -> str:
    if not rows:
        return "No rows returned."
    columns = list(rows[0].keys())
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    for row in rows:
        vals = []
        for col in columns:
            val = row.get(col)
            text = "" if val is None else str(val)
            text = text.replace("|", "\\|").replace("\r", " ").replace("\n", " ")
            vals.append(text[:300])
        lines.append("| " + " | ".join(vals) + " |")
    return _truncate("\n".join(lines), max_chars)


def _sql_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return iso()
    return str(value)


async def do_query_sql(content: str, owner: Optional[str] = None) -> Dict:
    """Read-only SQL access using backend environment credentials."""
    del owner
    try:
        args = _parse_tool_args(content) if content.strip() else {}
    except ValueError as e:
        return {"error": f"Invalid JSON: {e}", "exit_code": 1}
    if not isinstance(args, dict):
        return {"error": "query_sql expects JSON arguments.", "exit_code": 1}

    action = str(args.get("action") or "query").strip().lower()
    max_rows = None
    if "max_rows" in args and args.get("max_rows") not in (None, "", 0, "0", "all", "ALL"):
        try:
            max_rows = max(1, int(args.get("max_rows")))
        except (TypeError, ValueError):
            max_rows = _SQL_MAX_ROWS_DEFAULT

    if action == "list_databases":
        conns = _sql_connections()
        if not conns:
            return {"error": "No SQL databases are configured.", "exit_code": 1}
        lines = []
        for c in conns:
            dt = str(c.get("db_type") or ("url" if c.get("_url") else "")).strip()
            host = str(c.get("host") or "").strip()
            detail = "/".join(p for p in (dt, host) if p)
            lines.append(f"{c['name']}" + (f" ({detail})" if detail else ""))
        return {"output": "Available databases:\n" + "\n".join(lines), "exit_code": 0}

    conns = _sql_connections()
    if not conns:
        _, err = _build_external_sql_url()
        return {"error": err or "No SQL database is configured.", "exit_code": 1}

    requested = str(args.get("database") or "").strip()
    if requested:
        conn = next((c for c in conns if c["name"].lower() == requested.lower()), None)
        if conn is None:
            names = ", ".join(c["name"] for c in conns)
            return {"error": f"Unknown database '{requested}'. Available: {names}.", "exit_code": 1}
    elif len(conns) == 1:
        conn = conns[0]
    else:
        names = ", ".join(c["name"] for c in conns)
        return {
            "error": f'Multiple databases are configured ({names}). Pass "database" to choose one.',
            "exit_code": 1,
        }

    url, err = _resolve_conn_url(conn)
    if err or not url:
        return {"error": err or "No SQL database URL could be built.", "exit_code": 1}

    def _run() -> Dict:
        try:
            from sqlalchemy import create_engine, inspect, text
            from sqlalchemy.exc import SQLAlchemyError
        except Exception as exc:
            return {"error": f"SQLAlchemy is required for query_sql ({exc}).", "exit_code": 1}

        try:
            engine = create_engine(url, pool_pre_ping=True, connect_args={})
            if action == "list_tables":
                inspector = inspect(engine)
                names = []
                for schema in inspector.get_schema_names():
                    if schema.lower() in {"information_schema", "pg_catalog", "sys"}:
                        continue
                    try:
                        for table in inspector.get_table_names(schema=schema):
                            names.append(f"{schema}.{table}" if schema else table)
                        for view in inspector.get_view_names(schema=schema):
                            names.append(f"{schema}.{view}" if schema else view)
                    except Exception:
                        continue
                names = sorted(dict.fromkeys(names))
                if max_rows is not None:
                    names = names[:max_rows]
                return {"output": "\n".join(names) if names else "No tables found.", "exit_code": 0}

            if action == "describe":
                table = str(args.get("table") or "").strip()
                if not table or not re.match(r"^[A-Za-z0-9_.]+$", table):
                    return {
                        "error": "describe requires a safe table name like schema.table.",
                        "exit_code": 1,
                    }
                schema, table_name = table.rsplit(".", 1) if "." in table else (None, table)
                inspector = inspect(engine)
                cols = inspector.get_columns(table_name, schema=schema)
                rows = [
                    {
                        "name": c.get("name"),
                        "type": str(c.get("type")),
                        "nullable": c.get("nullable"),
                    }
                    for c in cols
                ]
                return {"output": _format_sql_rows(rows), "rows": rows, "exit_code": 0}

            if action != "query":
                return {
                    "error": "Unknown action. Use list_databases, list_tables, describe, or query.",
                    "exit_code": 1,
                }

            query = str(args.get("query") or "").strip()
            validation_error = _validate_readonly_sql(query)
            if validation_error:
                return {"error": validation_error, "exit_code": 1}
            query = _clean_sql_for_validation(query).rstrip(";").strip()
            with engine.connect() as conn:
                result = conn.execute(text(query))
                columns = list(result.keys())
                rows = []
                row_count = 0
                for row in result:
                    row_count += 1
                    if max_rows is None or len(rows) < max_rows:
                        rows.append({col: _sql_json_value(val) for col, val in zip(columns, row)})
                truncated = max_rows is not None and row_count > max_rows
                output = _format_sql_rows(rows)
                if truncated:
                    output += f"\n\nReturned first {max_rows} of {row_count} rows."
                return {
                    "output": output,
                    "rows": rows,
                    "row_count": row_count,
                    "truncated": truncated,
                    "exit_code": 0,
                }
        except SQLAlchemyError as exc:
            return {
                "error": f"SQL query failed: {exc.__class__.__name__}: {str(exc)[:500]}",
                "exit_code": 1,
            }
        except Exception as exc:
            return {
                "error": f"SQL tool failed: {exc.__class__.__name__}: {str(exc)[:500]}",
                "exit_code": 1,
            }

    return await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _parse_tool_args(content):
    """Parse a tool-call argument blob.

    Accepts either a JSON string or an already-decoded dict. Unwraps the
    common `{"body": {...}}` envelope that smaller models emit when they
    read tool descriptions like "Body is JSON: {...}" literally — they
    pass `body` as a field name rather than treating it as a noun.

    Returns a dict on success, raises ValueError on bad JSON.
    """
    if isinstance(content, str):
        try:
            args = json.loads(content) if content.strip() else {}
        except (json.JSONDecodeError, TypeError) as e:
            raise ValueError(str(e))
    elif isinstance(content, dict):
        args = content
    else:
        args = {}
    # Unwrap {"body": {...}} envelope — but only if `body` is the sole key
    # and points at a dict. We don't want to clobber a legitimate `body`
    # field on tools where it's a real arg (e.g. send_email body text).
    if (
        isinstance(args, dict)
        and len(args) == 1
        and "body" in args
        and isinstance(args["body"], dict)
        and "action"
        in args["body"]  # extra safety: only unwrap if the inner dict looks like a tool call
    ):
        args = args["body"]
    return args


# ---------------------------------------------------------------------------
# Active document state
# ---------------------------------------------------------------------------

_active_document_id: Optional[str] = None
_active_model: Optional[str] = None


def set_active_document(doc_id: Optional[str]):
    """Set the active document ID for document tool execution."""
    global _active_document_id
    _active_document_id = doc_id


def set_active_model(model: Optional[str]):
    """Set the current model name for version summaries."""
    global _active_model
    _active_model = model


def get_active_document():
    return _active_document_id


def clear_active_document(doc_id: Optional[str] = None) -> bool:
    """Clear the in-memory active-document pointer.

    With ``doc_id`` given, only clears when it matches the current pointer, so a
    different active document is left untouched. Returns True if it was cleared.

    Called when a document is detached from its session or deleted (its tab is
    closed): without this, the stale pointer makes the last-resort doc-injection
    path re-surface a closed document in a later, unrelated chat — even one whose
    session no longer matches — because an unlinked doc has session_id NULL (#1160).
    """
    global _active_document_id
    if doc_id is None or _active_document_id == doc_id:
        _active_document_id = None
        return True
    return False


def _owned_document_query(query, Document, owner: Optional[str]):
    if owner is None:
        # A bare Python `False` is not a valid SQL expression — SQLAlchemy 1.4
        # deprecates it and 2.0 raises ArgumentError. Use the SQL `false()`
        # literal to return zero rows for an unscoped (owner-less) query.
        from sqlalchemy import false

        return query.filter(false())
    return query.filter(Document.owner == owner)


def _get_owned_document(db, Document, doc_id: str, owner: Optional[str], active_only: bool = False):
    q = db.query(Document).filter(Document.id == doc_id)
    if active_only:
        q = q.filter(Document.is_active == True)
    q = _owned_document_query(q, Document, owner)
    return q.first()


def _most_recent_owned_document(db, Document, owner: Optional[str], active_only: bool = False):
    q = db.query(Document)
    if active_only:
        q = q.filter(Document.is_active == True)
    q = _owned_document_query(q, Document, owner)
    return q.order_by(Document.updated_at.desc()).first()


# ---------------------------------------------------------------------------
# Document tools — create/update/edit/suggest living documents
# ---------------------------------------------------------------------------


def _sniff_doc_language(text: str) -> str:
    """Best-effort detect a document's language from its content when the model
    didn't specify one. Defaults to 'markdown' (prose). Recognizes the common
    markup/code types the editor supports so e.g. an SVG isn't saved as markdown."""
    import json as _json
    import re as _re2

    s = (text or "").strip()
    if not s:
        return "markdown"
    head = s[:600]
    hl = head.lower()
    if _looks_like_email_document(s):
        return "email"
    # Markup (unambiguous)
    if "<svg" in hl:
        return "svg"
    if hl.startswith("<?xml"):
        return "xml"
    if (
        hl.startswith("<!doctype html")
        or hl.startswith("<html")
        or _re2.search(r"<(div|body|head|p|span|table|button|h[1-6]|ul|ol|li|img)\b", hl)
    ):
        return "html"
    # JSON
    if s[0] in "{[":
        try:
            _json.loads(s)
            return "json"
        except Exception:
            pass
    # Shebang
    first = s.split("\n", 1)[0].strip().lower()
    if first.startswith("#!"):
        return "python" if "python" in first else "bash"
    # Code by strong leading signals (line-anchored so prose with stray words won't match)
    if _re2.search(r"(?m)^\s*(def \w|class \w|import \w|from \w[\w.]* import )", s):
        return "python"
    if _re2.search(r"(?m)^\s*(function \w|const \w|let \w|export |import .* from )", s):
        return "javascript"
    if _re2.search(r"(?mi)^\s*(select .* from |create table |insert into |update \w)", s):
        return "sql"
    if _re2.search(r"(?m)^[.#]?[\w-]+\s*\{[^{}]*:[^{}]*;", s):
        return "css"
    return "markdown"


def _looks_like_email_document(text: str = "", title: str = "") -> bool:
    import re as _re

    title_l = (title or "").strip().lower()
    if title_l in {"new email", "new mail", "new message"}:
        return True
    s = (text or "").lstrip()
    if "\n---\n" in s and _re.search(r"(?im)^To:\s*", s) and _re.search(r"(?im)^Subject:\s*", s):
        return True
    return bool(_re.search(r"(?im)^To:\s*", s) and _re.search(r"(?im)^Subject:\s*", s))


def _coerce_email_document_content(existing: str, incoming: str) -> str:
    """Keep email docs in the To/Subject/---/body shape even if a model writes
    only the body or dumps header labels without the separator."""
    import re as _re

    old = existing or ""
    new = (incoming or "").strip()
    if "\n---\n" in new:
        return new
    header = old.split("\n---\n", 1)[0] if "\n---\n" in old else "To: \nSubject: "
    if _looks_like_email_document(new):
        lines = new.splitlines()
        last_header_idx = -1
        header_re = _re.compile(
            r"^(To|Cc|Bcc|Subject|In-Reply-To|References|X-Source-UID|X-Source-Folder|X-Attachments):",
            _re.I,
        )
        for i, line in enumerate(lines):
            if header_re.match(line.strip()):
                last_header_idx = i
        body_lines = lines[last_header_idx + 1 :] if last_header_idx >= 0 else lines
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        body = "\n".join(body_lines).strip()
    else:
        body = new
    return header.rstrip() + "\n---\n" + body


async def do_create_document(
    content_block: str, session_id: Optional[str] = None, owner: Optional[str] = None
) -> Dict:
    """Create a new document. Supports two formats:
      1) Line-based: line 1 = title, line 2 (optional) = language, rest = content
      2) XML-like tags: <title>...</title><language>...</language><content>...</content>
    Some models mix them — strip any XML-style tags and fall back to line parsing."""
    import re as _re
    import uuid

    from src.database import Document, DocumentVersion, SessionLocal
    from src.database import Session as DbSession

    raw = content_block or ""

    # Known languages the editor understands (match the <select> in HTML)
    _KNOWN_LANGS = {
        "python",
        "javascript",
        "typescript",
        "html",
        "css",
        "markdown",
        "json",
        "yaml",
        "bash",
        "sql",
        "rust",
        "go",
        "java",
        "c",
        "cpp",
        "xml",
        "toml",
        "ini",
        "ruby",
        "php",
        "csv",
        "email",
        "text",
        "plain",
        "svg",
    }

    # Try XML tag extraction first
    title = None
    language = None
    content = None
    mt = _re.search(r"<title>\s*(.*?)\s*</title>", raw, _re.DOTALL | _re.IGNORECASE)
    ml = _re.search(r"<language>\s*(.*?)\s*</language>", raw, _re.DOTALL | _re.IGNORECASE)
    mc = _re.search(r"<content>\s*(.*?)\s*</content>", raw, _re.DOTALL | _re.IGNORECASE)
    if mt or mc:
        title = mt.group(1).strip() if mt else None
        language = ml.group(1).strip().lower() if ml else None
        content = mc.group(1) if mc else None

    # Fall back to line-based parsing. First strip any stray XML-ish tags.
    if title is None or content is None:
        cleaned = _re.sub(r"</?(?:title|language|content)>", "", raw)
        lines = cleaned.strip().split("\n")
        if title is None:
            title = lines[0].strip() if lines else "Untitled"
            lines = lines[1:]
        # Only consume second line as language if it looks like a valid short lang token
        if language is None and lines:
            candidate = lines[0].strip().lower()
            if (
                candidate
                and len(candidate) < 20
                and " " not in candidate
                and candidate in _KNOWN_LANGS
            ):
                language = candidate
                lines = lines[1:]
        if content is None:
            content = "\n".join(lines)

    # Validate language: must be in known set, else default based on content
    if language and language not in _KNOWN_LANGS:
        language = None
    if not language:
        # No explicit language — sniff it from the content so an SVG / HTML / JSON
        # / code document isn't silently saved as markdown. Prose → markdown.
        language = _sniff_doc_language(content)
    if _looks_like_email_document(content, title):
        language = "email"

    if not title:
        title = "Untitled"
    if _re.match(r"^(?:untitled|document(?::|$)|code\s*\()", title, _re.IGNORECASE):
        from routes.document_helpers import _derive_title

        derived = _derive_title(content)
        if derived != "Untitled":
            title = derived

    if not session_id:
        return {"error": "No session context for document creation"}

    db = SessionLocal()
    try:
        doc_id = str(uuid.uuid4())
        ver_id = str(uuid.uuid4())

        # Inherit ownership from the chat session so the doc survives that
        # session later being deleted (session_id → NULL).
        _sess = db.query(DbSession).filter(DbSession.id == session_id).first()
        if owner is not None and (not _sess or _sess.owner != owner):
            return {"error": "Cannot create document in another user's session"}
        _owner = _sess.owner if _sess else None

        doc = Document(
            id=doc_id,
            session_id=session_id,
            title=title,
            language=language,
            current_content=content,
            version_count=1,
            is_active=True,
            owner=_owner,
        )
        ver = DocumentVersion(
            id=ver_id,
            document_id=doc_id,
            version_number=1,
            content=content,
            summary=f"Created by {_active_model or 'AI'}",
            source="ai",
        )
        db.add(doc)
        db.add(ver)
        db.commit()

        set_active_document(doc_id)

        return {
            "action": "create",
            "doc_id": doc_id,
            "title": title,
            "language": language,
            "content": content,
            "version": 1,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to create document: {e}"}
    finally:
        db.close()


async def do_update_document(
    content: str, doc_id: Optional[str] = None, owner: Optional[str] = None
) -> Dict:
    """Update an existing document. Content = full new document text."""
    import uuid

    from src.database import Document, DocumentVersion, SessionLocal

    target_id = doc_id or _active_document_id

    db = SessionLocal()
    try:
        doc = None
        if target_id:
            doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            doc = _most_recent_owned_document(db, Document, owner)
            if doc:
                target_id = doc.id
                set_active_document(target_id)
                logger.info(f"update_document: fell back to most recent doc id={target_id}")
        if not doc:
            return {"error": "No documents exist to update"}

        is_email_doc = doc.language == "email" or _looks_like_email_document(
            doc.current_content or "", doc.title or ""
        )
        new_content = (
            _coerce_email_document_content(doc.current_content or "", content)
            if is_email_doc
            else content.strip()
        )
        if is_email_doc:
            doc.language = "email"

        new_ver = doc.version_count + 1
        ver = DocumentVersion(
            id=str(uuid.uuid4()),
            document_id=target_id,
            version_number=new_ver,
            content=new_content,
            summary=f"Updated by {_active_model or 'AI'}",
            source="ai",
        )
        doc.current_content = new_content
        doc.version_count = new_ver
        db.add(ver)
        db.commit()

        return {
            "action": "update",
            "doc_id": target_id,
            "title": doc.title,
            "language": doc.language,
            "content": new_content,
            "version": new_ver,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to update document: {e}"}
    finally:
        db.close()


def parse_edit_blocks(content: str) -> list:
    """Parse <<<FIND>>>...<<<REPLACE>>>...<<<END>>> blocks."""
    edits = []
    pattern = r"<<<FIND>>>\n(.*?)\n<<<REPLACE>>>\n(.*?)\n<<<END>>>"
    for m in re.finditer(pattern, content, re.DOTALL):
        edits.append({"find": m.group(1), "replace": m.group(2)})
    return edits


async def do_edit_document(
    content: str, doc_id: Optional[str] = None, owner: Optional[str] = None
) -> Dict:
    """Apply targeted FIND/REPLACE edits to an existing document."""
    import uuid

    from src.database import Document, DocumentVersion, SessionLocal

    target_id = doc_id or _active_document_id

    edits = parse_edit_blocks(content)
    if not edits:
        return {"error": "No valid <<<FIND>>>...<<<REPLACE>>>...<<<END>>> blocks found"}

    db = SessionLocal()
    try:
        doc = None
        if target_id:
            doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            # Fallback: most recently updated document. Avoids "no active doc" errors
            # after server restart or when the agent loses track of which doc to edit.
            doc = _most_recent_owned_document(db, Document, owner)
            if doc:
                target_id = doc.id
                set_active_document(target_id)
                logger.info(
                    f"edit_document: fell back to most recent doc id={target_id} title={doc.title!r}"
                )
        if not doc:
            return {"error": "No documents exist to edit"}

        updated_content = doc.current_content
        applied = 0
        skipped = 0
        for edit in edits:
            _find = edit["find"]
            if _find in updated_content:
                updated_content = updated_content.replace(_find, edit["replace"], 1)
                applied += 1
            else:
                # Defensive: the active-doc context shows a "N\t" line-number
                # gutter for reference. Weaker models sometimes copy that prefix
                # into FIND. If the exact match failed, retry with a leading
                # "<digits><tab>" stripped from each FIND line — but only use it
                # when that stripped form actually matches, so we never corrupt a
                # legitimately tab-prefixed document.
                _stripped = "\n".join(re.sub(r"^\d+\t", "", _l) for _l in _find.split("\n"))
                if _stripped != _find and _stripped in updated_content:
                    updated_content = updated_content.replace(_stripped, edit["replace"], 1)
                    applied += 1
                    logger.info(
                        "edit_document: matched after stripping line-number gutter from FIND"
                    )
                else:
                    logger.warning(f"edit_document: FIND text not found, skipping: {_find[:80]!r}")
                    skipped += 1

        if applied == 0:
            return {
                "error": f"No edits applied — none of the FIND blocks matched the document content (skipped {skipped})"
            }

        new_ver = doc.version_count + 1
        ver = DocumentVersion(
            id=str(uuid.uuid4()),
            document_id=target_id,
            version_number=new_ver,
            content=updated_content,
            summary=f"Edited by {_active_model or 'AI'} ({applied} edit(s))",
            source="ai",
        )
        doc.current_content = updated_content
        doc.version_count = new_ver
        db.add(ver)
        db.commit()

        return {
            "action": "edit",
            "doc_id": target_id,
            "title": doc.title,
            "language": doc.language,
            "content": updated_content,
            "version": new_ver,
            "applied": applied,
            "skipped": skipped,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to edit document: {e}"}
    finally:
        db.close()


def parse_suggest_blocks(content: str) -> list:
    """Parse <<<FIND>>>...<<<SUGGEST>>>...<<<REASON>>>...<<<END>>> blocks."""
    suggestions = []
    _skip_phrases = ["no change", "clear", "fine as", "looks good", "no improvement", "keep as"]
    pattern = r"<<<FIND>>>\n(.*?)\n<<<SUGGEST>>>\n(.*?)\n<<<REASON>>>\n(.*?)\n<<<END>>>"
    for m in re.finditer(pattern, content, re.DOTALL):
        find_text = m.group(1)
        replace_text = m.group(2)
        reason = m.group(3).strip()
        # Skip no-op suggestions where find == replace or reason says no change
        if find_text.strip() == replace_text.strip():
            continue
        if any(phrase in reason.lower() for phrase in _skip_phrases):
            continue
        suggestions.append(
            {
                "id": f"sugg-{len(suggestions) + 1}",
                "find": find_text,
                "replace": replace_text,
                "reason": reason,
            }
        )
    return suggestions


async def do_suggest_document(
    content: str, doc_id: str = None, owner: Optional[str] = None
) -> Dict:
    """Create inline suggestions for the active document WITHOUT modifying it."""
    from src.database import Document, SessionLocal

    target_id = doc_id or _active_document_id
    if not target_id:
        return {"error": "No active document to suggest on"}

    suggestions = parse_suggest_blocks(content)
    if not suggestions:
        return {
            "error": "No valid <<<FIND>>>...<<<SUGGEST>>>...<<<REASON>>>...<<<END>>> blocks found"
        }

    db = SessionLocal()
    try:
        doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            return {"error": f"Document {target_id} not found"}

        # Validate that FIND text exists in document
        valid = []
        for s in suggestions:
            if s["find"] in doc.current_content:
                valid.append(s)
            else:
                logger.warning(
                    f"suggest_document: FIND text not found, skipping: {s['find'][:80]!r}"
                )

        if not valid:
            return {"error": "No suggestions matched the document content"}

        return {
            "action": "suggest",
            "doc_id": target_id,
            "suggestions": valid,
            "count": len(valid),
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Search chats
# ---------------------------------------------------------------------------


async def do_search_chats(query: str, limit: int = 20, owner: str | None = None) -> Dict:
    """Search past chat messages for the calling user's sessions only.

    Without an owner filter this used to leak EVERY user's chat history
    into the agent's `search_chats` results (v2 review HIGH-11). The
    caller in `tool_execution.execute_tool_block` now plumbs the owner
    through; legacy callers without owner pass through as before but
    will only see legacy/null-owner rows.
    """
    from src.database import ChatMessage as DBChatMessage
    from src.database import Session as DBSession
    from src.database import SessionLocal

    # Escape LIKE wildcards in the user-supplied query so a stray % or _
    # doesn't widen the match (and to keep the response deterministic).
    safe_q = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    db = SessionLocal()
    try:
        q = (
            db.query(DBChatMessage, DBSession.id, DBSession.name)
            .join(DBSession, DBChatMessage.session_id == DBSession.id)
            .filter(
                DBSession.archived == False,
                DBChatMessage.content.ilike(f"%{safe_q}%", escape="\\"),
                DBChatMessage.role.in_(["user", "assistant"]),
            )
        )
        if owner is not None:
            # Restrict to this user's sessions plus legacy null-owner
            # rows (so single-user upgrades keep seeing their own data).
            q = q.filter((DBSession.owner == owner) | (DBSession.owner.is_(None)))
        rows = q.order_by(DBChatMessage.timestamp.desc()).limit(limit).all()

        if not rows:
            return {"results": f'No chats found matching "{query}".'}

        # Group by session to avoid duplicate links
        seen_sessions = {}
        for msg, session_id, session_name in rows:
            if session_id not in seen_sessions:
                content = msg.content or ""
                lower_content = content.lower()
                idx = lower_content.find(query.lower())
                if idx == -1:
                    snippet = content[:150]
                else:
                    start = max(0, idx - 60)
                    end = min(len(content), idx + len(query) + 60)
                    snippet = (
                        ("..." if start > 0 else "")
                        + content[start:end]
                        + ("..." if end < len(content) else "")
                    )
                seen_sessions[session_id] = {
                    "name": session_name or "Untitled",
                    "snippet": snippet,
                    "role": msg.role,
                    "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
                }

        lines = [f'Found {len(seen_sessions)} session(s) matching "{query}":\n']
        for sid, info in seen_sessions.items():
            lines.append(f"- **{info['name']}** (#{sid})")
            lines.append(f"  Link: [Open chat](#{sid})")
            lines.append(f"  > {info['snippet']}")
            lines.append("")

        return {"results": "\n".join(lines)}
    except Exception as e:
        logger.error(f"search_chats failed: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Shared uploaded skills — read_skill tool
# ---------------------------------------------------------------------------


def _skill_matches_query(skill_meta: dict, query: str) -> bool:
    """Cheap relevance check: does the user's task overlap the skill's trigger
    text (name + description)? Word-level overlap so a spreadsheet request hits
    the 'xlsx' skill without a full embedding pass."""
    import re as _re

    q = (query or "").lower()
    if not q:
        return False
    tokens = {t for t in _re.split(r"[^a-z0-9]+", q) if len(t) > 3}
    if not tokens:
        return False
    hay = (skill_meta.get("name", "") + " " + skill_meta.get("description", "")).lower()
    hay_tokens = {t for t in _re.split(r"[^a-z0-9]+", hay) if len(t) > 3}
    # Direct name mention, or a couple of shared significant words.
    if skill_meta.get("name", "").lower() in q:
        return True
    overlap = tokens & hay_tokens
    return len(overlap) >= 2


async def do_browse_skills(
    content: str, owner: Optional[str] = None, workspace: Optional[str] = None
) -> Dict:
    """List the user's enabled skills and, for any that match the task, inline
    their full instructions so the model can follow them immediately.

    This is the forced 'look at your skills' step: the agent loop compels a call
    to this on the first round of a turn when at least one skill is enabled, so
    the model can't skip consulting the library. Accepts an optional
    `{"query": "..."}` (the user's task) used to decide which skills to expand.
    For matched skills that ship a bundle (references/scripts), the bundle is
    materialized into the workspace so the model can run those scripts — many
    skills (e.g. xlsx's recalc.py) require them.
    """
    query = ""
    raw = (content or "").strip()
    if raw.startswith("{"):
        try:
            args = _parse_tool_args(raw)
            query = str(args.get("query") or args.get("task") or "").strip()
        except ValueError:
            query = ""
    elif raw:
        query = raw

    try:
        from services.memory import shared_skills

        enabled = shared_skills.enabled_skills_for(owner)
    except Exception as e:
        logger.error(f"browse_skills failed: {e}")
        return {"error": f"Could not list skills: {e}", "exit_code": 1}

    if not enabled:
        return {"results": "No skills are enabled. Proceed with the task normally."}

    # Decide which skills to expand fully. With a query, expand the matches;
    # with no usable query, expand everything when the library is small so the
    # forced call still surfaces the method (the common single-skill case).
    matched = [s for s in enabled if _skill_matches_query(s, query)]
    if not matched and (not query or len(enabled) <= 2):
        matched = list(enabled)

    lines = ["## Your enabled skills"]
    for s in sorted(enabled, key=lambda x: x["name"]):
        lines.append(f"- {s['name']}: {s['description']}")

    expanded = []
    bundle_notes = []
    for s in sorted(matched, key=lambda x: x["name"]):
        try:
            full = shared_skills.get_skill(s["name"])
        except Exception as e:
            logger.warning(f"browse_skills expand failed for {s['name']}: {e}")
            continue
        if full and full.get("content"):
            expanded.append(f"### SKILL: {s['name']}\n{full['content']}")
        # Materialize any bundled files (references/scripts) so the model can
        # actually run them — the skill's instructions reference them by path.
        if full and full.get("file_paths") and workspace:
            try:
                import os as _os

                paths = full["file_paths"]
                dest = _os.path.join(workspace, "skills", s["name"])
                shared_skills.materialize(s["name"], dest)
                rel_dir = _os.path.join("skills", s["name"])
                # Point at a couple of representative scripts rather than dumping
                # all (a deep bundle can be dozens of files).
                scripts = [p for p in paths if p.lower().endswith(".py")][:6]
                script_hint = (
                    "e.g. " + "; ".join(f"`python {_os.path.join(rel_dir, p)}`" for p in scripts)
                    if scripts
                    else ""
                )
                bundle_notes.append(
                    f"- `{s['name']}`: {len(paths)} bundled file(s) written to "
                    f"`{dest}`. The skill's paths (e.g. `scripts/...`) are relative to "
                    f"that directory, so prefix them with `{rel_dir}/` when you run "
                    f"them from the workspace root. {script_hint}".rstrip()
                )
            except Exception as e:
                logger.warning(f"browse_skills materialize failed for {s['name']}: {e}")

    if expanded:
        lines.append(
            "\nOne or more skills fit this task. Their full instructions follow — "
            "carry out the task by following them EXACTLY, step by step, without "
            "deviating from or substituting your own method:"
        )
        lines.append("\n\n".join(expanded))
        if bundle_notes:
            lines.append(
                "\nBundled files for these skills have been placed in the workspace. "
                "Use these exact paths (do NOT expect the scripts at a bare "
                "`scripts/` path):\n" + "\n".join(bundle_notes)
            )
    else:
        lines.append(
            "\nNone of these skills clearly matches the task. If one does, load it "
            "with read_skill; otherwise proceed normally."
        )
    return {"results": "\n".join(lines)}


async def do_read_skill(
    content: str, owner: Optional[str] = None, workspace: Optional[str] = None
) -> Dict:
    """Load a shared (user-uploaded) skill by name, or one of its bundle files.

    Accepts `{"name": "...", "path": "..."}` JSON args, or fenced content with
    the skill name on line 1 and an optional bundle-file path on line 2.
    Without `path`: returns the full SKILL.md, lists bundled files, and (when a
    workspace is available) materializes the whole bundle to disk so bash/python
    can run its scripts. With `path`: returns that bundled file's content.
    Only skills the current user has ENABLED are readable — a disabled skill
    behaves as if it doesn't exist, matching the injected index.
    """
    raw = (content or "").strip()
    name, path = "", ""
    if raw.startswith("{"):
        try:
            args = _parse_tool_args(raw)
            name = str(args.get("name") or args.get("skill") or "").strip()
            path = str(args.get("path") or "").strip()
        except ValueError:
            return {"error": "Invalid JSON arguments", "exit_code": 1}
    else:
        lines = raw.splitlines()
        name = lines[0].strip() if lines else ""
        path = lines[1].strip() if len(lines) > 1 else ""
    if not name:
        return {"error": "name is required (the skill's name from the skills list)", "exit_code": 1}

    try:
        from services.memory import shared_skills

        enabled = {s["name"] for s in shared_skills.enabled_skills_for(owner)}
        skill = shared_skills.get_skill(name)
    except Exception as e:
        logger.error(f"read_skill failed: {e}")
        return {"error": f"Could not load skill: {e}", "exit_code": 1}

    if skill is None or skill["name"] not in enabled:
        available = ", ".join(sorted(enabled)) or "(none)"
        return {
            "error": f"No enabled skill named {name!r}. Enabled skills: {available}",
            "exit_code": 1,
        }

    # Level 2: a single bundled reference/script file.
    if path:
        data = shared_skills.get_skill_file(skill["name"], path)
        if data is None:
            listing = ", ".join(skill.get("file_paths") or []) or "(no bundled files)"
            return {
                "error": f"No file {path!r} in skill {skill['name']!r}. Bundled files: {listing}",
                "exit_code": 1,
            }
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return {
                "results": (
                    f"{path} is a binary file ({len(data)} bytes). It has been "
                    "materialized in the workspace (load the skill without a path "
                    "first if it isn't) — use bash/python to work with it."
                )
            }
        return {"results": f"=== {skill['name']} / {path} ===\n{text}"}

    # Level 1: the SKILL.md itself (+ bundle listing / materialization).
    extra = ""
    file_paths = skill.get("file_paths") or []
    if file_paths:
        listing = "\n".join(f"  - {p}" for p in file_paths)
        extra = (
            f"\n\nBundled files (load one with read_skill name + path when the "
            f"skill refers to it):\n{listing}"
        )
        if workspace:
            try:
                import os as _os

                dest = _os.path.join(workspace, "skills", skill["name"])
                shared_skills.materialize(skill["name"], dest)
                extra += (
                    f"\n\nThe full bundle (incl. scripts) is on disk at: {dest}\n"
                    "Run its scripts from there with bash/python when the skill says to."
                )
            except Exception as e:
                logger.warning(f"read_skill materialize failed: {e}")
    return {
        "results": (
            f"=== SKILL: {skill['name']} ===\n{skill['content']}{extra}\n\n"
            "[Instruction: You have now loaded this skill. Follow its method "
            "EXACTLY as written, step by step — do not deviate from, reorder, "
            "or substitute the procedure it prescribes.]"
        )
    }


async def do_create_skill(
    content: str, owner: Optional[str] = None, session_id: Optional[str] = None
) -> Dict:
    """Create or update a shared skill FROM the agent (skill-creator support).

    Args (JSON):
      - `source_dir`: a workspace folder the agent built, holding SKILL.md plus
        any references/scripts. The whole folder is packaged as the skill's
        bundle (this is the normal path — it captures scripts/references).
      - `content`: alternatively, the full SKILL.md text for a single-file skill.
      - `name`: optional; otherwise taken from the SKILL.md frontmatter.

    The saved skill is auto-enabled for its author and becomes available to every
    user (who each opt in). This is the write counterpart to read_skill/
    browse_skills, so a skill that teaches skill authoring can actually produce a
    new skill on Talos.
    """
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    from services.memory import shared_skills

    source_dir = str(args.get("source_dir") or args.get("dir") or "").strip().strip("/")
    inline = args.get("content")

    try:
        if source_dir:
            import io
            import zipfile

            from src.sandbox_client import download_workspace_zip

            raw = await download_workspace_zip(owner=owner, session_id=session_id)
            prefix = source_dir + "/"
            bundle_files: Dict[str, bytes] = {}
            skill_md = None
            total = 0
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for info in zf.infolist():
                    nm = info.filename.replace("\\", "/")
                    if info.is_dir() or not nm.startswith(prefix):
                        continue
                    rel = nm[len(prefix) :]
                    if not rel:
                        continue
                    data = zf.read(info)
                    if rel.lower() == "skill.md":
                        try:
                            skill_md = data.decode("utf-8")
                        except UnicodeDecodeError:
                            return {"error": "SKILL.md is not valid UTF-8", "exit_code": 1}
                        continue
                    safe = shared_skills._safe_bundle_path(rel)
                    if safe is None:
                        continue
                    total += len(data)
                    if (
                        len(data) > shared_skills.MAX_BUNDLE_FILE_BYTES
                        or total > shared_skills.MAX_BUNDLE_TOTAL_BYTES
                        or len(bundle_files) >= shared_skills.MAX_BUNDLE_FILES
                    ):
                        return {
                            "error": "Skill bundle exceeds size/file limits; trim the folder.",
                            "exit_code": 1,
                        }
                    bundle_files[safe] = data
            if skill_md is None:
                return {
                    "error": f"No SKILL.md found in workspace folder {source_dir!r}. "
                    "Create it there first (with a name + description frontmatter).",
                    "exit_code": 1,
                }
            meta = shared_skills.save_skill(skill_md, uploader=owner, bundle_files=bundle_files)
        elif isinstance(inline, str) and inline.strip():
            meta = shared_skills.save_skill(inline, uploader=owner)
        else:
            return {
                "error": "Provide either source_dir (a workspace folder containing "
                "SKILL.md) or content (the full SKILL.md text).",
                "exit_code": 1,
            }
    except PermissionError as e:
        return {"error": str(e), "exit_code": 1}
    except ValueError as e:
        return {"error": str(e), "exit_code": 1}
    except Exception as e:
        logger.error(f"create_skill failed: {e}")
        return {"error": f"Could not save skill: {e}", "exit_code": 1}

    try:
        shared_skills.set_enabled(owner, meta["name"], True)
    except Exception:
        pass
    return {
        "results": (
            f"Saved shared skill `{meta['name']}` ({meta.get('files', 0)} bundled "
            "file(s)) and enabled it for you. It is now in the skill library; other "
            "users can enable it in Settings → Skills. Test it by starting a fresh "
            "request that should trigger it."
        )
    }


# ---------------------------------------------------------------------------
# Skills management tool
# ---------------------------------------------------------------------------


async def do_manage_skills(content: str, owner: Optional[str] = None) -> Dict:
    """Handle manage_skills tool calls.

    SKILL.md-backed CRUD with progressive disclosure (Hermes-style). Actions:

      list / index               — Level 0: name + description summary.
      view {name}                — Level 1: full SKILL.md.
      view_ref {name, path}      — Level 2: a sub-file under the skill dir.
      add  {name, description, when_to_use, procedure[], pitfalls[],
            verification[], tags[], category, status}
                                 — Create a new skill (draft by default).
      patch {name, old_string, new_string}
                                 — Token-efficient surgical edit on the
                                   raw SKILL.md text. Fails on ambiguous
                                   `old_string` (multiple matches).
      edit  {name, content}      — Replace the entire SKILL.md.
      publish {name}             — Flip status: draft -> published.
      delete {name}              — Remove the skill directory.
      search {query}             — Relevance match on published skills.
    """
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = (args.get("action") or "").lower()
    from services.memory.skill_format import Skill, slugify
    from services.memory.skills import SkillsManager
    from src.constants import DATA_DIR

    sm = SkillsManager(DATA_DIR)

    # Accept legacy `skill_id` as an alias for `name`.
    name = (args.get("name") or args.get("skill_id") or "").strip()

    if action in ("list", "index", ""):
        all_skills = sm.load(owner=owner)
        if not all_skills:
            return {"results": "No skills yet. Create one with action='add'."}
        published = [s for s in all_skills if s.get("status") == "published"]
        drafts = [s for s in all_skills if s.get("status") == "draft"]
        lines = []
        if published:
            lines.append("## Published")
            for s in sorted(published, key=lambda x: x["name"]):
                lines.append(
                    f"- **{s['name']}** ({s.get('category', 'general')}): {s.get('description', '')}"
                )
        if drafts:
            lines.append("\n## Drafts")
            for s in sorted(drafts, key=lambda x: x["name"]):
                lines.append(f"- **{s['name']}** [draft]: {s.get('description', '')}")
        return {"results": "\n".join(lines) if lines else "No skills yet."}

    if action == "view":
        if not name:
            return {"error": "name is required for view", "exit_code": 1}
        md = sm.read_skill_md(name, owner=owner)
        if md is None:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        return {"results": md}

    if action == "view_ref":
        if not name:
            return {"error": "name is required for view_ref", "exit_code": 1}
        ref = (args.get("path") or "").strip()
        if not ref:
            return {"error": "path is required for view_ref", "exit_code": 1}
        text = sm.read_skill_reference(name, ref, owner=owner)
        if text is None:
            return {"error": f"Reference {ref!r} not found under {name!r}", "exit_code": 1}
        return {"results": text}

    if action == "add":
        if not name:
            return {
                "error": "name is required for add. Provide the exact slug the user should see, then report the returned name.",
                "exit_code": 1,
            }
        proc = args.get("procedure")
        if proc is None:
            proc = args.get("steps") or []
        if not proc and not args.get("body_extra") and not args.get("solution"):
            return {"error": "procedure (or solution body) is required", "exit_code": 1}
        entry = sm.add_skill(
            name=args.get("name"),
            description=(args.get("description") or args.get("title") or "").strip(),
            category=args.get("category") or "general",
            tags=args.get("tags") or [],
            platforms=args.get("platforms") or [],
            requires_toolsets=args.get("requires_toolsets") or [],
            fallback_for_toolsets=args.get("fallback_for_toolsets") or [],
            when_to_use=(
                args.get("when_to_use")
                if args.get("when_to_use") is not None
                else args.get("problem", "")
            ),
            procedure=proc,
            pitfalls=args.get("pitfalls") or [],
            verification=args.get("verification") or [],
            status=args.get("status") or "draft",
            version=args.get("version") or "1.0.0",
            confidence=args.get("confidence", 0.8),
            source=args.get("source", "learned"),
            teacher_model=args.get("teacher_model"),
            owner=owner,
            title=args.get("title", ""),
            problem=args.get("problem", ""),
            solution=args.get("solution", ""),
            steps=args.get("steps") or [],
        )
        if entry.get("_deduped"):
            return {
                "results": (
                    f"A near-identical skill already exists: `{entry['name']}` — not creating "
                    f"a duplicate. View or edit it with action='view', name='{entry['name']}'."
                )
            }
        verify_hint = ""
        if entry.get("status") == "draft":
            verify_hint = (
                "\n\nThis skill is a DRAFT. Run through the procedure once to verify, "
                f"then publish with action='publish', name='{entry['name']}'."
            )
        return {
            "results": f"Created skill `{entry['name']}` — {entry.get('description', '')}{verify_hint}"
        }

    if action == "edit":
        if not name:
            return {"error": "name is required for edit", "exit_code": 1}
        new_content = args.get("content")
        if not isinstance(new_content, str) or not new_content.strip():
            return {"error": "content (full SKILL.md) is required for edit", "exit_code": 1}
        try:
            sk_new = Skill.from_markdown(new_content)
        except Exception as e:
            return {"error": f"Could not parse content as SKILL.md: {e}", "exit_code": 1}
        sk_new.name = slugify(sk_new.name or name)
        existing = sm.load(owner=owner)
        match = next((s for s in existing if s.get("name") == name), None)
        if not match:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        if not sk_new.owner:
            sk_new.owner = match.get("owner") or owner
        ok = sm.update_skill(name, _skill_dump(sk_new), owner=owner)
        return (
            {"results": f"Edited skill `{sk_new.name}`."}
            if ok
            else {"error": "Update failed", "exit_code": 1}
        )

    if action == "patch":
        if not name:
            return {"error": "name is required for patch", "exit_code": 1}
        old = args.get("old_string")
        new_str = args.get("new_string", "")
        if not isinstance(old, str) or not old:
            return {"error": "old_string is required and must be non-empty", "exit_code": 1}
        md = sm.read_skill_md(name, owner=owner)
        if md is None:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        count = md.count(old)
        if count == 0:
            return {"error": "old_string not found in SKILL.md", "exit_code": 1}
        if count > 1:
            return {
                "error": f"old_string is ambiguous (appears {count} times). Make it more specific.",
                "exit_code": 1,
            }
        new_md = md.replace(old, new_str, 1)
        try:
            sk_new = Skill.from_markdown(new_md)
        except Exception as e:
            return {"error": f"Patched content is not valid SKILL.md: {e}", "exit_code": 1}
        sk_new.name = slugify(sk_new.name or name)
        ok = sm.update_skill(name, _skill_dump(sk_new), owner=owner)
        return (
            {"results": f"Patched skill `{sk_new.name}`."}
            if ok
            else {"error": "Patch update failed", "exit_code": 1}
        )

    if action == "publish":
        if not name:
            return {"error": "name is required for publish", "exit_code": 1}
        all_skills = sm.load(owner=owner)
        match = next((s for s in all_skills if s.get("name") == name), None)
        if not match:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        updates = {"status": "published"}
        if args.get("confidence") is not None:
            updates["confidence"] = max(0.0, min(1.0, float(args["confidence"])))
        sm.update_skill(name, updates, owner=owner)
        return {
            "results": f"✅ Published `{name}`. It now appears in the skills index for future turns."
        }

    if action == "delete":
        if not name:
            return {"error": "name is required for delete", "exit_code": 1}
        ok = sm.delete_skill(name, owner=owner)
        return (
            {"results": f"Deleted skill `{name}`."}
            if ok
            else {"error": f"Skill {name!r} not found", "exit_code": 1}
        )

    if action == "search":
        query = (args.get("query") or "").strip()
        if not query:
            return {"error": "query is required for search", "exit_code": 1}
        results = sm.get_relevant_skills(query, sm.load(owner=owner), max_items=5)
        if not results:
            return {"results": "No matching skills found."}
        lines = []
        for sk in results:
            proc = sk.get("procedure") or sk.get("steps") or []
            steps_str = " → ".join(proc[:5])
            lines.append(
                f"**{sk['name']}**: {sk.get('description', '')}\n  When: {sk.get('when_to_use', '')}\n  Steps: {steps_str}"
            )
        return {"results": "\n\n".join(lines)}

    return {
        "error": (
            f"Unknown action: {action!r}. "
            "Use one of: list, view, view_ref, add, edit, patch, publish, delete, search."
        ),
        "exit_code": 1,
    }


def _skill_dump(sk) -> Dict:
    """Translate a parsed Skill back into the kwargs `update_skill` expects."""
    return {
        "name": sk.name,
        "description": sk.description,
        "version": sk.version,
        "category": sk.category,
        "tags": sk.tags,
        "platforms": sk.platforms,
        "requires_toolsets": sk.requires_toolsets,
        "fallback_for_toolsets": sk.fallback_for_toolsets,
        "status": sk.status,
        "confidence": sk.confidence,
        "source": sk.source,
        "teacher_model": sk.teacher_model,
        "owner": sk.owner,
        "when_to_use": sk.when_to_use,
        "procedure": sk.procedure,
        "pitfalls": sk.pitfalls,
        "verification": sk.verification,
        "body_extra": sk.body_extra,
    }



# ---------------------------------------------------------------------------
# Endpoint management tool
# ---------------------------------------------------------------------------


async def do_manage_endpoints(content: str, owner: Optional[str] = None) -> Dict:
    """Manage model endpoints: list, add, delete, enable, disable."""
    from core.database import ModelEndpoint, SessionLocal

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        if action == "list":
            eps = db.query(ModelEndpoint).all()
            items = [
                {"id": e.id, "name": e.name, "base_url": e.base_url, "is_enabled": e.is_enabled}
                for e in eps
            ]
            return {"response": f"{len(items)} endpoints", "endpoints": items, "exit_code": 0}

        elif action == "add":
            import uuid as _uuid

            name = args.get("name", "")
            base_url = args.get("base_url", "")
            api_key = args.get("api_key", "")
            if not base_url:
                return {"error": "base_url is required", "exit_code": 1}
            eid = str(_uuid.uuid4())[:8]
            from datetime import datetime

            ep = ModelEndpoint(
                id=eid,
                name=name or base_url,
                base_url=base_url,
                api_key=api_key,
                is_enabled=True,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            db.add(ep)
            db.commit()
            return {"response": f"Added endpoint '{name or base_url}' (id: {eid})", "exit_code": 0}

        elif action == "delete":
            eid = args.get("endpoint_id", "")
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
            if not ep:
                return {"error": f"Endpoint {eid} not found", "exit_code": 1}
            name = ep.name
            db.delete(ep)
            db.commit()
            return {"response": f"Deleted endpoint '{name}'", "exit_code": 0}

        elif action in ("enable", "disable"):
            eid = args.get("endpoint_id", "")
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
            if not ep:
                return {"error": f"Endpoint {eid} not found", "exit_code": 1}
            ep.is_enabled = action == "enable"
            db.commit()
            return {"response": f"Endpoint '{ep.name}' {action}d", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_endpoints error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# MCP server management tool
# ---------------------------------------------------------------------------


async def do_manage_mcp(content: str, owner: Optional[str] = None) -> Dict:
    """Manage MCP servers: list, add, delete, enable, disable, reconnect."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")

    if action == "list":
        mcp = get_mcp_manager()
        if not mcp:
            return {"response": "No MCP manager available", "servers": [], "exit_code": 0}
        from core.database import McpServer, SessionLocal

        db = SessionLocal()
        try:
            servers = db.query(McpServer).all()
            items = []
            for s in servers:
                st = mcp.get_server_status(s.id)
                status = st.get("status", "disconnected")
                tool_count = st.get("tool_count", 0)
                items.append(
                    {
                        "id": s.id,
                        "name": s.name,
                        "transport": s.transport,
                        "is_enabled": s.is_enabled,
                        "status": status,
                        "tool_count": tool_count,
                    }
                )
            return {"response": f"{len(items)} MCP servers", "servers": items, "exit_code": 0}
        finally:
            db.close()

    elif action == "add":
        import uuid as _uuid
        from datetime import datetime

        from core.database import McpServer, SessionLocal

        name = args.get("name", "")
        command = args.get("command", "")
        cmd_args = args.get("args", [])
        env = args.get("env", {})
        if not name or not command:
            return {"error": "name and command are required", "exit_code": 1}
        sid = str(_uuid.uuid4())[:8]
        db = SessionLocal()
        try:
            srv = McpServer(
                id=sid,
                name=name,
                transport="stdio",
                command=command,
                args=json.dumps(cmd_args) if isinstance(cmd_args, list) else cmd_args,
                env=json.dumps(env) if isinstance(env, dict) else env,
                is_enabled=True,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            db.add(srv)
            db.commit()
        finally:
            db.close()
        # Try to connect
        mcp = get_mcp_manager()
        tool_count = 0
        if mcp:
            try:
                await mcp.connect_server(
                    sid,
                    name,
                    "stdio",
                    command=command,
                    args=cmd_args if isinstance(cmd_args, list) else json.loads(cmd_args),
                    env=env if isinstance(env, dict) else json.loads(env),
                )
                st = mcp.get_server_status(sid)
                tool_count = st.get("tool_count", 0)
            except Exception as e:
                logger.warning(f"MCP connect failed for {name}: {e}")
        return {"response": f"Added MCP server '{name}' ({tool_count} tools)", "exit_code": 0}

    elif action == "delete":
        sid = args.get("server_id", "")
        from core.database import McpServer, SessionLocal

        db = SessionLocal()
        try:
            srv = db.query(McpServer).filter(McpServer.id == sid).first()
            if not srv:
                return {"error": f"Server {sid} not found", "exit_code": 1}
            name = srv.name
            mcp = get_mcp_manager()
            if mcp:
                try:
                    await mcp.disconnect_server(sid)
                except Exception:
                    pass
            db.delete(srv)
            db.commit()
            return {"response": f"Deleted MCP server '{name}'", "exit_code": 0}
        finally:
            db.close()

    elif action == "reconnect":
        sid = args.get("server_id", "")
        mcp = get_mcp_manager()
        if not mcp:
            return {"error": "MCP manager not available", "exit_code": 1}
        try:
            await mcp.disconnect_server(sid)
            from core.database import McpServer, SessionLocal

            db2 = SessionLocal()
            try:
                srv = db2.query(McpServer).filter(McpServer.id == sid).first()
                if srv:
                    _args = json.loads(srv.args) if srv.args else []
                    _env = json.loads(srv.env) if srv.env else {}
                    await mcp.connect_server(
                        server_id=sid,
                        name=srv.name,
                        transport=srv.transport,
                        command=srv.command,
                        args=_args,
                        env=_env,
                        url=srv.url,
                    )
                    st = mcp.get_server_status(sid)
                    return {
                        "response": f"Reconnected '{srv.name}' ({st.get('tool_count', 0)} tools)",
                        "exit_code": 0,
                    }
                return {"error": f"Server {sid} not found", "exit_code": 1}
            finally:
                db2.close()
        except Exception as e:
            return {"error": str(e), "exit_code": 1}

    elif action in ("enable", "disable"):
        sid = args.get("server_id", "")
        from core.database import McpServer, SessionLocal

        db = SessionLocal()
        try:
            srv = db.query(McpServer).filter(McpServer.id == sid).first()
            if not srv:
                return {"error": f"Server {sid} not found", "exit_code": 1}
            srv.is_enabled = action == "enable"
            db.commit()
            return {"response": f"MCP server '{srv.name}' {action}d", "exit_code": 0}
        finally:
            db.close()

    elif action == "list_tools":
        mcp = get_mcp_manager()
        if not mcp:
            return {"response": "No MCP manager", "tools": [], "exit_code": 0}
        tools = mcp.get_all_tools()
        items = [
            {
                "name": t["name"],
                "server": t["server_name"],
                "description": t.get("description", "")[:100],
            }
            for t in tools
        ]
        return {"response": f"{len(items)} MCP tools available", "tools": items, "exit_code": 0}

    else:
        return {"error": f"Unknown action: {action}", "exit_code": 1}



# ---------------------------------------------------------------------------
# API token management tool
# ---------------------------------------------------------------------------


async def do_manage_tokens(content: str, owner: Optional[str] = None) -> Dict:
    """Manage API tokens: list, create, delete."""
    from core.database import ApiToken, SessionLocal

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        if action == "list":
            tokens = db.query(ApiToken).all()
            items = [
                {
                    "id": t.id,
                    "name": t.name,
                    "token_prefix": t.token_prefix + "...",
                    "is_active": t.is_active,
                }
                for t in tokens
            ]
            return {"response": f"{len(items)} API tokens", "tokens": items, "exit_code": 0}

        elif action == "create":
            import secrets
            import uuid as _uuid
            from datetime import datetime

            import bcrypt

            name = args.get("name", "API Token")
            raw_token = secrets.token_urlsafe(32)
            token_hash = bcrypt.hashpw(raw_token.encode(), bcrypt.gensalt()).decode()
            tid = str(_uuid.uuid4())[:8]
            t = ApiToken(
                id=tid,
                name=name,
                token_hash=token_hash,
                token_prefix=raw_token[:8],
                is_active=True,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            )
            db.add(t)
            db.commit()
            return {"response": f"Created token '{name}'", "token": raw_token, "exit_code": 0}

        elif action == "delete":
            tid = args.get("token_id", "")
            t = db.query(ApiToken).filter(ApiToken.id == tid).first()
            if not t:
                return {"error": f"Token {tid} not found", "exit_code": 1}
            name = t.name
            db.delete(t)
            db.commit()
            return {"response": f"Deleted token '{name}'", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_tokens error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Document management tool (delete, list, organize)
# ---------------------------------------------------------------------------


async def do_manage_documents(content: str, owner: Optional[str] = None) -> Dict:
    """Manage documents: list, read/view/open, delete, tidy.

    Output format mirrors `manage_session`: list rows include a
    clickable `[Title](#document-<id>)` anchor + relative timestamps
    so the user can click straight from chat to open the editor.
    """
    from datetime import datetime, timezone

    from core.database import Document, SessionLocal

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()

    def _rel(ts):
        if not ts:
            return "never"
        try:
            now = datetime.now(timezone.utc) if ts.tzinfo is not None else datetime.utcnow()
            diff = (now - ts).total_seconds()
        except Exception:
            return "unknown"
        if diff < 60:
            return "just now"
        if diff < 3600:
            return f"{int(diff / 60)}m ago"
        if diff < 86400:
            return f"{int(diff / 3600)}h ago"
        if diff < 86400 * 7:
            return f"{int(diff / 86400)}d ago"
        return ts.strftime("%Y-%m-%d")

    try:
        if action == "list":
            q = db.query(Document).filter(Document.is_active == True)
            q = _owned_document_query(q, Document, owner)
            if args.get("search"):
                q = q.filter(Document.title.ilike(f"%{args['search']}%"))
            if args.get("language"):
                q = q.filter(Document.language == args["language"])
            docs = q.order_by(Document.updated_at.desc()).limit(args.get("limit", 50)).all()
            if not docs:
                msg = (
                    "No documents found"
                    + (f" matching '{args['search']}'" if args.get("search") else "")
                    + "."
                )
                return {"response": msg, "documents": [], "exit_code": 0}
            lines = []
            items = []
            for i, d in enumerate(docs):
                size = len(d.current_content or "")
                lang = d.language or "text"
                ts = getattr(d, "updated_at", None) or getattr(d, "created_at", None)
                marker = " ← most recent" if i == 0 else ""
                lines.append(
                    f"- [{d.title}](#document-{d.id}) — {lang}, {size} chars, updated {_rel(ts)}{marker}"
                )
                items.append({"id": d.id, "title": d.title, "language": lang, "size": size})
            header = (
                f"Found {len(docs)} document(s), sorted most-recent first. Click a title to open:"
            )
            return {
                "response": header + "\n" + "\n".join(lines),
                "documents": items,
                "exit_code": 0,
            }

        elif action in ("read", "view", "open", "get"):
            doc_id = args.get("document_id") or args.get("id") or args.get("uid")
            if not doc_id:
                return {"error": "Need document_id (use action=list to find one)", "exit_code": 1}
            doc = _get_owned_document(db, Document, doc_id, owner, active_only=True)
            if not doc:
                return {"error": f"Document '{doc_id}' not found", "exit_code": 1}
            body = doc.current_content or ""
            preview_limit = int(args.get("limit", MAX_READ_CHARS))
            truncated = len(body) > preview_limit
            preview = body[:preview_limit] + (
                f"\n... (truncated, {len(body)} chars total)" if truncated else ""
            )
            anchor = f"[{doc.title}](#document-{doc.id})"
            return {
                "response": f"{anchor} — click to open in editor.\n\n```{doc.language or ''}\n{preview}\n```",
                "document": {
                    "id": doc.id,
                    "title": doc.title,
                    "language": doc.language,
                    "size": len(body),
                    "content": preview,
                    "truncated": truncated,
                },
                "exit_code": 0,
            }

        elif action == "delete":
            doc_id = (
                args.get("document_id") or args.get("id") or args.get("uid") or _active_document_id
            )
            doc = None
            if doc_id:
                doc = _get_owned_document(db, Document, doc_id, owner)
            if not doc:
                # Fallback: most recently updated doc (likely what the user means)
                doc = _most_recent_owned_document(db, Document, owner, active_only=True)
            if not doc:
                return {"error": "No document to delete", "exit_code": 1}
            title = doc.title
            doc.is_active = False
            db.commit()
            if _active_document_id == doc.id:
                set_active_document(None)
            return {"response": f"Deleted document '{title}'", "exit_code": 0}

        elif action == "tidy":
            from src.document_actions import run_document_tidy

            result = await run_document_tidy(owner or "")
            return {"response": result, "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_documents error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Settings/preferences management tool
# ---------------------------------------------------------------------------


async def do_manage_settings(content: str, owner: Optional[str] = None) -> Dict:
    """Manage user settings and preferences."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")

    from core.database import SessionLocal

    db = SessionLocal()
    try:
        # set/get/list/delete operate on the REAL app settings (the same store
        # the Settings panel writes), so changing a model / voice / search
        # engine / reminder channel from chat actually takes effect.
        from src.settings import DEFAULT_SETTINGS, load_settings, save_settings

        # Secrets/credentials the agent must NOT write — kept read-only (masked)
        # so API keys never flow through chat. User sets these in the panel.
        _SECRET_KEYS = {
            "app_public_url",
        }

        def _is_secret(k):
            # `token` must be a suffix, not a substring: otherwise the int
            # setting `agent_input_token_budget` (which even has a "token budget"
            # alias to set it from chat) is wrongly classified as a credential.
            return (
                k in _SECRET_KEYS
                or k.endswith("token")
                or any(t in k for t in ("api_key", "_key", "secret", "password"))
            )

        # Friendly aliases → real keys, so natural phrasing resolves.
        _ALIASES_SET = {
            "voice": "tts_voice",
            "tts voice": "tts_voice",
            "tts": "tts_enabled",
            "text to speech": "tts_enabled",
            "tts provider": "tts_provider",
            "speech speed": "tts_speed",
            "voice speed": "tts_speed",
            "stt": "stt_enabled",
            "speech to text": "stt_enabled",
            "transcription": "stt_enabled",
            "default model": "default_model",
            "chat model": "default_model",
            "default endpoint": "default_endpoint_id",
            "utility model": "utility_model",
            "research model": "research_model",
            "research max tokens": "research_max_tokens",
            "vision model": "vision_model",
            "vision": "vision_enabled",
            "image model": "image_model",
            "image quality": "image_quality",
            "image gen": "image_gen_enabled",
            "image generation": "image_gen_enabled",
            "reminder channel": "reminder_channel",
            "reminders": "reminder_channel",
            "ntfy topic": "reminder_ntfy_topic",
            "agent tool calls": "agent_max_tool_calls",
            "max tool calls": "agent_max_tool_calls",
            "agent timeout": "agent_stream_timeout_seconds",
            "stream timeout": "agent_stream_timeout_seconds",
            "token budget": "agent_input_token_budget",
            "input budget": "agent_input_token_budget",
            "hard max": "agent_input_token_hard_max",
            "token budget cap": "agent_input_token_hard_max",
            "input budget cap": "agent_input_token_hard_max",
        }

        def _resolve(k):
            k2 = (k or "").strip().lower()
            if k2 in DEFAULT_SETTINGS:
                return k2
            return _ALIASES_SET.get(k2, (k or "").strip())

        _ENUMS = {
            "image_quality": ["low", "medium", "high"],
            "reminder_channel": ["browser", "email", "ntfy"],
        }

        def _coerce(value, default):
            if isinstance(default, bool):
                return (
                    value
                    if isinstance(value, bool)
                    else str(value).strip().lower()
                    in ("true", "on", "yes", "1", "enable", "enabled")
                )
            if isinstance(default, int):
                return int(value)
            return value

        def _model_slug(value: str) -> str:
            import re as _re

            return _re.sub(r"[^a-z0-9]+", "", (value or "").lower())

        def _endpoint_model_from_cache(model_query: str):
            """Resolve friendly model text to an enabled endpoint + real model id.

            The Settings UI stores both `<prefix>_endpoint_id` and
            `<prefix>_model`; writing only the model leaves the runtime on the
            old endpoint. Prefer cached model lists so this stays fast/offline.
            """
            import json as _json
            import re as _re

            from core.database import ModelEndpoint

            wanted = (model_query or "").strip()
            wanted_slug = _model_slug(wanted)
            wanted_tokens = [_model_slug(t) for t in _re.findall(r"[A-Za-z0-9]+", wanted)]
            wanted_tokens = [t for t in wanted_tokens if t]
            if not wanted_slug:
                return None
            best = None
            for ep in db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).all():
                raw_models = []
                try:
                    raw_models = _json.loads(ep.cached_models or "[]") or []
                except Exception:
                    raw_models = []
                # If cache is empty, still allow matching against endpoint name
                # for callers using model@endpoint elsewhere later.
                for mid in raw_models:
                    mid = str(mid)
                    mid_slug = _model_slug(mid)
                    if not mid_slug:
                        continue
                    exact = mid.lower() == wanted.lower()
                    compact_match = wanted_slug in mid_slug or mid_slug in wanted_slug
                    token_match = bool(wanted_tokens) and all(
                        tok in mid_slug for tok in wanted_tokens
                    )
                    if exact or compact_match or token_match:
                        score = 3 if exact else (2 if compact_match else 1)
                        if not best or score > best[0]:
                            best = (score, ep.id, mid)
            if best:
                return {"endpoint_id": best[1], "model": best[2]}
            return None

        def _mask(k, v):
            return "••••• (set in panel)" if _is_secret(k) and v else v

        if action == "list":
            s = load_settings()
            shown = {
                k: _mask(k, v)
                for k, v in s.items()
                if k in DEFAULT_SETTINGS and not isinstance(v, dict)
            }
            return {
                "response": f"{len(shown)} settings (use get/set with a key)",
                "settings": shown,
                "exit_code": 0,
            }

        elif action == "get":
            key = _resolve(args.get("key", ""))
            if not key:
                return {"error": "key is required", "exit_code": 1}
            if key not in DEFAULT_SETTINGS:
                return {
                    "error": f"Unknown setting '{args.get('key')}'. Use action='list' to see them.",
                    "exit_code": 1,
                }
            val = load_settings().get(key, DEFAULT_SETTINGS.get(key))
            return {
                "response": f"{key} = {_mask(key, val)}",
                "value": _mask(key, val),
                "exit_code": 0,
            }

        elif action == "set":
            raw = args.get("key", "")
            value = args.get("value")
            if not raw:
                return {"error": "key is required", "exit_code": 1}
            key = _resolve(raw)
            if key not in DEFAULT_SETTINGS:
                return {
                    "error": f"Unknown setting '{raw}'. Use action='list' to see available settings.",
                    "exit_code": 1,
                }
            if _is_secret(key):
                return {
                    "response": f"'{key}' is a credential/secret — for security I can't set it from chat. Open Settings and set it there.",
                    "exit_code": 0,
                }
            # Structured settings (dicts/lists like keybinds, default_model_fallbacks)
            # have no safe scalar coercion — _coerce would pass a bare string
            # straight through and clobber the structure. Refuse them here; they're
            # edited in their dedicated panels. (reset/delete still restore the
            # default structure, which is safe.)
            if isinstance(DEFAULT_SETTINGS[key], (dict, list)):
                return {
                    "response": f"'{key}' is a structured setting — edit it in its panel, not from chat. (You can reset it to default here.)",
                    "exit_code": 0,
                }
            try:
                value = _coerce(value, DEFAULT_SETTINGS[key])
            except (ValueError, TypeError):
                return {
                    "error": f"'{value}' isn't a valid value for {key} (expected {type(DEFAULT_SETTINGS[key]).__name__}).",
                    "exit_code": 1,
                }
            if key in _ENUMS and str(value).lower() not in _ENUMS[key]:
                return {"error": f"{key} must be one of: {', '.join(_ENUMS[key])}.", "exit_code": 1}
            s = load_settings()
            s[key] = value
            if key in {
                "default_model",
                "research_model",
                "utility_model",
                "vision_model",
                "image_model",
            }:
                resolved = _endpoint_model_from_cache(str(value))
                if resolved:
                    prefix = key[:-6]
                    s[f"{prefix}_endpoint_id"] = resolved["endpoint_id"]
                    s[key] = resolved["model"]
                    value = resolved["model"]
            save_settings(s)
            if key.endswith("_model") and s.get(f"{key[:-6]}_endpoint_id"):
                return {
                    "response": f"Set {key} = {value} (endpoint {s.get(f'{key[:-6]}_endpoint_id')}).",
                    "exit_code": 0,
                }
            return {"response": f"Set {key} = {value}.", "exit_code": 0}

        elif action == "delete" or action == "reset":
            key = _resolve(args.get("key", ""))
            if key not in DEFAULT_SETTINGS:
                return {"error": f"Unknown setting '{args.get('key')}'.", "exit_code": 1}
            if _is_secret(key):
                return {
                    "response": f"'{key}' is a credential — reset it in the panel.",
                    "exit_code": 0,
                }
            s = load_settings()
            s[key] = DEFAULT_SETTINGS[key]
            save_settings(s)
            return {
                "response": f"Reset {key} to default ({DEFAULT_SETTINGS[key]}).",
                "exit_code": 0,
            }

        elif action in ("disable_tool", "enable_tool", "list_tools"):
            # Tool-toggle actions. These edit settings.json:disabled_tools
            # (the global list read on every chat request) rather than
            # prefs.json. Friendly aliases accepted: "shell" -> "bash",
            # "browser" -> "builtin_browser", "documents" -> the document
            # tool set, etc.
            from src.settings import get_setting, load_settings, save_settings

            _ALIASES = {
                "shell": ["bash"],
                "terminal": ["bash"],
                "browser": ["builtin_browser"],
                "documents": [
                    "create_document",
                    "edit_document",
                    "update_document",
                    "suggest_document",
                ],
                "doc": ["create_document", "edit_document", "update_document", "suggest_document"],
                "skills": ["manage_skills"],
                "images": ["generate_image"],
                "image": ["generate_image"],
            }

            if action == "list_tools":
                current = get_setting("disabled_tools", []) or []
                return {
                    "response": (
                        f"Currently disabled: {', '.join(current) if current else '(none)'}.\n"
                        "Common toggles: shell (bash), browser, documents, "
                        "memory, skills, images, tasks, notes, calendar, email."
                    ),
                    "disabled": list(current),
                    "exit_code": 0,
                }

            tool_name = (args.get("tool") or args.get("name") or "").strip().lower()
            if not tool_name:
                return {
                    "error": "tool name required (e.g. 'shell', 'search', 'bash')",
                    "exit_code": 1,
                }
            targets = _ALIASES.get(tool_name, [tool_name])

            settings = load_settings()
            current = list(settings.get("disabled_tools") or [])
            before = set(current)
            if action == "disable_tool":
                for t in targets:
                    if t not in current:
                        current.append(t)
            else:  # enable_tool
                current = [t for t in current if t not in targets]
            after = set(current)
            settings["disabled_tools"] = current
            save_settings(settings)

            verb = "Disabled" if action == "disable_tool" else "Enabled"
            changed = sorted(after.symmetric_difference(before))
            return {
                "response": (
                    f"{verb} {tool_name} ({', '.join(targets)}). "
                    f"Now disabled: {', '.join(current) if current else '(none)'}."
                ),
                "changed": changed,
                "disabled": list(current),
                "exit_code": 0,
            }

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_settings error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API call tool
# ---------------------------------------------------------------------------


async def do_api_call(content: str) -> Dict:
    """Execute an API call to a registered integration."""
    from src.integrations import execute_api_call, load_integrations

    try:
        args = json.loads(content)
    except json.JSONDecodeError:
        # Try line-based format: integration\nmethod path\nbody
        lines = content.strip().split("\n")
        args = {"integration": lines[0].strip() if lines else ""}
        if len(lines) > 1:
            parts = lines[1].strip().split(" ", 1)
            args["method"] = parts[0] if parts else "GET"
            args["path"] = parts[1] if len(parts) > 1 else "/"
        if len(lines) > 2:
            try:
                args["body"] = json.loads("\n".join(lines[2:]))
            except json.JSONDecodeError:
                pass

    integration_name = args.get("integration", "")
    integrations = load_integrations()
    intg = next(
        (
            i
            for i in integrations
            if i["id"] == integration_name or i["name"].lower() == integration_name.lower()
        ),
        None,
    )
    if not intg:
        available = ", ".join(i["name"] for i in integrations if i.get("enabled", True))
        return {
            "error": f"No integration matching '{integration_name}'. Available: {available or 'none configured'}",
            "exit_code": 1,
        }

    return await execute_api_call(
        intg["id"],
        args.get("method", "GET"),
        args.get("path", "/"),
        params=args.get("params"),
        body=args.get("body"),
        extra_headers=args.get("headers"),
    )


# ── Vaultwarden / Bitwarden CLI tools ──


def _load_vault_config() -> Dict:
    """Load Vaultwarden config from data/vault.json."""
    from pathlib import Path

    p = Path("data/vault.json")
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


async def _run_bw(
    args: list, session: Optional[str] = None, input_text: Optional[str] = None
) -> tuple:
    """Run a bw CLI command with optional session + stdin. Returns (stdout, stderr, returncode)."""
    import asyncio

    env = {}
    import os as _os

    env.update(_os.environ)
    if session:
        env["BW_SESSION"] = session

    proc = await asyncio.create_subprocess_exec(
        "bw",
        *args,
        stdin=asyncio.subprocess.PIPE if input_text else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await proc.communicate(input=input_text.encode() if input_text else None)
    return (
        stdout.decode(errors="replace").strip(),
        stderr.decode(errors="replace").strip(),
        proc.returncode,
    )


async def do_vault_search(content: str, owner: Optional[str] = None) -> Dict:
    """Search the vault by keyword. Returns matching item names + URLs, NO passwords."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    query = args.get("query", "").strip()
    if not query:
        return {"error": "query is required", "exit_code": 1}

    cfg = _load_vault_config()
    session = cfg.get("session")
    if not session:
        return {
            "error": "Vault is locked. Run vault_unlock or provide session key in settings.",
            "exit_code": 1,
        }

    stdout, stderr, rc = await _run_bw(["list", "items", "--search", query], session=session)
    if rc != 0:
        return {"error": f"bw failed: {stderr[:300]}", "exit_code": 1}

    try:
        items = json.loads(stdout)
    except json.JSONDecodeError:
        return {"error": "Failed to parse bw output", "exit_code": 1}

    if not items:
        return {"output": f"No vault items match '{query}'.", "exit_code": 0}

    lines = [f"Found {len(items)} item(s) matching '{query}':"]
    for it in items[:20]:
        item_id = it.get("id", "?")
        name = it.get("name", "?")
        login = it.get("login") or {}
        username = login.get("username", "")
        uris = login.get("uris") or []
        url = uris[0].get("uri", "") if uris else ""
        parts = [f"[{item_id[:8]}] {name}"]
        if username:
            parts.append(f"user: {username}")
        if url:
            parts.append(f"url: {url}")
        lines.append("- " + " · ".join(parts))
    lines.append("\nUse vault_get(item_id, reason) to retrieve the password.")
    return {"output": "\n".join(lines), "exit_code": 0}


async def do_vault_get(content: str, owner: Optional[str] = None) -> Dict:
    """Retrieve a full vault entry (including password) by item ID. Logs access to assistant chat."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    item_id = args.get("item_id", "").strip()
    reason = args.get("reason", "").strip()
    if not item_id:
        return {"error": "item_id is required", "exit_code": 1}
    if not reason:
        return {"error": "reason is required — explain WHY you need this password", "exit_code": 1}

    cfg = _load_vault_config()
    session = cfg.get("session")
    if not session:
        return {"error": "Vault is locked. Unlock first.", "exit_code": 1}

    stdout, stderr, rc = await _run_bw(["get", "item", item_id], session=session)
    if rc != 0:
        return {"error": f"bw failed: {stderr[:300]}", "exit_code": 1}

    try:
        item = json.loads(stdout)
    except json.JSONDecodeError:
        return {"error": "Failed to parse bw output", "exit_code": 1}

    login = item.get("login") or {}
    name = item.get("name", "?")

    # Audit log to assistant chat
    try:
        from src.assistant_log import log_to_assistant

        if owner:
            log_to_assistant(
                owner,
                f"Retrieved password for **{name}** — reason: {reason}",
                category="Vault",
            )
    except Exception:
        pass

    output = [
        f"Vault item: {name}",
        f"Username: {login.get('username', '(none)')}",
        f"Password: {login.get('password', '(none)')}",
    ]
    if login.get("totp"):
        output.append(f"TOTP secret: {login['totp']}")
    uris = login.get("uris") or []
    if uris:
        output.append("URLs: " + ", ".join(u.get("uri", "") for u in uris))
    if item.get("notes"):
        output.append(f"Notes: {item['notes']}")

    return {"output": "\n".join(output), "exit_code": 0}


async def do_vault_unlock(content: str, owner: Optional[str] = None) -> Dict:
    """Unlock the vault using a master password. Stores the resulting session key."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    master_password = args.get("master_password", "")
    if not master_password:
        return {"error": "master_password is required", "exit_code": 1}

    # Do not pass the master password as an argv element. Local process lists
    # can expose argv to other users; stdin keeps the secret out of `ps`.
    stdout, stderr, rc = await _run_bw(["unlock", "--raw"], input_text=master_password + "\n")
    if rc != 0:
        return {"error": f"Unlock failed: {stderr[:300]}", "exit_code": 1}

    session = stdout.strip()
    if not session:
        return {"error": "bw returned empty session", "exit_code": 1}

    # Save session to vault.json
    from pathlib import Path

    p = Path("data/vault.json")
    cfg = {}
    if p.exists():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    cfg["session"] = session
    from datetime import datetime as _dt

    cfg["unlocked_at"] = _dt.utcnow().isoformat()
    p.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        import os as _os

        _os.chmod(str(p), 0o600)
    except Exception:
        pass

    return {"output": "Vault unlocked. Session saved.", "exit_code": 0}
