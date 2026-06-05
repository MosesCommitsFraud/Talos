import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel


HOME_ROOT = Path(os.getenv("TALOS_SANDBOX_HOME_ROOT", "/home/talos"))
STATE_PATH = Path(os.getenv("TALOS_SANDBOX_STATE", "/var/lib/talos-sandbox/state.json"))
OPENCODE_HOST = os.getenv("TALOS_OPENCODE_HOST", "0.0.0.0")
OPENCODE_PUBLIC_HOST = os.getenv("TALOS_OPENCODE_PUBLIC_HOST", "talos-sandbox")
PORT_BASE = int(os.getenv("TALOS_OPENCODE_PORT_BASE", "41000"))
IDLE_SECONDS = int(os.getenv("TALOS_OPENCODE_IDLE_SECONDS", "3600"))
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://192.168.10.91:8000/v1")
VLLM_API_KEY = os.getenv("VLLM_API_KEY", "not-needed")
VLLM_MODEL = os.getenv("VLLM_MODEL", "qwen3-llm")

app = FastAPI(title="Talos Sandbox", version="0.1.0")


class EnsureUserResponse(BaseModel):
    user_id: str
    linux_user: str
    home: str


class WorkspaceResponse(BaseModel):
    user_id: str
    chat_id: str
    linux_user: str
    workspace: str


class OpencodeResponse(BaseModel):
    user_id: str
    linux_user: str
    base_url: str
    pid: int
    port: int


def _state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {"processes": {}}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"processes": {}}


def _save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(STATE_PATH)


def linux_user(user_id: str) -> str:
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]
    return f"talos_{digest}"


def user_home(user_id: str) -> Path:
    return HOME_ROOT / linux_user(user_id)


def workspace_path(user_id: str, chat_id: str) -> Path:
    safe_chat = hashlib.sha256(chat_id.encode("utf-8")).hexdigest()[:24]
    return user_home(user_id) / "workspaces" / safe_chat


def _run(args: list[str]) -> None:
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode != 0:
        raise HTTPException(500, f"Command failed: {' '.join(args)}\n{result.stderr}")


def ensure_user(user_id: str) -> tuple[str, Path]:
    name = linux_user(user_id)
    home = user_home(user_id)
    HOME_ROOT.mkdir(parents=True, exist_ok=True)
    if subprocess.run(["id", "-u", name], capture_output=True).returncode != 0:
        _run(["useradd", "--create-home", "--home-dir", str(home), "--shell", "/bin/bash", name])
    home.mkdir(parents=True, exist_ok=True)
    config_path = home / "opencode.json"
    config_path.write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "model": f"vllm/{VLLM_MODEL}",
        "provider": {
            "vllm": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "vLLM Spark",
                "options": {"baseURL": VLLM_BASE_URL, "apiKey": VLLM_API_KEY},
                "models": {
                    VLLM_MODEL: {
                        "name": VLLM_MODEL,
                        "tool_call": True,
                    }
                },
            }
        },
        "permission": {
            "read": "allow",
            "edit": "allow",
            "bash": {"*": "allow"},
            "webfetch": "deny",
            "websearch": "deny",
            "external_directory": {"*": "deny"},
        },
    }, indent=2), encoding="utf-8")
    _run(["chown", "-R", f"{name}:{name}", str(home)])
    return name, home


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _port_for(user_id: str) -> int:
    digest = int(hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:8], 16)
    return PORT_BASE + (digest % 20000)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "active": len(_state().get("processes", {}))}


@app.post("/users/{user_id}/ensure", response_model=EnsureUserResponse)
def ensure_user_route(user_id: str) -> EnsureUserResponse:
    name, home = ensure_user(user_id)
    return EnsureUserResponse(user_id=user_id, linux_user=name, home=str(home))


@app.post("/users/{user_id}/workspaces/{chat_id}/ensure", response_model=WorkspaceResponse)
def ensure_workspace_route(user_id: str, chat_id: str) -> WorkspaceResponse:
    name, _home = ensure_user(user_id)
    workspace = workspace_path(user_id, chat_id)
    workspace.mkdir(parents=True, exist_ok=True)
    _run(["chown", "-R", f"{name}:{name}", str(workspace)])
    return WorkspaceResponse(user_id=user_id, chat_id=chat_id, linux_user=name, workspace=str(workspace))


@app.post("/users/{user_id}/workspaces/{chat_id}/upload", response_model=WorkspaceResponse)
async def upload_file_route(user_id: str, chat_id: str, file: UploadFile = File(...)) -> WorkspaceResponse:
    name, _home = ensure_user(user_id)
    workspace = workspace_path(user_id, chat_id)
    workspace.mkdir(parents=True, exist_ok=True)
    filename = Path(file.filename or "upload.bin").name.replace("/", "_").replace("\\", "_")
    target = workspace / filename
    with target.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    _run(["chown", f"{name}:{name}", str(target)])
    return WorkspaceResponse(user_id=user_id, chat_id=chat_id, linux_user=name, workspace=str(workspace))


@app.post("/users/{user_id}/opencode/start", response_model=OpencodeResponse)
def start_opencode_route(user_id: str) -> OpencodeResponse:
    name, home = ensure_user(user_id)
    state = _state()
    processes = state.setdefault("processes", {})
    existing = processes.get(user_id)
    if existing and _pid_alive(int(existing.get("pid", 0))):
        existing["last_used"] = time.time()
        _save_state(state)
        return OpencodeResponse(
            user_id=user_id,
            linux_user=name,
            base_url=f"http://{OPENCODE_PUBLIC_HOST}:{existing['port']}",
            pid=int(existing["pid"]),
            port=int(existing["port"]),
        )

    port = _port_for(user_id)
    env = os.environ.copy()
    env["HOME"] = str(home)
    cmd = [
        "gosu",
        name,
        "opencode",
        "serve",
        "--hostname",
        OPENCODE_HOST,
        "--port",
        str(port),
    ]
    proc = subprocess.Popen(cmd, cwd=str(home), env=env, start_new_session=True)
    processes[user_id] = {"pid": proc.pid, "port": port, "last_used": time.time()}
    _save_state(state)
    return OpencodeResponse(user_id=user_id, linux_user=name, base_url=f"http://{OPENCODE_PUBLIC_HOST}:{port}", pid=proc.pid, port=port)


@app.post("/users/{user_id}/opencode/touch")
def touch_opencode_route(user_id: str) -> dict[str, Any]:
    state = _state()
    if user_id in state.get("processes", {}):
        state["processes"][user_id]["last_used"] = time.time()
        _save_state(state)
    return {"ok": True}


@app.post("/users/{user_id}/opencode/stop")
def stop_opencode_route(user_id: str) -> dict[str, Any]:
    state = _state()
    proc = state.get("processes", {}).pop(user_id, None)
    if proc:
        pid = int(proc.get("pid", 0))
        if pid and _pid_alive(pid):
            os.killpg(pid, signal.SIGTERM)
    _save_state(state)
    return {"ok": True}


@app.post("/maintenance/reap")
def reap_idle_route() -> dict[str, Any]:
    now = time.time()
    state = _state()
    stopped: list[str] = []
    for user_id, proc in list(state.get("processes", {}).items()):
        pid = int(proc.get("pid", 0))
        last_used = float(proc.get("last_used", 0))
        if not _pid_alive(pid) or now - last_used > IDLE_SECONDS:
            if pid and _pid_alive(pid):
                os.killpg(pid, signal.SIGTERM)
            state["processes"].pop(user_id, None)
            stopped.append(user_id)
    _save_state(state)
    return {"stopped": stopped}
