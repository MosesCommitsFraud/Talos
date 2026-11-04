"""memory_file.py — the Markdown file both memories are stored in.

src/user_memory.py keeps one file per user, src/db_memory.py one per database. Both
stay readable and can be edited by hand on the server:

    <!-- Talos memory file, next_id=3 -->
    # Memories

    ## #2 Answer style
    <!-- created=2026-11-04T15:00:00 updated=2026-11-04T15:00:00 -->
    Prefers short answers in German

A file is replaced in one step (core/atomic_io.py), so a crash mid-write leaves the
old version. LOCK keeps two chats from overwriting each other's change: Talos runs one
worker process, its login sessions live in memory too.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Tuple
from urllib.parse import quote, unquote

from core.atomic_io import atomic_write_text

LOCK = threading.RLock()

_NEXT_ID_RE = re.compile(r"next_id=(\d+)")
_HEADER_RE = re.compile(r"^## #(\d+)(?: (.*))?$")
_META_FIELD_RE = re.compile(r"(\w+)=(\S*)")
_SUFFIX = ".md"


@dataclass
class Entry:
    id: int
    text: str
    title: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""


def now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def clean(text: Any) -> str:
    """One line. A stored line break could otherwise pose as a new memory in the
    file, or as a new section of the prompt the text is shown in."""
    return " ".join(str(text or "").split())


def file_name(key: str) -> str:
    # Quoting leaves no path separator in the name.
    return quote(key, safe="") + _SUFFIX


def key_of(name: str) -> str:
    return unquote(name[: -len(_SUFFIX)])


def is_memory_file(name: str) -> bool:
    return name.endswith(_SUFFIX)


def parse(content: str) -> Tuple[List[Entry], int]:
    """(entries, next id). Line by line: what follows a header is always that entry's
    text, so no text can pose as a new entry. Further lines of a text (a hand edit)
    are joined to it."""
    lines = content.splitlines()
    match = _NEXT_ID_RE.search(lines[0]) if lines else None
    next_id = int(match.group(1)) if match else 1
    entries: List[Entry] = []
    seen = set()
    i = 0
    while i < len(lines):
        header = _HEADER_RE.match(lines[i])
        i += 1
        if not header:
            continue
        meta = {}
        if i < len(lines) and lines[i].startswith("<!-- created="):
            meta = {k: unquote(v) for k, v in _META_FIELD_RE.findall(lines[i])}
            i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        body = []
        if i < len(lines):
            body.append(lines[i])
            i += 1
        while i < len(lines) and not _HEADER_RE.match(lines[i]):
            body.append(lines[i])
            i += 1
        entry_id = int(header.group(1))
        text = clean(" ".join(body))
        if entry_id in seen or not text:
            continue
        seen.add(entry_id)
        entries.append(
            Entry(
                entry_id,
                text,
                title=clean(header.group(2)),
                created_at=meta.get("created", ""),
                updated_at=meta.get("updated", ""),
                created_by=meta.get("created_by", ""),
                updated_by=meta.get("updated_by", ""),
            )
        )
    return entries, max([next_id, *(e.id + 1 for e in entries)])


def read(path: str) -> Tuple[List[Entry], int]:
    """A missing file is an empty one. Any other failure propagates: writing on after
    a failed read would replace the entries with what little could be read."""
    try:
        with open(path, encoding="utf-8") as f:
            return parse(f.read())
    except FileNotFoundError:
        return [], 1


def _meta_line(entry: Entry) -> str:
    fields = [f"created={entry.created_at}", f"updated={entry.updated_at}"]
    if entry.created_by:
        fields.append(f"created_by={quote(entry.created_by, safe='')}")
    if entry.updated_by:
        fields.append(f"updated_by={quote(entry.updated_by, safe='')}")
    return f"<!-- {' '.join(fields)} -->"


def write(path: str, entries: List[Entry], next_id: int, heading: str) -> None:
    parts = [f"<!-- Talos memory file, next_id={next_id} -->", f"# {heading}", ""]
    for entry in entries:
        header = f"## #{entry.id} {entry.title}" if entry.title else f"## #{entry.id}"
        parts += [header, _meta_line(entry), entry.text, ""]
    atomic_write_text(path, "\n".join(parts))
