"""
declarative_widgets.py — `render_widget`: standard visuals from data alone.

`render_ui` lets the model write a small web app. That is the right tool for
anything bespoke, and the wrong one for the common cases — a bar chart, a few
key figures, a table, a flow diagram — where writing HTML and JS is wasted
effort and, for a small model, a real chance of a broken answer.

Here the model sends DATA only. Each type is validated and compiled by THIS
module into a finished interactive answer built with the Talos UI kit
(talos.chart, t-kpi, …) — the code is ours, the model's values reach it only as
JSON (window.TALOS_DATA) or HTML-escaped text. So it looks and behaves exactly
like a hand-built answer (theme, full screen, download, source bar), and there
is nothing for the model to get wrong but the numbers.

Types are primitives, not use cases: chart, kpi, table, diagram, timeline,
comparison. A new kind of answer is a skill that combines them, not a type here.
"""

from __future__ import annotations

import html as _html
import json
from typing import Any, Dict, List

from src.interactive_ui import RenderUiError, _sources

WIDGET_KINDS = ("chart", "kpi", "table", "diagram", "timeline", "comparison")
CHART_KINDS = ("bar", "horizontal", "stacked", "line", "area", "donut")

MAX_CATEGORIES = 200
MAX_SERIES = 8
MAX_KPIS = 12
MAX_TABLE_ROWS = 2000
MAX_TABLE_COLS = 40
MAX_EVENTS = 60
MAX_COMPARE_OPTIONS = 8
MAX_COMPARE_ROWS = 40
MAX_DIAGRAM_CHARS = 8000


def _esc(value: Any) -> str:
    return _html.escape(str(value if value is not None else ""), quote=True)


def _num(value: Any, where: str, allow_none: bool = True) -> Any:
    if value is None and allow_none:
        return None
    if isinstance(value, bool):
        raise RenderUiError(f"{where}: expected a number, got true/false.")
    if isinstance(value, (int, float)):
        if value != value or value in (float("inf"), float("-inf")):
            raise RenderUiError(f"{where}: numbers must be finite.")
        return value
    if isinstance(value, str):
        try:
            return float(value.replace(",", ".")) if value.strip() else None
        except ValueError:
            pass
    raise RenderUiError(f"{where}: expected a number, got {value!r}.")


def _text(value: Any, limit: int = 200) -> str:
    return str(value if value is not None else "").strip()[:limit]


# ── chart ──


def _chart(data: Dict[str, Any]) -> Dict[str, Any]:
    kind = str(data.get("kind") or data.get("chart") or "bar").lower()
    if kind not in CHART_KINDS:
        raise RenderUiError(f"chart.kind must be one of {', '.join(CHART_KINDS)}.")
    unit = _text(data.get("unit"), 20)
    if kind == "donut":
        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise RenderUiError('A donut needs `items`: [{"label": "…", "value": 12}, …].')
        clean = [
            {
                "label": _text(it.get("label"), 80),
                "value": _num(it.get("value"), "items.value", False),
            }
            for it in items[:MAX_CATEGORIES]
            if isinstance(it, dict)
        ]
        spec = {"kind": kind, "unit": unit, "items": clean}
        js = "talos.chart.donut('#w', {items: D.items, unit: D.unit, height: 240});"
        return {"spec": spec, "js": js, "height": 300}

    categories = data.get("categories")
    series = data.get("series")
    if not isinstance(categories, list) or not categories:
        raise RenderUiError("A chart needs `categories` (the x axis labels) — a non-empty list.")
    if len(categories) > MAX_CATEGORIES:
        raise RenderUiError(f"At most {MAX_CATEGORIES} categories; aggregate first.")
    if isinstance(series, dict):
        series = [series]
    if not isinstance(series, list) or not series or len(series) > MAX_SERIES:
        raise RenderUiError(
            f'A chart needs `series`: [{{"name": "…", "values": […]}}] (1-{MAX_SERIES}).'
        )
    clean_series = []
    for i, s in enumerate(series):
        if not isinstance(s, dict) or not isinstance(s.get("values"), list):
            raise RenderUiError(f"series[{i}] needs `values`, a list of numbers.")
        values = [_num(v, f"series[{i}].values") for v in s["values"]]
        if len(values) != len(categories):
            raise RenderUiError(
                f"series[{i}] has {len(values)} values for {len(categories)} categories."
            )
        clean_series.append({"name": _text(s.get("name"), 60), "values": values})
    spec = {
        "kind": kind,
        "unit": unit,
        "categories": [_text(c, 60) for c in categories],
        "series": clean_series,
    }
    if kind in ("line", "area"):
        js = "talos.chart.line('#w', {categories: D.categories, series: D.series, unit: D.unit, area: D.kind === 'area'});"
    else:
        js = (
            "talos.chart.bar('#w', {categories: D.categories, series: D.series, unit: D.unit, "
            "horizontal: D.kind === 'horizontal' ? true : undefined, stacked: D.kind === 'stacked'});"
        )
    rows = len(categories) if kind == "horizontal" else 0
    return {"spec": spec, "js": js, "height": max(300, min(1200, 60 + rows * 30))}


# ── kpi ──


def _kpi(data: Dict[str, Any]) -> Dict[str, Any]:
    items = data.get("items")
    if not isinstance(items, list) or not items or len(items) > MAX_KPIS:
        raise RenderUiError(
            f'kpi needs `items` (1-{MAX_KPIS}): [{{"label": "Umsatz", "value": 4.15, "unit": "Mio. €", "delta": 0.19}}].'
        )
    tiles = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise RenderUiError(f"kpi.items[{i}] must be an object.")
        value = it.get("value")
        shown = (
            _esc(value)
            if isinstance(value, str)
            else _esc(_fmt_number(_num(value, f"kpi.items[{i}].value", False)))
        )
        delta_html = ""
        delta = it.get("delta")
        if delta is not None:
            d = _num(delta, f"kpi.items[{i}].delta", False)
            direction = "up" if d > 0 else "down" if d < 0 else ""
            good = it.get("higherIsBetter", True) is not False
            css = direction and ("up" if (d > 0) == good else "down")
            arrow = "▲" if d > 0 else "▼" if d < 0 else "●"
            pct = it.get("deltaIsPercent", True) is not False
            amount = f"{abs(d) * 100:.1f} %".replace(".", ",") if pct else _fmt_number(abs(d))
            label = _esc(_text(it.get("deltaLabel"), 40))
            delta_html = f'<span class="t-delta {css}">{arrow} {_esc(amount)}{(" " + label) if label else ""}</span>'
        note = _text(it.get("note"), 80)
        tiles.append(
            '<div class="t-card t-kpi">'
            f'<span class="t-kpi-label">{_esc(_text(it.get("label"), 60))}</span>'
            f'<span class="t-kpi-value">{shown}'
            f"{('<small>' + _esc(_text(it.get('unit'), 20)) + '</small>') if it.get('unit') else ''}</span>"
            f"{delta_html}"
            f"{('<span class=t-note>' + _esc(note) + '</span>') if note else ''}"
            "</div>"
        )
    html = f'<div class="t-grid" style="--t-min:150px">{"".join(tiles)}</div>'
    rows = (len(tiles) + 3) // 4
    return {"html": html, "height": 40 + rows * 110}


def _fmt_number(value: float) -> str:
    """German grouping/decimal marks — the frame reformats nothing in kpi."""
    if float(value).is_integer() and abs(value) < 1e15:
        text = f"{int(value):,}"
    else:
        text = f"{value:,.2f}".rstrip("0").rstrip(".")
    return text.replace(",", " ").replace(".", ",")


# ── table ──


def _table(data: Dict[str, Any]) -> Dict[str, Any]:
    columns = data.get("columns")
    rows = data.get("rows")
    if not isinstance(columns, list) or not columns or len(columns) > MAX_TABLE_COLS:
        raise RenderUiError(f"table needs `columns` (1-{MAX_TABLE_COLS} names).")
    if not isinstance(rows, list):
        raise RenderUiError("table needs `rows` — a list of lists (or of objects keyed by column).")
    names = [_text(c, 80) for c in columns]
    matrix: List[List[Any]] = []
    for r in rows[:MAX_TABLE_ROWS]:
        if isinstance(r, dict):
            r = [r.get(n) for n in names]
        if not isinstance(r, list):
            raise RenderUiError("Each table row is a list (or an object keyed by column).")
        cells = []
        for v in r[: len(names)]:
            cells.append(v if isinstance(v, (int, float, str, bool)) or v is None else str(v))
        cells += [None] * (len(names) - len(cells))
        matrix.append(cells)
    return {"columns": names, "rows": matrix, "rowCount": len(rows)}


# ── diagram ──


def _diagram(data: Dict[str, Any]) -> Dict[str, Any]:
    source = str(data.get("mermaid") or data.get("source") or "").strip()
    if not source:
        raise RenderUiError(
            'diagram needs `mermaid`: the diagram in Mermaid syntax, e.g. "flowchart LR\\n  A[Antrag] --> B{Prüfung}".'
        )
    if len(source) > MAX_DIAGRAM_CHARS:
        raise RenderUiError(f"The diagram is too long (max {MAX_DIAGRAM_CHARS} characters).")
    js = (
        "(async () => {\n"
        # Mermaid computes with its colours, so the tokens go in resolved.
        "  const v = (n) => talos.color(n);\n"
        "  const dark = document.documentElement.dataset.theme === 'dark';\n"
        "  const font = getComputedStyle(document.documentElement).getPropertyValue('--talos-font');\n"
        # useMaxWidth false: natural size, never shrunk to fit — a wide flow
        # squeezed into the chat column is unreadable; it scrolls sideways.
        "  const natural = { useMaxWidth: false };\n"
        "  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: font,\n"
        "    flowchart: natural, sequence: natural, gantt: natural, class: natural, state: natural, er: natural,\n"
        "    journey: natural, mindmap: natural, timeline: natural, pie: natural,\n"
        "    themeVariables: { darkMode: dark, background: v('--talos-bg'), fontSize: '14px',\n"
        "      primaryColor: v('--talos-surface'), primaryBorderColor: v('--talos-accent'), primaryTextColor: v('--talos-fg'),\n"
        "      lineColor: v('--talos-muted'), secondaryColor: v('--talos-bg'), tertiaryColor: v('--talos-bg'),\n"
        "      textColor: v('--talos-fg'), mainBkg: v('--talos-surface'), nodeBorder: v('--talos-accent'),\n"
        "      clusterBkg: v('--talos-bg'), clusterBorder: v('--talos-border'), edgeLabelBackground: v('--talos-bg') } });\n"
        "  const { svg } = await mermaid.render('talos-diagram', D.mermaid);\n"
        "  const box = document.getElementById('w'); box.innerHTML = svg;\n"
        # Mermaid sometimes sizes the canvas far beyond the drawing (a 2100 px
        # square around an 850×170 flow). Fit it to what was actually drawn.
        "  const el = box.querySelector('svg'), root = el && el.querySelector(':scope > g');\n"
        "  if (root) { const b = root.getBBox(), pad = 8;\n"
        "    if (b.width > 0 && b.height > 0) {\n"
        "      el.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);\n"
        "      el.setAttribute('width', b.width + 2 * pad); el.setAttribute('height', b.height + 2 * pad);\n"
        "      el.style.maxWidth = 'none'; } }\n"
        "  window.__talosMeasure && window.__talosMeasure();\n"
        "})().catch(e => { document.getElementById('w').innerHTML = '<p class=\"t-note\">Diagramm fehlerhaft: ' + String(e.message || e).replace(/[<&]/g, '') + '</p>'; throw e; });"
    )
    css = "#w{overflow-x:auto;overflow-y:hidden;padding-bottom:4px}#w svg{display:block;margin:0 auto}"
    return {
        "spec": {"mermaid": source},
        "js": js,
        "css": css,
        "height": 360,
        "libraries": ["mermaid"],
    }


# ── timeline ──


def _timeline(data: Dict[str, Any]) -> Dict[str, Any]:
    events = data.get("events")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise RenderUiError(
            f'timeline needs `events` (1-{MAX_EVENTS}): [{{"date": "2024-03", "title": "…", "text": "…"}}].'
        )
    items = []
    for i, ev in enumerate(events):
        if not isinstance(ev, dict) or not ev.get("title"):
            raise RenderUiError(f"timeline.events[{i}] needs a `title` (and usually a `date`).")
        tone = {"done": "var(--talos-good)", "risk": "var(--talos-critical)"}.get(
            str(ev.get("status") or ""), "var(--talos-accent)"
        )
        items.append(
            '<li class="tl-item">'
            f'<span class="tl-dot" style="background:{tone}"></span>'
            f'<div class="tl-date">{_esc(_text(ev.get("date"), 40))}</div>'
            f'<div class="tl-title">{_esc(_text(ev.get("title"), 120))}</div>'
            f"{('<div class=t-note>' + _esc(_text(ev.get('text'), 400)) + '</div>') if ev.get('text') else ''}"
            "</li>"
        )
    css = (
        ".tl{list-style:none;margin:0;padding:0 0 0 18px;position:relative}"
        ".tl::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--talos-border)}"
        ".tl-item{position:relative;padding:0 0 14px 12px}"
        ".tl-dot{position:absolute;left:-18px;top:5px;width:12px;height:12px;border-radius:50%;box-shadow:0 0 0 3px var(--talos-bg)}"
        ".tl-date{font:500 11px/1.4 var(--talos-mono);color:var(--talos-muted)}"
        ".tl-title{font-weight:600;font-size:14px;margin:1px 0 2px}"
    )
    return {
        "html": f'<ol class="tl">{"".join(items)}</ol>',
        "css": css,
        "height": 40 + len(items) * 64,
    }


# ── comparison ──


def _comparison(data: Dict[str, Any]) -> Dict[str, Any]:
    options = data.get("options")
    rows = data.get("rows")
    if not isinstance(options, list) or not 1 <= len(options) <= MAX_COMPARE_OPTIONS:
        raise RenderUiError(f"comparison needs `options` (1-{MAX_COMPARE_OPTIONS} names).")
    if not isinstance(rows, list) or not rows or len(rows) > MAX_COMPARE_ROWS:
        raise RenderUiError(
            'comparison needs `rows`: [{"criterion": "Preis", "values": ["…", "…"], "best": 0}].'
        )
    head = "".join(f"<th>{_esc(_text(o, 60))}</th>" for o in options)
    body = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or not isinstance(r.get("values"), list):
            raise RenderUiError(f"comparison.rows[{i}] needs `criterion` and `values`.")
        values = r["values"][: len(options)] + [""] * (len(options) - len(r["values"]))
        best = r.get("best")
        cells = "".join(
            f'<td class="{"cmp-best" if best == j else ""}">{_esc(_text(v, 200))}</td>'
            for j, v in enumerate(values)
        )
        body.append(f"<tr><th scope=row>{_esc(_text(r.get('criterion'), 80))}</th>{cells}</tr>")
    verdict = _text(data.get("verdict"), 300)
    css = (
        ".cmp{overflow-x:auto}.cmp table{min-width:420px}"
        ".cmp thead th{color:var(--talos-fg);font-weight:600}"
        ".cmp tbody th{color:var(--talos-muted);font-weight:500;white-space:normal}"
        ".cmp-best{color:var(--talos-fg);font-weight:600;background:color-mix(in srgb,var(--talos-accent) 12%,transparent);border-radius:6px}"
    )
    html = (
        f'<div class="t-stack"><div class="cmp"><table class="t-table"><thead><tr><th></th>{head}</tr></thead>'
        f"<tbody>{''.join(body)}</tbody></table></div>"
        f"{('<p class=t-note>' + _esc(verdict) + '</p>') if verdict else ''}</div>"
    )
    return {"html": html, "css": css, "height": 80 + len(rows) * 36}


BUILDERS = {
    "chart": _chart,
    "kpi": _kpi,
    "diagram": _diagram,
    "timeline": _timeline,
    "comparison": _comparison,
}


def build(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a render_widget call and return the widget envelope."""
    from src.widgets import make_widget

    if not isinstance(args, dict):
        raise RenderUiError("render_widget takes a JSON object.")
    kind = str(args.get("type") or "").strip().lower()
    if kind not in WIDGET_KINDS:
        raise RenderUiError(f"`type` must be one of {', '.join(WIDGET_KINDS)}.")
    data = args.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            raise RenderUiError("`data` must be a JSON object.")
    if not isinstance(data, dict):
        raise RenderUiError("`data` must be a JSON object.")
    title = _text(args.get("title"), 120)
    sources = _sources(args.get("sources"))

    if kind == "table":
        from src.widgets import trim_rows_to_budget

        table = _table(data)
        table["rows"], _dropped = trim_rows_to_budget(table["rows"], overhead=4_000)
        # The native table widget (sortable, CSV, chart toggle). Marked as an
        # answer so it stays visible instead of folding away like a query
        # result does.
        return make_widget(
            "table",
            {
                **table,
                "shown": len(table["rows"]),
                "trimmed": table["rowCount"] > len(table["rows"]),
                "label": title,
                "database": "",
                "spillPath": "",
                "answer": True,
                "sources": sources,
            },
        )

    built = BUILDERS[kind](data)
    payload: Dict[str, Any] = {
        "title": title,
        "initialHeight": built.get("height", 320),
        "placeholderMessages": [],
        "css": built.get("css", ""),
        "html": built.get("html", '<div id="w"></div>'),
        "js": ("const D = window.TALOS_DATA;\n" + built["js"]) if built.get("js") else "",
        "jsInit": [],
        "sources": sources,
        "declarative": kind,
    }
    if "spec" in built:
        payload["data"] = built["spec"]
    if built.get("libraries"):
        payload["libraries"] = built["libraries"]
    return make_widget("ui", payload)


def summary(args: Dict[str, Any], widget: Dict[str, Any]) -> str:
    kind = str(args.get("type") or "")
    title = str(args.get("title") or "") or kind
    src = "; ".join(f"{s['kind']}: {s['label']}" for s in widget["data"].get("sources") or [])
    return (
        f"{kind.capitalize()} shown to the user: {title!r}. It is already visible — do not "
        "repeat its values as text or a table; add only what it does not show."
        + (f"\nSources shown under it: {src}" if src else "")
    )


async def do_render_widget(content: str) -> Dict[str, Any]:
    from src.interactive_ui import parse_args

    try:
        args = parse_args(content)
        widget = build(args)
    except RenderUiError as e:
        return {"error": f"render_widget: {e}", "exit_code": 1}
    return {"output": summary(args, widget), "exit_code": 0, "widget": widget}


def display_title(content: str) -> str:
    try:
        args = json.loads(content)
        if isinstance(args, dict):
            return str(args.get("title") or args.get("type") or "render_widget")[:80]
    except (ValueError, TypeError):
        pass
    return "render_widget"
