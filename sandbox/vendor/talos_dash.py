"""Dashboard scaffold for the Talos sandbox.

The *chrome* of a dashboard — the HTML shell, the inlined ECharts bundle, the
grid, the KPI tiles, light/dark theming, per-chart error isolation, resize
handling — is identical every single time and carries no information about the
user's question. Regenerating it per request is the dominant cost of a dashboard
turn, so it lives here instead.

What stays free is the part that should vary: which charts, and what data. Build
options with the catalog below (or hand-write any ECharts option dict — the
catalog returns plain dicts you can edit) and pass them to `dashboard()`.

    import sys; sys.path.insert(0, "/opt/talos/vendor")
    from talos_dash import dashboard, chart, kpi, line, hbar, heatmap

    dashboard(
        "output/dashboard.html",
        title="Umsatz 2023–2025",
        subtitle="Quartalszahlen, Stand 03/2026",
        kpis=[kpi("Nettoumsatz", "45,2 Mio. €", "+3,1 %", "up")],
        charts=[
            chart("trend", "Entwicklung", line(quarters, {"Ist": ist, "Plan": plan}), span=2),
            chart("top", "Top-Kunden", hbar(names, values)),
        ],
    )

Everything is self-contained: the workspace has no network and the preview
iframe runs under a CSP that blocks every outbound request, so a CDN <script
src> yields a permanently blank page.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

VENDOR = Path("/opt/talos/vendor")

__all__ = [
    "dashboard", "render", "chart", "kpi", "check_option", "themes",
    "line", "area", "bar", "hbar", "grouped_bar", "stacked_bar", "waterfall",
    "scatter", "heatmap", "pie", "donut", "radar", "gauge", "funnel",
    "boxplot", "histogram", "treemap", "sankey",
]

# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------
# One accent plus muted support colours. A twelve-colour rainbow says "I did not
# decide what matters" — the first series gets the strong colour, the rest
# recede. Override per chart with option["color"] when the data has its own
# semantics (red = loss, etc.).
ACCENT = "#2f6df6"
PALETTE = [ACCENT, "#8aa0c8", "#f2a63b", "#3fb28f", "#c8577e", "#7b6cc4", "#9aa5b1"]
POSITIVE = "#3fb28f"
NEGATIVE = "#d1495b"


def themes() -> list[str]:
    """Names of the vendored ECharts themes."""
    d = VENDOR / "echarts-themes"
    return sorted(p.stem for p in d.glob("*.js")) if d.is_dir() else []


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
_CARTESIAN = {"line", "bar", "scatter", "effectScatter", "candlestick", "boxplot"}


def check_option(cid: str, opt: Mapping[str, Any]) -> None:
    """Fail loudly in Python rather than silently in the browser.

    ECharts ignores unknown keys, so `xaxis` instead of `xAxis` produces no
    error — it produces a chart with no axis, and the resulting TypeError out of
    setOption aborts the script, taking every *later* chart on the page with it.
    """
    for wrong, right in (("xaxis", "xAxis"), ("yaxis", "yAxis"), ("Series", "series")):
        if wrong in opt:
            raise ValueError(f"{cid}: {wrong!r} must be {right!r} (ECharts is camelCase)")
    series = opt.get("series") or []
    if isinstance(series, Mapping):
        series = [series]
    if any(s.get("type") in _CARTESIAN for s in series):
        missing = [k for k in ("xAxis", "yAxis") if k not in opt]
        if missing:
            raise ValueError(f"{cid}: cartesian series needs {missing}")
    x = opt.get("xAxis") or {}
    cats = x.get("data") if isinstance(x, Mapping) else None
    if cats:
        for s in series:
            # Only line/bar map one datum per category. Scatter, heatmap and
            # friends carry their own coordinates ([x, y] / [x, y, v]) and are
            # legitimately a different length.
            if s.get("type") not in (None, "line", "bar"):
                continue
            data = s.get("data")
            if data and isinstance(data[0], (list, tuple)):
                continue
            if data is not None and len(data) != len(cats):
                raise ValueError(
                    f"{cid}: series {s.get('name')!r} has {len(data)} points but xAxis has "
                    f"{len(cats)} categories. Pad with None — a short array plots against the "
                    f"FIRST categories, it does not align to the right."
                )


def _pad(values: Sequence[Any], n: int) -> list[Any]:
    out = list(values)
    return out + [None] * (n - len(out)) if len(out) < n else out


def _series_map(series: Mapping[str, Sequence[Any]] | Sequence[Mapping[str, Any]]):
    """Accept either {"name": [...]} or a list of raw ECharts series dicts."""
    if isinstance(series, Mapping):
        return [{"name": k, "data": list(v)} for k, v in series.items()]
    return [dict(s) for s in series]


# --------------------------------------------------------------------------
# Chart catalog
# --------------------------------------------------------------------------
# Each builder returns a plain ECharts option dict — tweak it, or ignore these
# and write your own. They exist so that reaching for a heatmap, a sankey or a
# waterfall costs the same as reaching for a bar chart; the default bar-chart
# dashboard is a symptom of the alternatives being expensive to write, not of
# bars being right.
#
#   question shape                      -> builder
#   change over time                    -> line / area
#   one series over time, emphasised    -> area
#   compare categories                  -> bar (few) / hbar (many or long labels)
#   compare categories across groups    -> grouped_bar
#   composition over time               -> stacked_bar
#   what drove the change               -> waterfall
#   relationship between two measures   -> scatter
#   two categorical dims + a measure    -> heatmap
#   composition, one moment, <=5 parts  -> pie / donut
#   several metrics, few entities       -> radar
#   one ratio against a target          -> gauge
#   stage-by-stage drop-off             -> funnel
#   spread and outliers                 -> boxplot / histogram
#   hierarchy of parts                  -> treemap
#   flow between stages                 -> sankey


def _axes(categories, y_name="", *, x_name=""):
    return {
        "xAxis": {
            "type": "category",
            "data": list(categories),
            "name": x_name,
            "boundaryGap": True,
            "axisLine": {"show": False},
            "axisTick": {"show": False},
        },
        "yAxis": {
            "type": "value",
            "name": y_name,
            "splitLine": {"lineStyle": {"opacity": 0.25}},
        },
    }


def _base(title="", *, legend=True, trigger="axis"):
    opt: dict[str, Any] = {
        "color": PALETTE,
        "tooltip": {"trigger": trigger},
        "grid": {"left": 70, "right": 30, "top": 50, "bottom": 45, "containLabel": True},
    }
    if title:
        opt["title"] = {"text": title, "left": "center"}
    if legend:
        opt["legend"] = {"top": 8}
    return opt


def line(categories, series, *, y_name="", smooth=True, area_first=False):
    """Trend over an ordered axis. `series` is {"name": [values]}."""
    n = len(list(categories))
    out = _base(legend=True) | _axes(categories, y_name)
    built = []
    for i, s in enumerate(_series_map(series)):
        s = {"type": "line", "smooth": smooth, "symbolSize": 6, **s}
        s["data"] = _pad(s.get("data") or [], n)
        s.setdefault("lineStyle", {"width": 3 if i == 0 else 2})
        if i > 0:
            s["lineStyle"] = {"width": 2, **s["lineStyle"]}
        if area_first and i == 0:
            s["areaStyle"] = {"opacity": 0.18}
        built.append(s)
    out["series"] = built
    return out


def area(categories, name, values, *, y_name=""):
    """One emphasised series over time, with a gradient fill."""
    opt = _base(legend=False) | _axes(categories, y_name)
    opt["series"] = [{
        "name": name, "type": "line", "smooth": True, "showSymbol": False,
        "data": _pad(values, len(list(categories))),
        "lineStyle": {"width": 3},
        "areaStyle": {"opacity": 0.25},
    }]
    return opt


def bar(categories, values, *, name="", y_name="", sort=False, highlight=None):
    """Compare a measure across categories. `highlight` is an index or category
    name to accent while the rest recede."""
    cats, vals = list(categories), list(values)
    if sort:
        pairs = sorted(zip(cats, vals), key=lambda p: (p[1] is None, -(p[1] or 0)))
        cats, vals = [p[0] for p in pairs], [p[1] for p in pairs]
    hi = cats.index(highlight) if isinstance(highlight, str) and highlight in cats else highlight
    data = [
        {"value": v, "itemStyle": {"color": ACCENT if hi is None or i == hi else "#c3cbd8"}}
        for i, v in enumerate(vals)
    ]
    opt = _base(legend=False) | _axes(cats, y_name)
    opt["series"] = [{"name": name, "type": "bar", "data": data, "barMaxWidth": 48}]
    return opt


def hbar(categories, values, *, name="", x_name="", top=None):
    """Ranking with many or long labels — horizontal, largest at the top."""
    pairs = sorted(zip(categories, values), key=lambda p: (p[1] is None, p[1] or 0))
    if top:
        pairs = pairs[-top:]
    opt = _base(legend=False)
    opt["xAxis"] = {"type": "value", "name": x_name,
                    "splitLine": {"lineStyle": {"opacity": 0.25}}}
    opt["yAxis"] = {"type": "category", "data": [p[0] for p in pairs],
                    "axisLine": {"show": False}, "axisTick": {"show": False}}
    opt["series"] = [{
        "name": name, "type": "bar", "data": [p[1] for p in pairs],
        "barMaxWidth": 26, "itemStyle": {"color": ACCENT},
        "label": {"show": True, "position": "right"},
    }]
    opt["grid"]["left"] = 30
    return opt


def grouped_bar(categories, series, *, y_name=""):
    n = len(list(categories))
    opt = _base() | _axes(categories, y_name)
    opt["series"] = [
        {"type": "bar", "barMaxWidth": 32, **s, "data": _pad(s.get("data") or [], n)}
        for s in _series_map(series)
    ]
    return opt


def stacked_bar(categories, series, *, y_name="", percent=False):
    """Composition over time. `percent=True` normalises each column to 100%."""
    n = len(list(categories))
    built = _series_map(series)
    for s in built:
        s["data"] = _pad(s.get("data") or [], n)
    if percent:
        totals = [sum((s["data"][i] or 0) for s in built) for i in range(n)]
        for s in built:
            s["data"] = [
                None if v is None else (100.0 * v / totals[i] if totals[i] else 0.0)
                for i, v in enumerate(s["data"])
            ]
    opt = _base() | _axes(categories, "%" if percent else y_name)
    if percent:
        opt["yAxis"]["max"] = 100
    opt["series"] = [
        {"type": "bar", "stack": "total", "barMaxWidth": 48, **s} for s in built
    ]
    return opt


def waterfall(labels, deltas, *, start=0.0, y_name="", total_label="Gesamt"):
    """What drove the change between two numbers: signed contributions plus a
    closing total. Far more informative than the bar chart it usually loses to."""
    base, rises, falls = [], [], []
    running = start
    for d in deltas:
        d = d or 0
        if d >= 0:
            base.append(running)
            rises.append(d)
            falls.append(None)
        else:
            base.append(running + d)
            rises.append(None)
            falls.append(-d)
        running += d
    cats = list(labels) + [total_label]
    base.append(0)
    rises.append(None)
    falls.append(None)
    opt = _base(legend=False, trigger="axis") | _axes(cats, y_name)
    opt["series"] = [
        {"name": "", "type": "bar", "stack": "wf", "data": base, "barMaxWidth": 46,
         "itemStyle": {"color": "transparent"}, "emphasis": {"itemStyle": {"color": "transparent"}},
         "tooltip": {"show": False}},
        {"name": "Zuwachs", "type": "bar", "stack": "wf", "data": rises,
         "itemStyle": {"color": POSITIVE}, "barMaxWidth": 46},
        {"name": "Rückgang", "type": "bar", "stack": "wf", "data": falls,
         "itemStyle": {"color": NEGATIVE}, "barMaxWidth": 46},
        {"name": total_label, "type": "bar", "stack": "wf",
         "data": [None] * len(labels) + [running],
         "itemStyle": {"color": ACCENT}, "barMaxWidth": 46},
    ]
    return opt


def scatter(points, *, x_name="", y_name="", name="", sizes=None, labels=None):
    """Relationship between two measures. `points` is [(x, y), ...]."""
    data = []
    for i, (x, y) in enumerate(points):
        item: dict[str, Any] = {"value": [x, y]}
        if sizes is not None:
            item["symbolSize"] = sizes[i]
        if labels is not None:
            item["name"] = labels[i]
        data.append(item)
    opt = _base(legend=False, trigger="item")
    opt["xAxis"] = {"type": "value", "name": x_name,
                    "splitLine": {"lineStyle": {"opacity": 0.25}}}
    opt["yAxis"] = {"type": "value", "name": y_name,
                    "splitLine": {"lineStyle": {"opacity": 0.25}}}
    opt["series"] = [{"name": name, "type": "scatter", "data": data,
                      "symbolSize": 12 if sizes is None else None,
                      "itemStyle": {"opacity": 0.75}}]
    return opt


def heatmap(x_labels, y_labels, values, *, unit="", low=None, high=None):
    """Two categorical dimensions against one measure.
    `values` is a 2-D list indexed [y][x], or a list of (xi, yi, v) triples."""
    if values and isinstance(values[0], (list, tuple)) and len(values[0]) == 3 \
            and not isinstance(values[0][0], (list, tuple)):
        data = [[int(a), int(b), c] for a, b, c in values]
        flat = [c for _, _, c in data if c is not None]
    else:
        data = [[xi, yi, v] for yi, row in enumerate(values) for xi, v in enumerate(row)]
        flat = [v for _, _, v in data if v is not None]
    opt = {
        "tooltip": {"position": "top"},
        "grid": {"left": 70, "right": 30, "top": 40, "bottom": 60, "containLabel": True},
        "xAxis": {"type": "category", "data": list(x_labels), "splitArea": {"show": True}},
        "yAxis": {"type": "category", "data": list(y_labels), "splitArea": {"show": True}},
        "visualMap": {
            "min": low if low is not None else (min(flat) if flat else 0),
            "max": high if high is not None else (max(flat) if flat else 1),
            "calculable": True, "orient": "horizontal", "left": "center", "bottom": 5,
            "text": [unit, ""],
            "inRange": {"color": ["#eef2fb", "#9db6ee", ACCENT, "#1b3f9e"]},
        },
        "series": [{
            "type": "heatmap", "data": data,
            "label": {"show": len(data) <= 60},
            "emphasis": {"itemStyle": {"shadowBlur": 8}},
        }],
    }
    return opt


def pie(labels, values, *, inner=False, name=""):
    """Composition at one moment. Keep it to <=5 slices; past that a bar wins."""
    return {
        "color": PALETTE,
        "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
        "legend": {"bottom": 0},
        "series": [{
            "name": name, "type": "pie",
            "radius": ["45%", "70%"] if inner else "62%",
            "center": ["50%", "46%"],
            "avoidLabelOverlap": True,
            "itemStyle": {"borderColor": "#fff", "borderWidth": 2},
            "label": {"formatter": "{b}\n{d}%"},
            "data": [{"name": n, "value": v} for n, v in zip(labels, values)],
        }],
    }


def donut(labels, values, **kw):
    return pie(labels, values, inner=True, **kw)


def radar(indicators, series, *, maxes=None):
    """Several metrics compared across a few entities.
    `indicators` are metric names; `series` is {"entity": [values]}."""
    names = list(indicators)
    built = _series_map(series)
    if maxes is None:
        maxes = [
            max((s["data"][i] or 0) for s in built) * 1.15 or 1
            for i in range(len(names))
        ]
    return {
        "color": PALETTE,
        "tooltip": {},
        "legend": {"top": 8},
        "radar": {
            "indicator": [{"name": n, "max": m} for n, m in zip(names, maxes)],
            "splitArea": {"areaStyle": {"opacity": 0.05}},
        },
        "series": [{
            "type": "radar",
            "data": [{"name": s["name"], "value": s["data"],
                      "areaStyle": {"opacity": 0.15}} for s in built],
        }],
    }


def gauge(value, *, name="", target=100, unit="%"):
    """One ratio against a target. A KPI tile is usually better — use this when
    the distance to the target is the point."""
    return {
        "series": [{
            "type": "gauge", "min": 0, "max": target,
            "progress": {"show": True, "width": 16},
            "axisLine": {"lineStyle": {"width": 16}},
            "axisTick": {"show": False},
            "splitLine": {"length": 10},
            "pointer": {"width": 5},
            "detail": {"valueAnimation": True, "formatter": f"{{value}}{unit}",
                       "fontSize": 28, "offsetCenter": [0, "70%"]},
            "title": {"offsetCenter": [0, "95%"]},
            "itemStyle": {"color": ACCENT},
            "data": [{"value": value, "name": name}],
        }],
    }


def funnel(stages, values, *, name=""):
    """Stage-by-stage drop-off (pipeline, conversion)."""
    return {
        "color": PALETTE,
        "tooltip": {"trigger": "item", "formatter": "{b}: {c}"},
        "legend": {"bottom": 0},
        "series": [{
            "name": name, "type": "funnel", "left": "10%", "width": "80%",
            "top": 30, "bottom": 40, "sort": "descending", "gap": 3,
            "label": {"position": "inside", "formatter": "{b}: {c}"},
            "data": [{"name": n, "value": v} for n, v in zip(stages, values)],
        }],
    }


def boxplot(categories, groups, *, y_name=""):
    """Spread and outliers per category. `groups` is a list of raw value lists —
    never summarise a distribution to a mean and hide the shape."""
    boxes, outliers = [], []
    for i, raw in enumerate(groups):
        vals = sorted(v for v in raw if v is not None)
        if not vals:
            boxes.append([None] * 5)
            continue

        def q(p: float) -> float:
            if len(vals) == 1:
                return float(vals[0])
            pos = p * (len(vals) - 1)
            lo = math.floor(pos)
            hi = math.ceil(pos)
            return float(vals[lo] + (vals[hi] - vals[lo]) * (pos - lo))

        q1, q2, q3 = q(0.25), q(0.5), q(0.75)
        iqr = q3 - q1
        lo_f, hi_f = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        inside = [v for v in vals if lo_f <= v <= hi_f] or vals
        boxes.append([min(inside), q1, q2, q3, max(inside)])
        outliers += [[i, v] for v in vals if v < lo_f or v > hi_f]
    opt = _base(legend=False, trigger="item") | _axes(categories, y_name)
    opt["series"] = [
        {"name": "Verteilung", "type": "boxplot", "data": boxes,
         "itemStyle": {"color": "#e8eefc", "borderColor": ACCENT}},
        {"name": "Ausreißer", "type": "scatter", "data": outliers,
         "symbolSize": 7, "itemStyle": {"color": NEGATIVE, "opacity": 0.7}},
    ]
    return opt


def histogram(values, *, bins=20, y_name="Anzahl", x_name=""):
    """Shape of a single distribution."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return bar([], [])
    lo, hi = vals[0], vals[-1]
    if hi == lo:
        hi = lo + 1
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in vals:
        counts[min(int((v - lo) / width), bins - 1)] += 1
    labels = [f"{lo + i * width:.4g}" for i in range(bins)]
    opt = _base(legend=False) | _axes(labels, y_name, x_name=x_name)
    opt["xAxis"]["axisLabel"] = {"interval": max(bins // 10, 0)}
    opt["series"] = [{"type": "bar", "data": counts, "barCategoryGap": "2%",
                      "itemStyle": {"color": ACCENT}}]
    return opt


def treemap(nodes, *, name=""):
    """Hierarchy of parts. `nodes` is [{"name": .., "value": ..,
    "children": [...]}, ...] — nesting optional."""
    return {
        "color": PALETTE,
        "tooltip": {"trigger": "item"},
        "series": [{
            "name": name, "type": "treemap", "roam": False, "width": "96%", "height": "90%",
            "breadcrumb": {"show": False},
            "label": {"show": True, "formatter": "{b}\n{c}"},
            "itemStyle": {"borderColor": "#fff", "borderWidth": 2, "gapWidth": 2},
            "data": list(nodes),
        }],
    }


def sankey(nodes, links):
    """Flow between stages. `nodes` is ["A", "B", ...] (or dicts);
    `links` is [(source, target, value), ...]."""
    node_dicts = [n if isinstance(n, Mapping) else {"name": n} for n in nodes]
    return {
        "color": PALETTE,
        "tooltip": {"trigger": "item", "triggerOn": "mousemove"},
        "series": [{
            "type": "sankey", "data": node_dicts,
            "links": [
                dict(zip(("source", "target", "value"), link)) if not isinstance(link, Mapping)
                else dict(link)
                for link in links
            ],
            "emphasis": {"focus": "adjacency"},
            "lineStyle": {"color": "gradient", "curveness": 0.5, "opacity": 0.45},
            "label": {"fontSize": 11},
        }],
    }


# --------------------------------------------------------------------------
# Page assembly
# --------------------------------------------------------------------------
def chart(cid: str, title: str, option: Mapping[str, Any], *, span: int = 1,
          height: int = 340, note: str = "") -> dict:
    """One chart card. `span=2` makes it full width on a two-column grid."""
    return {"id": cid, "title": title, "option": dict(option),
            "span": span, "height": height, "note": note}


def kpi(label: str, value: Any, delta: str = "", tone: str = "") -> dict:
    """One headline number. `tone` is "up" | "down" | "" and only colours the
    delta — direction is not goodness, so set it deliberately."""
    return {"label": label, "value": value, "delta": delta, "tone": tone}


CSS = """
:root{--bg:#f4f6fa;--card:#fff;--fg:#141922;--muted:#5d6879;--line:#e2e7f0;
--accent:#2f6df6;--up:#2f8f6b;--down:#c23b52;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#11141a;--card:#191e27;--fg:#e8ecf3;
--muted:#95a0b3;--line:#262d3a;--accent:#6f9bff}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{max-width:1400px;margin:0 auto 20px}
h1{margin:0 0 4px;font-size:1.6rem;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.92rem}
.wrap{max-width:1400px;margin:0 auto}
.kpis{display:grid;gap:14px;margin-bottom:18px;
grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
padding:16px 18px;display:flex;flex-direction:column;gap:4px}
.kpi-label{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.7rem;font-weight:600;letter-spacing:-.02em}
.kpi-delta{font-size:.85rem;color:var(--muted)}
.kpi-delta.up{color:var(--up)}.kpi-delta.down{color:var(--down)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(2,minmax(0,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
padding:16px 18px 10px;min-width:0}
.card.span2{grid-column:1/-1}
.card h2{margin:0 0 2px;font-size:1rem;font-weight:600}
.card .note{color:var(--muted);font-size:.82rem;margin:0 0 8px}
.chart{width:100%}
.chart-error{color:var(--down);font-size:.85rem;padding:12px;white-space:pre-wrap}
footer{max-width:1400px;margin:22px auto 0;color:var(--muted);font-size:.82rem}
@media(max-width:900px){.grid{grid-template-columns:1fr}.card.span2{grid-column:auto}
body{padding:14px}}
"""


def _esc(text: Any) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _js(value: Any) -> str:
    """JSON for embedding inside a <script> tag."""
    return json.dumps(value, ensure_ascii=False, default=str).replace("</", "<\\/")


def render(title: str, charts: Sequence[Mapping[str, Any]],
           kpis: Sequence[Mapping[str, Any]] = (), *,
           subtitle: str = "", footer: str = "", theme: str | None = None,
           lang: str = "de") -> str:
    """Build the complete self-contained HTML page."""
    for c in charts:
        check_option(c["id"], c["option"])

    echarts_js = (VENDOR / "echarts.min.js").read_text(encoding="utf-8")
    theme_js = ""
    if theme:
        tf = VENDOR / "echarts-themes" / f"{theme}.js"
        if not tf.is_file():
            raise ValueError(f"theme {theme!r} not found. Available: {', '.join(themes())}")
        theme_js = tf.read_text(encoding="utf-8")

    tiles = "".join(
        f'<div class="kpi"><span class="kpi-label">{_esc(k["label"])}</span>'
        f'<span class="kpi-value">{_esc(k["value"])}</span>'
        f'<span class="kpi-delta {_esc(k.get("tone", ""))}">{_esc(k.get("delta", ""))}</span></div>'
        for k in kpis
    )
    cards = "".join(
        f'<section class="card{" span2" if c.get("span", 1) > 1 else ""}">'
        f'<h2>{_esc(c["title"])}</h2>'
        + (f'<p class="note">{_esc(c["note"])}</p>' if c.get("note") else "")
        + f'<div class="chart" id="{_esc(c["id"])}" style="height:{int(c.get("height", 340))}px">'
          f'</div></section>'
        for c in charts
    )
    # Each init is isolated: an exception in one setOption must not stop the
    # ones after it, and the failure has to be visible on the page rather than
    # showing up as a blank box with a clean-looking layout.
    specs = _js([{"id": c["id"], "option": c["option"]} for c in charts])

    return f"""<!DOCTYPE html>
<html lang="{lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(title)}</title>
<style>{CSS}</style>
<script>{echarts_js}</script>
<script>{theme_js}</script>
</head><body>
<header><h1>{_esc(title)}</h1>
{f'<div class="sub">{_esc(subtitle)}</div>' if subtitle else ''}</header>
<div class="wrap">
{f'<div class="kpis">{tiles}</div>' if tiles else ''}
<div class="grid">{cards}</div>
</div>
{f'<footer>{_esc(footer)}</footer>' if footer else ''}
<script>
// Fail loudly if the library didn't survive being inlined. A blank dashboard
// with a clean console is the hardest version of this to debug.
if (typeof echarts !== 'object' || typeof echarts.init !== 'function') {{
  document.body.insertAdjacentHTML('afterbegin',
    '<p style="background:#fee;color:#900;padding:1rem">ECharts did not load: window.echarts is '
    + typeof echarts + '. The library must be inlined verbatim, with nothing assigned to it.</p>');
}} else {{
  var dark = matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = {_js(theme)} || (dark ? 'dark' : null);
  var instances = [];
  ({specs}).forEach(function (spec) {{
    var el = document.getElementById(spec.id);
    if (!el) return;
    try {{
      var inst = echarts.init(el, theme, {{renderer: 'canvas'}});
      inst.setOption(spec.option);
      instances.push(inst);
    }} catch (e) {{
      console.error(spec.id, e);
      el.innerHTML = '<p class="chart-error">Chart ' + spec.id + ' failed: ' + e.message + '</p>';
    }}
  }});
  addEventListener('resize', function () {{ instances.forEach(function (i) {{ i.resize(); }}); }});
}}
</script>
</body></html>"""


def dashboard(path: str, title: str, charts: Sequence[Mapping[str, Any]],
              kpis: Sequence[Mapping[str, Any]] = (), *,
              subtitle: str = "", footer: str = "", theme: str | None = None,
              lang: str = "de") -> str:
    """Render and write the page. Returns the path written."""
    html = render(title, charts, kpis, subtitle=subtitle, footer=footer,
                  theme=theme, lang=lang)
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return str(out)
