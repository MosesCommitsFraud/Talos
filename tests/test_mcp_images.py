"""An image from an MCP tool (AutoTS plot, browser screenshot) goes to the chat,
and the model gets a note instead of the base64."""

import asyncio
from types import SimpleNamespace

from src.mcp_manager import McpManager
from src.tool_execution import format_tool_result

PNG = "iVBORw0KGgo" + "A" * 20_000


class _Session:
    async def call_tool(self, name, arguments):
        return SimpleNamespace(
            content=[SimpleNamespace(type="image", data=PNG, mimeType="image/png")],
            isError=False,
        )


def test_image_reaches_the_chat_and_the_model_gets_a_note():
    result = asyncio.run(McpManager()._do_call(_Session(), "plot_forecast", {}))
    assert result["images"] == [{"data": PNG, "mimeType": "image/png"}]
    assert "shown to the user" in result["stdout"]
    assert PNG not in result["stdout"]


def test_image_data_is_not_echoed_into_model_context():
    """Echoed as JSON it arrived cut off at 8000 characters, and the model tried
    to decode it and redrew the chart itself."""
    text = format_tool_result(
        "mcp: mcp__autots__plot_forecast",
        {
            "stdout": "[Image (image/png) shown to the user in the chat]",
            "stderr": "",
            "exit_code": 0,
            "images": [{"data": PNG, "mimeType": "image/png"}],
        },
    )
    assert "shown to the user" in text
    assert "AAAA" not in text
    assert "images" not in text
