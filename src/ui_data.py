"""
ui_data.py — live data sources for interactive answers (render_ui).

An interactive answer is built from data the agent fetched while answering. A
filter or a period switch in the UI often needs MORE data than was embedded —
"show 2023 instead", "only region Süd". Rebuilding the whole UI for that would
cost a full agent turn. So the model may declare data sources along with the
UI, and the UI may ask for them again with different parameters.

The frame never gets to say WHAT runs. It can only name a source the model
declared and pass values for that source's declared parameters:

  * the spec (SQL statement, URL template, search template) is validated when
    the UI is rendered and stored server-side, bound to the user who received
    the answer (core.database.UiDataSource);
  * parameters are typed and bounded by the spec (int with min/max, enum with
    a fixed list, …) and reach SQL as bind parameters, never as text;
  * the request comes from the HOST page (the user's own session), not from the
    sandboxed frame, which has no cookies and no network;
  * the same permission checks as the tools apply (query_sql / web_fetch /
    search_knowledge blocked or disabled for the user → refused), plus a rate
    limit per UI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import date
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

KINDS = ("sql", "web", "knowledge")
PARAM_TYPES = ("int", "number", "string", "enum", "bool", "date")
MAX_SOURCES = 8
MAX_PARAMS = 8
SOURCE_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
PARAM_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,30}$")
# `:name` bind parameters in SQL, not `::type` casts and not inside strings
# (good enough: the statement is also run through the read-only validator).
SQL_BIND_RE = re.compile(r"(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)")
TEMPLATE_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")

SQL_DEFAULT_ROWS, SQL_MAX_ROWS = 500, 5000
WEB_DEFAULT_CHARS, WEB_MAX_CHARS = 8000, 20000
KNOWLEDGE_DEFAULT_K, KNOWLEDGE_MAX_K = 5, 10
STRING_DEFAULT_LEN, STRING_MAX_LEN = 100, 200

# Which tool a source kind stands in for — its permissions apply.
TOOL_FOR_KIND = {"sql": "query_sql", "web": "web_fetch", "knowledge": "search_knowledge"}


class DataSourceError(ValueError):
    """A spec or request that is not acceptable. Message is user/model facing."""


# ── spec validation (render time) ─────────────────────────────────────────


def _param_spec(name: str, raw: Any) -> Dict[str, Any]:
    if not PARAM_NAME_RE.match(name):
        raise DataSourceError(f"Invalid parameter name {name!r}.")
    if not isinstance(raw, dict):
        raw = {"type": raw}
    kind = str(raw.get("type") or "string").lower()
    kind = {"integer": "int", "float": "number", "boolean": "bool", "str": "string"}.get(kind, kind)
    if kind not in PARAM_TYPES:
        raise DataSourceError(f"Parameter {name!r}: type must be one of {', '.join(PARAM_TYPES)}.")
    spec: Dict[str, Any] = {"type": kind}
    if kind in ("int", "number"):
        for bound in ("min", "max"):
            if raw.get(bound) is None:
                raise DataSourceError(f"Parameter {name!r}: numbers need `min` and `max`.")
            try:
                spec[bound] = int(raw[bound]) if kind == "int" else float(raw[bound])
            except (TypeError, ValueError):
                raise DataSourceError(f"Parameter {name!r}: `{bound}` must be a number.")
        if spec["min"] > spec["max"]:
            raise DataSourceError(f"Parameter {name!r}: `min` is above `max`.")
    elif kind == "enum":
        values = raw.get("values")
        if not isinstance(values, list) or not values or len(values) > 100:
            raise DataSourceError(f"Parameter {name!r}: enums need 1-100 `values`.")
        if not all(isinstance(v, (str, int, float)) and not isinstance(v, bool) for v in values):
            raise DataSourceError(f"Parameter {name!r}: enum values must be strings or numbers.")
        spec["values"] = values
    elif kind == "string":
        try:
            spec["maxLength"] = max(
                1, min(int(raw.get("maxLength") or STRING_DEFAULT_LEN), STRING_MAX_LEN)
            )
        except (TypeError, ValueError):
            spec["maxLength"] = STRING_DEFAULT_LEN
    elif kind == "date":
        for bound in ("min", "max"):
            if raw.get(bound) is not None:
                spec[bound] = _coerce_date(raw[bound], name)
    if "default" in raw:
        spec["default"] = coerce_param(name, spec, raw["default"])
    return spec


def _coerce_date(value: Any, name: str) -> str:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        raise DataSourceError(f"Parameter {name!r}: dates are YYYY-MM-DD.")


def coerce_param(name: str, spec: Dict[str, Any], value: Any) -> Any:
    """Check one value against its parameter spec and return it typed."""
    kind = spec["type"]
    if kind == "int":
        if isinstance(value, bool):
            raise DataSourceError(f"{name}: expected a whole number.")
        try:
            out = int(value)
            if isinstance(value, float) and value != out:
                raise ValueError
        except (TypeError, ValueError):
            raise DataSourceError(f"{name}: expected a whole number.")
    elif kind == "number":
        if isinstance(value, bool):
            raise DataSourceError(f"{name}: expected a number.")
        try:
            out = float(value)
        except (TypeError, ValueError):
            raise DataSourceError(f"{name}: expected a number.")
        if out != out or out in (float("inf"), float("-inf")):
            raise DataSourceError(f"{name}: expected a finite number.")
    elif kind == "bool":
        if not isinstance(value, bool):
            raise DataSourceError(f"{name}: expected true or false.")
        out = value
    elif kind == "enum":
        if value not in spec["values"]:
            raise DataSourceError(f"{name}: not one of the allowed values.")
        out = value
    elif kind == "date":
        out = _coerce_date(value, name)
    else:
        out = str(value if value is not None else "")
        if len(out) > spec.get("maxLength", STRING_DEFAULT_LEN):
            raise DataSourceError(f"{name}: too long.")
    if kind in ("int", "number", "date"):
        lo, hi = spec.get("min"), spec.get("max")
        if (lo is not None and out < lo) or (hi is not None and out > hi):
            raise DataSourceError(f"{name}: outside the allowed range.")
    return out


def _check_placeholders(used: List[str], params: Dict[str, Any], where: str) -> None:
    unknown = sorted(set(used) - set(params))
    if unknown:
        raise DataSourceError(
            f"{where} uses {', '.join(unknown)} without declaring them in `params`."
        )


def normalize_source(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise DataSourceError("Each data source is an object with `id`, `kind` and its spec.")
    sid = str(raw.get("id") or "").strip()
    if not SOURCE_ID_RE.match(sid):
        raise DataSourceError(
            f"Data source id {sid!r} must be lowercase letters, digits, - or _ (max 40)."
        )
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in KINDS:
        raise DataSourceError(f"Data source {sid!r}: kind must be one of {', '.join(KINDS)}.")
    params_raw = raw.get("params") or {}
    if not isinstance(params_raw, dict) or len(params_raw) > MAX_PARAMS:
        raise DataSourceError(f"Data source {sid!r}: `params` is an object (max {MAX_PARAMS}).")
    params = {name: _param_spec(name, p) for name, p in params_raw.items()}
    spec: Dict[str, Any] = {
        "id": sid,
        "kind": kind,
        "label": str(raw.get("label") or "").strip()[:200],
        "params": params,
    }

    if kind == "sql":
        from src.tool_implementations import _validate_readonly_sql

        query = str(raw.get("query") or "").strip()
        if not query:
            raise DataSourceError(f"Data source {sid!r}: `query` is required.")
        if len(query) > 8000:
            raise DataSourceError(f"Data source {sid!r}: query too long.")
        problem = _validate_readonly_sql(query)
        if problem:
            raise DataSourceError(f"Data source {sid!r}: {problem}")
        _check_placeholders(SQL_BIND_RE.findall(query), params, f"Data source {sid!r}")
        spec["query"] = query
        spec["database"] = str(raw.get("database") or "").strip()[:100]
        spec["maxRows"] = _bounded(raw.get("maxRows"), SQL_DEFAULT_ROWS, SQL_MAX_ROWS)
    elif kind == "web":
        url = str(raw.get("url") or "").strip()
        if not url.startswith("https://") or len(url) > 2000:
            raise DataSourceError(f"Data source {sid!r}: `url` must be an https URL template.")
        _check_placeholders(TEMPLATE_RE.findall(url), params, f"Data source {sid!r}")
        # The host part must not depend on a parameter — otherwise a value
        # could point the fetch anywhere.
        host_part = url.split("/", 3)[2] if url.count("/") >= 2 else url
        if "{" in host_part:
            raise DataSourceError(f"Data source {sid!r}: the host may not contain parameters.")
        spec["url"] = url
        spec["maxChars"] = _bounded(raw.get("maxChars"), WEB_DEFAULT_CHARS, WEB_MAX_CHARS)
    else:
        query = str(raw.get("query") or "").strip()
        if not query or len(query) > 500:
            raise DataSourceError(f"Data source {sid!r}: `query` (max 500 chars) is required.")
        _check_placeholders(TEMPLATE_RE.findall(query), params, f"Data source {sid!r}")
        spec["query"] = query
        spec["topK"] = _bounded(raw.get("topK"), KNOWLEDGE_DEFAULT_K, KNOWLEDGE_MAX_K)
    return spec


def _bounded(value: Any, default: int, cap: int) -> int:
    try:
        return max(1, min(int(value or default), cap))
    except (TypeError, ValueError):
        return default


def normalize_sources(value: Any) -> List[Dict[str, Any]]:
    if value in (None, "", []):
        return []
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or len(value) > MAX_SOURCES:
        raise DataSourceError(f"`dataSources` is a list of at most {MAX_SOURCES} sources.")
    specs = [normalize_source(v) for v in value]
    ids = [s["id"] for s in specs]
    if len(ids) != len(set(ids)):
        raise DataSourceError("Data source ids must be unique.")
    return specs


def public_spec(spec: Dict[str, Any]) -> Dict[str, Any]:
    """What the frame and the user may see: name, kind, parameters."""
    return {
        "id": spec["id"],
        "kind": spec["kind"],
        "label": spec["label"],
        "params": spec["params"],
    }


# ── storage ───────────────────────────────────────────────────────────────


def register(specs: List[Dict[str, Any]], owner: Optional[str], session_id: Optional[str]) -> str:
    """Store the specs of one UI; returns the UI id the frame refers to."""
    from core.database import SessionLocal, UiDataSource

    ui_id = uuid.uuid4().hex
    with SessionLocal() as db:
        for spec in specs:
            db.add(
                UiDataSource(
                    ui_id=ui_id,
                    source_id=spec["id"],
                    owner=owner or None,
                    session_id=session_id or None,
                    spec=json.dumps(spec, ensure_ascii=False),
                )
            )
        db.commit()
    return ui_id


def load(ui_id: str, source_id: str) -> Optional[Dict[str, Any]]:
    from core.database import SessionLocal, UiDataSource

    with SessionLocal() as db:
        row = (
            db.query(UiDataSource)
            .filter(UiDataSource.ui_id == ui_id, UiDataSource.source_id == source_id)
            .first()
        )
        if row is None:
            return None
        return {
            "owner": row.owner,
            "session_id": row.session_id,
            "spec": json.loads(row.spec),
        }


# ── execution (request time) ──────────────────────────────────────────────


def tool_allowed(kind: str, owner: Optional[str]) -> bool:
    """The same gates the agent's own tool would face for this user."""
    tool = TOOL_FOR_KIND[kind]
    try:
        from src.settings import get_setting
        from src.tool_security import is_tool_blocked_for_owner

        if is_tool_blocked_for_owner(tool, owner):
            return False
        disabled = get_setting("disabled_tools", []) or []
        if isinstance(disabled, list) and (
            tool in disabled or (kind == "web" and "web_search" in disabled)
        ):
            return False
    except Exception:
        logger.exception("ui_data permission check failed")
        return False
    return True


def resolve_params(spec: Dict[str, Any], raw: Any) -> Dict[str, Any]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise DataSourceError("`params` must be an object.")
    unknown = sorted(set(raw) - set(spec["params"]))
    if unknown:
        raise DataSourceError(f"Unknown parameter(s): {', '.join(unknown)}.")
    out: Dict[str, Any] = {}
    for name, pspec in spec["params"].items():
        if name in raw:
            out[name] = coerce_param(name, pspec, raw[name])
        elif "default" in pspec:
            out[name] = pspec["default"]
        else:
            raise DataSourceError(f"Missing parameter {name}.")
    return out


async def run(spec: Dict[str, Any], params: Dict[str, Any], session_id: str = "") -> Dict[str, Any]:
    kind = spec["kind"]
    if kind == "sql":
        return await asyncio.to_thread(_run_sql, spec, params)
    if kind == "web":
        return await _run_web(spec, params, session_id)
    return await _run_knowledge(spec, params, session_id)


def _run_sql(spec: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, Any]:
    from sqlalchemy import create_engine, text

    from src.tool_implementations import (
        _adapt_sql_dialect,
        _clean_sql_for_validation,
        _resolve_conn_url,
        _sql_connections,
        _sql_json_value,
        _validate_readonly_sql,
    )

    conns = _sql_connections()
    if not conns:
        raise DataSourceError("No SQL database is configured.")
    wanted = spec.get("database") or ""
    conn = (
        next((c for c in conns if c["name"].lower() == wanted.lower()), None)
        if wanted
        else (conns[0] if len(conns) == 1 else None)
    )
    if conn is None:
        raise DataSourceError("The database of this data source is not available.")
    url, err = _resolve_conn_url(conn)
    if err or not url:
        raise DataSourceError(err or "No SQL database URL could be built.")
    # Validated again at run time: the stored spec is ours, but cheap insurance.
    problem = _validate_readonly_sql(spec["query"])
    if problem:
        raise DataSourceError(problem)
    query = _clean_sql_for_validation(spec["query"]).rstrip(";").strip()
    engine = create_engine(url, pool_pre_ping=True)
    try:
        query, _note = _adapt_sql_dialect(query, getattr(engine.dialect, "name", ""))
        limit = spec.get("maxRows") or SQL_DEFAULT_ROWS
        with engine.connect() as connection:
            result = connection.execute(text(query), params)
            columns = list(result.keys())
            rows, count = [], 0
            for row in result:
                count += 1
                if len(rows) < limit:
                    rows.append([_sql_json_value(v) for v in row])
        return {"columns": columns, "rows": rows, "rowCount": count, "truncated": count > limit}
    finally:
        engine.dispose()


def _fill(template: str, params: Dict[str, Any], quote: bool) -> str:
    from urllib.parse import quote as urlquote

    def sub(m: re.Match) -> str:
        value = params.get(m.group(1), "")
        value = "true" if value is True else "false" if value is False else str(value)
        return urlquote(value, safe="") if quote else value

    return TEMPLATE_RE.sub(sub, template)


async def _run_web(spec: Dict[str, Any], params: Dict[str, Any], session_id: str) -> Dict[str, Any]:
    from src.web_search import fetch

    url = _fill(spec["url"], params, quote=True)
    result = await fetch(
        url, max_chars=spec.get("maxChars") or WEB_DEFAULT_CHARS, session_id=session_id
    )
    if result.get("error"):
        raise DataSourceError(str(result["error"])[:300])
    # fetch() returns the page as one block (header, readable text, notes).
    text_out = result.get("results") or result.get("output") or ""
    return {"url": url, "title": result.get("title") or "", "text": str(text_out)}


async def _run_knowledge(
    spec: Dict[str, Any], params: Dict[str, Any], session_id: str
) -> Dict[str, Any]:
    from src.chat_processor import ChatProcessor

    query = _fill(spec["query"], params, quote=False)
    sources, _block = await asyncio.to_thread(
        ChatProcessor(None).retrieve,
        query,
        citation_session=session_id or None,
        top_k=spec.get("topK") or KNOWLEDGE_DEFAULT_K,
    )
    passages = [
        {
            "document": s.get("filename") or "",
            "page": s.get("_page"),
            "text": str(s.get("_text") or s.get("snippet") or "")[:1500],
            "score": s.get("similarity"),
        }
        for s in sources or []
    ]
    return {"query": query, "passages": passages}
