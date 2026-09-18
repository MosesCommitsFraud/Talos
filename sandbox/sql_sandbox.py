"""SQL-only sandbox API. No shell, files, workspace or persistent kernel endpoints."""

import asyncio
import hmac
import json
import os
import re
import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Talos SQL Sandbox")
_slots = asyncio.Semaphore(4)


@app.get("/health")
async def health():
    return {"ok": True}


def host_allowed(host: str) -> bool:
    """Is `host` covered by TALOS_SQL_ALLOWED_HOSTS?

    Three spellings, comma-separated: an exact hostname, a `*.domain` suffix for
    a fleet whose members aren't known up front, and `*` for any host.

    Unset means no allow-list is configured, and every host passes. That is a
    deliberate loosening of the original "empty denies everything": the hosts
    arrive on the request because the caller — not this deployment — knows which
    database it is querying, and an operator who cannot enumerate them in
    advance would otherwise have to disable the guard by writing `*` anyway.
    The remaining guards still hold: the caller must supply that database's own
    credentials, the hostname must be bare, and the port is fixed by
    TALOS_SQL_PORT. Set the variable and the allow-list applies as before —
    which is what a deployment reachable from an untrusted network should do.
    """
    allowed = {h.strip().lower() for h in os.getenv("TALOS_SQL_ALLOWED_HOSTS", "").split(",") if h.strip()}
    if not allowed or "*" in allowed:
        return True
    host = host.lower()
    return any(
        host == entry or (entry.startswith("*.") and host.endswith(entry[1:]))
        for entry in allowed
    )


@app.post("/query")
async def query(request: Request):
    key = os.getenv("TALOS_SQL_SANDBOX_KEY", "")
    supplied = request.headers.get("x-talos-sandbox-key", "")
    if not key or not hmac.compare_digest(key.encode(), supplied.encode()):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 250_000:
            return JSONResponse({"error": "invalid_request"}, status_code=413)
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError()
        for field in ("host", "database", "user", "password", "query"):
            value = payload.get(field)
            if not isinstance(value, str) or not value or len(value) > (50_000 if field == "query" else 4096):
                raise ValueError()
        if type(payload.get("max_rows")) is not int or not 1 <= payload["max_rows"] <= 1000:
            raise ValueError()
        # No FreeTDS aliases, embedded ports or connection-string fragments.
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", payload["host"]):
            raise ValueError()
        if not host_allowed(payload["host"]):
            return {"error": "host_denied"}
        payload["port"] = int(os.getenv("TALOS_SQL_PORT", "1433"))
        if not 1 <= payload["port"] <= 65535:
            raise ValueError()
    except Exception:
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    if _slots.locked():
        return {"error": "busy"}
    async with _slots:
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "sql_worker",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"},
            )
            stdout, _ = await asyncio.wait_for(
                process.communicate(json.dumps(payload).encode()), timeout=45
            )
            return json.loads(stdout) if process.returncode == 0 else {"error": "query_failed"}
        except asyncio.TimeoutError:
            return {"error": "timeout"}
        except Exception:
            return {"error": "query_failed"}
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
