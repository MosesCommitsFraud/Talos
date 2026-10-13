"""render_widget (src/declarative_widgets.py): standard visuals from data alone."""

import asyncio
import json

import pytest

from src import declarative_widgets as dw
from src.widgets import sanitize_widget

SRC = [{"kind": "sql", "label": "dbo.orders"}]


def _run(call):
    return asyncio.run(dw.do_render_widget(json.dumps(call)))


def _ok(call):
    result = _run(call)
    assert result["exit_code"] == 0, result
    widget = sanitize_widget(result["widget"])
    assert widget is not None
    return result, widget


def test_bar_chart_compiles_to_a_kit_ui_with_data_only():
    call = {
        "type": "chart",
        "title": "Umsatz",
        "data": {
            "kind": "bar",
            "categories": ["Jan", "Feb"],
            "series": [{"name": "U", "values": [1, "2,5"]}],
            "unit": "T€",
        },
        "sources": SRC,
    }
    result, widget = _ok(call)
    assert widget["type"] == "ui"
    payload = widget["data"]
    assert payload["declarative"] == "chart"
    assert payload["data"]["series"][0]["values"] == [1, 2.5]
    assert "talos.chart.bar" in payload["js"]
    assert "Umsatz" in result["output"] and "do not" in result["output"]


def test_line_and_donut():
    _, line = _ok(
        {
            "type": "chart",
            "data": {"kind": "line", "categories": ["a"], "series": [{"values": [1]}]},
            "sources": SRC,
        }
    )
    assert "talos.chart.line" in line["data"]["js"]
    _, donut = _ok(
        {
            "type": "chart",
            "data": {"kind": "donut", "items": [{"label": "A", "value": 3}]},
            "sources": SRC,
        }
    )
    assert "talos.chart.donut" in donut["data"]["js"]


@pytest.mark.parametrize(
    "data, needle",
    [
        ({"kind": "pie3d"}, "chart.kind"),
        ({"kind": "bar", "categories": [], "series": []}, "categories"),
        ({"kind": "bar", "categories": ["a", "b"], "series": [{"values": [1]}]}, "1 values for 2"),
        ({"kind": "bar", "categories": ["a"], "series": [{"values": ["x"]}]}, "expected a number"),
        ({"kind": "bar", "categories": ["a"], "series": [{"values": [float("nan")]}]}, None),
    ],
)
def test_bad_charts_are_refused(data, needle):
    if needle is None:
        with pytest.raises(dw.RenderUiError):
            dw.build({"type": "chart", "data": data, "sources": SRC})
        return
    result = _run({"type": "chart", "data": data, "sources": SRC})
    assert result["exit_code"] == 1 and needle in result["error"]


def test_kpi_escapes_model_text_and_formats_deltas():
    _, widget = _ok(
        {
            "type": "kpi",
            "data": {
                "items": [
                    {
                        "label": "<img src=x onerror=alert(1)>",
                        "value": 4150000,
                        "unit": "€",
                        "delta": 0.191,
                        "deltaLabel": "ggü. Vorjahr",
                    },
                    {"label": "Kosten", "value": 12.5, "delta": 0.05, "higherIsBetter": False},
                ]
            },
            "sources": SRC,
        }
    )
    html = widget["data"]["html"]
    assert "<img" not in html and "&lt;img" in html
    assert "4 150 000" in html and "19,1 %" in html
    # Rising costs are bad news: marked down although the number went up.
    assert 't-delta down">▲' in html


def test_table_is_the_native_widget_marked_as_answer():
    _, widget = _ok(
        {
            "type": "table",
            "title": "Top Kunden",
            "data": {
                "columns": ["Kunde", "Umsatz"],
                "rows": [["A", 10], {"Kunde": "B", "Umsatz": 7}],
            },
            "sources": SRC,
        }
    )
    assert widget["type"] == "table"
    assert widget["data"]["answer"] is True
    assert widget["data"]["rows"] == [["A", 10], ["B", 7]]


def test_diagram_uses_mermaid_and_keeps_the_source_as_data():
    _, widget = _ok(
        {"type": "diagram", "data": {"mermaid": "flowchart LR\n A --> B"}, "sources": SRC}
    )
    payload = widget["data"]
    assert payload["libraries"] == ["mermaid"]
    assert payload["data"]["mermaid"].startswith("flowchart")
    assert "securityLevel: 'strict'" in payload["js"]


def test_timeline_and_comparison():
    _, tl = _ok(
        {
            "type": "timeline",
            "data": {"events": [{"date": "2024", "title": "Start <b>", "status": "done"}]},
            "sources": SRC,
        }
    )
    assert "Start &lt;b&gt;" in tl["data"]["html"]
    _, cmp_ = _ok(
        {
            "type": "comparison",
            "data": {
                "options": ["A", "B"],
                "rows": [{"criterion": "Preis", "values": ["10 €", "12 €"], "best": 0}],
                "verdict": "A gewinnt",
            },
            "sources": SRC,
        }
    )
    assert 'class="cmp-best">10 €' in cmp_["data"]["html"]


def test_sources_and_type_are_required():
    assert (
        "sources" in _run({"type": "kpi", "data": {"items": [{"label": "a", "value": 1}]}})["error"]
    )
    assert "`type`" in _run({"type": "gauge", "data": {}, "sources": SRC})["error"]


def test_registered_like_render_ui():
    from src.agent_loop import TOOL_SECTIONS
    from src.agent_tools import TOOL_TAGS
    from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block

    assert "render_widget" in TOOL_TAGS and "render_widget" in TOOL_SECTIONS
    assert "render_widget" in ALWAYS_AVAILABLE and "render_widget" in BUILTIN_TOOL_DESCRIPTIONS
    assert any(s["function"]["name"] == "render_widget" for s in FUNCTION_TOOL_SCHEMAS)
    block = function_call_to_tool_block("render_widget", json.dumps({"type": "kpi"}))
    assert block.tool_type == "render_widget"
