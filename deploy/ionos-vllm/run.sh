#!/usr/bin/env bash
# Serve one model at a time; switching stops the previous one.
#
#   ./run.sh qwen3.8-27b             start (or switch to) a model from models/
#   ./run.sh download [name ...]     fetch weights only (default: all models)
#   ./run.sh test                    one chat request against the running model
#   ./run.sh logs | stop | list
set -euo pipefail
cd "$(dirname "$0")"

model_id() { sed -n 's/^model:[[:space:]]*//p' "models/$1.yaml"; }
tp_size() { sed -n 's/^tensor-parallel-size:[[:space:]]*//p' "models/$1.yaml"; }
names() { for f in models/*.yaml; do basename "$f" .yaml; done; }
env_value() { sed -n "s/^$1=//p" .env | tail -1; }

case "${1:-}" in
  ""|-h|--help|list)
    echo "Models:"; names | sed 's/^/  /'
    echo "Usage: $0 <model> | download [model ...] | test | logs | stop"
    ;;
  download)
    shift
    [ $# -eq 0 ] && set -- $(names)
    ids=(); for n in "$@"; do ids+=("$(model_id "$n")"); done
    docker compose run --rm download "${ids[@]}"
    ;;
  test)
    # vLLM's port is only open inside the tailscale namespace, so the request
    # runs from within the vLLM container.
    docker compose exec -T -e KEY="$(env_value VLLM_API_KEY)" vllm python3 - <<'EOF'
import json, os, time, urllib.request
def call(path, body=None):
    req = urllib.request.Request("http://127.0.0.1:8000/v1" + path,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": "Bearer " + os.environ["KEY"], "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=600))
model = call("/models")["data"][0]["id"]
t = time.time()
r = call("/chat/completions", {"model": model, "max_tokens": 512,
    "messages": [{"role": "user", "content": "Antworte in einem Satz: Was ist Tailscale?"}]})
msg, usage = r["choices"][0]["message"], r["usage"]
print("model:    ", model)
print("reasoning:", (msg.get("reasoning_content") or msg.get("reasoning") or "")[:200])
print("answer:   ", msg["content"])
print("tokens:    %d in / %d out in %.1fs" % (usage["prompt_tokens"], usage["completion_tokens"], time.time() - t))
EOF
    ;;
  logs) docker compose logs -f vllm ;;
  stop) docker compose stop vllm ;;
  *)
    name="$1"
    [ -f "models/$name.yaml" ] || { echo "No models/$name.yaml. Available:"; names; exit 1; }
    gpus=$(nvidia-smi -L | wc -l); need=$(tp_size "$name")
    if [ "${need:-1}" -gt "$gpus" ]; then
      echo "$name needs $need GPUs (tensor-parallel-size), this host has $gpus." >&2
      exit 1
    fi
    MODEL_CONFIG="$name" docker compose up -d
    echo "Starting $name — follow with: $0 logs   (ready when 'Application startup complete')"
    ;;
esac
