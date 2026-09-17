"""Design lint for composed, branded dashboards (td.lint_composition)."""

import re
import unittest
from pathlib import Path

from sandbox.vendor import talos_dash as td


def _example():
    ref = Path("sample_skills/dashboard-v2/references/layout-and-export.md").read_text(encoding="utf-8")
    source = re.search(r"```python\n(.*?)\n```", ref, re.S)[1]
    source = source.split("td.compose(")[0]  # build the inputs, don't render
    namespace: dict = {"td": td}
    exec(compile(source.replace("import talos_dash as td", ""), "example", "exec"), namespace)
    return namespace


class LintTests(unittest.TestCase):
    def test_skill_example_passes(self):
        ns = _example()
        self.assertEqual(td.lint_composition(ns["layout"], ns["style"], ns["charts"]), [])

    def test_generated_mistakes_are_reported(self):
        css = (".grid-card{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)}"
               ".card-title{font-size:11px;color:#555;font-weight:700}"
               "@media (max-width: 1200px){.dashboard-grid{grid-template-columns:1fr}}")
        chart = td.chart("c", "C", td.echarts({
            "grid": {"left": 180},
            "yAxis": {"axisLabel": {"formatter": "{value} Mio"}},
            "series": [{"type": "bar", "itemStyle": {"color": ["#4A90D9", "#E85D2A"]},
                        "label": {"formatter": "{c:,.0f}"}, "data": [1, 2]}],
            "xAxis": {"data": ["Black Friday", "#1 Kunde"]},
        }))
        issues = "\n".join(td.lint_composition('<div style="color:#333">x</div>', css, [chart]))
        for expected in ("background: #fff", "font-size: 11px", "color: #555", "font-weight: 700",
                         "@media", "grid.left: 180", "{value} Mio", "#4A90D9", "{c:,.0f}", "layout_html style="):
            self.assertIn(expected, issues)
        self.assertNotIn("rgba(0,0,0,.06)", issues)  # shadows may use rgba
        self.assertNotIn("Black Friday", issues)
        self.assertNotIn("#1 Kunde", issues)

    def test_numbers_insights_and_overflow(self):
        layout = ('<p>207.5 Mio. € · 62.1% · 20748.5 K € · 33.500 € · Stand 31.12.2025</p>'
                  '<div style="width:471.0%"></div>')
        issues = "\n".join(td.lint_composition(layout, ":root{--bg:var(--brand-grey)}", []))
        for expected in ("207.5 Mio", "62.1%", "K €", "width: 471.0%", "missing insights", "--bg"):
            self.assertIn(expected, issues)
        self.assertNotIn("33.500", issues)
        self.assertNotIn("31.12", issues)

    def test_generated_wording_placeholders_layout_and_filters(self):
        layout = ('<div class="kpi">{{eur 236240409}}</div>'
                  '<ul class="insights"><li><strong>Konzentration:</strong> amazon trägt 33 % — prüfen.</li>'
                  '<li><strong>Portfolio:</strong> ein ganzheitlicher Ansatz spielt eine Rolle 🚀</li>'
                  '<li>Nicht nur Umsatz, sondern auch Marge steigt. Jan–Dez bleibt erlaubt.</li></ul>'
                  '{{chart:a}}{{chart:b}}')
        charts = [td.chart("a", "A", td.bar(["x"], [1])), td.chart("b", "B", td.echarts({"series": []}))]
        issues = "\n".join(td.lint_composition(layout, ".g{grid-template-columns:repeat(12,1fr)}", charts))
        for expected in ("em dash", "ganzheitlich", "spielt eine rolle", "nicht nur", "emoji", "bold label",
                         "{{eur 236240409}}", "12-column", "legacy", "no filter"):
            self.assertIn(expected, issues)
        self.assertNotIn("en dash", issues)  # Jan–Dez is a range

    def test_german_number_helpers(self):
        self.assertEqual(td.eur(207_500_000), "207,5 Mio. €")
        self.assertEqual(td.eur(20_748_512, compact=False), "20.748.512 €")
        self.assertEqual(td.pct(62.06), "62,1 %")
        self.assertEqual(td.pct(4.1, signed=True), "+4,1 %")
        self.assertEqual(td.num(12037), "12.037")
        self.assertIn("width:100.0%", td.meter(471))

    def test_compose_raises_with_all_points(self):
        with self.assertRaisesRegex(ValueError, "fixed colour"):
            td.compose("unused.html", "T", [], layout_html="<h1>x</h1>", css="h1{color:#000}")

    def test_logo_placeholder_inside_img_becomes_inline_svg(self):
        html = td.render("Logo", [], layout_html='<img src="{{brand:logo}}" alt="Logo" class="brand-logo">',
                         css="h1{}", brand="macs")
        self.assertIn('<svg class="brand-logo"', html)
        self.assertNotIn('src="<svg', html)


if __name__ == "__main__":
    unittest.main()
