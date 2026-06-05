# Talos

Talos is a self-hosted multi-user AI workspace for a trusted team. It uses the
Odysseus FastAPI/UI codebase as the platform foundation, but narrows the product
to the Talos use case: authenticated chat, RBAC, file uploads, MCP tools, and an
isolated opencode runtime per user.

## Architecture

- `talos-app`: FastAPI web/API app with Auth, RBAC, sessions, uploads, documents,
  memory, MCP management, webhooks, and API tokens.
- `talos-sandbox`: internal sandbox container that follows the Open-Terminal
  model. It creates one Linux user per Talos user, persistent homes, per-chat
  workspaces, and one `opencode serve` process per active user.
- Spark services: Talos connects to existing vLLM, Qdrant, SQL Server,
  Prometheus, and Grafana endpoints instead of serving local models.

## Deliberately Removed From The Product

- Deep Research
- Web Search
- Email, Calendar, Contacts
- Notes and scheduled tasks
- Gallery and image generation
- Cookbook model downloads / local model serving
- GPU compose overlays for local serving

Some upstream files may remain temporarily while the migration is being reduced,
but the runtime FastAPI app no longer mounts those feature routes.

## Development

```bash
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:7000`.

## Sandbox Model

The sandbox is designed for trusted team users. Unix users separate files and
process ownership inside the sandbox container; this protects the Spark host and
keeps user workspaces separate, but it is not hard multi-tenant isolation. If
Talos is ever exposed to untrusted users, upgrade to container-per-user.

## Docs

- `docs/PLAN.md`: implementation plan
- `docs/INFRA.md`: Spark infrastructure reference

## License

Talos is based on Odysseus, which is MIT licensed. Keep upstream attribution in
`ACKNOWLEDGMENTS.md` and `LICENSE` while derived code remains in the project.
