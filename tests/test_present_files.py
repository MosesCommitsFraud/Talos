"""`present_files` — the agent names the turn's deliverable(s) for the UI.

The frontend draws an output card for each path the call carries, live and
after a reload (from the saved tool event), so the executor's only job is to
hand back a clean, de-duplicated list."""

import json

import pytest

from src.agent_loop import TOOL_SECTIONS
from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS


class _Block:
    def __init__(self, tool_type, content):
        self.tool_type = tool_type
        self.content = content


@pytest.mark.asyncio
async def test_paths_are_normalised_and_deduplicated():
    from src.tool_execution import execute_tool_block

    payload = json.dumps({"files": ["./output/dashboard.html", "/workspace/output/dashboard.html", "chart.png"]})
    _desc, result = await execute_tool_block(_Block("present_files", payload), session_id=None)
    assert result["exit_code"] == 0
    assert result["presented_files"] == ["output/dashboard.html", "chart.png"]


@pytest.mark.asyncio
async def test_empty_call_is_an_error_the_model_can_fix():
    from src.tool_execution import execute_tool_block

    _desc, result = await execute_tool_block(_Block("present_files", '{"files": []}'), session_id=None)
    assert result["exit_code"] == 1
    assert "presented_files" not in result


def test_tool_is_described_everywhere_the_model_can_see_it():
    assert "present_files" in TOOL_SECTIONS
    assert "present_files" in BUILTIN_TOOL_DESCRIPTIONS
    assert any(s["function"]["name"] == "present_files" for s in FUNCTION_TOOL_SCHEMAS)
