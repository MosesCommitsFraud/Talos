"""Exact optional embedding budgets, including every enrichment and header."""

from copy import deepcopy
from functools import lru_cache


@lru_cache(maxsize=4)
def load_tokenizer(name):
    from transformers import AutoTokenizer

    # A tokenizer must never require executing third-party Python code.
    return AutoTokenizer.from_pretrained(name, trust_remote_code=False)


def embedding_counter(tokenizer_name, max_tokens):
    if not tokenizer_name and not max_tokens:
        return None, 0
    if not tokenizer_name:
        raise ValueError(
            "Embedding token budget requires embedding_tokenizer (model ID or local path)."
        )
    tokenizer = load_tokenizer(tokenizer_name)
    native_limit = int(getattr(tokenizer, "model_max_length", 0) or 0)
    known_limit = native_limit if 0 < native_limit < 1_000_000 else 0
    limit = (
        min(max_tokens, known_limit) if max_tokens and known_limit else max_tokens or known_limit
    )
    if not limit:
        raise ValueError("Tokenizer has no finite model limit; configure embedding_max_tokens.")
    return lambda text: len(
        tokenizer.encode(text, add_special_tokens=True, truncation=False)
    ), limit


def bound_documents(documents, render, count, limit, preserve_ids=False):
    """Split oversized text losslessly; refuse metadata-only overflow or asset edits."""
    from haystack import Document

    result = []
    for document in documents:
        content = document.content or ""
        meta = document.meta or {}
        if count(render(meta, content)) <= limit:
            document.meta["embedding_token_count"] = count(render(meta, content))
            result.append(document)
            continue
        if preserve_ids or meta.get("modality") == "figure":
            raise ValueError(
                "Edited chunk or figure exceeds embedding token limit; shorten it before indexing."
            )
        header = meta.get("table_header") or ""
        if header and not content.startswith(header):
            header = ""
        if count(render(meta, header)) >= limit:
            raise ValueError(
                "Embedding metadata/table header exhausts token budget; reduce enrichment or increase the limit."
            )
        body = content[len(header) :]
        spans = []

        def divide(start, end):
            text = header + body[start:end]
            if count(render(meta, text)) <= limit:
                spans.append((start, end, text))
                return
            if end - start <= 1:
                raise ValueError(
                    "Embedding token budget cannot fit one source character plus metadata."
                )
            middle = (start + end) // 2
            boundary = max(body.rfind("\n", start + 1, middle), body.rfind(" ", start + 1, middle))
            if boundary > start:
                middle = boundary + 1
            divide(start, middle)
            divide(middle, end)

        divide(0, len(body))
        base = meta.get("split_idx_start", 0)
        original_prefix = int(meta.get("repeated_header_chars", 0))
        for index, (start, end, text) in enumerate(spans):
            child = deepcopy(meta)
            child.pop("_split_overlap", None)
            child["split_idx_start"] = (
                base if index == 0 else base + len(header) - original_prefix + start
            )
            child["source_end"] = base + len(header) - original_prefix + end
            child["repeated_header_chars"] = original_prefix if index == 0 else len(header)
            child["embedding_token_count"] = count(render(child, text))
            result.append(Document(content=text, meta=child))
    return result
