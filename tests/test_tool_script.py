"""Tool scripts: a Python program the model writes calls tools in a loop, the
app carries the calls out, and only what the program prints comes back.

The scripts here really run, in a local Python process: that is the part that
has to be right, and it is the same program the sandbox would run.
"""

import asyncio
import json
import os
import sys

import pytest

from src import tool_execution, tool_script
from src.tool_script import run_script

ALLOWED = ["query_sql", "web_fetch", "search_knowledge"]


class Harness:
    """Runs the script locally and answers its tool calls from a function."""

    def __init__(self, tmp_path, answer):
        self.dir = str(tmp_path)
        self.answer = answer
        self.calls = []
        self.runs = 0
        self.active = 0
        self.max_active = 0

    async def run_python(self, source):
        self.runs += 1
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-c",
            source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.dir,
        )
        out, err = await proc.communicate()
        return out.decode("utf-8"), err.decode("utf-8"), proc.returncode or 0

    async def write_file(self, path, text):
        target = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text)

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.02)
        self.active -= 1
        return self.answer(name, args)

    async def run(self, code, allowed=ALLOWED, max_calls=50):
        return await run_script(
            code,
            allowed=allowed,
            run_python=self.run_python,
            write_file=self.write_file,
            call_tool=self.call_tool,
            max_calls=max_calls,
        )


@pytest.fixture
def harness(tmp_path):
    def make(answer):
        return Harness(tmp_path, answer)

    return make


async def test_a_loop_of_calls_returns_only_what_the_script_prints(harness):
    def answer(name, args):
        month = int(args["query"].split("=")[1])
        return True, f"SECRET RAW ROWS FOR MONTH {month} " * 50, [{"betrag": 100 * month}]

    h = harness(answer)
    result = await h.run(
        "total = 0\n"
        "for month in (1, 2, 3):\n"
        "    rows = tools.query_sql(action='query', query=f'monat={month}')\n"
        "    total += rows.data[0]['betrag']\n"
        "print('Summe Q1:', total)\n"
    )

    assert result["exit_code"] == 0
    assert result["output"].startswith("Summe Q1: 600")
    # The raw results never reach the model.
    assert "SECRET RAW ROWS" not in result["output"]
    assert "[The script made 3 tool call(s): query_sql ×3.]" in result["output"]
    # Each call is carried out once, however often the script was run to get there.
    assert [c[1]["query"] for c in h.calls] == ["monat=1", "monat=2", "monat=3"]
    assert h.runs == 4
    assert result["script_calls"] == [{"tool": "query_sql", "ok": True}] * 3


async def test_output_printed_before_a_call_appears_once(harness):
    h = harness(lambda name, args: (True, "ok", None))
    result = await h.run("print('start')\ntools.web_fetch(url='https://a.test')\nprint('ende')\n")
    assert result["output"].count("start") == 1
    assert result["output"].startswith("start\nende")


async def test_a_failed_call_raises_and_the_script_can_carry_on(harness):
    def answer(name, args):
        if args["url"].endswith("/b"):
            return False, "HTTP 404", None
        return True, "Seite " + args["url"], None

    h = harness(answer)
    result = await h.run(
        "for u in ('https://x.test/a', 'https://x.test/b'):\n"
        "    try:\n"
        "        print(tools.web_fetch(url=u))\n"
        "    except ToolError as e:\n"
        "        print('fehlgeschlagen:', e)\n"
    )
    assert "Seite https://x.test/a" in result["output"]
    assert "fehlgeschlagen: HTTP 404" in result["output"]
    assert "2 tool call(s): web_fetch ×2, 1 failed" in result["output"]


async def test_parallel_calls_run_together_and_keep_their_order(harness):
    def answer(name, args):
        n = int(args["url"][-1])
        return (n != 3), f"seite {n}", None

    h = harness(answer)
    result = await h.run(
        "urls = [f'https://x.test/{i}' for i in range(1, 6)]\n"
        "pages = tools.parallel([('web_fetch', {'url': u}) for u in urls])\n"
        "print([p if p is None else str(p) for p in pages])\n"
    )
    assert "['seite 1', 'seite 2', None, 'seite 4', 'seite 5']" in result["output"]
    assert len(h.calls) == 5
    assert h.runs == 2  # one batch, then the run that finishes
    assert 1 < h.max_active <= tool_script.PARALLEL_LIMIT


async def test_an_endless_loop_is_stopped_at_the_call_limit(harness):
    h = harness(lambda name, args: (True, "more", None))
    result = await h.run(
        "n = 0\nwhile True:\n    n += 1\n    tools.search_knowledge(query=f'q{n}')\n", max_calls=5
    )
    assert result["exit_code"] == 1
    assert "limit of 5 tool calls" in result["error"] and "endless loop" in result["error"]
    assert len(h.calls) == 5


async def test_a_script_that_takes_a_different_path_on_its_next_run_is_told_why(harness):
    h = harness(lambda name, args: (True, "ok", None))
    result = await h.run(
        "import random\n"
        "tools.search_knowledge(query=str(random.random()))\n"
        "tools.search_knowledge(query='zwei')\n"
    )
    assert result["exit_code"] == 1
    assert "different path" in result["error"] and "same way every time" in result["error"]


async def test_an_error_in_the_script_shows_its_traceback_with_script_line_numbers(harness):
    h = harness(lambda name, args: (True, "ok", None))
    result = await h.run("x = 1\nprint('vorher')\nraise ValueError('kaputt')\n")
    assert result["exit_code"] == 1
    assert "vorher" in result["output"]
    assert 'File "<script>", line 3' in result["output"]
    assert "ValueError: kaputt" in result["output"]


async def test_one_bare_argument_is_the_tools_main_one(harness):
    """`tools.web_fetch(url)` is what a model writes about as often as the
    keyword form; refusing it cost a failed script and another round."""
    h = harness(lambda name, args: (True, "ok", None))
    result = await h.run(
        "tools.web_fetch('https://a.test')\n"
        "tools.web_fetch('https://b.test', max_chars=20000)\n"
        "tools.query_sql('select 1')\n"
        "tools.search_knowledge('Urlaub', k=3)\n"
        "print('fertig')\n"
    )
    assert result["exit_code"] == 0 and result["output"].startswith("fertig")
    assert h.calls == [
        ("web_fetch", {"url": "https://a.test"}),
        ("web_fetch", {"max_chars": 20000, "url": "https://b.test"}),
        ("query_sql", {"action": "query", "query": "select 1"}),
        ("search_knowledge", {"k": 3, "query": "Urlaub"}),
    ]
    # Given twice, it is not guessed at.
    twice = await h.run("tools.web_fetch('https://a.test', url='https://b.test')\n")
    assert "keyword arguments" in twice["output"]


async def test_a_script_may_import_the_tools(harness):
    """A script that began with `import tools` ended in ModuleNotFoundError."""
    h = harness(
        lambda name, args: (name == "web_fetch", "ok" if name == "web_fetch" else "leer", None)
    )
    result = await h.run(
        "import tools\n"
        "from tools import web_fetch, ToolError\n"
        "print(tools.web_fetch(url='https://a.test'), web_fetch(url='https://b.test'))\n"
        "try:\n    tools.query_sql('select 1')\nexcept ToolError as e:\n    print('Fehler:', e)\n"
    )
    assert result["exit_code"] == 0 and result["output"].startswith("ok ok\nFehler: leer")
    assert [args.get("url") for _, args in h.calls] == ["https://a.test", "https://b.test", None]


def test_every_tool_a_script_can_call_has_a_main_argument_that_exists():
    # agent_tools first: it loads the schemas in the right order.
    from src import agent_tools, tool_script  # noqa: F401
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    schemas = {s["function"]["name"]: s["function"]["parameters"] for s in FUNCTION_TOOL_SCHEMAS}
    assert set(tool_script.POSITIONAL) == set(tool_script.SCRIPT_TOOLS)
    for name, (first, extra) in tool_script.POSITIONAL.items():
        assert {first, *extra} <= set(schemas[name]["properties"]), name
        assert set(schemas[name].get("required") or []) <= {first, *extra}, name


async def test_only_the_listed_tools_can_be_called_and_arguments_are_keywords(harness):
    h = harness(lambda name, args: (True, "ok", None))
    unknown = await h.run("tools.bash(command='rm -rf /')\n")
    assert "unknown tool 'bash'" in unknown["output"] and "query_sql" in unknown["output"]
    assert h.calls == []

    assert "unknown tool 'bash'" in (await h.run("tools.bash('ls')\n"))["output"]

    two = await h.run("tools.web_fetch('https://a.test', 2000)\n")
    assert "keyword arguments, e.g. tools.web_fetch(url=...)" in two["output"]
    assert h.calls == []

    # A single dict is accepted as the arguments, since that is how tool calls look.
    as_dict = await h.run("print(tools.web_fetch({'url': 'https://a.test'}))\n")
    assert as_dict["exit_code"] == 0 and h.calls[-1] == ("web_fetch", {"url": "https://a.test"})


async def test_without_code_or_without_tools_there_is_nothing_to_run(harness):
    h = harness(lambda name, args: (True, "ok", None))
    assert "`code` is required" in (await h.run("   "))["error"]
    assert "no tool is available" in (await h.run("print(1)", allowed=[]))["error"]
    assert h.runs == 0


async def test_a_script_without_tool_calls_just_runs(harness):
    h = harness(lambda name, args: (True, "ok", None))
    result = await h.run("print(sum(range(10)))\n")
    assert result["output"].startswith("45") and "made no tool calls" in result["output"]
    assert h.runs == 1


# ── how a tool result looks to a script ──────────────────────────────────────


def test_a_script_sees_plain_text_and_rows():
    widget = {"type": "table", "data": {"columns": ["monat", "betrag"], "rows": [[1, 10], [2, 20]]}}
    ok, text, data = tool_execution._script_view(
        {"output": "2 rows", "exit_code": 0, "widget": widget}
    )
    assert (ok, text) == (True, "2 rows")
    assert data == [{"monat": 1, "betrag": 10}, {"monat": 2, "betrag": 20}]

    assert tool_execution._script_view({"error": "Tool 'web_fetch' is disabled by user."}) == (
        False,
        "Tool 'web_fetch' is disabled by user.",
        None,
    )
    assert tool_execution._script_view({"results": "3 Treffer", "exit_code": 0})[1] == "3 Treffer"


# ── through the tool executor ────────────────────────────────────────────────


async def test_the_executor_runs_a_script_and_routes_its_calls_through_the_tool_gates(
    monkeypatch, tmp_path
):
    from src import sandbox_client
    from src.agent_tools import ToolBlock

    monkeypatch.setattr(sandbox_client, "sandbox_enabled", lambda: False)
    monkeypatch.setattr(tool_execution, "_AGENT_WORKDIR", str(tmp_path))
    seen = []
    real_execute = tool_execution.execute_tool_block

    async def fake_execute(block, **kwargs):
        if block.tool_type == "run_tool_script":
            return await real_execute(block, **kwargs)
        seen.append((block.tool_type, kwargs.get("owner"), kwargs.get("disabled_tools")))
        return "web_search", {"results": f"Treffer für {block.content}", "exit_code": 0}

    monkeypatch.setattr(tool_execution, "execute_tool_block", fake_execute)
    code = "r = tools.web_search(query='talos')\nprint(len(r) > 0)\n"
    desc, result = await real_execute(
        ToolBlock("run_tool_script", json.dumps({"description": "Suche", "code": code})),
        owner="anna",
        disabled_tools={"query_sql"},
    )

    assert desc == "run_tool_script: Suche"
    assert result["exit_code"] == 0 and result["output"].startswith("True")
    # The inner call carries the turn's owner and switches, like any other call.
    assert seen == [("web_search", "anna", {"query_sql"})]


def test_the_tool_is_off_unless_the_setting_is_on(monkeypatch):
    from src import settings

    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default)
    assert tool_script.enabled() is False
    monkeypatch.setattr(
        settings, "get_setting", lambda key, default=None: key == "tool_scripts_enabled" or default
    )
    assert tool_script.enabled() is True


async def test_umlauts_survive_whatever_the_platform_encoding(harness):
    h = harness(lambda name, args: (True, "Größe: 5 €", None))
    result = await h.run("print('Stärkster Monat:', tools.web_fetch(url='https://a.test'))\n")
    assert result["output"].startswith("Stärkster Monat: Größe: 5 €")
