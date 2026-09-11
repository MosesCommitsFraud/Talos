"""Build PNG/layout fixtures from the skill's runnable example.

First run dashboard_browser_fixture.py. Put html-to-image.js in that same
runtime directory, then run this script with the directory as its argument.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from sandbox.vendor import talos_dash as td
sys.modules["talos_dash"] = td

root = Path(sys.argv[1]).resolve()
td.VENDOR = root
td.BUNDLE = root / "talos-charts.js"
td.ECHARTS_BUNDLE = root / "echarts.min.js"
reference = Path("sample_skills/dashboard-v2/references/layout-and-export.md").read_text(encoding="utf-8")
example = re.search(r"```python\n(.*?)\n```", reference, re.S)[1]
example = example.replace('"output/dashboard.html"', repr(str(root / "design.html")))
namespace = {}
exec(compile(example, "skill-layout-example", "exec"), namespace)
layout, style, trend = (namespace[k] for k in ("layout", "style", "trend"))
styles = {
    "16:9": "",
    "a4": "#td-artboard .story{grid-template-columns:1fr;gap:20px}#td-artboard .plot{height:360px}",
    "a4-landscape": "#td-artboard h1{font-size:52px}#td-artboard .story{gap:32px;grid-template-columns:240px 1fr}",
    "web": "#td-artboard .source{position:static;margin-top:30px}@media(max-width:900px){#td-artboard .story{grid-template-columns:1fr}#td-artboard h1{font-size:38px}}",
}
csp = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; "
       "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
       "connect-src 'none'; form-action 'none'; base-uri 'none'")
for fmt, extra in styles.items():
    page = root / (fmt.replace(":", "-") + ".html")
    td.dashboard(str(page), title="Geschäftsentwicklung 2026",
                 charts=[td.chart("trend", "Quartalsumsatz", trend, height=None)],
                 page_format=fmt, layout_html=layout, css=style + extra, download_png=True)
    page.write_text(page.read_text(encoding="utf-8").replace(
        "<head>", f'<head><meta http-equiv="Content-Security-Policy" content="{csp}">'), encoding="utf-8")

# Test refusal of overflowing pages instead of silent cropping.
td.dashboard(str(root / "overflow.html"), title="Overflow", charts=[],
             page_format="16:9", layout_html='<div style="height:900px">Too tall</div>',
             download_png=True)

# Mixed engines and GL exercise the snapshot overlay and native SVG paths.
gl = td.echarts({"xAxis3D": {}, "yAxis3D": {}, "zAxis3D": {}, "grid3D": {},
                 "series": [{"type": "scatter3D", "symbolSize": 20,
                             "data": [[1, 2, 3], [2, 3, 1], [3, 1, 2]]}]},
                extensions=["echarts-gl"])
td.dashboard(str(root / "mixed.html"), title="Mixed export", charts=[
    td.chart("native", "ECharts", trend),
    td.chart("legacy", "Legacy SVG", td.bar(["A", "B", "C"], [3, 5, 2])),
    td.chart("gl", "WebGL", gl),
], download_png=True)
