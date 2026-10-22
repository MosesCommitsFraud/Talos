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

Each row also carries a ``detail`` dict the CSV leaves out: the output split
into thinking / answer / tool-call tokens, prefix-cache hits, where the time
went (prep, waiting for the first token, thinking, writing, tools) and the
context window — what the admin metrics panel charts.

Pure functions over the persisted message rows; the routes live in
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
        "_d": {
            "reasoning_tokens": 0,
            "answer_tokens": 0,
            "tool_call_tokens": 0,
            "split_sources": set(),
            "cached_tokens": 0,
            "prefill_tps": None,
            "context_length": 0,
            "context_breakdown": None,
            "context_build_s": 0.0,
            "prep_s": 0.0,
            "wait_s": 0.0,
            "thinking_s": 0.0,
            "writing_s": 0.0,
            "tools_s": 0.0,
            "tools": {},
        },
    }


def _add_timing(d: Dict[str, Any], md: Dict[str, Any]) -> None:
    """Where one assistant message's time went. The round profile has it per
    round; messages from before it existed fall back to TTFT vs. the rest."""
    d["context_build_s"] += _num(md.get("context_build_s"))
    prep = _num(md.get("agent_prep_time"))
    d["prep_s"] += prep
    rounds = [r for r in (md.get("round_profile") or []) if isinstance(r, dict)]
    if not rounds:
        ttft = _num(md.get("time_to_first_token"))
        d["wait_s"] += max(ttft - prep, 0.0)
        d["writing_s"] += max(_num(md.get("response_time")) - ttft, 0.0)
        return
    for r in rounds:
        first = _num(r.get("first_token_s"))
        visible = max(_num(r.get("first_visible_s")), first)
        stream = max(_num(r.get("stream_s")), visible)
        d["wait_s"] += first
        d["thinking_s"] += visible - first
        d["writing_s"] += stream - visible
        d["tools_s"] += _num(r.get("tools_s"))


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
    d = turn["_d"]
    for key in ("reasoning_tokens", "answer_tokens", "tool_call_tokens"):
        d[key] += int(_num(md.get(key)))
    if md.get("output_split_source"):
        d["split_sources"].add(str(md["output_split_source"]))
    for r in md.get("round_profile") or []:
        if isinstance(r, dict):
            d["cached_tokens"] += int(_num(r.get("cached_tokens")))
    if _num(md.get("prefill_tps")) > 0:
        d["prefill_tps"] = _num(md.get("prefill_tps"))
    d["context_length"] = max(d["context_length"], int(_num(md.get("context_length"))))
    if isinstance(md.get("context_breakdown"), dict) and md["context_breakdown"]:
        d["context_breakdown"] = md["context_breakdown"]
    _add_timing(d, md)
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
            stat = d["tools"].setdefault(name, {"calls": 0, "errors": 0})
            stat["calls"] += 1
            if e.get("exit_code") not in (None, 0):
                stat["errors"] += 1
        if name == "delegate":
            turn["_subagents"] += _subagent_count(e)


def _tps_of(pairs: List[tuple]) -> Optional[float]:
    if not pairs:
        return None
    weight = sum(out for _, out in pairs)
    if weight <= 0:
        return sum(t for t, _ in pairs) / len(pairs)
    return sum(t * out for t, out in pairs) / weight


def _detail(d: Dict[str, Any], output_tokens: int) -> Dict[str, Any]:
    split = d["reasoning_tokens"] + d["answer_tokens"] + d["tool_call_tokens"]
    sources = d["split_sources"]
    return {
        "reasoning_tokens": d["reasoning_tokens"],
        "answer_tokens": d["answer_tokens"],
        "tool_call_tokens": d["tool_call_tokens"],
        # Output recorded before the split existed (or estimated differently
        # than the split) — shown as its own segment rather than guessed.
        "unsplit_tokens": max(output_tokens - split, 0),
        "split_source": (
            next(iter(sources)) if len(sources) == 1 else "mixed" if sources else "none"
        ),
        "cached_tokens": d["cached_tokens"],
        "prefill_tps": round(d["prefill_tps"], 2) if d["prefill_tps"] else None,
        "context_length": d["context_length"],
        "context_breakdown": d["context_breakdown"],
        "time": {
            k: round(d[k + "_s"], 2)
            for k in ("context_build", "prep", "wait", "thinking", "writing", "tools")
        },
        "tools": d["tools"],
    }


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
        "detail": _detail(turn["_d"], turn["_out"]),
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
    total["detail"] = _total_detail([r["detail"] for r in rows])
    for r in rows:
        r.pop("_tps_pairs", None)
    return rows + [total]


def _total_detail(details: List[Dict[str, Any]]) -> Dict[str, Any]:
    sources = {d["split_source"] for d in details}
    tools: Dict[str, Dict[str, int]] = {}
    for d in details:
        for name, stat in d["tools"].items():
            agg = tools.setdefault(name, {"calls": 0, "errors": 0})
            agg["calls"] += stat["calls"]
            agg["errors"] += stat["errors"]
    prefill = [d["prefill_tps"] for d in details if d["prefill_tps"]]
    return {
        **{
            k: sum(d[k] for d in details)
            for k in (
                "reasoning_tokens",
                "answer_tokens",
                "tool_call_tokens",
                "unsplit_tokens",
                "cached_tokens",
            )
        },
        "split_source": next(iter(sources)) if len(sources) == 1 else "mixed",
        "prefill_tps": round(sum(prefill) / len(prefill), 2) if prefill else None,
        "context_length": max(d["context_length"] for d in details),
        "context_breakdown": next(
            (d["context_breakdown"] for d in reversed(details) if d["context_breakdown"]), None
        ),
        "time": {
            k: round(sum(d["time"][k] for d in details), 2) for k in details[0]["time"]
        },
        "tools": tools,
    }


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
