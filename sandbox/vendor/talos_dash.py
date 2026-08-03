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
    import talos_dash as td          # import the module — a `from ... import a, b`
                                     # list turns every builder you forgot into
                                     # a NameError and a wasted round trip
    td.dashboard(
        "output/dashboard.html",
        title="Umsatz 2023–2025",
        subtitle="Quartalszahlen, Stand 03/2026",
        kpis=[td.kpi("Nettoumsatz", "45,2 Mio. €", "+3,1 %", "up")],
        charts=[
            td.chart("trend", "Entwicklung", td.line(quarters, {"Ist": ist, "Plan": plan}), span=2),
            td.chart("top", "Top-Kunden", td.hbar(names, values)),
        ],
    )

Single-series builders (bar, hbar, area, pie, histogram) take a flat sequence of
numbers; multi-series builders (line, grouped_bar, stacked_bar, radar) take a
{"name": [numbers]} mapping. Colour is not yours to set — see the Colour section.

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
# Colour
# --------------------------------------------------------------------------
# Colours are emitted as TOKENS ("@series1", "@critical", …) and resolved to hex
# in the browser against the viewer's colour scheme. Baking hex here cannot work:
# a palette stepped for a white card is wrong on a dark one, and the page does
# not know which it will be rendered on until it loads.
#
# The hex behind each token is the validated categorical palette from the dataviz
# reference — eight fixed hues in a fixed order, each mode stepped for its own
# surface. Both columns clear the colourblind-separation, normal-vision,
# lightness-band and chroma gates (`validate_palette.js`); the light column has
# three slots under 3:1 contrast, which is why bar/pie marks carry direct labels.
#
# Rules that come with it, and that the builders below enforce:
#   - categorical hues are assigned in fixed order and NEVER cycled;
#   - magnitude uses one hue light->dark (`@seq*`), never a rainbow;
#   - status colours (@good/@critical) are reserved and never used as "series 4";
#   - text wears ink tokens, never the series colour.
ACCENT = "@series1"
MUTED = "@muted"
POSITIVE = "@good"
NEGATIVE = "@critical"
SURFACE = "@surface"
PALETTE = [f"@series{i}" for i in range(1, 9)]

# Resolved in the page. Keep in sync with references/palette.md.
_TOKENS = {
    "light": {
        "series": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
                   "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
        "seq": ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#184f95"],
        "good": "#0ca30c", "warning": "#fab219", "critical": "#d03b3b",
        "surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e",
        "muted": "#898781", "grid": "#e1e0d9", "base": "#c3c2b7",
    },
    "dark": {
        "series": ["#3987e5", "#d95926", "#199e70", "#c98500",
                   "#d55181", "#008300", "#9085e9", "#e66767"],
        "seq": ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#9ec5f4"],
        "good": "#0ca30c", "warning": "#fab219", "critical": "#d03b3b",
        "surface": "#1a1a19", "ink": "#ffffff", "ink2": "#c3c2b7",
        "muted": "#898781", "grid": "#2c2c2a", "base": "#383835",
    },
}


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
    for s in series:
        _check_numeric(cid, s.get("name"), s.get("data"))


_NUMERIC_SERIES = {None, "line", "bar", "scatter", "effectScatter", "pie",
                   "funnel", "gauge", "radar", "heatmap", "treemap"}


def _check_numeric(cid: str, name: Any, data: Any) -> None:
    """Reject string values in a numeric series.

    ECharts does not error on `data: ["Umsatz", "DB1"]` — it draws nothing, and a
    silently empty chart is the single hardest failure to notice. It happens when
    a mapping is iterated where a flat sequence was expected (iterating a dict or
    a DataFrame yields its KEYS), so the values become column names.
    """
    if not isinstance(data, (list, tuple)):
        return
    for v in data:
        if isinstance(v, Mapping):
            v = v.get("value")
        if isinstance(v, (list, tuple)):
            continue  # coordinate pair / box summary
        if isinstance(v, str):
            raise ValueError(
                f"{cid}: series {name!r} has the string {v!r} where a number belongs. "
                f"This usually means a dict or DataFrame was iterated instead of its "
                f"values (that yields the KEYS) — pass the list of numbers, e.g. "
                f"list(df['Umsatz']) or data['values']. ECharts would draw an empty "
                f"chart without complaining."
            )


def _pad(values: Sequence[Any], n: int) -> list[Any]:
    out = list(values)
    return out + [None] * (n - len(out)) if len(out) < n else out


def _flat(values: Any, *, who: str) -> list[Any]:
    """Coerce a one-series argument to a flat list.

    A mapping here is the commonest call-site mistake — `bar(names, {"Marge": xs})`
    is a grouped_bar call. Unwrap the single-series case rather than silently
    iterating the keys; refuse the ambiguous one.
    """
    if isinstance(values, Mapping):
        if len(values) == 1:
            return list(next(iter(values.values())))
        raise TypeError(
            f"{who}() takes one flat sequence of numbers, but got a mapping with "
            f"{len(values)} series ({', '.join(map(str, values))}). Use grouped_bar() "
            f"or stacked_bar() for several series."
        )
    return list(values)


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
    # Axis ink, gridlines and tick marks come from the registered theme so every
    # chart on the page recedes identically. Only structure lives here.
    return {
        "xAxis": {"type": "category", "data": list(categories), "name": x_name,
                  "boundaryGap": True},
        "yAxis": {"type": "value", "name": y_name},
    }


def _base(title="", *, legend=True, trigger="axis"):
    opt: dict[str, Any] = {
        "tooltip": {"trigger": trigger},
        "grid": {"left": 60, "right": 28, "top": 46, "bottom": 40, "containLabel": True},
    }
    if title:
        opt["title"] = {"text": title, "left": "center"}
    if legend:
        opt["legend"] = {"top": 4, "icon": "roundRect", "itemHeight": 8, "itemWidth": 14}
    return opt


def _legend_if_multi(opt: dict, series: list) -> dict:
    """A legend is mandatory for >=2 series and noise for one — the card title
    already names a lone series."""
    if len(series) < 2:
        opt.pop("legend", None)
    return opt


def line(categories, series, *, y_name="", smooth=True, area_first=False):
    """Trend over an ordered axis. `series` is {"name": [values]}."""
    n = len(list(categories))
    out = _base(legend=True) | _axes(categories, y_name)
    built = []
    for i, s in enumerate(_series_map(series)):
        s = {"type": "line", "smooth": smooth, "symbolSize": 8, **s}
        s["data"] = _pad(s.get("data") or [], n)
        # 2px marks throughout: the data should not be the heaviest ink by weight,
        # only by contrast.
        s["lineStyle"] = {"width": 2, **s.get("lineStyle", {})}
        if area_first and i == 0:
            s["areaStyle"] = {"opacity": 0.14}
        built.append(s)
    out["series"] = built
    return _legend_if_multi(out, built)


def area(categories, name, values, *, y_name=""):
    """One emphasised series over time, with a soft fill."""
    opt = _base(legend=False) | _axes(categories, y_name)
    opt["series"] = [{
        "name": name, "type": "line", "smooth": True, "showSymbol": False,
        "data": _pad(_flat(values, who="area"), len(list(categories))),
        "lineStyle": {"width": 2},
        "areaStyle": {"opacity": 0.18},
    }]
    return opt


def bar(categories, values, *, name="", y_name="", sort=False, highlight=None,
        label=True):
    """Compare a measure across categories. `highlight` is an index or category
    name to accent while the rest recede to muted."""
    cats, vals = list(categories), _flat(values, who="bar")
    if sort:
        pairs = sorted(zip(cats, vals), key=lambda p: (p[1] is None, -(p[1] or 0)))
        cats, vals = [p[0] for p in pairs], [p[1] for p in pairs]
    hi = cats.index(highlight) if isinstance(highlight, str) and highlight in cats else highlight
    data = [
        {"value": v, "itemStyle": {"color": ACCENT if hi is None or i == hi else MUTED}}
        for i, v in enumerate(vals)
    ]
    opt = _base(legend=False) | _axes(cats, y_name)
    opt["series"] = [{
        "name": name, "type": "bar", "data": data, "barMaxWidth": 44,
        # Rounded data-end anchored to the baseline; the other two corners stay
        # square so the bar still reads as measured from zero.
        "itemStyle": {"borderRadius": [4, 4, 0, 0]},
        # Direct labels are the relief for the light-mode slots that sit under
        # 3:1 against the card — identity must not rest on colour alone.
        "label": {"show": label, "position": "top", "color": "@ink2"},
    }]
    return opt


def hbar(categories, values, *, name="", x_name="", top=None):
    """Ranking with many or long labels — horizontal, largest at the top."""
    pairs = sorted(zip(categories, _flat(values, who="hbar")),
                   key=lambda p: (p[1] is None, p[1] or 0))
    if top:
        pairs = pairs[-top:]
    opt = _base(legend=False)
    opt["xAxis"] = {"type": "value", "name": x_name}
    opt["yAxis"] = {"type": "category", "data": [p[0] for p in pairs]}
    opt["series"] = [{
        "name": name, "type": "bar", "data": [p[1] for p in pairs],
        "barMaxWidth": 22, "itemStyle": {"color": ACCENT, "borderRadius": [0, 4, 4, 0]},
        "label": {"show": True, "position": "right", "color": "@ink2"},
    }]
    opt["grid"]["left"] = 24
    return opt


def grouped_bar(categories, series, *, y_name="", sort=False):
    """Same measure across categories, split into side-by-side groups.
    `sort=True` orders the categories by the first series, descending."""
    cats = list(categories)
    built = _series_map(series)
    n = len(cats)
    for s in built:
        s["data"] = _pad(s.get("data") or [], n)
    if sort and built:
        order = sorted(range(n), key=lambda i: (built[0]["data"][i] is None,
                                                -(built[0]["data"][i] or 0)))
        cats = [cats[i] for i in order]
        for s in built:
            s["data"] = [s["data"][i] for i in order]
    opt = _base() | _axes(cats, y_name)
    opt["series"] = [
        {"type": "bar", "barMaxWidth": 30,
         "itemStyle": {"borderRadius": [4, 4, 0, 0]}, **s}
        for s in built
    ]
    return _legend_if_multi(opt, built)


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
        # A 2px ring in the surface colour separates adjacent segments, so the
        # boundary is structural rather than a hue change the eye has to find.
        {"type": "bar", "stack": "total", "barMaxWidth": 44,
         "itemStyle": {"borderColor": SURFACE, "borderWidth": 2}, **s}
        for s in built
    ]
    return _legend_if_multi(opt, built)


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
    opt["xAxis"] = {"type": "value", "name": x_name}
    opt["yAxis"] = {"type": "value", "name": y_name}
    opt["series"] = [{"name": name, "type": "scatter", "data": data,
                      "symbolSize": 12 if sizes is None else None,
                      # A surface-coloured ring keeps overlapping dots readable.
                      "itemStyle": {"opacity": 0.85, "borderColor": SURFACE,
                                    "borderWidth": 2}}]
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
            "textStyle": {"color": "@ink2"},
            # Magnitude is one hue, light -> dark. A rainbow ramp invents
            # category boundaries the data does not have.
            "inRange": {"color": ["@seq1", "@seq2", "@seq3", "@seq4", "@seq5"]},
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
    vals = _flat(values, who="pie")
    if len(vals) > 6:
        raise ValueError(
            f"pie(): {len(vals)} slices. A pie stops being readable past ~5 — use "
            f"hbar() for a ranking, or fold the tail into 'Sonstige'."
        )
    return {
        "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
        "legend": {"bottom": 0, "icon": "roundRect", "itemHeight": 8, "itemWidth": 14},
        "series": [{
            "name": name, "type": "pie",
            "radius": ["48%", "70%"] if inner else "64%",
            "center": ["50%", "46%"],
            "avoidLabelOverlap": True,
            "itemStyle": {"borderColor": SURFACE, "borderWidth": 2},
            "label": {"formatter": "{b}\n{d}%", "color": "@ink2"},
            "data": [{"name": n, "value": v} for n, v in zip(labels, vals)],
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
        "tooltip": {},
        "legend": {"top": 4, "icon": "roundRect", "itemHeight": 8, "itemWidth": 14},
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
            "splitLine": {"length": 10, "lineStyle": {"color": "@base"}},
            "pointer": {"width": 5},
            "detail": {"valueAnimation": True, "formatter": f"{{value}}{unit}",
                       "fontSize": 28, "offsetCenter": [0, "70%"], "color": "@ink"},
            "title": {"offsetCenter": [0, "95%"], "color": "@ink2"},
            "itemStyle": {"color": ACCENT},
            "data": [{"value": value, "name": name}],
        }],
    }


def funnel(stages, values, *, name=""):
    """Stage-by-stage drop-off (pipeline, conversion)."""
    return {
        "tooltip": {"trigger": "item", "formatter": "{b}: {c}"},
        "legend": {"bottom": 0, "icon": "roundRect", "itemHeight": 8, "itemWidth": 14},
        "series": [{
            "name": name, "type": "funnel", "left": "10%", "width": "80%",
            "top": 30, "bottom": 40, "sort": "descending", "gap": 3,
            "itemStyle": {"borderColor": SURFACE, "borderWidth": 2},
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
         "itemStyle": {"color": SURFACE, "borderColor": ACCENT, "borderWidth": 2}},
        {"name": "Ausreißer", "type": "scatter", "data": outliers,
         "symbolSize": 8, "itemStyle": {"color": NEGATIVE, "opacity": 0.85}},
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
                      "itemStyle": {"color": ACCENT, "borderRadius": [4, 4, 0, 0]}}]
    return opt


def treemap(nodes, *, name=""):
    """Hierarchy of parts. `nodes` is [{"name": .., "value": ..,
    "children": [...]}, ...] — nesting optional."""
    return {
        "tooltip": {"trigger": "item"},
        "series": [{
            "name": name, "type": "treemap", "roam": False, "width": "96%", "height": "90%",
            "breadcrumb": {"show": False},
            "label": {"show": True, "formatter": "{b}\n{c}"},
            "itemStyle": {"borderColor": SURFACE, "borderWidth": 2, "gapWidth": 2},
            "data": list(nodes),
        }],
    }


def sankey(nodes, links):
    """Flow between stages. `nodes` is ["A", "B", ...] (or dicts);
    `links` is [(source, target, value), ...]."""
    node_dicts = [n if isinstance(n, Mapping) else {"name": n} for n in nodes]
    return {
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


# Surfaces and ink match the tokens the charts resolve against — the card colour
# IS the validator's surface, so a palette that passes contrast on paper passes
# on the page. `data-theme` (a viewer toggle) must beat the OS media query in
# both directions, hence the :not() guard.
CSS = """
:root{--bg:#f9f9f7;--card:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e1e0d9;
--accent:#2a78d6;--up:#006300;--down:#d03b3b;--radius:14px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
--bg:#0d0d0d;--card:#1a1a19;--fg:#ffffff;--muted:#c3c2b7;--line:#2c2c2a;
--accent:#3987e5;--up:#0ca30c;--down:#d03b3b}}
:root[data-theme="dark"]{--bg:#0d0d0d;--card:#1a1a19;--fg:#ffffff;--muted:#c3c2b7;
--line:#2c2c2a;--accent:#3987e5;--up:#0ca30c;--down:#d03b3b}
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
.kpi-value{font-size:1.7rem;font-weight:600;letter-spacing:-.02em;color:var(--fg)}
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
  var TOKENS = {_js(_TOKENS)};
  var VENDOR_THEME = {_js(theme)};
  var SPECS = {specs};
  var instances = [];

  function mode() {{
    var stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark' || stamped === 'light') return stamped;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }}

  // Colours arrive as tokens ("@series1", "@surface") and are resolved here,
  // against the mode the page is actually being viewed in. Baking hex at build
  // time cannot work: a palette stepped for a white card is wrong on a dark one.
  function resolve(value, t) {{
    if (typeof value === 'string') {{
      if (value.charAt(0) !== '@') return value;
      var key = value.slice(1);
      var m = /^series(\\d+)$/.exec(key);
      if (m) return t.series[(parseInt(m[1], 10) - 1) % t.series.length];
      m = /^seq(\\d+)$/.exec(key);
      if (m) return t.seq[Math.min(parseInt(m[1], 10) - 1, t.seq.length - 1)];
      return key in t ? t[key] : value;
    }}
    if (Array.isArray(value)) return value.map(function (v) {{ return resolve(v, t); }});
    if (value && typeof value === 'object') {{
      var out = {{}};
      for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) {{
        out[k] = resolve(value[k], t);
      }}
      return out;
    }}
    return value;
  }}

  // Chart chrome (axis ink, gridlines, tooltip, legend) lives in a registered
  // theme rather than in every option object: one definition, and the emitted
  // JSON stays small.
  function registerTheme(t) {{
    echarts.registerTheme('talos', {{
      color: t.series,
      backgroundColor: 'transparent',
      textStyle: {{fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
                   color: t.ink2}},
      title: {{textStyle: {{color: t.ink, fontWeight: 600}}}},
      legend: {{textStyle: {{color: t.ink2}}}},
      categoryAxis: {{
        axisLine: {{lineStyle: {{color: t.base}}}},
        axisTick: {{show: false}},
        axisLabel: {{color: t.muted}},
        splitLine: {{show: false}},
        nameTextStyle: {{color: t.muted}}
      }},
      valueAxis: {{
        axisLine: {{show: false}},
        axisTick: {{show: false}},
        axisLabel: {{color: t.muted}},
        splitLine: {{lineStyle: {{color: t.grid}}}},
        nameTextStyle: {{color: t.muted}}
      }},
      tooltip: {{
        backgroundColor: t.surface, borderColor: t.grid, borderWidth: 1,
        textStyle: {{color: t.ink}},
        axisPointer: {{lineStyle: {{color: t.base}}, crossStyle: {{color: t.base}}}}
      }}
    }});
  }}

  var live = {{}};   // id -> instance, for charts that have actually been drawn

  function drawOne(spec, t) {{
    var el = document.getElementById(spec.id);
    // A container with no width yet (collapsed preview panel, hidden tab,
    // display:none ancestor) cannot be laid out: some series types throw during
    // layout and the chart stays dead for the life of the page. Wait for width
    // instead — the ResizeObserver below calls back the moment it arrives.
    if (!el || !el.clientWidth) return;
    try {{
      if (live[spec.id]) {{ live[spec.id].dispose(); delete live[spec.id]; }}
      var inst = echarts.init(el, VENDOR_THEME || 'talos', {{renderer: 'canvas'}});
      var opt = resolve(spec.option, t);
      // Entry animation is not decorative here, it is a correctness hazard: the
      // first paint of an animated series is driven by animation frames, and a
      // hidden iframe or background tab suspends those. Sankey in particular
      // does its LAYOUT in that pass and throws asynchronously — past any
      // try/catch — leaving a permanently blank card with no message. Rendering
      // synchronously costs a fade nobody asked for and makes failures catchable.
      if (opt.animation === undefined) opt.animation = false;
      inst.setOption(opt);
      live[spec.id] = inst;
      instances = Object.keys(live).map(function (k) {{ return live[k]; }});
    }} catch (e) {{
      console.error(spec.id, e);
      el.innerHTML = '<p class="chart-error">Chart ' + spec.id + ' failed: ' + e.message + '</p>';
    }}
  }}

  function draw() {{
    var t = TOKENS[mode()];
    registerTheme(t);
    SPECS.forEach(function (spec) {{ drawOne(spec, t); }});
  }}

  draw();

  if (typeof ResizeObserver === 'function') {{
    var ro = new ResizeObserver(function (entries) {{
      var t = TOKENS[mode()];
      entries.forEach(function (entry) {{
        var id = entry.target.id;
        if (!entry.contentRect.width) return;
        if (live[id]) live[id].resize();
        else drawOne(SPECS.filter(function (s) {{ return s.id === id; }})[0], t);
      }});
    }});
    SPECS.forEach(function (s) {{
      var el = document.getElementById(s.id);
      if (el) ro.observe(el);
    }});
  }}

  // Belt and braces for the deferred case. ResizeObserver delivery is tied to
  // the rendering lifecycle, which a hidden iframe or a background tab can
  // suspend entirely — so never let it be the ONLY thing that can start a
  // chart. draw() only touches charts that aren't live yet, so re-running it is
  // cheap and idempotent.
  addEventListener('resize', function () {{
    Object.keys(live).forEach(function (k) {{ live[k].resize(); }});
    if (Object.keys(live).length < SPECS.length) draw();
  }});
  addEventListener('load', draw);
  document.addEventListener('visibilitychange', function () {{
    if (!document.hidden) draw();
  }});
  [120, 500, 1500].forEach(function (ms) {{
    setTimeout(function () {{ if (Object.keys(live).length < SPECS.length) draw(); }}, ms);
  }});

  // Dark mode is a redraw, not a CSS flip — the palette steps differ per surface.
  var mq = matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(draw);
  new MutationObserver(draw).observe(document.documentElement,
    {{attributes: true, attributeFilter: ['data-theme']}});
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
