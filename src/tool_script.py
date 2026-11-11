"""Tool scripts: the model writes a program that calls its tools itself.

Some tasks are many tool calls whose results the model does not need to read
one by one: look at twelve tables and join what matters, fetch thirty pages and
pull one figure from each, page through a search. Done call by call, every
result lands in the context and every step is a model round. A script does the
calls in a loop and prints only its conclusion.

The script runs where the `python` tool runs — the sandbox, which has no
network and cannot reach the database, the web or the knowledge base. That is
the whole reason those are tools. So a tool call inside a script is carried out
by the app, with the same checks as any other call, and the script gets the
result.

There is no channel from the sandbox back to the app, and none is needed:

1. the script runs until it calls a tool it has no result for. It writes down
   which call it needs and stops;
2. the app makes that call and adds the result to what the script already has;
3. the script runs again from the top. Calls it made before are answered from
   memory, so it moves past them and reaches the next one.

That repeats until the script finishes. Running a short program a few dozen
times costs milliseconds. What it asks of a script is that it reaches its tool
calls the same way every time (the wrapper checks, and says so if not), and
that things which must happen once — writing a file — happen after the last
tool call. The tool description tells the model both.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

TOOL_NAME = "run_tool_script"

# What a script may call: the things the sandbox cannot reach itself, all of
# them read-only. A tool switched off for the turn is left out on top of this.
SCRIPT_TOOLS: Tuple[str, ...] = (
    "query_sql",
    "search_knowledge",
    "read_knowledge",
    "grep_knowledge",
    "list_knowledge",
    "web_search",
    "web_fetch",
    "search_chats",
)

# What one bare argument means: `tools.web_fetch(url)` is how a model writes
# the call about as often as `tools.web_fetch(url=url)`, and there is only one
# thing it can mean. The second entry is what goes with it (a bare string to
# query_sql is a query to run).
POSITIONAL: Dict[str, Tuple[str, Dict[str, Any]]] = {
    "query_sql": ("query", {"action": "query"}),
    "search_knowledge": ("query", {}),
    "read_knowledge": ("document", {}),
    "grep_knowledge": ("pattern", {}),
    "list_knowledge": ("query", {}),
    "web_search": ("query", {}),
    "web_fetch": ("url", {}),
    "search_chats": ("query", {}),
}

DEFAULT_MAX_CALLS = 50
# Calls of one `tools.parallel([...])` carried out at the same time.
PARALLEL_LIMIT = 4
# Exit code of a run that stopped to ask for a tool call.
_PAUSED = 87

# One line of the run's output is the wrapper speaking to the app; it starts
# with a marker no script can know in advance.
_RESULTS_FILE = ".talos-data/tool_script_{run}.json"


def enabled() -> bool:
    """Whether the model is offered `run_tool_script` (setting
    `tool_scripts_enabled`)."""
    try:
        from src.settings import get_setting

        return bool(get_setting("tool_scripts_enabled", False))
    except Exception:
        return False


def max_calls_setting() -> int:
    try:
        from src.settings import get_setting

        return max(1, min(int(get_setting("tool_script_max_calls", DEFAULT_MAX_CALLS) or 0), 500))
    except Exception:
        return DEFAULT_MAX_CALLS


# The part of the program that is ours. It reads the results the app has so
# far, hands them to the script call by call, and stops at the first call it
# cannot answer. Everything the script prints is collected and written after
# the wrapper's own line, so that line is always the first of the output.
_WRAPPER = r'''
import base64 as _b64, contextlib as _ctx, io as _io, json as _json, os as _os, sys as _sys, traceback as _tb

_MARK = {mark!r}
_ALLOWED = {allowed!r}
_POSITIONAL = {positional!r}
try:
    with open({results_path!r}, encoding="utf-8") as _fh:
        _RESULTS = _json.load(_fh)
except FileNotFoundError:
    _RESULTS = []
_OUT = _io.StringIO()
# The stream the app reads, which it decodes as UTF-8 whatever the platform's
# default is. Taken now: while the script runs, sys.stdout is the buffer above.
try:
    _sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
_REAL = _sys.stdout


class ToolError(Exception):
    """A tool call that failed. The message is what the tool said."""


class ToolResult(str):
    """A tool's answer as text. `.data` holds it as rows or objects when the
    tool returns structured data, else None."""

    data = None


def _emit(message, code):
    _REAL.write(_MARK + _json.dumps(message, default=str) + "\n")
    _REAL.write(_OUT.getvalue())
    _REAL.flush()
    _os._exit(code)


def _norm(value):
    return _json.loads(_json.dumps(value, default=str, sort_keys=True))


class _Tools:
    def __init__(self):
        self._n = 0

    def _answer(self, name, args):
        if name not in _ALLOWED:
            raise ToolError("unknown tool %r. A script can call: %s" % (name, ", ".join(_ALLOWED)))
        index = self._n
        self._n += 1
        if index >= len(_RESULTS):
            return None, index
        known = _RESULTS[index]
        if known["name"] != name or known["args"] != _norm(args):
            _emit({{"error": "The script took a different path than on its previous run: call %d "
                   "was %s, now it is %s. A script is run again from the top after each tool "
                   "call, so it must reach its calls the same way every time (no randomness, no "
                   "decisions based on the clock or on files it writes itself)."
                   % (index + 1, known["name"], name)}}, 1)
        return known, index

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(*positional, **args):
            if positional:
                if name not in _ALLOWED:
                    self._answer(name, {{}})  # says which tools there are
                first, extra = _POSITIONAL.get(name) or (None, {{}})
                if len(positional) == 1 and isinstance(positional[0], dict) and not args:
                    args = positional[0]
                elif len(positional) == 1 and first and first not in args:
                    # One bare argument is the tool's main one.
                    args = dict(extra, **args)
                    args[first] = positional[0]
                else:
                    raise TypeError("tools.%s() takes keyword arguments, e.g. tools.%s(%s=...)"
                                    % (name, name, first or "query"))
            known, _index = self._answer(name, args)
            if known is None:
                _emit({{"calls": [{{"name": name, "args": _norm(args)}}]}}, {paused})
            if not known["ok"]:
                raise ToolError(known["text"])
            result = ToolResult(known["text"])
            result.data = known.get("data")
            return result

        return call

    def parallel(self, calls):
        """Make several independent calls at once. `calls` is a list of
        (tool name, arguments dict). Returns one result per call, in order;
        a call that failed gives None."""
        calls = [(str(n), dict(a or {{}})) for n, a in calls]
        answers, missing = [], []
        for name, args in calls:
            known, _index = self._answer(name, args)
            answers.append(known)
            if known is None:
                missing.append({{"name": name, "args": _norm(args)}})
        if missing:
            _emit({{"calls": missing}}, {paused})
        results = []
        for known in answers:
            if not known["ok"]:
                results.append(None)
                continue
            result = ToolResult(known["text"])
            result.data = known.get("data")
            results.append(result)
        return results


tools = _Tools()
_code = _b64.b64decode({code_b64!r}).decode("utf-8")
_status = 0
with _ctx.redirect_stdout(_OUT), _ctx.redirect_stderr(_OUT):
    try:
        exec(compile(_code, "<script>", "exec"), {{"tools": tools, "ToolError": ToolError, "__name__": "__main__"}})
    except SystemExit as _stop:
        _status = _stop.code if isinstance(_stop.code, int) else (0 if _stop.code is None else 1)
    except BaseException:
        _tb.print_exc()
        _status = 1
_emit({{"done": True}}, _status)
'''


def build_program(code: str, mark: str, allowed: Iterable[str], results_path: str) -> str:
    """The Python source that is run in the sandbox: wrapper plus script."""
    return _WRAPPER.format(
        mark=mark,
        allowed=list(allowed),
        positional={name: list(POSITIONAL[name]) for name in allowed if name in POSITIONAL},
        results_path=results_path,
        code_b64=base64.b64encode(code.encode("utf-8")).decode("ascii"),
        paused=_PAUSED,
    )


def _split_output(stdout: str, mark: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """The wrapper's message and the script's own output."""
    at = stdout.find(mark)
    if at < 0:
        return None, stdout
    line_end = stdout.find("\n", at)
    line_end = len(stdout) if line_end < 0 else line_end
    try:
        message = json.loads(stdout[at + len(mark) : line_end])
    except ValueError:
        return None, stdout
    # Anything before the marker was written by a child process of the script.
    return (message if isinstance(message, dict) else None), stdout[:at] + stdout[line_end + 1 :]


def _summary(results: List[Dict[str, Any]]) -> str:
    if not results:
        return "[The script made no tool calls.]"
    counts: Dict[str, int] = {}
    for r in results:
        counts[r["name"]] = counts.get(r["name"], 0) + 1
    failed = sum(1 for r in results if not r["ok"])
    parts = ", ".join(f"{name} ×{n}" for name, n in counts.items())
    tail = f", {failed} failed" if failed else ""
    return f"[The script made {len(results)} tool call(s): {parts}{tail}.]"


RunPython = Callable[[str], Awaitable[Tuple[str, str, int]]]
WriteFile = Callable[[str, str], Awaitable[None]]
CallTool = Callable[[str, Dict[str, Any]], Awaitable[Tuple[bool, str, Any]]]


async def run_script(
    code: str,
    *,
    allowed: Iterable[str],
    run_python: RunPython,
    write_file: WriteFile,
    call_tool: CallTool,
    max_calls: int = DEFAULT_MAX_CALLS,
) -> Dict[str, Any]:
    """Run a tool script to its end. Returns a tool result dict.

    * `run_python(source)` runs Python in the script's workspace and returns
      (stdout, stderr, exit code);
    * `write_file(path, content)` writes a workspace file;
    * `call_tool(name, arguments)` carries out one tool call and returns
      (ok, text, structured data or None).
    """
    code = (code or "").strip()
    if not code:
        return {"error": f"{TOOL_NAME}: `code` is required.", "exit_code": 1}
    allowed = [name for name in allowed]
    if not allowed:
        return {
            "error": f"{TOOL_NAME}: no tool is available to a script in this chat. "
            "Use the `python` tool for plain computation.",
            "exit_code": 1,
        }

    run_id = secrets.token_hex(6)
    mark = f"<<tool-script:{secrets.token_hex(8)}>>"
    results_path = _RESULTS_FILE.format(run=run_id)
    program = build_program(code, mark, allowed, results_path)
    results: List[Dict[str, Any]] = []
    gate = asyncio.Semaphore(PARALLEL_LIMIT)

    async def one(call: Dict[str, Any]) -> Dict[str, Any]:
        name, args = str(call.get("name") or ""), call.get("args") or {}
        async with gate:
            try:
                ok, text, data = await call_tool(name, args)
            except Exception as exc:
                logger.warning("tool script: %s failed: %s", name, exc)
                ok, text, data = False, f"{name} failed: {exc}", None
        try:
            json.dumps(data)
        except (TypeError, ValueError):
            data = None
        return {"name": name, "args": args, "ok": bool(ok), "text": str(text or ""), "data": data}

    output, exit_code = "", 1
    # One run per batch of calls, plus the run that finishes.
    for _ in range(max_calls + 2):
        await write_file(results_path, json.dumps(results, ensure_ascii=False))
        stdout, stderr, exit_code = await run_python(program)
        # A Windows interpreter (local development) writes \r\n line ends.
        message, output = _split_output((stdout or "").replace("\r\n", "\n"), mark)
        if stderr and stderr.strip():
            output = (output.rstrip() + "\nSTDERR: " + stderr.strip()).strip()
        if message is None:
            # The wrapper never got to speak: the interpreter itself failed, or
            # the output was cut before its line.
            return {
                "error": f"{TOOL_NAME}: the script could not be run.\n{output.strip()}".strip(),
                "exit_code": exit_code or 1,
            }
        if message.get("error"):
            return {"error": f"{TOOL_NAME}: {message['error']}", "exit_code": 1}
        calls = message.get("calls")
        if not calls:
            break  # done
        if len(results) + len(calls) > max_calls:
            return {
                "error": (
                    f"{TOOL_NAME}: the script went past its limit of {max_calls} tool calls and "
                    "was stopped. It may contain an endless loop; check where the loop ends, or "
                    "split the work into several scripts.\n" + _summary(results)
                ),
                "exit_code": 1,
            }
        results += await asyncio.gather(*(one(call) for call in calls))
    else:
        return {"error": f"{TOOL_NAME}: the script did not finish.", "exit_code": 1}

    body = output.strip() or "(the script printed nothing)"
    return {
        "output": f"{body}\n\n{_summary(results)}",
        "exit_code": int(exit_code or 0),
        "script_calls": [{"tool": r["name"], "ok": r["ok"]} for r in results],
    }


def tool_description(allowed: Iterable[str]) -> str:
    """What the model reads about the tool."""
    names = ", ".join(f"tools.{name}" for name in allowed)
    return (
        "Run a Python script that calls your tools itself. Use it when a task takes many tool "
        "calls whose results you do not need to read one by one: look at several tables and "
        "combine them, fetch a list of pages and take one fact from each, page through search "
        "results. For one or two calls, call the tools directly instead. "
        "Inside the script, `tools.<name>(...)` calls that tool with the same arguments it "
        "takes as a tool, given as keyword arguments (one bare argument is taken as the tool's "
        "main one, e.g. `tools.web_fetch(url)`), and returns its answer as text (with "
        "`.data` holding rows or objects when the tool returns structured data). A failed call "
        "raises `ToolError`; catch it to carry on. `tools.parallel([(name, {args}), ...])` makes "
        "independent calls at once and returns their results in order, None for a failed one. "
        f"A script can call: {names}. "
        "Only what the script prints comes back to you, so print conclusions, not raw results. "
        "The script runs in your workspace like the `python` tool (pandas and the like are "
        "there). It is run again from the top after each tool call, with earlier calls answered "
        "from memory: write files, and do anything that must happen only once, after the last "
        "tool call, and keep the order of calls independent of the clock and of randomness."
    )
