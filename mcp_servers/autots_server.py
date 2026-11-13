"""AutoTS time series forecasts as an MCP connector (Customize -> Connectors).

Not the `autots-mcp` server that ships with AutoTS, which does not run as it is:
its tools declare an output schema they never fill, so current MCP versions
reject every result, and it prints to stdout, the protocol's own channel.

This server runs in the app container, not the sandbox, so it offers less on
purpose. Data comes in only as text in the call: no file paths, URLs or live
sources, which would read the app's disk and network past the web guards. CSV
output is left out because it writes files. Nothing lists or clears the cache,
which all users share; a result is reached only by its random id.

Forecasts always run a model search. The upstream `forecast_fast` skips it and was
far off on a daily series of a year (mean error 838 where repeating the last week
gives 3.9). `forecast_explainable` and `detect_features` failed on the same data
with errors from inside AutoTS. `forecast_event_risk` reads a plain threshold as a
quantile, which a model would get wrong. So only these two tools are offered.
"""

import asyncio
import json
import os
import sys

# Set before the imports below read them: this shares the app's CPUs and memory.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("AUTOTS_MCP_CACHE_MAX", "20")

import matplotlib  # noqa: E402

matplotlib.use("Agg")

from autots.mcp.cache import get_cached_object  # noqa: E402
from autots.mcp.core import run_tool  # noqa: E402
from mcp.server import Server  # noqa: E402
from mcp.server.stdio import stdio_server  # noqa: E402
from mcp.types import ImageContent, TextContent, Tool  # noqa: E402

MAX_TEXT_CHARS = 2_000_000
MAX_FORECAST_LENGTH = 366
N_JOBS = int(os.environ.get("AUTOTS_N_JOBS", "2"))

QUALITY = {
    "quick": {"model_list": "superfast", "max_generations": 2, "num_validations": 1},
    "thorough": {"model_list": "fast", "max_generations": 4, "num_validations": 2},
}

TOOLS = [
    Tool(
        name="forecast",
        description=(
            "Forecast time series with an automatic model search and return the values with "
            "upper and lower bounds. Pass the data as CSV text, or the data_id of an earlier "
            "forecast to run the same data again. Takes seconds on quality quick, about a "
            "minute or more on thorough."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "maxLength": MAX_TEXT_CHARS,
                    "description": "CSV or TSV text with a date column and one column per series.",
                },
                "data_id": {"type": "string", "description": "From an earlier forecast."},
                "data_format": {"type": "string", "enum": ["auto", "wide", "long"]},
                "forecast_length": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_FORECAST_LENGTH,
                    "description": (
                        "How many periods to forecast, at most as many as the data has. "
                        "Without it, a quarter of the history, up to 30."
                    ),
                },
                "quality": {"type": "string", "enum": list(QUALITY), "default": "quick"},
                "prediction_interval": {
                    "type": "number",
                    "minimum": 0.5,
                    "maximum": 0.99,
                    "default": 0.9,
                    "description": "Share of outcomes the bounds should cover.",
                },
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="plot_forecast",
        description=(
            "Draw a forecast with its history and bounds as an image. The chat shows the "
            "image to the user; you get only a note that it was shown, not the picture."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "prediction_id": {"type": "string", "description": "From forecast."},
                "include_history": {"type": "boolean", "default": True},
                "series": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["prediction_id"],
            "additionalProperties": False,
        },
    ),
]
_BY_NAME = {t.name: t for t in TOOLS}

app = Server("autots")

# One computation at a time: this process shares the app's memory, and pyplot is
# not thread safe. It runs in a thread, so a waiting call doesn't stall the protocol.
_compute = asyncio.Lock()


def check_arguments(name, arguments):
    """Refuse what the schema doesn't offer, whatever the client validated."""
    tool = _BY_NAME.get(name)
    if tool is None:
        raise ValueError(f"Unknown tool: {name}. Available: {', '.join(_BY_NAME)}")
    arguments = arguments or {}
    unknown = set(arguments) - set(tool.inputSchema["properties"])
    if unknown:
        raise ValueError(f"{name} does not take: {', '.join(sorted(unknown))}")
    for value in arguments.values():
        if isinstance(value, str) and len(value) > MAX_TEXT_CHARS:
            raise ValueError(f"Text is over the limit of {MAX_TEXT_CHARS} characters.")
    return arguments


def search_params(arguments):
    """The AutoTS settings of a forecast. Only these reach the AutoTS constructor."""
    quality = arguments.get("quality", "quick")
    if quality not in QUALITY:
        raise ValueError(f"quality must be one of: {', '.join(QUALITY)}")
    return {
        **QUALITY[quality],
        "prediction_interval": arguments.get("prediction_interval", 0.9),
        "ensemble": None,
        "verbose": 0,
        "n_jobs": N_JOBS,
    }


# AutoTS 1.0.4 draws the next generation of its model search with pandas `sample`,
# whose weights pandas 3 refuses once enough models are tried ("Weighted sampling
# cannot be achieved with replace=False"). On a short series with quality thorough
# that happens every time; the search then runs again without new generations.
_SAMPLING_ERROR = "Weighted sampling cannot be achieved"


def history_length(data_id):
    """Periods in the loaded data: smart_load keeps it wide, one row per date."""
    return len(get_cached_object(data_id, "data")["object"])


def forecast_length(arguments, rows):
    """The periods asked for, or a quarter of the history up to 30.

    A fixed 30 forecast two and a half years from 12 months of data and broke
    the model search; more periods than the data has can't be checked against it.
    """
    length = arguments.get("forecast_length")
    if length is None:
        return max(1, min(30, rows // 4))
    if length > rows:
        raise ValueError(
            f"forecast_length {length} is longer than the data, which has {rows} periods. "
            f"Forecast at most {rows} periods, or pass more history."
        )
    return length


async def _forecast(arguments):
    if bool(arguments.get("text")) == bool(arguments.get("data_id")):
        raise ValueError("Pass the data either as text or as a data_id.")
    result = {}
    data_id = arguments.get("data_id")
    if not data_id:
        load = {"text": arguments["text"]}
        if arguments.get("data_format"):
            load["data_format"] = arguments["data_format"]
        loaded = await run_tool("smart_load", load)
        data_id = loaded["data_id"]
        result["data_report"] = loaded.get("report")
    length = forecast_length(arguments, history_length(data_id))
    params = search_params(arguments)
    try:
        done = await _fit(data_id, length, params)
    except ValueError as exc:
        if _SAMPLING_ERROR not in str(exc) or not params["max_generations"]:
            raise
        params["max_generations"] = 0
        done = await _fit(data_id, length, params)
        result["note"] = "The model search ran its first round only (an AutoTS limit)."
    prediction_id = done["prediction_id"]
    result.update(prediction_id=prediction_id, data_id=data_id, forecast_length=length)
    for output in ("forecast", "upper_forecast", "lower_forecast"):
        result[output] = await run_tool(
            "get_forecast", {"prediction_id": prediction_id, "output": output}
        )
    model = await run_tool("get_model_params", {"prediction_id": prediction_id})
    result["model"] = model.get("model_name") if isinstance(model, dict) else None
    return result


async def _fit(data_id, length, params):
    return await run_tool(
        "forecast_custom",
        {"data_id": data_id, "forecast_length": length, "autots_params": params},
    )


async def _dispatch(name, arguments):
    if name == "forecast":
        return await _forecast(arguments)
    return await run_tool(name, arguments)


def to_content(result):
    if isinstance(result, dict) and "image_base64" in result:
        return [
            ImageContent(
                type="image",
                data=result["image_base64"],
                mimeType=result.get("mime_type", "image/png"),
            )
        ]
    return [TextContent(type="text", text=json.dumps(result, separators=(",", ":"), default=str))]


@app.list_tools()
async def list_tools():
    return TOOLS


@app.call_tool()
async def call_tool(name, arguments):
    arguments = check_arguments(name, arguments)
    async with _compute:
        result = await asyncio.to_thread(asyncio.run, _dispatch(name, arguments))
    if isinstance(result, dict) and result.get("error"):
        raise ValueError(str(result["error"]))
    return to_content(result)


def _protocol_stdout():
    """Keep fd 1 for the protocol alone and send everything else to stderr.

    AutoTS and the libraries under it print while fitting, some from native code,
    and one stray line on stdout breaks the client's parsing.
    """
    import io

    import anyio

    protocol = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return anyio.wrap_file(io.TextIOWrapper(protocol, encoding="utf-8", newline="\n"))


async def main():
    stdout = _protocol_stdout()
    if hasattr(os, "nice"):
        os.nice(10)  # A forecast yields to the app's own requests.
    async with stdio_server(stdout=stdout) as (read, write):
        await app.run(read, write, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
