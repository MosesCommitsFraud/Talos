"""scripts/loop_eval.py: the harness of the loop eval, driven by a scripted
model so it needs no endpoint. What a real model does with the tasks is the
eval's business, not this test's."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src import agent_loop, agent_runs, settings

_spec = importlib.util.spec_from_file_location(
    "loop_eval", Path(__file__).resolve().parent.parent / "scripts" / "loop_eval.py"
)
loop_eval = importlib.util.module_from_spec(_spec)
import sys  # noqa: E402

sys.modules["loop_eval"] = loop_eval
_spec.loader.exec_module(loop_eval)

OPTS = SimpleNamespace(
    url="http://vllm.test:8000/v1",
    model="qwen3-llm",
    headers=None,
    temperature=0.6,
    context_length=262144,
    reasoning=False,
    timeout=30,
    repeats=1,
)
TASK = {t.key: t for t in loop_eval.TASKS}


@pytest.fixture
def model(monkeypatch):
    """Answer each model call with the next scripted round."""
    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    def script(*rounds):
        calls = []

        async def fake_stream(candidates, messages, **kwargs):
            calls.append(json.loads(json.dumps(messages, default=str)))
            for payload in rounds[min(len(calls), len(rounds)) - 1]:
                yield f"data: {json.dumps(payload)}\n\n"
            yield "data: [DONE]\n\n"

        monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
        return calls

    yield script
    agent_runs._RUNS.clear()


def _call(name, **args):
    return {
        "type": "tool_calls",
        "calls": [{"id": name, "name": name, "arguments": json.dumps(args)}],
    }


def test_the_tasks_are_complete():
    keys = [t.key for t in loop_eval.TASKS]
    assert len(keys) == len(set(keys)) >= 8
    for task in loop_eval.TASKS:
        assert task.prompt and task.about and callable(task.check)


async def test_a_turn_is_run_through_the_real_loop_and_scored(model):
    requests = model(
        [_call("python", code="print(17 * 349.90 * 1.045)")],
        [{"delta": "Die Gesamtsumme beträgt 6.215,97 Euro."}],
    )
    run = await loop_eval.run_task(TASK["rechnen"], "lean", {}, OPTS)

    assert run.passed, run.problems or run.error
    assert run.model_calls == len(requests) == 2
    assert run.tools == ["python"] and run.calls[0].ok and run.calls[0].round == 1
    # The scripted result reached the model.
    assert "6215.9735" in json.dumps(requests[1])
    # The loop's own executor and model stream are back in place.
    assert agent_loop.execute_tool_block is not None
    assert run.summary()["tool_calls"] == 1


async def test_a_turn_that_misses_the_task_says_why(model):
    model([{"delta": "Das sind ungefähr 6.000 Euro."}])
    run = await loop_eval.run_task(TASK["rechnen"], "lean", {}, OPTS)
    assert not run.passed
    assert run.problems == ["answer does not contain 6.215,97"]


async def test_a_tool_the_task_has_no_result_for_is_unavailable_and_counted(model):
    requests = model(
        [_call("web_search", query="Deckungsbeitrag")],
        [{"delta": "Der Deckungsbeitrag I ist der Umsatz abzüglich der variablen Kosten. " * 4}],
    )
    run = await loop_eval.run_task(TASK["wissen"], "lean", {}, OPTS)

    assert [(c.tool, c.ok, c.scripted) for c in run.calls] == [("web_search", False, False)]
    assert "not available in this session" in json.dumps(requests[1])
    assert run.summary()["unexpected_tools"] == ["web_search"]
    assert not run.passed  # the task is to answer without tools


async def test_a_fixture_can_fail_and_then_succeed(model):
    model(
        [_call("read_file", path="daten/umsatz.csv")],
        [_call("glob", pattern="**/*.csv")],
        [_call("read_file", path="data/umsatz.csv")],
        [{"delta": "Die Summe der Spalte umsatz ist 533."}],
    )
    run = await loop_eval.run_task(TASK["fehler"], "lean", {}, OPTS)
    assert [(c.tool, c.ok) for c in run.calls] == [
        ("read_file", False),
        ("glob", True),
        ("read_file", True),
    ]
    assert run.passed, run.problems


async def test_ask_user_runs_for_real_and_ends_the_turn(model):
    requests = model(
        [_call("ask_user", question="Wofür soll die Auswertung sein?")],
        [{"delta": "sollte nie gefragt werden"}],
    )
    run = await loop_eval.run_task(TASK["unklar"], "lean", {}, OPTS)
    assert len(requests) == 1 and run.tools == ["ask_user"]
    assert run.passed, run.problems


def test_settings_are_overridden_for_the_run_only():
    before = settings.get_setting("agent_prompt_style")
    with loop_eval.settings_override({"agent_prompt_style": "classic"}):
        assert settings.get_setting("agent_prompt_style") == "classic"
        from src import prompt_style

        assert prompt_style.prompt_style() == "classic"
    assert settings.get_setting("agent_prompt_style") == before


async def test_every_variant_runs_every_task_with_its_own_settings(model, monkeypatch):
    seen = []

    async def fake_stream(candidates, messages, **kwargs):
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        seen.append("lean" if "## Working with tools" in system else "classic")
        yield f"data: {json.dumps({'delta': 'Antwort.'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    runs = await loop_eval.run_all(
        [TASK["wissen"], TASK["rechnen"]], loop_eval.COMPARISONS["prompt"], OPTS
    )
    assert [(r.task, r.variant) for r in runs] == [
        ("wissen", "lean"),
        ("wissen", "classic"),
        ("rechnen", "lean"),
        ("rechnen", "classic"),
    ]
    assert seen == ["lean", "classic", "lean", "classic"]

    text = loop_eval.report(runs, ["lean", "classic"], [TASK["wissen"], TASK["rechnen"]])
    assert "| Tasks passed | 0/2 | 0/2 |" in text
    assert "lean / rechnen: answer does not contain 6.215,97" in text


@pytest.fixture
def endpoint(monkeypatch):
    """A model endpoint that is away until told otherwise."""
    state = {"down": True, "pauses": []}

    async def fake_stream(candidates, messages, **kwargs):
        if state["down"]:
            error = {"error": "Cannot reach http://vllm.test:8000", "status": 503}
            yield f"event: error\ndata: {json.dumps(error)}\n\n"
            return
        yield f"data: {json.dumps({'delta': 'Die Gesamtsumme beträgt 6.215,97 Euro.'})}\n\n"
        yield "data: [DONE]\n\n"

    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    yield state
    agent_runs._RUNS.clear()


async def test_a_turn_the_endpoint_dropped_out_of_is_run_again(endpoint, monkeypatch):
    async def pause(seconds):
        endpoint["pauses"].append(seconds)
        endpoint["down"] = False  # it is back after the first wait

    monkeypatch.setattr(loop_eval, "_pause", pause)
    shown = []
    runs = await loop_eval.run_all(
        [TASK["rechnen"]], [("lean", {"agent_prompt_style": "lean"})], OPTS, on_run=shown.append
    )
    # Only the turn that ran is in the numbers.
    assert endpoint["pauses"] == [loop_eval.RECONNECT_WAITS[0]]
    assert len(runs) == 1 and shown == runs
    assert not runs[0].error and not runs[0].unreachable


async def test_an_endpoint_that_stays_away_ends_the_run(endpoint, monkeypatch):
    async def pause(seconds):
        endpoint["pauses"].append(seconds)

    monkeypatch.setattr(loop_eval, "_pause", pause)
    shown = []
    with pytest.raises(loop_eval.ModelGone, match="Cannot reach"):
        await loop_eval.run_all(
            [TASK["rechnen"]], [("lean", {"agent_prompt_style": "lean"})], OPTS, on_run=shown.append
        )
    assert endpoint["pauses"] == list(loop_eval.RECONNECT_WAITS)
    assert shown == []  # no turn was counted as the model's failure


def test_a_fetched_page_is_a_numbered_source_and_counts_as_a_lookup():
    from src import citations

    run = loop_eval.Run("recherche", "v")
    page = loop_eval._web_fetch(
        '{"url": "https://www.postgresql.org/docs/17/release-17.html"}', run
    )
    # The number it has as a search result, and the rule that says to cite it.
    assert page.startswith("[4] Fetched: https://www.postgresql.org/docs/17/release-17.html\n")
    assert "JSON_TABLE" in page and page.endswith(citations.CITATION_RULE)
    other = loop_eval._web_fetch(
        '{"url": "https://docs.python.org/3.13/whatsnew/changelog.html"}', run
    )
    assert other.startswith("[5] Fetched:")
    with pytest.raises(loop_eval.Fail):
        loop_eval._web_fetch('{"url": "https://example.org/"}', run)

    run.texts = ["", "Python 3.13 [1] und PostgreSQL 17 [4]."]
    run.calls = [loop_eval.Call(1, "web_fetch", "", True, True) for _ in range(2)]
    assert loop_eval._check_recherche(run) == []
    run.calls[1].round = 2
    assert loop_eval._check_recherche(run) == ["the two lookups were not sent in the same response"]


def test_the_database_answers_what_the_query_asks_for():
    october = "from dbo.orders where order_date >= '2026-10-01'"
    ask = loop_eval._sql_query
    assert ask(f"select count(*) as bestellungen {october}") == "bestellungen\n1284\n(1 row)"
    assert ask(f"select count(*) as n, sum(total) as summe {october}") == (
        "n,summe\n1284,187432.50\n(1 row)"
    )
    by_status = ask(f"select status, count(*) as cnt {october} group by status")
    assert by_status.startswith("status,cnt\n") and "shipped,1102" in by_status
    assert sum(n for _, n in loop_eval.SQL_STATUS) == 1284
    assert ask(f"select count(*) {october} and status = 'cancelled'") == "anzahl\n51\n(1 row)"
    per = ask(
        "select count(*) filter (where status = 'pending') as pending, "
        f"count(*) filter (where status = 'shipped') as shipped {october}"
    )
    assert per == "pending,shipped\n131,1102\n(1 row)"
    # A sum over a status is not the sum of the totals.
    mixed = ask(
        "select count(*) as total, sum(case when status = 'cancelled' then 1 else 0 end) "
        f"as cancelled, round(sum(total),2) as revenue {october}"
    )
    assert mixed == "total,cancelled,revenue\n1284,51,187432.50\n(1 row)"
    assert "rows shown" in ask(f"select * {october}")
    with pytest.raises(loop_eval.Fail):
        ask("select count(*) from dbo.invoices")


def test_a_variant_is_parsed_from_the_command_line():
    assert loop_eval.parse_variant("x:agent_prompt_style=classic,loop.reasoning=false,n=3") == (
        "x",
        {"agent_prompt_style": "classic", "loop.reasoning": False, "n": 3},
    )
    with pytest.raises(SystemExit):
        loop_eval.parse_variant("nur-ein-name")
