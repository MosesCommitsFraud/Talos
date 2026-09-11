"""Offline dashboard serialization and engine-selection contracts."""
import csv
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sandbox.vendor import talos_dash as td
from sandbox.vendor.charts.index_examples import build


class DashboardTests(unittest.TestCase):
    def test_full_options_and_explicit_callbacks(self):
        option = {"series": [{"type": "custom", "renderItem": td.js("function() { return null; }")}],
                  "matrix": {"x": {"data": ["A"]}}}
        spec = td.echarts(option)
        encoded = td._js(spec)
        self.assertIn('"renderItem":(function()', encoded)
        self.assertEqual(spec["option"], option)

    def test_data_is_not_executable(self):
        data = {"label": "</script><script>alert(1)</script>", "value": "function(){}"}
        encoded = td._js(data)
        self.assertNotIn("</script>", encoded)
        self.assertIn('"function(){}"', encoded)

    def test_bad_payloads_fail_before_render(self):
        for option in ({"x": float("nan")}, {"x": float("inf")}, {"x": object()}):
            with self.subTest(option=option), self.assertRaises((ValueError, TypeError)):
                td.echarts(option)
        with self.assertRaises(ValueError):
            td.echarts({}, setup="function(){}")
        with self.assertRaises(ValueError):
            td.echarts({}, extensions=["missing-plugin"])

    def test_engine_selection_and_offline_extensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("legacy.js", "echarts.min.js", "echarts-gl.min.js", "adapter.js"):
                (root / name).write_text(f"/* {name} */", encoding="utf-8")
            with patch.multiple(td, VENDOR=root, BUNDLE=root / "legacy.js",
                                ECHARTS_BUNDLE=root / "echarts.min.js",
                                ECHARTS_ADAPTER=root / "adapter.js"):
                native = td.chart("n", "Native", td.echarts({"series": []}))
                html = td.render("Demo", [native])
                self.assertIn("/* echarts.min.js */", html)
                self.assertNotIn("/* legacy.js */", html)
                self.assertNotIn('src="http', html)
                legacy = td.chart("l", "Legacy", td.bar(["A"], [1]))
                mixed = td.render("Demo", [native, legacy])
                self.assertIn("/* legacy.js */", mixed)
                self.assertIn("/* echarts.min.js */", mixed)
                gl = td.chart("g", "GL", td.echarts({}, extensions=["echarts-gl"]))
                self.assertIn("/* echarts-gl.min.js */", td.render("GL", [gl]))
                (root / "echarts.min.js").unlink()
                with self.assertRaises(FileNotFoundError):
                    td.render("Missing", [native])
                self.assertIn("/* legacy.js */", td.render("Old", [legacy]))

    def test_legacy_validation_remains_strict(self):
        with self.assertRaises(ValueError):
            td.check_spec("old", {**td.bar(["A"], [1]), "visualMap": {}})

    def test_index_covers_all_sources_and_dependency_hints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sources = root / "public/examples/ts"
            for folder in (sources, sources / "gl", sources / "archive"):
                folder.mkdir(parents=True, exist_ok=True)
            (sources / "tree.ts").write_text("/*\ntitle: Tree\ncategory: tree\n*/\noption = {};", encoding="utf-8")
            (sources / "gl/surface.js").write_text("/*\ntitle: Surface\ncategory: surface\n*/\nfetch(ROOT_PATH);", encoding="utf-8")
            (sources / "archive/old.js").write_text("/*\ntitle: Old\ncategory: custom\n*/\nrenderItem()", encoding="utf-8")
            self.assertEqual(build(root), 3)
            with (root / "index.tsv").open(encoding="utf-8") as stream:
                rows = {r["id"]: r for r in csv.DictReader(stream, delimiter="\t")}
            self.assertEqual(rows["surface"]["visibility"], "gallery")
            self.assertIn("external-data", rows["surface"]["dependency_hints"])
            self.assertEqual(rows["old"]["visibility"], "supplemental")
            for row in rows.values():
                self.assertTrue((root / row["source"]).is_file())


if __name__ == "__main__":
    unittest.main()
