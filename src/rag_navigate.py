"""rag_navigate.py — let the agent *navigate* the knowledge base, not only search it.

``search_knowledge`` returns the top few chunks for a query. That is the right
first move, but it cannot answer "what does chapter 7 say", "summarize this
200-page manual" or "list every step of the workshop's second hour": the
evidence is spread over far more chunks than any top-k returns, and a small
model asked to stitch it together from five passages invents the rest.

The moves an expert makes with a long document are the ones a coding agent
makes with a repository — list, look at the structure, read a part, grep — so
that is the tool surface here:

* ``list_knowledge``  — which documents exist (optionally filtered by name).
* ``read_knowledge``  — a document's outline (section tree with pages / times),
  or the verbatim text of a section, page range or time range, paged.
* ``grep_knowledge``  — exact, case-insensitive term lookup with locations.

Everything is derived from metadata the ingest already stores on each chunk
(``seq``, ``section_id``, ``heading_path``, ``page``, ``start``/``end``), so it
works on existing indexes without a re-index. Chunks of one section overlap by
``chunk_overlap_chars``; ``_join`` removes that overlap using the stored
``split_idx_start``/``source_end`` offsets so read text is never duplicated.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Default and ceiling for one read_knowledge page. One page should hold a
# typical chapter of a manual; the ceiling keeps a single call from swallowing
# the context window of a 32k-token model.
DEFAULT_READ_CHARS = 12_000
MAX_READ_CHARS = 40_000
# Above this a document is shown as an outline instead of in full.
FULL_DOC_CHARS = 12_000
# Outline lines shown before the rest is summarized as a count.
MAX_OUTLINE_LINES = 250
MAX_LIST_ROWS = 200
MAX_GREP_HITS = 40

_DOC_CACHE_TTL = 30.0
_doc_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}


class NavigationError(Exception):
    """A user-facing problem (unknown document, ambiguous name, …)."""


# ---------------------------------------------------------------------------
# Bases and documents
# ---------------------------------------------------------------------------


def _external() -> bool:
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {}) or {}
        return str(cfg.get("provider") or "internal").strip().lower() == "external"
    except Exception:
        return False


def _bases() -> List[Tuple[Dict[str, Any], Any]]:
    """Chat-enabled bases with a healthy manager, in registry order."""
    from src.rag_registry import chat_enabled, list_bases
    from src.rag_singleton import get_rag_manager

    out = []
    for base in list_bases():
        if not chat_enabled(base):
            continue
        try:
            manager = get_rag_manager(base["id"])
        except Exception as e:
            logger.warning("knowledge base %s unavailable: %s", base.get("id"), e)
            continue
        if manager is not None and getattr(manager, "healthy", False):
            out.append((base, manager))
    return out


def _documents(base: Dict[str, Any], manager: Any) -> List[Dict[str, Any]]:
    """One row per indexed document of a base (cached briefly — the listing
    scans the whole collection)."""
    key = str(base.get("id"))
    hit = _doc_cache.get(key)
    if hit and time.monotonic() - hit[0] < _DOC_CACHE_TTL:
        return hit[1]
    rows = manager.list_documents(exclude_scopes=["sql"]) or []
    _doc_cache[key] = (time.monotonic(), rows)
    return rows


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", str(name or "")).strip().lower()


def resolve_document(name: str) -> Tuple[Dict[str, Any], Any, Dict[str, Any]]:
    """Find the document a model means by ``name``.

    The model sees documents by their filename label, so match on that first,
    then on the full source path, then on a unique substring. Several matches
    are an error listing them — guessing would read the wrong manual.
    """
    wanted = _norm(name)
    if not wanted:
        raise NavigationError("Pass the document's name as `document`.")
    # Strip a leading "[3] " citation label the model may have copied along.
    wanted = re.sub(r"^\[\d+\]\s*", "", wanted)
    rows = [(b, m, r) for b, m in _bases() for r in _documents(b, m)]
    if not rows:
        raise NavigationError("The knowledge base is empty or unavailable.")
    for test in (
        lambda r: _norm(r.get("filename")) == wanted,
        lambda r: _norm(r.get("source")) == wanted,
        lambda r: _norm(os.path.splitext(str(r.get("filename") or ""))[0]) == wanted,
        lambda r: wanted in _norm(r.get("filename")) or wanted in _norm(r.get("source")),
    ):
        found = [(b, m, r) for b, m, r in rows if test(r)]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            names = "\n".join(
                f"- {r.get('filename')} ({r.get('source')})" for _, _, r in found[:15]
            )
            raise NavigationError(
                f'"{name}" matches several documents — pass the exact one:\n{names}'
            )
    raise NavigationError(
        f'No indexed document is called "{name}". Call list_knowledge to see the '
        "available documents (optionally with a `query` filter)."
    )


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


def _fmt_time(seconds: Any) -> str:
    try:
        s = int(float(seconds))
    except (TypeError, ValueError):
        return ""
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _parse_time(text: str) -> Optional[float]:
    parts = [p for p in str(text or "").strip().split(":") if p != ""]
    if not parts:
        return None
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return total


def _parse_range(value: Any, parse=float) -> Optional[Tuple[float, float]]:
    """ "12", "12-15", [12, 15] or "0:10:00-0:20:00" → (lo, hi)."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), float(value)
    if isinstance(value, (list, tuple)) and value:
        lo, hi = parse(str(value[0])), parse(str(value[-1]))
    else:
        text = str(value).strip()
        # A time like "1:30" contains no range dash; "1:30-2:00" does.
        bits = re.split(r"\s*(?:-|–|bis|to)\s*", text, maxsplit=1)
        lo = parse(bits[0])
        hi = parse(bits[1]) if len(bits) > 1 and bits[1] else lo
    if lo is None or hi is None:
        return None
    return (min(lo, hi), max(lo, hi))


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _pages(meta: Dict[str, Any]) -> List[int]:
    pages = meta.get("pages")
    if isinstance(pages, list):
        out = [int(p) for p in pages if _num(p) is not None]
        if out:
            return out
    page = _num(meta.get("page"))
    return [int(page)] if page is not None else []


def _ordered_chunks(manager: Any, source: str) -> List[Dict[str, Any]]:
    rows = manager.get_document_chunks(source) or []
    return sorted(rows, key=lambda r: (_num(r.get("seq")) or 0))


def build_sections(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group consecutive chunks of one section, in document order.

    Figures ride with the section they appear in (they carry their own
    ``figure-…`` section id, so they are attached to the preceding text
    section instead of opening a section of their own).
    """
    sections: List[Dict[str, Any]] = []
    for row in chunks:
        meta = row.get("metadata") or {}
        is_figure = row.get("modality") == "figure" or meta.get("modality") == "figure"
        if is_figure and sections:
            sections[-1]["figures"].append(row)
            continue
        sid = row.get("section_id") or meta.get("section_id") or f"chunk-{row.get('id')}"
        if not sections or sections[-1]["id"] != sid:
            path = meta.get("heading_path") or ((meta.get("dl_meta") or {}).get("headings")) or []
            sections.append(
                {
                    "id": sid,
                    "n": len(sections) + 1,
                    "heading_path": [str(h) for h in path if str(h).strip()],
                    "chunks": [],
                    "figures": [],
                }
            )
        if is_figure:
            sections[-1]["figures"].append(row)
        else:
            sections[-1]["chunks"].append(row)
    for sec in sections:
        metas = [c.get("metadata") or {} for c in sec["chunks"] + sec["figures"]]
        pages = sorted({p for m in metas for p in _pages(m)})
        starts = [s for s in (_num(m.get("start")) for m in metas) if s is not None]
        ends = [e for e in (_num(m.get("end")) for m in metas) if e is not None]
        sec["pages"] = (pages[0], pages[-1]) if pages else None
        sec["time"] = (min(starts), max(ends or starts)) if starts else None
        sec["text"] = _join(sec["chunks"])
        sec["chars"] = len(sec["text"])
        sec["title"] = (
            sec["heading_path"][-1]
            if sec["heading_path"]
            else _first_line(sec["text"]) or f"Part {sec['n']}"
        )
    return [s for s in sections if s["chunks"] or s["figures"]]


def _first_line(text: str, limit: int = 70) -> str:
    for line in (text or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"
    return ""


def _join(chunks: List[Dict[str, Any]]) -> str:
    """Concatenate a section's chunks without their overlap.

    Consecutive chunks of one section share ``chunk_overlap_chars`` of text;
    the stored ``split_idx_start``/``source_end`` offsets say exactly how much.
    Continued table parts repeat the header row, which is dropped likewise.
    """
    out: List[str] = []
    prev_end: Optional[float] = None
    prev_table: Optional[str] = None
    for row in chunks:
        meta = row.get("metadata") or {}
        text = row.get("content") or ""
        start = _num(meta.get("split_idx_start"))
        table = meta.get("table_id")
        if table and table == prev_table:
            cut = int(_num(meta.get("repeated_header_chars")) or 0)
            text = text[cut:] if 0 < cut < len(text) else text
            out.append(text)
        elif prev_end is not None and start is not None and start < prev_end:
            out.append(text[int(prev_end - start) :])
        else:
            if out:
                out.append("\n\n")
            out.append(text)
        end = _num(meta.get("source_end"))
        prev_end = end if end is not None else None
        prev_table = table
    return "".join(out).strip()


def _location(sec: Dict[str, Any]) -> str:
    bits = []
    if sec.get("pages"):
        lo, hi = sec["pages"]
        bits.append(f"p. {lo}" if lo == hi else f"p. {lo}–{hi}")
    if sec.get("time"):
        lo, hi = sec["time"]
        bits.append(f"{_fmt_time(lo)}–{_fmt_time(hi)}")
    return ", ".join(bits)


def _size(chars: int) -> str:
    return f"{chars / 1000:.1f}k chars" if chars >= 1000 else f"{chars} chars"


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def list_knowledge(query: str = "") -> str:
    if _external():
        return (
            "Browsing is not available for the external knowledge provider; use search_knowledge."
        )
    bases = _bases()
    if not bases:
        return "No knowledge base is available."
    needle = _norm(query)
    lines: List[str] = []
    total = shown = 0
    for base, manager in bases:
        rows = _documents(base, manager)
        if needle:
            rows = [
                r
                for r in rows
                if needle in _norm(r.get("filename"))
                or needle in _norm(r.get("source"))
                or needle in _norm(r.get("directory"))
            ]
        total += len(rows)
        if not rows:
            continue
        if len(bases) > 1:
            lines.append(f"\n## {base.get('name') or base.get('id')}")
        for r in rows:
            if shown >= MAX_LIST_ROWS:
                break
            kind = (r.get("type") or os.path.splitext(str(r.get("filename") or ""))[1]).lstrip(".")
            lines.append(f"- {r.get('filename')} — {kind or 'file'}, {r.get('chunks', 0)} chunks")
            shown += 1
    if not total:
        return (
            f'No document name contains "{query}". Call list_knowledge without a query '
            "to see everything, or search_knowledge to search the contents."
            if needle
            else "The knowledge base contains no documents."
        )
    head = f"{total} document(s)" + (f' matching "{query}"' if needle else "") + "."
    if shown < total:
        head += f" Showing the first {shown}; narrow it down with `query`."
    return (
        head
        + ' Open one with read_knowledge {"document": "<name>"} to see its outline.\n'
        + "\n".join(lines).strip("\n")
    )


def _outline(row: Dict[str, Any], base: Dict[str, Any], sections: List[Dict[str, Any]]) -> str:
    total = sum(s["chars"] for s in sections)
    figures = sum(len(s["figures"]) for s in sections)
    pages = [p for s in sections if s.get("pages") for p in s["pages"]]
    times = [t for s in sections if s.get("time") for t in s["time"]]
    span = []
    if pages:
        span.append(f"pages {min(pages)}–{max(pages)}")
    if times:
        span.append(f"duration ~{_fmt_time(max(times))}")
    lines = [
        f"Document: {row.get('filename')}"
        + (f" (knowledge base: {base.get('name')})" if base.get("name") else ""),
        f"{len(sections)} sections, {_size(total)}"
        + (f", {figures} figure(s)" if figures else "")
        + (", " + ", ".join(span) if span else ""),
        "This is the OUTLINE only. Read parts with read_knowledge and `section` "
        '(a number or range like "4-6")'
        + (', `pages` ("12-15")' if pages else "")
        + (', or `time` ("0:10:00-0:25:00")' if times else "")
        + ". Read every section a question needs before answering; never infer a "
        "section's content from its title.",
        "",
    ]
    for sec in sections[:MAX_OUTLINE_LINES]:
        depth = max(0, len(sec["heading_path"]) - 1)
        loc = _location(sec)
        extra = [x for x in (loc, _size(sec["chars"])) if x]
        if sec["figures"]:
            extra.append(f"{len(sec['figures'])} fig.")
        lines.append(f"{'  ' * min(depth, 4)}{sec['n']}. {sec['title']} — {' · '.join(extra)}")
    if len(sections) > MAX_OUTLINE_LINES:
        lines.append(
            f"… {len(sections) - MAX_OUTLINE_LINES} more sections "
            f'(read them by number, e.g. section "{MAX_OUTLINE_LINES + 1}-{len(sections)}").'
        )
    return "\n".join(lines)


def _select(sections, args) -> Tuple[List[Dict[str, Any]], str]:
    """Sections matching the requested section/pages/time window."""
    if args.get("section") not in (None, ""):
        rng = _parse_range(args.get("section"))
        if not rng:
            raise NavigationError('`section` must be a number or a range like "4-6".')
        lo, hi = int(rng[0]), int(rng[1])
        picked = [s for s in sections if lo <= s["n"] <= hi]
        if not picked:
            raise NavigationError(
                f"The document has sections 1–{len(sections)}; there is no section {lo}"
                + (f"–{hi}" if hi != lo else "")
                + "."
            )
        return picked, f"section {lo}" + (f"–{hi}" if hi != lo else "")
    if args.get("pages") not in (None, ""):
        rng = _parse_range(args.get("pages"))
        if not rng:
            raise NavigationError('`pages` must be a page number or a range like "12-15".')
        picked = [
            s
            for s in sections
            if s.get("pages") and s["pages"][0] <= rng[1] and s["pages"][1] >= rng[0]
        ]
        if not picked:
            raise NavigationError("No indexed text on those pages (or the document has no pages).")
        return picked, f"pages {int(rng[0])}–{int(rng[1])}"
    if args.get("time") not in (None, ""):
        rng = _parse_range(args.get("time"), _parse_time)
        if not rng:
            raise NavigationError('`time` must be a range like "0:10:00-0:25:00".')
        picked = [
            s
            for s in sections
            if s.get("time") and s["time"][0] <= rng[1] and s["time"][1] >= rng[0]
        ]
        if not picked:
            raise NavigationError("No transcript segment overlaps that time range.")
        return picked, f"time {_fmt_time(rng[0])}–{_fmt_time(rng[1])}"
    return sections, "full text"


def _figure_lines(sec: Dict[str, Any]) -> List[str]:
    out = []
    for fig in sec["figures"]:
        meta = fig.get("metadata") or {}
        url = meta.get("image_url")
        cap = _first_line(meta.get("image_caption") or fig.get("content") or "", 120) or "figure"
        cap = cap.replace("[", "(").replace("]", ")")
        if url:
            out.append(f"![{cap}]({url})")
        else:
            out.append(f"[Figure: {cap}]")
    return out


def read_knowledge(
    args: Dict[str, Any], citation_session: Optional[str] = None
) -> Tuple[str, List[Dict[str, Any]], str]:
    """Returns (supplied text, rag_sources, short label for the tool row)."""
    if _external():
        raise NavigationError(
            "Reading whole documents is not available for the external knowledge "
            "provider; use search_knowledge."
        )
    base, manager, row = resolve_document(str(args.get("document") or args.get("name") or ""))
    sections = build_sections(_ordered_chunks(manager, row["source"]))
    if not sections:
        raise NavigationError(f"{row.get('filename')} has no readable text in the index.")
    wants_part = any(args.get(k) not in (None, "") for k in ("section", "pages", "time"))
    total = sum(s["chars"] for s in sections)
    if not wants_part and total > FULL_DOC_CHARS and not args.get("offset"):
        return _outline(row, base, sections), [], f"{row.get('filename')}: outline"

    picked, what = _select(sections, args)
    try:
        budget = int(args.get("max_chars") or DEFAULT_READ_CHARS)
    except (TypeError, ValueError):
        budget = DEFAULT_READ_CHARS
    budget = max(2_000, min(budget, MAX_READ_CHARS))
    try:
        offset = max(0, int(args.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0

    # Render the picked window as one text with a header per section, then cut
    # a page out of it at `offset`. Sections are never reordered or merged, so
    # offsets stay stable between calls.
    from src.citations import cite_rag

    parts: List[str] = []
    spans: List[Tuple[int, int, Dict[str, Any]]] = []
    cursor = 0
    for sec in picked:
        loc = _location(sec)
        head = f"### [§{sec['n']}] " + (" › ".join(sec["heading_path"]) or sec["title"])
        if loc:
            head += f"  ({loc})"
        body = "\n".join([head, sec["text"], *_figure_lines(sec)]).strip()
        spans.append((cursor, cursor + len(body), sec))
        parts.append(body)
        cursor += len(body) + 2
    full = "\n\n".join(parts)
    if offset >= len(full):
        raise NavigationError(f"`offset` {offset} is past the end ({len(full)} chars).")
    end = min(len(full), offset + budget)
    if end < len(full):
        # Cut at a paragraph or line boundary inside the last fifth of the page.
        floor = offset + int(budget * 0.8)
        cut = max(full.rfind("\n\n", floor, end), full.rfind("\n", floor, end))
        if cut > offset:
            end = cut
    page = full[offset:end]

    sources: List[Dict[str, Any]] = []
    for lo, hi, sec in spans:
        if hi <= offset or lo >= end:
            continue
        first = (sec["chunks"] or sec["figures"])[0]
        meta = first.get("metadata") or {}
        src: Dict[str, Any] = {
            "filename": row.get("filename"),
            "snippet": sec["text"][:400],
            "similarity": 1.0,
            "_text": sec["text"][:3000],
            "_id": f"{base['id']}:{first.get('id')}",
            "_source": f"{base['id']}:{row.get('source')}",
            "_page": sec["pages"][0] if sec.get("pages") else None,
            "rag_id": base["id"],
            "rag_name": base.get("name"),
        }
        if sec.get("time"):
            src.update(modality="video", start=sec["time"][0], end=sec["time"][1])
            if meta.get("deeplink"):
                src["deeplink"] = meta["deeplink"]
        n = cite_rag(citation_session, src)
        if n is not None:
            src["n"] = n
            page = page.replace(f"### [§{sec['n']}] ", f"### [{n}] §{sec['n']} ", 1)
        sources.append(src)

    status = f"{row.get('filename')} — {what}, chars {offset}–{end} of {len(full)}"
    if end < len(full):
        status += (
            f". MORE TEXT FOLLOWS: call read_knowledge again with the same arguments and "
            f'"offset": {end} before relying on the rest.'
        )
    else:
        status += " (complete)."
    label = f"{row.get('filename')}: {what}"
    return status + "\n\n" + page, sources, label


def grep_knowledge(args: Dict[str, Any]) -> str:
    if _external():
        return "Exact term lookup is not available for the external knowledge provider; use search_knowledge."
    pattern = str(args.get("pattern") or args.get("query") or "").strip()
    if not pattern:
        raise NavigationError("Pass the term to look for as `pattern`.")
    needle = pattern.lower()
    doc = str(args.get("document") or "").strip()
    hits: List[str] = []
    count = 0
    if doc:
        base, manager, row = resolve_document(doc)
        for sec in build_sections(_ordered_chunks(manager, row["source"])):
            low = sec["text"].lower()
            pos = low.find(needle)
            while pos >= 0:
                count += 1
                if len(hits) < MAX_GREP_HITS:
                    s, e = max(0, pos - 100), pos + len(needle) + 140
                    snippet = " ".join(sec["text"][s:e].split())
                    loc = _location(sec)
                    hits.append(
                        f"- §{sec['n']} {sec['title']}"
                        + (f" ({loc})" if loc else "")
                        + f": …{snippet}…"
                    )
                pos = low.find(needle, pos + len(needle))
        where = f" in {row.get('filename')}"
        follow = 'Read a hit\'s section with read_knowledge {"document": ..., "section": n}.'
    else:
        for base, manager in _bases():
            for h in manager.grep_chunks(pattern, limit=500, exclude_scopes=["sql"]) or []:
                count += 1
                if len(hits) < MAX_GREP_HITS:
                    loc = f", p. {h['page']}" if h.get("page") is not None else ""
                    hits.append(f"- {h.get('filename')}{loc}: {h.get('snippet')}")
        where = ""
        follow = (
            "Narrow to one document with `document`, or open one with read_knowledge "
            "to see where the hit sits in its outline."
        )
    if not hits:
        return (
            f'"{pattern}" does not occur literally{where} in the knowledge base. '
            "grep is exact; try a shorter stem or a synonym, or use search_knowledge "
            "for a meaning-based search."
        )
    more = f" Showing {len(hits)}." if count > len(hits) else ""
    return f'{count} occurrence(s) of "{pattern}"{where}.{more} {follow}\n' + "\n".join(hits)
