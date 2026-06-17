"""Generic external RAG retrieval client.

Lets the chat pipeline pull context from an external retrieval service (e.g.
RagFlow) instead of the built-in Qdrant pipeline. The client POSTs the query to
a configurable URL with a Bearer key and a dataset/knowledge-base id, then
normalizes the response into the same shape the internal RAG manager returns —
``{document, metadata{filename, source}, similarity, rerank_score}`` — so the
downstream context-injection code in ``chat_processor`` is unchanged.

Several common response shapes are accepted (RagFlow's ``data.chunks``, a plain
``results``/``chunks``/``data`` list, OpenAI-style records), so it works against
RagFlow and similar services without per-vendor code.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _as_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_records(data: Any) -> List[dict]:
    """Pull the list of result records out of a few common envelopes."""
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if not isinstance(data, dict):
        return []
    # RagFlow: {"data": {"chunks": [...]}}
    inner = data.get("data")
    if isinstance(inner, dict):
        for key in ("chunks", "results", "records", "documents"):
            seq = inner.get(key)
            if isinstance(seq, list):
                return [r for r in seq if isinstance(r, dict)]
    if isinstance(inner, list):
        return [r for r in inner if isinstance(r, dict)]
    for key in ("chunks", "results", "records", "documents", "matches"):
        seq = data.get(key)
        if isinstance(seq, list):
            return [r for r in seq if isinstance(r, dict)]
    return []


def _normalize_record(rec: dict) -> Optional[dict]:
    """Map a service record into the internal RAG result shape."""
    document = (
        rec.get("content")
        or rec.get("content_with_weight")
        or rec.get("document")
        or rec.get("text")
        or rec.get("chunk")
        or ""
    )
    if not isinstance(document, str) or not document.strip():
        return None
    filename = (
        rec.get("document_keyword")
        or rec.get("docnm_kwd")
        or rec.get("filename")
        or rec.get("document_name")
        or rec.get("source")
        or (rec.get("metadata") or {}).get("filename")
        or (rec.get("metadata") or {}).get("source")
        or "external"
    )
    similarity = _as_float(
        rec.get("similarity")
        if rec.get("similarity") is not None
        else rec.get("score")
    )
    rerank_score = _as_float(rec.get("rerank_score") or rec.get("relevance_score") or rec.get("vector_similarity"))
    return {
        "document": document,
        "metadata": {"filename": str(filename), "source": str(filename)},
        "similarity": similarity if similarity is not None else 0.0,
        "rerank_score": rerank_score,
    }


class ExternalRagClient:
    """Thin retrieval client for an external RAG service."""

    def __init__(self, cfg: dict):
        self.url = str(cfg.get("external_url") or "").strip()
        self.api_key = str(cfg.get("external_api_key") or "").strip()
        self.dataset_id = str(cfg.get("external_dataset_id") or "").strip()
        try:
            self.top_k = max(1, min(int(cfg.get("external_top_k") or 5), 50))
        except (TypeError, ValueError):
            self.top_k = 5

    @property
    def configured(self) -> bool:
        return bool(self.url and self.dataset_id)

    @property
    def healthy(self) -> bool:
        # Cheap, side-effect-free reachability check used by the test route.
        if not self.configured:
            return False
        try:
            self.search("ping", k=1)
            return True
        except Exception as e:
            logger.warning("External RAG health check failed: %s", e)
            return False

    def search(self, query: str, k: int = 5, owner=None, candidate_k: Optional[int] = None) -> List[Dict[str, Any]]:
        del owner  # external KB is global, no owner filter
        if not self.configured or not (query or "").strip():
            return []
        import httpx

        top_n = max(int(k or self.top_k), candidate_k or 0) or self.top_k
        # dataset_ids covers RagFlow; the singular forms cover other services.
        ids = [self.dataset_id]
        payload: Dict[str, Any] = {
            "question": query,
            "query": query,
            "dataset_ids": ids,
            "knowledgebase_id": self.dataset_id,
            "dataset_id": self.dataset_id,
            "top_k": top_n,
            "page_size": top_n,
            "similarity_threshold": 0.0,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        resp = httpx.post(self.url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        records = _extract_records(resp.json())
        results = [n for n in (_normalize_record(r) for r in records) if n]
        return results[:top_n]
