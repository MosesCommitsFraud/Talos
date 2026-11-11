#!/usr/bin/env python3
"""Loop eval: how does the model behave in the agent loop, variant against variant?

Runs a fixed set of tasks as whole turns through the real agent loop
(``src.agent_loop.stream_agent_loop``) against a real model, once per variant,
and reports what the loop recorded: model calls, tool calls, rejected calls,
repeat reminders, nudges, how the turn ended, tokens and time, plus one check
per task of whether the turn did what the task asks for.

A variant is a set of settings that differ for the run, for example
``agent_prompt_style=lean`` against ``classic``. The settings are overridden in
this process only; nothing is written to the instance's settings file.

The tools do not really run. Each task brings scripted results for the tools it
needs (a search result, a file, a query result), so every variant sees the same
world and the run needs neither sandbox, database nor internet: only the model
endpoint. A tool the task has no result for answers "not available" and is
counted as an unexpected call. What this cannot show is anything that depends
on real tool output: whether generated code runs, whether a chart looks right.
Code is not executed either; what it "prints" is told from what it contains,
which is rough. When a task goes wrong in every variant, read its calls in the
saved JSON before blaming the model: the scripted world may be the odd one.

A local model samples, so one run per task says little. ``--repeats`` runs
every task several times per variant (default 3) and the report gives totals;
read a difference of one or two runs as noise.

Usage:
    python scripts/loop_eval.py --url http://192.168.10.91:8000/v1/chat/completions \\
        --model qwen3-llm --compare prompt --save loop_eval.json

    --compare prompt     lean against classic system prompt (default)
    --compare passback   reasoning_passback off against on
    --compare scripts    tool_scripts_enabled off against on
    --variant name:key=value,key=value   your own (repeatable; replaces --compare)
                         keys starting with ``loop.`` are arguments of the loop,
                         e.g. ``loop.reasoning=false``

    --list               show the tasks and exit
    --only a,b           run only these tasks
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Tools that only talk to the loop itself and are safe to run for real.
PASS_THROUGH = {"find_tools", "ask_user", "update_plan", "expand_output"}

COMPARISONS = {
    "prompt": [
        ("lean", {"agent_prompt_style": "lean"}),
        ("classic", {"agent_prompt_style": "classic"}),
    ],
    "passback": [
        ("passback-off", {"reasoning_passback": False}),
        ("passback-on", {"reasoning_passback": True}),
    ],
    "scripts": [
        ("scripts-off", {"tool_scripts_enabled": False}),
        ("scripts-on", {"tool_scripts_enabled": True}),
    ],
}


# ── one run ──────────────────────────────────────────────────────────────────


@dataclass
class Call:
    round: int
    tool: str
    content: str
    ok: bool
    scripted: bool  # the task had a result for it


@dataclass
class Run:
    task: str
    variant: str
    calls: List[Call] = field(default_factory=list)
    texts: List[str] = field(default_factory=lambda: [""])  # visible text per round
    model_calls: int = 0
    stats: Dict[str, Any] = field(default_factory=dict)  # metrics["loop"]
    stop_reason: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    seconds: float = 0.0
    error: str = ""
    unreachable: bool = False  # the endpoint dropped out: not a measurement
    problems: List[str] = field(default_factory=list)
    state: Dict[str, Any] = field(default_factory=dict)  # for fixtures

    @property
    def tools(self) -> List[str]:
        return [c.tool for c in self.calls]

    @property
    def answer(self) -> str:
        return "\n\n".join(t.strip() for t in self.texts if t.strip())

    @property
    def passed(self) -> bool:
        return not self.error and not self.problems

    def count(self, tool: str) -> int:
        return self.tools.count(tool)

    def summary(self) -> Dict[str, Any]:
        return {
            "task": self.task,
            "variant": self.variant,
            "passed": self.passed,
            "problems": self.problems,
            "error": self.error,
            "model_calls": self.model_calls,
            "tool_calls": len(self.calls),
            "unexpected_tools": [c.tool for c in self.calls if not c.scripted],
            "loop": self.stats,
            "stop_reason": self.stop_reason,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "seconds": round(self.seconds, 1),
            "calls": [
                {"round": c.round, "tool": c.tool, "ok": c.ok, "content": c.content[:400]}
                for c in self.calls
            ],
            "texts": self.texts,
        }


class Fail(Exception):
    """Raised by a fixture: the tool answers with this error."""


Fixture = Callable[[str, Run], Optional[str]]


@dataclass
class Task:
    key: str
    prompt: str
    about: str
    check: Callable[[Run], List[str]]
    tools: Dict[str, Fixture] = field(default_factory=dict)
    loop: Dict[str, Any] = field(default_factory=dict)  # extra loop arguments


# ── tasks ────────────────────────────────────────────────────────────────────

CSV = "monat,umsatz\nJan,120\nFeb,135\nMrz,128\nApr,150\n"

PY_RESULTS = (
    "[1] What's New In Python 3.13 - https://docs.python.org/3/whatsnew/3.13.html\n"
    "    Neuer interaktiver Interpreter (REPL) mit mehrzeiliger Bearbeitung und Farbe, "
    "experimenteller Free-Threaded-Build ohne GIL (PEP 703), experimenteller "
    "JIT-Compiler (PEP 744), bessere Fehlermeldungen.\n"
    "[2] Python 3.13 Release Notes - https://www.python.org/downloads/release/python-3130/\n"
    "    Veröffentlicht im Oktober 2024. Entfernt die veralteten 'dead batteries' "
    "der Standardbibliothek (PEP 594), iOS und Android als unterstützte Plattformen (Tier 3)."
)
PG_RESULTS = (
    "[3] PostgreSQL 17 Released - https://www.postgresql.org/about/news/postgresql-17-released-2936/\n"
    "    Neues Speichermanagement für VACUUM mit deutlich weniger Speicherbedarf, "
    "inkrementelle Backups mit pg_basebackup, JSON_TABLE, MERGE mit RETURNING.\n"
    "[4] PostgreSQL 17 Release Notes - https://www.postgresql.org/docs/17/release-17.html\n"
    "    Logische Replikation: Failover-Slots und pg_createsubscriber; COPY mit "
    "ON_ERROR; schnellere Schreibvorgänge im WAL bei hoher Parallelität."
)


def _web_search(content: str, run: Run) -> str:
    q = content.lower()
    parts = []
    if "python" in q:
        parts.append(PY_RESULTS)
    if "postgres" in q:
        parts.append(PG_RESULTS)
    return "\n".join(parts) if parts else _no_results(content, run)


PY_PAGE = (
    "What's New In Python 3.13\n\nRelease date: October 7, 2024\n\n"
    "Summary - Release Highlights\n"
    "A better interactive interpreter: the new REPL has multi-line editing with history, "
    "colour in prompts and tracebacks, and direct support for help, exit and quit.\n"
    "Free-threaded CPython (PEP 703): an experimental build that runs without the global "
    "interpreter lock, so threads can run in parallel on several cores.\n"
    "An experimental just-in-time compiler (PEP 744), off by default, as the basis for "
    "later performance work.\n"
    "Improved error messages: tracebacks are coloured by default, and a script named like "
    "a standard library module is pointed out.\n"
    "locals() now has defined semantics when it is modified (PEP 667).\n"
    "Removals: the 19 'dead batteries' modules deprecated by PEP 594 are gone, among them "
    "cgi, crypt, imghdr and telnetlib, and also the 2to3 tool.\n"
    "Platforms: iOS and Android are supported at tier 3, WASI at tier 2."
)
PG_PAGE = (
    "PostgreSQL 17 Released\n\nSeptember 26, 2024\n\n"
    "Performance: a new memory structure for vacuum uses up to 20 times less memory; "
    "write throughput under high concurrency is up to twice as high thanks to changes in "
    "write-ahead log processing; sequential reads use a new streaming I/O interface.\n"
    "Developer features: JSON_TABLE turns JSON data into a table; the SQL/JSON "
    "constructors and query functions (JSON_EXISTS, JSON_QUERY, JSON_VALUE) are added; "
    "MERGE gains a RETURNING clause and can update views.\n"
    "Backup: pg_basebackup supports incremental backups, and pg_combinebackup "
    "reconstructs a full backup from them.\n"
    "Logical replication: slots survive a major version upgrade with pg_upgrade, "
    "failover of slots is supported, and pg_createsubscriber turns a physical standby "
    "into a logical replica.\n"
    "COPY has an ON_ERROR option to continue when a row cannot be loaded."
)


# A page that was a search result keeps its source number when it is fetched,
# as in the real tool; any other page of the topic gets a number of its own.
_SOURCE_NUMBERS = (
    ("docs.python.org/3/whatsnew/3.13.html", 1),
    ("python.org/downloads/release/python-3130", 2),
    ("postgresql-17-released-2936", 3),
    ("release-17.html", 4),
)


def _web_fetch(content: str, run: Run) -> str:
    """A fetched page in the shape the real tool returns: numbered as a source
    and followed by the citation rule. Without the number the model has
    nothing to cite when it goes to the official page without searching."""
    from src import citations

    low = content.lower()
    if "postgres" in low:
        page, n = PG_PAGE, 6
    elif "python" in low:
        page, n = PY_PAGE, 5
    else:
        raise Fail("Could not fetch this URL (HTTP 404).")
    try:
        url = str(json.loads(content).get("url") or "")
    except (ValueError, TypeError, AttributeError):
        url = content.strip()
    n = next((number for part, number in _SOURCE_NUMBERS if part in url), n)
    title = page.split("\n", 1)[0]
    return f"[{n}] Fetched: {url}\nTitle: {title}\n\n{page}\n\n{citations.CITATION_RULE}"


def _no_results(content: str, run: Run) -> str:
    """A search that finds nothing, in the words the real tool uses. They depend
    on how many searches of the turn were empty, so the run is given a turn."""
    from src import citations, web_search

    try:
        query = str(json.loads(content).get("query") or "")
    except (ValueError, TypeError, AttributeError):
        query = content.strip()
    turn = run.state.setdefault("turn", f"loop-eval-{id(run)}")
    if not citations.active(turn):
        citations.begin_turn(turn)
    return web_search._format_search_results(query, {"results": []}, 8, session_id=turn)


def _calc(content: str, run: Run) -> str:
    return "5948.3\n267.6735\n6215.9735"


def _created(content: str, run: Run) -> str:
    title = content.strip().split("\n")[0][:80] or "Dokument"
    return f"Document created: [{title}](#document-d1a2b3)"


def _file_read(content: str, run: Run) -> str:
    if "daten/umsatz.csv" in content:
        raise Fail("File not found: daten/umsatz.csv")
    if "data/umsatz.csv" in content:
        return CSV
    raise Fail("File not found.")


def _file_ls(content: str, run: Run) -> str:
    if "daten" in content:
        raise Fail("No such directory: daten")
    if "data" in content:
        return "umsatz.csv"
    return "data/\nnotizen.md"


def _file_glob(content: str, run: Run) -> str:
    return "data/umsatz.csv"


def _file_bash(content: str, run: Run) -> str:
    if "data/umsatz.csv" in content and "daten/" not in content:
        return CSV
    if re.search(r"\b(ls|find|tree)\b", content):
        return "./data\n./data/umsatz.csv\n./notizen.md"
    raise Fail("No such file or directory")


def _file_python(content: str, run: Run) -> str:
    if "daten/umsatz.csv" in content:
        raise Fail("FileNotFoundError: [Errno 2] No such file or directory: 'daten/umsatz.csv'")
    if "data/umsatz.csv" in content:
        return "533"
    if "listdir" in content or "glob" in content or "walk" in content:
        return "['data', 'notizen.md']\n['data/umsatz.csv']"
    raise Fail("FileNotFoundError: [Errno 2] No such file or directory")


XLSX_ROWS = (
    "('Quartal', 'Umsatz')\n('Q1', 120)\n('Q2', 135)\n('Q3', 128)\n('Q4', 150)\n"
    "('Summe', '=SUM(B2:B5)')"
)


def _xlsx_code(content: str, run: Run) -> str:
    """What code about the spreadsheet prints, as far as that can be told
    without running it: building is silent, checking shows the rows."""
    out = []
    if "__version__" in content or "pip install" in content:
        out.append("openpyxl 3.1.5")
    if "Workbook(" in content and ".save(" in content:
        run.state["built"] = True
        if "print(" in content:
            out.append("output/quartale.xlsx")
    elif re.search(r"\bpython3? +\S+\.py\b", content):
        run.state["built"] = True
    built = run.state.get("built")
    if re.search(r"load_workbook|iter_rows|read_excel", content):
        if not built:
            raise Fail(
                "FileNotFoundError: [Errno 2] No such file or directory: 'output/quartale.xlsx'"
            )
        out.append(XLSX_ROWS)
    elif re.search(r"\bls\b|listdir|os\.path\.(exists|getsize)|\bfind\b", content):
        out.append("quartale.xlsx  5120 bytes" if built else "(no files)")
    return "\n".join(out)


def _xlsx_present(content: str, run: Run) -> str:
    if not run.state.get("built"):
        raise Fail("File not found: output/quartale.xlsx")
    return "Presented: output/quartale.xlsx"


def _sql(content: str, run: Run) -> str:
    try:
        args = json.loads(content)
    except (ValueError, TypeError):
        args = {"query": content}
    action = str(args.get("action") or ("query" if args.get("query") else "list_tables"))
    query = str(args.get("query") or "").lower()
    if action == "list_databases":
        return "main"
    if action == "list_tables":
        return "dbo.customers\ndbo.order_items\ndbo.orders"
    if action == "describe":
        table = str(args.get("table") or "").lower()
        if "orders" in table or "order" == table:
            return (
                "dbo.orders\n  order_id int\n  customer_id int\n  order_date date\n"
                "  total decimal(12,2)\n  status varchar(20)"
            )
        if "customer" in table:
            return "dbo.customers\n  customer_id int\n  name varchar(200)\n  city varchar(100)"
        return "dbo.order_items\n  order_id int\n  product_id int\n  quantity int"
    if action == "knowledge":
        return "No notes found for this query."
    return _sql_query(query)


# dbo.orders holds October 2026 and nothing else: 1284 orders.
SQL_STATUS = (("cancelled", 51), ("pending", 131), ("shipped", 1102))


def _sql_query(query: str) -> str:
    """Answer a query by what it asks for, as far as its text tells: a query
    for the sum or the status breakdown that only ever got the count back made
    the model ask again and again."""

    def alias(expression: str, default: str) -> str:
        found = re.search(expression + r"[^,]*?\bas\s+(\w+)", query)
        return found.group(1) if found else default

    if "order_items" in query:
        if "count" in query:
            return "anzahl\n3907\n(1 row)"
        return "order_id,product_id,quantity\n1001,4,2\n1001,9,1\n(2 of 3907 rows shown)"
    if "orders" not in query:
        if "customers" in query:
            if "count" in query:
                return "anzahl\n412\n(1 row)"
            return "customer_id,name,city\n17,Brandt GmbH,Kassel\n(1 of 412 rows shown)"
        raise Fail("Invalid object name.")
    if "distinct status" in query:
        return "status\n" + "\n".join(s for s, _ in SQL_STATUS) + "\n(3 rows)"
    if "group by" in query and "status" in query:
        name = alias(r"count\(", "anzahl")
        return f"status,{name}\n" + "\n".join(f"{s},{n}" for s, n in SQL_STATUS) + "\n(3 rows)"

    columns: List[tuple] = []
    per_status = "status" in query and ("case when" in query or "filter" in query)
    if per_status:
        # One column per status asked for, and the total if it is asked for too.
        whole = re.search(r"count\(\*\)\s+as\s+(\w+)", query)
        if whole:
            columns.append((whole.group(1), 1284))
        columns += [(s, n) for s, n in SQL_STATUS if f"'{s}'" in query]
    elif "count" in query:
        total = 1284
        one = re.search(r"where[^;]*\bstatus\s*(=|<>|!=)\s*'(\w+)'", query)
        if one:
            count = dict(SQL_STATUS).get(one.group(2), 0)
            total = count if one.group(1) == "=" else 1284 - count
        columns.append((alias(r"count\(", "anzahl"), total))
    revenue = re.search(
        r"sum\(\s*(?:cast\(\s*)?total\b[^,]*?\)+(?:\s*,\s*\d+\s*\))?(?:\s+as\s+(\w+))?", query
    )
    if revenue:
        columns.append((revenue.group(1) or "summe", "187432.50"))
    if "min(" in query:
        columns.append((alias(r"min\(", "min"), "2026-10-01"))
    if "max(" in query:
        columns.append((alias(r"max\(", "max"), "2026-10-31"))
    if columns:
        names = ",".join(str(c[0]) for c in columns)
        return f"{names}\n" + ",".join(str(c[1]) for c in columns) + "\n(1 row)"
    return (
        "order_id,customer_id,order_date,total,status\n"
        "1001,17,2026-10-01,249.90,shipped\n1002,23,2026-10-01,89.00,shipped\n"
        "(2 of 1284 rows shown)"
    )


def _has(text: str, *patterns: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def _check_wissen(run: Run) -> List[str]:
    out = []
    if run.calls:
        out.append(f"called tools for a question it can answer: {', '.join(run.tools)}")
    if len(run.answer) < 150:
        out.append("answer is missing or very short")
    return out


def _check_rechnen(run: Run) -> List[str]:
    out = []
    if not _has(run.answer, r"6[.\s]?215[,.]97"):
        out.append("answer does not contain 6.215,97")
    if run.model_calls > 3:
        out.append(f"{run.model_calls} model calls for one calculation")
    return out


def _check_dokument(run: Run) -> List[str]:
    out = []
    if run.count("create_document") != 1:
        out.append(f"create_document called {run.count('create_document')} times, expected once")
    if len(run.texts[-1].strip()) > 700:
        out.append("writes the document out again in the chat after creating it")
    if run.model_calls > 3:
        out.append(f"{run.model_calls} model calls, expected at most 3")
    return out


def _check_recherche(run: Run) -> List[str]:
    out = []
    # Going straight to the two official pages is as good as searching for them:
    # what counts is that the two independent lookups go out together.
    lookups = [c for c in run.calls if c.tool in ("web_search", "web_fetch")]
    if len(lookups) < 2:
        out.append("fewer than two lookups for two topics")
    elif len([c for c in lookups if c.round == 1]) < 2:
        out.append("the two lookups were not sent in the same response")
    if not re.search(r"\[\d\]", run.answer):
        out.append("answer cites no source number")
    if not (_has(run.answer, "python") and _has(run.answer, "postgres")):
        out.append("answer does not cover both topics")
    return out


def _check_unklar(run: Run) -> List[str]:
    out = []
    if run.count("ask_user") != 1:
        out.append("did not ask with ask_user")
    elif run.tools[-1] != "ask_user":
        out.append("carried on after asking")
    if run.model_calls > 3:
        out.append(f"{run.model_calls} model calls before the question")
    return out


def _check_fehler(run: Run) -> List[str]:
    out = []
    if not _has(run.answer, r"\b533\b"):
        out.append("answer does not contain the sum 533")
    failed = [(c.tool, c.content) for c in run.calls if not c.ok]
    if len(failed) != len(set(failed)):
        out.append("repeated a call that had already failed")
    if run.model_calls > 6:
        out.append(f"{run.model_calls} model calls to find one file")
    return out


def _check_leer(run: Run) -> List[str]:
    out = []
    if run.count("web_search") == 0:
        out.append("did not search")
    if run.count("web_search") > 4:
        out.append(f"{run.count('web_search')} searches on a source that has nothing")
    if not _has(run.answer, "nichts", "kein", "nicht gefunden", "no results", "ohne ergebnis"):
        out.append("answer does not say that nothing was found")
    if _has(run.answer, r"bedeutet,? dass", r"steht für") and not _has(run.answer, "könnte"):
        out.append("explains the code although nothing was found")
    return out


def _check_abgabe(run: Run) -> List[str]:
    out = []
    presented = [c for c in run.calls if c.tool == "present_files"]
    if not presented:
        out.append("did not hand the file over with present_files")
    elif len([c for c in presented if c.ok]) != 1:
        out.append("present_files did not succeed exactly once")
    elif "quartale.xlsx" not in presented[-1].content:
        out.append("presented a different file than the one asked for")
    if not (run.count("python") or run.count("bash") or run.count("run_cell")):
        out.append("never built the file")
    if run.model_calls > 8:
        out.append(f"{run.model_calls} model calls to build one small file")
    return out


def _check_sql(run: Run) -> List[str]:
    out = []
    if not _has(run.answer, r"1[.\s]?284"):
        out.append("answer does not contain 1.284")
    if run.count("query_sql") > 6:
        out.append(f"{run.count('query_sql')} database calls for one count")
    return out


TASKS: List[Task] = [
    Task(
        "wissen",
        "Was ist der Unterschied zwischen Deckungsbeitrag I und II? Kurz bitte.",
        "answers from knowledge without calling a tool",
        _check_wissen,
    ),
    Task(
        "rechnen",
        "Rechne bitte genau aus: 17 Monatsraten zu 349,90 Euro plus 4,5 % Aufschlag auf die Summe.",
        "computes and reports the result",
        _check_rechnen,
        tools={"python": _calc, "run_cell": _calc},
    ),
    Task(
        "dokument",
        "Erstelle mir eine kurze Checkliste für ein Kundengespräch als Dokument.",
        "creates the document once and does not repeat it in the chat",
        _check_dokument,
        tools={"create_document": _created, "present_files": lambda c, r: "Presented."},
    ),
    Task(
        "recherche",
        "Recherchiere: Was sind die wichtigsten Neuerungen in Python 3.13 und in PostgreSQL 17?",
        "sends independent lookups together and cites the sources",
        _check_recherche,
        tools={"web_search": _web_search, "web_fetch": _web_fetch},
    ),
    Task(
        "unklar",
        "Mach mir eine Auswertung.",
        "asks with ask_user and stops",
        _check_unklar,
        tools={
            "ls": lambda c, r: "(empty directory)",
            "glob": lambda c, r: "No files found.",
            "grep": lambda c, r: "No matches.",
            "bash": lambda c, r: "",
        },
    ),
    Task(
        "fehler",
        "Lies die Datei daten/umsatz.csv und nenne mir die Summe der Spalte umsatz.",
        "recovers from a wrong path without repeating the failed call",
        _check_fehler,
        tools={
            "read_file": _file_read,
            "ls": _file_ls,
            "glob": _file_glob,
            "grep": _file_glob,
            "bash": _file_bash,
            "python": _file_python,
            "run_cell": _file_python,
        },
    ),
    Task(
        "leer",
        "Suche im Web nach dem Fehlercode XK-9921-ZETA unserer Hydra-Steuerung "
        "und sag mir, was er bedeutet.",
        "stops searching a source that has nothing and says so",
        _check_leer,
        tools={"web_search": _no_results, "get_news": _no_results},
    ),
    Task(
        "abgabe",
        "Erstelle eine Excel-Datei mit den Quartalsumsätzen Q1 120, Q2 135, Q3 128, Q4 150 "
        "und der Summe, und speichere sie als output/quartale.xlsx.",
        "builds the file and hands it over with present_files",
        _check_abgabe,
        tools={
            "python": _xlsx_code,
            "run_cell": _xlsx_code,
            "bash": _xlsx_code,
            "write_file": lambda c, r: "File written.",
            "ls": lambda c, r: "output/" if not r.state.get("built") else "quartale.xlsx",
            "glob": lambda c, r: "output/quartale.xlsx" if r.state.get("built") else "",
            "present_files": _xlsx_present,
        },
    ),
    Task(
        "sql",
        "Wie viele Bestellungen gab es im Oktober 2026?",
        "finds the table and counts with few database calls",
        _check_sql,
        tools={"query_sql": _sql, "db_memory": lambda c, r: "No notes yet."},
        loop={"force_db": True},
    ),
]


# Tools a model may reach for in any task. They answer like a fresh
# installation: nothing stored yet.
COMMON: Dict[str, Fixture] = {
    "browse_skills": lambda c, r: "No skills are enabled.",
    "memory": lambda c, r: "No memories yet.",
    "search_chats": lambda c, r: "No chats found.",
    "manage_documents": lambda c, r: "No documents.",
    "list_sessions": lambda c, r: "No other chats.",
}


# ── running ──────────────────────────────────────────────────────────────────


@contextlib.contextmanager
def settings_override(values: Dict[str, Any]):
    """Settings as the variant wants them, for this process only."""
    from src import agent_loop, settings

    real = settings.load_settings
    settings.load_settings = lambda: {**real(), **values}
    agent_loop._cached_base_prompt = None
    try:
        yield
    finally:
        settings.load_settings = real
        agent_loop._cached_base_prompt = None


def _preface(prompt: str) -> List[Dict[str, Any]]:
    """The system context a chat turn starts with."""
    from src.prompt_security import UNTRUSTED_CONTEXT_POLICY, system_policy

    try:
        from src.chat_processor import ChatProcessor

        preface, _ = ChatProcessor(None).build_context_preface(
            message=prompt, session=None, use_rag=False, agent_mode=True
        )
        return [{"role": m["role"], "content": m["content"]} for m in preface]
    except Exception:
        return [
            {"role": "system", "content": system_policy()},
            {"role": "system", "content": UNTRUSTED_CONTEXT_POLICY},
        ]


class ModelGone(Exception):
    """The endpoint stopped answering and did not come back."""


# Seconds to wait before a turn the endpoint dropped out of is run again.
RECONNECT_WAITS = (30, 60, 120, 300, 600)
_GATEWAY_STATUS = (502, 503, 504)


def _stream_error(chunk: str) -> Dict[str, Any]:
    """What an ``event: error`` chunk of the model stream says."""
    try:
        info = json.loads(chunk.partition("data: ")[2].strip())
    except ValueError:
        info = None
    return info if isinstance(info, dict) else {"error": chunk.strip()}


async def _pause(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def run_task(task: Task, variant: str, loop_args: Dict[str, Any], opts) -> Run:
    """One whole turn. Settings must already be overridden by the caller."""
    from src import agent_loop

    run = Run(task=task.key, variant=variant)
    real_execute = agent_loop.execute_tool_block
    real_stream = agent_loop.stream_llm_with_fallback

    async def execute(block, **kwargs):
        tool, content = block.tool_type, str(block.content or "")
        if getattr(block, "error", None):  # rejected by the loop: its error is the result
            desc, result = await real_execute(block, **kwargs)
            run.calls.append(Call(run.model_calls, tool, content, False, True))
            return desc, result
        if tool in PASS_THROUGH:
            desc, result = await real_execute(block, **kwargs)
            ok = result.get("exit_code") in (0, None) and not result.get("error")
            run.calls.append(Call(run.model_calls, tool, content, ok, True))
            return desc, result
        fixture = task.tools.get(tool) or COMMON.get(tool)
        if fixture is None:
            run.calls.append(Call(run.model_calls, tool, content, False, False))
            return f"{tool}: failed", {
                "error": f"{tool} is not available in this session.",
                "exit_code": 1,
            }
        try:
            output = fixture(content, run)
        except Fail as exc:
            run.calls.append(Call(run.model_calls, tool, content, False, True))
            return f"{tool}: failed", {"error": str(exc), "exit_code": 1}
        run.calls.append(Call(run.model_calls, tool, content, True, True))
        return f"{tool}: ok", {"output": output or "", "exit_code": 0}

    async def stream(*args, **kwargs):
        run.model_calls += 1
        async for chunk in real_stream(*args, **kwargs):
            yield chunk

    messages = _preface(task.prompt) + [{"role": "user", "content": task.prompt}]
    kwargs: Dict[str, Any] = {
        "headers": opts.headers,
        "temperature": opts.temperature,
        "max_tokens": 0,
        "context_length": opts.context_length,
        "session_id": f"loop-eval-{variant}-{task.key}-{int(time.time() * 1000)}",
        "reasoning": opts.reasoning,
        **task.loop,
        **loop_args,
    }

    async def consume():
        async for chunk in agent_loop.stream_agent_loop(opts.url, opts.model, messages, **kwargs):
            if chunk.startswith("event: error"):
                # The model call failed. Even if the loop gets its round
                # through on another try, this turn did not run cleanly.
                info = _stream_error(chunk)
                run.error = str(info.get("error") or "model error")[:300]
                if info.get("status") in _GATEWAY_STATUS or "reach" in run.error.lower():
                    run.unreachable = True
                continue
            if not chunk.startswith("data: {"):
                continue
            event = json.loads(chunk[6:])
            if "delta" in event:
                if not event.get("thinking"):
                    run.texts[-1] += event["delta"]
            elif event.get("type") == "agent_step":
                run.texts.append("")
            elif event.get("type") == "error":
                run.error = str(event.get("message") or event.get("error") or "error")[:300]
            elif event.get("type") == "metrics":
                data = event.get("data") or {}
                run.stats = data.get("loop") or {}
                run.stop_reason = data.get("stop_reason") or ""
                run.input_tokens = int(data.get("input_tokens") or 0)
                run.output_tokens = int(data.get("output_tokens") or 0)

    agent_loop.execute_tool_block = execute
    agent_loop.stream_llm_with_fallback = stream
    started = time.time()
    try:
        await asyncio.wait_for(consume(), timeout=opts.timeout)
    except asyncio.TimeoutError:
        run.error = f"no end after {opts.timeout}s"
    except Exception as exc:  # the eval reports, it does not stop at one broken turn
        run.error = f"{type(exc).__name__}: {exc}"[:300]
    finally:
        agent_loop.execute_tool_block = real_execute
        agent_loop.stream_llm_with_fallback = real_stream
    run.seconds = time.time() - started
    if not run.error:
        run.problems = task.check(run)
    return run


async def _measured(task: Task, name: str, values: Dict[str, Any], opts) -> Run:
    """One turn that counts. A turn the endpoint dropped out of says nothing
    about the model, so it is run again once the endpoint answers; when it
    stays away, the run ends with ModelGone."""
    settings = {k: v for k, v in values.items() if not k.startswith("loop.")}
    loop_args = {k[5:]: v for k, v in values.items() if k.startswith("loop.")}
    for wait in (*getattr(opts, "reconnect_waits", RECONNECT_WAITS), None):
        with settings_override(settings):
            run = await run_task(task, name, loop_args, opts)
        if not run.unreachable:
            return run
        if wait is None:
            break
        print(
            f"model not reachable ({run.error}); {name} {task.key} again in {wait}s",
            file=sys.stderr,
            flush=True,
        )
        await _pause(wait)
    raise ModelGone(run.error)


async def run_all(tasks: List[Task], variants, opts, on_run=None) -> List[Run]:
    """Every task, every variant, ``opts.repeats`` times; variants take turns."""
    runs: List[Run] = []
    for _ in range(opts.repeats):
        for task in tasks:
            for name, values in variants:
                run = await _measured(task, name, values, opts)
                runs.append(run)
                if on_run:
                    on_run(run)
    return runs


# ── report ───────────────────────────────────────────────────────────────────

NUDGES = ("empty_round_nudges", "intent_nudges", "verifier_rounds")


def totals(runs: List[Run]) -> Dict[str, Any]:
    n = len(runs) or 1
    stat = lambda key: sum(int(r.stats.get(key) or 0) for r in runs)  # noqa: E731
    return {
        "runs": len(runs),
        "passed": sum(r.passed for r in runs),
        "model_calls": round(sum(r.model_calls for r in runs) / n, 2),
        "tool_calls": round(sum(len(r.calls) for r in runs) / n, 2),
        "rejected_calls": stat("rejected_calls"),
        "repeat_reminders": stat("repeat_reminders"),
        "nudges": sum(stat(k) for k in NUDGES),
        "forced_answers": sum(1 for r in runs if r.stats.get("forced_answer_by")),
        "unexpected_tools": sum(1 for r in runs for c in r.calls if not c.scripted),
        "abnormal_ends": sum(1 for r in runs if r.stop_reason or r.error),
        "input_tokens": round(sum(r.input_tokens for r in runs) / n),
        "output_tokens": round(sum(r.output_tokens for r in runs) / n),
        "seconds": round(sum(r.seconds for r in runs) / n, 1),
    }


ROWS = [
    ("passed", "Tasks passed"),
    ("model_calls", "Model calls per turn"),
    ("tool_calls", "Tool calls per turn"),
    ("rejected_calls", "Rejected calls (total)"),
    ("repeat_reminders", "Repeat reminders (total)"),
    ("nudges", "Nudges (total)"),
    ("forced_answers", "Forced answers (total)"),
    ("unexpected_tools", "Calls to tools the task has no use for"),
    ("abnormal_ends", "Turns that did not end normally"),
    ("input_tokens", "Input tokens per turn"),
    ("output_tokens", "Output tokens per turn"),
    ("seconds", "Seconds per turn"),
]


def report(runs: List[Run], variants: List[str], tasks: List[Task]) -> str:
    def table(header: List[str], rows: List[List[str]]) -> List[str]:
        out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
        return out + ["| " + " | ".join(r) + " |" for r in rows]

    by = {v: [r for r in runs if r.variant == v] for v in variants}
    sums = {v: totals(by[v]) for v in variants}
    lines = ["## Totals", ""]
    rows = []
    for key, label in ROWS:
        cells = [
            f"{sums[v]['passed']}/{sums[v]['runs']}" if key == "passed" else str(sums[v][key])
            for v in variants
        ]
        rows.append([label] + cells)
    lines += table([""] + variants, rows)

    lines += ["", "## Per task (passed, model calls per turn)", ""]
    rows = []
    for task in tasks:
        cells = []
        for v in variants:
            mine = [r for r in by[v] if r.task == task.key]
            if not mine:
                cells.append("-")
                continue
            calls = sum(r.model_calls for r in mine) / len(mine)
            cells.append(f"{sum(r.passed for r in mine)}/{len(mine)}, {calls:.1f}")
        rows.append([f"{task.key}: {task.about}"] + cells)
    lines += table(["Task"] + variants, rows)

    failed = [r for r in runs if not r.passed]
    if failed:
        lines += ["", "## What went wrong", ""]
        seen: Dict[tuple, int] = {}
        for r in failed:
            for problem in [r.error] if r.error else r.problems:
                seen[(r.variant, r.task, problem)] = seen.get((r.variant, r.task, problem), 0) + 1
        for (variant, task, problem), count in sorted(seen.items()):
            lines.append(f"- {variant} / {task}: {problem}" + (f" ({count}x)" if count > 1 else ""))
    return "\n".join(lines)


# ── command line ─────────────────────────────────────────────────────────────


def _value(text: str) -> Any:
    low = text.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError:
            return text


def parse_variant(spec: str):
    name, _, rest = spec.partition(":")
    values = {}
    for pair in filter(None, (p.strip() for p in rest.split(","))):
        key, _, value = pair.partition("=")
        values[key.strip()] = _value(value)
    if not name.strip() or not values:
        raise SystemExit(f"--variant needs name:key=value, got {spec!r}")
    return name.strip(), values


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default=os.environ.get("LOOP_EVAL_URL", ""))
    ap.add_argument("--model", default=os.environ.get("LOOP_EVAL_MODEL", ""))
    ap.add_argument("--api-key", default=os.environ.get("LOOP_EVAL_API_KEY", ""))
    ap.add_argument("--compare", choices=sorted(COMPARISONS), default="prompt")
    ap.add_argument("--variant", action="append", default=[], help="name:key=value,key=value")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--only", help="comma-separated task keys")
    ap.add_argument("--no-thinking", action="store_true", help="run the turns without reasoning")
    ap.add_argument("--temperature", type=float, default=0.6)
    ap.add_argument("--context-length", type=int, default=131072)
    ap.add_argument("--timeout", type=int, default=900, help="seconds per turn")
    ap.add_argument("--save", help="write every run with its calls and texts as JSON")
    ap.add_argument("--list", action="store_true", help="show the tasks and exit")
    args = ap.parse_args(argv)

    if args.list:
        for task in TASKS:
            print(f"{task.key:10} {task.about}\n{'':10} {task.prompt}")
        return 0
    if not args.url or not args.model:
        ap.error("--url and --model are required (or LOOP_EVAL_URL / LOOP_EVAL_MODEL)")

    os.environ.setdefault("TALOS_ASSUME_NATIVE_TOOLS", "1")
    only = {k.strip() for k in (args.only or "").split(",") if k.strip()}
    unknown = only - {t.key for t in TASKS}
    if unknown:
        ap.error(f"unknown task(s): {', '.join(sorted(unknown))}")
    tasks = [t for t in TASKS if not only or t.key in only]
    variants = [parse_variant(v) for v in args.variant] or COMPARISONS[args.compare]
    args.headers = {"Authorization": f"Bearer {args.api_key}"} if args.api_key else None
    args.reasoning = not args.no_thinking

    names = [name for name, _ in variants]
    planned = len(tasks) * len(variants) * args.repeats
    runs: List[Run] = []

    def save() -> None:
        if not args.save:
            return
        payload = {
            "model": args.model,
            "variants": dict(variants),
            "repeats": args.repeats,
            "reasoning": args.reasoning,
            "turns": f"{len(runs)}/{planned}",
            "totals": {v: totals([r for r in runs if r.variant == v]) for v in names},
            "runs": [r.summary() for r in runs],
        }
        Path(args.save).write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")

    def show(run: Run) -> None:
        runs.append(run)
        save()  # after every turn: a run that breaks off keeps what it measured
        mark = "ok  " if run.passed else "FAIL"
        why = run.error or "; ".join(run.problems)
        print(
            f"{mark} {run.variant:14} {run.task:10} {run.model_calls} model calls, "
            f"{len(run.calls)} tool calls, {run.seconds:5.1f}s" + (f"  ({why})" if why else ""),
            flush=True,
        )

    gone = ""
    try:
        asyncio.run(run_all(tasks, variants, args, on_run=show))
    except ModelGone as exc:
        gone = str(exc) or "no answer"
    print("\n" + report(runs, names, tasks))
    if args.save:
        print(f"\nSaved {len(runs)} runs to {args.save}")
    if gone:
        print(
            f"\nStopped after {len(runs)} of {planned} turns: the model endpoint "
            f"stopped answering ({gone}). The numbers above cover the turns that ran.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
