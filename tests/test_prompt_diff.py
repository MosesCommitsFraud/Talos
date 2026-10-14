"""`[prompt-diff]` must point at the first piece that changed between prompts."""

import logging

import pytest

from src import prompt_diff


@pytest.fixture(autouse=True)
def _fresh():
    prompt_diff._recent.clear()
    yield
    prompt_diff._recent.clear()


SYS = {"role": "system", "content": "You are Talos."}
TOOLS = [{"type": "function", "function": {"name": "search"}}]


def _last(caplog):
    return [r.getMessage() for r in caplog.records if "[prompt-diff]" in r.getMessage()][-1]


def test_first_prompt(caplog):
    caplog.set_level(logging.INFO, logger="src.prompt_diff")
    prompt_diff.record("u", "m", [SYS, {"role": "user", "content": "a"}], TOOLS)
    assert "first prompt since Talos start" in _last(caplog)


def test_follow_up_extends_previous(caplog):
    caplog.set_level(logging.INFO, logger="src.prompt_diff")
    turn1 = [SYS, {"role": "user", "content": "a"}]
    prompt_diff.record("u", "m", turn1, TOOLS)
    prompt_diff.record(
        "u",
        "m",
        turn1 + [{"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}],
        TOOLS,
    )
    assert "no difference before the shorter one ends" in _last(caplog)


def test_changed_system_prompt_is_named(caplog):
    caplog.set_level(logging.INFO, logger="src.prompt_diff")
    prompt_diff.record("u", "m", [SYS, {"role": "user", "content": "a"}], TOOLS)
    prompt_diff.record(
        "u",
        "m",
        [{"role": "system", "content": "You are Talos!"}, {"role": "user", "content": "a"}],
        TOOLS,
    )
    assert "first difference in system" in _last(caplog)


def test_changed_tools_and_template_kwargs_are_named(caplog):
    caplog.set_level(logging.INFO, logger="src.prompt_diff")
    msgs = [SYS, {"role": "user", "content": "a"}]
    prompt_diff.record("u", "m", msgs, TOOLS, {"reasoning_effort": "medium"})
    prompt_diff.record("u", "m", msgs, TOOLS + TOOLS, {"reasoning_effort": "medium"})
    assert "first difference in tools" in _last(caplog)
    prompt_diff.record("u", "m", msgs, TOOLS, {"reasoning_effort": "low"})
    assert "first difference in template kwargs" in _last(caplog)


def test_best_match_wins_and_models_are_separate(caplog):
    caplog.set_level(logging.INFO, logger="src.prompt_diff")
    chat_a = [SYS, {"role": "user", "content": "chat A " * 50}]
    chat_b = [SYS, {"role": "user", "content": "chat B"}]
    prompt_diff.record("u", "m", chat_a, TOOLS)
    prompt_diff.record("u", "m", chat_b, TOOLS)
    prompt_diff.record("u", "m", chat_a + [{"role": "user", "content": "more"}], TOOLS)
    assert "no difference" in _last(caplog)
    prompt_diff.record("u", "other-model", chat_a, TOOLS)
    assert "first prompt since Talos start" in _last(caplog)
