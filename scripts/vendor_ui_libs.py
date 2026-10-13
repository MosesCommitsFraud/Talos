#!/usr/bin/env python3
"""Fetch the JavaScript libraries interactive answers may use into static/ui-vendor/.

Interactive answers (`render_ui`, src/interactive_ui.py) run in a sandboxed
iframe whose CSP allows scripts only from this instance — no public CDN. Talos
is often deployed on-prem without internet, and a CDN request would also tell a
third party who is using Talos. So the libraries are served from here.

Versions are pinned and every tarball is checked against the npm registry's
sha512 integrity before anything is extracted. The output is committed; run
this only to add a library or bump a version, then update LIBRARIES in
web/src/lib/uiFrame.ts and the interactive-answers skill to match.

    python scripts/vendor_ui_libs.py
"""

from __future__ import annotations

import base64
import hashlib
import io
import shutil
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static" / "ui-vendor"

# name, version, sha512 integrity, {path in package: path under OUT/<name>@<version>/}
PACKAGES = [
    (
        "echarts",
        "5.5.1",
        "sha512-Fce8upazaAXUVUVsjgV6mBnGuqgO+JNDlcgF79Dksy4+wgGpQB2lmYoO4TSweFg/mZITdpGHomw/cNBJZj1icA==",
        {"dist/echarts.min.js": "echarts.min.js", "LICENSE": "LICENSE", "NOTICE": "NOTICE"},
    ),
    (
        "d3",
        "7.9.0",
        "sha512-e1U46jVP+w7Iut8Jt8ri1YsPOvFpg46k+K8TpCb0P+zjCkjkPnV7WzfDJzMHy1LnA+wj5pLT1wjO901gLXeEhA==",
        {"dist/d3.min.js": "d3.min.js", "LICENSE": "LICENSE"},
    ),
    (
        "chart.js",
        "4.4.4",
        "sha512-emICKGBABnxhMjUjlYRR12PmOXhJ2eJjEHL2/dZlWjxRAZT1D8xplLFq5M0tMQK8ja+wBS/tuVEJB5C6r7VxJA==",
        {"dist/chart.umd.js": "chart.umd.js", "LICENSE.md": "LICENSE.md"},
    ),
    (
        "three",
        "0.169.0",
        "sha512-Ed906MA3dR4TS5riErd4QBsRGPcx+HBDX2O5yYE5GqJeFQTPU+M56Va/f/Oph9X7uZo3W3o4l2ZhBZ6f6qUv0w==",
        {"build/three.module.min.js": "three.module.min.js", "LICENSE": "LICENSE"},
    ),
    (
        "leaflet",
        "1.9.4",
        "sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==",
        {
            "dist/leaflet.js": "leaflet.js",
            "dist/leaflet.css": "leaflet.css",
            "dist/images/marker-icon.png": "images/marker-icon.png",
            "dist/images/marker-icon-2x.png": "images/marker-icon-2x.png",
            "dist/images/marker-shadow.png": "images/marker-shadow.png",
            "dist/images/layers.png": "images/layers.png",
            "dist/images/layers-2x.png": "images/layers-2x.png",
            "LICENSE": "LICENSE",
        },
    ),
]

# Already vendored for the docs site; reused rather than downloaded twice.
LOCAL = [
    ("mermaid", "11.15.0", {ROOT / "docs" / "javascripts" / "mermaid.min.js": "mermaid.min.js"})
]


def fetch(name: str, version: str, integrity: str) -> bytes:
    bare = name.split("/")[-1]
    url = f"https://registry.npmjs.org/{name}/-/{bare}-{version}.tgz"
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 - fixed https URL
        data = resp.read()
    algo, _, expected = integrity.partition("-")
    digest = base64.b64encode(hashlib.new(algo, data).digest()).decode()
    if digest != expected:
        raise SystemExit(f"{name}@{version}: integrity mismatch, refusing to extract")
    return data


def main() -> None:
    for name, version, integrity, files in PACKAGES:
        target = OUT / f"{name}@{version}"
        data = fetch(name, version, integrity)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            members = {m.name.split("/", 1)[1]: m for m in tar.getmembers() if "/" in m.name}
            for src, dst in files.items():
                member = members.get(src)
                if member is None or not member.isfile():
                    raise SystemExit(f"{name}@{version}: {src} not in package")
                out = target / dst
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(tar.extractfile(member).read())
        print(f"{name}@{version}: {len(files)} files")
    for name, label, files in LOCAL:  # label = the copied version
        target = OUT / f"{name}@{label}"
        target.mkdir(parents=True, exist_ok=True)
        for src, dst in files.items():
            shutil.copyfile(src, target / dst)
        print(f"{name}@{label}: copied")


if __name__ == "__main__":
    main()
