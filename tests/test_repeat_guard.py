"""A model repeating one tool call is reminded, not stopped, and two calls only
count as the same when their complete arguments match."""

import json

import pytest

from src import agent_loop, agent_runs
from src.agent_tools import ToolBlock
from src.repeat_guard import GENTLE_REMINDER, RepeatGuard, call_signature


@pytest.fixture(autouse=True)
def clean_runs():
    agent_runs._RUNS.clear()
    yield
    agent_runs._RUNS.clear()


def test_calls_that_share_a_long_beginning_are_different_calls():
    imports = "import pandas as pd\nimport numpy as np\nfrom pathlib import Path\n" * 3
    assert len(imports) > 120
    a = ToolBlock("python", imports + "print(df.head())")
    b = ToolBlock("python", imports + "print(df.describe())")
    assert call_signature(a) != call_signature(b)
    assert call_signature(a) == call_signature(ToolBlock("python", imports + "print(df.head())"))


def test_reminders_come_at_the_third_and_fifth_call_in_a_row():
    guard = RepeatGuard()
    call = ToolBlock("grep", '{"pattern": "TODO"}')
    seen = [guard.observe(call) for _ in range(6)]
    assert seen[0] is None and seen[1] is None
    assert seen[2] == GENTLE_REMINDER
    assert seen[3] is None
    assert "calls in a row: 5" in seen[4] and "tool: grep" in seen[4]
    assert '{"pattern": "TODO"}' in seen[4]
    assert seen[5] is None
    assert guard.reminders_sent == 2


def test_a_different_call_starts_the_count_again():
    guard = RepeatGuard()
    a, b = ToolBlock("grep", "a"), ToolBlock("grep", "b")
    assert [guard.observe(x) for x in (a, a, b, a, a)] == [None] * 5


def test_a_plan_update_in_between_does_not_hide_the_repetition():
    guard = RepeatGuard()
    call, plan = ToolBlock("web_search", "q"), ToolBlock("update_plan", "- [ ] a")
    seen = [guard.observe(x) for x in (call, plan, call, plan, call)]
    assert seen[-1] == GENTLE_REMINDER


def test_a_user_message_ends_the_chain():
    guard = RepeatGuard()
    call = ToolBlock("web_search", "q")
    guard.observe(call)
    guard.observe(call)
    guard.reset()
    assert guard.observe(call) is None


def test_long_arguments_are_quoted_in_part():
    guard = RepeatGuard(thresholds=(2, 3))
    call = ToolBlock("write_file", "x" * 5000)
    guard.observe(call)
    guard.observe(call)
    reminder = guard.observe(call)
    assert len(reminder) < 1200


# ── the loop ─────────────────────────────────────────────────────────────────


def _same_call_model(monkeypatch, repeats):
    requests = []

    async def fake_stream(candidates, messages, **kwargs):
        requests.append(json.loads(json.dumps(messages, default=str)))
        if len(requests) <= repeats:
            call = {
                "id": f"c{len(requests)}",
                "name": "bash",
                "arguments": json.dumps({"command": "cat status.txt"}),
            }
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Fertig.'})}\n\n"
        yield "data: [DONE]\n\n"

    async def fake_execute(block, **kwargs):
        return "bash: ok", {"output": "pending", "exit_code": 0}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_execute)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    return requests


async def test_the_reminder_follows_the_results_and_leaves_the_prompt_prefix_alone(monkeypatch):
    requests = _same_call_model(monkeypatch, repeats=3)
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Status?"}]
    chunks = [
        c
        async for c in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=8
        )
    ]

    assert len(requests) == 4
    third, fourth = requests[2], requests[3]
    # Nothing the server has already seen changes.
    assert fourth[: len(third)] == third
    # The reminder is the last thing before the model's next decision, after
    # the result of the third identical call.
    assert fourth[-1]["content"] == GENTLE_REMINDER
    assert fourth[-2]["role"] == "tool"
    # No reminder after the first two calls.
    assert GENTLE_REMINDER not in json.dumps(third)
    # The call itself ran every time: the reminder is advice, not a block.
    outputs = [
        json.loads(c[6:]) for c in chunks if c.startswith("data: {") and '"tool_output"' in c
    ]
    assert len(outputs) == 3
