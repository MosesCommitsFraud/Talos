#!/usr/bin/env bash
# Runs the three models side by side (see docker-compose.yml); which model sits
# on which port is set by MODEL_CONFIG / MOE_CONFIG / SMALL_CONFIG in .env.
#
#   ./run.sh up                      start all (loads one after the other)
#   ./run.sh download [name ...]     fetch weights only (default: the three configured)
#   ./run.sh test                    one chat request per model
#   ./run.sh status | logs [service] | stop | list
set -euo pipefail
cd "$(dirname "$0")"

model_id() { sed -n 's/^model:[[:space:]]*//p' "models/$1.yaml"; }
names() { for f in models/*.yaml; do basename "$f" .yaml; done; }
env_value() { sed -n "s/^$1=//p" .env | tail -1; }
configured() {
  echo "${MODEL_CONFIG:-$(env_value MODEL_CONFIG)}" | sed 's/^$/qwen3.8-27b/'
  echo "${MOE_CONFIG:-$(env_value MOE_CONFIG)}" | sed 's/^$/qwen3.6-35b-a3b/'
  echo "${SMALL_CONFIG:-$(env_value SMALL_CONFIG)}" | sed 's/^$/qwen3.5-4b/'
}

case "${1:-}" in
  ""|-h|--help|list)
    echo "Models:"; names | sed 's/^/  /'
    echo "Configured (ports 8000/8001/8002):"; configured | sed 's/^/  /'
    echo "Usage: $0 up | download [model ...] | test | status | logs [service] | stop"
    ;;
  up)
    share=$(for n in $(configured); do sed -n 's/^gpu-memory-utilization:[[:space:]]*//p' "models/$n.yaml"; done \
      | awk '{ s += $1 } END { print s }')
    if awk -v s="$share" 'BEGIN { exit !(s > 0.92) }'; then
      echo "gpu-memory-utilization of the three models adds up to $share (max ~0.92)." >&2
      exit 1
    fi
    docker compose up -d
    echo "Loading one after the other (~3 min each) — $0 status"
    ;;
  download)
    shift
    [ $# -eq 0 ] && set -- $(configured)
    ids=(); for n in "$@"; do ids+=("$(model_id "$n")"); done
    docker compose run --rm download "${ids[@]}"
    ;;
  test)
    # The ports are only open inside the tailscale namespace, so the requests
    # run from within the vLLM container.
    docker compose exec -T -e KEY="$(env_value VLLM_API_KEY)" vllm python3 - <<'EOF'
import json, os, time, urllib.request
def call(port, path, body=None):
    req = urllib.request.Request("http://127.0.0.1:%d/v1%s" % (port, path),
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": "Bearer " + os.environ["KEY"], "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=600))
for port in (8000, 8001, 8002):
    try:
        model = call(port, "/models")["data"][0]["id"]
    except Exception as e:
        print("port %d: not ready (%s)\n" % (port, e)); continue
    t = time.time()
    r = call(port, "/chat/completions", {"model": model, "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Antworte in einem Satz: Was ist Tailscale?"}]})
    msg, usage = r["choices"][0]["message"], r["usage"]
    dt = time.time() - t
    print("port %d   %s" % (port, model))
    print("  reasoning:", (msg.get("reasoning_content") or msg.get("reasoning") or "-")[:120].replace("\n", " "))
    print("  answer:   ", (msg["content"] or "").strip())
    print("  tokens:    %d in / %d out in %.1fs (%.0f tok/s)\n" % (
        usage["prompt_tokens"], usage["completion_tokens"], dt, usage["completion_tokens"] / dt))
EOF
    ;;
  status)
    docker compose ps --format '{{.Service}}\t{{.Status}}'
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
    ;;
  logs) docker compose logs -f "${2:-vllm}" ;;
  stop) docker compose stop vllm vllm-moe vllm-small ;;
  *) echo "Unknown command: $1 — see $0 --help" >&2; exit 1 ;;
esac
