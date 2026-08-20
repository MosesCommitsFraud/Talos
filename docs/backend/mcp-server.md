# MCP server (outward-facing)

Talos exposes its RAG knowledge base, its skill library and its web access to
external MCP clients — Claude Desktop, Claude Code, MACS, or any other agent
that speaks the Model Context Protocol — at a single endpoint:

```
POST https://<talos-host>/mcp
```

!!! note "Two directions, two modules"
    Don't confuse this with `src/builtin_mcp.py`, which wires *external* MCP
    servers **into** Talos (Talos as MCP client). This page is the opposite
    direction: Talos **as** an MCP server.

## Transport

MCP **Streamable HTTP**, stateless flavour:

| Aspect | Behaviour |
| --- | --- |
| Requests | `POST /mcp` with a JSON-RPC 2.0 body |
| Responses | `application/json` (no SSE stream) |
| Notifications | answered with `202 Accepted`, empty body |
| `GET /mcp` | `405` — no server→client stream on a stateless server |
| `DELETE /mcp` | `204` — no sessions to tear down |
| `Mcp-Session-Id` | never issued |
| Protocol versions | `2025-06-18`, `2025-03-26`, `2024-11-05` |

Statelessness is deliberate: the tools are read-only and independent, so the
endpoint survives a restart and needs no sticky sessions behind a proxy.

## Authentication

Reuses the existing `ody_` API tokens (**Admin → API Tokens**). The token goes
in an `Authorization: Bearer` header; `AuthMiddleware` in `app.py` validates it
before the request reaches the MCP route.

Three scopes gate the tool catalogue, and a token only ever *sees* the tools it
may call:

| Scope | Unlocks |
| --- | --- |
| `rag:read` | `rag_search`, `rag_list_documents`, `rag_get_document` |
| `skills:read` | `skills_list`, `skills_search`, `skills_get`, `skills_read_reference` |
| `web:read` | `web_search`, `web_fetch` |

Two token profiles cover the common cases: `mcp` grants the two knowledge
scopes, `mcp_web` adds `web:read` on top. Web access is a separate scope on
purpose — a token that may read the knowledge base should not automatically
get a route out to the public internet through your SearxNG.

A logged-in browser session reaching `/mcp` from the same origin gets the full
read catalogue — it can already read all of this in the UI.

## Tools

All nine tools are **read-only**. There is no ingest, no delete, no skill
authoring. An outward-facing endpoint held open by a long-lived bearer token is
the wrong place to accept mutations, and skills in particular have a deliberate
publish/audit review step (`routes/skills_routes.py`) that a write tool would
route around.

### RAG (`rag:read`)

- **`rag_search`** — hybrid dense+sparse Qdrant retrieval followed by the
  cross-encoder rerank. Arguments: `query` (required), `k` (1–20, default from
  the saved `search_top_k`), `owner`, `scope`. By default the `sql` knowledge
  namespace is excluded, exactly as the chat pipeline does; passing an explicit
  `scope` overrides that.
- **`rag_list_documents`** — one row per indexed source file with its chunk
  count. `filter` matches filename or path, case-insensitively.
- **`rag_get_document`** — the indexed text of one document in reading order.
  Reads from Qdrant only, never from the filesystem, so an unindexed `source`
  simply doesn't resolve.

### Skills (`skills:read`)

- **`skills_list`** — the same published-skills index the agent gets in its
  system prompt.
- **`skills_search`** — relevance-ranked skills for a task description.
  `published_only` is forced on: a draft is unreviewed, and this result reaches
  a model that will follow it as a proven procedure.
- **`skills_get`** — the full `SKILL.md`.
- **`skills_read_reference`** — a supporting file under the skill's directory.
  Traversal outside it is refused by `SkillsManager`.

Skills are owner-scoped on disk, so a token only sees skills owned by the user
who created it. An empty result says so explicitly rather than leaving the
caller to guess.

### Web (`web:read`)

- **`web_search`** — the public internet through your self-hosted SearxNG.
  Arguments: `query` (required), `max_results` (1–20, default 6), `language`,
  `category`, `time_range`, `page`.
- **`web_fetch`** — one page's readable text, chrome stripped. HTML, text,
  JSON and XML only; `max_chars` is 500–20000, default 8000.

Both wrap `src/web_search.py` unchanged, so everything that guards the agent's
own web access guards this endpoint too:

- the administrator's **domain allow/deny policy** — filtered results are
  reported as filtered, not silently dropped;
- the **SSRF guard** on `web_fetch`, re-checked on every redirect hop, so a
  public URL cannot bounce a caller onto Qdrant, vLLM or the LAN;
- the **outbound leak guard**, which rejects queries long enough to be pasted
  document content.

The leak guard's session-scoped half is inert here: it compares a query against
the documents retrieved in a Talos *chat session*, and an MCP caller has no
session, so there is no such context to leak.

!!! warning "This is outbound internet from your server"
    `web:read` lets a token holder drive requests out of your infrastructure.
    Grant it deliberately — that's why it isn't in the plain `mcp` profile.

## Client setup

Claude Code:

```bash
claude mcp add --transport http talos https://<talos-host>/mcp --header "Authorization: Bearer ody_..."
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "talos": {
      "type": "http",
      "url": "https://<talos-host>/mcp",
      "headers": { "Authorization": "Bearer ody_..." }
    }
  }
}
```

Smoke-test by hand:

```bash
curl -sS https://<talos-host>/mcp -H "Authorization: Bearer ody_..." -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Behaviour worth knowing

- **Tool failures are not JSON-RPC errors.** A tool that can't do its job
  returns a successful result carrying `isError: true` and a readable message,
  which is what lets the calling model correct itself. JSON-RPC errors are
  reserved for malformed protocol frames.
- **An unreachable backend is a tool error, not a 500.** For RAG the message
  carries the real reason from `rag_singleton.last_init_error()`; for the web
  tools it carries SearxNG's own diagnosis.
- **Outputs are capped** at ~24k characters per call, with an explicit
  truncation note.
- **Calls time out after 120s** so an unreachable Qdrant or rerank endpoint
  can't hold a client's request open.
- **Tracebacks never reach the client** — they're logged server-side and the
  client gets the exception type and message only.

## Where the code lives

| File | Role |
| --- | --- |
| `src/mcp_public.py` | tool catalogue, scope gating, dispatch — transport-free and unit-tested |
| `routes/mcp_public_routes.py` | JSON-RPC / HTTP shell |
| `routes/api_token_routes.py` | mints the `rag:read` / `skills:read` / `web:read` scopes |
| `src/web_search.py` | SearxNG client, domain policy, SSRF guard — wrapped, not reimplemented |
| `tests/test_mcp_public.py` | scope gating, tool contracts, JSON-RPC framing |

The split keeps the tools callable without a server, so a stdio wrapper could
reuse `src/mcp_public.py` verbatim if a local-only client ever needs one.
