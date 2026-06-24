# API reference

The backend is **FastAPI**, so a complete, interactive API reference is generated
automatically from the route definitions and Pydantic models — no separate maintenance.

When the app is running:

| Endpoint | What it is |
|----------|-----------|
| [`/api/docs`](/api/docs) | **Swagger UI** — try requests live in the browser |
| [`/api/redoc`](/api/redoc) | **ReDoc** — clean, readable reference layout |
| [`/openapi.json`](/openapi.json) | Raw OpenAPI schema (for codegen / Postman / clients) |

!!! note "Why `/api/docs` and not `/docs`?"
    `/docs` serves this documentation site, so FastAPI's built-in Swagger UI was moved to
    `/api/docs` (and ReDoc to `/api/redoc`). See `app.py` where the `FastAPI(...)` app is
    constructed with `docs_url` / `redoc_url`.

## Making the generated docs good

The auto-generated reference is only as good as the annotations on the routes. When
adding or editing an endpoint in `routes/`:

- Give each route a `summary=` and a docstring (the docstring becomes the description).
- Group related routes with `tags=[...]`.
- Type request/response bodies with Pydantic models (`src/request_models.py`) and add
  `Field(..., description=...)` to non-obvious fields.
- Declare `response_model=` so the schema documents what comes back.

```python
@router.post(
    "/api/rag/search",
    tags=["rag"],
    summary="Search indexed documents",
    response_model=RagSearchResponse,
)
async def rag_search(req: RagSearchRequest) -> RagSearchResponse:
    """Run a hybrid (dense + sparse) search over the caller's documents."""
    ...
```

## Route map

Routers live in `routes/`, one module per feature area. The main groups:

| Area | Module |
|------|--------|
| Chat / agent | `routes/chat_routes.py` |
| RAG / documents | `routes/rag_routes.py`, `routes/document_routes.py`, `routes/upload_routes.py` |
| Auth / sessions / tokens | `routes/auth_routes.py`, `routes/session_routes.py`, `routes/api_token_routes.py` |
| Memory | `routes/memory_routes.py`, `routes/personal_routes.py` |
| Models / embeddings | `routes/model_routes.py`, `routes/embedding_routes.py` |
| MCP | `routes/mcp_routes.py` |
| Admin / diagnostics | `routes/diagnostics_routes.py`, `routes/admin_wipe_routes.py`, `routes/backup_routes.py` |

For the full, always-current list, open [`/api/docs`](/api/docs).
