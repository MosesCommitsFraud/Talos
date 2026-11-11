"""What the model is given at the start of a turn, kept as files.

The system prompt and the tool list decide how a model behaves, and a change to
either is easy to make without noticing: a rule added to a description, a tool
that moves into the list. The files under tests/snapshots/ hold both as a
default installation sends them, so every such change shows up as a diff in
review, next to the code that caused it.

When a change is intended, write the files anew and commit them with it:

    TALOS_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_prompt_snapshot.py
"""

import json
import os
from pathlib import Path

import pytest

from src import agent_loop, agent_runs, prompt_style, settings
from src.prompt_security import UNTRUSTED_CONTEXT_POLICY, system_policy

SNAPSHOTS = Path(__file__).parent / "snapshots"
UPDATE = os.environ.get("TALOS_UPDATE_SNAPSHOTS") == "1"


@pytest.fixture
def first_request(monkeypatch):
    """The first request of a turn on a default installation, per style."""
    agent_runs._RUNS.clear()
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    captured = {}

    async def fake_stream(candidates, messages, **kwargs):
        captured["system"] = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        captured["tools"] = kwargs.get("tools") or []
        yield f"data: {json.dumps({'delta': 'ok'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)

    async def run(style):
        # Shipped defaults, whatever this machine has stored.
        defaults = {**settings.DEFAULT_SETTINGS, "agent_prompt_style": style}
        monkeypatch.setattr(settings, "load_settings", lambda: dict(defaults))
        monkeypatch.setattr(prompt_style, "prompt_style", lambda: style)
        monkeypatch.setattr(agent_loop, "_cached_base_prompt", None)
        messages = [
            {"role": "system", "content": system_policy()},
            {"role": "system", "content": UNTRUSTED_CONTEXT_POLICY},
            {"role": "user", "content": "Hallo"},
        ]
        async for _ in agent_loop.stream_agent_loop(
            "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=1, context_length=262144
        ):
            pass
        return captured

    yield run
    agent_runs._RUNS.clear()


def _compare(name: str, text: str) -> None:
    path = SNAPSHOTS / name
    text = text.rstrip("\n") + "\n"
    if UPDATE:
        SNAPSHOTS.mkdir(exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        return
    assert path.exists(), f"{path} is missing; see this file's docstring"
    stored = path.read_text(encoding="utf-8")
    assert text == stored, (
        f"{name} no longer matches what a turn sends. If the change is intended, "
        "update the snapshots (see this file's docstring) and commit them."
    )


@pytest.mark.parametrize("style", ["lean", "classic"])
async def test_the_system_prompt_is_the_recorded_one(first_request, style):
    sent = await first_request(style)
    _compare(f"system_prompt.{style}.md", sent["system"])


async def test_the_tool_list_is_the_recorded_one(first_request):
    sent = await first_request("lean")
    tools = [
        {
            "name": t["function"]["name"],
            "description": t["function"].get("description", ""),
            "parameters": t["function"].get("parameters", {}),
        }
        for t in sent["tools"]
    ]
    _compare("tools.lean.json", json.dumps(tools, ensure_ascii=False, indent=1))
