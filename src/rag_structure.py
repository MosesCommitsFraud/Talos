"""Format adapters and the one structure-aware chunker every lane shares.

Every extractor (Docling, Markdown, VLM transcription, MarkItDown, ...) reduces a
file to sections, and ``split_documents`` chunks those the same way, so a chapter
is cut alike whether it arrived as .docx, .pdf, .html or .md.

Imports stay lazy: importing the application does not initialize RAG or OCR.
"""

import bisect
import hashlib
import json
import math
import re
from collections import defaultdict
from copy import deepcopy
from dataclasses import is_dataclass, replace

CHUNKING_VERSION = "haystack-sections-v4"
# Ordinary prose stays well inside embedding and reranker windows (about 1,150 tokens
# at 4,000 characters of German). Rerank time grows with chunk length, so this limit
# also bounds how long a search waits on the reranker.
DEFAULT_CHUNK_MAX_CHARS = 4000
# Retrieved text injected into one chat turn: room for several whole chunks at
# that size, and about 5,000 tokens of German, so small next to model contexts.
DEFAULT_CONTEXT_MAX_CHARS = 18000
# Chunks one search hands the reranker. Its time grows with this number and with
# chunk length, and calls queue behind each other: 40 chunks of 6,000 characters took
# 16 s alone on Qwen3-Reranker-4B and 32 s with two at once.
DEFAULT_CANDIDATE_TOP_K = 20

# Docling reads PDFs without a heading hierarchy, so a numbered title is the only
# level the text itself still carries ("2.1 Kosten" sits below "2 Planung").
_NUMBERED_HEADING = re.compile(r"\s*(\d+(?:\.\d+)*)\.?\s+\S")
# Words whose trailing dot does not end a sentence (single letters are handled
# separately, which covers "z. B.", "d. h.", "u. a.").
_ABBREVIATIONS = frozenset(
    "abs abt bzw ca dr etc evtl fa ggf inkl max min mio mrd nr prof rd sog str tel "
    "usw vgl vs zzgl zzt".split()
)
_SENTENCE_END = re.compile(
    r"[.!?\u2026][\"'\u201c\u201d\u00bb)\]]*\s+"
    r"(?=[\"'\u201e\u00ab(\[]?[^\W_a-z\u00e4\u00f6\u00fc\u00df])"
)
# YAML front matter between "---" lines. Markdown alone reads the opening line as a
# rule and everything up to the closing line as one long heading.
_FRONTMATTER = re.compile(
    r"\A\ufeff?---[ \t]*\r?\n(.*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.DOTALL | re.MULTILINE
)
_FRONTMATTER_KEY = re.compile(r"[\w.-]+[ \t]*:(?:\s|$)")
_FRONTMATTER_MORE = re.compile(r"[ \t]|-\s|#")
# Rules that close a text block, which carry no content of their own. A rule directly
# under a line of text would be a Setext heading, hence the blank line.
_TRAILING_RULES = re.compile(
    r"(?:(?:\A|\n[ \t\r]*\n) {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}))+\s*\Z"
)
# Text this short next to a table explains that table ("Es gilt:", "Regel: ..."). On
# its own it is a fragment the search finds without the table it is about. Longer
# prose stays apart, so it keeps a vector of its own.
_TABLE_NOTE_CHARS = 500


def clean_content_metadata(meta, transform):
    """Apply the same content guards to extracted headings/captions/provenance."""

    def clean(value):
        if isinstance(value, str):
            return transform(value)
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        return value

    for key in (
        "heading_path",
        "dl_meta",
        "image_caption",
        "_visual_context",
        "context",
        "aux_terms",
    ):
        if key in meta:
            meta[key] = clean(meta[key])


def heading_path(meta):
    dl = meta.get("dl_meta") or {}
    if not isinstance(dl, dict):
        dl = {}
    # Both released Docling metadata layouts occur in existing collections.
    return list(
        meta.get("heading_path")
        or dl.get("headings")
        or (dl.get("meta") or {}).get("headings")
        or []
    )


def _frontmatter_end(text):
    """Where YAML front matter at the very start of ``text`` ends, else 0."""
    match = _FRONTMATTER.match(text)
    if not match:
        return 0
    lines = [line for line in match.group(1).splitlines() if line.strip()]
    if not lines or not _FRONTMATTER_KEY.match(lines[0]):
        return 0
    if all(_FRONTMATTER_KEY.match(line) or _FRONTMATTER_MORE.match(line) for line in lines):
        return match.end()
    return 0


def markdown_sections(text, stack=(), ordinal=0):
    """Return exact source slices and a positional heading hierarchy.

    ``stack``/``ordinal`` resume the hierarchy of an earlier document, for page
    transcripts where a chapter simply continues on the next page. Front matter
    is text of the section it opens, so its title and keywords stay searchable.
    """
    from markdown_it import MarkdownIt

    lead = _frontmatter_end(text)
    tokens = MarkdownIt().parse(text[lead:])
    starts = [lead]
    for line in text[lead:].splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    headings = []
    for i, token in enumerate(tokens):
        if token.type == "heading_open" and token.map:
            headings.append((starts[token.map[0]], int(token.tag[1:]), tokens[i + 1].content))
    stack = list(stack)
    cursor = 0
    for offset, level, title in headings:
        if offset > cursor and (cursor or text[lead:offset].strip()):
            yield text[cursor:offset], list(stack), ordinal
            cursor = offset
        ordinal += 1
        stack = [entry for entry in stack if entry[0] < level]
        stack.append((level, title, ordinal))
    if cursor < len(text):
        yield text[cursor:], list(stack), ordinal


def _docling_label(item):
    # Enum str behavior differs between docling-core releases.
    label = getattr(item, "label", None)
    return getattr(label, "value", str(label or ""))


def _numbered_levels(items):
    """Heading levels from the numbering, when the extractor reports one flat level."""
    headers = [item for item in items if _docling_label(item) == "section_header"]
    if len({int(getattr(item, "level", 1) or 1) for item in headers}) != 1:
        return {}
    levels = {}
    for item in headers:
        match = _NUMBERED_HEADING.match(getattr(item, "text", "") or "")
        if match:
            levels[item.self_ref] = match.group(1).count(".") + 1
    return levels if len(set(levels.values())) > 1 else {}


def _docling_unit_key(native):
    """Formats whose Docling "pages" are real units, kept apart by the chunker."""
    mimetype = str(getattr(getattr(native, "origin", None), "mimetype", "") or "")
    if "presentation" in mimetype:
        return "slide"
    if "spreadsheet" in mimetype or "ms-excel" in mimetype:
        return "sheet"
    return None


def docling_documents(serialized):
    """Consume lossless Docling JSON, keeping layout provenance and heading IDs."""
    from docling_core.types.doc import DoclingDocument
    from haystack import Document

    native = DoclingDocument.model_validate_json(serialized)
    items = [item for item, _depth in native.iterate_items()]
    levels = _numbered_levels(items)
    unit_key = _docling_unit_key(native)
    stack = []
    ordinal = 0
    documents = []
    for item in items:
        label = _docling_label(item)
        if label in {"page_header", "page_footer"}:
            continue
        if label in {"title", "section_header"}:
            ordinal += 1
            # A document title sits above its top-level headings, as "# Title"
            # above "## Chapter" does in Markdown.
            level = (
                0
                if label == "title"
                else levels.get(item.self_ref) or int(getattr(item, "level", 1) or 1)
            )
            title = getattr(item, "text", "")
            stack = [entry for entry in stack if entry[0] < level]
            stack.append((level, title, ordinal))
            content = f"{'#' * max(1, min(level, 6))} {title}"
        elif label == "table":
            content = item.export_to_markdown(doc=native)
        elif label == "picture":
            content = item.caption_text(native)
        elif label == "list_item":
            text = getattr(item, "text", "")
            content = f"{getattr(item, 'marker', '') or '-'} {text}" if text.strip() else ""
        else:
            content = getattr(item, "text", "")
        if not content or not content.strip():
            continue
        raw = item.model_dump(mode="json", exclude_none=True)
        pages = sorted({p.page_no for p in getattr(item, "prov", [])})
        meta = {
            "heading_path": [h[1] for h in stack],
            "section_path": [h[2] for h in stack],
            "section_ordinal": ordinal,
            "structure_source": "docling",
            "dl_meta": {"headings": [h[1] for h in stack], "doc_items": [raw]},
        }
        if pages:
            meta.update(page=pages[0], pages=pages)
            if unit_key:
                meta[unit_key] = pages[0]
        if label == "table":
            meta["block_type"] = "table"
            meta["block_id"] = str(item.self_ref)
        documents.append(Document(content=content, meta=meta))
    return documents


def page_list(meta):
    pages = meta.get("pages")
    if isinstance(pages, list) and pages:
        return pages
    page = meta.get("page")
    return [page] if page is not None else []


def _stamp_pages(meta, spans, start, end):
    """Give a chunk exactly the pages its own text came from."""
    pages = sorted(
        {
            page
            for span_start, span_end, span_pages in spans
            if span_start < end and start < span_end
            for page in span_pages
        },
        key=lambda page: (isinstance(page, str), page),
    )
    if not pages:
        return
    meta["page"] = pages[0]
    if len(pages) > 1 or "pages" in meta:
        meta["pages"] = pages


def _block_glue(before, before_pages, after, after_pages):
    """A paragraph torn apart by PDF layout analysis is one paragraph again.

    Extractors end a block at the bottom of a page or a layout region, even
    mid-sentence. Left as two paragraphs, the chunker would take that tear for its
    best place to cut. Only blocks with page provenance qualify: in Word or
    Markdown a paragraph break is the author's.
    """
    tail = before.rstrip()[-1:]
    head = after.lstrip()[:1]
    torn = (
        before_pages and after_pages and (tail.isalnum() or tail in {",", "-"}) and head.islower()
    )
    return " " if torn else "\n\n"


def _heading_only(text):
    """True when a block holds nothing but heading lines (and rules between them)."""
    if not text.strip() or len(text) > 1000:
        return False
    from markdown_it import MarkdownIt

    return all(
        token.type in {"heading_open", "inline", "heading_close", "hr"}
        for token in MarkdownIt().parse(text)
    )


def _rules_only(text):
    """True when a block holds nothing but thematic breaks such as ``---``."""
    if not text.strip() or len(text) > 1000:
        return False
    from markdown_it import MarkdownIt

    return all(token.type == "hr" for token in MarkdownIt().parse(text))


def _table_note(group, units, index, room):
    """The short closing text of a section, when it directly follows this table."""
    if index + 2 != len(units) or group.meta.get("literal_text"):
        return ""
    start, end, _ = units[index + 1]
    note = _TRAILING_RULES.sub("", group.content[start:end])
    fits = 0 < len(note.strip()) <= _TABLE_NOTE_CHARS and len(note) <= room
    return note if fits and not _rules_only(note) else ""


def _fold_lone_headings(groups):
    """A chapter title without text of its own opens the section after it.

    Otherwise "# Teil 2" followed directly by "## Kapitel 1" becomes a vector
    holding only the title, cut off from the chapter it introduces. Slides and
    sheets are real units, so a title-only slide stays what it is.
    """
    out = []
    pending = None
    for group in groups:
        key, doc, spans = group
        if key is None:
            out.append(group)
            continue
        if not doc.meta.get("literal_text") and _rules_only(doc.content):
            continue
        if pending is not None:
            if pending[0][2][:-1] == key[2][:-1]:
                lead = pending[1].content.rstrip() + "\n\n"
                shift = len(lead)
                items = pending[1].meta.get("dl_meta", {}).get("doc_items", [])
                if items:
                    dl_meta = doc.meta.setdefault("dl_meta", {})
                    dl_meta["doc_items"] = items + dl_meta.get("doc_items", [])
                spans = pending[2] + [(s + shift, e + shift, p) for s, e, p in spans]
                doc = replace(doc, content=lead + doc.content)
                group = [key, doc, spans]
            else:
                out.append(pending)
            pending = None
        if _heading_only(doc.content):
            pending = group
        else:
            out.append(group)
    if pending is not None:
        out.append(pending)
    return out


def _sentence_starts(text):
    """Offsets where a sentence begins, skipping "z. B.", "Nr. 5" and "1. Schritt"."""
    starts = []
    for match in _SENTENCE_END.finditer(text):
        before = re.search(r"[^\W\d_]*\d*$", text[max(0, match.start() - 12) : match.start()])
        word = before.group(0) if before else ""
        if text[match.start()] == "." and (
            len(word) <= 1 or word.isdigit() or word.lower() in _ABBREVIATIONS
        ):
            continue
        starts.append(match.end())
    return starts


def _cut_marks(text):
    """Allowed chunk ends, strongest first: paragraph, sentence or line, clause, word."""
    paragraphs = [m.end() for m in re.finditer(r"\n[ \t]*\n\s*", text)]
    sentences = sorted(set(_sentence_starts(text)) | {m.end() for m in re.finditer(r"\n", text)})
    clauses = [m.end() for m in re.finditer(r"[;:,]\s+", text)]
    words = [m.end() for m in re.finditer(r"\s+", text)]
    return [paragraphs, sentences, clauses, words]


def _chunk_ranges(total, marks, max_chars, overlap):
    """Cut text into even parts at the strongest boundary near each even cut point.

    Evening out keeps a chapter just over the limit from losing a stray last
    sentence to a chunk of its own. Parts stay short enough to take the overlap.
    """
    room = max_chars - overlap
    ranges = []
    start = 0
    while total - start > (room if ranges else max_chars):
        remaining = total - start
        target = start + remaining / math.ceil(remaining / room)
        floor = start + (target - start) / 2
        limit = start + (room if ranges else max_chars)
        cut = None
        for positions in marks:
            low = bisect.bisect_right(positions, floor)
            high = bisect.bisect_right(positions, limit)
            if low < high:
                cut = min(positions[low:high], key=lambda p: abs(p - target))
                break
        cut = cut or limit  # Unbroken text has no boundary to respect.
        ranges.append((start, cut))
        start = cut
    ranges.append((start, total))
    return ranges


def _overlap_start(text, cut, overlap, sentences):
    """Where the next chunk starts: whole sentences before ``cut``, never a word stump.

    A paragraph boundary needs no overlap, and neither does a sentence boundary
    when the sentence before it does not fit: nothing was cut apart there.
    """
    if overlap <= 0 or re.search(r"\n[ \t]*\n\s*$", text[max(0, cut - 8) : cut]):
        return cut
    low = max(0, cut - overlap)
    first = bisect.bisect_left(sentences, low)
    if first < len(sentences) and sentences[first] < cut:
        return sentences[first]
    if first < len(sentences) and sentences[first] == cut:
        return cut
    space = re.search(r"\s+", text[low:cut])
    return low + space.end() if space and low + space.end() < cut else low


def split_documents(documents, max_chars=DEFAULT_CHUNK_MAX_CHARS, overlap=200):
    """Normalize every lane to sections and chunk those the same way.

    Sections are the boundaries. PDF pages are only provenance: a chapter runs
    across a page break like it runs across one in Word, and each chunk records
    the pages of its own text. Slides, sheets, symbols and timed segments are
    real units and stay apart.
    """
    from haystack import Document

    overlap = min(overlap, max_chars - 1)
    groups = []
    last_text = None
    serial = 0
    carried = []
    for position, doc in enumerate(documents):
        meta = deepcopy(doc.meta or {})
        text = doc.content or ""
        if meta.get("modality") == "figure":
            groups.append([None, doc, []])
            continue
        if not text.strip():
            continue
        path = heading_path(meta)
        if "section_ordinal" in meta:
            pieces = [(text, meta)]
        elif path:
            # Legacy parsers provide titles, but no positional hierarchy.
            pieces = [
                (text, {**meta, "heading_path": path, "section_ordinal": f"legacy-{position}"})
            ]
        else:
            pieces = []
            parse_headings = not meta.get("symbol") and not meta.get("literal_text")
            resume = meta.pop("continues_section", False)
            sections = (
                markdown_sections(text, carried if resume else (), serial)
                if parse_headings
                else [(text, [], serial)]
            )
            for body, stack, ordinal in sections:
                serial = max(serial, ordinal)
                if resume:
                    carried = stack
                if not body.strip():
                    continue
                pieces.append(
                    (
                        body,
                        {
                            **meta,
                            "heading_path": [h[1] for h in stack],
                            "section_path": [f"md-{h[2]}" for h in stack],
                            "section_ordinal": f"md-{ordinal}" if stack else f"unit-{position}",
                            "structure_source": "markdown" if stack else "fallback",
                        },
                    )
                )
        for body, part_meta in pieces:
            locality = tuple(
                str(part_meta.get(k, ""))
                for k in ("slide", "sheet", "start", "end", "symbol", "block_id")
            )
            key = (
                str(part_meta["section_ordinal"]),
                tuple(part_meta.get("heading_path", [])),
                locality,
            )
            pages = page_list(part_meta)
            if last_text is not None and groups[last_text][0] == key:
                prior_key, prior, spans = groups[last_text]
                glue = _block_glue(prior.content, spans[-1][2], body, pages)
                offset = len(prior.content) + len(glue)
                spans.append((offset, offset + len(body), pages))
                prior = replace(prior, content=prior.content + glue + body)
                groups[last_text] = [prior_key, prior, spans]
                prior.meta.setdefault("dl_meta", {}).setdefault("doc_items", []).extend(
                    part_meta.get("dl_meta", {}).get("doc_items", [])
                )
            else:
                groups.append(
                    [key, Document(content=body, meta=part_meta), [(0, len(body), pages)]]
                )
                last_text = len(groups) - 1
    out = []
    offsets = defaultdict(int)
    for key, group, spans in _fold_lone_headings(groups):
        if key is None:
            out.append(group)
            continue
        section_key = str(group.meta["section_ordinal"])
        from src.rag_tables import table_parts, table_units

        units = (
            list(table_units(group.content))
            if not group.meta.get("literal_text")
            else [(0, len(group.content), False)]
        )
        literal = group.meta.get("literal_text")
        base = offsets[section_key]
        lead = ""
        taken = None
        for index, (unit_start, unit_end, is_table) in enumerate(units):
            if index == taken:
                continue
            unit = replace(group, content=group.content[unit_start:unit_end])
            if is_table:
                # A heading or short text directly above a table belongs on its first
                # part, a short closing text on its last.
                parts = list(table_parts(unit.content, max_chars - len(lead)))
                used = len(parts[-1][0]) + (len(lead) if len(parts) == 1 else 0)
                note = _table_note(group, units, index, max_chars - used)
                if note:
                    taken = index + 1
                    content, start, end, prefix = parts[-1]
                    parts[-1] = (content + note, start, end + len(note), prefix)
                for content, start, end, prefix in parts:
                    meta = deepcopy(group.meta)
                    first = unit_start + start - len(lead)
                    meta.update(
                        block_type="table",
                        table_id=f"{section_key}:{base + unit_start}",
                        repeated_header_chars=prefix,
                        table_header="".join(unit.content.splitlines(keepends=True)[:2]),
                        split_idx_start=base + first,
                        source_end=base + unit_start + end,
                        chunking_version=CHUNKING_VERSION,
                        chunk_max_chars=max_chars,
                        chunk_overlap_chars=0,
                    )
                    _stamp_pages(meta, spans, first, unit_start + end)
                    out.append(Document(content=lead + content, meta=meta))
                    lead = ""
                continue
            if not unit.content.strip() or (not literal and _rules_only(unit.content)):
                continue
            if (
                index + 1 < len(units)
                and units[index + 1][2]
                and len(unit.content) <= max_chars // 2
                and (len(unit.content.strip()) <= _TABLE_NOTE_CHARS or _heading_only(unit.content))
            ):
                lead = unit.content
                continue
            if not literal:
                unit = replace(unit, content=_TRAILING_RULES.sub("", unit.content))
            for chunk in _split_text_unit(unit, max_chars, overlap, base + unit_start):
                _stamp_pages(
                    chunk.meta,
                    spans,
                    chunk.meta["split_idx_start"] - base,
                    chunk.meta["source_end"] - base,
                )
                out.append(chunk)
        offsets[section_key] += len(group.content) + 2
    return out


def _split_text_unit(group, max_chars, overlap, offset):
    from haystack import Document

    text = group.content
    marks = _cut_marks(text)
    out = []
    for index, (start, end) in enumerate(_chunk_ranges(len(text), marks, max_chars, overlap)):
        if index:
            start = _overlap_start(text, start, overlap, marks[1])
        chunk = Document(content=text[start:end], meta=deepcopy(group.meta))
        chunk.meta["split_idx_start"] = start + offset
        chunk.meta["source_end"] = end + offset
        chunk.meta["chunking_version"] = CHUNKING_VERSION
        chunk.meta["chunk_max_chars"] = max_chars
        chunk.meta["chunk_overlap_chars"] = overlap
        out.append(chunk)
    return out


def assign_sections(documents):
    """Stable Haystack window metadata, scoped to content, owner and document."""
    if not documents:
        return
    identity = {k: documents[0].meta.get(k) for k in ("source", "owner", "scope")}
    source_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    version = hashlib.sha256()
    for doc in documents:
        version.update((doc.content or "").encode())
        version.update(
            json.dumps(
                {
                    k: doc.meta.get(k)
                    for k in (
                        "section_ordinal",
                        "chunk_max_chars",
                        "chunk_overlap_chars",
                        "chunking_version",
                        "embedding_tokenizer",
                        "embedding_max_tokens",
                    )
                },
                sort_keys=True,
            ).encode()
        )
    generation = version.hexdigest()[:20]
    by_section = defaultdict(list)
    for seq, doc in enumerate(documents):
        meta = doc.meta
        ordinal = meta.get("section_ordinal", f"legacy-{seq // 3}")
        if meta.get("modality") == "figure":
            ordinal = f"figure-{seq}"
        seed = f"{source_id}:{generation}:{ordinal}"
        sid = hashlib.sha256(seed.encode()).hexdigest()[:24]
        meta.update(
            document_id=source_id,
            document_version=generation,
            seq=seq,
            section_id=sid,
            source_id=sid,
        )
        path = meta.get("section_path") or []
        if len(path) > 1:
            parent_seed = f"{source_id}:{generation}:{path[-2]}"
            meta["parent_section_id"] = hashlib.sha256(parent_seed.encode()).hexdigest()[:24]
        by_section[sid].append(doc)
    replacements = {}
    for sid, siblings in by_section.items():
        for index, doc in enumerate(siblings):
            new_id = hashlib.sha256(f"{sid}:{index}".encode()).hexdigest()
            if is_dataclass(doc):
                updated = replace(doc, id=new_id)
                replacements[id(doc)] = updated
                siblings[index] = updated
            else:
                doc.id = new_id
        for index, doc in enumerate(siblings):
            doc.meta.update(
                split_id=index,
                chunk_index=index,
                chunk_count=len(siblings),
                prev_chunk_id=siblings[index - 1].id if index else None,
                next_chunk_id=siblings[index + 1].id if index + 1 < len(siblings) else None,
            )
    documents[:] = [replacements.get(id(doc), doc) for doc in documents]


class ScopedDocumentStore:
    """Apply caller authorization filters to every native Haystack window lookup."""

    def __init__(self, store, filters):
        self.store = store
        self.filters = filters

    def filter_documents(self, filters=None, **kwargs):
        from src.rag_generations import combine, store_filter

        return self.store.filter_documents(
            filters=store_filter(self.store, combine(self.filters, filters)), **kwargs
        )


def expand_context(store, results, max_chars=12000, window=1, filters=None):
    """Native Haystack neighbor lookup with anchor-first budgeting and citations."""
    from haystack import Document
    from haystack.components.retrievers import SentenceWindowRetriever

    if window < 1:
        return results
    retriever = SentenceWindowRetriever(
        document_store=ScopedDocumentStore(store, filters),
        window_size=window,
        source_id_meta_field=["section_id", "source", "document_version"],
        split_id_meta_field="split_id",
        raise_on_missing_meta_fields=False,
    )
    for result in results:
        meta = result.get("metadata") or {}
        if meta.get("modality") == "figure" or not meta.get("document_version"):
            continue  # Legacy metadata cannot safely reconstruct a chapter.
        anchor = Document(
            id=result.get("id") or "anchor", content=result.get("document") or "", meta=meta
        )
        if len(anchor.content) > max_chars:
            continue  # A small expansion cap must never truncate the actual hit.
        fetched = retriever.run(retrieved_documents=[anchor])["context_documents"]
        candidates = {d.id: d for d in fetched}
        candidates[anchor.id] = anchor
        selected = [anchor]
        budget = len(anchor.content)
        for doc in sorted(
            candidates.values(),
            key=lambda d: abs(d.meta.get("split_id", 0) - meta.get("split_id", 0)),
        ):
            if doc.id == anchor.id:
                continue
            if budget + len(doc.content or "") + 2 <= max_chars:
                selected.append(doc)
                budget += len(doc.content or "") + 2
        selected.sort(key=lambda d: d.meta.get("split_id", 0))
        result["_context_documents"] = [
            {"id": d.id, "document": d.content or "", "metadata": dict(d.meta)} for d in selected
        ]
        budget_context(result, max_chars)
    return results


def _source_record(doc):
    meta = doc.get("metadata") or {}
    return {
        "id": doc.get("id"),
        **{
            k: meta.get(k)
            for k in ("source", "page", "pages", "heading_path", "chunk_index", "start", "end")
        },
    }


def budget_context(result, max_chars, seen=None):
    """Budget and deduplicate *after* relevance filtering, keeping the hit whole.

    `seen` is local to one consumer response. Never deduplicate in the retriever:
    an earlier hit might subsequently fail a relevance threshold.
    """
    anchor = result.get("document") or ""
    docs = result.get("_context_documents")
    if not docs:
        expanded = result.get("expanded") or anchor
        if len(expanded) <= max_chars:
            return expanded
        # Legacy expansions have no component map; retain the actual match.
        result.pop("expanded_sources", None)
        result.pop("expanded", None)
        return anchor if len(anchor) <= max_chars else ""
    seen = seen if seen is not None else set()
    namespace = result.get("collection")
    if (namespace, result.get("id")) in seen:
        result["expanded_sources"] = []
        return ""
    if len(anchor) > max_chars:
        result["expanded_sources"] = []
        return ""
    center = result.get("metadata", {}).get("split_id", 0)
    selected = []
    used = 0
    for doc in sorted(
        docs,
        key=lambda d: (
            d.get("id") != result.get("id"),
            abs(d.get("metadata", {}).get("split_id", 0) - center),
        ),
    ):
        if (namespace, doc.get("id")) in seen:
            continue
        cost = len(doc["document"]) + (2 if selected else 0)
        if used + cost <= max_chars:
            selected.append(doc)
            used += cost
    selected.sort(key=lambda d: d.get("metadata", {}).get("split_id", 0))
    merged, end, previous_table = "", None, None
    for doc in selected:
        meta = doc.get("metadata") or {}
        start = meta.get("split_idx_start")
        text = doc["document"]
        prefix = meta.get("repeated_header_chars", 0)
        if prefix and previous_table == meta.get("table_id") and end == start:
            text = text[prefix:]
        if start is not None and end is not None:
            if start < end:
                text = text[max(0, end - start) :]
            elif start > end:
                merged += "\n\n"
        elif merged:
            merged += "\n\n"
        merged += text
        end = (
            meta.get("source_end", start + len(doc["document"]) - prefix)
            if start is not None
            else None
        )
        previous_table = meta.get("table_id")
        seen.add((namespace, doc.get("id")))
    result["expanded"] = merged
    result["expanded_sources"] = [_source_record(d) for d in selected]
    return merged


def context_location(result):
    """Human-readable provenance for the exact window passed to the model."""
    records = result.get("expanded_sources") or []
    pages = sorted(
        {
            int(page)
            for record in records
            for page in page_list(record)
            if isinstance(page, (int, float)) and not isinstance(page, bool)
        }
    )
    path = heading_path(result.get("metadata") or {})
    parts = []
    if path:
        parts.append("Section: " + " / ".join(str(h) for h in path))
    if pages:
        parts.append("Context pages: " + ", ".join(map(str, pages)))
    return "; ".join(parts)
