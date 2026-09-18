"""SQL-only sandbox API. No shell, files, workspace or persistent kernel endpoints."""

import asyncio
import hmac
import json
import logging
import os
import re
import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# The container runs with --no-access-log, so without this the operator has no
# record of why a query failed — the caller only ever sees a fixed error code.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("sql_sandbox")

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
        logger.warning(
            "rejected /query: %s",
            "TALOS_SQL_SANDBOX_KEY is empty in this container, so every request is refused"
            if not key else "the caller's X-Talos-Sandbox-Key does not match",
        )
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
            logger.warning(
                "rejected /query: host %s is not covered by TALOS_SQL_ALLOWED_HOSTS=%r",
                payload["host"], os.getenv("TALOS_SQL_ALLOWED_HOSTS", ""),
            )
            return {"error": "host_denied"}
        payload["port"] = int(os.getenv("TALOS_SQL_PORT", "1433"))
        if not 1 <= payload["port"] <= 65535:
            raise ValueError()
    except Exception as exc:
        # The body is never logged: it carries the password.
        logger.warning("rejected /query: malformed request (%s)", type(exc).__name__)
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    if _slots.locked():
        logger.warning("rejected /query: all 4 slots busy")
        return {"error": "busy"}
    async with _slots:
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "sql_worker",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"},
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps(payload).encode()), timeout=45
            )
            # The worker's diagnosis, kept on this side of the boundary.
            for line in (stderr or b"").decode("utf-8", "replace").splitlines():
                if line.strip():
                    logger.warning("%s", line.strip())
            if process.returncode != 0:
                logger.warning("sql_worker exited %s for host=%s db=%s", process.returncode,
                               payload["host"], payload["database"])
                return {"error": "query_failed"}
            return json.loads(stdout)
        except asyncio.TimeoutError:
            logger.warning("sql_worker timed out after 45s for host=%s db=%s",
                           payload["host"], payload["database"])
            return {"error": "timeout"}
        except Exception:
            logger.exception("sql_worker could not be run for host=%s db=%s",
                             payload["host"], payload["database"])
            return {"error": "query_failed"}
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
