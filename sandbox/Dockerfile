FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gosu \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    sudo \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/talos-sandbox

COPY requirements.txt ./requirements.txt
RUN python3 -m venv /opt/talos-sandbox-venv \
    && /opt/talos-sandbox-venv/bin/pip install --no-cache-dir -r requirements.txt

# The npm package name is intentionally configurable because opencode packaging
# has changed across releases. Override OPENCODE_NPM_PACKAGE at build time if needed.
ARG OPENCODE_NPM_PACKAGE=opencode-ai
RUN npm install -g ${OPENCODE_NPM_PACKAGE}

COPY sandboxd.py ./sandboxd.py

RUN mkdir -p /home/talos /var/lib/talos-sandbox

EXPOSE 7800

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/talos-sandbox-venv/bin/uvicorn", "sandboxd:app", "--host", "0.0.0.0", "--port", "7800"]
