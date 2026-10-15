"""turn_metrics_export.py — a chat's turn metrics as a spreadsheet-ready list.

Model comparisons (same question catalog, several endpoints) need the numbers
every turn already records — time to first token, response time, tokens,
tokens/s, tool rounds and calls — in a form a tester can paste into a results
sheet. The admin debug dump has all of it, but buried in megabytes of JSON.

One row per user turn: everything the agent did until the next user message is
summed into it (a turn can span several assistant messages, e.g. a background
follow-up). A final ``Gesamt`` row adds the turns up, so a multi-turn test
question is one line too. The column order from ``Chat-ID`` to ``Sub-Agenten``
matches the results sheet of the model-test workbook, so that block pastes
across in one go.

Pure functions over the persisted message rows; the route lives in
routes/session_routes.py.
"""

import csv
import io
import json
from typing import Any, Dict, Iterable, List, Optional

QUESTION_CHARS = 200

COLUMNS = [
    "Turn",
    "Frage",
    "Modell",
    "Zeitpunkt",
    "Chat-ID",
    "TTFT [s]",
    "Antwortzeit [s]",
    "Ausgabe-Tokens",
    "Input-Tokens (Summe)",
    "Kontext-Tokens",
    "Tokens/s",
    "tps_source",
    "Runden",
    "Tool-Calls",
    "Fehlerhafte Tool-Calls",
    "Sub-Agenten",
    "Tools",
    "usage_source",
]


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _subagent_count(event: Dict[str, Any]) -> int:
    """Number of helpers one `delegate` call started (its `tasks` list)."""
    try:
        args = json.loads(event.get("command") or "")
    except (TypeError, ValueError):
        return 1
    tasks = args.get("tasks") if isinstance(args, dict) else None
    return len(tasks) if isinstance(tasks, list) and tasks else 1


def _new_turn(index: int, question: str, timestamp: Any) -> Dict[str, Any]:
    return {
        "Turn": index,
        "Frage": " ".join(str(question or "").split())[:QUESTION_CHARS],
        "Zeitpunkt": str(timestamp or ""),
        "_ttft": None,
        "_time": 0.0,
        "_out": 0,
        "_in": 0,
        "_ctx": 0,
        "_tps": [],  # (tps, output tokens) per assistant message
        "_tps_sources": set(),
        "_usage_sources": set(),
        "_rounds": 0,
        "_calls": 0,
        "_errors": 0,
        "_subagents": 0,
        "_tools": [],
        "_model": "",
        "_answered": False,
    }


def _add_assistant(turn: Dict[str, Any], md: Dict[str, Any]) -> None:
    if not md.get("response_time") and not md.get("output_tokens") and not md.get("tool_events"):
        return
    turn["_answered"] = True
    ttft = _num(md.get("time_to_first_token"))
    if turn["_ttft"] is None and ttft > 0:
        turn["_ttft"] = ttft
    turn["_time"] += _num(md.get("response_time"))
    out = int(_num(md.get("output_tokens")))
    turn["_out"] += out
    turn["_in"] += int(_num(md.get("input_tokens")))
    turn["_ctx"] = max(turn["_ctx"], int(_num(md.get("context_tokens"))))
    tps = _num(md.get("tokens_per_second"))
    if tps > 0:
        turn["_tps"].append((tps, out))
    if md.get("tps_source"):
        turn["_tps_sources"].add(str(md["tps_source"]))
    if md.get("usage_source"):
        turn["_usage_sources"].add(str(md["usage_source"]))
    if md.get("model"):
        turn["_model"] = str(md["model"])
    events = [e for e in (md.get("tool_events") or []) if isinstance(e, dict)]
    rounds = [int(_num(e.get("round"))) for e in events if e.get("round") is not None]
    # Rounds count from 1; the closing answer is one more round after the last
    # one that called tools.
    turn["_rounds"] += (max(rounds) + 1) if rounds else 1
    turn["_calls"] += len(events)
    turn["_errors"] += sum(1 for e in events if e.get("exit_code") not in (None, 0))
    for e in events:
        name = str(e.get("tool") or "")
        if name:
            turn["_tools"].append(name)
        if name == "delegate":
            turn["_subagents"] += _subagent_count(e)


def _tps_of(pairs: List[tuple]) -> Optional[float]:
    if not pairs:
        return None
    weight = sum(out for _, out in pairs)
    if weight <= 0:
        return sum(t for t, _ in pairs) / len(pairs)
    return sum(t * out for t, out in pairs) / weight


def _finish(turn: Dict[str, Any], chat_id: str) -> Dict[str, Any]:
    tps = _tps_of(turn["_tps"])
    return {
        "Turn": turn["Turn"],
        "Frage": turn["Frage"],
        "Modell": turn["_model"],
        "Zeitpunkt": turn["Zeitpunkt"],
        "Chat-ID": chat_id,
        "TTFT [s]": round(turn["_ttft"], 2) if turn["_ttft"] is not None else None,
        "Antwortzeit [s]": round(turn["_time"], 2),
        "Ausgabe-Tokens": turn["_out"],
        "Input-Tokens (Summe)": turn["_in"],
        "Kontext-Tokens": turn["_ctx"],
        "Tokens/s": round(tps, 2) if tps is not None else None,
        "tps_source": "/".join(sorted(turn["_tps_sources"])),
        "Runden": turn["_rounds"],
        "Tool-Calls": turn["_calls"],
        "Fehlerhafte Tool-Calls": turn["_errors"],
        "Sub-Agenten": turn["_subagents"],
        "Tools": ", ".join(turn["_tools"]),
        "usage_source": "/".join(sorted(turn["_usage_sources"])),
        "_tps_pairs": turn["_tps"],
    }


def build_rows(messages: Iterable[Dict[str, Any]], chat_id: str) -> List[Dict[str, Any]]:
    """Turn rows plus a closing ``Gesamt`` row.

    ``messages`` are dicts with ``role``, ``content``, ``metadata`` (parsed) and
    ``timestamp``, oldest first — the shape the debug dump uses.
    """
    turns: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for msg in messages:
        md = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}
        if md.get("hidden"):
            continue
        role = msg.get("role")
        if role == "user":
            current = _new_turn(len(turns) + 1, msg.get("content"), msg.get("timestamp"))
            turns.append(current)
        elif role == "assistant":
            if current is None:  # an opening assistant message (greeting, injected)
                current = _new_turn(len(turns) + 1, "", msg.get("timestamp"))
                turns.append(current)
            _add_assistant(current, md)
    rows = [_finish(t, chat_id) for t in turns if t["_answered"]]
    if not rows:
        return []
    all_pairs = [p for r in rows for p in r["_tps_pairs"]]
    tps = _tps_of(all_pairs)
    first_ttft = next((r["TTFT [s]"] for r in rows if r["TTFT [s]"] is not None), None)
    total = {
        "Turn": "Gesamt",
        "Frage": f"{len(rows)} Turn(s)",
        "Modell": "/".join(sorted({r["Modell"] for r in rows if r["Modell"]})),
        "Zeitpunkt": rows[0]["Zeitpunkt"],
        "Chat-ID": chat_id,
        "TTFT [s]": first_ttft,
        "Antwortzeit [s]": round(sum(r["Antwortzeit [s]"] for r in rows), 2),
        "Ausgabe-Tokens": sum(r["Ausgabe-Tokens"] for r in rows),
        "Input-Tokens (Summe)": sum(r["Input-Tokens (Summe)"] for r in rows),
        "Kontext-Tokens": max(r["Kontext-Tokens"] for r in rows),
        "Tokens/s": round(tps, 2) if tps is not None else None,
        "tps_source": "/".join(sorted({s for r in rows for s in r["tps_source"].split("/") if s})),
        "Runden": sum(r["Runden"] for r in rows),
        "Tool-Calls": sum(r["Tool-Calls"] for r in rows),
        "Fehlerhafte Tool-Calls": sum(r["Fehlerhafte Tool-Calls"] for r in rows),
        "Sub-Agenten": sum(r["Sub-Agenten"] for r in rows),
        "Tools": "",
        "usage_source": "/".join(
            sorted({s for r in rows for s in r["usage_source"].split("/") if s})
        ),
    }
    for r in rows:
        r.pop("_tps_pairs", None)
    return rows + [total]


def to_csv(rows: List[Dict[str, Any]], excel_de: bool = True) -> str:
    """CSV text. ``excel_de``: semicolon separator and decimal comma, so a
    German Excel opens it straight into columns; otherwise comma and dot."""
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";" if excel_de else ",", lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for row in rows:
        out = []
        for col in COLUMNS:
            value = row.get(col)
            if value is None:
                out.append("")
            elif isinstance(value, float) and excel_de:
                out.append(f"{value:.2f}".replace(".", ","))
            else:
                out.append(value)
        writer.writerow(out)
    return buf.getvalue()
