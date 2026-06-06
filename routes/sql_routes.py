from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.middleware import require_admin
from src.settings import load_settings, save_settings


class SqlConfigIn(BaseModel):
    enabled: bool = True
    db_type: str = "mssql"
    host: str = ""
    port: str = ""
    database: str = ""
    username: str = ""
    password: str = ""
    odbc_driver: str = ""


def _public_config(cfg: dict) -> dict:
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "db_type": cfg.get("db_type", "mssql"),
        "host": cfg.get("host", ""),
        "port": cfg.get("port", ""),
        "database": cfg.get("database", ""),
        "username": cfg.get("username", ""),
        "password_set": bool(cfg.get("password")),
        "odbc_driver": cfg.get("odbc_driver", ""),
    }


def setup_sql_routes():
    router = APIRouter(prefix="/api/sql", tags=["sql"])

    @router.get("/config")
    def get_sql_config(request: Request):
        require_admin(request)
        settings = load_settings()
        return _public_config(settings.get("sql_database", {}))

    @router.put("/config")
    def set_sql_config(body: SqlConfigIn, request: Request):
        require_admin(request)
        settings = load_settings()
        current = settings.get("sql_database", {}) if isinstance(settings.get("sql_database"), dict) else {}
        cfg = {
            "enabled": bool(body.enabled),
            "db_type": (body.db_type or "mssql").strip().lower(),
            "host": body.host.strip(),
            "port": str(body.port or "").strip(),
            "database": body.database.strip(),
            "username": body.username.strip(),
            "password": body.password if body.password else current.get("password", ""),
            "odbc_driver": body.odbc_driver.strip(),
        }
        if cfg["enabled"] and cfg["db_type"] != "sqlite":
            missing = [k for k in ("host", "database", "username") if not cfg.get(k)]
            if missing:
                raise HTTPException(400, f"Missing SQL config fields: {', '.join(missing)}")
        settings["sql_database"] = cfg
        save_settings(settings)
        return _public_config(cfg)

    @router.delete("/config")
    def clear_sql_config(request: Request):
        require_admin(request)
        settings = load_settings()
        settings["sql_database"] = {"enabled": False}
        save_settings(settings)
        return _public_config(settings["sql_database"])

    @router.post("/test")
    async def test_sql_config(request: Request):
        require_admin(request)
        from src.tool_implementations import do_query_sql

        result = await do_query_sql('{"action":"query","query":"SELECT 1 AS ok","max_rows":1}')
        if result.get("exit_code") == 0:
            return {"ok": True, "output": result.get("output", "")}
        return {"ok": False, "error": result.get("error", "Connection failed")}

    return router
