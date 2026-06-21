#!/usr/bin/env python3
"""Local UI-only preview server for Talos.

Runs without Docker, Spark, vLLM, or the FastAPI backend. It serves the static UI
and returns small mock responses for common API calls so layout/theme changes can
be tested on a laptop.
"""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import os
import shutil
import signal
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
# New React UI bundle — served at "/" when built (mirrors app.py's strangler
# routing: new UI at /, legacy at /legacy).
WEB_DIST = ROOT / "web" / "dist"


def _json_bytes(data) -> bytes:
    return json.dumps(data).encode("utf-8")


# --- Mock conversation state -------------------------------------------------
# Real edit/revert/delete affordances only render once a message has a backend
# row id (metadata._db_id). The live app gets that from /api/history; we mirror
# the shape here so the preview shows the full message-action toolbar.

from datetime import datetime, timezone, timedelta  # noqa: E402

_DB_SEQ = 0
# Per-session history: session_id -> list of {role, content, metadata}.
_HISTORY: dict[str, list[dict]] = {}


def _next_db_id() -> str:
    global _DB_SEQ
    _DB_SEQ += 1
    return f"preview-msg-{_DB_SEQ}"


def _iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


def _entry(role: str, content: str, ts_offset: int = 0) -> dict:
    return {"role": role, "content": content,
            "metadata": {"timestamp": _iso(ts_offset), "_db_id": _next_db_id()}}


def _history_for(session_id: str) -> list[dict]:
    """History for a session, seeding the canonical preview session on first use."""
    if session_id not in _HISTORY:
        if session_id == "preview-session":
            _HISTORY[session_id] = [
                _entry("user", "Preview the Talos UI", -2 * 86400),
                _entry("assistant", "This is mock content for local UI work.", -2 * 86400 + 12),
            ]
        else:
            _HISTORY[session_id] = []
    return _HISTORY[session_id]


def _record_turn(session_id: str, message: str) -> None:
    """Append a sent turn (user + the two assistant rounds the stream emits) so a
    post-stream history fetch hands every message a _db_id — matching runtime
    length so the app reconciles them and shows edit/revert/delete."""
    # setdefault (not _history_for) so a brand-new chat starts empty and stays
    # length-matched with the runtime — only an explicitly opened preview session
    # carries the seeded backlog.
    hist = _HISTORY.setdefault(session_id, [])
    hist.append(_entry("user", message or "(empty)"))
    hist.append(_entry("assistant", "The computed highest gross value is **22.61** for item **B**.", 1))
    hist.append(_entry("assistant", "Second-round reply: the calculation checks out, **B** stays on top.", 2))


def _sse(event: dict | str) -> str:
    if event == "[DONE]":
        return "data: [DONE]\n\n"
    return f"data: {json.dumps(event)}\n\n"


def _preview_stream(message: str) -> bytes:
    code = """import duckdb
import pandas as pd

df = pd.DataFrame({"item": ["A", "B", "C"], "value": [12, 19, 7]})
result = duckdb.sql("SELECT item, value, value * 1.19 AS gross FROM df ORDER BY gross DESC").df()
print(result)
"""
    events: list[dict | str] = [
        # Auto-compaction fired before this turn (history crossed the threshold);
        # the real backend emits this just before streaming. Renders the in-stream
        # "earlier messages summarized" marker above the assistant turn.
        {"type": "compacted", "context_length": 40960},
        {"delta": "I need to inspect the request, decide whether a quick calculation is enough, and then show the UI states for reasoning, code, tools, and metrics.\n", "thinking": True},
        {"delta": "The request is a local preview, so I will simulate a Python/DuckDB calculation and stream a small code artifact.\n", "thinking": True},
        {"type": "tool_start", "tool": "python", "command": "python preview_calculation.py"},
        {"type": "tool_progress", "tool": "python", "tail": "Creating dataframe...\nRunning DuckDB SQL..."},
        {"type": "tool_output", "tool": "python", "command": "python preview_calculation.py", "output": "  item  value  gross\n0    B     19  22.61\n1    A     12  14.28\n2    C      7   8.33", "exit_code": 0},
        {"type": "doc_stream_open", "title": "preview_calculation.py", "language": "python"},
        {"type": "doc_stream_delta", "content": code[:90]},
        {"type": "doc_stream_delta", "content": code[90:]},
        {"delta": "Here is a mocked local preview response. It includes a reasoning block, a running Python tool card, a streamed code/document preview, and token metrics.\n\n"},
        {"delta": f"Your message was: `{message or '(empty)'}`\n\n"},
        {"delta": "```python\n" + code + "```\n\n"},
        {"delta": "The computed highest gross value is **22.61** for item **B**."},
        # Second agent round: must render as a NEW bubble with its own
        # reasoning block (agent_step delimits rounds in the real stream).
        {"type": "agent_step", "round": 2},
        {"delta": "Round two: I should double-check the result before summarizing.\n", "thinking": True},
        {"delta": "Looks right — gross = value × 1.19 and B has the largest value.\n", "thinking": True},
        # show_image flow: the image must render exactly once (inline at the
        # tool row), not again in a grid at the end of the message.
        {"type": "tool_start", "tool": "show_image", "command": "chart.png"},
        {"type": "tool_output", "tool": "show_image", "command": "chart.png",
         "output": "[Displayed 1 image(s) to the user inline: chart.png]", "exit_code": 0,
         "created_images": [{"name": "chart.png", "data_url": (
             "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dw"
             "n4GBgYGJAQowMQAAOQYDB1G7K2IAAAAASUVORK5CYII=")}]},
        {"delta": "Second-round reply: the calculation checks out, **B** stays on top."},
        {"type": "metrics", "data": {
            "model": "mock-ui-preview",
            "response_time": 1.42,
            # Near-full window with a real tokenizer count, so the context meter
            # shows the "exact" badge and the post-compaction usage.
            "input_tokens": 31130,
            "output_tokens": 156,
            "tokens_per_second": 109.9,
            "context_percent": 76.0,
            "context_length": 40960,
            "usage_source": "real",
        }},
        {"type": "message_saved", "id": "preview-message"},
        "[DONE]",
    ]
    return "".join(_sse(event) for event in events).encode("utf-8")


def _sessions():
    now = int(time.time())
    return [
        {
            "id": "preview-session",
            "name": "UI Preview",
            "model": "qwen3-llm",
            "endpoint_url": "mock://preview",
            "created_at": now,
            "updated_at": now,
            "last_accessed": now,
            "message_count": 2,
            "archived": False,
            "rag": False,
            "mode": "chat",
        }
    ]


def _models():
    return [
        {
            "id": "mock-qwen3",
            "name": "Spark Mock",
            "base_url": "mock://preview",
            "models": ["qwen3-llm"],
            "model_type": "llm",
            "is_enabled": True,
        }
    ]


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "TalosUIPreview/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str = "application/json", headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data, status: int = 200):
        self._send(status, _json_bytes(data))

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _serve_file(self, path: Path, root: Path = STATIC):
        try:
            resolved = path.resolve()
            if not str(resolved).startswith(str(root.resolve())) or not resolved.is_file():
                self._send_json({"error": "not found"}, 404)
                return
            ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            self._send(200, resolved.read_bytes(), ctype)
        except OSError as exc:
            self._send_json({"error": str(exc)}, 500)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            if (WEB_DIST / "index.html").is_file():
                self._serve_file(WEB_DIST / "index.html", root=WEB_DIST)
            else:
                self._serve_file(STATIC / "index.html")
            return
        if path == "/legacy":
            self._serve_file(STATIC / "index.html")
            return
        if path.startswith("/assets/"):
            self._serve_file(WEB_DIST / path.lstrip("/"), root=WEB_DIST)
            return
        if path == "/login":
            self._serve_file(STATIC / "login.html")
            return
        if path.startswith("/static/"):
            self._serve_file(STATIC / path[len("/static/"):])
            return

        if path == "/api/auth/settings":
            self._send_json({"auth_enabled": False, "user": "preview", "is_admin": True})
            return
        if path == "/api/auth/status":
            # auth_enabled False ⇒ the React AuthGate renders the app directly.
            self._send_json({
                "configured": True, "authenticated": True, "username": "preview",
                "is_admin": True, "signup_enabled": False, "auth_enabled": False,
            })
            return
        if path == "/api/sessions":
            self._send_json(_sessions())
            return
        if path == "/api/sessions/archived":
            now = int(time.time())
            self._send_json([
                {"id": "arch-1", "name": "Old planning notes", "archived": True,
                 "created_at": now, "updated_at": now, "last_message_at": now,
                 "message_count": 14},
                {"id": "arch-2", "name": "Scratch experiment", "archived": True,
                 "created_at": now, "updated_at": now, "last_message_at": now,
                 "message_count": 3},
            ])
            return
        if path.startswith("/api/history/"):
            session_id = path[len("/api/history/"):]
            self._send_json({"id": session_id, "name": "UI Preview",
                             "history": _history_for(session_id)})
            return
        if path in ("/api/models", "/api/model-endpoints"):
            self._send_json(_models())
            return
        if path == "/api/tools":
            self._send_json({"tools": [
                {"id": t, "enabled": t != "generate_image"}
                for t in ("bash", "python", "read_file", "write_file", "web_search",
                          "search_chats", "create_document", "generate_image",
                          "manage_memory", "manage_skills", "query_sql",
                          "chat_with_model", "list_models", "manage_tasks")
            ]})
            return
        if path == "/api/capabilities":
            # Pretend both knowledge sources are configured so the composer
            # renders the full RAG + SQL mode dropdown in the preview.
            self._send_json({"rag": True, "sql": True})
            return
        if path == "/api/sql/config":
            self._send_json({"databases": [
                {"id": "p1", "name": "sales", "enabled": True, "db_type": "mssql",
                 "host": "db.example.local", "port": "1433", "database": "Sales",
                 "username": "ro_user", "password_set": True, "odbc_driver": ""},
                {"id": "p2", "name": "analytics", "enabled": True, "db_type": "postgresql",
                 "host": "pg.example.local", "port": "5432", "database": "analytics",
                 "username": "readonly", "password_set": False, "odbc_driver": ""},
            ]})
            return
        if path == "/api/rag/config":
            self._send_json({
                "enabled": True,
                "provider": "internal",
                "external_url": "",
                "external_api_key_set": False,
                "external_dataset_id": "",
                "external_top_k": 5,
                "embedding_url": "http://192.168.10.91:8001/v1/embeddings",
                "embedding_model": "qwen3-embed",
                "qdrant_url": "http://qdrant:6333",
                "qdrant_api_key_set": False,
                "rerank_url": "http://192.168.10.91:8002/v1/rerank",
                "rerank_model": "qwen3-reranker",
                "rerank_api_key_set": False,
                "sparse_model": "Qdrant/bm25",
                "chat_top_k": 5, "search_top_k": 5, "candidate_top_k": 40,
                "similarity_threshold": 0.0, "rerank_min_score": 0.1,
                "max_context_chars": 10000, "query_prefix": "", "context_prompt": "",
            })
            return
        if path == "/api/rag/jobs/diagnostics":
            self._send_json({"active_worker_count": 1, "active_workers": ["preview"],
                             "multi_worker_warning": False, "message": "Single active ingest worker"})
            return
        if path == "/api/rag/jobs":
            self._send_json({"jobs": []})
            return
        if path == "/api/rag/documents":
            self._send_json({"available": True, "documents": [
                {"source": "/srv/uploads/handbook.pdf", "filename": "handbook.pdf", "type": ".pdf", "directory": "", "chunks": 42},
                {"source": "/srv/uploads/prices.xlsx", "filename": "prices.xlsx", "type": ".xlsx", "directory": "", "chunks": 17},
            ]})
            return
        if path == "/api/prefs/theme":
            self._send_json({})
            return
        if path == "/api/prefs/custom-themes":
            self._send_json([])
            return
        if path.startswith("/api/tasks"):
            self._send_json([] if path in ("/api/tasks", "/api/tasks/runs/recent") else {})
            return
        if path.startswith("/api/research"):
            self._send_json([] if any(x in path for x in ("active", "library")) else {})
            return
        if path.startswith("/api/notes") or path.startswith("/api/memory") or path.startswith("/api/documents"):
            self._send_json([])
            return
        if path.startswith("/api/search/providers"):
            self._send_json([])
            return
        if path.startswith("/api/workspace/browse"):
            self._send_json({"path": "/preview", "entries": []})
            return
        if path.startswith("/api/artifacts/"):
            self._send_json({"artifacts": [{"path": "result.csv", "size": 2048}]})
            return
        if path == "/api/assistants":
            self._send_json([
                {
                    "id": "asst-1", "name": "Support Bot", "slug": "support-bot",
                    "endpoint_id": "preview-endpoint", "endpoint_name": "Local Preview",
                    "model": "qwen3-llm", "use_rag": True, "use_sql": False,
                    "reasoning": True, "require_auth": True, "is_enabled": True,
                },
            ])
            return
        if path.startswith("/api/"):
            self._send_json({})
            return

        self._serve_file(STATIC / path.lstrip("/"))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" in ctype and "boundary=" in ctype:
            # Minimal multipart parse — enough to extract simple text fields
            # (the React UI posts FormData, matching the real backend).
            boundary = ctype.split("boundary=")[1].split(";")[0].strip()
            fields: dict[str, list[str]] = {}
            for part in body.split(b"--" + boundary.encode()):
                if b'name="' not in part:
                    continue
                header_blob, _, value = part.partition(b"\r\n\r\n")
                name = header_blob.split(b'name="')[1].split(b'"')[0].decode()
                fields.setdefault(name, []).append(value.rstrip(b"\r\n-").decode("utf-8", errors="ignore"))
        else:
            fields = parse_qs(body.decode("utf-8", errors="ignore")) if body else {}

        if path == "/api/session":
            self._send_json(_sessions()[0])
            return
        if path == "/api/chat_stream":
            message = fields.get("message", [""])[0]
            session_id = fields.get("session", ["preview-session"])[0]
            _record_turn(session_id, message)
            self._send(200, _preview_stream(message), "text/event-stream")
            return
        if path.endswith("/delete-messages"):
            # /api/session/{id}/delete-messages — drop the rows so history stays
            # in sync with the runtime (edit/revert delete then re-send).
            session_id = path[len("/api/session/"):-len("/delete-messages")]
            try:
                ids = set(json.loads(body or b"{}").get("msg_ids", []))
            except (ValueError, AttributeError):
                ids = set()
            _HISTORY[session_id] = [m for m in _history_for(session_id)
                                    if m["metadata"].get("_db_id") not in ids]
            self._send_json({"ok": True})
            return
        if path.endswith("/edit-message"):
            # /api/session/{id}/edit-message — update the stored content in place.
            session_id = path[len("/api/session/"):-len("/edit-message")]
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                payload = {}
            for m in _history_for(session_id):
                if m["metadata"].get("_db_id") == payload.get("msg_id"):
                    m["content"] = payload.get("content", m["content"])
                    break
            self._send_json({"ok": True})
            return
        if path == "/api/chat":
            self._send_json({"response": "This is a local UI preview response."})
            return
        if path == "/api/sql/test":
            # Failure shape: HTTP 200 + ok:false — the settings Test button
            # must surface the error, not report "Connection OK".
            self._send(200, _json_bytes({"ok": False, "error": "Login failed for user 'talos_ro' (preview mock)"}))
            return
        if path.startswith("/api/upload"):
            self._send_json({"files": []})
            return
        if path.startswith("/api/"):
            self._send_json({"ok": True})
            return
        self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        self._read_body()
        self._send_json({"ok": True})

    def do_PATCH(self):
        self._read_body()
        self._send_json({"ok": True})

    def do_DELETE(self):
        self._send_json({"ok": True})


class PreviewServer(ThreadingHTTPServer):
    # Let a freshly-started server reclaim a port left in TIME_WAIT by a prior run.
    allow_reuse_address = True
    daemon_threads = True


def _free_port(port: int) -> None:
    """Kill any process still listening on `port` so a re-run can rebind. Keeps
    the "every run serves the fresh build" guarantee — otherwise a lingering old
    instance keeps answering and you see stale UI."""
    lsof = shutil.which("lsof")
    if not lsof:
        return
    out = subprocess.run([lsof, "-ti", f"tcp:{port}"], capture_output=True, text=True)
    pids = {int(p) for p in out.stdout.split() if p.strip().isdigit() and int(p) != os.getpid()}
    for pid in pids:
        print(f"Freeing port {port}: killing stale process {pid}")
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        time.sleep(1.0)


def _build_web() -> None:
    """Rebuild the React bundle into web/dist so the preview reflects the current
    source. Skipped when web/ is missing or no pnpm is on PATH."""
    web_dir = ROOT / "web"
    if not (web_dir / "package.json").is_file():
        print("Skipping web build:", web_dir, "has no package.json")
        return
    pnpm = shutil.which("pnpm")
    if not pnpm:
        print("Skipping web build: pnpm not found on PATH")
        return
    print("Building web bundle (pnpm --dir web run build)…")
    start = time.time()
    result = subprocess.run([pnpm, "--dir", str(web_dir), "run", "build"], cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit(f"web build failed (exit {result.returncode})")
    print(f"web build done in {time.time() - start:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="Run local Talos UI preview server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("TALOS_UI_PREVIEW_PORT", "5177")))
    parser.add_argument("--no-build", action="store_true", help="Serve the existing web/dist without rebuilding")
    args = parser.parse_args()

    if not args.no_build:
        _build_web()

    try:
        httpd = PreviewServer((args.host, args.port), PreviewHandler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print(f"Port {args.port} in use — freeing it and retrying…")
        _free_port(args.port)
        httpd = PreviewServer((args.host, args.port), PreviewHandler)
    print(f"Talos UI preview: http://{args.host}:{args.port}")
    print("Serving static files from", STATIC)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
