"""rag_api.py

The outward-facing RAG service — plain REST/JSON on its **own port**.

Why it exists
-------------
Talos's knowledge bases used to be reachable from outside only as MCP tools on
``POST /mcp``. That is the wrong shape for a caller that already has its own
agent framework: it wants to enumerate the available knowledge bases, decide
for itself who may touch which one, and then call them like any other HTTP
service. So the same three retrieval operations the MCP tools expose
(``rag_search`` / ``rag_list_documents`` / ``rag_get_document``) are served here
as ordinary REST endpoints, plus the CRUD needed to manage the bases themselves.

The tool *bodies* are literally the ones in ``src/mcp_public.py`` — every
endpoint returns the identical rendered ``text`` an MCP client would receive,
alongside a structured ``results``/``documents`` payload. A caller can feed
``text`` straight to a model and get the behaviour Talos itself gets, or use the
structured fields and render its own.

Permissions
-----------
There are none here, by design. ``GET /v1/rags`` is the catalogue the calling
software reads to build *its* permission model; this service does not know about
users. What it does have is an optional gate on the service as a whole: set
``RAG_API_KEY`` and every request must carry it (``X-API-Key`` or
``Authorization: Bearer``). Unset — the default — means open, which is only safe
on a trusted network. The check is one function, so tightening later is a config
change, not a refactor.

Deployment
----------
Runs in the Talos process but on its own port (``RAG_API_PORT``, default 7010),
started from the app lifespan in ``app.py``. Sharing the process is deliberate:
the dense embedder, the sparse embedder and the Qdrant clients are all cached
per-process, so a second process would double the memory for no benefit. The
HTTP contract is the only coupling, so lifting this into its own container later
is a compose change.

``GET /openapi.json`` describes every endpoint, so an agent framework can import
the whole surface as tools without anything hand-written.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_PORT = 7010


# ---------------------------------------------------------------------------
# Optional service-wide key
# ---------------------------------------------------------------------------


def _expected_key() -> str:
    return os.getenv("RAG_API_KEY", "").strip()


async def require_key(request: Request) -> None:
    """Gate the service when ``RAG_API_KEY`` is set; otherwise a no-op.

    Deliberately all-or-nothing: which *base* a caller may read is the calling
    software's decision, not this service's.
    """
    expected = _expected_key()
    if not expected:
        return
    presented = (request.headers.get("x-api-key") or "").strip()
    if not presented:
        auth = (request.headers.get("authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            presented = auth[7:].strip()
    # Constant-time compare — the key is a bearer secret.
    import hmac

    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(401, "Invalid or missing API key")


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class RagCreate(BaseModel):
    name: str = Field(..., description="Display name, e.g. 'Service Manuals'.")
    description: str = Field(
        "",
        description=(
            "What this knowledge base contains. Shown to callers (and to models "
            "choosing which base to query), so write it for that audience."
        ),
    )
    language: str = Field(
        "", description="Primary language of the content, e.g. 'de' or 'en'. Free text."
    )
    id: Optional[str] = Field(
        None,
        description=(
            "URL id. Lowercase letters, digits, '-' or '_'. Derived from the "
            "name when omitted. Immutable afterwards."
        ),
    )


class RagUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    language: Optional[str] = None


class SearchRequest(BaseModel):
    query: str = Field(..., description="Natural-language question or search phrase.")
    k: Optional[int] = Field(None, description="Passages to return (1–20, default 5).")
    owner: Optional[str] = Field(
        None, description="Restrict to one user's personal documents. Usually omitted."
    )
    scope: Optional[str] = Field(
        None, description="Restrict to one knowledge namespace (e.g. 'sql')."
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _entry(rag_id: str) -> Dict[str, Any]:
    from src.rag_registry import RagNotFound, get_base

    try:
        return get_base(rag_id)
    except RagNotFound:
        raise HTTPException(404, f"Unknown knowledge base '{rag_id}'")


def _rag_or_503(rag_id: str):
    """The live VectorRAG for a base, or a 503 explaining what is down."""
    from src.rag_singleton import get_rag_manager, last_init_error

    _entry(rag_id)  # 404 before anything else
    rag = get_rag_manager(rag_id)
    if rag is None or not getattr(rag, "healthy", False):
        raise HTTPException(
            503,
            "RAG backend unavailable: " + (last_init_error() or "check Qdrant and the embedder"),
        )
    return rag


def _tool_text(fn, args: Dict[str, Any]) -> str:
    """Run one ``src/mcp_public.py`` tool body and return its rendered text."""
    from src.mcp_public import ToolError

    try:
        return fn(args)
    except ToolError as e:
        raise HTTPException(400, str(e))


def _base_url(request: Request, rag_id: str) -> str:
    return str(request.base_url).rstrip("/") + f"/v1/rags/{rag_id}"


def _ingest_roots() -> List[str]:
    """Directories the server-side ingest endpoint is allowed to read.

    Empty (the default) disables that endpoint entirely — see its docstring.
    """
    raw = os.getenv("RAG_API_INGEST_DIRS", "")
    parts = [p.strip() for p in raw.replace(os.pathsep, ",").split(",")]
    return [os.path.abspath(os.path.expanduser(p)) for p in parts if p]


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(path), root]) == root
    except ValueError:  # different drives on Windows
        return False


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    app = FastAPI(
        title="Talos RAG Service",
        version="1.0.0",
        description=(
            "Named knowledge bases with hybrid (dense + sparse) retrieval and "
            "cross-encoder reranking. List the bases, then search one."
        ),
    )
    # A machine API on a trusted network: any origin may call it. Access control,
    # where it exists, is the RAG_API_KEY header, which CORS does not affect.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    guard = [Depends(require_key)]

    @app.get("/health", tags=["service"])
    def health() -> Dict[str, Any]:
        """Liveness plus how many knowledge bases are registered. No key needed."""
        from src.rag_registry import list_bases

        try:
            bases = list_bases()
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "service": "talos-rag", "bases": len(bases)}

    # -- catalogue ---------------------------------------------------------

    @app.get("/v1/rags", tags=["knowledge bases"], dependencies=guard)
    def list_rags(request: Request, counts: bool = True) -> Dict[str, Any]:
        """Every knowledge base with its name, description, language and live
        content count.

        This is the endpoint the calling software reads to build its own
        permission model — one row per base, each with the URL to query it.
        Pass ``counts=false`` to skip the Qdrant round-trip per base when only
        the names are needed.
        """
        from src.rag_registry import describe, list_bases

        rows = []
        for entry in list_bases():
            row = describe(entry, with_counts=counts)
            row["url"] = _base_url(request, str(row["id"]))
            rows.append(row)
        return {"count": len(rows), "rags": rows}

    @app.post("/v1/rags", tags=["knowledge bases"], status_code=201, dependencies=guard)
    def create_rag(body: RagCreate, request: Request) -> Dict[str, Any]:
        """Register a new knowledge base.

        Its Qdrant collection is created on first use, sized by the embedding
        model live at that moment. A fresh base is empty — ``content_count`` 0
        — until something is uploaded to it.
        """
        from src.rag_registry import RagConflict, create_base, describe

        try:
            entry = create_base(
                name=body.name,
                description=body.description,
                language=body.language,
                rag_id=body.id,
            )
        except RagConflict as e:
            raise HTTPException(409, f"A knowledge base with id '{e.args[0]}' already exists")
        except ValueError as e:
            raise HTTPException(400, str(e))
        row = describe(entry)
        row["url"] = _base_url(request, str(row["id"]))
        return row

    @app.get("/v1/rags/{rag_id}", tags=["knowledge bases"], dependencies=guard)
    def get_rag(rag_id: str, request: Request) -> Dict[str, Any]:
        from src.rag_registry import describe

        row = describe(_entry(rag_id))
        row["url"] = _base_url(request, rag_id)
        return row

    @app.patch("/v1/rags/{rag_id}", tags=["knowledge bases"], dependencies=guard)
    def update_rag(rag_id: str, body: RagUpdate, request: Request) -> Dict[str, Any]:
        """Edit name/description/language. The id and its collection are fixed."""
        from src.rag_registry import describe, update_base

        _entry(rag_id)
        entry = update_base(
            rag_id,
            name=body.name,
            description=body.description,
            language=body.language,
        )
        row = describe(entry)
        row["url"] = _base_url(request, rag_id)
        return row

    @app.delete("/v1/rags/{rag_id}", tags=["knowledge bases"], dependencies=guard)
    def delete_rag(rag_id: str, drop_data: bool = True) -> Dict[str, Any]:
        """Unregister a base and, unless ``drop_data=false``, delete its vectors.

        The default base cannot be deleted — everything that does not name a
        base falls back to it, including Talos's own chat retrieval.
        """
        from src.rag_registry import delete_base

        _entry(rag_id)
        try:
            entry = delete_base(rag_id, drop_collection=drop_data)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"deleted": entry.get("id"), "dropped_data": bool(drop_data)}

    # -- retrieval (the tool-calls) ---------------------------------------

    @app.post("/v1/rags/{rag_id}/search", tags=["retrieval"], dependencies=guard)
    def search(rag_id: str, body: SearchRequest) -> Dict[str, Any]:
        """Hybrid search over one knowledge base — the ``rag_search`` tool.

        Dense + sparse retrieval in Qdrant, merged by RRF, then a cross-encoder
        rerank. ``text`` is the rendered answer block (identical to what the MCP
        tool returns, ready to hand to a model); ``results`` is the same hits as
        structured rows. One retrieval produces both.
        """
        from src.mcp_public import (
            DEFAULT_EXCLUDE_SCOPES,
            SNIPPET_CHARS,
            _clamp_k,
            _search_config,
            render_search_results,
        )

        query = (body.query or "").strip()
        if not query:
            raise HTTPException(400, "`query` is required and must not be empty.")

        rag = _rag_or_503(rag_id)
        cfg = _search_config()
        k = _clamp_k(body.k if body.k is not None else cfg.get("search_top_k", 5))
        try:
            candidate_k = max(k, min(int(cfg.get("candidate_top_k", 40)), 100))
        except (TypeError, ValueError):
            candidate_k = max(k, 40)
        scope = (body.scope or "").strip() or None
        results = rag.search(
            query,
            k=k,
            owner=(body.owner or "").strip() or None,
            candidate_k=candidate_k,
            scope=scope,
            # An explicit scope means the caller wants that namespace; the
            # default exclusion keeps the SQL schema files out otherwise, as
            # Talos's own chat retrieval does.
            exclude_scopes=None if scope else DEFAULT_EXCLUDE_SCOPES,
        )
        rows = []
        for r in results:
            meta = r.get("metadata") or {}
            source = meta.get("source") or meta.get("filename") or "unknown"
            rows.append(
                {
                    "source": source,
                    "filename": meta.get("filename") or os.path.basename(str(source)),
                    "page": meta.get("page"),
                    "modality": meta.get("modality") or "text",
                    "similarity": r.get("similarity"),
                    "rerank_score": r.get("rerank_score"),
                    "text": (r.get("document") or "")[:SNIPPET_CHARS],
                }
            )
        return {
            "rag_id": rag_id,
            "query": query,
            "count": len(rows),
            "text": render_search_results(query, results),
            "results": rows,
        }

    @app.get("/v1/rags/{rag_id}/search", tags=["retrieval"], dependencies=guard)
    def search_get(
        rag_id: str,
        query: str,
        k: Optional[int] = None,
        owner: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Same as the POST form, for callers that prefer a URL they can paste."""
        return search(rag_id, SearchRequest(query=query, k=k, owner=owner, scope=scope))

    @app.get("/v1/rags/{rag_id}/documents", tags=["retrieval"], dependencies=guard)
    def list_documents(
        rag_id: str, filter: Optional[str] = None, limit: int = 100
    ) -> Dict[str, Any]:
        """Every indexed document in one base — the ``rag_list_documents`` tool."""
        from src.mcp_public import (
            DEFAULT_EXCLUDE_SCOPES,
            _clamp_limit,
            filter_documents,
            render_document_list,
        )

        rag = _rag_or_503(rag_id)
        capped = _clamp_limit(limit, default=100, hi=500)
        docs = filter_documents(
            rag.list_documents(exclude_scopes=DEFAULT_EXCLUDE_SCOPES) or [], filter or ""
        )
        return {
            "rag_id": rag_id,
            "total": len(docs),
            "text": render_document_list(docs, capped, filtered=bool((filter or "").strip())),
            "documents": docs[:capped],
        }

    @app.get("/v1/rags/{rag_id}/document", tags=["retrieval"], dependencies=guard)
    def get_document(rag_id: str, source: str, max_chunks: int = 50) -> Dict[str, Any]:
        """One document's indexed text — the ``rag_get_document`` tool.

        ``source`` must be a value returned by search or the document list; only
        indexed documents are readable, so this cannot reach the filesystem.
        """
        from src import mcp_public

        _rag_or_503(rag_id)
        args = {"rag_id": rag_id, "source": source, "max_chunks": max_chunks}
        text = _tool_text(mcp_public._tool_rag_get_document, args)
        return {"rag_id": rag_id, "source": source, "text": text}

    # -- ingest ------------------------------------------------------------

    @app.post("/v1/rags/{rag_id}/documents", tags=["ingest"], dependencies=guard)
    async def upload_documents(
        rag_id: str,
        files: List[UploadFile] = File(..., description="One or more files to index."),
        redact_pii: Optional[str] = Form(None),
    ) -> Dict[str, Any]:
        """Upload files into one knowledge base.

        Files are stored and an ingest job is queued; the rag-ingest-worker does
        the parse/chunk/embed/upsert. The response carries a ``job_id`` — poll
        ``/v1/jobs/{job_id}`` for progress. Indexing is asynchronous, so the
        base's content count only rises once the job completes.
        """
        entry = _entry(rag_id)
        from routes.personal_routes import (
            MAX_PERSONAL_UPLOAD_BYTES,
            _personal_upload_dir_for_owner,
            _unique_personal_upload_path,
        )

        upload_dir = _personal_upload_dir_for_owner("kb-" + str(entry.get("id")))
        redact_override: Optional[bool] = None
        if redact_pii is not None and redact_pii.strip() != "":
            redact_override = redact_pii.strip().lower() in ("true", "1", "on", "yes")

        stored: List[str] = []
        errors: List[str] = []
        to_index: List[Any] = []
        for upload in files:
            try:
                file_path, stored_name, safe_name = _unique_personal_upload_path(
                    upload_dir, upload.filename
                )
                size = 0
                too_big = False
                with open(file_path, "wb") as fh:
                    while True:
                        chunk = await upload.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_PERSONAL_UPLOAD_BYTES:
                            too_big = True
                            break
                        fh.write(chunk)
                if too_big:
                    try:
                        os.remove(file_path)
                    except OSError:
                        pass
                    limit_mb = MAX_PERSONAL_UPLOAD_BYTES // (1024 * 1024)
                    errors.append(f"{upload.filename}: exceeds {limit_mb} MB limit")
                    continue
                meta = {
                    "source": file_path,
                    "filename": safe_name,
                    "stored_filename": stored_name,
                    "directory": upload_dir,
                    "type": os.path.splitext(safe_name)[1].lower(),
                }
                if redact_override is not None:
                    meta["redact_pii"] = redact_override
                to_index.append((file_path, meta))
                stored.append(safe_name)
            except Exception as e:
                logger.error("RAG API upload failed for %s: %s", upload.filename, e)
                errors.append(f"{upload.filename}: {type(e).__name__}")

        job = None
        if to_index:
            from src import rag_worker

            try:
                job = rag_worker.start_index_files(to_index, owner=None, base_id=rag_id)
            except Exception as e:
                logger.error("Failed to enqueue ingest job: %s", e)
                raise HTTPException(
                    503,
                    "Files were saved but the ingest queue is unavailable — is "
                    "Redis (rag-redis) running and REDIS_URL correct?",
                )
        return {
            "rag_id": rag_id,
            "uploaded": stored,
            "errors": errors,
            "job_id": (job or {}).get("id"),
            "status": (job or {}).get("status", "queued" if to_index else "idle"),
        }

    @app.post("/v1/rags/{rag_id}/directory", tags=["ingest"], dependencies=guard)
    def index_directory(rag_id: str, directory: str = Form(...)) -> Dict[str, Any]:
        """Index a directory that is already on the Talos host into one base.

        The path is resolved on the *server*, so this is for content that lives
        beside Talos (a mounted share, an export directory) — not for pushing
        files from the caller, which is what the upload endpoint is for.

        Because it reads server-side paths, it is restricted to the roots listed
        in ``RAG_API_INGEST_DIRS`` (os-separator-separated) and refuses outright
        when that is unset. Otherwise an unauthenticated caller could index any
        directory on the host and then read it back through search.
        """
        _entry(rag_id)
        roots = _ingest_roots()
        if not roots:
            raise HTTPException(
                403,
                "Server-side directory ingest is disabled. Set RAG_API_INGEST_DIRS "
                "to the directories that may be indexed, or use the upload endpoint.",
            )
        path = os.path.abspath(os.path.expanduser((directory or "").strip()))
        if not path or not os.path.isdir(path):
            raise HTTPException(400, f"Not a directory on the Talos host: {directory!r}")
        if not any(_is_within(path, root) for root in roots):
            raise HTTPException(403, "That directory is not in RAG_API_INGEST_DIRS")
        from src import rag_worker

        try:
            job = rag_worker.start_index_directory(path, owner=None, base_id=rag_id)
        except Exception as e:
            logger.error("Failed to enqueue directory ingest: %s", e)
            raise HTTPException(503, "Ingest queue unavailable — is Redis running?")
        return {
            "rag_id": rag_id,
            "directory": path,
            "job_id": job.get("id"),
            "status": job.get("status"),
        }

    @app.delete("/v1/rags/{rag_id}/document", tags=["ingest"], dependencies=guard)
    def delete_document(rag_id: str, source: str) -> Dict[str, Any]:
        """Remove one document (all its chunks) from a knowledge base."""
        from src.rag_registry import invalidate_counts

        rag = _rag_or_503(rag_id)
        removed = rag.delete_by_source(source)
        if not removed:
            raise HTTPException(404, f"No indexed document with source {source!r}")
        invalidate_counts(rag_id)
        return {"rag_id": rag_id, "source": source, "removed": removed}

    @app.get("/v1/jobs/{job_id}", tags=["ingest"], dependencies=guard)
    def job_status(job_id: str) -> Dict[str, Any]:
        """Progress of one ingest job."""
        from src import rag_worker

        job = rag_worker.get_job(job_id)
        if not job:
            raise HTTPException(404, "Unknown job")
        return job

    return app


# ---------------------------------------------------------------------------
# Server lifecycle (driven from app.py's lifespan)
# ---------------------------------------------------------------------------


def service_port() -> int:
    try:
        return int(os.getenv("RAG_API_PORT", str(DEFAULT_PORT)))
    except ValueError:
        return DEFAULT_PORT


def enabled() -> bool:
    """Off only when explicitly disabled — the point of the service is to be
    reachable, and a silently-absent port is a confusing failure mode."""
    return (os.getenv("RAG_API_ENABLED", "true") or "").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


_server = None  # the running uvicorn.Server, so shutdown can ask it to stop


async def serve() -> None:
    """Run the RAG service on its own port until stopped.

    Started as a task from the Talos app's lifespan so it shares the process
    (and therefore the warm embedders and Qdrant clients) while listening
    separately. Binding failures are logged and swallowed: Talos itself must
    still come up if the extra port is taken.
    """
    global _server
    import uvicorn

    host = os.getenv("RAG_API_BIND", "0.0.0.0").strip() or "0.0.0.0"
    port = service_port()
    config = uvicorn.Config(
        create_app(),
        host=host,
        port=port,
        log_level=os.getenv("RAG_API_LOG_LEVEL", "info"),
        access_log=False,
    )
    server = uvicorn.Server(config)
    # uvicorn installs process-wide signal handlers by default, which would
    # fight the host app's own shutdown handling. This server is a guest here.
    server.install_signal_handlers = lambda: None
    _server = server
    logger.info("RAG service listening on http://%s:%s (docs at /docs)", host, port)
    try:
        await server.serve()
    except Exception as e:
        logger.error("RAG service stopped: %s", e)
    finally:
        _server = None


def stop() -> None:
    """Ask the RAG service to shut down (called from the app's shutdown hook).

    Without this the guest server keeps its socket open while the host app is
    tearing down, and the process lingers instead of exiting.
    """
    if _server is not None:
        _server.should_exit = True
