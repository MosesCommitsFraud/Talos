# ---- Stage 1: build the new React UI (web/ → web/dist) ----
FROM node:25-alpine AS webbuild
WORKDIR /web
# corepack picks the pnpm version pinned in package.json ("packageManager")
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

# ---- Stage 1b: build the documentation site (docs/ → docs_build) ----
FROM python:3.12-slim AS docsbuild
WORKDIR /docs
COPY requirements-docs.txt ./
RUN pip install --no-cache-dir -r requirements-docs.txt
COPY mkdocs.yml ./
COPY docs/ ./docs/
RUN mkdocs build

# ---- Stage 2: the Talos app ----
FROM python:3.12-slim

# System deps for the Talos web/API container. Agent code execution happens in
# the separate talos-sandbox container, not in this app container.
# nodejs/npm are NOT just build tooling: src/builtin_mcp.py resolves `npx` at
# runtime to launch stdio MCP servers, so they have to stay in the final image.
# gosu lets the entrypoint drop privileges cleanly so signals still reach
# uvicorn directly (no extra shell layer like `su`/`sudo` would add).
#
# The apt dance below exists because deb.debian.org is a Fastly CDN that resets
# the connection when apt pipelines hundreds of small .debs at once — Debian's
# `npm` package alone drags in ~650 node-* packages. Pipeline-Depth 0 serialises
# the requests. Acquire::Retries does NOT rescue this on its own: it doesn't
# cover the OpenSSL "connection reset by peer" error class, which is why a build
# with Retries=5 already set still died on a single .deb. Hence the retry loop.
# The Verify-Peer bypass is one-shot, for the two bootstrap commands only: the
# base image can't verify the https sources we just rewrote until
# ca-certificates exists.
RUN set -eu; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
        'Acquire::Retries "5";' \
        'Acquire::http::Pipeline-Depth "0";' \
        'Acquire::https::Pipeline-Depth "0";' \
        > /etc/apt/apt.conf.d/99-talos-apt-resilience; \
    apt-get update -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false; \
    apt-get install -y --no-install-recommends \
        -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
        ca-certificates; \
    ok=0; \
    for attempt in 1 2 3; do \
        if apt-get update && apt-get install -y --no-install-recommends \
            build-essential \
            curl \
            ffmpeg \
            git \
            nodejs \
            npm \
            gosu \
            libglib2.0-0 \
            libgl1 \
            libgomp1 \
            libsm6 \
            libxext6 \
            libxrender1 \
            libxcb1; \
        then ok=1; break; fi; \
        echo "apt install failed (attempt $attempt/3), retrying in 10s"; \
        sleep 10; \
    done; \
    [ "$ok" = 1 ]; \
    rm -rf /var/lib/apt/lists/*

# MSSQL connectivity uses the pymssql / FreeTDS stack (see _build_external_sql_url:
# `mssql+pymssql://`). The pinned pymssql wheel bundles FreeTDS statically, so no
# unixodbc / msodbcsql / FreeTDS system packages are needed here. This matches the
# sandbox image (freetds-dev + pymssql). pyodbc / Microsoft ODBC are NOT used.

WORKDIR /app

# Install Python deps first (layer cache). Optional extras (PyMuPDF AGPL, etc.)
# are opt-in so the default image stays MIT-core; see requirements-optional.txt.
ARG INSTALL_OPTIONAL=false
COPY requirements.txt requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_OPTIONAL" = "true" ]; then pip install --no-cache-dir -r requirements-optional.txt; fi

# Copy app code
COPY . .

# React UI bundle (served at /)
COPY --from=webbuild /web/dist ./web/dist

# Documentation site (served at /docs)
COPY --from=docsbuild /docs/docs_build ./docs_build

# Create data directory (mount a volume here for persistence)
RUN mkdir -p data logs services/cache/search

# Entrypoint that drops to PUID/PGID (default 1000:1000) and repairs
# ownership on the bind-mounted /app/data and /app/logs. Without this,
# the container runs as root and writes root-owned files into host
# bind mounts — any later non-root run (or a host user trying to
# update them) silently fails on EPERM, breaking skill extraction,
# prefs persistence, mail attachments, etc.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Build identity. Baked in last so a new commit doesn't invalidate any layer
# above it. TALOS_BUILD_HASH is the git sha CI built from; TALOS_IMAGE_TAG is
# the immutable GHCR tag that carries this build. Both stay at their dev
# defaults for local `docker compose -f docker-compose.dev.yml build`, which is
# how /api/version reports whether it's serving a released image or a local one.
ARG TALOS_BUILD_HASH=dev-build
ARG TALOS_IMAGE_TAG=dev
# The release tag CI built from ("v0.2.0"), or "dev" for anything else. This is
# the only place a version number exists — there is no literal in the source.
ARG TALOS_VERSION=dev
ENV TALOS_BUILD_HASH=${TALOS_BUILD_HASH} \
    TALOS_IMAGE_TAG=${TALOS_IMAGE_TAG} \
    TALOS_VERSION=${TALOS_VERSION}

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
