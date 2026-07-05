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
    # Even with many keyframes (which would trip the unanchored flood guard),
    # a timed hit attaches the ones near its window and skips distant ones.
    rag = _rag([_keyframe(i, start=i * 30) for i in range(20)])  # 0..570s
    out = rag._attach_companion_figures([_video_hit(start=100, end=130)])
    attached = [r for r in out if r.get("search_type") == "figure_companion"]
    assert 1 <= len(attached) <= rv.VectorRAG._COMPANION_FIGURES_MAX
    win = rv.VectorRAG._COMPANION_TIME_WINDOW_SEC
    for r in attached:
        assert 100 - win <= r["metadata"]["start"] <= 130 + win
    # Nearest-first: the closest keyframe to the segment start comes first.
    assert attached[0]["metadata"]["start"] == 90.0


def test_video_hit_skips_keyframes_outside_window():
    rag = _rag([_keyframe(1, start=400)])
    out = rag._attach_companion_figures([_video_hit(start=100, end=130)])
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
