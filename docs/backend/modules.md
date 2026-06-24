# Backend modules

A guided tour of the Python packages. For request/response shapes see the
[API reference](api.md); for the retrieval path see the [RAG pipeline](../architecture/rag-pipeline.md).

## `core/` — cross-cutting infrastructure

| Module | Responsibility |
|--------|----------------|
| `database.py` | DB engine/session setup and connection management |
| `models.py` | ORM models / shared data models |
| `auth.py` | Authentication, RBAC, password/token handling |
| `session_manager.py` | User session lifecycle |
| `middleware.py` | Request middleware (auth resolution, headers, rate limiting hooks) |
| `exceptions.py` | Shared exception types mapped to HTTP responses in `app.py` |
| `atomic_io.py` | Crash-safe file writes |
| `constants.py` | App-wide constants (incl. `APP_VERSION`) |

## `src/` — business logic

Grouped by concern:

**Agent & chat**

- `agent_loop.py` — the model ↔ tool loop driving agentic chat.
- `agent_tools.py`, `builtin_actions.py`, `builtin_mcp.py` — tools available to the agent.
- `chat_handler.py`, `chat_processor.py`, `chat_helpers.py` — request handling & streaming.
- `context_budget.py`, `context_compactor.py`, `context_optimizer.py` — context-window management.
- `ai_interaction.py`, `llm_core.py`, `model_context.py`, `model_discovery.py` — LLM plumbing.

**RAG & documents**

- `rag_vector.py`, `rag_manager.py`, `rag_singleton.py`, `rag_worker.py`, `rag_external.py` — retrieval engine & jobs.
- `embeddings.py`, `chroma_client.py` — embedding clients & Chroma access.
- `document_processor.py`, `document_actions.py`, `personal_docs.py` — file extraction & document ops.
- `docling_runtime.py`, `markitdown_runtime.py`, `pdf_runtime.py`, `pdf_forms.py` — parsing backends.

**Memory**

- `memory.py`, `memory_provider.py`, `memory_vector.py` — the memory subsystem (see also `services/memory/`).

**Platform & ops**

- `app_initializer.py`, `app_helpers.py`, `config.py`, `readiness.py` — startup & config.
- `bg_jobs.py`, `bg_monitor.py`, `cleanup_service.py`, `event_bus.py` — background work & events.
- `mcp_manager.py`, `mcp_oauth.py` — MCP server management.
- `api_key_manager.py`, `rate_limiter.py`, `prompt_security.py` — security & limits.

## `mcp_servers/` — in-process MCP servers

Each module exposes a capability to the agent as MCP tools:

- `rag_server.py` — search the document index.
- `memory_server.py` — read/write long-term memory.
- `image_gen_server.py` — generate images.
- `_common.py` — shared MCP server helpers.

## Conventions

- **Imports.** Modules use a try/except import ladder (`rag_vector` → `.rag_vector` →
  `src.rag_vector`) so they work both as a package and with the root on `sys.path`
  (see `pyproject.toml` `pythonpath`).
- **Linting.** Ruff runs `E9, F, I` only (real bugs + import sorting); style groups are
  intentionally off — see the rationale in `pyproject.toml`.
- **Docstrings.** Module- and class-level docstrings are the source of truth; keep them
  accurate since they back the API reference and these pages.
