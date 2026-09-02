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
| `rag:read` | `rag_query`, `rag_list_collections`, `rag_list_documents`, `rag_get_document` |
| `skills:read` | `skills_list`, `skills_search`, `skills_get`, `skills_read_reference`, plus one `skill_<slug>` tool per published skill |
| `web:read` | `web_search`, `web_fetch` |

Two token profiles cover the common cases: `mcp` grants the two knowledge
scopes, `mcp_web` adds `web:read` on top. Web access is a separate scope on
purpose — a token that may read the knowledge base should not automatically
get a route out to the public internet through your SearxNG.

A logged-in browser session reaching `/mcp` from the same origin gets the full
read catalogue — it can already read all of this in the UI.

## Tools

Every tool is **read-only**. There is no ingest, no delete, no skill authoring.
An outward-facing endpoint held open by a long-lived bearer token is the wrong
place to accept mutations, and skills in particular have a deliberate
publish/audit review step (`routes/skills_routes.py`) that a write tool would
route around.

The static catalogue is ten tools; the per-skill tools below are appended to it,
so the exact list depends on the token's owner.

### RAG (`rag:read`)

- **`rag_query`** — hybrid dense+sparse Qdrant retrieval followed by the
  cross-encoder rerank. Arguments: `query` (required), `collections` (a list of
  knowledge-base ids — several are searched together and their hits merged by
  rerank score; omit for the default base), `topK` (1–20, default from the saved
  `search_top_k`), `language`, `owner`, `scope`. By default the `sql` knowledge
  namespace is excluded, exactly as the chat pipeline does; passing an explicit
  `scope` overrides that.

    Each hit carries the matched chunk's **whole section** (the `expanded`
    field the retrieval pipeline already produces for small-to-big injection),
    not an 800-character snippet, so one call is normally enough to answer
    from — a client driving its own agent loop cannot be relied upon to make a
    second `rag_get_document` call. The passage budget is shared across the
    hits, so 20 results still fit inside `MAX_TEXT_CHARS`.

    `language` is accepted because agent frameworks send it; it does not change
    retrieval, which is multilingual on both the embedder and the reranker.
    `rag_search`, the pre-rename name, is still accepted but no longer listed.

- **`rag_list_collections`** — the knowledge bases this instance serves (id,
  name, description, language, document count), from `src/rag_registry.py`.
  Registry-driven, so it still answers when Qdrant is down.
- **`rag_list_documents`** — one row per indexed source file with its chunk
  count. `filter` matches filename or path, case-insensitively; `collection`
  picks the base.
- **`rag_get_document`** — the indexed text of one document in reading order.
  Pass the `collection` from the `rag_query` hit when the document lives outside
  the default base. Reads from Qdrant only, never from the filesystem, so an
  unindexed `source` simply doesn't resolve.

### Skills (`skills:read`)

- **`skills_list`** — the same published-skills index the agent gets in its
  system prompt.
- **`skills_search`** — relevance-ranked skills for a task description.
  `published_only` is forced on: a draft is unreviewed, and this result reaches
  a model that will follow it as a proven procedure.
- **`skills_get`** — the full `SKILL.md`.
- **`skills_read_reference`** — a supporting file under the skill's directory.
  Traversal outside it is refused by `SkillsManager`.
- **`skill_<slug>`** — one tool per published skill, taking no arguments and
  returning that skill's `SKILL.md`. Same content as `skills_get`, reachable
  without the model first having to search: a client whose agent framework
  filters tools *by name* (MACS does) can grant a role its skills through the
  tool list itself. A skill is a written procedure, not something Talos
  executes — the tool description says so, so a model doesn't sit waiting for
  side effects. Capped at `MAX_SKILL_TOOLS` (60) so a large library can't bury
  a client's palette; past the cap `skills_search` remains the way in. Names are
  lowercased and non-`[a-z0-9_-]` characters become underscores; a name that
  collides with an earlier one is skipped rather than shadowing it.

Both shapes obey the same two gates: the skills are owner-scoped on disk, so a
token only sees skills owned by the user who created it, and the administrator's
allowlist (**Settings → MCP**) narrows the tool list as well as the search. An
empty result says so explicitly rather than leaving the caller to guess, and a
`skill_*` name this caller was never offered comes back as an unknown tool —
never as "not allowed", which would confirm the skill exists.

### Web (`web:read`)

- **`web_search`** — the public internet through your self-hosted SearxNG.
  Arguments: `query` (required), `max_results` (1–20, default 6), `language`,
  `category`, `time_range`, `page`.
- **`web_fetch`** — one page's readable text, chrome stripped. HTML, text,
  JSON and XML only; `max_chars` is 500–20000, default 8000.

Both wrap `src/web_search.py`, so everything that guards the agent's own web
access guards this endpoint too:

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

## Settings (Settings → MCP Server)

Scopes decide what one *token* may reach; this page decides what the *instance*
hands out at all. It is deliberately separate from Settings → Web Access: a
long-lived bearer token on someone else's machine is not the same trust level
as a logged-in browser session, so the two get their own policy.

| Setting | Effect |
| --- | --- |
| `mcp_web_enabled` | Off removes `web_search` / `web_fetch` from the catalogue, whatever the token's scopes say. The in-app agent is unaffected. |
| `mcp_web_inherit` | On (default) = the Web Access policy applies verbatim. Off = the `mcp_web_*` values below apply and the web-UI policy is ignored for `/mcp`. |
| `mcp_web_searxng_url` | A different SearxNG for MCP callers. Empty = the same one the UI uses. |
| `mcp_web_domain_allowlist` / `_blocklist` | The MCP-only domain policy. Same semantics as the web-UI lists: blocklist always wins, a non-empty allowlist is allowlist-only. |
| `mcp_web_max_results` / `mcp_web_max_fetch_chars` | Defaults for callers that don't name a size. A caller's own request still wins, bounded by the hard caps in `src/web_search.py`. |
| `mcp_skills_enabled` | Off removes the whole `skills_*` family. |
| `mcp_skills_inherit` | On (default) = exactly the library enabled in Settings → Skills goes out. Off = only `mcp_skills_allowed` does. |
| `mcp_skills_allowed` | Skill names shared in selected mode. Gated names are refused with "not shared over MCP" so a client stops re-spelling them. |

There is **one** skill library. Selected mode narrows which of the existing
published skills leave the instance — it never introduces a second copy, and it
can't widen access to drafts or another user's skills, because `index_for` /
`published_only` still run first.

RAG has no section here: its pipeline is configured in Settings → RAG and the
MCP tools read that config directly.

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
| `src/mcp_settings.py` | the administrator's policy: which tools are offered, and whether web/skills inherit the web-UI settings |
| `routes/mcp_public_routes.py` | JSON-RPC / HTTP shell |
| `routes/api_token_routes.py` | mints the `rag:read` / `skills:read` / `web:read` scopes |
| `src/web_search.py` | SearxNG client, domain policy, SSRF guard — wrapped, not reimplemented |
| `tests/test_mcp_public.py` | scope gating, tool contracts, JSON-RPC framing |
| `tests/test_mcp_settings.py` | policy separation: MCP domain lists vs the web UI's, skill gating |

The split keeps the tools callable without a server, so a stdio wrapper could
reuse `src/mcp_public.py` verbatim if a local-only client ever needs one.
