#!/usr/bin/env python3
"""Interactive-answers eval — does the model pick the right form and build it?

Runs a JSONL set of prompts against a running Talos instance (the real chat
endpoint, the real model), reads the streamed events of each turn and scores
what the agent did. Run it per model before enabling interactive answers for
that model, and again after changing prompts, skills or the tools.

Eval file (one JSON object per line; ``#`` lines and blanks ignored):

    {"id": "kpi-1", "q": "Wie lief der Umsatz 2025? Zeig mir die Kennzahlen.",
     "expect": "widget", "widget_types": ["kpi", "chart"], "data": ["sql"],
     "flags": {"use_db": true}}

``expect``: ``text`` (no view), ``widget`` (render_widget), ``ui`` (render_ui),
``view`` (either tool), ``file`` (a file, e.g. a dashboard — no inline view).
``data``: source kinds the answer must cite (``sql``/``knowledge``/``web``/…).
``flags``: composer toggles for the turn (``use_db``, ``use_rag``, ``use_web``).
``setup``: optional messages sent first, in the same chat, NOT scored.

Prompts do not have to know the database or the documents. A ``setup`` turn
lets the agent find something suitable itself ("Which table has a time column
and a figure? Name one."), and the scored question refers back to it ("Show me
how it developed."). The same set then runs on any instance.

When an instance has no data of an expected kind (no database connected, no
matching document, no table with rows), a prompt that did not pass is scored
``n/a`` instead of FAIL and left out of the rates — the eval measures the
model, not the data it was given.

Scores per prompt:
  choice   — the form matches ``expect``
  built    — every expected view rendered (a failed call that was retried
             successfully still counts, but the retry is reported)
  sources  — the expected source kinds are cited and nothing is marked
             illustrative when real data was expected
  skills   — the built-in skills the agent loaded (informational)

What this cannot see: whether the generated JavaScript runs without errors in
the browser. Check the reported UIs by opening the eval chats in Talos — the
error badge on a card counts script errors.

Usage:
    python scripts/ui_eval.py --eval scripts/ui_eval.example.jsonl \\
        --base-url http://localhost:7000 --endpoint <endpoint-id> --model <model> \\
        --cookie "talos_session=…" --save results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

VIEW_TOOLS = ("render_ui", "render_widget")
FILE_HINTS = (".html", ".png", ".pdf", ".xlsx", "dashboard")


def load_eval(path: str) -> List[Dict[str, Any]]:
    entries = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            entries.append(json.loads(line))
    return entries


def parse_sse(lines: Iterable[str]) -> List[Dict[str, Any]]:
    """Events of one turn from raw SSE lines (``data: {...}``)."""
    events = []
    for line in lines:
        if not line.startswith("data: ") or line.startswith("data: [DONE]"):
            continue
        try:
            events.append(json.loads(line[6:]))
        except json.JSONDecodeError:
            continue
    return events


def _outputs(events: List[Dict[str, Any]], tool: str) -> List[Dict[str, Any]]:
    return [e for e in events if e.get("type") == "tool_output" and e.get("tool") == tool]


# Which tool results show that data of a kind actually exists on this instance.
_KNOWLEDGE_TOOLS = ("search_knowledge", "read_knowledge", "grep_knowledge", "list_knowledge")
_EMPTY_MARKERS = ("no indexed document", "no documents", "nothing found", "no matches", "keine")


def available_kinds(events: List[Dict[str, Any]]) -> set:
    """Data kinds this conversation actually reached: a query that returned
    rows, a knowledge lookup that returned text, a web call that succeeded."""
    kinds = set()
    for e in events:
        if e.get("type") != "tool_output" or (e.get("exit_code") or 0) != 0:
            continue
        tool = e.get("tool")
        if tool == "query_sql":
            rows = ((e.get("widget") or {}).get("data") or {}).get("rowCount")
            if isinstance(rows, int) and rows > 0:
                kinds.add("sql")
        elif tool in _KNOWLEDGE_TOOLS:
            text = str(e.get("output") or "").strip().lower()
            if len(text) > 80 and not any(text.startswith(m) for m in _EMPTY_MARKERS):
                kinds.add("knowledge")
        elif tool in ("web_search", "web_fetch", "get_news"):
            kinds.add("web")
    return kinds


def score(
    entry: Dict[str, Any],
    events: List[Dict[str, Any]],
    setup_events: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Score the final turn. Pure: the events in, a result dict out.
    `setup_events` are the unscored turns before it in the same chat; they
    count for data availability only."""
    expect = entry.get("expect", "view")
    calls = {t: _outputs(events, t) for t in VIEW_TOOLS}
    ok_calls = {t: [e for e in calls[t] if (e.get("exit_code") or 0) == 0] for t in VIEW_TOOLS}
    failed = sum(len(calls[t]) - len(ok_calls[t]) for t in VIEW_TOOLS)
    widgets = [e.get("widget") or {} for t in VIEW_TOOLS for e in ok_calls[t]]
    made_widget = bool(ok_calls["render_widget"])
    made_ui = bool(ok_calls["render_ui"])
    file_written = any(
        e.get("type") == "tool_output"
        and (e.get("presented_files") or e.get("artifacts_changed"))
        and any(
            h in json.dumps(e.get("presented_files") or e.get("command") or "").lower()
            for h in FILE_HINTS
        )
        for e in events
    )

    if made_ui and made_widget:
        chose = "view"
    elif made_ui:
        chose = "ui"
    elif made_widget:
        chose = "widget"
    elif file_written:
        chose = "file"
    else:
        chose = "text"
    choice_ok = {
        "text": chose == "text",
        "widget": made_widget,
        "ui": made_ui,
        "view": made_widget or made_ui,
        "file": chose == "file",
    }.get(expect, False)

    # Widget types actually shown: render_widget compiles to `ui` (declarative
    # marks the kind) or to the native `table`.
    shown_types = set()
    for w in widgets:
        data = w.get("data") or {}
        if w.get("type") == "table":
            shown_types.add("table")
        elif data.get("declarative"):
            shown_types.add(data["declarative"])
        else:
            shown_types.add("ui")
    wanted_types = set(entry.get("widget_types") or [])
    types_ok = not wanted_types or bool(wanted_types & shown_types)

    cited = set()
    for w in widgets:
        for s in (w.get("data") or {}).get("sources") or []:
            cited.add(s.get("kind"))
    wanted_data = set(entry.get("data") or [])
    sources_ok = (
        True
        if chose in ("text", "file")
        else wanted_data <= cited and not (wanted_data and "illustrative" in cited)
    )
    built_ok = expect in ("text", "file") or (choice_ok and types_ok)
    skills = sorted(
        {
            str(e.get("command") or "").split("\n")[0].replace("read_skill:", "").strip()
            for e in events
            if e.get("type") == "tool_start" and e.get("tool") == "read_skill"
        }
    )
    passed = choice_ok and built_ok and sources_ok
    # Data the prompt depends on that this instance never produced. Only the
    # kinds that come from the instance count — user input, model knowledge
    # and computed values are always there.
    instance_kinds = {"sql", "knowledge", "web"}
    missing = sorted(
        (wanted_data & instance_kinds) - available_kinds(list(setup_events or []) + list(events))
    )
    status = "pass" if passed else ("n/a" if missing else "fail")
    return {
        "id": entry.get("id") or entry.get("q", "")[:40],
        "status": status,
        "missing_data": missing,
        "expect": expect,
        "chose": chose,
        "choice_ok": choice_ok,
        "types": sorted(shown_types),
        "types_ok": types_ok,
        "built_ok": built_ok,
        "failed_calls": failed,
        "cited": sorted(k for k in cited if k),
        "sources_ok": sources_ok,
        "skills": skills,
        "streamed": any(e.get("type") == "ui_stream_open" for e in events),
        "pass": passed,
    }


def summarise(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Rates over the prompts that could be judged; n/a ones are counted apart."""
    na = [r for r in results if r.get("status") == "n/a"]
    results = [r for r in results if r.get("status") != "n/a"]
    n = len(results) or 1
    return {
        "prompts": len(results) + len(na),
        "not_applicable": len(na),
        "pass_rate": round(sum(r["pass"] for r in results) / n, 3),
        "choice_rate": round(sum(r["choice_ok"] for r in results) / n, 3),
        "sources_rate": round(sum(r["sources_ok"] for r in results) / n, 3),
        "failed_calls": sum(r["failed_calls"] for r in results),
        "with_retry": sum(1 for r in results if r["failed_calls"]),
    }


# ── running against a live instance ──


def _client(base_url: str, cookie: str):
    import httpx

    headers = {"Cookie": cookie} if cookie else {}
    return httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=None)


def _turn(client, sid: str, message: str, flags: Dict[str, Any]) -> List[Dict[str, Any]]:
    form = {
        "message": message,
        "session": sid,
        "use_rag": "true" if flags.get("use_rag") else "false",
        "use_db": "true" if flags.get("use_db") else "false",
    }
    if flags.get("use_web") is False:
        form["use_web"] = "false"
    lines: List[str] = []
    with client.stream("POST", "/api/chat_stream", data=form) as res:
        res.raise_for_status()
        for line in res.iter_lines():
            lines.append(line)
    return parse_sse(lines)


def run_one(client, entry: Dict[str, Any], endpoint: str, model: str):
    """(setup events, scored-turn events) of one prompt in a fresh chat."""
    session = client.post(
        "/api/session",
        data={
            "name": f"[eval] {entry.get('id') or entry['q'][:30]}",
            "endpoint_id": endpoint,
            "model": model,
        },
    )
    session.raise_for_status()
    sid = session.json().get("id") or session.json().get("session_id")
    flags = entry.get("flags") or {}
    setup_events: List[Dict[str, Any]] = []
    for message in entry.get("setup") or []:
        setup_events.extend(_turn(client, sid, message, flags))
    return setup_events, _turn(client, sid, entry["q"], flags)


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--eval", required=True)
    ap.add_argument("--base-url", default="http://localhost:7000")
    ap.add_argument("--endpoint", required=True, help="endpoint id of the model under test")
    ap.add_argument("--model", required=True)
    ap.add_argument("--cookie", default=os.environ.get("UI_EVAL_COOKIE", ""))
    ap.add_argument("--only", help="comma-separated ids to run")
    ap.add_argument("--save", help="write per-prompt results + summary as JSON")
    args = ap.parse_args(argv)

    entries = load_eval(args.eval)
    if args.only:
        wanted = set(args.only.split(","))
        entries = [e for e in entries if e.get("id") in wanted]
    results = []
    with _client(args.base_url, args.cookie) as client:
        for entry in entries:
            t0 = time.time()
            try:
                setup_events, events = run_one(client, entry, args.endpoint, args.model)
                result = score(entry, events, setup_events)
            except Exception as e:  # keep going; one broken prompt is a data point
                result = {
                    "id": entry.get("id"),
                    "status": "fail",
                    "pass": False,
                    "choice_ok": False,
                    "sources_ok": False,
                    "failed_calls": 0,
                    "error": str(e),
                }
            result["seconds"] = round(time.time() - t0, 1)
            results.append(result)
            mark = {"pass": "PASS", "n/a": "N/A ", "fail": "FAIL"}[result.get("status", "fail")]
            print(
                f"{mark}  {result['id']:<22} expect={entry.get('expect', 'view'):<6} "
                f"chose={result.get('chose', '?'):<6} types={','.join(result.get('types', []))} "
                f"cited={','.join(result.get('cited', []))} retries={result.get('failed_calls', 0)} "
                f"{result['seconds']}s"
                + (
                    f"  (no {', '.join(result['missing_data'])} data here)"
                    if result.get("missing_data") and result.get("status") == "n/a"
                    else ""
                ),
                flush=True,
            )
    summary = summarise(results)
    print(json.dumps(summary, indent=2))
    if args.save:
        Path(args.save).write_text(
            json.dumps(
                {"model": args.model, "summary": summary, "results": results},
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    return 0 if summary["pass_rate"] >= 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
