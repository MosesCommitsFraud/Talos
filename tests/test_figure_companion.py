"""Unit tests for companion-figure attachment (VectorRAG._attach_companion_figures).

A figure chunk's caption rarely outranks prose/ASR chunks, so figures ride
along with the text hits from their document instead of winning the ranking
themselves. Companions are reranked against the query on their own captions
(each carries its own score + anchor_id); without a reranker they fall back to
inheriting their anchor's scores. Pure logic against a stub store — no Qdrant,
embeddings, or model deps (RERANK_URL is unset under pytest, so the fallback
path runs unless a test stubs _rerank).
"""

import importlib

rv = importlib.import_module("src.rag_vector")

_QUERY = "how do I align the impeller"


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


def test_attaches_same_page_figure_with_anchor_and_fallback_scores():
    rag = _rag([_fig(1, page=3), _fig(2, page=5)])
    out = rag._attach_companion_figures(_QUERY, [_hit(page=3, score=0.9)])
    assert len(out) == 2
    fig = out[1]
    assert fig["metadata"]["image_url"].endswith("fig1.png")
    # No reranker in tests → the companion inherits its anchor's scores.
    assert fig["rerank_score"] == 0.9 and fig["similarity"] == 0.9
    assert fig["search_type"] == "figure_companion"
    assert fig["anchor_id"] == "hit"


def test_no_page_anchor_attaches_all_document_figures():
    rag = _rag([_fig(1), _fig(2)])
    out = rag._attach_companion_figures(_QUERY, [_hit()])
    assert [r["id"] for r in out] == ["hit", "fig1", "fig2"]


def test_no_cap_on_attached_figures():
    # There is deliberately no attachment cap: relevance is decided per figure
    # by the rerank score downstream, not by an arbitrary count.
    rag = _rag([_fig(i, page=1) for i in range(10)])
    out = rag._attach_companion_figures(_QUERY, [_hit(page=1)])
    assert len(out) == 11


def test_companions_are_reranked_on_their_captions():
    rag = _rag([_fig(1, page=1), _fig(2, page=1)])

    def fake_rerank(query, candidates, k):
        assert query == _QUERY
        scored = []
        for c in candidates:
            c = dict(c)
            c["rerank_score"] = 0.8 if c["id"] == "fig2" else 0.05
            c["similarity"] = c["rerank_score"]
            scored.append(c)
        return sorted(scored, key=lambda c: -c["rerank_score"])[:k]

    rag._rerank = fake_rerank
    out = rag._attach_companion_figures(_QUERY, [_hit(page=1, score=0.9)])
    figs = {r["id"]: r for r in out if r.get("search_type") == "figure_companion"}
    # Each figure keeps its OWN score — not the anchor's 0.9 — so the
    # chat-side threshold can drop fig1 while keeping fig2.
    assert figs["fig2"]["rerank_score"] == 0.8
    assert figs["fig1"]["rerank_score"] == 0.05
    assert all(f["anchor_id"] == "hit" for f in figs.values())


def test_docling_provenance_page_is_used():
    rag = _rag([_fig(1, page=2)])
    hit = _hit(dl_meta={"doc_items": [{"prov": [{"page_no": 2}]}]})
    out = rag._attach_companion_figures(_QUERY, [hit])
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
    out = rag._attach_companion_figures(_QUERY, [already, _hit(page=1)])
    assert len(out) == 2  # nothing re-attached


def test_store_failure_returns_results_unchanged():
    r = object.__new__(rv.VectorRAG)
    r._store = None  # filter_documents raises → best-effort no-op
    hits = [_hit(page=1)]
    assert r._attach_companion_figures(_QUERY, hits) == hits


# ── Video keyframes: time-window companions ──


def _keyframe(n, start, source="/u/training.mp4"):
    return _Doc(
        f"kf{n}",
        f"screen {n}",
        {
            "modality": "figure",
            "figure_kind": "keyframe",
            "source": source,
            "start": float(start),
            "end": float(start) + 8.0,
            "image_url": f"/api/personal/rag-asset?source=kf{n}.png",
        },
    )


def _video_hit(start, end, source="/u/training.mp4", score=0.8):
    return {
        "id": "vhit",
        "document": "transcript",
        "metadata": {"source": source, "modality": "video", "start": start, "end": end},
        "similarity": score,
        "rerank_score": score,
    }


def test_video_hit_attaches_keyframes_in_time_window():
    rag = _rag([_keyframe(i, start=i * 30) for i in range(20)])  # 0..570s
    out = rag._attach_companion_figures(_QUERY, [_video_hit(start=100, end=130)])
    attached = [r for r in out if r.get("search_type") == "figure_companion"]
    win = rv.VectorRAG._COMPANION_TIME_WINDOW_SEC
    # Every keyframe inside the ±window rides along (no cap); none outside.
    expected = [i * 30 for i in range(20) if 100 - win <= i * 30 <= 130 + win]
    assert sorted(r["metadata"]["start"] for r in attached) == sorted(expected)
    # Nearest-first: the closest keyframe to the segment start comes first.
    assert attached[0]["metadata"]["start"] == 90.0


def test_video_hit_skips_keyframes_outside_window():
    rag = _rag([_keyframe(1, start=400)])
    out = rag._attach_companion_figures(_QUERY, [_video_hit(start=100, end=130)])
    assert len(out) == 1  # 400s is far outside the ±window


def test_citation_media_keeps_image_branch_for_keyframes():
    """Regression: a keyframe figure whose *source* is an .mp4 must surface its
    image preview, not be misrouted to the assetless-video branch."""
    import importlib

    cp = importlib.import_module("src.chat_processor")

    kf_meta = {
        "modality": "figure",
        "source": "/u/training.mp4",
        "filename": "training.mp4",
        "start": 90.0,
        "end": 98.0,
        "image_url": "/api/personal/rag-asset?source=kf1.png",
        "image_caption": "[at 1:30] Freigabe dialog",
    }
    media = cp._citation_media(kf_meta)
    assert media["modality"] == "image"
    assert media["image_url"].endswith("kf1.png")

    # Plain ASR transcript chunks still take the video branch.
    asr_meta = {"modality": "video", "source": "/u/training.mp4", "start": 10.0, "end": 20.0}
    assert cp._citation_media(asr_meta)["modality"] == "video"


def test_only_best_text_pages_contribute_pdf_figures():
    import src.chat_processor as cp

    source = "/u/training.pdf"
    results = [
        {
            "id": "band-text",
            "document": "Band einfügen per Rechtsklick",
            "metadata": {"source": source, "page": 6},
            "rerank_score": 0.93,
        },
        {
            "id": "drilldown-text",
            "document": "DrillDownControl im Gruppenband",
            "metadata": {"source": source, "page": 27},
            "rerank_score": 0.51,
        },
        {
            "id": "band-figure",
            "document": "Band einfügen menu",
            "metadata": {"source": source, "page": 6, "image_url": "/band.png"},
            "rerank_score": 0.90,
        },
        {
            "id": "drilldown-figure",
            "document": "DrillDownControl",
            "metadata": {"source": source, "page": 27, "image_url": "/drill.png"},
            "rerank_score": 0.60,
        },
        {
            "id": "sparkline-figure",
            "document": "Sparkline einfügen",
            "metadata": {"source": source, "page": 28, "image_url": "/spark.png"},
            "rerank_score": 0.58,
        },
    ]

    filtered = cp._figures_from_best_text_pages(results)

    assert {r["id"] for r in filtered} == {
        "band-text",
        "drilldown-text",
        "band-figure",
    }


def test_page_filter_does_not_drop_standalone_or_video_images():
    import src.chat_processor as cp

    results = [
        {
            "id": "standalone",
            "metadata": {"source": "/u/image.png", "image_url": "/image.png"},
            "rerank_score": 0.8,
        },
        {
            "id": "keyframe",
            "metadata": {
                "source": "/u/video.mp4",
                "image_url": "/frame.png",
                "start": 90.0,
            },
            "rerank_score": 0.8,
        },
    ]

    assert cp._figures_from_best_text_pages(results) == results
