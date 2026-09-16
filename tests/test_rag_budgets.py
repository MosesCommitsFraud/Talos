from copy import deepcopy

import pytest
from haystack import Document
from haystack.document_stores.in_memory import InMemoryDocumentStore

from src.rag_structure import assign_sections, budget_context, expand_context, split_documents
from src.rag_token_budget import bound_documents, embedding_counter
from src.rag_vector import _embed_text


def test_long_markdown_table_repeats_header_and_reconstructs_original():
    header = "| Name | Value |\n| --- | --- |\n"
    original = header + "".join(f"| row{i} | {'value ' * 10} |\n" for i in range(100))
    docs = split_documents(
        [Document(content=original, meta={"source": "table.md"})], max_chars=1000
    )
    assign_sections(docs)
    assert len(docs) > 2
    assert all(d.content.startswith(header) and len(d.content) <= 1000 for d in docs)
    recovered = "".join(d.content[d.meta["repeated_header_chars"] :] for d in docs)
    assert recovered == original
    store = InMemoryDocumentStore()
    store.write_documents(docs)
    anchor = docs[1]
    result = {"id": anchor.id, "document": anchor.content, "metadata": anchor.meta}
    expand_context(store, [result], max_chars=12000, window=10)
    assert result["expanded"] == original


def test_table_inside_code_fence_is_not_rewritten():
    text = "```\n| A | B |\n| --- | --- |\n| x | y |\n```"
    docs = split_documents([Document(content=text)])
    assert docs[0].content == text
    assert "table_header" not in docs[0].meta


def test_embedding_limit_counts_enrichment_and_splits_losslessly():
    original = "Hydraulik 🙂 " * 100
    meta = {
        "filename": "guide",
        "heading_path": ["Setup"],
        "context": "background " * 5,
        "aux_terms": "hydraulic pressure",
        "split_idx_start": 0,
    }
    docs = bound_documents([Document(content=original, meta=meta)], _embed_text, len, 300)
    assert len(docs) > 1
    assert all(len(_embed_text(d.meta, d.content)) <= 300 for d in docs)
    assert "".join(d.content for d in docs) == original
    assert docs[-1].meta["source_end"] == len(original)


def test_embedding_rejects_metadata_only_overflow():
    with pytest.raises(ValueError, match="metadata/table header"):
        bound_documents(
            [Document(content="body", meta={"context": "x" * 500})], _embed_text, len, 200
        )


def test_limit_requires_matching_tokenizer_and_uses_its_lower_limit(monkeypatch):
    with pytest.raises(ValueError, match="requires embedding_tokenizer"):
        embedding_counter("", 100)

    class Tokenizer:
        model_max_length = 32

        def encode(self, text, **kwargs):
            assert kwargs == {"add_special_tokens": True, "truncation": False}
            return list(text) + [0, 0]

    monkeypatch.setattr("src.rag_token_budget.load_tokenizer", lambda _: Tokenizer())
    count, limit = embedding_counter("matching-tokenizer", 100)
    assert limit == 32
    assert count("body") == 6


def test_consumer_budget_keeps_anchor_and_deduplicates_neighbor_windows():
    text = "# Chapter\n\n" + "word " * 1600
    docs = split_documents([Document(content=text, meta={"source": "guide.md"})])
    assign_sections(docs)
    store = InMemoryDocumentStore()
    store.write_documents(docs)
    results = [{"id": d.id, "document": d.content, "metadata": deepcopy(d.meta)} for d in docs[1:]]
    expand_context(store, results)
    seen = set()
    first = budget_context(results[0], 12000, seen)
    second = budget_context(results[1], 12000, seen)
    assert first == text
    assert second == ""
    # Another consumer has a smaller budget: it receives the actual middle hit.
    narrow = budget_context(results[0], len(docs[1].content) + 2)
    assert narrow == docs[1].content


def test_real_local_tokenizer_checks_model_limit_without_download(tmp_path):
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from tokenizers.pre_tokenizers import Whitespace
    from transformers import PreTrainedTokenizerFast

    native = Tokenizer(WordLevel({"[UNK]": 0, "word": 1}, unk_token="[UNK]"))
    native.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=native, unk_token="[UNK]", model_max_length=16
    )
    tokenizer.save_pretrained(tmp_path)
    count, limit = embedding_counter(str(tmp_path), 32)
    assert limit == 16
    docs = bound_documents([Document(content="word " * 40)], lambda meta, text: text, count, limit)
    assert all(count(d.content) <= 16 for d in docs)
    assert "".join(d.content for d in docs) == "word " * 40


def test_mcp_budget_preserves_middle_hit_and_context_page_provenance():
    from src.mcp_public import render_search_results

    docs = split_documents(
        [
            Document(
                content=text,
                meta={
                    "source": "guide.pdf",
                    "page": page,
                    "section_ordinal": 1,
                    "heading_path": ["Chapter"],
                },
            )
            for page, text in [
                (1, "Before " * 450),
                (2, "MiddleMarker " * 260),
                (3, "After " * 500),
            ]
        ]
    )
    assign_sections(docs)
    store = InMemoryDocumentStore()
    store.write_documents(docs)
    anchor = next(d for d in docs if "MiddleMarker" in d.content)
    hit = {"id": anchor.id, "document": anchor.content, "metadata": anchor.meta}
    expand_context(store, [hit])
    text = render_search_results("MiddleMarker", [hit])
    assert anchor.content.strip() in text
    assert "Context pages: 2" in text
    assert len(text) < 24000
