#!/bin/bash
set -e

if [ -n "${TALOS_SANDBOX_APT_PACKAGES:-}" ]; then
  echo "Installing sandbox apt packages: ${TALOS_SANDBOX_APT_PACKAGES}"
  apt-get update -qq
  apt-get install -y --no-install-recommends ${TALOS_SANDBOX_APT_PACKAGES}
  rm -rf /var/lib/apt/lists/*
fi

if [ -n "${TALOS_SANDBOX_PIP_PACKAGES:-}" ]; then
  echo "Installing sandbox pip packages: ${TALOS_SANDBOX_PIP_PACKAGES}"
  /opt/talos-sandbox-venv/bin/pip install --no-cache-dir ${TALOS_SANDBOX_PIP_PACKAGES}
fi

if [ -n "${TALOS_SANDBOX_NPM_PACKAGES:-}" ]; then
  echo "Installing sandbox npm packages: ${TALOS_SANDBOX_NPM_PACKAGES}"
  npm install -g ${TALOS_SANDBOX_NPM_PACKAGES}
fi

exec /opt/talos-sandbox-venv/bin/uvicorn sandboxd:app --host 0.0.0.0 --port 7800
