#!/usr/bin/env python3
"""Local UI-only preview server for Talos.

Runs without Docker, an LLM host, vLLM, or the FastAPI backend. It serves the static UI
and returns small mock responses for common API calls so layout/theme changes can
be tested on a laptop.
"""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import os
import shutil
import signal
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
# The inline-UI routes reuse the real CSP/tile helpers (stdlib-only module).
sys.path.insert(0, str(ROOT))
STATIC = ROOT / "static"
# New React UI bundle — served at "/" when built (mirrors app.py's strangler
# routing: new UI at /, legacy at /legacy).
WEB_DIST = ROOT / "web" / "dist"
PREVIEW_SESSION_NAME = "Quarterly planning, architecture review, and release readiness follow-up"


def _json_bytes(data) -> bytes:
    return json.dumps(data).encode("utf-8")


def _make_png(width: int, height: int) -> bytes:
    """A tiny gradient PNG built with stdlib only — sample image for previews."""
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (
            struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 per scanline
        for x in range(width):
            raw += bytes(((x * 255) // width, (y * 255) // height, 150))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def _zip(files: dict[str, str]) -> bytes:
    """Pack name->XML pairs into an OOXML (zip) container, stdlib only."""
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


def _make_xlsx() -> bytes:
    """A minimal, real .xlsx with a couple of sheets — renders in the preview's
    SheetJS table view (uses inline strings so no shared-strings part needed)."""

    def cell(ref: str, value: str, *, num: bool = False) -> str:
        if num:
            return f'<c r="{ref}"><v>{value}</v></c>'
        esc = value.replace("&", "&amp;").replace("<", "&lt;")
        return f'<c r="{ref}" t="inlineStr"><is><t>{esc}</t></is></c>'

    def sheet(rows: list[list[tuple[str, bool]]]) -> str:
        out = []
        for r, row in enumerate(rows, start=1):
            cells = "".join(
                cell(f"{chr(65 + c)}{r}", val, num=num) for c, (val, num) in enumerate(row)
            )
            out.append(f'<row r="{r}">{cells}</row>')
        body = "".join(out)
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{body}</sheetData></worksheet>"
        )

    s = False
    n = True
    revenue = [
        [("Region", s), ("Q1", s), ("Q2", s), ("Growth %", s)],
        [("EMEA", s), ("120", n), ("145", n), ("20.8", n)],
        [("APAC", s), ("90", n), ("110", n), ("22.2", n)],
        [("AMER", s), ("200", n), ("205", n), ("2.5", n)],
        [("LATAM", s), ("40", n), ("55", n), ("37.5", n)],
    ]
    headcount = [
        [("Team", s), ("Headcount", s)],
        [("Engineering", s), ("48", n)],
        [("Sales", s), ("31", n)],
        [("Support", s), ("17", n)],
    ]
    return _zip(
        {
            "[Content_Types].xml": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                "</Types>"
            ),
            "_rels/.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                "</Relationships>"
            ),
            "xl/workbook.xml": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                '<sheet name="Revenue" sheetId="1" r:id="rId1"/>'
                '<sheet name="Headcount" sheetId="2" r:id="rId2"/>'
                "</sheets></workbook>"
            ),
            "xl/_rels/workbook.xml.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
                "</Relationships>"
            ),
            "xl/worksheets/sheet1.xml": sheet(revenue),
            "xl/worksheets/sheet2.xml": sheet(headcount),
        }
    )


def _make_pptx() -> bytes:
    """A minimal, openable .pptx (one master, one layout, one theme, one slide).
    Not previewed in-app (downloads), but a real file so it opens in PowerPoint."""
    rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pml = "http://schemas.openxmlformats.org/presentationml/2006/main"
    dml = "http://schemas.openxmlformats.org/drawingml/2006/main"
    empty_clr = (
        f'<a:clrMap xmlns:a="{dml}" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" '
        'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" '
        'accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    )
    theme = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<a:theme xmlns:a="{dml}" name="Office"><a:themeElements>'
        '<a:clrScheme name="Office">'
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
        '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
        '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
        '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
        '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
        '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
        "</a:clrScheme>"
        '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
        '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>"
        "<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
        '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
        "</a:fmtScheme></a:themeElements></a:theme>"
    )

    def textbox(title: str, body: str) -> str:
        return (
            f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="7772400" cy="2286000"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            f"<p:txBody><a:bodyPr/><a:lstStyle/>"
            f'<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>{title}</a:t></a:r></a:p>'
            f'<a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>{body}</a:t></a:r></a:p>'
            "</p:txBody></p:sp>"
        )

    sp_tree = (
        '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        "<p:grpSpPr/>{shapes}</p:spTree>"
    )
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sld xmlns:a="{dml}" xmlns:r="{rels}" xmlns:p="{pml}"><p:cSld><p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        + textbox("Quarterly review", "Mock slide from the Talos UI preview.")
        + "</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping "
        f'xmlns:a="{dml}" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
        'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" '
        'folHlink="folHlink"/></p:clrMapOvr></p:sld>'
    )
    layout = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldLayout xmlns:a="{dml}" xmlns:r="{rels}" xmlns:p="{pml}" type="blank" preserve="1">'
        f'<p:cSld name="Blank">{sp_tree.format(shapes="")}</p:cSld>{empty_clr}</p:sldLayout>'
    )
    master = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldMaster xmlns:a="{dml}" xmlns:r="{rels}" xmlns:p="{pml}">'
        f"<p:cSld>{sp_tree.format(shapes='')}</p:cSld>{empty_clr}"
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
    )
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:presentation xmlns:a="{dml}" xmlns:r="{rels}" xmlns:p="{pml}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
        '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    )
    return _zip(
        {
            "[Content_Types].xml": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
                '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
                '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
                '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
                "</Types>"
            ),
            "_rels/.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
                "</Relationships>"
            ),
            "ppt/presentation.xml": presentation,
            "ppt/_rels/presentation.xml.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
                "</Relationships>"
            ),
            "ppt/slideMasters/slideMaster1.xml": master,
            "ppt/slideMasters/_rels/slideMaster1.xml.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
                "</Relationships>"
            ),
            "ppt/slideLayouts/slideLayout1.xml": layout,
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
                "</Relationships>"
            ),
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/_rels/slide1.xml.rels": (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                "</Relationships>"
            ),
            "ppt/theme/theme1.xml": theme,
        }
    )


# Sample workspace files served by the mock artifact endpoints, so the preview
# panel has real markdown/csv/text content to render during local dev.
_SAMPLE_ARTIFACTS: dict[str, tuple[bytes, str]] = {
    "summary.md": (
        b"# Analysis summary\n\n"
        b"This file is rendered by the **preview panel** in the current theme.\n\n"
        b"## Findings\n\n"
        b"- Revenue grew **12%** quarter over quarter\n"
        b"- Churn held steady at ~3%\n"
        b"- Three regions outperformed forecast\n\n"
        b"```python\ndef growth(a, b):\n    return (b - a) / a\n```\n\n"
        b"| Region | Q1 | Q2 |\n|--------|----|----|\n| EMEA | 120 | 145 |\n| APAC | 90 | 110 |\n",
        "text/markdown",
    ),
    "result.csv": (
        b"region,q1,q2,growth\nEMEA,120,145,0.21\nAPAC,90,110,0.22\n"
        b"AMER,200,205,0.025\nLATAM,40,55,0.375\n",
        "text/csv",
    ),
    "notes.txt": (
        b"Raw notes\n=========\n\nThese are plain-text notes shown verbatim in the preview panel.\n"
        b"Line wrapping and monospace formatting are preserved.\n",
        "text/plain",
    ),
    "chart.png": (_make_png(160, 100), "image/png"),
    "revenue.xlsx": (
        _make_xlsx(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "deck.pptx": (
        _make_pptx(),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
}


# --- Artifacts page library (GET/PATCH/DELETE /api/artifacts) ----------------
# A spread of types and dates so the list's month groups, the tile previews and
# the type filter all have something to show. Mutated by pin/rename/delete.
def _library_seed() -> list[dict]:
    now = time.time()
    day = 86400
    sid, sname = "preview-session", PREVIEW_SESSION_NAME
    rows = [
        ("summary.md", "text/markdown", now - 3600, "document"),
        ("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", now - 2 * day, "workspace"),
        ("revenue.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", now - 9 * day, "workspace"),
        ("chart.png", "image/png", now - 20 * day, "workspace"),
        ("result.csv", "text/csv", now - 45 * day, "workspace"),
        ("notes.txt", "text/plain", now - 80 * day, "workspace"),
        ("dashboard.html", "text/html", now - 120 * day, "workspace"),
        ("etl_job.py", "text/x-python", now - 400 * day, "workspace"),
    ]
    out = []
    for name, mime, mtime, source in rows:
        content = _SAMPLE_ARTIFACTS.get(name, (b"", mime))[0]
        row = {
            "path": f"document:{name}" if source == "document" else name,
            "name": name,
            "size": len(content) or 2048,
            "mime": mime,
            "mtime": mtime,
            "source": source,
            "session_id": sid,
            "session_name": sname,
            "pinned": name == "deck.pptx",
            "pinned_at": now if name == "deck.pptx" else None,
        }
        if source == "document":
            row["snippet"] = content.decode("utf-8", "replace")[:600]
        out.append(row)
    return out


_LIBRARY: list[dict] = []
_LIBRARY_DELETED: set[str] = set()


# --- Mock conversation state -------------------------------------------------
# Real edit/revert/delete affordances only render once a message has a backend
# row id (metadata._db_id). The live app gets that from /api/history; we mirror
# the shape here so the preview shows the full message-action toolbar.

from datetime import datetime, timedelta, timezone  # noqa: E402

_DB_SEQ = 0
# Per-session history: session_id -> list of {role, content, metadata}.
_HISTORY: dict[str, list[dict]] = {}


def _next_db_id() -> str:
    global _DB_SEQ
    _DB_SEQ += 1
    return f"preview-msg-{_DB_SEQ}"


def _iso(offset_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


def _entry(role: str, content: str, ts_offset: int = 0) -> dict:
    return {
        "role": role,
        "content": content,
        "metadata": {"timestamp": _iso(ts_offset), "_db_id": _next_db_id()},
    }


def _cold_agent_turn(ts_offset: int) -> dict:
    """A finished multi-round agent turn as the DB stores it: ONE assistant row
    carrying `round_texts` plus per-round `tool_events`. The frontend rebuilds
    the per-round bubbles from these (see coldLoadMessage), which is a different
    code path from the live stream — reopening an old chat is the only way to
    exercise it, so the preview needs one seeded."""
    entry = _entry("assistant", "Done — the schema lines up with the report.", ts_offset)
    entry["metadata"].update(
        {
            "round_texts": [
                "<think>Erst die Tabellen ansehen, dann die Query bauen.</think>"
                "Ich schaue mir zuerst das Schema an.",
                "Die Spalten passen. Jetzt die Auswertung.",
                "Done — the schema lines up with the report.",
            ],
            "tool_events": [
                {
                    "round": 1,
                    "tool": "query_sql",
                    "command": '{"action": "list_tables"}',
                    "output": "orders\ncustomers\ninvoices",
                    "exit_code": 0,
                },
                {
                    "round": 1,
                    "tool": "query_sql",
                    "command": '{"action": "describe", "table": "orders"}',
                    "output": "id, customer_id, total, created_at",
                    "exit_code": 0,
                },
                # Two calls of a family whose wording wants a subject: the group
                # header must fall back to the counted plural ("Listed 2
                # directories") instead of naming one of the two paths.
                {
                    "round": 1,
                    "tool": "ls",
                    "command": '{"path": "src"}',
                    "output": "report.py\nschema.sql",
                    "exit_code": 0,
                },
                {
                    "round": 1,
                    "tool": "ls",
                    "command": '{"path": "tests"}',
                    "output": "test_report.py",
                    "exit_code": 0,
                },
                {
                    "round": 2,
                    "tool": "query_sql",
                    "command": '{"action": "query", "query": "SELECT count(*) FROM orders"}',
                    "output": "No rows returned.",
                    "exit_code": 1,
                    "row_count": 0,
                },
                # The table widget on the COLD path: a query_sql result rebuilt
                # from storage, with the sortable table it carried.
                {
                    "round": 2,
                    "tool": "query_sql",
                    "command": '{"action": "query", "query": "SELECT ... FROM orders"}',
                    "output": "500 rows x 6 columns. First 25 shown: …",
                    "exit_code": 0,
                    "row_count": 1284,
                    "widget": _table_widget(),
                },
                # The chart view's other branch: a date label column, so the
                # toggle opens on a line rather than bars.
                {
                    "round": 2,
                    "tool": "query_sql",
                    "command": '{"action": "query", "query": "SELECT monat, SUM(umsatz) ..."}',
                    "output": "24 rows x 3 columns",
                    "exit_code": 0,
                    "row_count": 24,
                    "widget": _timeseries_widget(),
                },
                {
                    "round": 2,
                    "tool": "edit_file",
                    "command": '{"path": "src/report.py"}',
                    "output": "Edited src/report.py (1 replacement)",
                    "exit_code": 0,
                    "diff": "--- a/src/report.py\n+++ b/src/report.py\n-old = 1\n+new = 2\n+extra = 3",
                },
                # Widgets on the COLD path. A widget only reaches the card if it
                # was written into metadata.tool_events as well as onto the live
                # SSE frame — miss that and the card renders while the turn
                # streams and is gone the next time the chat is opened, which is
                # exactly how this was found. Both types are seeded so the
                # registry is exercised on reload, not just mid-stream.
                {
                    "round": 2,
                    "tool": "get_weather",
                    "command": '{"location": "Zürich"}',
                    "output": "Weather for Zurich, Switzerland.",
                    "exit_code": 0,
                    "widget": _weather_widget(),
                },
                {
                    "round": 2,
                    "tool": "get_news",
                    "command": '{"query": "EU AI Act"}',
                    "output": 'News: "EU AI Act" — 5 article(s).',
                    "exit_code": 0,
                    "widget": _news_widget(),
                },
                {
                    "round": 2,
                    "tool": "render_ui",
                    "command": "Angebotsvergleich – gewichtete Bewertung",
                    "output": "Interactive answer rendered inline for the user.",
                    "exit_code": 0,
                    "widget": _ui_widget(),
                },
                {
                    "round": 2,
                    "tool": "render_ui",
                    "command": "Umsatz 2025 nach Region",
                    "output": "Interactive answer rendered inline for the user.",
                    "exit_code": 0,
                    "widget": _ui_widget(1),
                },
                {
                    "round": 2,
                    "tool": "render_ui",
                    "command": "Standorte und Mitarbeitende",
                    "output": "Interactive answer rendered inline for the user.",
                    "exit_code": 0,
                    "widget": _ui_widget(0, "ui-maps"),
                },
                {
                    "round": 2,
                    "tool": "render_ui",
                    "command": "Umsatz je Monat",
                    "output": "Interactive answer rendered inline for the user.",
                    "exit_code": 0,
                    "widget": _ui_widget(0, "ui-data"),
                },
                *_declarative_events(),
            ],
        }
    )
    return entry


def _rag_turn(ts_offset: int) -> dict:
    """A knowledge-base answer: several passages of one file, a single-passage
    file, a figure and a video — the shapes the sources bar under the answer
    groups into chips with a stepping hover card."""
    entry = _entry(
        "assistant",
        "Die Wartung erfolgt alle 500 Betriebsstunden [1], der Filter wird dabei "
        "immer mitgetauscht [2, 3]. Details zur Montage zeigt das Schulungsvideo [4].",
        ts_offset,
    )
    sources = [
        {
            "filename": "Wartungshandbuch.pdf",
            "_page": 12,
            "similarity": 0.82,
            "snippet": "Die Inspektion ist alle 500 Betriebsstunden durchzuführen. Dabei sind "
            "Hydraulikleitungen, Dichtungen und der Ölstand zu prüfen.\n\nAbweichungen "
            "sind im Wartungsprotokoll zu dokumentieren.",
        },
        {
            "filename": "Wartungshandbuch.pdf",
            "_page": 14,
            "similarity": 0.77,
            "snippet": "Der Ansaugfilter ist bei jeder Inspektion zu ersetzen, unabhängig vom "
            "optischen Zustand. Verwenden Sie ausschließlich Originalfilter (Art.-Nr. 4711).",
        },
        {
            "filename": "Wartungshandbuch.pdf",
            "_page": 31,
            "similarity": 0.64,
            "snippet": "Anhang B: Drehmomenttabelle für Filtergehäuse M8 – 24 Nm, M10 – 45 Nm.",
        },
        {
            "filename": "Ersatzteilliste_2025.xlsx",
            "similarity": 0.58,
            "snippet": "4711 | Ansaugfilter komplett | VE 1 | lagernd",
        },
        {
            "filename": "Wartungshandbuch.pdf",
            "modality": "image",
            "similarity": 0.6,
            "image_url": "/api/news/thumbnail?url=filter",
            "image_caption": "Abb. 7: Filtergehäuse, Explosionsdarstellung",
            "snippet": "Abb. 7",
        },
        {
            "filename": "Schulung_Filterwechsel.mp4",
            "modality": "video",
            "similarity": 0.7,
            "start": 42,
            "end": 75,
            "deeplink": "https://example.com/video#t=42",
            "snippet": "Zuerst das Gehäuse drucklos machen, dann die vier Schrauben lösen …",
        },
        {
            "filename": "Schulung_Filterwechsel.mp4",
            "modality": "video",
            "similarity": 0.66,
            "start": 190,
            "end": 230,
            "snippet": "Beim Einsetzen auf den Sitz des O-Rings achten.",
        },
    ]
    entry["metadata"]["rag_sources"] = sources
    entry["metadata"]["citations"] = [
        {
            "n": 1,
            "kind": "rag",
            "title": "Wartungshandbuch.pdf",
            "page": 12,
            "snippet": sources[0]["snippet"],
        },
        {
            "n": 2,
            "kind": "rag",
            "title": "Wartungshandbuch.pdf",
            "page": 14,
            "snippet": sources[1]["snippet"],
        },
        {
            "n": 3,
            "kind": "rag",
            "title": "Ersatzteilliste_2025.xlsx",
            "snippet": sources[3]["snippet"],
        },
        {
            "n": 4,
            "kind": "rag",
            "title": "Schulung_Filterwechsel.mp4",
            "snippet": sources[5]["snippet"],
            "deeplink": "https://example.com/video#t=42",
        },
    ]
    return entry


def _history_for(session_id: str) -> list[dict]:
    """History for a session, seeding the canonical preview session on first use."""
    if session_id not in _HISTORY:
        if session_id == "preview-session":
            _HISTORY[session_id] = [
                _entry("user", "Preview the Talos UI", -2 * 86400),
                _entry("assistant", "This is mock content for local UI work.", -2 * 86400 + 12),
                _entry("user", "Check the orders schema", -86400),
                _cold_agent_turn(-86400 + 30),
                _entry("user", "Wie oft muss die Anlage gewartet werden?", -3600),
                _rag_turn(-3600 + 8),
            ]
        else:
            _HISTORY[session_id] = []
    return _HISTORY[session_id]


# An ask_user card with three questions (multi-select, single choice with a
# header chip, free text), so the preview exercises the paged question card.
_MOCK_ASK = {
    "questions": [
        {
            "question": "Welche Features sollen rein?",
            "header": "Features",
            "multi": True,
            "options": [
                {"label": "Dark Mode", "description": "Eigenes Farbschema für dunkle Umgebungen."},
                {"label": "CSV-Export", "description": "Tabellen als CSV herunterladen."},
                {"label": "Tastenkürzel", "description": "Häufige Aktionen per Tastatur."},
            ],
        },
        {
            "question": "Welcher Zeitraum soll ausgewertet werden?",
            "header": "Zeitraum",
            "options": [
                {"label": "Letzte 12 Monate (empfohlen)", "description": "Genug Daten für Saisonalität."},
                {"label": "Aktuelles Quartal", "description": "Schneller, aber ohne Vorjahresvergleich."},
            ],
        },
        {"question": "Gibt es sonst noch etwas, das ich wissen sollte?"},
    ]
}


def _ask_stream() -> bytes:
    first = _MOCK_ASK["questions"][0]
    payload = {**_MOCK_ASK, "question": first["question"], "options": first["options"], "multi": True}
    events: list[dict | str] = [
        {"delta": "Bevor ich loslege, brauche ich ein paar Entscheidungen.\n\n"},
        # The real loop also streams the questions as text (for replay).
        {"delta": "\n\n".join(q["question"] for q in _MOCK_ASK["questions"])},
        {"type": "tool_start", "tool": "ask_user", "command": json.dumps(_MOCK_ASK)},
        {"type": "tool_output", "tool": "ask_user", "output": "Awaiting their answer.", "exit_code": 0},
        {"type": "ask_user", "data": payload},
        "[DONE]",
    ]
    return "".join(_sse(e) for e in events).encode("utf-8")


def _record_ask_turn(session_id: str, message: str) -> None:
    hist = _HISTORY.setdefault(session_id, [])
    hist.append(_entry("user", message or "(empty)"))
    asked = "\n\n".join(q["question"] for q in _MOCK_ASK["questions"])
    entry = _entry("assistant", "Bevor ich loslege, brauche ich ein paar Entscheidungen.\n\n" + asked)
    entry["metadata"]["tool_events"] = [
        {"tool": "ask_user", "command": json.dumps(_MOCK_ASK), "output": "Awaiting their answer.",
         "exit_code": 0, "ask_user": _MOCK_ASK}
    ]
    hist.append(entry)


def _record_turn(session_id: str, message: str, ask_answers=None) -> None:
    """Append a sent turn (user + the two assistant rounds the stream emits) so a
    post-stream history fetch hands every message a _db_id — matching runtime
    length so the app reconciles them and shows edit/revert/delete."""
    # setdefault (not _history_for) so a brand-new chat starts empty and stays
    # length-matched with the runtime — only an explicitly opened preview session
    # carries the seeded backlog.
    hist = _HISTORY.setdefault(session_id, [])
    hist.append(_entry("user", message or "(empty)"))
    if ask_answers:
        hist[-1]["metadata"]["ask_answers"] = ask_answers
    hist.append(
        _entry("assistant", "The computed highest gross value is **22.61** for item **B**.", 1)
    )
    hist.append(
        _entry(
            "assistant", "Second-round reply: the calculation checks out, **B** stays on top.", 2
        )
    )


def _weather_widget() -> dict:
    """A get_weather widget payload in the shape src/weather.py emits, so the
    preview exercises the widget channel and the weather card.

    Deliberately not flat weather: the hours cross into night (the card swaps to
    its moon icons), and one forecast day is wet while the rest are dry (the
    precipitation figures only render above 10%, and the range bars are scaled
    across the whole week, so a mixed week is the case worth looking at)."""
    hours = []
    for i in range(24):
        hour = (15 + i) % 24
        night = hour >= 21 or hour < 6
        hours.append(
            {
                "time": f"2026-08-{11 + (15 + i) // 24:02d}T{hour:02d}:00",
                "temperature": round(21.5 - abs(hour - 15) * 0.6, 1),
                "condition": "partly-cloudy" if not night else "clear",
                "precipitationProbability": 70 if 8 <= hour <= 13 else 0,
            }
        )
    # A 16-day forecast: "more than one week" is now askable, and the range bars
    # have to stay comparable across a fortnight rather than a week.
    total_days = 16
    conditions = [
        "mainly-clear",
        "partly-cloudy",
        "rain",
        "showers",
        "overcast",
        "clear",
        "clear",
        "thunderstorm",
        "drizzle",
        "partly-cloudy",
        "clear",
        "fog",
        "rain",
        "overcast",
        "clear",
        "snow",
    ]
    highs = [
        23.4,
        22.1,
        18.6,
        19.8,
        21.0,
        24.6,
        26.1,
        25.2,
        20.4,
        22.8,
        27.3,
        19.1,
        17.5,
        18.9,
        23.0,
        4.2,
    ]
    lows = [
        14.2,
        13.8,
        12.1,
        12.9,
        13.5,
        15.0,
        16.4,
        15.8,
        12.6,
        13.1,
        16.9,
        11.4,
        10.8,
        11.2,
        13.7,
        -2.1,
    ]
    pops = [0, 20, 85, 60, 15, 0, 0, 90, 45, 10, 0, 30, 75, 25, 5, 55]

    def _day_hours(index: int) -> list:
        """Hourly readings for one forecast day — but only inside the window the
        backend still sends them for (HOURLY_DAYS). Past that a day opens to its
        daily figures alone, and the card must say so rather than look broken."""
        if index >= 7:
            return []
        out = []
        for hour in range(24):
            night = hour >= 21 or hour < 6
            out.append(
                {
                    "time": f"2026-08-{11 + index:02d}T{hour:02d}:00",
                    "temperature": round(
                        lows[index] + (highs[index] - lows[index]) * (1 - abs(hour - 15) / 15), 1
                    ),
                    "condition": conditions[index]
                    if 8 <= hour <= 18
                    else ("clear" if night else conditions[index]),
                    "precipitationProbability": pops[index]
                    if 8 <= hour <= 16
                    else max(0, pops[index] - 40),
                    "wind": round(6 + (hour % 7) * 1.8, 1),
                }
            )
        return out

    return {
        "type": "weather",
        "version": 1,
        "data": {
            # Asked-for vs resolved: the geocoder's canonical spelling differs
            # from what the user typed, so the card must lead with "Zürich" and
            # keep "Zurich, Switzerland" as the confirming subtitle.
            "location": {
                "query": "Zürich",
                "name": "Zurich",
                "admin": "Zurich",
                "country": "Switzerland",
                "timezone": "Europe/Zurich",
            },
            "units": {"temperature": "°C", "wind": "km/h", "precipitation": "mm"},
            "current": {
                "time": "2026-08-11T15:00",
                "temperature": 21.5,
                "apparent": 19.2,
                "humidity": 34,
                "wind": 11.4,
                "precipitation": 0.0,
                "condition": "mainly-clear",
                "isDay": True,
            },
            "hourly": hours,
            "daily": [
                {
                    "date": f"2026-08-{11 + i:02d}",
                    "condition": conditions[i],
                    "max": highs[i],
                    "min": lows[i],
                    "apparentMax": round(highs[i] - 1.4, 1),
                    "apparentMin": round(lows[i] - 2.1, 1),
                    "precipitationProbability": pops[i],
                    "precipitation": round(pops[i] / 12, 1),
                    "wind": round(9 + i * 1.3, 1),
                    "uvIndex": round(max(0.5, 7.2 - i * 0.3), 1),
                    "sunrise": f"2026-08-{11 + i:02d}T05:{40 + (i % 10):02d}",
                    "sunset": f"2026-08-{11 + i:02d}T20:{40 + ((8 - i) % 10):02d}",
                    "hours": _day_hours(i),
                }
                for i in range(total_days)
            ],
        },
    }


def _table_widget() -> dict:
    """A query_sql table widget in the shape src/tool_implementations.py emits.

    Deliberately awkward data, because a table that only ever sees tidy rows
    looks fine right up until it doesn't: a NULL (which must read as NULL, not as
    an empty cell), a mixed-type column (which must NOT right-align), a very long
    text cell (which must truncate instead of stretching the card), and more rows
    than fit so the scroll and the "showing N of M" footer are exercised.
    """
    rows = []
    # The real cap (_SQL_WIDGET_ROWS), not a token handful: a table that is only
    # ever previewed with 60 rows looks fast right up until a real query lands.
    for i in range(1, 501):
        rows.append(
            [
                1000 + i,
                f"Kunde {i:03d}" if i % 7 else None,
                ["DE", "AT", "CH", "NL"][i % 4],
                round(1249.5 + i * 37.25, 2),
                i % 5 if i % 11 else "n/a",
                (
                    "Sammelrechnung über mehrere Positionen inklusive Nachlass und "
                    "abweichender Lieferanschrift"
                    if i % 9 == 0
                    else f"Bestellung {i}"
                ),
            ]
        )
    return {
        "type": "table",
        "version": 1,
        "data": {
            "columns": ["id", "kunde", "land", "umsatz", "retouren", "notiz"],
            "rows": rows,
            "rowCount": 1284,
            "shown": len(rows),
            "trimmed": False,
            "label": "SELECT id, kunde, land, umsatz, retouren, notiz FROM orders ORDER BY umsatz DESC",
            "database": "vertrieb",
            "spillPath": "orders_query.csv",
        },
    }


def _timeseries_widget() -> dict:
    """A query_sql result whose label column is a DATE.

    Exercises the chart view's other branch: a temporal axis makes the reader's
    job "trend", which a row of dated bars answers worse than a line does. Also
    the case where values are not readable off the mark, so the hover crosshair
    is the only way to get a number out of the chart — and the table tab is the
    ungated twin that proves it isn't the only way overall.
    """
    rows = []
    for month in range(1, 25):
        year = 2025 + (month - 1) // 12
        m = (month - 1) % 12 + 1
        # A seasonal shape with a visible dip, so the line has something to say.
        base = 84000 + month * 2400
        seasonal = -14000 if m in (1, 2) else (9000 if m in (6, 7, 11) else 0)
        rows.append([f"{year}-{m:02d}", base + seasonal, 120 + month * 3])
    return {
        "type": "table",
        "version": 1,
        "data": {
            "columns": ["monat", "umsatz", "auftraege"],
            "rows": rows,
            "rowCount": len(rows),
            "shown": len(rows),
            "trimmed": False,
            "label": "SELECT monat, SUM(umsatz) umsatz, COUNT(*) auftraege FROM orders GROUP BY monat",
            "database": "vertrieb",
            "spillPath": "",
        },
    }


def _placeholder_png(seed: str) -> bytes:
    """A 1×1 PNG in a colour derived from `seed`, built by hand.

    The news cards crop their thumbnail with `object-cover`, so a single pixel
    fills the frame as a flat colour — enough to check the layout, the lazy
    loading and the failure path without the preview needing Pillow or a folder
    of binary fixtures. Deriving the colour from the URL makes the cards
    visually distinct, which is the point of having pictures at all.
    """
    import binascii
    import struct
    import zlib

    digest = binascii.crc32(seed.encode("utf-8"))
    rgb = bytes(
        (
            ((digest >> 16) & 0x7F) + 0x60,
            ((digest >> 8) & 0x7F) + 0x60,
            (digest & 0x7F) + 0x60,
        )
    )

    def _chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1×1, 8-bit, truecolour
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(b"\x00" + rgb))
        + _chunk(b"IEND", b"")
    )


def _declarative_events() -> list:
    """render_widget results (src/declarative_widgets.py), one per type."""
    from src.declarative_widgets import build

    src = [{"kind": "sql", "label": "dbo.orders"}]
    calls = [
        {
            "type": "kpi",
            "title": "Kennzahlen 2025",
            "data": {
                "items": [
                    {
                        "label": "Umsatz",
                        "value": 4.15,
                        "unit": "Mio. €",
                        "delta": 0.191,
                        "deltaLabel": "ggü. Vorjahr",
                    },
                    {"label": "Aufträge", "value": 12840, "delta": 0.064},
                    {
                        "label": "Reklamationsquote",
                        "value": "1,8 %",
                        "delta": 0.12,
                        "higherIsBetter": False,
                    },
                    {
                        "label": "Ø Lieferzeit",
                        "value": 3.4,
                        "unit": "Tage",
                        "delta": -0.08,
                        "higherIsBetter": False,
                    },
                ]
            },
            "sources": src,
        },
        {
            "type": "diagram",
            "title": "Freigabeprozess Bestellung",
            "data": {
                "mermaid": (
                    "flowchart LR\n  A[Bedarf] --> B{Betrag > 5.000 €?}\n"
                    "  B -- nein --> C[Einkauf bestellt]\n  B -- ja --> D[Freigabe Leitung]\n"
                    "  D --> C\n  C --> E[(ERP)]"
                )
            },
            "sources": [
                {
                    "kind": "knowledge",
                    "label": "Einkaufsrichtlinie",
                    "ref": "Richtlinie_Einkauf.pdf, Kap. 3",
                }
            ],
        },
        {
            "type": "timeline",
            "title": "Projektverlauf",
            "data": {
                "events": [
                    {
                        "date": "2025-01",
                        "title": "Kick-off",
                        "text": "Ziele und Team festgelegt.",
                        "status": "done",
                    },
                    {"date": "2025-04", "title": "Pilot Werk Süd", "status": "done"},
                    {
                        "date": "2025-09",
                        "title": "Rollout",
                        "text": "Verzögert durch Lieferengpass.",
                        "status": "risk",
                    },
                    {"date": "2026-01", "title": "Abnahme"},
                ]
            },
            "sources": [{"kind": "user", "label": "Projektplan aus deiner Nachricht"}],
        },
        {
            "type": "comparison",
            "title": "Angebote im Vergleich",
            "data": {
                "options": ["Angebot A", "Angebot B", "Angebot C"],
                "rows": [
                    {
                        "criterion": "Preis",
                        "values": ["48.000 €", "52.500 €", "45.900 €"],
                        "best": 2,
                    },
                    {
                        "criterion": "Lieferzeit",
                        "values": ["6 Wochen", "3 Wochen", "8 Wochen"],
                        "best": 1,
                    },
                    {
                        "criterion": "Garantie",
                        "values": ["2 Jahre", "3 Jahre", "2 Jahre"],
                        "best": 1,
                    },
                ],
                "verdict": "B ist teurer, liefert aber am schnellsten mit der längsten Garantie.",
            },
            "sources": [{"kind": "user", "label": "Angebote aus deiner Nachricht"}],
        },
        {
            "type": "table",
            "title": "Top-Kunden 2025",
            "data": {
                "columns": ["Kunde", "Umsatz (T€)", "Aufträge"],
                "rows": [["Müller GmbH", 412, 88], ["Schmidt AG", 388, 61], ["Weber KG", 301, 74]],
            },
            "sources": src,
        },
    ]
    return [
        {
            "round": 2,
            "tool": "render_widget",
            "command": call["title"],
            "output": "Shown to the user.",
            "exit_code": 0,
            "widget": build(call),
        }
        for call in calls
    ]


def _ui_widget_raw(index: int, skill_name: str = "interactive-answers") -> dict:
    """The skill example as written, before render-time processing."""
    skill = ROOT / "system_skills" / skill_name / "SKILL.md"
    body = skill.read_text(encoding="utf-8").split("```json\n")[index + 1].split("\n```", 1)[0]
    return json.loads(body)


def _ui_widget(index: int = 0, skill_name: str = "interactive-answers") -> dict:
    """A render_ui widget (src/interactive_ui.py). The payload is one of the
    complete examples from the built-in skills (system_skills/), so the preview
    also proves that the examples the model learns from actually render."""
    skill = ROOT / "system_skills" / skill_name / "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    body = text.split("```json\n")[index + 1].split("\n```", 1)[0]
    data = json.loads(body)
    # What do_render_ui does with declared data sources: register them (here a
    # fixed id the mock /api/ui/data answers for) and keep only the public part.
    if data.get("dataSources"):
        from src.ui_data import normalize_sources, public_spec

        data["uiId"] = "0" * 32
        data["dataSources"] = [public_spec(s) for s in normalize_sources(data["dataSources"])]
    data.setdefault("jsInit", [])
    data.setdefault("placeholderMessages", [])
    return {"type": "ui", "version": 1, "data": data}


def _ui_stream_events(index: int = 0, chunk: int = 40) -> list:
    """The ui_stream_* frames the backend emits while a render_ui call is being
    written — produced by the real UiStream over the skill example, cut into
    token-sized pieces."""
    from src.interactive_ui import UiStream

    args = json.dumps(_ui_widget(index)["data"], ensure_ascii=False)
    stream = UiStream("1-0")
    events = []
    for end in range(chunk, len(args) + chunk, chunk):
        events.extend(stream.feed(args[:end]))
    return events


def _news_widget() -> dict:
    """A get_news widget payload in the shape src/news.py emits.

    The ages are computed off the current clock rather than hard-coded, so the
    card's relative-time rendering ("gerade eben" / "vor 5 Std." / "vor 2 Tagen"
    / an absolute date past a week) is actually exercised every time the preview
    runs. One article deliberately carries no timestamp — engines vary, and a
    card missing its age must still line up."""
    import datetime as _dt

    now = _dt.datetime.now(_dt.timezone.utc)

    def _ago(**kwargs) -> str:
        return (now - _dt.timedelta(**kwargs)).isoformat()

    return {
        "type": "news",
        "version": 1,
        "data": {
            "query": "EU AI Act",
            "timeRange": "week",
            "hiddenByPolicy": 2,
            "articles": [
                {
                    "title": "EU AI Act: Übergangsfristen für Hochrisiko-Systeme laufen aus",
                    "url": "https://www.tagesschau.de/wirtschaft/eu-ai-act-102.html",
                    "source": "tagesschau.de",
                    "snippet": "Anbieter von Hochrisiko-KI müssen ab kommendem Monat eine Konformitätsbewertung vorlegen. Was das für Unternehmen bedeutet, die Modelle nur einkaufen.",
                    "published": _ago(minutes=20),
                    "thumbnail": "https://www.tagesschau.de/img/ai-act-102.jpg",
                },
                {
                    "title": "Was der AI Act für Entwickler konkret bedeutet",
                    "url": "https://www.heise.de/news/ai-act-entwickler-9999999.html",
                    "source": "heise.de",
                    "snippet": "Dokumentationspflichten, Logging, Risikomanagement — eine Einordnung der Anforderungen für Teams, die eigene Modelle betreiben.",
                    "published": _ago(hours=5),
                    "thumbnail": "https://www.heise.de/scale/ai-act.jpg",
                },
                {
                    "title": "Kommission veröffentlicht Leitlinien zu General-Purpose-AI",
                    "url": "https://netzpolitik.org/2026/gpai-leitlinien/",
                    "source": "netzpolitik.org",
                    "snippet": "Der Entwurf präzisiert, ab welcher Rechenleistung ein Modell als systemisches Risiko gilt.",
                    "published": _ago(days=2),
                    # Refused by the proxy (the mock 403s anything with "broken"
                    # in the URL, as the real one does for a blocked domain or a
                    # non-image response). The row must render WITHOUT a picture
                    # rather than showing a broken-image glyph.
                    "thumbnail": "https://netzpolitik.org/broken-image.jpg",
                },
                {
                    "title": "Analyse: Wer den AI Act tatsächlich durchsetzt",
                    "url": "https://www.zeit.de/digital/ai-act-durchsetzung",
                    "source": "zeit.de",
                    "snippet": "Die nationalen Marktüberwachungsbehörden sind personell dünn besetzt.",
                    "published": _ago(days=12),
                    "thumbnail": "https://img.zeit.de/digital/ai-act-durchsetzung.jpg",
                },
                {
                    # No timestamp: the row must still align without an age.
                    "title": "Hintergrund: Die Entstehung des AI Act",
                    "url": "https://example.org/hintergrund-ai-act",
                    "source": "example.org",
                    "snippet": "Von der ersten Fassung bis zur Verabschiedung.",
                    "published": "",
                },
            ],
        },
    }


def _sse(event: dict | str) -> str:
    if event == "[DONE]":
        return "data: [DONE]\n\n"
    return f"data: {json.dumps(event)}\n\n"


# Mock subagents (`delegate`): started by a chat message mentioning
# "subagent"/"delegate", then advanced by wall-clock on every /api/bg-tasks
# poll so the tray shows them working step by step and finishing.
_SUBAGENT_RUNS: list[dict] = []
_SUBAGENT_PLAN = [
    (
        "Handbuch A: Export",
        "Read the export chapter of Handbuch_A.pdf and list every configuration step.",
        [
            ("list_knowledge", '{"query": "Handbuch"}'),
            ("read_knowledge", '{"document": "Handbuch_A.pdf"}'),
            ("read_knowledge", '{"document": "Handbuch_A.pdf", "section": "7-9"}'),
        ],
        "**Export einrichten (Handbuch A, §7–9)**\n\n1. *Einstellungen › Export* öffnen [1]\n"
        "2. Zielordner wählen [1]\n3. Format **CSV (UTF-8)** setzen [2]",
    ),
    (
        "Handbuch B: Export",
        "Read the export chapter of Handbuch_B.pdf and list every configuration step.",
        [
            ("grep_knowledge", '{"pattern": "Export", "document": "Handbuch_B.pdf"}'),
            ("read_knowledge", '{"document": "Handbuch_B.pdf", "pages": "40-44"}'),
        ],
        "**Export (Handbuch B, S. 40–44)**\n\nGleiche Schritte, zusätzlich *Zeitplan* [3].",
    ),
    (
        "Workshop: Export",
        "In Workshop_Export.mp4 list the export steps the presenter performs, with timestamps.",
        [
            ("read_knowledge", '{"document": "Workshop_Export.mp4"}'),
            ("read_knowledge", '{"document": "Workshop_Export.mp4", "time": "0:12:00-0:25:00"}'),
            ("search_knowledge", '{"query": "Export Zeitplan", "document": "Workshop_Export.mp4"}'),
        ],
        "Ab **0:12:40** zeigt der Referent den Export-Dialog [4]; Zeitplan bei 0:21:05 [5].",
    ),
]


def _start_mock_subagents(session_id: str) -> None:
    now = time.time()
    group = f"g{int(now)}"
    for i, (title, prompt, steps, report) in enumerate(_SUBAGENT_PLAN):
        _SUBAGENT_RUNS.append(
            {
                "id": f"sub{int(now)}{i}",
                "session_id": session_id,
                "group": group,
                "title": title,
                "prompt": prompt,
                "steps": steps,
                "report": report,
                "started_at": now,
                # Staggered finish so the tray shows mixed states.
                "duration": 7 + 3 * i,
            }
        )


def _mock_bg_tasks(session_id: str) -> list[dict]:
    now = time.time()
    out = []
    for run in _SUBAGENT_RUNS:
        if run["session_id"] != session_id:
            continue
        # A stopped run freezes at the moment the tray's stop button was hit.
        stopped_at = run.get("stopped_at")
        elapsed = (stopped_at or now) - run["started_at"]
        done = stopped_at is not None or elapsed >= run["duration"]
        per = run["duration"] / (len(run["steps"]) + 1)
        shown = min(len(run["steps"]), int(elapsed / per) + 1)
        steps = []
        for j, (tool, command) in enumerate(run["steps"][:shown]):
            running = not done and j == shown - 1 and elapsed < per * (j + 1)
            steps.append(
                {"tool": tool, "command": command, "status": "running" if running else "done"}
            )
        stopped = stopped_at is not None
        out.append(
            {
                "id": run["id"],
                "kind": "subagent",
                "label": run["title"],
                "status": "failed" if stopped else ("done" if done else "running"),
                "started_at": run["started_at"],
                "ended_at": (stopped_at or run["started_at"] + run["duration"]) if done else None,
                "exit_code": (1 if stopped else 0) if done else None,
                "timed_out": False,
                "stopped": stopped,
                "output": (
                    "Lese die Abschnitte…\n\n[Stopped by the user.]"
                    if stopped
                    else run["report"]
                    if done
                    else ("Lese die Abschnitte…" if shown > 1 else "")
                ),
                "prompt": run["prompt"],
                "group": run["group"],
                "steps": steps,
            }
        )
    return out


# The delegating turn's update_plan checklist, ticked off as the mock runs.
_MOCK_PLAN = (
    "- [{}] Quellen bestimmen\n- [{}] Handbuch A lesen\n- [{}] Handbuch B lesen\n"
    "- [{}] Workshop auswerten\n- [{}] Antwort schreiben"
)


def _delegate_stream() -> bytes:
    tasks = [{"title": t, "prompt": p} for t, p, _, _ in _SUBAGENT_PLAN]
    events: list[dict | str] = [
        {"delta": "Three independent lookups — I will hand them to subagents.\n", "thinking": True},
        {"type": "plan_update", "data": {"plan": _MOCK_PLAN.format("x", " ", " ", " ", " ")}},
        {"type": "tool_start", "tool": "delegate", "command": json.dumps({"tasks": tasks})},
        ": sleep 13",
        {
            "type": "tool_output",
            "tool": "delegate",
            "output": "3/3 subagent task(s) finished.",
            "exit_code": 0,
        },
        {"type": "plan_update", "data": {"plan": _MOCK_PLAN.format("x", "x", "x", "x", " ")}},
        {"delta": "Alle drei Quellen beschreiben den Export gleich: Einstellungen › Export [1], "},
        {
            "delta": "Format CSV [2]; Handbuch B ergänzt einen Zeitplan [3], im Workshop ab 0:12:40 [4]."
        },
        "[DONE]",
    ]
    return "".join(
        e + "\n\n" if isinstance(e, str) and e.startswith(":") else _sse(e) for e in events
    ).encode("utf-8")


def _preview_stream(message: str) -> bytes:
    code = """import duckdb
import pandas as pd

df = pd.DataFrame({"item": ["A", "B", "C"], "value": [12, 19, 7]})
result = duckdb.sql("SELECT item, value, value * 1.19 AS gross FROM df ORDER BY gross DESC").df()
print(result)
"""
    events: list[dict | str] = [
        # Auto-compaction fired before this turn (history crossed the threshold);
        # the real backend emits this just before streaming. Renders the in-stream
        # "earlier messages summarized" marker above the assistant turn.
        {"type": "compacted", "context_length": 40960},
        # Live context-meter frames. The real backend emits one at the top of
        # the turn (history only, before any prep work), a refined one after
        # prompt assembly, one per usage report, and one after each round's tool
        # results land — so the meter fills at the start of the turn instead of
        # only when final metrics arrive.
        #
        # Frame 1: turn start. Only the conversation history exists, so the
        # split is coarse — but it is real, and the ring moves immediately.
        {
            "type": "metrics",
            "data": {
                "context_percent": 15.7,
                "context_length": 262144,
                "context_tokens": 41200,
                "usage_source": "estimated",
                "context_breakdown": {"messages": 29200, "toolResults": 12000},
            },
        },
        # Frame 2: prompt assembled — system prompt, tool schemas, skills index
        # and retrieved knowledge have landed, so every category appears.
        {
            "type": "metrics",
            "data": {
                "context_percent": 41.2,
                "context_length": 262144,
                "context_tokens": 108000,
                "usage_source": "estimated",
                "context_breakdown": {
                    "system": 8120,
                    "tools": 12400,
                    "mcpTools": 9260,
                    "skills": 6400,
                    "knowledge": 21280,
                    "documents": 14300,
                    "toolResults": 12000,
                    "messages": 24240,
                },
            },
        },
        {
            "delta": "I need to inspect the request, decide whether a quick calculation is enough, and then show the UI states for reasoning, code, tools, and metrics.\n",
            "thinking": True,
        },
        {
            "delta": "The request is a local preview, so I will simulate a Python/DuckDB calculation and stream a small code artifact.\n",
            "thinking": True,
        },
        {"type": "tool_start", "tool": "python", "command": "python preview_calculation.py"},
        {
            "type": "tool_progress",
            "tool": "python",
            "tail": "Creating dataframe...\nRunning DuckDB SQL...",
        },
        {
            "type": "tool_output",
            "tool": "python",
            "command": "python preview_calculation.py",
            "output": "  item  value  gross\n0    B     19  22.61\n1    A     12  14.28\n2    C      7   8.33",
            "exit_code": 0,
        },
        {"type": "doc_stream_open", "title": "preview_calculation.py", "language": "python"},
        {"type": "doc_stream_delta", "content": code[:90]},
        {"type": "doc_stream_delta", "content": code[90:]},
        {
            "delta": "Here is a mocked local preview response. It includes a reasoning block, a running Python tool card, a streamed code/document preview, and token metrics.\n\n"
        },
        {"delta": f"Your message was: `{message or '(empty)'}`\n\n"},
        {"delta": "```python\n" + code + "```\n\n"},
        {"delta": "The computed highest gross value is **22.61** for item **B**."},
        # Second agent round: must render as a NEW bubble with its own
        # reasoning block (agent_step delimits rounds in the real stream).
        {"type": "agent_step", "round": 2},
        {
            "delta": "Round two: I should double-check the result before summarizing.\n",
            "thinking": True,
        },
        {
            "delta": "Looks right — gross = value × 1.19 and B has the largest value.\n",
            "thinking": True,
        },
        # show_image flow: the image must render exactly once (inline at the
        # tool row), not again in a grid at the end of the message.
        {"type": "tool_start", "tool": "show_image", "command": "chart.png"},
        {
            "type": "tool_output",
            "tool": "show_image",
            "command": "chart.png",
            "output": "[Displayed 1 image(s) to the user inline: chart.png]",
            "exit_code": 0,
            "created_images": [
                {
                    "name": "chart.png",
                    "data_url": (
                        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dw"
                        "n4GBgYGJAQowMQAAOQYDB1G7K2IAAAAASUVORK5CYII="
                    ),
                }
            ],
        },
        # present_files flow: the agent names the turn's deliverables, which
        # render as output cards under the answer (and lead the file panel).
        {
            "type": "tool_start",
            "tool": "present_files",
            "command": '{"files": ["revenue.xlsx", "summary.md"]}',
        },
        {
            "type": "tool_output",
            "tool": "present_files",
            "command": '{"files": ["revenue.xlsx", "summary.md"]}',
            "output": "Shown to the user: revenue.xlsx, summary.md",
            "exit_code": 0,
            "presented_files": ["revenue.xlsx", "summary.md"],
        },
        # Widget flow: a tool result that carries a structured payload. The card
        # must render OUTSIDE the collapsed tool group (it is the answer, not a
        # log line) and exactly once — not again in the settled turn's recap.
        {"type": "tool_start", "tool": "get_weather", "command": '{"location": "Zürich"}'},
        {
            "type": "tool_output",
            "tool": "get_weather",
            "command": '{"location": "Zürich"}',
            "output": "Weather for Zurich, Switzerland (local time 2026-08-11T15:00).\nNow: 21.5°C, feels like 19.2°C, mainly clear, wind 11.4 km/h, humidity 34%.",
            "exit_code": 0,
            "widget": _weather_widget(),
        },
        # A second widget type in the SAME turn: both cards must render, each
        # with its own spacing, in the order the tools ran.
        # list_tables: the longest thing query_sql ever returns, and the case
        # that reached the user as a wall of text because the widget was only
        # wired to `query` and `describe`.
        {"type": "tool_start", "tool": "query_sql", "command": '{"action": "list_tables"}'},
        {
            "type": "tool_output",
            "tool": "query_sql",
            "command": '{"action": "list_tables"}',
            "output": "dbo.dim1\ndbo.dim2\n… (5800 tables)",
            "exit_code": 0,
            "widget": {
                "type": "table",
                "version": 1,
                "data": {
                    "columns": ["schema", "table"],
                    "rows": (
                        [["client_spark_user20", "pivot_ctx_1234"]]
                        + [["dbo", f"dim{i}"] for i in range(1, 120)]
                        + [["dbo", f"ent{200 + i}"] for i in range(0, 80)]
                        + [["", "unqualified_legacy_table"]]
                    ),
                    "rowCount": 5800,
                    "shown": 201,
                    "trimmed": True,
                    "label": "5800 tables",
                    "database": "",
                    "spillPath": "",
                },
            },
        },
        {"type": "tool_start", "tool": "get_news", "command": '{"query": "EU AI Act"}'},
        {
            "type": "tool_output",
            "tool": "get_news",
            "command": '{"query": "EU AI Act"}',
            "output": 'News: "EU AI Act" — 5 article(s).\n1. **EU AI Act: Übergangsfristen für Hochrisiko-Systeme laufen aus**',
            "exit_code": 0,
            "widget": _news_widget(),
        },
        # An interactive answer (render_ui), streamed the way the agent loop
        # streams it: the call's arguments arrive in pieces and become
        # ui_stream_* events (src/interactive_ui.UiStream), then the call runs.
        *_ui_stream_events(),
        {
            "type": "tool_start",
            "tool": "render_ui",
            "command": "Angebotsvergleich – gewichtete Bewertung",
        },
        {
            "type": "tool_output",
            "tool": "render_ui",
            "command": "Angebotsvergleich – gewichtete Bewertung",
            "output": "Interactive answer rendered inline for the user.",
            "exit_code": 0,
            "widget": _ui_widget(),
        },
        # An unknown widget type must render as NOTHING rather than an error —
        # that is what keeps a backend ahead of the deployed bundle safe.
        {"type": "tool_start", "tool": "bash", "command": "echo future"},
        {
            "type": "tool_output",
            "tool": "bash",
            "command": "echo future",
            "output": "future",
            "exit_code": 0,
            "widget": {"type": "not-yet-implemented", "version": 1, "data": {"x": 1}},
        },
        {"delta": "Second-round reply: the calculation checks out, **B** stays on top."},
        {
            "type": "metrics",
            "data": {
                "model": "mock-ui-preview",
                "response_time": 1.42,
                # Near-full window with a real tokenizer count, so the context meter
                # shows the "exact" badge and the post-compaction usage.
                "input_tokens": 247650,
                "output_tokens": 156,
                "tokens_per_second": 109.9,
                # A near-full 262k window is the worst case for the meter's
                # layout: "262k of 262k tokens" is the widest the numbers get.
                "context_percent": 94.5,
                "context_length": 262144,
                "context_tokens": 247650,
                "usage_source": "real",
                # Category split for the meter's detail panel; sums to
                # context_tokens (backend guarantees this). All categories
                # present so the full ramp and every legend label render.
                "context_breakdown": {
                    "system": 8120,
                    "tools": 12400,
                    "mcpTools": 9260,
                    "skills": 6400,
                    "knowledge": 21280,
                    "documents": 14300,
                    "toolResults": 98600,
                    "messages": 77290,
                },
            },
        },
        {"type": "message_saved", "id": "preview-message"},
        "[DONE]",
    ]
    return "".join(_sse(event) for event in events).encode("utf-8")


# In-memory stand-in for routes/mcp_routes.py (Settings → MCP connections).
# A server whose command or url contains "fail" comes up in the error state.
_MCP_SERVERS: list[dict] = [
    {
        "id": "a1b2c3d4",
        "name": "github",
        "transport": "http",
        "command": None,
        "args": [],
        "env": {},
        "url": "https://api.githubcopilot.com/mcp/",
        "is_enabled": True,
        "disabled": ["delete_repository"],
        "tools": [
            ("search_repositories", "Search GitHub repositories by query."),
            ("get_file_contents", "Read a file or directory listing from a repository."),
            ("create_issue", "Open a new issue in a repository."),
            ("delete_repository", "Permanently delete a repository."),
        ],
    },
]


def _mcp_status(srv: dict) -> dict:
    target = f"{srv.get('command') or ''} {' '.join(srv['args'])} {srv.get('url') or ''}"
    failed = "fail" in target
    connected = srv["is_enabled"] and not failed
    total = len(srv["tools"]) if connected else 0
    disabled = len(srv["disabled"])
    return {
        **{k: srv[k] for k in ("id", "name", "transport", "command", "args", "env", "url", "is_enabled")},
        "status": "connected" if connected else ("error" if srv["is_enabled"] else "disconnected"),
        "tool_count": total,
        "disabled_tool_count": disabled,
        "enabled_tool_count": max(0, total - disabled),
        "error": "spawn npx ENOENT: command failed to start" if srv["is_enabled"] and failed else None,
        "auth_url": None,
        "has_oauth": False,
        "needs_oauth": False,
    }


def _mcp_find(path: str) -> dict | None:
    sid = path[len("/api/mcp/servers/") :].split("/")[0]
    return next((s for s in _MCP_SERVERS if s["id"] == sid), None)


def _form_fields(body: bytes, ctype: str) -> dict[str, str]:
    """Plain (non-file) fields of a multipart/form-data body."""
    if "boundary=" not in ctype:
        return {}
    boundary = ctype.split("boundary=")[1].split(";")[0].strip()
    fields = {}
    for part in body.split(b"--" + boundary.encode()):
        header_blob, _, data = part.partition(b"\r\n\r\n")
        if b'name="' not in header_blob or b'filename="' in header_blob:
            continue
        name = header_blob.split(b'name="')[1].split(b'"')[0].decode()
        fields[name] = data[:-2].decode("utf-8", errors="replace") if data.endswith(b"\r\n") else data.decode()
    return fields


# In-memory shared-skills store for the settings panel preview.
# Files posted to /api/upload during this preview run: id -> (name, mime, bytes).
_UPLOADS: dict[str, tuple[str, str, bytes]] = {}

_SHARED_SKILLS: list[dict] = [
    {
        "name": "pdf-report-builder",
        "description": "Build polished PDF reports from raw data.",
        "uploaded_by": "alice",
        "size": 2048,
        "files": 3,
        "enabled": True,
        "mine": False,
    },
    {
        "name": "weekly-summary",
        "description": "Summarize the week's chats into a structured digest.",
        "uploaded_by": "preview",
        "size": 1024,
        "files": 0,
        "enabled": False,
        "mine": True,
    },
]


# ── Users & usage workspace (#/users) ──
# Shapes must match client.ts UsageOverview / UsageDetail / StorageOverview —
# the workspace dereferences every field.

# Admins come back from auth_manager.get_privileges with every flag on
# (core/auth.py ADMIN_PRIVILEGES), so mirror that — an admin row rendered with
# empty privileges would make the read-only panel look wrong in the preview.
_ADMIN_PRIVS = {
    "can_use_agent": True,
    "can_use_browser": True,
    "can_use_documents": True,
    "can_use_research": True,
    "can_generate_images": True,
    "can_manage_memory": True,
    "can_use_shell": True,
    "can_use_files": True,
    "can_search_chats": True,
    "can_use_mcp": True,
    "can_use_vault": True,
    "can_manage_instance": True,
    "max_messages_per_day": 0,
    "allowed_models": [],
}

_PREVIEW_USERS = [
    {
        "username": "preview",
        "display_name": "Preview Admin",
        "is_admin": True,
        "privileges": dict(_ADMIN_PRIVS),
    },
    {
        "username": "mara",
        "display_name": "Mara Kessler",
        "is_admin": False,
        # Mixed tool grants so the preview shows the Tools section in both
        # states rather than an all-off column.
        "privileges": {
            "can_use_agent": True,
            "can_use_shell": True,
            "can_use_files": True,
            "can_search_chats": True,
            "max_messages_per_day": 40,
        },
    },
    {"username": "jonas", "display_name": None, "is_admin": False, "privileges": {}},
    {"username": "sam", "display_name": "Sam Ito", "is_admin": False, "privileges": {}},
]

# (username, turns, tokens, tools, web, skill loads, errors)
_USAGE_SEED = {
    "preview": (61, 980_000, 140, 18, 9, 3),
    "mara": (214, 3_400_000, 512, 74, 41, 22),
    "jonas": (38, 410_000, 61, 6, 2, 1),
    "sam": (0, 0, 0, 0, 0, 0),
}


def _usage_row(name: str, days: int) -> dict:
    turns, tokens, tools, web, skills, errors = _USAGE_SEED.get(name, (0, 0, 0, 0, 0, 0))
    scale = 1 if days == 0 else min(1.0, days / 90)
    turns, tokens, tools = int(turns * scale), int(tokens * scale), int(tools * scale)
    acct = next((u for u in _PREVIEW_USERS if u["username"] == name), {})
    return {
        "username": name,
        "display_name": acct.get("display_name"),
        "is_admin": acct.get("is_admin", False),
        "orphaned": False,
        "turns": turns,
        "tool_calls": tools,
        "tool_errors": int(errors * scale),
        "input_tokens": int(tokens * 0.82),
        "output_tokens": int(tokens * 0.18),
        "total_tokens": tokens,
        "sessions": max(0, turns // 6),
        "active_days": min(days or 90, max(0, turns // 8)),
        "web_searches": int(web * scale),
        "skill_loads": int(skills * scale),
        "skills_created": 2 if name == "mara" else 0,
        "top_tool": "web_search" if turns else None,
        "modes": {"full": turns // 2, "knowledge": turns // 3, "chat": turns // 8} if turns else {},
        "last_active": _iso(-3600 * 5) if turns else None,
        "rank": 0,
    }


def _rag_chunks(source: str) -> list:
    """Fake indexed chunks so the RAG explorer (list, inspector, search) is
    clickable in the preview harness."""
    base = os.path.basename(source or "document")
    bodies = [
        "Onboarding: every new employee receives a laptop and an ID badge on day one.",
        "Travel expenses are reimbursed within 14 days once the receipt is uploaded.",
        "The escalation path for production incidents is on-call → team lead → CTO.",
    ]
    return [
        {
            "id": f"{base}-{i}",
            "content": f"## {base} · section {i + 1}\n\n{body}",
            "seq": i,
            "section_id": f"sec{i}",
            "context": "Chapter 2, employee handbook" if i == 0 else "",
            "context_error": "",
            "aux_terms": "onboarding, laptop, badge" if i == 0 else "",
            "aux_terms_error": "",
            "symbol": "",
            "language": "",
            "modality": "text",
            "metadata": {"source": source, "filename": base, "seq": i, "page": i + 1},
        }
        for i, body in enumerate(bodies)
    ]


def _usage_overview(days: int) -> dict:
    rows = [_usage_row(u["username"], days) for u in _PREVIEW_USERS]
    rows.sort(key=lambda r: r["total_tokens"], reverse=True)
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    tot = [r["total_tokens"] for r in rows]
    return {
        "days": days,
        "users": rows,
        "totals": {
            "turns": sum(r["turns"] for r in rows),
            "tool_calls": sum(r["tool_calls"] for r in rows),
            "total_tokens": sum(tot),
            "input_tokens": sum(r["input_tokens"] for r in rows),
            "output_tokens": sum(r["output_tokens"] for r in rows),
            "sessions": sum(r["sessions"] for r in rows),
            "active_users": sum(1 for r in rows if r["turns"]),
        },
        "median": {
            "turns": sorted(r["turns"] for r in rows)[len(rows) // 2],
            "total_tokens": sorted(tot)[len(tot) // 2],
            "tool_calls": sorted(r["tool_calls"] for r in rows)[len(rows) // 2],
        },
        # One model — the workspace hides the model breakdown at this size.
        "models": {"qwen3-llm": sum(r["turns"] for r in rows)},
    }


def _usage_detail(name: str, days: int) -> dict:
    import datetime

    row = _usage_row(name, days)
    today = datetime.date.today()
    daily = []
    for i in range(91):
        d = today - datetime.timedelta(days=90 - i)
        busy = (i * 13) % 7
        tokens = busy * (row["total_tokens"] // 200 or 1) if row["turns"] else 0
        daily.append(
            {
                "date": d.isoformat(),
                "turns": busy if row["turns"] else 0,
                "tokens": tokens,
                # Roughly the real ratio: prompts dominate, output is the
                # expensive minority.
                "input": int(tokens * 0.82),
                "output": tokens - int(tokens * 0.82),
                "tools": busy // 2 if row["turns"] else 0,
            }
        )
    hours = [0] * 24
    weekday = [0] * 7
    if row["turns"]:
        for h, n in (
            (8, 4),
            (9, 11),
            (10, 19),
            (11, 14),
            (13, 9),
            (14, 16),
            (15, 12),
            (16, 6),
            (21, 3),
        ):
            hours[h] = n
        for wd, n in ((0, 21), (1, 27), (2, 24), (3, 19), (4, 14), (5, 3), (6, 1)):
            weekday[wd] = n
    return {
        "username": name,
        "days": days,
        "tiles": {
            "turns": row["turns"],
            "tool_calls": row["tool_calls"],
            "tool_errors": row["tool_errors"],
            "input_tokens": row["input_tokens"],
            "output_tokens": row["output_tokens"],
            "total_tokens": row["total_tokens"],
            "sessions": row["sessions"],
            "active_days": row["active_days"],
            "web_searches": row["web_searches"],
            "skill_loads": row["skill_loads"],
            "avg_tokens_per_turn": row["total_tokens"] // row["turns"] if row["turns"] else 0,
            "peak_hour": 10 if row["turns"] else None,
            "last_active": row["last_active"],
            "first_seen": _iso(-3600 * 24 * 74) if row["turns"] else None,
            "avg_response_ms": 4200 if row["turns"] else 0,
            "total_compute_ms": row["turns"] * 4200,
            "avg_rounds": 2.4 if row["turns"] else 0,
            "busiest_day": max(daily, key=lambda r: r["tokens"])["date"] if row["turns"] else None,
            "busiest_day_tokens": max((r["tokens"] for r in daily), default=0),
        },
        "daily": daily,
        "hours": hours,
        "weekday": weekday,
        "tools": [
            {"tool": t, "count": c, "errors": e}
            for t, c, e in (
                ("web_search", row["web_searches"], 0),
                ("read_file", max(0, row["tool_calls"] // 3), 1),
                ("run_shell", max(0, row["tool_calls"] // 4), row["tool_errors"]),
                ("read_skill", row["skill_loads"], 0),
                ("create_document", max(0, row["tool_calls"] // 9), 0),
            )
            if c
        ],
        "modes": row["modes"],
        "models": {"qwen3-llm": row["turns"]} if row["turns"] else {},
        "skills": {
            "used": [{"name": n, "count": c} for n, c in (("pdf-forms", 12), ("weekly-report", 5))]
            if row["skill_loads"]
            else [],
            "authored": ["weekly-report", "invoice-check"] if name == "mara" else [],
        },
        "comparison": {
            # Same rule as the real endpoint: how many users are strictly above.
            "rank": sum(
                1
                for u in _PREVIEW_USERS
                if _usage_row(u["username"], days)["total_tokens"] > row["total_tokens"]
            )
            + 1,
            "of": len(_PREVIEW_USERS),
            "median_tokens": 695_000,
            "median_turns": 49,
            "median_tools": 100,
        },
        "limit": {
            "max_messages_per_day": 40 if name == "mara" else 0,
            "hit_days": 6 if name == "mara" else 0,
        },
    }


def _user_storage(name: str) -> dict:
    seed = {
        "mara": [
            ("chats", 61, "1,204 messages", 4_100_000),
            ("documents", 22, None, 880_000),
            ("gallery", 14, None, 22_400_000),
            ("notes", 7, None, 0),
            ("tools", 3, None, 0),
        ],
        "preview": [("chats", 12, "190 messages", 620_000), ("notes", 2, None, 0)],
        "jonas": [("chats", 6, "74 messages", 210_000)],
        "sam": [],
    }.get(name, [])
    cats = [{"kind": k, "count": c, "detail": d, "bytes": b} for k, c, d, b in seed]
    known = {c["kind"] for c in cats}
    for kind in (
        "chats",
        "documents",
        "gallery",
        "notes",
        "tools",
        "drafts",
        "crew",
        "calendars",
        "comparisons",
    ):
        if kind not in known:
            cats.append({"kind": kind, "count": 0, "detail": None, "bytes": 0})
    return {
        "username": name,
        "categories": cats,
        "total_bytes": sum(c["bytes"] for c in cats),
        "uploads_attributable": False,
    }


def _sessions():
    now = int(time.time())
    return [
        {
            "id": "preview-session",
            "name": PREVIEW_SESSION_NAME,
            "model": "qwen3-llm",
            "endpoint_url": "mock://preview",
            "created_at": now,
            "updated_at": now,
            "last_accessed": now,
            "message_count": 2,
            "archived": False,
            "rag": False,
            "mode": "chat",
        }
    ]


def _session_metrics(sid: str):
    """Six made-up turns through the real turn_metrics_export, so the admin
    metrics pane shows every chart (thinking split, cache, timing, tools)."""
    from src.turn_metrics_export import build_rows

    messages = []
    shapes = [  # reasoning, answer, tool-call tokens, tools, cached share
        (820, 410, 0, [], 0.0),
        (1450, 380, 120, ["query_sql", "query_sql"], 0.62),
        (300, 900, 0, [], 0.81),
        (2100, 520, 260, ["web_search", "fetch_url", "web_search"], 0.74),
        (640, 1210, 90, ["create_document"], 0.88),
        (1900, 300, 180, ["query_sql", "run_python"], 0.9),
    ]
    for i, (reasoning, answer, tools_out, tools, cached) in enumerate(shapes, start=1):
        out = reasoning + answer + tools_out
        rounds = len(tools) + 1 if tools else 1
        prompt = 6000 + i * 2500
        profile = []
        for r in range(1, rounds + 1):
            profile.append(
                {
                    "round": r,
                    "first_token_s": 0.4 + 0.1 * r,
                    "first_visible_s": 0.4 + 0.1 * r + reasoning / 900 / rounds,
                    "stream_s": 0.4 + 0.1 * r + (reasoning + answer) / 900 / rounds,
                    "tools_s": 1.6 if r < rounds else 0,
                    "cached_tokens": int(prompt * cached),
                }
            )
        messages.append({"role": "user", "content": f"Testfrage {i}", "metadata": {}, "timestamp": ""})
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "timestamp": "",
                "metadata": {
                    "model": "qwen3-llm",
                    "time_to_first_token": round(0.5 + reasoning / 900, 2),
                    "response_time": round(sum(p["stream_s"] + p["tools_s"] for p in profile) + 0.3, 2),
                    "output_tokens": out,
                    "input_tokens": prompt * rounds,
                    "context_tokens": prompt + 900 * rounds,
                    "context_length": 65536,
                    "tokens_per_second": 38.0 + i * 1.7,
                    "tps_source": "backend",
                    "prefill_tps": 2400.0 + i * 40,
                    "usage_source": "real",
                    "reasoning_tokens": reasoning,
                    "answer_tokens": answer,
                    "tool_call_tokens": tools_out,
                    "output_split_source": "proportional",
                    "agent_prep_time": 0.18,
                    "context_build_s": 0.12,
                    "context_breakdown": {
                        "system": 3100, "tools": 4200, "skills": 600,
                        "toolResults": 1800 * i, "messages": 900 * i,
                    },
                    "round_profile": profile,
                    "tool_events": [
                        {"round": n + 1, "tool": name, "command": "{}", "exit_code": 1 if (i, n) == (4, 1) else 0}
                        for n, name in enumerate(tools)
                    ],
                },
            }
        )
    rows = build_rows(messages, sid)
    return {"turns": rows[:-1], "total": rows[-1] if rows else None}


# Mutable so the admin "Add models" panel can rename, toggle and delete.
_MODEL_ENDPOINTS = [
    {
        "id": "mock-qwen3",
        "name": "Mock Endpoint",
        "base_url": "mock://preview",
        "models": ["qwen3-llm"],
        "model_type": "llm",
        "is_enabled": True,
        "has_key": False,
        "status": "online",
    }
]


def _models():
    # Like the real /api/models: disabled endpoints drop out of the picker.
    return [ep for ep in _MODEL_ENDPOINTS if ep["is_enabled"]]


def _model_endpoint(path: str):
    ep_id = path[len("/api/model-endpoints/") :].split("/", 1)[0]
    return next((ep for ep in _MODEL_ENDPOINTS if ep["id"] == ep_id), None)



# Document-register mock data for the /rag content view: a re-uploaded file
# with history, a duplicate, a failed upload and a pre-register legacy file.
_SHA_V3 = "9f2c1a7be4d05c3e8a6b1f0d2e4c6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f"
_RAG_DOCS = [
    {
        "source": "/srv/uploads/kb-default/Reisekostenrichtlinie-3fa9c2d1e0.pdf",
        "filename": "Reisekostenrichtlinie.pdf",
        "type": ".pdf",
        "directory": "",
        "chunks": 42,
        "registered": True,
        "doc_id": "d_5b8e0c3a91f2d4e6a7b8c9d0",
        "logical_path": "Reisekostenrichtlinie.pdf",
        "origin": "upload",
        "status": "indexed",
        "version": 3,
        "content_sha256": _SHA_V3,
        "size_bytes": 1843200,
        "indexed_at": 1792500000,
        "updated_at": 1792500000,
        "duplicate_of": None,
        "lane": "docling",
        "parse_cached": True,
        "pipeline_fingerprint": "a41c9e07d2b35f68",
        "error": "",
        "warnings": ["2 extraction call(s) failed, e.g. ReadTimeout: VLM page 7"],
        "owner": None,
        "scope": None,
        "created_at": 1790000000,
        "deleted_at": None,
        "duplicate_of_name": "",
        "duplicate_of_source": "",
        "duplicates": [{"doc_id": "d_77aa", "filename": "Reisekosten Kopie.pdf"}],
        "versions": [
            {"version": 3, "content_sha256": _SHA_V3, "size_bytes": 1843200,
             "status": "current", "chunks": 42, "created_at": 1792500000, "file_available": True},
            {"version": 2, "content_sha256": "1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
             "size_bytes": 1790000, "status": "superseded", "chunks": 40,
             "created_at": 1791500000, "file_available": True},
            {"version": 1, "content_sha256": "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
             "size_bytes": 1650000, "status": "superseded", "chunks": 37,
             "created_at": 1790000000, "file_available": False},
        ],
    },
    {
        "source": "/srv/uploads/kb-default/Reisekosten_Kopie-81b2c3d4e5.pdf",
        "filename": "Reisekosten Kopie.pdf",
        "type": ".pdf",
        "directory": "",
        "chunks": 0,
        "registered": True,
        "doc_id": "d_77aa",
        "logical_path": "Reisekosten Kopie.pdf",
        "origin": "upload",
        "status": "duplicate",
        "version": 1,
        "content_sha256": _SHA_V3,
        "size_bytes": 1843200,
        "indexed_at": None,
        "duplicate_of": "d_5b8e0c3a91f2d4e6a7b8c9d0",
        "lane": "docling",
        "parse_cached": False,
        "pipeline_fingerprint": "a41c9e07d2b35f68",
        "error": "",
        "warnings": [],
        "duplicate_of_name": "Reisekostenrichtlinie.pdf",
        "duplicates": [],
        "versions": [],
    },
    {
        "source": "/srv/uploads/kb-default/scan_leer-0c9d8e7f6a.pdf",
        "filename": "scan_leer.pdf",
        "type": ".pdf",
        "directory": "",
        "chunks": 0,
        "registered": True,
        "doc_id": "d_c0ffee000000000000000001",
        "logical_path": "scan_leer.pdf",
        "origin": "upload",
        "status": "failed",
        "version": 1,
        "content_sha256": "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb",
        "size_bytes": 20480,
        "error": "no extractable text (empty/unsupported file)",
        "warnings": [],
        "lane": "docling",
        "duplicates": [],
        "versions": [],
    },
    {
        "source": "/srv/share/prices.xlsx",
        "filename": "prices.xlsx",
        "type": ".xlsx",
        "directory": "/srv/share",
        "chunks": 17,
        "registered": False,
    },
]


def _rag_doc_row(doc):
    row = {k: v for k, v in doc.items() if k not in ("versions", "duplicates")}
    sha = doc.get("content_sha256")
    row["duplicate_count"] = (
        sum(1 for d in _RAG_DOCS if sha and d.get("content_sha256") == sha) - 1 if sha else 0
    )
    return row


_RAG_JOBS = [
    {
        "id": "job-preview-1",
        "type": "index_files",
        "status": "completed",
        "directory": "",
        "base_id": "default",
        "indexed_count": 42,
        "failed_count": 1,
        "processed_count": 5,
        "total_count": 5,
        "current_file": "",
        "message": "Indexed 42 chunks, 1 new version(s), 2 unchanged, 1 duplicate(s) skipped, 1 file(s) failed",
        "errors": [{"file": "scan_leer.pdf", "error": "no extractable text (empty/unsupported file)"}],
        "outcomes": {"indexed": 0, "updated": 1, "unchanged": 2, "duplicate": 1, "failed": 1},
        "files": [],
        "created_at": 1792500000,
        "started_at": 1792500001,
        "ended_at": 1792500100,
    }
]

class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "TalosUIPreview/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str = "application/json",
        headers: dict | None = None,
    ):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data, status: int = 200):
        self._send(status, _json_bytes(data))

    def _send_event_stream(self, body: bytes):
        """Drip mock SSE events so running/queue UI states can be previewed."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        for event in body.split(b"\n\n"):
            if not event:
                continue
            if event.startswith(b": sleep "):
                # Mock-only pause: hold a tool "running" while the tray polls.
                time.sleep(float(event[len(b": sleep ") :]))
                continue
            self.wfile.write(event + b"\n\n")
            self.wfile.flush()
            time.sleep(0.15)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _serve_file(self, path: Path, root: Path = STATIC):
        try:
            resolved = path.resolve()
            if not str(resolved).startswith(str(root.resolve())) or not resolved.is_file():
                self._send_json({"error": "not found"}, 404)
                return
            ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            self._send(200, resolved.read_bytes(), ctype)
        except OSError as exc:
            self._send_json({"error": str(exc)}, 500)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            if (WEB_DIST / "index.html").is_file():
                self._serve_file(WEB_DIST / "index.html", root=WEB_DIST)
            else:
                self._serve_file(STATIC / "index.html")
            return
        if path == "/legacy":
            self._serve_file(STATIC / "index.html")
            return
        if path.startswith("/assets/"):
            self._serve_file(WEB_DIST / path.lstrip("/"), root=WEB_DIST)
            return
        if path == "/login":
            self._serve_file(STATIC / "login.html")
            return
        if path.startswith("/static/"):
            self._serve_file(STATIC / path[len("/static/") :])
            return

        if path.startswith("/api/upload/"):
            # Serves back whatever this run uploaded (see do_POST), which is what
            # the composer's image thumbnails point at.
            entry = _UPLOADS.get(unquote(path[len("/api/upload/") :]))
            if entry is None:
                self._send_json({"error": "not found"}, 404)
                return
            name, mime, data = entry
            self._send(200, data, mime, {"Content-Disposition": f'inline; filename="{name}"'})
            return
        if path == "/api/ui-shell":
            # Mirrors routes/document_routes.py: an empty document the inline
            # interactive answer is written into, under its own no-network CSP.
            shell = (
                '<!doctype html><meta charset="utf-8"><script>'
                "addEventListener('message',function receive(e){"
                "if(e.source!==parent||!e.data||e.data.type!=='talos:ui-document'||typeof e.data.html!=='string')return;"
                "removeEventListener('message',receive);"
                "document.open();document.write(e.data.html);document.close();});"
                "parent.postMessage({type:'talos:ui-shell-ready'},'*');"
                "</script>"
            )
            from src.interactive_ui import ui_shell_csp

            self._send(
                200,
                shell.encode("utf-8"),
                "text/html; charset=utf-8",
                {
                    "Content-Security-Policy": ui_shell_csp(),
                },
            )
            return
        if path == "/api/ui/config":
            from src.interactive_ui import DEFAULT_TILE_ATTRIBUTION, TILE_PROXY_PATH

            self._send_json(
                {
                    "maps": {
                        "enabled": True,
                        "osm": True,
                        "tileUrl": TILE_PROXY_PATH,
                        "attribution": DEFAULT_TILE_ATTRIBUTION,
                        "maxZoom": 19,
                    }
                }
            )
            return
        if path.startswith("/api/ui/tiles/"):
            # Stands in for the tile proxy (routes/ui_routes.py). The preview
            # never contacts a real tile server: a generated square per tile.
            self._send(200, _placeholder_png(path), "image/png", {"Cache-Control": "max-age=86400"})
            return
        if path == "/api/news/thumbnail":
            # Stands in for routes/news_routes.py — the news cards point their
            # <img> at this path, so without it the preview only ever exercises
            # the "thumbnail failed, render without it" branch. One URL is left
            # deliberately unresolvable in the fixture so that branch is covered
            # too; see _news_widget.
            source = parse_qs(parsed.query).get("url", [""])[0]
            if "broken" in source:
                self._send_json({"error": "refused"}, 403)
                return
            self._send(200, _placeholder_png(source), "image/png")
            return
        if path == "/api/auth/settings":
            self._send_json({"auth_enabled": False, "user": "preview", "is_admin": True})
            return
        if path == "/api/auth/status":
            # auth_enabled False ⇒ the React AuthGate renders the app directly.
            self._send_json(
                {
                    "configured": True,
                    "authenticated": True,
                    "username": "preview",
                    "is_admin": True,
                    "signup_enabled": False,
                    "auth_enabled": False,
                }
            )
            return
        if path == "/api/sessions":
            self._send_json(_sessions())
            return
        if path == "/api/sessions/archived":
            now = int(time.time())
            self._send_json(
                [
                    {
                        "id": "arch-1",
                        "name": "Old planning notes",
                        "archived": True,
                        "created_at": now,
                        "updated_at": now,
                        "last_message_at": now,
                        "message_count": 14,
                    },
                    {
                        "id": "arch-2",
                        "name": "Scratch experiment",
                        "archived": True,
                        "created_at": now,
                        "updated_at": now,
                        "last_message_at": now,
                        "message_count": 3,
                    },
                ]
            )
            return
        if path.startswith("/api/history/"):
            session_id = path[len("/api/history/") :]
            self._send_json(
                {
                    "id": session_id,
                    "name": PREVIEW_SESSION_NAME,
                    "history": _history_for(session_id),
                }
            )
            return
        if path == "/api/models":
            self._send_json(_models())
            return
        if path.startswith("/api/session/") and path.endswith("/metrics"):
            self._send_json(_session_metrics(path.split("/")[3]))
            return
        if path == "/api/model-endpoints":
            self._send_json(_MODEL_ENDPOINTS)
            return
        if path.startswith("/api/model-endpoints/") and path.endswith("/dependents"):
            self._send_json({"dependents": ["Standard-Chat-Modell"] if _model_endpoint(path) else []})
            return
        if path == "/api/tools":
            self._send_json(
                {
                    "tools": [
                        {"id": t, "enabled": t != "generate_image"}
                        for t in (
                            "bash",
                            "python",
                            "read_file",
                            "write_file",
                            "search_chats",
                            "create_document",
                            "generate_image",
                            "manage_skills",
                            "query_sql",
                            "list_models",
                        )
                    ]
                }
            )
            return
        if path == "/api/capabilities":
            # Pretend both knowledge sources are configured so the composer
            # renders the full RAG + SQL mode dropdown in the preview, and
            # voice so the mic button shows (streaming needs a real sidecar).
            self._send_json({"rag": True, "sql": True, "voice": True, "voice_streaming": False})
            return
        if path == "/api/sql/config":
            self._send_json(
                {
                    "databases": [
                        {
                            "id": "p1",
                            "name": "sales",
                            "enabled": True,
                            "db_type": "mssql",
                            "host": "db.example.local",
                            "port": "1433",
                            "database": "Sales",
                            "username": "ro_user",
                            "password_set": True,
                            "odbc_driver": "",
                        },
                        {
                            "id": "p2",
                            "name": "analytics",
                            "enabled": True,
                            "db_type": "postgresql",
                            "host": "pg.example.local",
                            "port": "5432",
                            "database": "analytics",
                            "username": "readonly",
                            "password_set": False,
                            "odbc_driver": "",
                        },
                    ]
                }
            )
            return
        if path == "/api/usage/me":
            days = int(parse_qs(parsed.query).get("days", ["30"])[0])
            detail = _usage_detail("preview", days)
            detail["comparison"] = None
            detail["limit"] = {"max_messages_per_day": 50, "hit_days": 0}
            self._send_json(detail)
            return
        if path == "/api/stats":
            # Shape must match client.ts UsageStats — StatsPanel dereferences
            # every field, so an empty object crashes the whole Welcome tree.
            import datetime

            today = datetime.date.today()
            self._send_json(
                {
                    "sessions": 42,
                    "messages": 813,
                    "total_tokens": 1_500_000,
                    "active_days": 23,
                    "current_streak": 3,
                    "longest_streak": 9,
                    "peak_hour": 10,
                    "favorite_model": "qwen3-llm",
                    "daily": [
                        {
                            "date": (today - datetime.timedelta(days=41 - i)).isoformat(),
                            "count": (i * 7) % 5,
                        }
                        for i in range(42)
                    ],
                }
            )
            return
        if path == "/api/auth/users":
            self._send_json({"users": _PREVIEW_USERS})
            return
        if path == "/api/admin/usage/overview":
            self._send_json(_usage_overview(int(parse_qs(parsed.query).get("days", ["30"])[0])))
            return
        # The per-user reads are POSTs — usernames are emails and stay out of
        # the URL. See do_POST.
        if path == "/api/rag/config":
            self._send_json(
                {
                    "enabled": True,
                    "provider": "internal",
                    "external_url": "",
                    "external_api_key_set": False,
                    "external_dataset_id": "",
                    "external_top_k": 5,
                    "embedding_url": "http://your-host:8001/v1/embeddings",
                    "embedding_model": "qwen3-embed",
                    "qdrant_url": "http://qdrant:6333",
                    "qdrant_api_key_set": False,
                    "rerank_url": "http://your-host:8002/v1/rerank",
                    "rerank_model": "qwen3-reranker",
                    "rerank_api_key_set": False,
                    "sparse_model": "Qdrant/bm25",
                    "chat_top_k": 5,
                    "search_top_k": 5,
                    "candidate_top_k": 40,
                    "similarity_threshold": 0.0,
                    "rerank_min_score": 0.3,
                    "max_context_chars": 10000,
                    "query_prefix": "",
                    "context_prompt": "",
                    "redact_pii_enabled": False,
                }
            )
            return
        if path == "/api/rag/jobs/diagnostics":
            self._send_json(
                {
                    "active_worker_count": 1,
                    "active_workers": ["preview"],
                    "multi_worker_warning": False,
                    "message": "Single active ingest worker",
                }
            )
            return
        if path == "/api/rag/bases":
            self._send_json(
                {
                    "bases": [
                        {
                            "id": "default",
                            "name": "Talos Knowledge Base",
                            "description": "Preview base",
                            "language": "de",
                            "collection": "talos_rag",
                            "chat_enabled": True,
                            "created_at": 0.0,
                            "updated_at": 0.0,
                            "override_count": 0,
                            "access": {"restricted": True, "users": ["anna"]},
                            "content_count": len(_RAG_DOCS),
                            "chunk_count": sum(d["chunks"] for d in _RAG_DOCS),
                        }
                    ]
                }
            )
            return
        if path == "/api/rag/jobs":
            self._send_json({"jobs": _RAG_JOBS})
            return
        if path == "/api/rag/documents":
            self._send_json(
                {
                    "available": True,
                    "documents": [_rag_doc_row(d) for d in _RAG_DOCS],
                    "sparse": {
                        "model": "Qdrant/bm25",
                        "indexed_language": "english",
                        "configured_language": "german",
                        "stale": True,
                    },
                }
            )
            return
        if path == "/api/rag/documents/detail":
            doc_id = parse_qs(parsed.query).get("doc_id", [""])[0]
            doc = next((d for d in _RAG_DOCS if d.get("doc_id") == doc_id), None)
            if doc is None:
                self._send_json({"detail": "Document is not in the register"}, 404)
                return
            self._send_json(doc)
            return
        if path == "/api/rag/documents/chunks":
            source = parse_qs(parsed.query).get("source", [""])[0]
            self._send_json({"available": True, "source": source, "chunks": _rag_chunks(source)})
            return
        if path == "/api/rag/documents/search":
            needle = parse_qs(parsed.query).get("q", [""])[0].lower()
            hits = []
            for src in ("/srv/uploads/handbook.pdf", "/srv/uploads/prices.xlsx"):
                for c in _rag_chunks(src):
                    if needle and needle in c["content"].lower():
                        hits.append(
                            {
                                "id": c["id"],
                                "source": src,
                                "filename": os.path.basename(src),
                                "seq": c["seq"],
                                "page": None,
                                "modality": c["modality"],
                                "snippet": c["content"][:200],
                            }
                        )
            self._send_json({"available": True, "query": needle, "count": len(hits), "hits": hits})
            return
        if path == "/api/rag/documents/original":
            name = os.path.basename(parse_qs(parsed.query).get("source", ["document"])[0])
            self._send(
                200,
                f"original bytes of {name}".encode("utf-8"),
                content_type="application/octet-stream",
                headers={"Content-Disposition": f'attachment; filename="{name}"'},
            )
            return
        if path == "/api/prefs/theme":
            self._send_json({})
            return
        if path == "/api/prefs/custom-themes":
            self._send_json([])
            return
        if path == "/api/bg-tasks":
            sid = parse_qs(parsed.query).get("session_id", [""])[0]
            self._send_json({"tasks": _mock_bg_tasks(sid)})
            return
        if path.startswith("/api/tasks"):
            self._send_json([] if path in ("/api/tasks", "/api/tasks/runs/recent") else {})
            return
        if path.startswith("/api/research"):
            self._send_json([] if any(x in path for x in ("active", "library")) else {})
            return
        if (
            path.startswith("/api/notes")
            or path.startswith("/api/memory")
            or path.startswith("/api/documents")
        ):
            self._send_json([])
            return
        if path.startswith("/api/search/providers"):
            self._send_json([])
            return
        if path.startswith("/api/workspace/browse"):
            self._send_json({"path": "/preview", "entries": []})
            return
        if path == "/api/artifacts":
            if not _LIBRARY:
                _LIBRARY.extend(_library_seed())
            self._send_json({"artifacts": _LIBRARY, "count": len(_LIBRARY)})
            return
        if path.startswith("/api/artifacts/"):
            # Download endpoint: stream one of the sample files (so the preview
            # panel has real markdown/csv/text to render in dev).
            # Match the trailing segment, not a substring: the preview's own
            # session is called "preview-session", which an `in path` test read
            # as the /preview endpoint and 404'd the artifact list.
            if path.endswith("/download"):
                name = parse_qs(parsed.query).get("path", [""])[0]
                content, ctype = _SAMPLE_ARTIFACTS.get(name, (b"", "application/octet-stream"))
                disp = "inline" if ctype.startswith("image/") else "attachment"
                self._send(
                    200,
                    content,
                    content_type=ctype,
                    headers={"Content-Disposition": f'{disp}; filename="{name}"'},
                )
                return
            # Office preview (LibreOffice→PDF) isn't available in the mock, so
            # 404 like a backend without the sandbox. This forces the frontend's
            # client-side fallback (SheetJS for .xlsx), matching real setups.
            if path.endswith("/preview"):
                self._send_json({"detail": "Sandbox not available"}, 404)
                return
            listing = (
                {
                    "artifacts": [
                        {
                            "path": "summary.md",
                            "size": len(_SAMPLE_ARTIFACTS["summary.md"][0]),
                            "mime": "text/markdown",
                        },
                        {
                            "path": "result.csv",
                            "size": len(_SAMPLE_ARTIFACTS["result.csv"][0]),
                            "mime": "text/csv",
                        },
                        {
                            "path": "notes.txt",
                            "size": len(_SAMPLE_ARTIFACTS["notes.txt"][0]),
                            "mime": "text/plain",
                        },
                        {
                            "path": "chart.png",
                            "size": len(_SAMPLE_ARTIFACTS["chart.png"][0]),
                            "mime": "image/png",
                            "is_image": True,
                        },
                        {
                            "path": "revenue.xlsx",
                            "size": len(_SAMPLE_ARTIFACTS["revenue.xlsx"][0]),
                            "mime": _SAMPLE_ARTIFACTS["revenue.xlsx"][1],
                        },
                        {
                            "path": "deck.pptx",
                            "size": len(_SAMPLE_ARTIFACTS["deck.pptx"][0]),
                            "mime": _SAMPLE_ARTIFACTS["deck.pptx"][1],
                        },
                    ]
                }
            )
            # Deleting on the Artifacts page removes the file here too.
            listing["artifacts"] = [a for a in listing["artifacts"] if a["path"] not in _LIBRARY_DELETED]
            self._send_json(listing)
            return
        if path == "/api/assistants":
            self._send_json(
                [
                    {
                        "id": "asst-1",
                        "name": "Support Bot",
                        "slug": "support-bot",
                        "endpoint_id": "preview-endpoint",
                        "endpoint_name": "Local Preview",
                        "model": "qwen3-llm",
                        "use_rag": True,
                        "use_sql": False,
                        "reasoning": True,
                        "require_auth": True,
                        "is_enabled": True,
                    },
                ]
            )
            return
        if path == "/api/shared-skills":
            self._send_json({"skills": _SHARED_SKILLS, "count": len(_SHARED_SKILLS)})
            return
        if path == "/api/mcp/servers":
            self._send_json([_mcp_status(s) for s in _MCP_SERVERS])
            return
        if path.startswith("/api/mcp/servers/") and path.endswith("/tools"):
            srv = _mcp_find(path)
            self._send_json(
                [
                    {
                        "server_id": srv["id"],
                        "name": n,
                        "qualified_name": f"mcp__{srv['id']}__{n}",
                        "description": d,
                        "is_disabled": n in srv["disabled"],
                    }
                    for n, d in srv["tools"]
                ]
                if srv
                else []
            )
            return
        if path.startswith("/api/"):
            self._send_json({})
            return

        self._serve_file(STATIC / path.lstrip("/"))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/mcp/servers":
            f = _form_fields(self._read_body(), self.headers.get("Content-Type", ""))
            srv = {
                "id": f"{len(_MCP_SERVERS) + 1:08x}",
                "name": f.get("name", ""),
                "transport": f.get("transport", "stdio"),
                "command": f.get("command"),
                "args": json.loads(f.get("args") or "[]"),
                "env": json.loads(f.get("env") or "{}"),
                "url": f.get("url"),
                "is_enabled": True,
                "disabled": [],
                "tools": [
                    ("list_targets", "List analysis targets known to this server."),
                    ("analyze", "Run an analysis on a target and return findings."),
                ],
            }
            _MCP_SERVERS.append(srv)
            st = _mcp_status(srv)
            self._send_json({**st, "connected": st["status"] == "connected"})
            return
        if path.startswith("/api/mcp/servers/") and path.endswith("/reconnect"):
            srv = _mcp_find(path)
            st = _mcp_status(srv) if srv else {"status": "disconnected", "tool_count": 0}
            self._send_json({**st, "connected": st["status"] == "connected"})
            return
        if path == "/api/ui/data":
            # Stands in for routes/ui_routes.py: resolves the parameters against
            # the skill example's declared source and returns made-up months.
            from src.ui_data import DataSourceError, normalize_sources, resolve_params

            body = json.loads(self._read_body() or b"{}")
            spec = next(
                (
                    s
                    for s in normalize_sources(_ui_widget_raw(0, "ui-data").get("dataSources"))
                    if s["id"] == body.get("sourceId")
                ),
                None,
            )
            if spec is None:
                self._send_json({"detail": "Unknown data source."}, 404)
                return
            try:
                params = resolve_params(spec, body.get("params"))
            except DataSourceError as e:
                self._send_json({"detail": str(e)}, 422)
                return
            time.sleep(0.4)
            factor = {2023: 0.82, 2024: 0.91}.get(params.get("jahr"), 1.0)
            base = [286, 302, 330, 329, 340, 361, 348, 320, 352, 368, 386, 424]
            rows = [[i + 1, round(v * factor)] for i, v in enumerate(base)]
            self._send_json(
                {
                    "sourceId": spec["id"],
                    "params": params,
                    "data": {
                        "columns": ["monat", "umsatz"],
                        "rows": rows,
                        "rowCount": 12,
                        "truncated": False,
                    },
                }
            )
            return
        if path.startswith("/api/bg-tasks/") and path.endswith("/stop"):
            job_id = path[len("/api/bg-tasks/") : -len("/stop")]
            for run in _SUBAGENT_RUNS:
                if run["id"] == job_id and "stopped_at" not in run:
                    if time.time() - run["started_at"] < run["duration"]:
                        run["stopped_at"] = time.time()
                        self._send_json({"stopped": True})
                        return
            self._send_json({"stopped": False, "reason": "already finished"})
            return
        body = self._read_body()
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" in ctype and "boundary=" in ctype:
            # Minimal multipart parse — enough to extract simple text fields
            # (the React UI posts FormData, matching the real backend).
            boundary = ctype.split("boundary=")[1].split(";")[0].strip()
            fields: dict[str, list[str]] = {}
            for part in body.split(b"--" + boundary.encode()):
                if b'name="' not in part:
                    continue
                header_blob, _, value = part.partition(b"\r\n\r\n")
                name = header_blob.split(b'name="')[1].split(b'"')[0].decode()
                fields.setdefault(name, []).append(
                    value.rstrip(b"\r\n-").decode("utf-8", errors="ignore")
                )
        else:
            fields = parse_qs(body.decode("utf-8", errors="ignore")) if body else {}

        if path == "/api/session":
            self._send_json(_sessions()[0])
            return
        if path == "/api/voice/transcribe":
            # Canned dictation result so the composer's voice flow (italic
            # interim → Enter confirms → Enter sends) is testable offline.
            self._send_json({"text": "Hallo Welt, das ist ein Diktat-Test."})
            return
        # Users & usage: the username travels in the body, never the URL.
        if path in (
            "/api/admin/usage/detail",
            "/api/admin/storage/detail",
            "/api/admin/storage/delete",
        ):
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                payload = {}
            name = str(payload.get("username", ""))
            if path == "/api/admin/usage/detail":
                self._send_json(_usage_detail(name, int(payload.get("days", 30))))
            elif path == "/api/admin/storage/detail":
                self._send_json(_user_storage(name))
            else:
                self._send_json({"status": "deleted", "kind": payload.get("kind"), "count": 1})
            return
        if path == "/api/chat_stream":
            message = fields.get("message", [""])[0]
            session_id = fields.get("session", ["preview-session"])[0]
            if "frage" in message.lower():
                _record_ask_turn(session_id, message)
                self._send_event_stream(_ask_stream())
                return
            try:
                ask_answers = json.loads(fields.get("ask_answers", [""])[0] or "null")
            except ValueError:
                ask_answers = None
            _record_turn(session_id, message, ask_answers)
            if "subagent" in message.lower() or "delegate" in message.lower():
                _start_mock_subagents(session_id)
                self._send_event_stream(_delegate_stream())
                return
            self._send_event_stream(_preview_stream(message))
            return
        if path.endswith("/delete-messages"):
            # /api/session/{id}/delete-messages — drop the rows so history stays
            # in sync with the runtime (edit/revert delete then re-send).
            session_id = path[len("/api/session/") : -len("/delete-messages")]
            try:
                ids = set(json.loads(body or b"{}").get("msg_ids", []))
            except (ValueError, AttributeError):
                ids = set()
            _HISTORY[session_id] = [
                m for m in _history_for(session_id) if m["metadata"].get("_db_id") not in ids
            ]
            self._send_json({"ok": True})
            return
        if path.endswith("/edit-message"):
            # /api/session/{id}/edit-message — update the stored content in place.
            session_id = path[len("/api/session/") : -len("/edit-message")]
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                payload = {}
            for m in _history_for(session_id):
                if m["metadata"].get("_db_id") == payload.get("msg_id"):
                    m["content"] = payload.get("content", m["content"])
                    break
            self._send_json({"ok": True})
            return
        if path == "/api/chat":
            self._send_json({"response": "This is a local UI preview response."})
            return
        if path == "/api/sql/test":
            # Failure shape: HTTP 200 + ok:false — the settings Test button
            # must surface the error, not report "Connection OK".
            self._send(
                200,
                _json_bytes(
                    {"ok": False, "error": "Login failed for user 'talos_ro' (preview mock)"}
                ),
            )
            return
        if path.startswith("/api/upload"):
            # Echo the posted files back (and keep their bytes in memory, served
            # from GET /api/upload/<id>) so the composer's attachment previews —
            # image thumbnails included — are exercisable in the preview.
            files = []
            if "multipart/form-data" in ctype and "boundary=" in ctype:
                boundary = ctype.split("boundary=")[1].split(";")[0].strip()
                for part in body.split(b"--" + boundary.encode()):
                    if b'filename="' not in part:
                        continue
                    header_blob, _, data = part.partition(b"\r\n\r\n")
                    filename = (
                        header_blob.split(b'filename="')[1]
                        .split(b'"')[0]
                        .decode("utf-8", errors="ignore")
                    )
                    if not filename:
                        continue
                    data = data.rstrip(b"\r\n-")
                    file_id = f"up-{len(_UPLOADS) + 1}"
                    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                    _UPLOADS[file_id] = (filename, mime, data)
                    files.append({"id": file_id, "name": filename, "mime": mime, "size": len(data)})
            self._send_json({"files": files})
            return
        if path == "/api/shared-skills/upload":
            # Multipart bundle upload — the preview doesn't unzip; it just adds
            # a canned bundle entry so the flow is exercisable in the UI.
            _SHARED_SKILLS[:] = [s for s in _SHARED_SKILLS if s["name"] != "uploaded-bundle"]
            _SHARED_SKILLS.append(
                {
                    "name": "uploaded-bundle",
                    "description": "Bundle uploaded in preview mode.",
                    "uploaded_by": "preview",
                    "size": len(body or b""),
                    "files": 4,
                    "enabled": True,
                    "mine": True,
                }
            )
            _SHARED_SKILLS.sort(key=lambda s: s["name"])
            self._send_json({"ok": True})
            return
        if path == "/api/shared-skills":
            try:
                content = json.loads(body or b"{}").get("content", "")
            except ValueError:
                content = ""
            import re as _re

            m = _re.match(r"\A\s*---\s*\n(.*?)\n---", content, _re.S)
            fm = dict(_re.findall(r"^([A-Za-z_-]+)\s*:\s*(.+)$", m.group(1), _re.M) if m else [])
            if not fm.get("name") or not fm.get("description"):
                self._send_json(
                    {"detail": "SKILL.md needs frontmatter with name + description"}, 400
                )
                return
            name = _re.sub(r"[^a-z0-9]+", "-", fm["name"].lower()).strip("-")
            _SHARED_SKILLS[:] = [s for s in _SHARED_SKILLS if s["name"] != name]
            _SHARED_SKILLS.append(
                {
                    "name": name,
                    "description": fm["description"].strip(),
                    "uploaded_by": "preview",
                    "size": len(content),
                    "files": 0,
                    "enabled": True,
                    "mine": True,
                }
            )
            _SHARED_SKILLS.sort(key=lambda s: s["name"])
            self._send_json({"ok": True})
            return
        if path.startswith("/api/"):
            self._send_json({"ok": True})
            return
        self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        body = self._read_body()
        path = urlparse(self.path).path
        if path.startswith("/api/shared-skills/") and path.endswith("/enabled"):
            name = path[len("/api/shared-skills/") : -len("/enabled")]
            try:
                enabled = bool(json.loads(body or b"{}").get("enabled"))
            except ValueError:
                enabled = True
            for s in _SHARED_SKILLS:
                if s["name"] == name:
                    s["enabled"] = enabled
        self._send_json({"ok": True})

    def do_PATCH(self):
        body = self._read_body()
        path = urlparse(self.path).path
        if path.startswith("/api/mcp/servers/"):
            srv = _mcp_find(path)
            if srv and path.endswith("/tools"):
                srv["disabled"] = list(json.loads(body or b"{}").get("disabled", []))
            elif srv:
                fields = _form_fields(body, self.headers.get("Content-Type", ""))
                srv["is_enabled"] = fields.get("is_enabled", "true").lower() == "true"
            self._send_json({"ok": True})
            return
        if path.startswith("/api/model-endpoints/"):
            ep = _model_endpoint(path)
            req = json.loads(body or b"{}")
            if ep:
                for key in ("name", "base_url", "model_type", "is_enabled"):
                    if key in req:
                        ep[key] = req[key]
                if "api_key" in req:
                    ep["has_key"] = bool(req["api_key"])
            self._send_json(ep or {})
            return
        if path == "/api/artifacts":
            req = json.loads(body or b"{}")
            for row in _LIBRARY:
                if row["path"] != req.get("path"):
                    continue
                if "pinned" in req:
                    row["pinned"] = bool(req["pinned"])
                    row["pinned_at"] = time.time() if req["pinned"] else None
                if req.get("name"):
                    ext = row["name"].rsplit(".", 1)[-1] if "." in row["name"] else ""
                    row["name"] = f"{req['name']}.{ext}" if ext else req["name"]
            self._send_json({"status": "ok", "path": req.get("path")})
            return
        self._send_json({"ok": True})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/artifacts":
            target = parse_qs(parsed.query).get("path", [""])[0]
            _LIBRARY[:] = [r for r in _LIBRARY if r["path"] != target]
            _LIBRARY_DELETED.add(target.split(":", 1)[-1])
        if path.startswith("/api/mcp/servers/"):
            srv = _mcp_find(path)
            _MCP_SERVERS[:] = [s for s in _MCP_SERVERS if s is not srv]
        if path.startswith("/api/model-endpoints/"):
            ep = _model_endpoint(path)
            _MODEL_ENDPOINTS[:] = [e for e in _MODEL_ENDPOINTS if e is not ep]
        if path.startswith("/api/shared-skills/"):
            name = path[len("/api/shared-skills/") :]
            _SHARED_SKILLS[:] = [s for s in _SHARED_SKILLS if s["name"] != name]
        self._send_json({"ok": True})


class PreviewServer(ThreadingHTTPServer):
    # Let a freshly-started server reclaim a port left in TIME_WAIT by a prior run.
    allow_reuse_address = True
    daemon_threads = True


def _free_port(port: int) -> None:
    """Kill any process still listening on `port` so a re-run can rebind. Keeps
    the "every run serves the fresh build" guarantee — otherwise a lingering old
    instance keeps answering and you see stale UI."""
    lsof = shutil.which("lsof")
    if not lsof:
        return
    out = subprocess.run([lsof, "-ti", f"tcp:{port}"], capture_output=True, text=True)
    pids = {int(p) for p in out.stdout.split() if p.strip().isdigit() and int(p) != os.getpid()}
    for pid in pids:
        print(f"Freeing port {port}: killing stale process {pid}")
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        time.sleep(1.0)


def _build_web() -> None:
    """Rebuild the React bundle into web/dist so the preview reflects the current
    source. Skipped when web/ is missing or no pnpm is on PATH."""
    web_dir = ROOT / "web"
    if not (web_dir / "package.json").is_file():
        print("Skipping web build:", web_dir, "has no package.json")
        return
    pnpm = shutil.which("pnpm")
    if not pnpm:
        print("Skipping web build: pnpm not found on PATH")
        return
    print("Building web bundle (pnpm --dir web run build)…")
    start = time.time()
    result = subprocess.run([pnpm, "--dir", str(web_dir), "run", "build"], cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit(f"web build failed (exit {result.returncode})")
    print(f"web build done in {time.time() - start:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="Run local Talos UI preview server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("TALOS_UI_PREVIEW_PORT", "5177")))
    parser.add_argument(
        "--no-build", action="store_true", help="Serve the existing web/dist without rebuilding"
    )
    args = parser.parse_args()

    if not args.no_build:
        _build_web()

    try:
        httpd = PreviewServer((args.host, args.port), PreviewHandler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print(f"Port {args.port} in use — freeing it and retrying…")
        _free_port(args.port)
        httpd = PreviewServer((args.host, args.port), PreviewHandler)
    print(f"Talos UI preview: http://{args.host}:{args.port}")
    print("Serving static files from", STATIC)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
