# Security

Talos is a private, self-hosted AI workspace for a trusted team. Do not expose it
directly to the public internet.

## Required Defaults

- Keep `AUTH_ENABLED=true` for every shared deployment.
- Keep `LOCALHOST_BYPASS=false` outside local development.
- Use `SECURE_COOKIES=true` behind HTTPS.
- Put Talos behind a trusted reverse proxy, VPN, Tailscale, or private access
  gateway before binding to LAN interfaces.
- Never mount the Docker socket into `talos-app` or `talos-sandbox`.
- Keep `.env`, `data/`, `logs/`, sandbox homes, DB files, uploads, and backups
  out of Git.

## Sandbox Boundary

Talos runs opencode in `talos-sandbox`, not in the FastAPI app container and not
on the Spark host. The sandbox creates one Linux user per Talos user and stores
workspaces under that user's home.

This protects the host and separates trusted team users by Unix permissions. It
does not provide hard hostile-tenant isolation. If untrusted users are added,
move to container-per-user.

## Secrets

- Use new read-only SQL credentials; the old SQL login referenced in planning
  docs is considered compromised.
- Scope model/API/tool secrets to the process that needs them.
- Rotate any token pasted into chats, screenshots, logs, or shared demos.

## Internal Ports

- `7000`: Talos web/API entrypoint.
- `7800`: internal sandbox management API. Do not expose publicly.
- `41000+`: internal opencode user processes. Do not expose publicly.
