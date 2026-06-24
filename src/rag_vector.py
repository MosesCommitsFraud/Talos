"""
rag_vector.py

Haystack-orchestrated RAG over Qdrant with native hybrid retrieval and a
vLLM cross-encoder reranker.

Pipeline:
  * Parsing + chunking : Docling ``DoclingConverter`` (HybridChunker — layout-
    and tokenizer-aware) for rich docs/images; a length splitter for plain
    text/code/json.
  * Dense embeddings   : vLLM (OpenAI-compatible) via Haystack ``OpenAI*Embedder``.
  * Sparse embeddings  : FastEmbed BM25/IDF via Haystack ``Fastembed*SparseEmbedder``.
  * Vector store       : Qdrant with named dense+sparse vectors; server-side RRF
    fusion through ``QdrantHybridRetriever``.
  * Reranking          : vLLM reranker (``/v1/rerank``) as the 2nd stage.

Config comes from the saved ``rag_pipeline`` settings (UI fields) and is bridged
to env vars (see ``_apply_saved_rag_config``). Qdrant is **required** — there is
no ChromaDB / SQLite-FTS fallback any more. The public ``VectorRAG`` API
(``search``, ``index_personal_documents``, ``remove_directory``,
``delete_by_source``, ``rebuild_index``, ``get_stats``, ``add_document``,
``add_documents_batch``, ``retrieve``, ``test_reranker``, ``healthy``) is
unchanged, so existing callers — ``rag_singleton``, ``chat_processor``,
``ai_interaction``, the personal/diagnostics routes and ``rag_worker`` — keep
working. All Haystack imports are lazy so the MIT core stays importable without
the optional RAG dependencies installed.
"""

import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

DEFAULT_FILE_EXTENSIONS: Set[str] = {
    # Plain text / code (read directly, length-split)
    ".txt",
    ".md",
    ".py",
    ".json",
    ".yaml",
    ".yml",
    ".css",
    ".js",
    ".ts",
    # Rich documents (Docling parse + HybridChunk)
    ".csv",
    ".html",
    ".xhtml",
    ".adoc",
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".xls",
    ".epub",
    # Images (Docling OCR + layout)
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".bmp",
    ".webp",
    ".gif",
}

COLLECTION_NAME = "talos_rag"
_DEFAULT_SPARSE_MODEL = "Qdrant/bm25"


def _apply_saved_rag_config() -> None:
    """Bridge the UI-configured ``rag_pipeline`` settings onto env vars.

    Lets the admin set every endpoint/model from the Settings → RAG panel
    instead of hardcoding them in the compose file. The separate ingest worker
    receives the same values as a snapshot in the job payload (see
    ``src.rag_worker``) so it stays in sync without reading the app DB.
    """
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
        "sparse_model": "RAG_SPARSE_MODEL",
        "query_prefix": "RAG_QUERY_PREFIX",
    }
    for key, env_name in mapping.items():
        value = str(cfg.get(key) or "").strip()
        if value:
            os.environ[env_name] = value


def _embed_base_url() -> str:
    """Return the OpenAI-style ``/v1`` base URL for the dense embedder.

    The UI stores the full ``/v1/embeddings`` endpoint (what the legacy direct
    httpx client called); Haystack's OpenAI embedder appends ``/embeddings``
    itself and wants the ``/v1`` base, so strip the suffix.
    """
    url = os.getenv("EMBEDDING_URL", "").strip().rstrip("/")
    if url.endswith("/embeddings"):
        url = url[: -len("/embeddings")]
    return url or "http://localhost:8001/v1"


class VectorRAG:
    """Haystack + Qdrant hybrid RAG. Public API kept stable for callers."""

    def __init__(self, persist_directory: str = "data/rag"):
        self.persist_directory = persist_directory
        self._store = None
        self._dim: Optional[int] = None
        self._healthy = False
        self._backend = "qdrant"
        self._last_rerank_error = ""
        self._last_error = ""
        self._sparse_model = _DEFAULT_SPARSE_MODEL
        # Lazily built, cached Haystack components.
        self._retriever = None
        self._dense_q = None
        self._sparse_q = None
        self._dense_d = None
        self._sparse_d = None
        self._docling = None
        self._splitter = None

        Path(self.persist_directory).mkdir(parents=True, exist_ok=True)
        self._initialize_system()

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize_system(self) -> bool:
        try:
            _apply_saved_rag_config()

            qdrant_url = os.getenv("QDRANT_URL", "").strip()
            if not qdrant_url:
                self._last_error = "QDRANT_URL is not configured (Settings → RAG → Qdrant URL)"
                logger.warning("RAG disabled: %s", self._last_error)
                self._healthy = False
                return False

            self._sparse_model = os.getenv("RAG_SPARSE_MODEL", "").strip() or _DEFAULT_SPARSE_MODEL

            # Probe the embedding dimension with the SAME Haystack dense embedder
            # that ingestion/search use. Using a separate client (src.embeddings)
            # risks divergence: it took EMBEDDING_URL as a full endpoint and, when
            # that 404'd, silently fell back to a 384-dim local model while the
            # real embedder returned a different size — guaranteeing a Qdrant dim
            # mismatch. Probing through the real embedder also fails loudly if the
            # endpoint is down instead of degrading to a wrong dimension.
            try:
                probe = self._dense_text_embedder().run(text="dimension probe")
                self._dim = len(probe["embedding"])
            except Exception as e:
                raise RuntimeError(
                    f"embedding endpoint unreachable at {_embed_base_url()} "
                    f"(model={os.getenv('EMBEDDING_MODEL', '')}): {e}"
                ) from e
            if not self._dim:
                raise RuntimeError("embedding endpoint returned an empty vector")

            # Qdrant may still be warming up (container "started" ≠ REST ready),
            # so retry the initial connect a few times before giving up. This
            # avoids a spurious "connection refused" when a job fires right after
            # `docker compose up`.
            count = None
            last_exc: Optional[Exception] = None
            for attempt in range(6):
                try:
                    self._store = self._build_store(recreate=False)
                    count = self._store.count_documents()
                    last_exc = None
                    break
                except ImportError as e:
                    raise RuntimeError(
                        "Haystack/Qdrant RAG dependencies are not installed in this "
                        f"image — rebuild it (docker compose build). Detail: {e}"
                    ) from e
                except Exception as e:
                    msg = str(e).lower()
                    # Embedding dimension changed vs. the existing collection —
                    # not a connection issue, retrying won't help. Tell the user
                    # exactly what to do.
                    if "vector size" in msg or "already exists" in msg:
                        raise RuntimeError(
                            f"Embedding dimension mismatch: the '{COLLECTION_NAME}' collection was "
                            f"created with a different vector size than the current embedding model "
                            f"({os.getenv('EMBEDDING_MODEL', '')}, dim={self._dim}) returns. Use "
                            f"'Rebuild index' (or delete the '{COLLECTION_NAME}' collection in Qdrant) "
                            f"and re-index. Detail: {e}"
                        ) from e
                    last_exc = e
                    logger.warning("Qdrant connect attempt %s/6 failed: %s", attempt + 1, e)
                    time.sleep(2)
            if last_exc is not None:
                raise RuntimeError(
                    f"Qdrant connection failed at {qdrant_url} after retries: {last_exc}"
                ) from last_exc

            logger.info(
                "VectorRAG ready (Qdrant hybrid, %s docs, dim=%s, sparse=%s) url=%s",
                count,
                self._dim,
                self._sparse_model,
                qdrant_url,
            )
            self._last_error = ""
            self._healthy = True
            return True
        except Exception as e:
            self._last_error = f"{type(e).__name__}: {e}"
            logger.error(f"VectorRAG init failed: {self._last_error}")
            self._healthy = False
            return False

    @property
    def last_error(self) -> str:
        return self._last_error

    def _build_store(self, recreate: bool = False):
        from haystack.utils import Secret
        from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

        api_key = os.getenv("QDRANT_API_KEY") or ""
        return QdrantDocumentStore(
            url=os.getenv("QDRANT_URL", "").strip(),
            api_key=Secret.from_token(api_key) if api_key else None,
            index=COLLECTION_NAME,
            embedding_dim=self._dim or 1024,
            use_sparse_embeddings=True,
            sparse_idf=True,  # IDF modifier — required for BM25-style sparse
            recreate_index=recreate,
            return_embedding=False,
            wait_result_from_api=True,
        )

    # ------------------------------------------------------------------
    # Cached Haystack components
    # ------------------------------------------------------------------

    def _dense_text_embedder(self):
        if self._dense_q is None:
            from haystack.components.embedders import OpenAITextEmbedder
            from haystack.utils import Secret

            self._dense_q = OpenAITextEmbedder(
                api_key=Secret.from_token(os.getenv("EMBEDDING_API_KEY") or "not-needed"),
                api_base_url=_embed_base_url(),
                model=os.getenv("EMBEDDING_MODEL", "") or "qwen3-embed",
            )
        return self._dense_q

    def _dense_doc_embedder(self):
        if self._dense_d is None:
            from haystack.components.embedders import OpenAIDocumentEmbedder
            from haystack.utils import Secret

            self._dense_d = OpenAIDocumentEmbedder(
                api_key=Secret.from_token(os.getenv("EMBEDDING_API_KEY") or "not-needed"),
                api_base_url=_embed_base_url(),
                model=os.getenv("EMBEDDING_MODEL", "") or "qwen3-embed",
                progress_bar=False,
            )
        return self._dense_d

    def _sparse_text_embedder(self):
        if self._sparse_q is None:
            from haystack_integrations.components.embedders.fastembed import (
                FastembedSparseTextEmbedder,
            )

            emb = FastembedSparseTextEmbedder(model=self._sparse_model)
            emb.warm_up()
            self._sparse_q = emb
        return self._sparse_q

    def _sparse_doc_embedder(self):
        if self._sparse_d is None:
            from haystack_integrations.components.embedders.fastembed import (
                FastembedSparseDocumentEmbedder,
            )

            emb = FastembedSparseDocumentEmbedder(model=self._sparse_model)
            emb.warm_up()
            self._sparse_d = emb
        return self._sparse_d

    def _hybrid_retriever(self):
        if self._retriever is None:
            from haystack_integrations.components.retrievers.qdrant import (
                QdrantHybridRetriever,
            )

            self._retriever = QdrantHybridRetriever(document_store=self._store)
        return self._retriever

    @staticmethod
    def _build_filters(
        owner: Optional[str] = None,
        scope: Optional[str] = None,
        exclude_scopes: Optional[List[str]] = None,
    ):
        """Combine optional owner/scope constraints into a Haystack-Qdrant filter.

        ``scope`` pins retrieval to one knowledge namespace (e.g. ``"sql"`` for
        the SQL schema files); ``exclude_scopes`` removes namespaces from the
        default knowledge base so SQL-only files never leak into ordinary RAG.
        Documents with no ``scope`` meta are kept by ``exclude_scopes`` (the
        ``not in`` operator can't match an absent field), so legacy chunks stay
        searchable.
        """
        conds = []
        if owner:
            conds.append({"field": "meta.owner", "operator": "==", "value": owner})
        if scope:
            conds.append({"field": "meta.scope", "operator": "==", "value": scope})
        if exclude_scopes:
            conds.append(
                {"field": "meta.scope", "operator": "not in", "value": list(exclude_scopes)}
            )
        if not conds:
            return None
        if len(conds) == 1:
            return conds[0]
        return {"operator": "AND", "conditions": conds}

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def healthy(self) -> bool:
        return self._healthy and self._store is not None

    @property
    def collection(self):
        """Legacy accessor kept for callers; no Chroma collection any more."""
        return None

    # ------------------------------------------------------------------
    # Search — Qdrant hybrid (dense + sparse, RRF) → vLLM rerank
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        k: int = 5,
        owner: Optional[str] = None,
        candidate_k: Optional[int] = None,
        scope: Optional[str] = None,
        exclude_scopes: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if not self.healthy:
            return []
        if not query or not isinstance(query, str):
            return []
        try:
            fetch_k = max(int(candidate_k or k * 5), k)
            # Qwen3-Embedding recommends an instruction prefix on the *query*
            # (e.g. "Instruct: Given a query, retrieve relevant passages\nQuery: ")
            # while documents are embedded without one. Applied to the dense
            # query only; the sparse/BM25 side stays on the raw query terms.
            prefix = os.getenv("RAG_QUERY_PREFIX", "")
            dense = self._dense_text_embedder().run(text=(prefix + query) if prefix else query)[
                "embedding"
            ]
            sparse = self._sparse_text_embedder().run(text=query)["sparse_embedding"]
            response = self._hybrid_retriever().run(
                query_embedding=dense,
                query_sparse_embedding=sparse,
                top_k=fetch_k,
                filters=self._build_filters(owner, scope, exclude_scopes),
            )
            docs = response.get("documents", []) or []
            candidates = [
                {
                    "id": d.id,
                    "document": d.content or "",
                    "metadata": dict(d.meta or {}),
                    "similarity": round(float(d.score or 0.0), 6),
                    "search_type": "hybrid",
                }
                for d in docs
            ]
            top = self._rerank(query, candidates, k)
            logger.info("Qdrant hybrid search for '%s': %s results", query[:60], len(top))
            return top
        except Exception as e:
            logger.error(f"search failed: {e}")
            return []

    def _rerank(self, query: str, candidates: List[Dict[str, Any]], k: int) -> List[Dict[str, Any]]:
        url = os.getenv("RERANK_URL", "").strip()
        if not url or not candidates:
            return candidates[:k]
        try:
            import httpx

            model = os.getenv("RERANK_MODEL", "")
            docs = [c.get("document", "") for c in candidates]
            payload: Dict[str, Any] = {"query": query, "documents": docs}
            if model:
                payload["model"] = model
            headers = (
                {"Authorization": f"Bearer {os.getenv('RERANK_API_KEY')}"}
                if os.getenv("RERANK_API_KEY")
                else {}
            )
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
            logger.warning("Rerank failed, using hybrid ranking: %s", e)
        return candidates[:k]

    def test_reranker(self) -> Dict[str, Any]:
        url = os.getenv("RERANK_URL", "").strip()
        if not url:
            return {"configured": False, "ok": False, "message": "RERANK_URL is not configured"}
        try:
            import httpx

            model = os.getenv("RERANK_MODEL", "")
            payload: Dict[str, Any] = {
                "query": "alpha",
                "documents": ["alpha beta", "unrelated gamma"],
            }
            if model:
                payload["model"] = model
            headers = (
                {"Authorization": f"Bearer {os.getenv('RERANK_API_KEY')}"}
                if os.getenv("RERANK_API_KEY")
                else {}
            )
            resp = httpx.post(url, json=payload, headers=headers, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            raw = data.get("results") or data.get("data") or []
            ok = any(isinstance(item, dict) and isinstance(item.get("index"), int) for item in raw)
            return {
                "configured": True,
                "ok": bool(ok),
                "model": model,
                "message": "Reranker reachable"
                if ok
                else "Reranker response did not include indexed results",
            }
        except Exception as e:
            return {
                "configured": True,
                "ok": False,
                "model": os.getenv("RERANK_MODEL", ""),
                "message": str(e),
            }

    # ------------------------------------------------------------------
    # Ingestion — Docling HybridChunker → dense+sparse embed → Qdrant
    # ------------------------------------------------------------------

    def _write_documents(self, docs) -> int:
        if not docs:
            return 0
        from haystack.document_stores.types import DuplicatePolicy

        docs = self._dense_doc_embedder().run(documents=docs)["documents"]
        docs = self._sparse_doc_embedder().run(documents=docs)["documents"]
        self._store.write_documents(docs, policy=DuplicatePolicy.OVERWRITE)
        return len(docs)

    def _documents_for_file(self, path: str, meta: Dict[str, Any]):
        """Parse + chunk a single file into Haystack Documents with metadata."""
        from haystack.dataclasses import Document

        from src.docling_runtime import is_docling_format

        if is_docling_format(path):
            from haystack_integrations.components.converters.docling import DoclingConverter

            if self._docling is None:
                # Default export_type=DOC_CHUNKS → Docling HybridChunker.
                self._docling = DoclingConverter()
            docs = self._docling.run(sources=[path]).get("documents", []) or []
        else:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
            if not text.strip():
                return []
            from haystack.components.preprocessors import DocumentSplitter

            if self._splitter is None:
                self._splitter = DocumentSplitter(
                    split_by="word", split_length=250, split_overlap=40
                )
                try:
                    self._splitter.warm_up()
                except Exception:
                    pass
            docs = self._splitter.run(documents=[Document(content=text)]).get("documents", []) or []

        for d in docs:
            d.meta.update(meta)
        return docs

    def index_files(
        self,
        files: List[Tuple[str, Dict[str, Any]]],
        progress_cb=None,
        cancel_cb=None,
    ) -> Dict[str, Any]:
        """Index an explicit list of ``(path, metadata)`` pairs (uploads)."""
        if not self.healthy:
            return {
                "success": False,
                "indexed_count": 0,
                "failed_count": 0,
                "message": "RAG not available",
            }
        indexed = 0
        failed = 0
        errors: List[Dict[str, str]] = []
        for fpath, meta in files:
            if cancel_cb and cancel_cb():
                return {
                    "success": False,
                    "cancelled": True,
                    "indexed_count": indexed,
                    "failed_count": failed,
                    "errors": errors,
                    "message": f"Cancelled after {indexed} chunks",
                }
            try:
                docs = self._documents_for_file(fpath, dict(meta or {}))
                if docs:
                    indexed += self._write_documents(docs)
                else:
                    failed += 1
                    errors.append(
                        {
                            "file": os.path.basename(fpath),
                            "error": "no extractable text (empty/unsupported file)",
                        }
                    )
            except Exception as e:
                logger.error(f"index {fpath}: {e}")
                failed += 1
                errors.append(
                    {"file": os.path.basename(fpath), "error": f"{type(e).__name__}: {e}"}
                )
            if progress_cb:
                progress_cb(
                    {
                        "file": fpath,
                        "indexed_count": indexed,
                        "failed_count": failed,
                        "errors": errors,
                    }
                )
        msg = f"Indexed {indexed} chunks" + (f", {failed} file(s) failed" if failed else "")
        return {
            "success": True,
            "indexed_count": indexed,
            "failed_count": failed,
            "errors": errors,
            "message": msg,
        }

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
        errors: List[Dict[str, str]] = []
        try:
            for root, _, files in os.walk(directory):
                for fname in files:
                    if cancel_cb and cancel_cb():
                        return {
                            "success": False,
                            "cancelled": True,
                            "indexed_count": indexed,
                            "failed_count": failed,
                            "errors": errors,
                            "message": f"Cancelled after indexing {indexed} chunks from {directory}",
                        }
                    fpath = os.path.join(root, fname)
                    ext = Path(fname).suffix.lower()
                    if ext not in file_extensions:
                        continue
                    try:
                        meta = {
                            "source": fpath,
                            "filename": fname,
                            "directory": root,
                            "type": ext,
                        }
                        if owner:
                            meta["owner"] = owner
                        docs = self._documents_for_file(fpath, meta)
                        if docs:
                            indexed += self._write_documents(docs)
                    except Exception as e:
                        logger.error(f"index {fpath}: {e}")
                        failed += 1
                        errors.append({"file": fname, "error": f"{type(e).__name__}: {e}"})
                    if progress_cb:
                        progress_cb(
                            {
                                "file": fpath,
                                "indexed_count": indexed,
                                "failed_count": failed,
                                "errors": errors,
                            }
                        )

            msg = f"Indexed {indexed} chunks from {directory}" + (
                f", {failed} file(s) failed" if failed else ""
            )
            return {
                "success": True,
                "indexed_count": indexed,
                "failed_count": failed,
                "errors": errors,
                "message": msg,
            }
        except Exception as e:
            logger.error(f"index_personal_documents {directory}: {e}")
            return {
                "success": False,
                "indexed_count": indexed,
                "failed_count": failed,
                "errors": errors,
                "message": str(e),
            }

    # ------------------------------------------------------------------
    # Direct text indexing (kept for compatibility)
    # ------------------------------------------------------------------

    def add_document(self, text: str, metadata: Dict[str, Any]) -> bool:
        if not self.healthy or not text or not isinstance(text, str):
            return False
        if not metadata or not isinstance(metadata, dict):
            return False
        try:
            from haystack.dataclasses import Document

            self._write_documents([Document(content=text, meta=dict(metadata))])
            return True
        except Exception as e:
            logger.error(f"add_document failed: {e}")
            return False

    def add_documents_batch(self, docs: List[tuple]) -> Dict[str, Any]:
        if not self.healthy:
            return {"success": False, "message": "RAG not available"}
        if not docs:
            return {"success": False, "message": "Empty document list"}
        valid = [(t, m) for t, m in docs if t and isinstance(t, str) and m and isinstance(m, dict)]
        if not valid:
            return {"success": False, "message": "No valid documents"}
        try:
            from haystack.dataclasses import Document

            hs_docs = [Document(content=t, meta=dict(m)) for t, m in valid]
            added = self._write_documents(hs_docs)
            return {
                "success": True,
                "added_count": added,
                "total_count": len(docs),
                "failed_count": len(docs) - len(valid),
            }
        except Exception as e:
            logger.error(f"add_documents_batch failed: {e}")
            return {"success": False, "message": str(e)}

    # ------------------------------------------------------------------
    # Index management
    # ------------------------------------------------------------------

    def rebuild_index(self) -> bool:
        try:
            self._store = self._build_store(recreate=True)
            self._retriever = None
            self._healthy = True
            return True
        except Exception as e:
            logger.error(f"rebuild_index failed: {e}")
            self._healthy = False
            return False

    def get_stats(self) -> Dict[str, Any]:
        if not self.healthy:
            return {"error": "RAG not available"}
        try:
            count = self._store.count_documents()
            return {
                "document_count": count,
                "embedding_model": f"{os.getenv('EMBEDDING_MODEL', '')} @ {_embed_base_url()}",
                "persist_directory": self.persist_directory,
                "collection_name": COLLECTION_NAME,
                "vector_backend": self._backend,
                "sparse_model": self._sparse_model,
                "embedding_dim": self._dim,
                "rerank_enabled": bool(os.getenv("RERANK_URL", "").strip()),
                "rerank_model": os.getenv("RERANK_MODEL", ""),
                "last_rerank_error": self._last_rerank_error,
                "healthy": True,
            }
        except Exception as e:
            logger.error(f"get_stats failed: {e}")
            return {"error": str(e), "healthy": False}

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    def list_documents(
        self,
        scope: Optional[str] = None,
        exclude_scopes: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Aggregate indexed chunks by source file → one row per document.

        Reads straight from Qdrant (the source of truth) so the UI shows what is
        actually searchable, including dir-indexed files, not just uploads.
        ``scope``/``exclude_scopes`` keep the SQL knowledge namespace and the
        ordinary knowledge base listed separately.
        """
        if not self.healthy:
            return []
        try:
            _filters = self._build_filters(scope=scope, exclude_scopes=exclude_scopes)
            chunks = (
                self._store.filter_documents(filters=_filters)
                if _filters
                else self._store.filter_documents()
            )
            agg: Dict[str, Dict[str, Any]] = {}
            for d in chunks:
                meta = d.meta or {}
                source = meta.get("source") or meta.get("filename") or "unknown"
                row = agg.get(source)
                if row is None:
                    row = {
                        "source": source,
                        "filename": meta.get("filename") or os.path.basename(str(source)),
                        "type": meta.get("type") or "",
                        "directory": meta.get("directory") or "",
                        "chunks": 0,
                    }
                    agg[source] = row
                row["chunks"] += 1
            return sorted(agg.values(), key=lambda r: str(r["filename"]).lower())
        except Exception as e:
            logger.error(f"list_documents failed: {e}")
            return []

    # ------------------------------------------------------------------
    # Delete by metadata
    # ------------------------------------------------------------------

    def remove_directory(self, directory: str) -> Dict[str, Any]:
        """Remove all chunks under ``directory`` (recursively) by a path-boundary
        match on each chunk's stored ``source`` — never a bare substring, so
        removing ``/docs`` won't touch ``/docs2`` or ``/docs_personal``."""
        if not self.healthy:
            return {"success": False, "message": "RAG not available"}
        directory = os.path.abspath(directory)
        try:
            all_docs = self._store.filter_documents()
            ids = [
                d.id
                for d in all_docs
                if isinstance((d.meta or {}).get("source"), str)
                and (
                    d.meta["source"] == directory or d.meta["source"].startswith(directory + os.sep)
                )
            ]
            if ids:
                self._store.delete_documents(ids)
            return {
                "success": True,
                "removed_count": len(ids),
                "message": f"Removed {len(ids)} chunks",
            }
        except Exception as e:
            logger.error(f"remove_directory {directory}: {e}")
            return {"success": False, "message": str(e)}

    def delete_by_source(self, source: str) -> int:
        """Remove all chunks whose metadata['source'] equals *source*."""
        if not self.healthy:
            return 0
        try:
            docs = self._store.filter_documents(
                filters={"field": "meta.source", "operator": "==", "value": source}
            )
            ids = [d.id for d in docs]
            if ids:
                self._store.delete_documents(ids)
            return len(ids)
        except Exception as e:
            logger.error(f"delete_by_source failed: {e}")
            return 0

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
    # Convenience
    # ------------------------------------------------------------------

    def retrieve(self, query: str, k: int = 5) -> List[str]:
        return [r["document"] for r in self.search(query, k)]
