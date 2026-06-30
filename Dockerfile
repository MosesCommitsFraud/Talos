# ---- Stage 1: build the new React UI (web/ → web/dist) ----
FROM node:24-alpine AS webbuild
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
# nodejs/npm are kept for existing static build/tooling compatibility.
# gosu lets the entrypoint drop privileges cleanly so signals still reach
# uvicorn directly (no extra shell layer like `su`/`sudo` would add).
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false ca-certificates \
    && apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
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
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

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

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
