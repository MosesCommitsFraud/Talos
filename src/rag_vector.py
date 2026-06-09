"""
rag_vector.py

Vector-based RAG using ChromaDB for storage and API-based embeddings.
Features: persistent storage, hybrid search (vector + keyword), sentence-aware chunking,
configurable embedding endpoint via EMBEDDING_URL env var.
"""

import os
import hashlib
import json
import re
import logging
import numpy as np
import sqlite3
import uuid
from typing import List, Dict, Any, Optional, Set
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_FILE_EXTENSIONS: Set[str] = {
    # Plain text / code (read directly)
    '.txt', '.md', '.py', '.json', '.yaml', '.yml', '.css', '.js', '.ts',
    # Rich documents (Docling / pypdf / markitdown)
    '.csv', '.html', '.xhtml', '.adoc', '.pdf',
    '.docx', '.pptx', '.xlsx', '.xls', '.epub',
    # Images (Docling OCR + layout)
    '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.gif',
}

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3

COLLECTION_NAME = "talos_rag"
MAX_KEYWORD_FALLBACK_SCAN = int(os.getenv("RAG_MAX_KEYWORD_FALLBACK_SCAN", "5000"))
RRF_K = 60


def _apply_saved_rag_config():
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
    except Exception:
        cfg = {}
    if not isinstance(cfg, dict):
        return
    mapping = {
        "embedding_url": "EMBEDDING_URL",
        "embedding_model": "EMBEDDING_MODEL",
        "qdrant_url": "QDRANT_URL",
        "qdrant_api_key": "QDRANT_API_KEY",
        "rerank_url": "RERANK_URL",
        "rerank_model": "RERANK_MODEL",
        "rerank_api_key": "RERANK_API_KEY",
    }
    for key, env_name in mapping.items():
        value = str(cfg.get(key) or "").strip()
        if value:
            os.environ[env_name] = value


def _qdrant_point_id(doc_id: str) -> str:
    return str(uuid.UUID(hashlib.sha256(doc_id.encode("utf-8")).hexdigest()[:32]))


def _keyword_score(query: str, doc_text: str) -> float:
    query_words = set(query.lower().split())
    if not query_words:
        return 0.0
    doc_words = set((doc_text or "").lower().split())
    return len(query_words & doc_words) / len(query_words)


def _generate_doc_id(text: str, owner: str = "") -> str:
    # Owner-scope the id so two owners can index byte-identical chunks
    # without the second one's add early-returning on the first's id and
    # being silently dropped from their owner-filtered search results.
    # Empty owner reproduces the legacy text-only id so the unowned/base
    # index keeps its existing ids and isn't re-churned.
    key = f"{owner}\x00{text}" if owner else text
    return f"doc_{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}"


def _fts_query(query: str) -> str:
    terms = re.findall(r"[\w][\w.-]*", query.lower())
    return " OR ".join(f'"{t.replace(chr(34), chr(34) + chr(34))}"' for t in terms[:12])


def _rrf_fuse(groups: List[List[Dict[str, Any]]], k: int) -> List[Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}
    scores: Dict[str, float] = {}
    sources: Dict[str, set] = {}
    for group in groups:
        for rank, item in enumerate(group, start=1):
            item_id = str(item.get("id") or "")
            if not item_id:
                continue
            by_id.setdefault(item_id, item)
            scores[item_id] = scores.get(item_id, 0.0) + (1.0 / (RRF_K + rank))
            src = item.get("search_type") or "vector"
            sources.setdefault(item_id, set()).add(src)
    fused = []
    for item_id, item in by_id.items():
        row = dict(item)
        row["rrf_score"] = round(scores.get(item_id, 0.0), 6)
        row["search_type"] = "+".join(sorted(sources.get(item_id, {"vector"})))
        # Use RRF for pre-rerank ordering. Rerank score replaces similarity later.
        row["similarity"] = row["rrf_score"]
        fused.append(row)
    fused.sort(key=lambda c: c.get("rrf_score", 0.0), reverse=True)
    return fused[:k]


class VectorRAG:
    """RAG system using ChromaDB vector storage with hybrid search."""

    def __init__(self, persist_directory: str = "data/chroma"):
        self.persist_directory = persist_directory
        self._collection = None
        self._qdrant = None
        self._model = None
        self._healthy = False
        self._backend = "chroma"
        self._last_rerank_error = ""
        self._fts_path = os.path.join(self.persist_directory, "rag_fts.sqlite3")

        Path(self.persist_directory).mkdir(parents=True, exist_ok=True)
        self._initialize_system()

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize_system(self) -> bool:
        try:
            _apply_saved_rag_config()
            from src.embeddings import get_embedding_client

            self._model = get_embedding_client()
            if self._model is None:
                raise RuntimeError("No embedding backend available")
            logger.info(f"Embedding: {self._model.url} model={self._model.model}")
            self._init_fts()

            qdrant_url = os.getenv("QDRANT_URL", "").strip()
            if qdrant_url:
                from qdrant_client import QdrantClient
                from qdrant_client.models import Distance, VectorParams

                self._backend = "qdrant"
                self._qdrant = QdrantClient(url=qdrant_url, api_key=os.getenv("QDRANT_API_KEY") or None)
                dim = self._model.get_sentence_embedding_dimension()
                if not self._qdrant.collection_exists(COLLECTION_NAME):
                    self._qdrant.create_collection(
                        collection_name=COLLECTION_NAME,
                        vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
                    )
                count = self._qdrant.count(collection_name=COLLECTION_NAME, exact=True).count
                logger.info(f"VectorRAG ready with Qdrant ({count} docs) url={qdrant_url}")
                self._healthy = True
                return True

            from src.chroma_client import get_chroma_client

            client = get_chroma_client()
            self._collection = client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )

            count = self._collection.count()
            logger.info(f"VectorRAG ready ({count} docs)")
            self._healthy = True
            return True

        except Exception as e:
            logger.error(f"VectorRAG init failed: {e}")
            self._healthy = False
            return False

    def _fts_conn(self):
        conn = sqlite3.connect(self._fts_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_fts(self) -> None:
        Path(self.persist_directory).mkdir(parents=True, exist_ok=True)
        with self._fts_conn() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5("
                "id UNINDEXED, document, filename, title, section, source UNINDEXED, owner UNINDEXED, metadata_json UNINDEXED)"
            )

    def _fts_upsert(self, doc_id: str, text: str, metadata: Dict[str, Any]) -> None:
        try:
            with self._fts_conn() as conn:
                conn.execute("DELETE FROM rag_fts WHERE id = ?", (doc_id,))
                conn.execute(
                    "INSERT INTO rag_fts(id, document, filename, title, section, source, owner, metadata_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        doc_id,
                        text,
                        str(metadata.get("filename") or ""),
                        str(metadata.get("title") or ""),
                        str(metadata.get("section") or ""),
                        str(metadata.get("source") or ""),
                        str(metadata.get("owner") or ""),
                        json.dumps(metadata, ensure_ascii=False),
                    ),
                )
        except Exception as e:
            logger.warning("FTS upsert failed for %s: %s", doc_id, e)

    def _fts_delete_ids(self, ids: List[str]) -> None:
        if not ids:
            return
        try:
            with self._fts_conn() as conn:
                conn.executemany("DELETE FROM rag_fts WHERE id = ?", [(str(i),) for i in ids])
        except Exception as e:
            logger.warning("FTS delete failed: %s", e)

    def _fts_clear(self) -> None:
        try:
            with self._fts_conn() as conn:
                conn.execute("DELETE FROM rag_fts")
        except Exception as e:
            logger.warning("FTS clear failed: %s", e)

    def _fts_search(self, query: str, k: int, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        match = _fts_query(query)
        if not match:
            return []
        try:
            where_owner = " AND owner = ?" if owner else ""
            params: List[Any] = [match]
            if owner:
                params.append(owner)
            params.append(k)
            with self._fts_conn() as conn:
                rows = conn.execute(
                    "SELECT id, document, filename, title, section, source, owner, metadata_json, bm25(rag_fts) AS bm25_score "
                    f"FROM rag_fts WHERE rag_fts MATCH ?{where_owner} ORDER BY bm25_score LIMIT ?",
                    params,
                ).fetchall()
            out = []
            for row in rows:
                try:
                    meta = json.loads(row["metadata_json"] or "{}")
                except Exception:
                    meta = {}
                out.append({
                    "id": row["id"],
                    "document": row["document"],
                    "metadata": meta,
                    "bm25_score": round(float(row["bm25_score"]), 6),
                    "similarity": round(1.0 / (1.0 + abs(float(row["bm25_score"]))), 6),
                    "search_type": "bm25",
                })
            return out
        except Exception as e:
            logger.warning("FTS search failed: %s", e)
            return []

    def _embed(self, texts: List[str]) -> List[List[float]]:
        vecs = self._model.encode(texts, normalize_embeddings=True)
        return np.array(vecs, dtype=np.float32).tolist()

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def healthy(self) -> bool:
        if self._backend == "qdrant":
            return self._healthy and self._qdrant is not None
        return self._healthy and self._collection is not None

    @property
    def collection(self):
        """Expose the ChromaDB collection for direct access by personal_routes etc."""
        return self._collection

    # ------------------------------------------------------------------
    # Document operations
    # ------------------------------------------------------------------

    def add_document(self, text: str, metadata: Dict[str, Any]) -> bool:
        if not self.healthy:
            logger.error("Collection not initialized")
            return False
        if not text or not isinstance(text, str):
            return False
        if not metadata or not isinstance(metadata, dict):
            return False

        try:
            doc_id = _generate_doc_id(text, metadata.get("owner") or "")
            if self._backend == "qdrant":
                from qdrant_client.models import PointStruct

                point_id = _qdrant_point_id(doc_id)
                existing = self._qdrant.retrieve(collection_name=COLLECTION_NAME, ids=[point_id])
                if existing:
                    self._fts_upsert(doc_id, text, metadata)
                    return True
                payload = {**metadata, "document": text, "doc_id": doc_id}
                self._qdrant.upsert(
                    collection_name=COLLECTION_NAME,
                    points=[PointStruct(id=point_id, vector=self._embed([text])[0], payload=payload)],
                )
                self._fts_upsert(doc_id, text, metadata)
                return True

            # Check if already exists
            existing = self._collection.get(ids=[doc_id])
            if existing["ids"]:
                self._fts_upsert(doc_id, text, metadata)
                return True  # already exists
            embeddings = self._embed([text])
            self._collection.add(
                ids=[doc_id],
                embeddings=embeddings,
                documents=[text],
                metadatas=[metadata],
            )
            self._fts_upsert(doc_id, text, metadata)
            return True
        except Exception as e:
            logger.error(f"add_document failed: {e}")
            return False

    def add_documents_batch(self, docs: List[tuple]) -> Dict[str, Any]:
        if not self.healthy:
            return {"success": False, "message": "Collection not initialized"}
        if not docs:
            return {"success": False, "message": "Empty document list"}

        valid = [
            (t, m) for t, m in docs
            if t and isinstance(t, str) and m and isinstance(m, dict)
        ]
        if not valid:
            return {"success": False, "message": "No valid documents"}

        try:
            # Resolve which docs already exist in ONE round trip rather than one
            # lookup per chunk. _generate_doc_id is deterministic, so we can
            # compute every id up front and ask the backend for all of them at
            # once (Qdrant.retrieve and Chroma.get both take an id list).
            doc_ids = [_generate_doc_id(t, m.get("owner") or "") for t, m in valid]
            if self._backend == "qdrant":
                point_ids = [_qdrant_point_id(d) for d in doc_ids]
                found = self._qdrant.retrieve(collection_name=COLLECTION_NAME, ids=point_ids)
                existing_point_ids = {str(p.id) for p in found}
                existing_doc_ids = {
                    d for d, pid in zip(doc_ids, point_ids)
                    if str(pid) in existing_point_ids
                }
            else:
                found = self._collection.get(ids=doc_ids)
                existing_doc_ids = set(found.get("ids") or [])

            new_texts = []
            new_metas = []
            new_ids = []
            # Dedup within this batch too: a file can produce byte-identical
            # chunks, which collide on doc_id and would otherwise be embedded
            # and upserted twice.
            seen_in_batch: Set[str] = set()
            for (t, m), doc_id in zip(valid, doc_ids):
                if doc_id in existing_doc_ids or doc_id in seen_in_batch:
                    continue
                seen_in_batch.add(doc_id)
                new_texts.append(t)
                new_metas.append(m)
                new_ids.append(doc_id)

            if new_texts:
                # Batch in chunks of 100
                for i in range(0, len(new_texts), 100):
                    batch_texts = new_texts[i:i + 100]
                    batch_ids = new_ids[i:i + 100]
                    batch_metas = new_metas[i:i + 100]
                    embeddings = self._embed(batch_texts)
                    if self._backend == "qdrant":
                        from qdrant_client.models import PointStruct

                        points = [
                            PointStruct(
                                id=_qdrant_point_id(doc_id),
                                vector=emb,
                                payload={**meta, "document": text, "doc_id": doc_id},
                            )
                            for doc_id, emb, meta, text in zip(batch_ids, embeddings, batch_metas, batch_texts)
                        ]
                        self._qdrant.upsert(collection_name=COLLECTION_NAME, points=points)
                        for doc_id, text, meta in zip(batch_ids, batch_texts, batch_metas):
                            self._fts_upsert(doc_id, text, meta)
                        continue
                    self._collection.add(
                        ids=batch_ids,
                        embeddings=embeddings,
                        documents=batch_texts,
                        metadatas=batch_metas,
                    )
                    for doc_id, text, meta in zip(batch_ids, batch_texts, batch_metas):
                        self._fts_upsert(doc_id, text, meta)

            return {
                "success": True,
                "added_count": len(new_texts),
                "total_count": len(docs),
                "failed_count": len(docs) - len(valid),
            }
        except Exception as e:
            logger.error(f"add_documents_batch failed: {e}")
            return {"success": False, "message": str(e)}

    # ------------------------------------------------------------------
    # Search — hybrid: vector similarity + keyword overlap
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        k: int = 5,
        owner: Optional[str] = None,
        candidate_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        if not self.healthy:
            return []
        if not query or not isinstance(query, str):
            return []

        try:
            fetch_k = max(int(candidate_k or k * 5), k)
            if self._backend == "qdrant":
                vector_candidates = self._search_qdrant_candidates(query, owner=owner, candidate_k=fetch_k)
                bm25_candidates = self._fts_search(query, fetch_k, owner=owner)
                fused = _rrf_fuse([vector_candidates, bm25_candidates], fetch_k)
                top = self._rerank(query, fused, k)
                logger.info(f"Qdrant hybrid search for '{query[:60]}': {len(top)} results")
                return top

            if self._collection.count() == 0:
                return []

            # Fetch a broad candidate pool, then rerank down to final k. Keeping
            # these separate is critical for cross-encoder rerankers to help.
            fetch_k = min(fetch_k, self._collection.count())
            if owner:
                fetch_k = min(fetch_k * 2, self._collection.count())

            query_embeddings = self._embed([query])

            # Use ChromaDB where filter for owner if specified
            where_filter = {"owner": owner} if owner else None

            results = self._collection.query(
                query_embeddings=query_embeddings,
                n_results=fetch_k,
                where=where_filter,
                include=["documents", "metadatas", "distances"],
            )

            query_words = set(query.lower().split())
            candidates = []

            for idx in range(len(results["ids"][0])):
                doc_id = results["ids"][0][idx]
                distance = results["distances"][0][idx]
                doc_text = results["documents"][0][idx]
                meta = results["metadatas"][0][idx]

                # ChromaDB cosine distance = 1 - cosine_similarity
                vector_sim = 1.0 - distance

                keyword_score = _keyword_score(query, doc_text)

                hybrid_score = (VECTOR_WEIGHT * vector_sim) + (KEYWORD_WEIGHT * keyword_score)

                candidates.append({
                    "id": doc_id,
                    "document": doc_text,
                    "metadata": meta,
                    "distance": round(distance, 4),
                    "similarity": round(hybrid_score, 4),
                    "vector_similarity": round(vector_sim, 4),
                    "keyword_score": round(keyword_score, 4),
                })

            candidates.sort(key=lambda c: c["similarity"], reverse=True)
            bm25_candidates = self._fts_search(query, fetch_k, owner=owner)
            fused = _rrf_fuse([candidates, bm25_candidates], fetch_k)
            top = self._rerank(query, fused, k)
            logger.info(f"Hybrid search for '{query[:60]}': {len(top)} results")
            return top

        except Exception as e:
            logger.error(f"search failed: {e}")
            return self._keyword_search_fallback(query, k, owner=owner)

    def _search_qdrant_candidates(
        self,
        query: str,
        owner: Optional[str] = None,
        candidate_k: int = 40,
    ) -> List[Dict[str, Any]]:
        count = self._qdrant.count(collection_name=COLLECTION_NAME, exact=True).count
        if count == 0:
            return []
        from qdrant_client.models import FieldCondition, Filter, MatchValue

        fetch_k = min(max(int(candidate_k), 1), count)
        query_filter = Filter(must=[FieldCondition(key="owner", match=MatchValue(value=owner))]) if owner else None
        query_vector = self._embed([query])[0]
        if hasattr(self._qdrant, "query_points"):
            response = self._qdrant.query_points(
                collection_name=COLLECTION_NAME,
                query=query_vector,
                query_filter=query_filter,
                limit=fetch_k,
                with_payload=True,
            )
            points = response.points
        else:
            points = self._qdrant.search(
                collection_name=COLLECTION_NAME,
                query_vector=query_vector,
                query_filter=query_filter,
                limit=fetch_k,
                with_payload=True,
            )

        candidates = []
        for point in points:
            payload = point.payload or {}
            doc_text = payload.get("document", "")
            vector_sim = float(getattr(point, "score", 0.0) or 0.0)
            keyword_score = _keyword_score(query, doc_text)
            hybrid_score = (VECTOR_WEIGHT * vector_sim) + (KEYWORD_WEIGHT * keyword_score)
            metadata = {k: v for k, v in payload.items() if k not in {"document", "doc_id"}}
            candidates.append({
                "id": payload.get("doc_id", str(point.id)),
                "document": doc_text,
                "metadata": metadata,
                "distance": round(1.0 - vector_sim, 4),
                "similarity": round(hybrid_score, 4),
                "vector_similarity": round(vector_sim, 4),
                "keyword_score": round(keyword_score, 4),
            })
        candidates.sort(key=lambda c: c["similarity"], reverse=True)
        return candidates

    def _rerank(self, query: str, candidates: List[Dict[str, Any]], k: int) -> List[Dict[str, Any]]:
        url = os.getenv("RERANK_URL", "").strip()
        if not url or not candidates:
            return candidates[:k]
        try:
            import httpx

            model = os.getenv("RERANK_MODEL", "")
            docs = [c.get("document", "") for c in candidates]
            payload = {"query": query, "documents": docs}
            if model:
                payload["model"] = model
            headers = {"Authorization": f"Bearer {os.getenv('RERANK_API_KEY')}"} if os.getenv("RERANK_API_KEY") else {}
            resp = httpx.post(url, json=payload, headers=headers, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            raw = data.get("results") or data.get("data") or []
            ranked = []
            for item in raw:
                idx = item.get("index")
                score = item.get("relevance_score", item.get("score"))
                if isinstance(idx, int) and 0 <= idx < len(candidates):
                    c = dict(candidates[idx])
                    c["rerank_score"] = score
                    if score is not None:
                        c["similarity"] = round(float(score), 4)
                    ranked.append(c)
            if ranked:
                self._last_rerank_error = ""
                return ranked[:k]
            self._last_rerank_error = "Rerank response contained no ranked results"
        except Exception as e:
            self._last_rerank_error = str(e)
            logger.warning("Rerank failed, using vector ranking: %s", e)
        return candidates[:k]

    def test_reranker(self) -> Dict[str, Any]:
        url = os.getenv("RERANK_URL", "").strip()
        if not url:
            return {"configured": False, "ok": False, "message": "RERANK_URL is not configured"}
        try:
            import httpx

            model = os.getenv("RERANK_MODEL", "")
            payload = {"query": "alpha", "documents": ["alpha beta", "unrelated gamma"]}
            if model:
                payload["model"] = model
            headers = {"Authorization": f"Bearer {os.getenv('RERANK_API_KEY')}"} if os.getenv("RERANK_API_KEY") else {}
            resp = httpx.post(url, json=payload, headers=headers, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            raw = data.get("results") or data.get("data") or []
            ok = any(isinstance(item, dict) and isinstance(item.get("index"), int) for item in raw)
            return {
                "configured": True,
                "ok": bool(ok),
                "model": model,
                "message": "Reranker reachable" if ok else "Reranker response did not include indexed results",
            }
        except Exception as e:
            return {"configured": True, "ok": False, "model": os.getenv("RERANK_MODEL", ""), "message": str(e)}

    def _keyword_search_fallback(self, query: str, k: int = 5, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        try:
            if self._backend == "qdrant":
                return []

            if self._collection.count() == 0:
                return []

            count = self._collection.count()
            if count > MAX_KEYWORD_FALLBACK_SCAN:
                logger.warning(
                    "Skipping keyword fallback full scan: collection has %s docs; limit is %s",
                    count,
                    MAX_KEYWORD_FALLBACK_SCAN,
                )
                return []

            # Fetch all documents for keyword search fallback
            all_docs = self._collection.get(include=["documents", "metadatas"])
            if not all_docs["ids"]:
                return []

            query_words = query.lower().split()
            scored = []
            for i, doc in enumerate(all_docs["documents"]):
                meta = all_docs["metadatas"][i]
                if owner:
                    # Match the primary path's strict where={"owner": owner}
                    # filter. The old `if doc_owner and doc_owner != owner`
                    # let docs with a missing/empty owner fall through, leaking
                    # owner-less documents into another user's results.
                    if meta.get("owner") != owner:
                        continue
                doc_lower = doc.lower()
                score = sum(1 for w in query_words if w in doc_lower)
                if score > 0:
                    scored.append({
                        "id": all_docs["ids"][i],
                        "document": doc,
                        "metadata": meta,
                        "distance": 0,
                        "similarity": score,
                        "search_type": "keyword_fallback",
                    })

            scored.sort(key=lambda x: x["similarity"], reverse=True)
            return scored[:k]
        except Exception as e:
            logger.error(f"keyword fallback failed: {e}")
            return []

    # ------------------------------------------------------------------
    # Index management
    # ------------------------------------------------------------------

    def rebuild_index(self) -> bool:
        try:
            if self._backend == "qdrant":
                from qdrant_client.models import Distance, VectorParams

                dim = self._model.get_sentence_embedding_dimension()
                if self._qdrant.collection_exists(COLLECTION_NAME):
                    self._qdrant.delete_collection(COLLECTION_NAME)
                self._qdrant.create_collection(
                    collection_name=COLLECTION_NAME,
                    vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
                )
                self._fts_clear()
                self._healthy = True
                return True

            from src.chroma_client import get_chroma_client
            client = get_chroma_client()
            try:
                client.delete_collection(COLLECTION_NAME)
            except Exception:
                pass
            self._collection = client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
            self._fts_clear()
            self._healthy = True
            return True
        except Exception as e:
            logger.error(f"rebuild_index failed: {e}")
            self._healthy = False
            return False

    def get_stats(self) -> Dict[str, Any]:
        if not self.healthy:
            return {"error": "Collection not initialized"}
        try:
            count = (
                self._qdrant.count(collection_name=COLLECTION_NAME, exact=True).count
                if self._backend == "qdrant"
                else self._collection.count()
            )
            return {
                "document_count": count,
                "embedding_model": f"{self._model.model} @ {self._model.url}" if self._model else "N/A",
                "persist_directory": self.persist_directory,
                "collection_name": COLLECTION_NAME,
                "vector_backend": self._backend,
                "rerank_enabled": bool(os.getenv("RERANK_URL", "").strip()),
                "rerank_model": os.getenv("RERANK_MODEL", ""),
                "last_rerank_error": self._last_rerank_error,
                "fts_enabled": True,
                "healthy": True,
            }
        except Exception as e:
            logger.error(f"get_stats failed: {e}")
            return {"error": str(e), "healthy": False}

    # ------------------------------------------------------------------
    # Directory indexing
    # ------------------------------------------------------------------

    def index_personal_documents(
        self,
        directory: str,
        file_extensions: Optional[set] = None,
        owner: Optional[str] = None,
        progress_cb=None,
        cancel_cb=None,
    ) -> Dict[str, Any]:
        if file_extensions is None:
            file_extensions = DEFAULT_FILE_EXTENSIONS

        indexed = 0
        failed = 0

        try:
            for root, _, files in os.walk(directory):
                for fname in files:
                    if cancel_cb and cancel_cb():
                        return {
                            'success': False,
                            'cancelled': True,
                            'indexed_count': indexed,
                            'failed_count': failed,
                            'message': f'Cancelled after indexing {indexed} chunks from {directory}',
                        }
                    fpath = os.path.join(root, fname)
                    ext = Path(fname).suffix.lower()
                    if ext not in file_extensions:
                        continue

                    try:
                        # Unified extractor: Docling (PDF/Office/HTML/images,
                        # incl. OCR) with pypdf/markitdown/raw-text fallbacks.
                        from src.personal_docs import extract_file_content
                        content = extract_file_content(fpath)

                        if not content or not content.strip():
                            continue

                        meta = {
                            'source': fpath,
                            'filename': fname,
                            'directory': root,
                            'type': ext,
                        }
                        if owner:
                            meta['owner'] = owner

                        if cancel_cb and cancel_cb():
                            return {
                                'success': False,
                                'cancelled': True,
                                'indexed_count': indexed,
                                'failed_count': failed,
                                'message': f'Cancelled after indexing {indexed} chunks from {directory}',
                            }
                        # Batch all of this file's chunks into a single
                        # add_documents_batch call. That embeds in groups (one
                        # HTTP request per ~100 chunks) and batches the Qdrant
                        # existence check + upsert, instead of one embedding
                        # request and two round trips *per chunk*. For large
                        # files this is the difference between seconds and
                        # minutes (#perf).
                        file_docs = [
                            (chunk, {**meta, 'chunk_id': i})
                            for i, chunk in enumerate(self._split_into_chunks(content))
                        ]
                        if file_docs:
                            result = self.add_documents_batch(file_docs)
                            if result.get("success"):
                                indexed += len(file_docs)
                            else:
                                failed += len(file_docs)
                        if progress_cb:
                            progress_cb({"file": fpath, "indexed_count": indexed, "failed_count": failed})
                    except Exception as e:
                        logger.error(f"index {fpath}: {e}")
                        failed += 1
                        if progress_cb:
                            progress_cb({"file": fpath, "indexed_count": indexed, "failed_count": failed})

            return {
                'success': True,
                'indexed_count': indexed,
                'failed_count': failed,
                'message': f'Indexed {indexed} chunks from {directory}',
            }
        except Exception as e:
            logger.error(f"index_personal_documents {directory}: {e}")
            return {'success': False, 'indexed_count': indexed, 'failed_count': failed, 'message': str(e)}

    def remove_directory(self, directory: str) -> Dict[str, Any]:
        """Remove all chunks under ``directory`` (recursively), and nothing else.

        Selection is a Python-side path-boundary match on each chunk's stored
        ``source`` full path, NOT a Chroma metadata ``where`` filter. No Chroma
        metadata operator selects a scalar string by path prefix (``$contains``
        targets document content / list membership, not a ``source`` substring),
        and a plain substring would over-delete siblings — removing ``/docs``
        must not touch ``/docs2`` or ``/docs_personal``. We therefore match
        ``source == directory`` or ``source`` startswith ``directory + os.sep``,
        the same boundary rule add_directory uses for exclusions. ``directory``
        is abspath-normalized so it matches the absolute ``source`` that indexing
        always stores, regardless of how the caller passed it in.
        """
        if not self.healthy:
            return {"success": False, "message": "Collection not initialized"}
        directory = os.path.abspath(directory)
        try:
            if self._backend == "qdrant":
                ids = self._qdrant.scroll(collection_name=COLLECTION_NAME, limit=10000, with_payload=True)[0]
                point_ids = []
                for point in ids:
                    m = point.payload or {}
                    source = m.get("source")
                    if isinstance(source, str) and (source == directory or source.startswith(directory + os.sep)):
                        point_ids.append(point.id)
                if point_ids:
                    self._qdrant.delete(collection_name=COLLECTION_NAME, points_selector=point_ids)
                    doc_ids = [str((p.payload or {}).get("doc_id") or p.id) for p in ids if p.id in point_ids]
                    self._fts_delete_ids(doc_ids)
                return {"success": True, "removed_count": len(point_ids), "message": f"Removed {len(point_ids)} chunks"}

            results = self._collection.get(include=["metadatas"])
            ids = [
                results["ids"][i]
                for i, m in enumerate(results["metadatas"])
                if isinstance(m, dict)
                and isinstance(m.get("source"), str)
                and (m["source"] == directory or m["source"].startswith(directory + os.sep))
            ]
            if not ids:
                return {"success": True, "removed_count": 0, "message": "No docs found"}

            self._collection.delete(ids=ids)
            self._fts_delete_ids(ids)
            n = len(ids)
            logger.info(f"Removed {n} chunks from {directory}")
            return {"success": True, "removed_count": n, "message": f"Removed {n} chunks"}
        except Exception as e:
            logger.error(f"remove_directory {directory}: {e}")
            return {"success": False, "message": str(e)}

    def reindex_directory(
        self, directory: str, file_extensions: Optional[set] = None
    ) -> Dict[str, Any]:
        remove_result = self.remove_directory(directory)
        if not remove_result.get("success"):
            return remove_result
        index_result = self.index_personal_documents(directory, file_extensions)
        return {
            "success": index_result.get("success", False),
            "message": (
                f"Re-index for {directory}: removed {remove_result.get('removed_count', 0)}, "
                f"{index_result.get('message', '')}"
            ),
            "removed_count": remove_result.get("removed_count", 0),
            "indexed_count": index_result.get("indexed_count", 0),
            "failed_count": index_result.get("failed_count", 0),
        }

    # ------------------------------------------------------------------
    # Sentence-boundary-aware chunking
    # ------------------------------------------------------------------

    def _split_into_chunks(
        self, text: str, chunk_size: int = 1000, overlap: int = 200
    ) -> List[str]:
        if not text:
            return []
        if len(text) <= chunk_size:
            return [text]

        # Split into sentences first
        sentences = re.split(r'(?<=[.!?])\s+|\n{2,}', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        chunks: List[str] = []
        current_chunk: List[str] = []
        current_len = 0

        for sentence in sentences:
            sent_len = len(sentence)

            # If a single sentence exceeds chunk_size, split it by character
            if sent_len > chunk_size:
                # Flush current chunk first
                if current_chunk:
                    chunks.append(' '.join(current_chunk))
                    current_chunk = []
                    current_len = 0

                # Hard-split the long sentence
                for start in range(0, sent_len, chunk_size - overlap):
                    chunks.append(sentence[start:start + chunk_size])
                continue

            if current_len + sent_len + 1 > chunk_size and current_chunk:
                chunks.append(' '.join(current_chunk))
                # Keep last few sentences for overlap
                overlap_sentences: List[str] = []
                overlap_len = 0
                for s in reversed(current_chunk):
                    if overlap_len + len(s) > overlap:
                        break
                    overlap_sentences.insert(0, s)
                    overlap_len += len(s) + 1
                current_chunk = overlap_sentences
                current_len = sum(len(s) for s in current_chunk) + max(0, len(current_chunk) - 1)

            current_chunk.append(sentence)
            current_len += sent_len + (1 if current_len > 0 else 0)

        if current_chunk:
            chunks.append(' '.join(current_chunk))

        return chunks if chunks else [text]

    # ------------------------------------------------------------------
    # Delete by metadata
    # ------------------------------------------------------------------

    def delete_by_source(self, source: str) -> int:
        """Remove all chunks whose metadata['source'] matches *source*.
        Returns the number of removed chunks."""
        if not self.healthy:
            return 0
        try:
            if self._backend == "qdrant":
                from qdrant_client.models import FieldCondition, Filter, FilterSelector, MatchValue

                flt = Filter(must=[FieldCondition(key="source", match=MatchValue(value=source))])
                count = self._qdrant.count(collection_name=COLLECTION_NAME, count_filter=flt, exact=True).count
                if count:
                    hits = self._qdrant.scroll(collection_name=COLLECTION_NAME, scroll_filter=flt, limit=10000, with_payload=True)[0]
                    self._fts_delete_ids([str((p.payload or {}).get("doc_id") or p.id) for p in hits])
                    self._qdrant.delete(collection_name=COLLECTION_NAME, points_selector=FilterSelector(filter=flt))
                return int(count)

            results = self._collection.get(
                where={"source": source},
                include=[],
            )
            ids = results.get("ids", [])
            if not ids:
                return 0
            self._collection.delete(ids=ids)
            self._fts_delete_ids(ids)
            logger.info(f"Deleted {len(ids)} chunks for source={source}")
            return len(ids)
        except Exception as e:
            logger.error(f"delete_by_source failed: {e}")
            return 0

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    def retrieve(self, query: str, k: int = 5) -> List[str]:
        return [r['document'] for r in self.search(query, k)]
