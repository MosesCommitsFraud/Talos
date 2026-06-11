#!/usr/bin/env python3
"""Local UI-only preview server for Talos.

Runs without Docker, Spark, vLLM, or the FastAPI backend. It serves the static UI
and returns small mock responses for common API calls so layout/theme changes can
be tested on a laptop.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
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
        {"type": "metrics", "data": {
            "model": "mock-ui-preview",
            "response_time": 1.42,
            "input_tokens": 384,
            "output_tokens": 156,
            "tokens_per_second": 109.9,
            "context_percent": 4.8,
            "context_length": 8192,
            "usage_source": "preview",
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
        if path == "/api/sessions":
            self._send_json(_sessions())
            return
        if path == "/api/session/preview-session":
            self._send_json({"id": "preview-session", "name": "UI Preview", "history": [
                {"role": "user", "content": "Preview the Talos UI"},
                {"role": "assistant", "content": "This is mock content for local UI work."},
            ]})
            return
        if path in ("/api/models", "/api/model-endpoints"):
            self._send_json(_models())
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
        if path.startswith("/api/"):
            self._send_json({})
            return

        self._serve_file(STATIC / path.lstrip("/"))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()
        fields = parse_qs(body.decode("utf-8", errors="ignore")) if body else {}

        if path == "/api/session":
            self._send_json(_sessions()[0])
            return
        if path == "/api/chat_stream":
            message = fields.get("message", [""])[0]
            self._send(200, _preview_stream(message), "text/event-stream")
            return
        if path == "/api/chat":
            self._send_json({"response": "This is a local UI preview response."})
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


def main():
    parser = argparse.ArgumentParser(description="Run local Talos UI preview server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("TALOS_UI_PREVIEW_PORT", "5177")))
    args = parser.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), PreviewHandler)
    print(f"Talos UI preview: http://{args.host}:{args.port}")
    print("Serving static files from", STATIC)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
