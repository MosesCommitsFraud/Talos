# Threat Model

## Scope

Talos is designed for trusted internal users operating against existing Spark
services: vLLM, Qdrant, SQL Server, Prometheus, and Grafana.

## Assets

- User accounts and sessions.
- Chat history and uploaded files.
- Per-user sandbox homes and workspaces.
- SQL read-only credentials.
- vLLM/Qdrant endpoints and model usage metadata.

## Trust Boundaries

- Browser to `talos-app`: authenticated HTTP(S) boundary.
- `talos-app` to `talos-sandbox`: internal Docker network only.
- Sandbox Linux users: filesystem/process separation inside one container.
- Spark host: must not be writable from agent code.

## Explicit Non-Goals

- Running arbitrary code from untrusted internet users.
- Public SaaS-style multi-tenancy.
- Preventing a Talos admin from using admin-only capabilities.

## Main Risks

- Prompt/tool misuse causing destructive code execution inside a user workspace.
- Sandbox breakout through kernel/container vulnerabilities.
- Accidental exposure of sandbox/opencode ports.
- Leaked SQL/API credentials.
- Cross-user data access through wrong file ownership or route owner checks.

## Mitigations

- opencode runs in `talos-sandbox`, not on the host.
- Each Talos user maps to a dedicated Linux user and home directory.
- Uploads are written into the owning user's chat workspace.
- Web Search and Deep Research are removed from the Talos runtime profile.
- SQL access must use a dedicated read-only account.
- Raw opencode and sandbox management ports stay internal-only.
- Upgrade path for untrusted users: container-per-user.
