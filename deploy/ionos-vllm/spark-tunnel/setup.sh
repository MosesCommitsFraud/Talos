#!/usr/bin/env bash
# One-time setup on the Talos host: tunnel key pair, the IONOS server's host
# key, and .env with the network of the running Talos container.
#
#   ./setup.sh <ionos-ip> [ssh-user]
set -euo pipefail
cd "$(dirname "$0")"
host=${1:?usage: ./setup.sh <ionos-ip> [ssh-user]}
user=${2:-moritz}

mkdir -p ssh
[ -f ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "talos-llm-tunnel" -f ssh/id_ed25519
ssh-keyscan -t ed25519 "$host" 2>/dev/null > ssh/known_hosts
echo "Host key of $host (compare with the fingerprint you were given):"
ssh-keygen -lf ssh/known_hosts

# The app's own network, not the internal sandbox one.
net=$(docker inspect talos -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
  | tr ' ' '\n' | grep -v -e '^$' -e sandbox | head -1 || true)
printf 'IONOS_HOST=%s\nIONOS_USER=%s\nTALOS_NETWORK=%s\n' "$host" "$user" "${net:-app_default}" > .env
echo; cat .env

echo
echo "This line goes into ~$user/.ssh/authorized_keys on the IONOS server."
echo "It allows nothing but the tunnel to 127.0.0.1:8000-8002 — no shell, no other ports:"
echo
open='permitopen="127.0.0.1:8000",permitopen="127.0.0.1:8001",permitopen="127.0.0.1:8002"'
echo "restrict,port-forwarding,$open,command=\"/bin/false\" $(cat ssh/id_ed25519.pub)"
