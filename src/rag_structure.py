"""Format adapters and a shared Haystack character splitter.

Imports stay lazy: importing the application does not initialize RAG or OCR.
"""

import hashlib
import json
from collections import defaultdict
from copy import deepcopy
from dataclasses import is_dataclass, replace

CHUNKING_VERSION = "haystack-sections-v2"


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


def markdown_sections(text):
    """Return exact source slices and a positional heading hierarchy."""
    from markdown_it import MarkdownIt

    tokens = MarkdownIt().parse(text)
    lines = text.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    headings = []
    for i, token in enumerate(tokens):
        if token.type == "heading_open" and token.map:
            headings.append((starts[token.map[0]], int(token.tag[1:]), tokens[i + 1].content))
    stack = []
    cursor = 0
    ordinal = 0
    for offset, level, title in headings:
        if offset > cursor:
            yield text[cursor:offset], list(stack), ordinal
        ordinal += 1
        stack = [entry for entry in stack if entry[0] < level]
        stack.append((level, title, ordinal))
        cursor = offset
    if cursor < len(text):
        yield text[cursor:], list(stack), ordinal


def docling_documents(serialized):
    """Consume lossless Docling JSON, keeping layout provenance and heading IDs."""
    from docling_core.types.doc import DoclingDocument
    from haystack import Document

    native = DoclingDocument.model_validate_json(serialized)
    stack = []
    ordinal = 0
    documents = []
    for item, _depth in native.iterate_items():
        label = str(getattr(item, "label", ""))
        # Enum str behavior differs between docling-core releases.
        label = getattr(getattr(item, "label", None), "value", label)
        if label in {"page_header", "page_footer"}:
            continue
        if label in {"title", "section_header"}:
            ordinal += 1
            level = int(getattr(item, "level", 1) or 1)
            title = getattr(item, "text", "")
            stack = [entry for entry in stack if entry[0] < level]
            stack.append((level, title, ordinal))
            content = f"{'#' * min(level, 6)} {title}"
        elif label == "table":
            content = item.export_to_markdown(doc=native)
        elif label == "picture":
            content = item.caption_text(native)
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
        if label == "table":
            meta["block_type"] = "table"
            meta["block_id"] = str(item.self_ref)
        documents.append(Document(content=content, meta=meta))
    return documents


def split_documents(documents, max_chars=4000, overlap=200):
    """Normalize sections, then use the same Haystack splitter for every lane.

    Page, sheet, slide, symbol and timed-segment boundaries remain provenance
    boundaries. Parts can still share a section across pages.
    """
    from haystack import Document
    from haystack.components.preprocessors import RecursiveDocumentSplitter

    overlap = min(overlap, max_chars - 1)
    splitter = RecursiveDocumentSplitter(
        split_length=max_chars - overlap,
        split_overlap=0,
        split_unit="char",
        separators=["\n\n", "\n", ". ", "! ", "? ", "; ", " "],
    )
    splitter.warm_up()
    groups = []
    serial = 0
    for position, doc in enumerate(documents):
        meta = deepcopy(doc.meta or {})
        text = doc.content or ""
        if meta.get("modality") == "figure":
            groups.append((None, doc))
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
            sections = markdown_sections(text) if parse_headings else [(text, [], 0)]
            local_ids = {}
            for body, stack, ordinal in sections:
                if not body.strip():
                    continue
                for _level, _title, local in stack:
                    if local not in local_ids:
                        serial += 1
                        local_ids[local] = f"md-{position}-{serial}"
                section = local_ids.get(ordinal, f"unit-{position}")
                pieces.append(
                    (
                        body,
                        {
                            **meta,
                            "heading_path": [h[1] for h in stack],
                            "section_path": [local_ids[h[2]] for h in stack],
                            "section_ordinal": section,
                            "structure_source": "markdown" if stack else "fallback",
                        },
                    )
                )
        for body, part_meta in pieces:
            locality = tuple(
                str(part_meta.get(k, ""))
                for k in ("page", "slide", "sheet", "start", "end", "symbol", "block_id")
            )
            key = (
                str(part_meta["section_ordinal"]),
                tuple(part_meta.get("heading_path", [])),
                locality,
            )
            if groups and groups[-1][0] == key:
                prior = groups[-1][1]
                prior = replace(prior, content=prior.content + "\n\n" + body)
                groups[-1] = (key, prior)
                prior.meta.setdefault("dl_meta", {}).setdefault("doc_items", []).extend(
                    part_meta.get("dl_meta", {}).get("doc_items", [])
                )
            else:
                groups.append((key, Document(content=body, meta=part_meta)))
    out = []
    offsets = defaultdict(int)
    for key, group in groups:
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
        for unit_start, unit_end, is_table in units:
            unit = replace(group, content=group.content[unit_start:unit_end])
            if is_table:
                for content, start, end, prefix in table_parts(unit.content, max_chars):
                    meta = deepcopy(group.meta)
                    meta.update(
                        block_type="table",
                        table_id=f"{section_key}:{offsets[section_key] + unit_start}",
                        repeated_header_chars=prefix,
                        table_header="".join(unit.content.splitlines(keepends=True)[:2]),
                        split_idx_start=offsets[section_key] + unit_start + start,
                        source_end=offsets[section_key] + unit_start + end,
                        chunking_version=CHUNKING_VERSION,
                        chunk_max_chars=max_chars,
                        chunk_overlap_chars=0,
                    )
                    out.append(Document(content=content, meta=meta))
                continue
            out.extend(
                _split_text_unit(
                    unit, splitter, max_chars, overlap, offsets[section_key] + unit_start
                )
            )
        offsets[section_key] += len(group.content) + 2
    return out


def _split_text_unit(group, splitter, max_chars, overlap, offset):
    from haystack import Document

    pieces = splitter.run(documents=[group])["documents"]
    # Haystack recursively preserves small blocks (including headings).
    # Pack those blocks so a heading need not become a standalone vector.
    ranges = []
    for piece in pieces:
        start = piece.meta["split_idx_start"]
        end = start + len(piece.content)
        capacity = max_chars if len(ranges) == 1 else max_chars - overlap
        if ranges and end - ranges[-1][0] <= capacity:
            ranges[-1] = (ranges[-1][0], end)
        else:
            ranges.append((start, end))
    out = []
    for index, (start, end) in enumerate(ranges):
        start = max(0, start - overlap) if index else start
        chunk = Document(content=group.content[start:end], meta=deepcopy(group.meta))
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
            for page in (record.get("pages") or [record.get("page")])
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
