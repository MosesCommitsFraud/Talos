# Talos

**Talos is a self-hosted, multi-user AI workspace** with isolated per-user sandboxes,
a retrieval-augmented generation (RAG) pipeline over your own documents, a memory
subsystem, and pluggable MCP servers — all behind a FastAPI backend and a React/Vite
frontend.

These docs are served live by the app at **`/docs`** and cover how the system fits
together, with a focus on the backend and the RAG pipeline.

## Where to start

<div class="grid cards" markdown>

- :material-sitemap: **[Architecture overview](architecture/overview.md)**
  How the FastAPI app, frontend, MCP servers, and data stores connect.

- :material-database-search: **[RAG pipeline](architecture/rag-pipeline.md)**
  Ingestion → chunking → embeddings → Qdrant hybrid retrieval → reranking.

- :material-api: **[API reference](backend/api.md)**
  The live, interactive OpenAPI docs generated from the FastAPI routes.

- :material-react: **[Frontend](frontend/overview.md)**
  The React/Vite UI, state management, and component catalog.

</div>

## The stack at a glance

| Layer | Technology |
|-------|-----------|
| Backend API | FastAPI + Uvicorn (`app.py`, `routes/`, `src/`) |
| RAG | Haystack + Qdrant (hybrid dense + sparse), Docling parsing, reranking |
| Background jobs | Redis + RQ (`src/rag_worker.py`) |
| Vector stores | Qdrant (document RAG), Chroma (memory + agent tool index) |
| Frontend | React 19 + Vite + TypeScript + Tailwind (`web/`) |
| Extensibility | MCP servers (`mcp_servers/`) |
| Deployment | Docker / docker-compose |

## Running the docs locally

```bash
pip install -r requirements-docs.txt
mkdocs serve        # live preview at http://127.0.0.1:8000
mkdocs build        # static build → docs_build/ (served by the app at /docs)
```
