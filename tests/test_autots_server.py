"""The AutoTS connector: what it refuses, and that a real client gets a forecast."""

import asyncio
import json
import math
import os
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

pytest.importorskip("autots")

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

from mcp_servers import autots_server as server  # noqa: E402

SCRIPT = Path(server.__file__)


def _csv(days=120):
    start = date(2025, 1, 1)
    rows = [
        f"{start + timedelta(days=i)},{100 + 15 * math.sin(2 * math.pi * i / 7):.2f}"
        for i in range(days)
    ]
    return "date,sales\n" + "\n".join(rows)


def _properties():
    return {name for t in server.TOOLS for name in t.inputSchema["properties"]}


def test_only_the_tested_tools_are_offered():
    assert {t.name for t in server.TOOLS} == {"forecast", "plot_forecast"}


def test_nothing_offered_reaches_disk_or_network():
    assert not _properties() & {"url", "filepath", "content_base64", "data", "save_path", "format"}


@pytest.mark.parametrize(
    "name,arguments",
    [
        ("forecast", {"text": "x", "url": "http://169.254.169.254/latest"}),
        ("forecast", {"filepath": "/app/data/settings.json"}),
        ("forecast", {"data": "/app/data/secrets.csv"}),
        ("forecast", {"autots_params": {"n_jobs": 64}}),
        ("plot_forecast", {"prediction_id": "x", "save_path": "/tmp/x.png"}),
        ("load_data_from_file", {"filepath": "/etc/passwd"}),
        ("list_cache", {}),
        ("clear_cache", {}),
    ],
)
def test_refuses_what_the_schema_does_not_offer(name, arguments):
    with pytest.raises(ValueError):
        server.check_arguments(name, arguments)


def test_refuses_text_over_the_limit():
    with pytest.raises(ValueError):
        server.check_arguments("forecast", {"text": "x" * (server.MAX_TEXT_CHARS + 1)})


def test_search_params_stay_within_the_presets():
    params = server.search_params({"quality": "quick", "n_jobs": 64, "max_generations": 999})
    assert params["n_jobs"] == server.N_JOBS
    assert params["max_generations"] == server.QUALITY["quick"]["max_generations"]
    with pytest.raises(ValueError):
        server.search_params({"quality": "forever"})


def test_forecast_length_fits_the_history():
    assert server.forecast_length({}, 12) == 3
    assert server.forecast_length({}, 400) == 30
    assert server.forecast_length({}, 2) == 1
    assert server.forecast_length({"forecast_length": 12}, 12) == 12
    with pytest.raises(ValueError, match="12 periods"):
        server.forecast_length({"forecast_length": 30}, 12)


def test_sampling_error_runs_the_search_again_without_generations(monkeypatch):
    """AutoTS 1.0.4 under pandas 3 fails this way on short series with thorough."""
    fits = []

    async def fit(data_id, length, params):
        fits.append(dict(params))
        if params["max_generations"]:
            raise ValueError("Weighted sampling cannot be achieved with replace=False.")
        return {"prediction_id": "p1"}

    async def run_tool(name, arguments):
        return {"model_name": "FFT"} if name == "get_model_params" else {"y": [1.0]}

    monkeypatch.setattr(server, "_fit", fit)
    monkeypatch.setattr(server, "run_tool", run_tool)
    monkeypatch.setattr(server, "history_length", lambda data_id: 12)
    out = asyncio.run(server._forecast({"data_id": "d1", "quality": "thorough"}))
    assert [f["max_generations"] for f in fits] == [4, 0]
    assert out["forecast_length"] == 3
    assert out["note"]
    assert out["model"] == "FFT"


async def _in_client(body):
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(SCRIPT)],
        env={**os.environ, "PYTHONPATH": str(SCRIPT.parent.parent)},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await body(session)


def _text(result):
    return "\n".join(c.text for c in result.content if hasattr(c, "text"))


def test_stray_output_stays_off_the_protocol_channel():
    """AutoTS prints while fitting, some of it from native code."""
    code = (
        "import os, sys\n"
        f"sys.path.insert(0, {str(SCRIPT.parent.parent)!r})\n"
        "from mcp_servers import autots_server as s\n"
        "s._protocol_stdout()\n"
        "print('from python')\n"
        "os.write(1, b'from native code')\n"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=120)
    assert done.returncode == 0, done.stderr[-500:]
    assert done.stdout == b""
    assert b"from python" in done.stderr
    assert b"from native code" in done.stderr


def test_forecast_and_plot_through_a_real_client():
    async def body(session):
        res = await session.call_tool("forecast", {"text": _csv(), "forecast_length": 7})
        assert not res.isError, _text(res)
        out = json.loads(_text(res))
        assert len(out["forecast"]["sales"]) == 7
        assert len(out["upper_forecast"]["sales"]) == 7
        assert out["model"]
        assert out["data_report"]["series_count"] == 1

        again = await session.call_tool(
            "forecast", {"data_id": out["data_id"], "forecast_length": 3}
        )
        assert not again.isError, _text(again)
        assert len(json.loads(_text(again))["forecast"]["sales"]) == 3

        short = await session.call_tool("forecast", {"text": _csv(days=12)})
        assert not short.isError, _text(short)
        assert json.loads(_text(short))["forecast_length"] == 3

        plot = await session.call_tool("plot_forecast", {"prediction_id": out["prediction_id"]})
        assert not plot.isError
        assert plot.content[0].type == "image"

    asyncio.run(_in_client(body))
