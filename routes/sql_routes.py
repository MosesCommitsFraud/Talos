import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.middleware import require_admin
from src.settings import load_settings, save_settings


class SqlConnectionIn(BaseModel):
    id: str = ""
    name: str = ""
    enabled: bool = True
    db_type: str = "mssql"
    host: str = ""
    port: str = ""
    database: str = ""
    username: str = ""
    password: str = ""
    odbc_driver: str = ""


class SqlConfigIn(BaseModel):
    databases: list[SqlConnectionIn] = []


def _public_conn(cfg: dict) -> dict:
    return {
        "id": cfg.get("id", ""),
        "name": cfg.get("name", ""),
        "enabled": bool(cfg.get("enabled", False)),
        "db_type": cfg.get("db_type", "mssql"),
        "host": cfg.get("host", ""),
        "port": cfg.get("port", ""),
        "database": cfg.get("database", ""),
        "username": cfg.get("username", ""),
        "password_set": bool(cfg.get("password")),
        "odbc_driver": cfg.get("odbc_driver", ""),
    }


def _load_connections(settings: dict) -> list[dict]:
    """Stored connections as a list, migrating the legacy single dict shape."""
    dbs = settings.get("sql_databases")
    if isinstance(dbs, list):
        return [c for c in dbs if isinstance(c, dict)]
    legacy = settings.get("sql_database")
    if isinstance(legacy, dict) and (legacy.get("host") or legacy.get("database") or legacy.get("enabled")):
        migrated = {**legacy}
        migrated.setdefault("id", uuid.uuid4().hex[:12])
        migrated.setdefault("name", "default")
        return [migrated]
    return []


def setup_sql_routes():
    router = APIRouter(prefix="/api/sql", tags=["sql"])

    @router.get("/config")
    def get_sql_config(request: Request):
        require_admin(request)
        settings = load_settings()
        return {"databases": [_public_conn(c) for c in _load_connections(settings)]}

    @router.get("/status")
    def sql_status(request: Request):
        # Non-admin on purpose: the chat UI calls this to decide whether to
        # show the DB toggle. Exposes a single boolean, never the config —
        # covers list, legacy-single, and env-var setups.
        from src.tool_implementations import _build_external_sql_url

        url, _ = _build_external_sql_url()
        return {"configured": bool(url)}

    @router.put("/config")
    def set_sql_config(body: SqlConfigIn, request: Request):
        require_admin(request)
        settings = load_settings()
        existing = {c.get("id"): c for c in _load_connections(settings) if c.get("id")}

        out: list[dict] = []
        seen_names: set[str] = set()
        for item in body.databases:
            cid = (item.id or "").strip() or uuid.uuid4().hex[:12]
            prev = existing.get(cid, {})
            name = item.name.strip() or item.database.strip() or item.host.strip() or f"db{len(out) + 1}"
            key = name.lower()
            if key in seen_names:
                raise HTTPException(400, f"Duplicate database name: {name}")
            seen_names.add(key)
            cfg = {
                "id": cid,
                "name": name,
                "enabled": bool(item.enabled),
                "db_type": (item.db_type or "mssql").strip().lower(),
                "host": item.host.strip(),
                "port": str(item.port or "").strip(),
                "database": item.database.strip(),
                "username": item.username.strip(),
                # Blank password on edit keeps the stored one (same trick as before).
                "password": item.password if item.password else prev.get("password", ""),
                "odbc_driver": item.odbc_driver.strip(),
            }
            if cfg["enabled"] and cfg["db_type"] != "sqlite":
                missing = [k for k in ("host", "database", "username") if not cfg.get(k)]
                if missing:
                    raise HTTPException(400, f"Missing SQL config fields for '{name}': {', '.join(missing)}")
            out.append(cfg)

        settings["sql_databases"] = out
        # Drop the legacy single-dict key so it can't shadow the list.
        settings.pop("sql_database", None)
        save_settings(settings)
        return {"databases": [_public_conn(c) for c in out]}

    @router.delete("/config")
    def delete_sql_config(request: Request, id: str = ""):
        require_admin(request)
        settings = load_settings()
        conns = _load_connections(settings)
        if id:
            conns = [c for c in conns if c.get("id") != id]
        else:
            conns = []
        settings["sql_databases"] = conns
        settings.pop("sql_database", None)
        save_settings(settings)
        return {"databases": [_public_conn(c) for c in conns]}

    @router.post("/test")
    async def test_sql_config(request: Request, id: str = ""):
        require_admin(request)
        from src.tool_implementations import do_query_sql

        body = {"action": "query", "query": "SELECT 1 AS ok", "max_rows": 1}
        if id:
            settings = load_settings()
            conn = next((c for c in _load_connections(settings) if c.get("id") == id), None)
            if conn is None:
                raise HTTPException(404, "Unknown database id")
            body["database"] = conn.get("name", "")
        import json

        result = await do_query_sql(json.dumps(body))
        if result.get("exit_code") == 0:
            return {"ok": True, "output": result.get("output", "")}
        return {"ok": False, "error": result.get("error", "Connection failed")}

    return router
