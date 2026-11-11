"""view_image: the model looks at an image it made, through the vision model."""

import base64
import json
import os

import pytest

from src import agent_loop, agent_runs, sandbox_client, tool_execution
from src.agent_tools import TOOL_TAGS, ToolBlock
from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n not really a picture").decode()


def test_the_tool_is_registered_everywhere_a_tool_lives():
    assert "view_image" in TOOL_TAGS
    assert "view_image" in agent_loop.TOOL_SECTIONS
    assert "view_image" in ALWAYS_AVAILABLE and "view_image" in BUILTIN_TOOL_DESCRIPTIONS
    schema = next(s for s in FUNCTION_TOOL_SCHEMAS if s["function"]["name"] == "view_image")
    assert schema["function"]["parameters"]["required"] == ["path"]
    # It says what it is for and what shows an image to the user instead.
    assert "`show_image`" in schema["function"]["description"]


@pytest.fixture
def world(monkeypatch):
    """A sandbox holding one image and a vision model that answers."""
    seen = {}

    async def read_image(owner, session_id, operation, payload):
        seen["read"] = (operation, payload)
        return seen.get("file") or {
            "name": "chart.png",
            "data_url": f"data:image/png;base64,{PNG}",
            "exit_code": 0,
        }

    def analyze(image_path, prompt="", owner=None):
        seen["prompt"] = prompt
        seen["path"] = image_path
        seen["bytes"] = open(image_path, "rb").read()
        return seen.get("answer") or {
            "text": "A bar chart; the x labels overlap.",
            "model": "vl-1",
        }

    monkeypatch.setattr(sandbox_client, "sandbox_enabled", lambda: True)
    monkeypatch.setattr(sandbox_client, "file_tool_in_sandbox", read_image)
    monkeypatch.setattr("src.document_processor.analyze_image_with_vl_result", analyze)
    monkeypatch.setattr(tool_execution, "view_image_available", lambda owner: True)
    return seen


async def _view(**args):
    return await tool_execution.execute_tool_block(
        ToolBlock("view_image", json.dumps(args)), session_id="s1", owner=None
    )


async def test_the_vision_model_answers_the_models_question_about_the_file(world):
    _, result = await _view(path="chart.png", question="Are the axis labels readable?")

    assert result["exit_code"] == 0
    assert result["output"] == (
        "chart.png, as the vision model sees it:\nA bar chart; the x labels overlap."
    )
    assert world["read"] == ("image", {"path": "chart.png"})
    assert "Are the axis labels readable?" in world["prompt"]
    # It was given the file's bytes, and the copy is gone afterwards.
    assert world["bytes"].startswith(b"\x89PNG") and world["path"].endswith(".png")
    assert not os.path.exists(world["path"])


async def test_without_a_question_it_asks_for_a_description(world):
    await _view(path="chart.png")
    assert "point out anything that looks wrong" in world["prompt"]


async def test_what_cannot_be_looked_at_is_an_error_the_model_can_act_on(world):
    world["file"] = {
        "name": "logo.svg",
        "data_url": "data:image/svg+xml;base64,PHN2Zy8+",
        "exit_code": 0,
    }
    _, result = await _view(path="logo.svg")
    assert result["exit_code"] == 1 and "PNG or JPEG" in result["error"]
    assert "prompt" not in world  # the vision model was not asked

    world["file"] = {"error": "File not found: nope.png", "exit_code": 1}
    _, result = await _view(path="nope.png")
    assert result == {"error": "File not found: nope.png", "exit_code": 1}

    _, result = await _view(question="What is it?")
    assert result["exit_code"] == 1 and "path is required" in result["error"]


async def test_a_vision_model_that_does_not_answer_is_reported_not_passed_on(world):
    world["answer"] = {"text": "[VL model unavailable - image not analyzed]", "model": ""}
    _, result = await _view(path="chart.png")
    assert result == {
        "error": "view_image: VL model unavailable - image not analyzed",
        "exit_code": 1,
    }


# ── offered only when it can work ────────────────────────────────────────────


def test_it_needs_vision_switched_on_and_a_vision_model(monkeypatch):
    from src import settings

    def stored(**values):
        monkeypatch.setattr(
            settings, "get_user_setting", lambda key, owner, default=None: values.get(key, default)
        )
        monkeypatch.setattr(
            settings, "get_setting", lambda key, default=None: values.get(key, default)
        )

    stored()
    assert not tool_execution.view_image_available(None)
    stored(vision_model="vl-1")
    assert tool_execution.view_image_available(None)
    stored(vision_model="vl-1", vision_enabled=False)
    assert not tool_execution.view_image_available(None)


@pytest.mark.parametrize("available", [False, True])
async def test_a_turn_lists_the_tool_only_when_it_is_available(monkeypatch, available):
    agent_runs._RUNS.clear()
    captured = {}

    async def fake_stream(candidates, messages, **kwargs):
        captured["tools"] = {t["function"]["name"] for t in kwargs.get("tools") or []}
        yield f"data: {json.dumps({'delta': 'ok'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(tool_execution, "view_image_available", lambda owner: available)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")
    messages = [{"role": "system", "content": "p"}, {"role": "user", "content": "Hallo"}]
    async for _ in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1", "qwen3-llm", messages, max_rounds=1
    ):
        pass
    agent_runs._RUNS.clear()

    assert ("view_image" in captured["tools"]) is available
    assert "show_image" in captured["tools"]
