"""Build a searchable offline index from the pinned official example sources.

Usage: python index_examples.py /opt/talos/vendor/echarts-examples
The directory contains upstream public/ and LICENSE, plus a REVISION file.
No upstream JavaScript is executed. Every source is indexed, including archives.
"""
import csv
import re
import sys
from collections import Counter
from pathlib import Path


def build(root: Path) -> int:
    rows = []
    categories = Counter()
    source = root / "public/examples/ts"
    for path in sorted(source.rglob("*")):
        if path.suffix not in {".ts", ".js"} or path.name.endswith(".d.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        header = re.search(r"/\*(.*?)\*/", text, re.S)
        meta = dict(re.findall(r"^\s*(\w+):\s*([^\n]+)", header[1], re.M)) if header else {}
        meta = {k: v.strip().strip("\"'") for k, v in meta.items()}
        category = meta.get("category", "uncategorized")
        categories.update(c.strip() for c in category.split(","))
        hints = []
        for label, pattern in {
            "external-data": r"ROOT_PATH|\$\.get|fetch\(|https?://",
            "map-registration": r"registerMap",
            "webgl": r"\b(globe|\w+3D|flowGL|graphGL|mapbox3D)\b",
            "ecStat": r"\becStat\b",
            "custom-render": r"renderItem",
            "events-animation": r"setInterval|setTimeout|myChart\.on|dispatchAction",
            "extra-script": r"getScript|require\(|import ",
        }.items():
            if re.search(pattern, text):
                hints.append(label)
        visible = path.parent in {source, source / "gl"} and meta.get("noExplore") != "true" and "title" in meta and "category" in meta
        rows.append([path.stem, meta.get("title", path.stem), category,
                     meta.get("since", ""), "gallery" if visible else "supplemental",
                     ",".join(hints), path.relative_to(root).as_posix(),
                     ("https://echarts.apache.org/examples/en/editor.html?c=" + path.stem
                      + ("&gl=1" if path.parent == source / "gl" else "")) if visible else ""])
    if not rows:
        raise ValueError(f"No example sources found in {source}")
    with (root / "index.tsv").open("w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out, delimiter="\t")
        writer.writerow(["id", "title", "categories", "since", "visibility", "dependency_hints", "source", "url"])
        writer.writerows(rows)
    (root / "categories.tsv").write_text(
        "category\texamples\n" + "".join(f"{k}\t{v}\n" for k, v in sorted(categories.items())),
        encoding="utf-8",
    )
    print(f"Indexed {len(rows)} sources ({sum(r[4] == 'gallery' for r in rows)} gallery examples)")
    return len(rows)


if __name__ == "__main__":
    build(Path(sys.argv[1]))
