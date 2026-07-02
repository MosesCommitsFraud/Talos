"""Unit tests for companion-figure attachment (VectorRAG._attach_companion_figures).

A figure chunk's caption rarely outranks prose/ASR chunks, so figures ride
along with the text hits from their document instead of winning the ranking
themselves. Pure logic against a stub store — no Qdrant, embeddings, or model
deps.
"""

import importlib

rv = importlib.import_module("src.rag_vector")


class _Doc:
    def __init__(self, id, content, meta):
        self.id, self.content, self.meta = id, content, meta


class _Store:
    """Answers the exact source+modality filter _figures_for_source issues."""

    def __init__(self, docs):
        self._docs = docs

    def filter_documents(self, filters):
        conds = {c["field"]: c["value"] for c in filters["conditions"]}
        return [
            d
            for d in self._docs
            if d.meta.get("source") == conds["meta.source"]
            and d.meta.get("modality") == conds["meta.modality"]
        ]


def _rag(figure_docs):
    r = object.__new__(rv.VectorRAG)
    r._store = _Store(figure_docs)
    return r


def _fig(n, source="/u/doc.pdf", page=None):
    return _Doc(
        f"fig{n}",
        f"caption {n}",
        {
            "modality": "figure",
            "source": source,
            "page": page,
            "image_url": f"/api/personal/rag-asset?source=fig{n}.png",
        },
    )


def _hit(source="/u/doc.pdf", page=None, score=0.66, **meta):
    md = {"source": source, **meta}
    if page is not None:
        md["page"] = page
    return {
        "id": "hit",
        "document": "text",
        "metadata": md,
        "similarity": score,
        "rerank_score": score,
    }


def test_attaches_same_page_figure_and_inherits_scores():
    rag = _rag([_fig(1, page=3), _fig(2, page=5)])
    out = rag._attach_companion_figures([_hit(page=3, score=0.9)])
    assert len(out) == 2
    fig = out[1]
    assert fig["metadata"]["image_url"].endswith("fig1.png")
    assert fig["rerank_score"] == 0.9 and fig["similarity"] == 0.9
    assert fig["search_type"] == "figure_companion"


def test_no_page_anchor_attaches_all_when_few():
    rag = _rag([_fig(1), _fig(2)])
    out = rag._attach_companion_figures([_hit()])
    assert [r["id"] for r in out] == ["hit", "fig1", "fig2"]


def test_no_page_anchor_skips_figure_heavy_doc():
    rag = _rag([_fig(i) for i in range(6)])
    out = rag._attach_companion_figures([_hit()])
    assert len(out) == 1  # attaching 6 unanchored figures would flood the context


def test_docling_provenance_page_is_used():
    rag = _rag([_fig(1, page=2)])
    hit = _hit(dl_meta={"doc_items": [{"prov": [{"page_no": 2}]}]})
    out = rag._attach_companion_figures([hit])
    assert len(out) == 2


def test_dedupes_figure_already_retrieved():
    fig = _fig(1, page=1)
    rag = _rag([fig])
    already = {
        "id": "fig1",
        "document": fig.content,
        "metadata": dict(fig.meta),
        "similarity": 0.5,
        "rerank_score": 0.5,
    }
    out = rag._attach_companion_figures([already, _hit(page=1)])
    assert len(out) == 2  # nothing re-attached


def test_cap_limits_attached_figures():
    rag = _rag([_fig(i, page=1) for i in range(10)])
    out = rag._attach_companion_figures([_hit(page=1)])
    assert len(out) == 1 + rv.VectorRAG._COMPANION_FIGURES_MAX


def test_store_failure_returns_results_unchanged():
    r = object.__new__(rv.VectorRAG)
    r._store = None  # filter_documents raises → best-effort no-op
    hits = [_hit(page=1)]
    assert r._attach_companion_figures(hits) == hits
