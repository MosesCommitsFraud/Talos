# RAG service (outward-facing REST)

Talos's knowledge bases are also reachable as a plain REST service on their own
port — no MCP, no Talos session, no agent framework required:

```
http://<talos-host>:7010
```

Use it when the calling software already has its own agent framework (MAF,
LangChain, a hand-rolled loop) and wants the knowledge bases as ordinary HTTP
tools. `GET /openapi.json` describes the whole surface, so the endpoints can be
imported as tool definitions instead of written by hand; `/docs` is the
browsable version.

!!! note "Three ways in, one index"
    `POST /mcp` (see [MCP server](mcp-server.md)) exposes the same retrieval as
    MCP tools, `/api/rag/*` backs the admin UI, and this service is the machine
    API. All three read the same Qdrant collections — nothing is duplicated.

## Several knowledge bases

A knowledge base ("RAG DB") is a named index with its **own Qdrant collection**.
Isolation is physical rather than a metadata filter, so a filter bug cannot leak
documents across bases, the content count is exact, and rebuilding or deleting
one base leaves the others untouched.

| Field | Meaning |
| --- | --- |
| `id` | URL segment, immutable. Derived from the name when not given. |
| `name` | Display name. |
| `description` | What is in it — written for the caller (and for a model choosing which base to query). |
| `language` | Primary language of the content, e.g. `de`. Descriptive metadata; it does not change the pipeline. |
| `content_count` | Indexed documents (source files), read live from Qdrant. |
| `chunk_count` | Embedded passages behind those documents. |
| `url` | Where to query this base. |

The catalogue lives in `data/rag/registry.json` — a file, not the app DB,
because the ingest worker runs in its own container and shares only the `data/`
volume.

The `default` base is seeded automatically and pinned to the historical
`talos_rag` collection, so everything indexed before this existed stays where it
was and Talos chat is unaffected. It cannot be deleted.

## Permissions

There are none per base, deliberately. `GET /v1/rags` is the catalogue the
calling software reads to build **its** permission model — it decides which of
its users may reach which URL. Talos gains no user/ACL system for this.

What does exist is an optional gate on the service as a whole: set `RAG_API_KEY`
and every request must carry it as `X-API-Key` or `Authorization: Bearer`. Unset
— the default — means open, which is only safe while the port is bound to
loopback or a trusted network. `/health` is always reachable.

## Endpoints

### Catalogue

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/rags` | Every base with name, description, language, counts, URL. `?counts=false` skips the Qdrant round-trip. |
| `POST` | `/v1/rags` | Register a base: `{name, description, language, id?}`. |
| `GET` | `/v1/rags/{id}` | One base. |
| `PATCH` | `/v1/rags/{id}` | Edit name/description/language. |
| `DELETE` | `/v1/rags/{id}` | Unregister; `?drop_data=false` keeps the vectors. |

### Retrieval — the same three tool-calls

| Method | Path | Equivalent tool |
| --- | --- | --- |
| `POST` / `GET` | `/v1/rags/{id}/search` | `rag_search` |
| `GET` | `/v1/rags/{id}/documents` | `rag_list_documents` |
| `GET` | `/v1/rags/{id}/document?source=…` | `rag_get_document` |

Every retrieval response carries **both** views:

* `text` — the rendered block, byte-identical to what an MCP client receives.
  Hand it straight to a model and the behaviour matches Talos's own.
* `results` / `documents` — the same hits as structured rows, for callers that
  render their own.

One retrieval produces both; the reranker is a remote call, so the endpoint
never searches twice.

### Ingest

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/rags/{id}/documents` | Multipart upload; queues an ingest job. |
| `POST` | `/v1/rags/{id}/directory` | Index a directory that exists **on the Talos host**. Disabled unless `RAG_API_INGEST_DIRS` lists allowed roots. |
| `DELETE` | `/v1/rags/{id}/document?source=…` | Remove one document's chunks. |
| `GET` | `/v1/jobs/{job_id}` | Ingest progress. |

Indexing is asynchronous — the rag-ingest-worker container does the parse,
chunk, embed and upsert — so a base's `content_count` only rises once its job
completes.

A base's Qdrant collection is created on **first use**, sized by the embedding
model live at that moment — registering a base while the embedder is down is
still valid, the base just reports `available: false` until it is back.

## Example

```bash
# What is available?
curl -s http://talos:7010/v1/rags | jq '.rags[] | {id, name, content_count}'

# Create one and fill it
curl -s -X POST http://talos:7010/v1/rags \
  -H 'Content-Type: application/json' \
  -d '{"name":"Service Manuals","description":"Machine documentation","language":"de"}'

curl -s -X POST http://talos:7010/v1/rags/service-manuals/documents \
  -F 'files=@manual.pdf'

# Query it
curl -s -X POST http://talos:7010/v1/rags/service-manuals/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Getriebe wechseln","k":5}' | jq -r .text
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAG_API_ENABLED` | `true` | Set false to not start the service. |
| `RAG_API_PORT` | `7010` | Listen port (inside the container it is always 7010; the compose var maps the host side). |
| `RAG_API_BIND` | `0.0.0.0` | Listen address. In compose this variable is the **host** publish address and defaults to `127.0.0.1`. |
| `RAG_API_KEY` | *(empty)* | When set, required on every request. |
| `RAG_API_INGEST_DIRS` | *(empty)* | Roots the server-side directory-ingest endpoint may read. Empty disables that endpoint. |

The service runs inside the Talos process but listens on its own port. That is
deliberate: the dense embedder, the sparse embedder and the Qdrant clients are
cached per process, so a separate process would double the memory for nothing.
The HTTP contract is the only coupling, so moving it into its own container
later is a compose change, not a refactor.
