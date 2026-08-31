"""Dashboard scaffold for the Talos sandbox.

The *chrome* of a dashboard — the HTML shell, the inlined chart bundle, the
grid, the KPI tiles, light/dark theming, per-chart error isolation, resize
handling — is identical every single time and carries no information about the
user's question. Regenerating it per request is the dominant cost of a dashboard
turn, so it lives here instead.

What stays free is the part that should vary: which charts, and what data. Build
chart specs with the catalog below and pass them to `dashboard()`.

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

Each builder returns a plain dict — a *spec*, not a finished chart. The browser
half of this scaffold (TanStack Charts, bundled into /opt/talos/vendor by the
image build) turns a spec into marks, scales and guides. The split exists
because a chart definition is made of functions and JSON cannot carry one: every
knob a spec exposes is listed under its builder, and `check_spec` rejects the
ones that are not.

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
BUNDLE = VENDOR / "talos-charts.js"

__all__ = [
    "dashboard", "render", "chart", "kpi", "check_spec", "check_option",
    "line", "area", "bar", "hbar", "grouped_bar", "stacked_bar", "waterfall",
    "scatter", "heatmap", "pie", "donut", "radar", "gauge", "funnel",
    "boxplot", "histogram", "treemap", "sankey", "fmt",
    "lollipop", "dumbbell", "slope", "stacked_area", "range_area", "timeline",
    "calendar", "mosaic", "waffle", "violin",
]

# --------------------------------------------------------------------------
# Colour
# --------------------------------------------------------------------------
# Colours are emitted as TOKENS ("@series1", "@critical", …) and resolved in the
# browser to CSS custom properties, which the page defines twice — once for a
# light card, once for a dark one. Baking hex here cannot work: a palette stepped
# for a white card is wrong on a dark one, and the page does not know which it
# will be rendered on until it loads.
#
# The hex behind each token is the validated categorical palette from the dataviz
# reference — eight fixed hues in a fixed order, each mode stepped for its own
# surface. Both columns clear the colourblind-separation, normal-vision,
# lightness-band and chroma gates; the light column has three slots under 3:1
# contrast, which is why bar and pie marks carry direct labels.
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

# Resolved in the page as CSS variables. Keep in sync with references/palette.md.
_TOKENS = {
    "light": {
        "s": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
              "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
        "q": ["#cde2fb", "#9ec5f4", "#5598e7", "#2a78d6", "#184f95"],
        "good": "#0ca30c", "warning": "#fab219", "critical": "#d03b3b",
        "surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e",
        "muted": "#898781", "grid": "#e1e0d9", "base": "#c3c2b7",
    },
    "dark": {
        "s": ["#3987e5", "#d95926", "#199e70", "#c98500",
              "#d55181", "#008300", "#9085e9", "#e66767"],
        "q": ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#9ec5f4"],
        "good": "#0ca30c", "warning": "#fab219", "critical": "#d03b3b",
        "surface": "#1a1a19", "ink": "#ffffff", "ink2": "#c3c2b7",
        "muted": "#898781", "grid": "#2c2c2a", "base": "#383835",
    },
}


def fmt(*, unit: str = "", decimals: int | None = None, compact: bool = False,
        percent: bool = False) -> dict:
    """A number format for an axis, a data label and the tooltip at once.

    `compact` is `Intl` compact notation, which is locale-dependent and not a
    thousands suffix: German has no short form below a million, so 412.000 stays
    412.000 while 4.100.000 becomes "4,1 Mio.".
    """
    out: dict[str, Any] = {}
    if unit:
        out["unit"] = unit
    if decimals is not None:
        out["decimals"] = int(decimals)
    if compact:
        out["compact"] = True
    if percent:
        out["percent"] = True
    return out


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
_TYPES = {
    "line", "area", "bar", "hbar", "grouped_bar", "stacked_bar", "waterfall",
    "scatter", "heatmap", "pie", "donut", "radar", "gauge", "funnel",
    "boxplot", "histogram", "treemap", "sankey",
    "lollipop", "dumbbell", "slope", "stacked_area", "range_area", "timeline",
    "calendar", "mosaic", "waffle", "violin",
}

# Keys any spec may carry, on top of the ones its own type defines. Unknown keys
# are rejected rather than ignored: a misspelled option that silently does
# nothing is a chart that looks configured and is not.
_COMMON = {"type", "x", "y", "legend", "value_format", "note"}

_OWN = {
    "line": {"categories", "series", "smooth", "area_first", "rolling"},
    "area": {"categories", "values", "name"},
    "bar": {"categories", "values", "name", "highlight", "label"},
    "hbar": {"categories", "values", "name"},
    "grouped_bar": {"categories", "series"},
    "stacked_bar": {"categories", "series", "percent"},
    "waterfall": {"bars"},
    "scatter": {"points", "sizes", "labels", "name", "trend"},
    "heatmap": {"x_labels", "y_labels", "cells", "unit", "low", "high"},
    "pie": {"labels", "values", "name"},
    "donut": {"labels", "values", "name"},
    "radar": {"indicators", "series", "maxes"},
    "gauge": {"value", "target", "unit", "name"},
    "funnel": {"stages", "values", "name"},
    "boxplot": {"categories", "groups"},
    "histogram": {"bins"},
    "treemap": {"nodes", "name"},
    "sankey": {"nodes", "links"},
    "lollipop": {"categories", "values"},
    "dumbbell": {"categories", "series"},
    "slope": {"labels", "before", "after", "before_name", "after_name"},
    "stacked_area": {"categories", "series", "percent", "stream"},
    "range_area": {"categories", "low", "high", "line"},
    "timeline": {"tasks"},
    "calendar": {"days", "unit", "low", "high"},
    "mosaic": {"cells", "y_order"},
    "waffle": {"labels", "values", "unit"},
    "violin": {"categories", "groups"},
}

_AXIS_KEYS = {"label", "format", "ticks", "rotate", "min", "max", "min_gap"}


def check_spec(cid: str, spec: Mapping[str, Any]) -> None:
    """Fail loudly in Python rather than silently in the browser.

    Every failure mode below has the same shape: the page still renders, the
    card still has a title, and the chart inside it is empty or wrong. That is
    the one class of bug the reader cannot detect and the author does not see
    without opening the page — so it is worth an exception here.
    """
    kind = spec.get("type")
    if kind not in _TYPES:
        raise ValueError(
            f"{cid}: unknown chart type {kind!r}. Use one of: {', '.join(sorted(_TYPES))}"
        )
    allowed = _COMMON | _OWN[kind]
    unknown = set(spec) - allowed
    if unknown:
        raise ValueError(
            f"{cid}: unknown option(s) {sorted(unknown)} for a {kind} chart. "
            f"Accepted: {sorted(allowed)}. A spec is data, not an escape hatch — "
            f"anything past this list has to change in the runtime."
        )
    for axis in ("x", "y"):
        conf = spec.get(axis)
        if conf is None:
            continue
        if not isinstance(conf, Mapping):
            raise ValueError(f"{cid}: {axis!r} must be a mapping like {{'label': 'Mio. €'}}")
        bad = set(conf) - _AXIS_KEYS
        if bad:
            raise ValueError(f"{cid}: unknown {axis}-axis key(s) {sorted(bad)}; accepted {sorted(_AXIS_KEYS)}")

    cats = spec.get("categories")
    for s in spec.get("series") or []:
        _check_numeric(cid, s.get("name"), s.get("data"))
        if cats is not None and len(s.get("data") or []) != len(cats):
            raise ValueError(
                f"{cid}: series {s.get('name')!r} has {len(s.get('data') or [])} points but "
                f"there are {len(cats)} categories. Pad with None — a short series plots "
                f"against the FIRST categories, it does not align to the right."
            )
    if "values" in spec:
        _check_numeric(cid, spec.get("name") or kind, spec["values"])
        if cats is not None and len(spec["values"]) != len(cats):
            raise ValueError(
                f"{cid}: {len(spec['values'])} values for {len(cats)} categories."
            )
    for band in ("low", "high", "line"):
        if cats is not None and isinstance(spec.get(band), list) \
                and len(spec[band]) != len(cats):
            raise ValueError(
                f"{cid}: {band!r} has {len(spec[band])} values for {len(cats)} categories."
            )
    if kind == "range_area":
        for i, (lo, hi) in enumerate(zip(spec["low"], spec["high"])):
            if lo is not None and hi is not None and hi < lo:
                raise ValueError(
                    f"{cid}: range_area low > high at index {i} ({lo} > {hi}). The band "
                    f"would be drawn inside out — the arguments are (low, high)."
                )


# The old name. The scaffold used to emit ECharts option dicts and the check ran
# over those; keeping the alias means a half-remembered call still works.
check_option = check_spec


def _check_numeric(cid: str, name: Any, data: Any) -> None:
    """Reject string values in a numeric series.

    A chart drawn from `["Umsatz", "DB1"]` is empty, and a silently empty chart
    is the single hardest failure to notice. It happens when a mapping is
    iterated where a flat sequence was expected (iterating a dict or a DataFrame
    yields its KEYS), so the values become column names.
    """
    if not isinstance(data, (list, tuple)):
        return
    for v in data:
        if isinstance(v, str):
            raise ValueError(
                f"{cid}: series {name!r} has the string {v!r} where a number belongs. "
                f"This usually means a dict or DataFrame was iterated instead of its "
                f"values (that yields the KEYS) — pass the list of numbers, e.g. "
                f"list(df['Umsatz']) or data['values']."
            )


def _pad(values: Sequence[Any], n: int) -> list[Any]:
    out = list(values)
    return out + [None] * (n - len(out)) if len(out) < n else out


def _num(values: Sequence[Any]) -> list[Any]:
    """Coerce to plain floats, keeping None. numpy scalars and Decimals do not
    survive `json.dumps` intact, and a Decimal that lands in the page as a
    string draws nothing."""
    out = []
    for v in values:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
        elif isinstance(v, str):
            out.append(v)  # left for _check_numeric to reject with a real message
        else:
            out.append(float(v))
    return out


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


def _series_map(series: Any, n: int) -> list[dict]:
    """Accept {"name": [...]} or [{"name": .., "data": [..]}, ...]."""
    if isinstance(series, Mapping):
        built = [{"name": str(k), "data": list(v)} for k, v in series.items()]
    else:
        built = [{"name": str(s["name"]), "data": list(s.get("data") or [])} for s in series]
    for s in built:
        s["data"] = _num(_pad(s["data"], n))
    return built


def _axis(label: str = "", **rest) -> dict:
    out = {k: v for k, v in rest.items() if v not in (None, "")}
    if label:
        out["label"] = label
    return out


# --------------------------------------------------------------------------
# Chart catalog
# --------------------------------------------------------------------------
# Each builder returns a plain spec dict — edit it in place before handing it to
# `chart()`. They exist so that reaching for a heatmap, a sankey or a waterfall
# costs the same as reaching for a bar chart; a dashboard of three bar charts is
# a sign the alternatives were expensive, not that bars were right.
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


def line(categories, series, *, y_name="", x_name="", smooth=True,
         area_first=False, rolling=None, value_format=None):
    """Trend over an ordered axis. `series` is {"name": [values]}.

    `rolling=7` adds a moving average over each series and fades the raw line
    behind it — the right answer for noisy daily data, where the raw line is
    unreadable and a smoothed line alone hides how noisy it was.
    """
    cats = [str(c) for c in categories]
    spec = {
        "type": "line",
        "categories": cats,
        "series": _series_map(series, len(cats)),
        "x": _axis(x_name),
        "y": _axis(y_name, format=value_format),
        "smooth": bool(smooth),
        "area_first": bool(area_first),
    }
    if rolling:
        spec["rolling"] = int(rolling)
    return spec


def area(categories, name, values, *, y_name="", x_name="", value_format=None):
    """One emphasised series over time, with a soft fill."""
    cats = [str(c) for c in categories]
    return {
        "type": "area",
        "categories": cats,
        "name": str(name),
        "values": _num(_pad(_flat(values, who="area"), len(cats))),
        "x": _axis(x_name),
        "y": _axis(y_name, format=value_format),
    }


def bar(categories, values, *, name="", y_name="", x_name="", sort=False,
        highlight=None, label=True, value_format=None):
    """Compare a measure across categories. `highlight` is an index or category
    name to accent while the rest recede to muted."""
    cats, vals = [str(c) for c in categories], _num(_flat(values, who="bar"))
    if sort:
        pairs = sorted(zip(cats, vals), key=lambda p: (p[1] is None, -(p[1] or 0)))
        cats, vals = [p[0] for p in pairs], [p[1] for p in pairs]
    return {
        "type": "bar",
        "categories": cats,
        "values": vals,
        "name": str(name),
        "highlight": str(highlight) if isinstance(highlight, str) else highlight,
        "label": bool(label),
        "x": _axis(x_name),
        "y": _axis(y_name, format=value_format),
    }


def hbar(categories, values, *, name="", x_name="", top=None, value_format=None):
    """Ranking with many or long labels — horizontal, largest at the top."""
    pairs = sorted(zip([str(c) for c in categories], _num(_flat(values, who="hbar"))),
                   key=lambda p: (p[1] is None, -(p[1] or 0)))
    if top:
        pairs = pairs[:top]
    return {
        "type": "hbar",
        # The band axis runs top-to-bottom, so the largest value has to be the
        # first entry of the domain for the ranking to read downward.
        "categories": [p[0] for p in pairs],
        "values": [p[1] for p in pairs],
        "name": str(name),
        "x": _axis(x_name, format=value_format),
        "y": _axis(),
    }


def grouped_bar(categories, series, *, y_name="", x_name="", sort=False,
                value_format=None):
    """Same measure across categories, split into side-by-side groups.
    `sort=True` orders the categories by the first series, descending."""
    cats = [str(c) for c in categories]
    built = _series_map(series, len(cats))
    if sort and built:
        first = built[0]["data"]
        order = sorted(range(len(cats)), key=lambda i: (first[i] is None, -(first[i] or 0)))
        cats = [cats[i] for i in order]
        for s in built:
            s["data"] = [s["data"][i] for i in order]
    return {
        "type": "grouped_bar",
        "categories": cats,
        "series": built,
        "x": _axis(x_name),
        "y": _axis(y_name, format=value_format),
    }


def stacked_bar(categories, series, *, y_name="", x_name="", percent=False,
                value_format=None):
    """Composition over time. `percent=True` normalises each column to 100%."""
    cats = [str(c) for c in categories]
    built = _series_map(series, len(cats))
    if percent:
        totals = [sum((s["data"][i] or 0) for s in built) for i in range(len(cats))]
        for s in built:
            s["data"] = [
                None if v is None else (100.0 * v / totals[i] if totals[i] else 0.0)
                for i, v in enumerate(s["data"])
            ]
    return {
        "type": "stacked_bar",
        "categories": cats,
        "series": built,
        "percent": bool(percent),
        "x": _axis(x_name),
        # Percent mode owns the axis: the ticks already carry "%", so a "%"
        # axis title would say it twice, and the domain is pinned to 0–100 so
        # every column is read against the same whole.
        "y": _axis("" if percent else y_name,
                   format=fmt(percent=True) if percent else value_format,
                   min=0 if percent else None, max=100 if percent else None),
    }


def waterfall(labels, deltas, *, start=0.0, y_name="", total_label="Gesamt",
              value_format=None):
    """What drove the change between two numbers: signed contributions plus a
    closing total. Far more informative than the bar chart it usually loses to."""
    bars = []
    running = float(start)
    if start:
        bars.append({"label": "Start", "y1": 0.0, "y2": running,
                     "delta": running, "role": "total"})
    for label, d in zip(labels, deltas):
        d = float(d or 0)
        bars.append({
            "label": str(label),
            "y1": running,
            "y2": running + d,
            "delta": d,
            "role": "rise" if d >= 0 else "fall",
        })
        running += d
    bars.append({"label": str(total_label), "y1": 0.0, "y2": running,
                 "delta": running, "role": "total"})
    return {
        "type": "waterfall",
        "bars": bars,
        "x": _axis(),
        "y": _axis(y_name, format=value_format),
    }


def scatter(points, *, x_name="", y_name="", name="", sizes=None, labels=None,
            trend=False):
    """Relationship between two measures. `points` is [(x, y), ...].

    `sizes=` turns it into a bubble chart (a third measure per point).
    `trend=True` overlays a least-squares fit with a 95 % band — say so in the
    card `note=` when you do: a fit line is a claim, not a measurement.
    """
    return {
        "type": "scatter",
        "points": [[float(x), float(y)] for x, y in points],
        "sizes": [float(s) for s in sizes] if sizes is not None else None,
        "labels": [str(v) for v in labels] if labels is not None else None,
        "name": str(name),
        "trend": bool(trend),
        "x": _axis(x_name),
        "y": _axis(y_name),
    }


def heatmap(x_labels, y_labels, values, *, unit="", low=None, high=None,
            value_format=None):
    """Two categorical dimensions against one measure.
    `values` is a 2-D list indexed [y][x], or a list of (xi, yi, v) triples."""
    xs = [str(v) for v in x_labels]
    ys = [str(v) for v in y_labels]
    values = list(values)
    rows, cols = len(ys), len(xs)
    # Matrix or triples? Shape decides, not the width of the first row: a 2-D
    # grid that happens to be three columns wide used to be read as a list of
    # (x, y, v) triples and drew three cells out of six.
    is_matrix = (len(values) == rows
                 and all(isinstance(r, (list, tuple)) and len(r) == cols for r in values))
    if is_matrix:
        cells = [[xi, yi, None if v is None else float(v)]
                 for yi, row in enumerate(values) for xi, v in enumerate(row)]
    else:
        cells = [[int(a), int(b), None if c is None else float(c)] for a, b, c in values]
    return {
        "type": "heatmap",
        "x_labels": xs,
        "y_labels": ys,
        "cells": cells,
        "unit": unit,
        "low": low,
        "high": high,
        "value_format": value_format,
    }


def pie(labels, values, *, inner=False, name="", value_format=None):
    """Composition at one moment. Keep it to <=5 slices; past that a bar wins."""
    vals = _num(_flat(values, who="pie"))
    if len(vals) > 6:
        raise ValueError(
            f"pie(): {len(vals)} slices. A pie stops being readable past ~5 — use "
            f"hbar() for a ranking, or fold the tail into 'Sonstige'."
        )
    if any(v is not None and v < 0 for v in vals):
        raise ValueError("pie(): negative values have no share of a whole. Use bar().")
    return {
        "type": "donut" if inner else "pie",
        "labels": [str(v) for v in labels],
        "values": vals,
        "name": str(name),
        "value_format": value_format,
    }


def donut(labels, values, **kw):
    return pie(labels, values, inner=True, **kw)


def radar(indicators, series, *, maxes=None):
    """Several metrics compared across a few entities.
    `indicators` are metric names; `series` is {"entity": [values]}."""
    names = [str(v) for v in indicators]
    built = _series_map(series, len(names))
    if maxes is None:
        # Each axis is scaled by its own maximum. A radar over raw units puts
        # millimetres and millions on the same radius and draws a spike that
        # means nothing.
        maxes = [
            max((s["data"][i] or 0) for s in built) * 1.15 or 1
            for i in range(len(names))
        ]
    return {
        "type": "radar",
        "indicators": names,
        "series": built,
        "maxes": [float(m) or 1.0 for m in maxes],
    }


def gauge(value, *, name="", target=100, unit="%", value_format=None):
    """One ratio against a target. A KPI tile is usually better — use this when
    the distance to the target is the point."""
    return {
        "type": "gauge",
        "value": float(value),
        "target": float(target),
        "unit": unit,
        "name": str(name),
        "value_format": value_format,
    }


def funnel(stages, values, *, name="", value_format=None):
    """Stage-by-stage drop-off (pipeline, conversion)."""
    return {
        "type": "funnel",
        "stages": [str(v) for v in stages],
        "values": _num(_flat(values, who="funnel")),
        "name": str(name),
        "value_format": value_format,
    }


def boxplot(categories, groups, *, y_name="", value_format=None):
    """Spread and outliers per category. `groups` is a list of raw value lists —
    never summarise a distribution to a mean and hide the shape. Quartiles,
    Tukey fences and outliers are computed in the browser from these raw
    observations, so the box on the page and the numbers in the frame cannot
    drift apart."""
    return {
        "type": "boxplot",
        "categories": [str(c) for c in categories],
        "groups": [[float(v) for v in raw if v is not None] for raw in groups],
        "x": _axis(),
        "y": _axis(y_name, format=value_format),
    }


def histogram(values, *, bins=20, y_name="Anzahl", x_name=""):
    """Shape of a single distribution."""
    vals = sorted(float(v) for v in values if v is not None)
    if not vals:
        raise ValueError("histogram(): no finite values to bin.")
    lo, hi = vals[0], vals[-1]
    if hi == lo:
        hi = lo + 1
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in vals:
        counts[min(int((v - lo) / width), bins - 1)] += 1
    return {
        "type": "histogram",
        "bins": [[lo + i * width, lo + (i + 1) * width, counts[i]] for i in range(bins)],
        "x": _axis(x_name),
        "y": _axis(y_name),
    }


def lollipop(categories, values, *, x_name="", top=None, value_format=None):
    """A ranking with more categories than bars can carry. Same baseline and the
    same endpoint, a fraction of the ink — reach for it past ~15 rows, where
    stacked bars turn the card into a solid block."""
    spec = hbar(categories, values, x_name=x_name, top=top, value_format=value_format)
    spec["type"] = "lollipop"
    del spec["name"]
    return spec


def dumbbell(categories, series, *, x_name="", sort=True, value_format=None):
    """Two values per category with the GAP as the subject: Ist vs. Plan, 2024
    vs. 2025, vorher vs. nachher. `series` is exactly two {"name": [values]}."""
    cats = [str(c) for c in categories]
    built = _series_map(series, len(cats))
    if len(built) != 2:
        raise ValueError(
            f"dumbbell() compares exactly two values per category, got {len(built)} "
            f"series. Use grouped_bar() for three or more."
        )
    if sort:
        # Ordered by the gap, so the categories that moved most are together at
        # one end — otherwise the reader hunts for them.
        gaps = [abs((built[1]["data"][i] or 0) - (built[0]["data"][i] or 0))
                for i in range(len(cats))]
        order = sorted(range(len(cats)), key=lambda i: -gaps[i])
        cats = [cats[i] for i in order]
        for s in built:
            s["data"] = [s["data"][i] for i in order]
    return {
        "type": "dumbbell",
        "categories": cats,
        "series": built,
        "x": _axis(x_name, format=value_format),
        "y": _axis(),
    }


def slope(labels, before, after, *, before_name="Vorher", after_name="Nachher",
          value_format=None):
    """Level and rank change between exactly two moments. Crossing lines are the
    point — it answers "who overtook whom", which two bar charts side by side
    make the reader work out for themselves."""
    names = [str(v) for v in labels]
    a, b = _num(list(before)), _num(list(after))
    if not (len(a) == len(b) == len(names)):
        raise ValueError(
            f"slope(): {len(names)} labels, {len(a)} before and {len(b)} after values."
        )
    return {
        "type": "slope",
        "labels": names,
        "before": a,
        "after": b,
        "before_name": str(before_name),
        "after_name": str(after_name),
        "y": _axis(format=value_format),
    }


def stacked_area(categories, series, *, y_name="", x_name="", percent=False,
                 stream=False, value_format=None):
    """Composition over a continuous axis. `stacked_bar` is the discrete twin —
    use this one when the x axis is time and the shape of the change matters
    more than any single period. `stream=True` drops the shared baseline for
    readable band thicknesses; only do that when no band's level has to be read
    off the axis."""
    cats = [str(c) for c in categories]
    return {
        "type": "stacked_area",
        "categories": cats,
        "series": _series_map(series, len(cats)),
        "percent": bool(percent),
        "stream": bool(stream),
        "x": _axis(x_name),
        "y": _axis("" if percent else y_name,
                   format=fmt(percent=True) if percent else value_format),
    }


def range_area(categories, low, high, *, line=None, y_name="", x_name="",
               value_format=None):
    """A band between two bounds: forecast ranges, min/max, confidence, best and
    worst case. **This is the honest way to draw a projection** — a single line
    into the future claims a precision the model does not have."""
    cats = [str(c) for c in categories]
    spec = {
        "type": "range_area",
        "categories": cats,
        "low": _num(_pad(_flat(low, who="range_area"), len(cats))),
        "high": _num(_pad(_flat(high, who="range_area"), len(cats))),
        "x": _axis(x_name),
        "y": _axis(y_name, format=value_format),
    }
    if line is not None:
        spec["line"] = _num(_pad(_flat(line, who="range_area"), len(cats)))
    return spec


def timeline(tasks, *, legend=True):
    """Phases, projects or bookings on a real date axis (a Gantt without the
    dependency arrows). `tasks` is [{"label": .., "start": "2026-01-01",
    "end": "2026-03-15", "group": ..}] — ISO dates, `group` optional and used
    only for colour."""
    built = []
    for t in tasks:
        start, end = str(t["start"]), str(t["end"])
        if end < start:
            raise ValueError(
                f"timeline(): {t.get('label')!r} ends {end} before it starts {start}. "
                f"A zero-or-negative interval draws nothing."
            )
        built.append({"label": str(t["label"]), "start": start, "end": end,
                      "group": str(t.get("group") or t["label"])})
    return {"type": "timeline", "tasks": built, "legend": bool(legend)}


def calendar(dates, values, *, unit="", low=None, high=None, value_format=None):
    """Daily activity over weeks or a year — tickets, Umsatz, Fehler pro Tag.
    Weekday-vs-week layout, so weekly rhythms and quiet periods show up as
    stripes. `dates` are ISO "YYYY-MM-DD" strings."""
    import datetime as _dt

    vals = _num(_flat(values, who="calendar"))
    if len(vals) != len(list(dates)):
        raise ValueError("calendar(): one value per date, please.")
    days = []
    for iso, v in zip(dates, vals):
        d = _dt.date.fromisoformat(str(iso))
        year, week, weekday = d.isocalendar()
        # The week key carries the year so a multi-year range does not fold
        # week 3 of 2025 onto week 3 of 2026; the label shown is the month, so
        # the reader gets a calendar rather than week numbers.
        days.append([f"{year}-{week:02d}", weekday - 1, v, d.isoformat()])
    return {
        "type": "calendar",
        "days": days,
        "unit": unit,
        "low": low,
        "high": high,
        "value_format": value_format,
    }


def mosaic(cells, *, y_order=None, value_format=None):
    """Marimekko: column WIDTH is each segment's size, segment HEIGHT is its
    share. One rectangle's area is its absolute contribution — exactly what a
    100 %-stacked bar throws away. Reach for it when "big share of a small
    segment" must not look like "big".

    `cells` is [(segment, part, value), ...]."""
    built = [[str(a), str(b), float(v)] for a, b, v in cells]
    parts = []
    for _, b, _v in built:
        if b not in parts:
            parts.append(b)
    return {
        "type": "mosaic",
        "cells": built,
        "y_order": [str(p) for p in (y_order or parts)],
        "value_format": value_format,
    }


def waffle(labels, values, *, unit=1, value_format=None):
    """Part-to-whole in countable squares. Better than a pie whenever the
    quantity is a count of things (Mitarbeiter, Störungen, Aufträge): the reader
    sees "roughly one in five" without estimating an angle. `unit` is the value
    one square stands for."""
    return {
        "type": "waffle",
        "labels": [str(v) for v in labels],
        "values": _num(_flat(values, who="waffle")),
        "unit": float(unit),
        "value_format": value_format,
    }


def violin(categories, groups, *, y_name="", value_format=None):
    """The shape of a distribution, not just its quartiles — bimodality, a long
    tail, a pile-up at zero. `boxplot` is the safer default; use this when the
    *form* of the spread is the finding. Same input: raw observations."""
    spec = boxplot(categories, groups, y_name=y_name, value_format=value_format)
    spec["type"] = "violin"
    return spec


def treemap(nodes, *, name=""):
    """Hierarchy of parts. `nodes` is [{"path": "Konzern/Nord/Handel",
    "name": "Handel", "value": 42}, ...] — one row per LEAF, with the full
    slash-separated path. Parents are imputed and their value is the sum of
    their children, so passing a parent row as well double-counts it."""
    built = []
    for n in nodes:
        path = str(n["path"] if "path" in n else n["name"])
        built.append({
            "path": path,
            "name": str(n.get("name") or path.rsplit("/", 1)[-1]),
            "value": float(n["value"]),
        })
    return {"type": "treemap", "nodes": built, "name": str(name)}


def sankey(nodes, links):
    """Flow between stages. `nodes` is ["A", "B", ...] or [{"id": .., "label": ..}];
    `links` is [(source, target, value), ...]."""
    built_nodes = []
    for n in nodes:
        if isinstance(n, Mapping):
            nid = str(n.get("id") or n.get("name"))
            built_nodes.append({"id": nid, "label": str(n.get("label") or nid)})
        else:
            built_nodes.append({"id": str(n), "label": str(n)})
    known = {n["id"] for n in built_nodes}
    built_links = []
    for link in links:
        if isinstance(link, Mapping):
            src, dst, val = link["source"], link["target"], link["value"]
        else:
            src, dst, val = link
        for end in (src, dst):
            if str(end) not in known:
                raise ValueError(
                    f"sankey(): link endpoint {end!r} is not one of the nodes "
                    f"({', '.join(sorted(known))}). The layout throws on an unknown "
                    f"endpoint and the card would be blank."
                )
        built_links.append({"source": str(src), "target": str(dst), "value": float(val)})
    return {"type": "sankey", "nodes": built_nodes, "links": built_links}


# --------------------------------------------------------------------------
# Page assembly
# --------------------------------------------------------------------------
def chart(cid: str, title: str, spec: Mapping[str, Any], *, span: int = 1,
          height: int = 340, note: str = "") -> dict:
    """One chart card. `span=2` makes it full width on a two-column grid."""
    return {"id": cid, "title": title, "spec": dict(spec),
            "span": span, "height": height, "note": note}


def kpi(label: str, value: Any, delta: str = "", tone: str = "") -> dict:
    """One headline number. `tone` is "up" | "down" | "" and only colours the
    delta — direction is not goodness, so set it deliberately."""
    return {"label": label, "value": value, "delta": delta, "tone": tone}


def _css() -> str:
    """The page stylesheet, including every colour token the charts resolve
    against.

    Card surfaces and ink are the same tokens the marks use, so the palette that
    passed contrast against a `#fcfcfb` card on paper passes against the card on
    the page. `data-theme` (a viewer toggle) must beat the OS media query in both
    directions, hence the `:not()` guard.
    """
    def block(mode: str) -> str:
        t = _TOKENS[mode]
        parts = [f"--td-s{i + 1}:{c}" for i, c in enumerate(t["s"])]
        parts += [f"--td-q{i + 1}:{c}" for i, c in enumerate(t["q"])]
        parts += [f"--td-{k}:{t[k]}" for k in
                  ("good", "warning", "critical", "surface", "ink", "ink2",
                   "muted", "grid", "base")]
        return ";".join(parts)

    light_page = "--bg:#f9f9f7;--card:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e1e0d9;--up:#006300;--down:#d03b3b"
    dark_page = "--bg:#0d0d0d;--card:#1a1a19;--fg:#ffffff;--muted:#c3c2b7;--line:#2c2c2a;--up:#0ca30c;--down:#d03b3b"
    # A plain template with named placeholders rather than an f-string: CSS is
    # nothing but braces, and every one of them would need doubling.
    return (_CSS_TEMPLATE
            .replace("__LIGHT__", light_page + ";--radius:14px;" + block("light"))
            .replace("__DARK__", dark_page + ";" + block("dark")))


_CSS_TEMPLATE = """
:root{__LIGHT__}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){__DARK__}}
:root[data-theme="dark"]{__DARK__}
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
padding:16px 18px 12px;min-width:0}
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
           subtitle: str = "", footer: str = "", lang: str = "de",
           locale: str = "de-DE") -> str:
    """Build the complete self-contained HTML page."""
    for c in charts:
        check_spec(c["id"], c["spec"])

    if not BUNDLE.is_file():
        raise FileNotFoundError(
            f"{BUNDLE} is missing. The chart runtime is baked into the sandbox image "
            f"at build time (sandbox/Dockerfile) — a dashboard cannot fetch it, the "
            f"workspace has no network."
        )
    runtime = BUNDLE.read_text(encoding="utf-8")

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
        + f'<div class="chart" id="{_esc(c["id"])}"></div></section>'
        for c in charts
    )
    specs = _js([
        {"id": c["id"], "title": c["title"], "height": int(c.get("height", 340)),
         "spec": c["spec"]}
        for c in charts
    ])

    parts = {
        "__LANG__": _esc(lang),
        "__TITLE__": _esc(title),
        "__CSS__": _css(),
        "__RUNTIME__": runtime,
        "__SUB__": f'<div class="sub">{_esc(subtitle)}</div>' if subtitle else "",
        "__KPIS__": f'<div class="kpis">{tiles}</div>' if tiles else "",
        "__CARDS__": cards,
        "__FOOTER__": f"<footer>{_esc(footer)}</footer>" if footer else "",
        "__SPECS__": specs,
        "__LOCALE__": _js(locale),
    }
    html = _PAGE_TEMPLATE
    # The runtime goes in last and its own text is never scanned for markers:
    # 200 KB of minified JS will contain almost anything, and a placeholder that
    # matched inside it would corrupt the library.
    for marker in ("__LANG__", "__TITLE__", "__CSS__", "__SUB__", "__KPIS__",
                   "__CARDS__", "__FOOTER__", "__SPECS__", "__LOCALE__",
                   "__RUNTIME__"):
        html = html.replace(marker, parts[marker])
    return html


# Braces belong to JavaScript here, not to Python: a template plus replacements
# keeps the script readable and removes a whole class of escaping mistake.
_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="__LANG__"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>__CSS__</style>
<script>__RUNTIME__</script>
</head><body>
<header><h1>__TITLE__</h1>
__SUB__</header>
<div class="wrap">
__KPIS__
<div class="grid">__CARDS__</div>
</div>
__FOOTER__
<script>
// Fail loudly if the runtime didn't survive being inlined. A blank dashboard
// with a clean console is the hardest version of this to debug.
if (typeof TalosCharts !== 'object' || typeof TalosCharts.mountAll !== 'function') {
  document.body.insertAdjacentHTML('afterbegin',
    '<p style="background:#fee;color:#900;padding:1rem">The chart runtime did not load: '
    + 'window.TalosCharts is ' + typeof TalosCharts + '. It must be inlined verbatim.</p>');
} else {
  // Each chart is mounted inside its own try/catch: one bad spec must leave a
  // message in its own card and let every later chart draw. The DOM host owns
  // resizing from here — it measures the container and follows it, and falls
  // back to a deterministic width while the card is still hidden, which is
  // where a preview panel starts.
  window.TALOS_CHARTS = TalosCharts.mountAll(__SPECS__, {locale: __LOCALE__});
}
</script>
</body></html>"""


def dashboard(path: str, title: str, charts: Sequence[Mapping[str, Any]],
              kpis: Sequence[Mapping[str, Any]] = (), *,
              subtitle: str = "", footer: str = "", lang: str = "de",
              locale: str = "de-DE", **unsupported) -> str:
    """Render and write the page. Returns the path written."""
    if "theme" in unsupported:
        raise ValueError(
            "dashboard(theme=…) is gone with the ECharts scaffold. The palette is "
            "the validated categorical one and is no longer swappable per page; "
            "accent a single category with bar(highlight=…) instead."
        )
    if unsupported:
        raise TypeError(f"dashboard() got unexpected keyword(s) {sorted(unsupported)}")
    html = render(title, charts, kpis, subtitle=subtitle, footer=footer,
                  lang=lang, locale=locale)
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return str(out)
