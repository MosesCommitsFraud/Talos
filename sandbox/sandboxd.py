import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
import fnmatch
import re
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


class ExecRequest(BaseModel):
    kind: str = "bash"
    command: str = ""
    code: str = ""
    timeout: int = 120


class ExecResponse(BaseModel):
    user_id: str
    chat_id: str
    linux_user: str
    workspace: str
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class FileReadRequest(BaseModel):
    path: str
    offset: int = 0
    limit: int = 0


class FileWriteRequest(BaseModel):
    path: str
    content: str = ""


class FileEditRequest(BaseModel):
    path: str
    old_string: str
    new_string: str
    replace_all: bool = False


class SearchRequest(BaseModel):
    pattern: str = ""
    path: str = ""
    glob: str = ""
    ignore_case: bool = False
    max_results: int = 200


class ListRequest(BaseModel):
    path: str = ""


MAX_READ_CHARS = 20_000
MAX_OUTPUT_CHARS = 10_000
MAX_DIFF_LINES = 400
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".pytest_cache", ".mypy_cache"}


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


def _workspace(user_id: str, chat_id: str) -> tuple[str, Path]:
    name, _home = ensure_user(user_id)
    workspace = workspace_path(user_id, chat_id)
    workspace.mkdir(parents=True, exist_ok=True)
    _run(["chown", "-R", f"{name}:{name}", str(workspace)])
    return name, workspace


def _safe_path(workspace: Path, raw_path: str) -> Path:
    raw = (raw_path or ".").strip() or "."
    candidate = Path(raw)
    if candidate.is_absolute():
        candidate = workspace / str(candidate).lstrip("/")
    else:
        candidate = workspace / candidate
    resolved = candidate.resolve()
    root = workspace.resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(403, "Path escapes workspace")
    return resolved


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n... [truncated at {limit} chars]"


def _diff(old: str, new: str, path: str) -> dict[str, Any] | None:
    if old == new:
        return None
    import difflib
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(), fromfile=f"a/{path}", tofile=f"b/{path}", lineterm=""))
    added = sum(1 for line in lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in lines if line.startswith("-") and not line.startswith("---"))
    if len(lines) > MAX_DIFF_LINES:
        lines = lines[:MAX_DIFF_LINES] + [f"... diff truncated at {MAX_DIFF_LINES} lines"]
    return {"text": "\n".join(lines), "added": added, "removed": removed, "new_file": old == "", "file": Path(path).name or path}


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


@app.post("/users/{user_id}/workspaces/{chat_id}/exec", response_model=ExecResponse)
def exec_route(user_id: str, chat_id: str, req: ExecRequest) -> ExecResponse:
    name, workspace = _workspace(user_id, chat_id)

    timeout = max(1, min(int(req.timeout or 120), 900))
    env = os.environ.copy()
    env["HOME"] = str(user_home(user_id))
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = "120"
    env["LINES"] = "40"
    env["PATH"] = f"/opt/talos-sandbox-venv/bin:{env.get('PATH', '')}"

    if req.kind == "python":
        cmd = ["gosu", name, "/opt/talos-sandbox-venv/bin/python", "-c", req.code or req.command]
    else:
        cmd = ["gosu", name, "bash", "-lc", req.command]

    try:
        result = subprocess.run(
            cmd,
            cwd=str(workspace),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return ExecResponse(
            user_id=user_id,
            chat_id=chat_id,
            linux_user=name,
            workspace=str(workspace),
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode,
        )
    except subprocess.TimeoutExpired as exc:
        return ExecResponse(
            user_id=user_id,
            chat_id=chat_id,
            linux_user=name,
            workspace=str(workspace),
            stdout=exc.stdout or "",
            stderr=exc.stderr or "",
            exit_code=124,
            timed_out=True,
        )


@app.post("/users/{user_id}/workspaces/{chat_id}/files/read")
def read_file_route(user_id: str, chat_id: str, req: FileReadRequest) -> dict[str, Any]:
    _name, workspace = _workspace(user_id, chat_id)
    path = _safe_path(workspace, req.path)
    try:
        if req.offset > 0 or req.limit > 0:
            start = max(int(req.offset), 1)
            limit = max(int(req.limit), 0)
            out: list[str] = []
            budget = MAX_READ_CHARS
            count = 0
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh, 1):
                    if i < start:
                        continue
                    if limit and count >= limit:
                        break
                    out.append(line)
                    count += 1
                    budget -= len(line)
                    if budget <= 0:
                        out.append(f"\n... [truncated at {MAX_READ_CHARS} chars]")
                        break
            text = "".join(out)
        else:
            text = path.read_text(encoding="utf-8", errors="replace")
            text = _truncate(text, MAX_READ_CHARS)
        return {"output": text, "exit_code": 0, "path": str(path)}
    except FileNotFoundError:
        return {"error": f"read_file: {req.path}: not found", "exit_code": 1, "path": str(path)}
    except IsADirectoryError:
        return {"error": f"read_file: {req.path}: is a directory (use ls)", "exit_code": 1, "path": str(path)}
    except OSError as exc:
        return {"error": f"read_file: {req.path}: {exc}", "exit_code": 1, "path": str(path)}


@app.post("/users/{user_id}/workspaces/{chat_id}/files/write")
def write_file_route(user_id: str, chat_id: str, req: FileWriteRequest) -> dict[str, Any]:
    name, workspace = _workspace(user_id, chat_id)
    path = _safe_path(workspace, req.path)
    old = ""
    try:
        if path.exists() and path.is_file():
            old = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        old = ""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(req.content, encoding="utf-8")
        _run(["chown", f"{name}:{name}", str(path)])
    except OSError as exc:
        return {"error": f"write_file: {req.path}: {exc}", "exit_code": 1, "path": str(path)}
    result: dict[str, Any] = {"output": f"Wrote {len(req.content)} bytes to {path}", "exit_code": 0, "path": str(path)}
    diff = _diff(old, req.content, req.path)
    if diff:
        result["diff"] = diff
    return result


@app.post("/users/{user_id}/workspaces/{chat_id}/files/edit")
def edit_file_route(user_id: str, chat_id: str, req: FileEditRequest) -> dict[str, Any]:
    name, workspace = _workspace(user_id, chat_id)
    path = _safe_path(workspace, req.path)
    if not req.old_string:
        return {"error": "edit_file: old_string required", "exit_code": 1, "path": str(path)}
    if req.old_string == req.new_string:
        return {"error": "edit_file: old_string and new_string are identical", "exit_code": 1, "path": str(path)}
    try:
        old = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"error": f"edit_file: {req.path}: not found (use write_file to create it)", "exit_code": 1, "path": str(path)}
    except (IsADirectoryError, UnicodeDecodeError, OSError) as exc:
        return {"error": f"edit_file: {req.path}: {exc}", "exit_code": 1, "path": str(path)}
    count = old.count(req.old_string)
    if count == 0:
        return {"error": f"edit_file: old_string not found in {req.path}. Read the file and match it exactly.", "exit_code": 1, "path": str(path)}
    if count > 1 and not req.replace_all:
        return {"error": f"edit_file: old_string is not unique in {req.path} ({count} matches). Add surrounding context or set replace_all=true.", "exit_code": 1, "path": str(path)}
    new = old.replace(req.old_string, req.new_string) if req.replace_all else old.replace(req.old_string, req.new_string, 1)
    path.write_text(new, encoding="utf-8")
    _run(["chown", f"{name}:{name}", str(path)])
    result: dict[str, Any] = {"output": f"Edited {path} ({count if req.replace_all else 1} replacement{'s' if (count if req.replace_all else 1) != 1 else ''})", "exit_code": 0, "path": str(path)}
    diff = _diff(old, new, req.path)
    if diff:
        result["diff"] = diff
    return result


@app.post("/users/{user_id}/workspaces/{chat_id}/files/grep")
def grep_route(user_id: str, chat_id: str, req: SearchRequest) -> dict[str, Any]:
    _name, workspace = _workspace(user_id, chat_id)
    root = _safe_path(workspace, req.path or ".")
    if not req.pattern:
        return {"error": "grep: pattern is required", "exit_code": 1}
    flags = re.IGNORECASE if req.ignore_case else 0
    try:
        rx = re.compile(req.pattern, flags)
    except re.error as exc:
        return {"error": f"grep: bad pattern: {exc}", "exit_code": 1}
    max_results = max(1, min(int(req.max_results or 200), 500))
    files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file() and not (set(p.relative_to(root).parts) & SKIP_DIRS)]
    hits: list[str] = []
    for fp in files:
        if req.glob and not fnmatch.fnmatch(fp.name, req.glob) and not fnmatch.fnmatch(str(fp.relative_to(root)), req.glob):
            continue
        try:
            with fp.open("r", encoding="utf-8", errors="strict") as fh:
                for i, line in enumerate(fh, 1):
                    if rx.search(line):
                        hits.append(f"{fp}:{i}:{line.rstrip()[:500]}")
                        if len(hits) >= max_results:
                            break
        except (UnicodeDecodeError, OSError):
            continue
        if len(hits) >= max_results:
            break
    if not hits:
        return {"output": f"No matches for {req.pattern!r} under {root}", "exit_code": 0}
    out = "\n".join(hits)
    if len(hits) >= max_results:
        out += f"\n... [capped at {max_results} matches]"
    return {"output": _truncate(out), "exit_code": 0}


@app.post("/users/{user_id}/workspaces/{chat_id}/files/glob")
def glob_route(user_id: str, chat_id: str, req: SearchRequest) -> dict[str, Any]:
    _name, workspace = _workspace(user_id, chat_id)
    root = _safe_path(workspace, req.path or ".")
    if not req.pattern:
        return {"error": "glob: pattern is required", "exit_code": 1}
    if not root.is_dir():
        return {"error": f"glob: {root}: not a directory", "exit_code": 1}
    matched: list[tuple[float, str]] = []
    try:
        for p in root.rglob(req.pattern):
            if set(p.relative_to(root).parts) & SKIP_DIRS:
                continue
            try:
                matched.append((p.stat().st_mtime, str(p)))
            except OSError:
                matched.append((0, str(p)))
    except OSError as exc:
        return {"error": f"glob: {exc}", "exit_code": 1}
    matched.sort(key=lambda item: item[0], reverse=True)
    paths = [path for _mtime, path in matched[:200]]
    if not paths:
        return {"output": f"No files matching {req.pattern!r} under {root}", "exit_code": 0}
    out = "\n".join(paths)
    if len(matched) > len(paths):
        out += f"\n... [capped at {len(paths)} files]"
    return {"output": _truncate(out), "exit_code": 0}


@app.post("/users/{user_id}/workspaces/{chat_id}/files/ls")
def ls_route(user_id: str, chat_id: str, req: ListRequest) -> dict[str, Any]:
    _name, workspace = _workspace(user_id, chat_id)
    root = _safe_path(workspace, req.path or ".")
    if not root.is_dir():
        return {"error": f"ls: {root}: not a directory", "exit_code": 1}
    rows: list[tuple[bool, str, int]] = []
    try:
        for entry in root.iterdir():
            if entry.name.startswith("."):
                continue
            is_dir = entry.is_dir()
            size = 0 if is_dir else entry.stat().st_size
            rows.append((is_dir, entry.name, size))
    except OSError as exc:
        return {"error": f"ls: {exc}", "exit_code": 1}
    rows.sort(key=lambda row: (not row[0], row[1].lower()))
    lines = [f"{root}:"]
    for is_dir, name, size in rows[:200]:
        lines.append(f"  {name}/" if is_dir else f"  {name}  ({size} B)")
    if len(rows) > 200:
        lines.append(f"  ... [{len(rows) - 200} more]")
    if not rows:
        lines.append("  (empty)")
    return {"output": _truncate("\n".join(lines)), "exit_code": 0}


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
