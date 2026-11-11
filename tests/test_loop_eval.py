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


def test_a_variant_is_parsed_from_the_command_line():
    assert loop_eval.parse_variant("x:agent_prompt_style=classic,loop.reasoning=false,n=3") == (
        "x",
        {"agent_prompt_style": "classic", "loop.reasoning": False, "n": 3},
    )
    with pytest.raises(SystemExit):
        loop_eval.parse_variant("nur-ein-name")
