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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
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
                {
                    "round": 2,
                    "tool": "edit_file",
                    "command": '{"path": "src/report.py"}',
                    "output": "Edited src/report.py (1 replacement)",
                    "exit_code": 0,
                    "diff": "--- a/src/report.py\n+++ b/src/report.py\n-old = 1\n+new = 2\n+extra = 3",
                },
            ],
        }
    )
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
            ]
        else:
            _HISTORY[session_id] = []
    return _HISTORY[session_id]


def _record_turn(session_id: str, message: str) -> None:
    """Append a sent turn (user + the two assistant rounds the stream emits) so a
    post-stream history fetch hands every message a _db_id — matching runtime
    length so the app reconciles them and shows edit/revert/delete."""
    # setdefault (not _history_for) so a brand-new chat starts empty and stays
    # length-matched with the runtime — only an explicitly opened preview session
    # carries the seeded backlog.
    hist = _HISTORY.setdefault(session_id, [])
    hist.append(_entry("user", message or "(empty)"))
    hist.append(
        _entry("assistant", "The computed highest gross value is **22.61** for item **B**.", 1)
    )
    hist.append(
        _entry(
            "assistant", "Second-round reply: the calculation checks out, **B** stays on top.", 2
        )
    )


def _sse(event: dict | str) -> str:
    if event == "[DONE]":
        return "data: [DONE]\n\n"
    return f"data: {json.dumps(event)}\n\n"


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
        "privileges": {"can_use_agent": True, "max_messages_per_day": 40},
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


def _models():
    return [
        {
            "id": "mock-qwen3",
            "name": "Mock Endpoint",
            "base_url": "mock://preview",
            "models": ["qwen3-llm"],
            "model_type": "llm",
            "is_enabled": True,
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
        if path in ("/api/models", "/api/model-endpoints"):
            self._send_json(_models())
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
        if path == "/api/rag/jobs":
            self._send_json({"jobs": []})
            return
        if path == "/api/rag/documents":
            self._send_json(
                {
                    "available": True,
                    "documents": [
                        {
                            "source": "/srv/uploads/handbook.pdf",
                            "filename": "handbook.pdf",
                            "type": ".pdf",
                            "directory": "",
                            "chunks": 42,
                        },
                        {
                            "source": "/srv/uploads/prices.xlsx",
                            "filename": "prices.xlsx",
                            "type": ".xlsx",
                            "directory": "",
                            "chunks": 17,
                        },
                    ],
                }
            )
            return
        if path == "/api/rag/documents/chunks":
            source = parse_qs(parsed.query).get("source", [""])[0]
            self._send_json(
                {"available": True, "source": source, "chunks": _rag_chunks(source)}
            )
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
            self._send_json(
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
        if path.startswith("/api/"):
            self._send_json({})
            return

        self._serve_file(STATIC / path.lstrip("/"))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
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
            _record_turn(session_id, message)
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
        self._read_body()
        self._send_json({"ok": True})

    def do_DELETE(self):
        path = urlparse(self.path).path
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
