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

import hashlib
import logging
import os
import re
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
    # Audio/video (only indexed when the ASR lane is enabled; otherwise each is
    # reported as a skipped file — see ``_lane_av``).
    ".mp4",
    ".mov",
    ".mkv",
    ".webm",
    ".avi",
    ".m4v",
    ".mp3",
    ".wav",
    ".m4a",
    ".flac",
    ".aac",
    ".ogg",
}

COLLECTION_NAME = "talos_rag"
# Separate collection for true pixel embeddings (Phase 5). Kept apart from the
# text collection because VL image vectors live in a different space/dimension.
VISUAL_COLLECTION_NAME = "talos_rag_visual"
_DEFAULT_SPARSE_MODEL = "Qdrant/bm25"

# Image extensions eligible for the opt-in pixel-embedding lane (see
# ``_image_active``). These already go through Docling OCR for the text spur;
# pixel embedding is *additive* on top of that.
_IMAGE_EXTS: Set[str] = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}

# Code extension → tree-sitter language name for the opt-in AST code lane (see
# ``_code_active`` / ``_lane_code``). Without the lane these still index fine via
# the plain length splitter.
_CODE_LANGS: Dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
}

# tree-sitter node types that represent a "definition" worth being its own chunk,
# unioned across languages (the type strings are language-specific so a single
# set is safe — only the relevant ones ever match for a given grammar).
_DEF_NODE_TYPES: Set[str] = {
    "function_definition",
    "class_definition",
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "method_definition",
    "method_declaration",
    "constructor_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "type_declaration",
    "struct_declaration",
    "struct_specifier",
    "class_specifier",
    "function_item",
    "struct_item",
    "impl_item",
    "trait_item",
    "enum_item",
    "method",
    "module",
}

_NAME_NODE_TYPES = {
    "identifier",
    "name",
    "type_identifier",
    "field_identifier",
    "property_identifier",
    "constant",
}

_IMPORT_RE = re.compile(
    r"^\s*(?:import\s+.+|from\s+\S+\s+import\s+.+|#include\s+.+|use\s+.+;|using\s+.+;)",
    re.MULTILINE,
)

# Audio/video extensions routed to the opt-in ASR lane (see ``_asr_active``).
# Module-level so the router and the dir-ingest accepted-extension set agree.
_AV_EXTS: Set[str] = {
    ".mp4",
    ".mov",
    ".mkv",
    ".webm",
    ".avi",
    ".m4v",
    ".mp3",
    ".wav",
    ".m4a",
    ".flac",
    ".aac",
    ".ogg",
}


def _asr_active() -> bool:
    """True only when the ASR lane is explicitly enabled *and* an endpoint is set.

    Default deployments leave this off, so audio/video files are rejected with a
    clear message and the embedding/reranker pipeline is completely unchanged —
    "just embedding + reranker like before".
    """
    return bool(os.getenv("VIDEO_ASR_ENABLED", "").strip()) and bool(
        os.getenv("VIDEO_ASR_URL", "").strip()
    )


def _asr_correct_active() -> bool:
    """True when LLM transcript cleanup is enabled *and* an ingest LLM is set.

    Opt-in: after ASR, the transcript is passed to the LLM to fix recognition
    errors and restore English technical terms (which a German-biased ASR
    mistranscribes). Off by default — adds one LLM call per chunk."""
    return bool(os.getenv("VIDEO_ASR_CORRECT_ENABLED", "").strip()) and bool(
        os.getenv("RAG_LLM_URL", "").strip()
    )


def _asr_language_code(language: str) -> str:
    lang = (language or "").strip().lower()
    return {
        "german": "de",
        "deutsch": "de",
        "de": "de",
        "english": "en",
        "englisch": "en",
        "en": "en",
    }.get(lang, lang)


def _asr_segments(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    segments = []
    for seg in payload.get("segments") or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start": float(seg.get("start") or 0),
                "end": float(seg.get("end") or 0),
                "text": text,
            }
        )
    if not segments and (payload.get("text") or "").strip():
        segments.append({"start": 0.0, "end": 0.0, "text": payload["text"].strip()})
    return segments


def _image_active() -> bool:
    """True only when pixel image embedding is explicitly enabled *and* a VL
    embedding endpoint is configured.

    Off by default: images still get indexed via the Docling OCR/text spur, so
    nothing about the existing pipeline changes. When on, the image's *pixels*
    are additionally embedded into a separate visual collection (Plan B).
    """
    return bool(os.getenv("IMAGE_PIXEL_ENABLED", "").strip()) and bool(
        os.getenv("IMAGE_EMBED_URL", "").strip()
    )


def _code_active() -> bool:
    """True when the AST code lane is enabled. No external endpoint — it needs
    only the optional ``tree-sitter-language-pack``; if that's missing the lane
    degrades to the plain length splitter, so this stays safe to turn on."""
    return bool(os.getenv("CODE_LANE_ENABLED", "").strip())


def _contextual_active() -> bool:
    """True when ingest-time Contextual Retrieval is enabled *and* an ingest LLM
    endpoint is configured. Off by default — a heavier, slower ingest (one LLM
    call per chunk), so it's strictly opt-in."""
    return bool(os.getenv("CONTEXTUAL_RETRIEVAL_ENABLED", "").strip()) and bool(
        os.getenv("RAG_LLM_URL", "").strip()
    )


def _env_int(name: str) -> int:
    try:
        return int(os.getenv(name, "0") or 0)
    except Exception:
        return 0


def _autokw_active() -> bool:
    """True when auto keyword/question generation is on (either count > 0) *and*
    an ingest LLM endpoint is configured. Off by default."""
    if not os.getenv("RAG_LLM_URL", "").strip():
        return False
    return _env_int("RAG_AUTO_KEYWORDS_N") > 0 or _env_int("RAG_AUTO_QUESTIONS_N") > 0


def _expand_active() -> bool:
    """True when small-to-big parent expansion is enabled. No endpoint needed —
    it just re-reads sibling chunks from Qdrant at retrieval time."""
    return bool(os.getenv("EXPAND_TO_PARENT_ENABLED", "").strip())


def _pdf_vlm_active() -> bool:
    """True when VLM transcription is enabled *and* a vision endpoint is
    configured. Off by default — it's a heavier ingest (one VLM call per page or
    embedded image), so strictly opt-in. When on, image-bearing documents
    (slide decks, screenshots, figures) are read by a vision model instead of
    relying on Docling OCR alone."""
    return bool(os.getenv("PDF_VLM_ENABLED", "").strip()) and bool(
        os.getenv("VLM_URL", "").strip()
    )


# Document formats eligible for the VLM lane. PDFs are page-rendered; Office
# files keep Docling's text and get their *embedded* images VLM-captioned.
_VLM_DOC_EXTS: Set[str] = {".pdf", ".docx", ".pptx"}

# Raster image members inside an Office (OOXML) zip we can hand to the VLM.
# Vector formats (.emf/.wmf) are skipped — the VLM needs raster pixels.
_OOXML_IMG_EXTS: Tuple[str, ...] = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".webp",
)


def _file_has_images(path: str) -> bool:
    """Best-effort: does this document actually contain images worth a VLM pass?

    Lets the lane auto-select — a text-only PDF/Word stays on the fast Docling
    path; only files with embedded images (slide decks, screenshots, figures)
    pay for vision. PDFs: scan page objects for an image. Office (docx/pptx):
    look for raster members under ``*/media/``. On any error, assume True for
    PDFs (preserve the prior "VLM all PDFs" behavior) and False otherwise.
    """
    ext = Path(path).suffix.lower()
    try:
        if ext == ".pdf":
            import pypdfium2 as pdfium
            import pypdfium2.raw as pdfium_c

            pdf = pdfium.PdfDocument(path)
            try:
                for i in range(len(pdf)):
                    page = pdf[i]
                    for obj in page.get_objects():
                        if getattr(obj, "type", None) == pdfium_c.FPDF_PAGEOBJ_IMAGE:
                            return True
                return False
            finally:
                try:
                    pdf.close()
                except Exception:
                    pass
        if ext in (".docx", ".pptx", ".xlsx"):
            import zipfile

            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    low = name.lower()
                    if "/media/" in low and low.endswith(_OOXML_IMG_EXTS):
                        return True
            return False
    except Exception as e:
        logger.warning("image detection failed for %s: %s", path, e)
        return ext == ".pdf"
    return False


def _vlm_concurrency() -> int:
    """How many VLM/ingest-LLM calls to run in parallel. Defaults to 4 to match a
    typical vLLM ``--max-num-seqs 4``; raise it (env) if the server allows more."""
    try:
        return max(1, min(int(os.getenv("RAG_INGEST_CONCURRENCY", "4") or 4), 16))
    except Exception:
        return 4


def _docling_threads() -> int:
    """CPU threads Docling's layout/OCR/table models may use.

    Docling's ``AcceleratorOptions`` defaults to just 4 threads regardless of how
    many cores the worker container has, so a CPU-only ingest leaves most of the
    box idle. Default to every available core (override with ``RAG_DOCLING_THREADS``).
    Purely a throughput knob — the models and their output are unchanged, so the
    extracted text/tables/OCR are byte-for-byte identical, just produced faster.
    """
    try:
        env = os.getenv("RAG_DOCLING_THREADS", "").strip()
        n = int(env) if env else (os.cpu_count() or 4)
        return max(1, n)
    except Exception:
        return os.cpu_count() or 4


def _docling_pdf_options(**overrides):
    """Shared ``PdfPipelineOptions`` with the accelerator pinned to all cores.

    Keeps every extraction default (OCR on, table structure on, same engines/
    models) so results don't change — only the thread budget is raised. Extra
    kwargs let the figure converter add its image-generation flags on top.
    """
    from docling.datamodel.pipeline_options import AcceleratorOptions, PdfPipelineOptions

    opts = PdfPipelineOptions()
    try:
        from docling.datamodel.pipeline_options import AcceleratorDevice

        device = AcceleratorDevice.CPU
    except Exception:
        device = "cpu"
    opts.accelerator_options = AcceleratorOptions(num_threads=_docling_threads(), device=device)
    for key, value in overrides.items():
        setattr(opts, key, value)
    return opts


def _concurrent_map(fn, items: List[Any], concurrency: int, on_done=None) -> List[Any]:
    """Map ``fn`` over ``items`` with a bounded thread pool, preserving order.

    Used to fan out the per-page / per-chunk LLM calls at ingest (all blocking
    httpx POSTs, so threads give real speedup). ``on_done(n_completed)`` fires
    after each item finishes for progress. A failing item yields ``None`` so one
    bad page/chunk never sinks the batch.
    """
    items = list(items)
    results: List[Any] = [None] * len(items)
    if not items:
        return results
    from concurrent.futures import ThreadPoolExecutor, as_completed

    workers = max(1, min(concurrency, len(items)))
    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): i for i, it in enumerate(items)}
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                results[i] = fut.result()
            except Exception as e:
                logger.warning("ingest concurrent task %s failed: %s", i, e)
                results[i] = None
            completed += 1
            if on_done:
                try:
                    on_done(completed)
                except Exception:
                    pass
    return results


_SECTION_WINDOW = 3  # chunks per fallback "section" when no heading info exists


def _section_key(meta: Dict[str, Any], index: int) -> str:
    """Group key for a chunk: its Docling heading path when available, else a
    sliding window over the chunk order (so neighbours share a parent)."""
    dl = meta.get("dl_meta") if isinstance(meta.get("dl_meta"), dict) else None
    headings = (dl or {}).get("headings")
    if isinstance(headings, (list, tuple)) and any(headings):
        return " / ".join(str(h) for h in headings if h)
    return f"win{index // _SECTION_WINDOW}"


def _prefix_context(context: str, content: str) -> str:
    """The text actually embedded when a chunk has a situating context: context
    then the original chunk. No-op when there's no context."""
    context = (context or "").strip()
    return f"{context}\n\n{content}" if context else content


def _embed_text(meta: Dict[str, Any], content: str) -> str:
    """The text actually embedded for a chunk: a situating ``context`` prefix
    (Phase 8) + the original content + auto ``aux_terms`` suffix (Phase 9). The
    original ``content`` is what gets stored/displayed/cited — only the embedding
    sees these enrichments."""
    text = _prefix_context((meta or {}).get("context") or "", content)
    aux = ((meta or {}).get("aux_terms") or "").strip()
    return f"{text}\n\n{aux}" if aux else text


# Content-hash → blurb cache so re-ingesting unchanged chunks never re-pays the
# LLM. In-process memo backed by Redis (shared across worker forks/restarts when
# REDIS_URL is set); both layers degrade silently if unavailable.
_CONTEXT_CACHE: Dict[str, str] = {}


def _ctx_redis():
    try:
        url = os.getenv("REDIS_URL", "").strip()
        if not url:
            return None
        from redis import Redis

        return Redis.from_url(url)
    except Exception:
        return None


def _ctx_cache_get(h: str) -> Optional[str]:
    if h in _CONTEXT_CACHE:
        return _CONTEXT_CACHE[h]
    try:
        r = _ctx_redis()
        if r is not None:
            v = r.get(f"rag:ctx:{h}")
            if v is not None:
                val = v.decode("utf-8", "replace")
                _CONTEXT_CACHE[h] = val
                return val
    except Exception:
        pass
    return None


def _ctx_cache_set(h: str, blurb: str) -> None:
    _CONTEXT_CACHE[h] = blurb
    try:
        r = _ctx_redis()
        if r is not None:
            r.set(f"rag:ctx:{h}", blurb)
    except Exception:
        pass


def _node_symbol(node, src: bytes) -> str:
    """Best-effort symbol name for a tree-sitter definition node."""
    for child in node.children:
        if child.type in _NAME_NODE_TYPES:
            return src[child.start_byte : child.end_byte].decode("utf-8", "replace")
    return ""


def _code_chunks(source: str, language: str):
    """AST-chunk source into ``[(text, symbol), …]`` by function/class/etc.

    Returns ``None`` when tree-sitter or the grammar is unavailable (caller falls
    back to the length splitter), or a list otherwise (possibly empty when the
    file has no top-level definitions). Matched definitions aren't recursed into,
    so a class is one chunk that includes its methods.
    """
    try:
        from tree_sitter_language_pack import get_parser
    except Exception:
        return None
    try:
        parser = get_parser(language)
        tree = parser.parse(source.encode("utf-8"))
    except Exception:
        return None
    src = source.encode("utf-8")
    chunks: List[Tuple[str, str]] = []

    def visit(node):
        for child in node.children:
            if child.type in _DEF_NODE_TYPES:
                text = src[child.start_byte : child.end_byte].decode("utf-8", "replace")
                chunks.append((text, _node_symbol(child, src)))
            else:
                visit(child)

    visit(tree.root_node)
    return chunks


def _extract_imports(source: str) -> List[str]:
    """Best-effort, language-agnostic import lines (for chunk metadata)."""
    return [m.group(0).strip() for m in _IMPORT_RE.finditer(source)][:50]


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
        "video_asr_url": "VIDEO_ASR_URL",
        "video_asr_language": "VIDEO_ASR_LANGUAGE",
        "video_asr_prompt": "VIDEO_ASR_PROMPT",
        "image_embed_url": "IMAGE_EMBED_URL",
        "image_embed_model": "IMAGE_EMBED_MODEL",
        # Ingest-time LLM (Contextual Retrieval and other ingest enrichment).
        "llm_url": "RAG_LLM_URL",
        "llm_model": "RAG_LLM_MODEL",
        # Per-page VLM transcription endpoint (image-heavy PDFs).
        "vlm_url": "VLM_URL",
        "vlm_model": "VLM_MODEL",
    }
    for key, env_name in mapping.items():
        value = str(cfg.get(key) or "").strip()
        if value:
            os.environ[env_name] = value
    # Boolean toggles set explicitly (not via the truthy-skip loop) so turning
    # one back off actually clears the env in a long-lived app process.
    os.environ["VIDEO_ASR_ENABLED"] = "true" if cfg.get("video_asr_enabled") else ""
    os.environ["VIDEO_ASR_CORRECT_ENABLED"] = "true" if cfg.get("video_asr_correct_enabled") else ""
    os.environ["IMAGE_PIXEL_ENABLED"] = "true" if cfg.get("image_pixel_enabled") else ""
    os.environ["CODE_LANE_ENABLED"] = "true" if cfg.get("code_lane_enabled") else ""
    os.environ["CONTEXTUAL_RETRIEVAL_ENABLED"] = (
        "true" if cfg.get("contextual_retrieval_enabled") else ""
    )
    # Integer counts set explicitly so 0 clears a previously-set value.
    os.environ["RAG_AUTO_KEYWORDS_N"] = str(int(cfg.get("auto_keywords_n") or 0))
    os.environ["RAG_AUTO_QUESTIONS_N"] = str(int(cfg.get("auto_questions_n") or 0))
    os.environ["EXPAND_TO_PARENT_ENABLED"] = "true" if cfg.get("expand_to_parent_enabled") else ""
    os.environ["RAG_PARENT_MAX_CHARS"] = str(int(cfg.get("parent_max_chars") or 0))
    os.environ["PDF_VLM_ENABLED"] = "true" if cfg.get("pdf_vlm_enabled") else ""


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

    def __init__(self, persist_directory: str = "data/rag", recreate_index: bool = False):
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
        self._fig_converter = None
        self._splitter = None
        # Pixel-embedding lane (Phase 5): a raw qdrant-client for the separate
        # visual collection. Built lazily, only when the lane is enabled.
        self._visual_client = None
        self._visual_dim: Optional[int] = None

        Path(self.persist_directory).mkdir(parents=True, exist_ok=True)
        self._initialize_system(recreate_index=recreate_index)

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def _initialize_system(self, recreate_index: bool = False) -> bool:
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
                    self._store = self._build_store(recreate=recreate_index)
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
            # Pixel lane (Phase 5): when enabled, fan out to the visual collection
            # and let the cross-encoder reranker merge image hits with text hits.
            # Inert (returns []) when the lane is off — text retrieval unchanged.
            if _image_active():
                candidates.extend(self._visual_search(query, fetch_k))
            top = self._rerank(query, candidates, k)
            # Small-to-big (Phase 10): attach each hit's surrounding section for
            # injection (citations still point at the matched chunk). No-op off.
            top = self._expand_to_parent(top)
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

        # Ingest enrichment (Phases 8 & 9): embed dense+sparse on the enriched
        # text (situating context prefix + auto keywords/questions suffix), but
        # store/display the ORIGINAL chunk. Swap content in before embedding and
        # restore it after, so citations stay verbatim.
        for d in docs:
            enriched = _embed_text(d.meta or {}, d.content)
            if enriched != d.content:
                d.meta["_ctx_orig"] = d.content
                d.content = enriched
        docs = self._dense_doc_embedder().run(documents=docs)["documents"]
        docs = self._sparse_doc_embedder().run(documents=docs)["documents"]
        for d in docs:
            if d.meta and "_ctx_orig" in d.meta:
                d.content = d.meta.pop("_ctx_orig")
        self._store.write_documents(docs, policy=DuplicatePolicy.OVERWRITE)
        return len(docs)

    def _contextual_blurb(self, full_doc: str, chunk: str) -> str:
        """Ask the ingest LLM for a 1–2 sentence context situating ``chunk``
        within ``full_doc``. Best-effort: returns "" on any error/misconfig so
        ingest never blocks on it."""
        url = os.getenv("RAG_LLM_URL", "").strip()
        if not url:
            return ""
        try:
            import httpx

            model = os.getenv("RAG_LLM_MODEL", "").strip()
            sys_prompt = (
                "Give a short 1–2 sentence context that situates the chunk within the "
                "document, to improve search retrieval. Output ONLY the context."
            )
            user_prompt = (
                f"<document>\n{full_doc[:6000]}\n</document>\n\n"
                f"<chunk>\n{chunk[:1500]}\n</chunk>\n\nContext:"
            )
            payload: Dict[str, Any] = {
                "messages": [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.0,
                "max_tokens": 120,
                # No chain-of-thought needed for a one-line blurb — skip it on
                # Qwen3/vLLM so each per-chunk call is faster. Ignored by servers
                # that don't support the flag.
                "chat_template_kwargs": {"enable_thinking": False},
            }
            if model:
                payload["model"] = model
            headers = {}
            if os.getenv("RAG_LLM_API_KEY"):
                headers["Authorization"] = f"Bearer {os.getenv('RAG_LLM_API_KEY')}"
            resp = httpx.post(url, json=payload, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            return (data["choices"][0]["message"]["content"] or "").strip()
        except Exception as e:
            logger.warning("contextual blurb failed: %s", e)
            return ""

    def _apply_contextual(self, docs) -> None:
        """Stash a situating ``context`` blurb in each chunk's meta (used by
        ``_write_documents`` to enrich the embedding). Cached by content hash so
        re-ingesting unchanged chunks makes zero LLM calls. No-op when off."""
        if not _contextual_active() or not docs:
            return
        full = "\n\n".join((d.content or "") for d in docs)[:8000]

        def _one(d):
            chunk = d.content or ""
            if not chunk.strip():
                return
            h = hashlib.sha256(("ctx-v1\x00" + chunk).encode("utf-8")).hexdigest()
            blurb = _ctx_cache_get(h)
            if blurb is None:
                blurb = self._contextual_blurb(full, chunk)
                _ctx_cache_set(h, blurb)
            if blurb:
                d.meta["context"] = blurb

        # One LLM call per chunk — fan out so a multi-chunk doc isn't serialized.
        _concurrent_map(_one, docs, _vlm_concurrency())

    def _auto_terms(self, chunk: str) -> str:
        """Ask the ingest LLM for keywords/synonyms and likely questions for a
        chunk (RagFlow-style recall boost). Best-effort: "" on error."""
        url = os.getenv("RAG_LLM_URL", "").strip()
        if not url:
            return ""
        nk = _env_int("RAG_AUTO_KEYWORDS_N")
        nq = _env_int("RAG_AUTO_QUESTIONS_N")
        try:
            import httpx

            wants = []
            if nk > 0:
                wants.append(f"{nk} keywords or synonyms")
            if nq > 0:
                wants.append(f"{nq} likely user questions this chunk answers")
            sys_prompt = (
                f"From the chunk, produce {' and '.join(wants)} to improve search recall. "
                "Output them one per line, no numbering, no preamble."
            )
            payload: Dict[str, Any] = {
                "messages": [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": f"<chunk>\n{chunk[:1500]}\n</chunk>"},
                ],
                "temperature": 0.0,
                "max_tokens": 220,
                # Keyword/question generation needs no reasoning pass — skip it.
                "chat_template_kwargs": {"enable_thinking": False},
            }
            model = os.getenv("RAG_LLM_MODEL", "").strip()
            if model:
                payload["model"] = model
            headers = {}
            if os.getenv("RAG_LLM_API_KEY"):
                headers["Authorization"] = f"Bearer {os.getenv('RAG_LLM_API_KEY')}"
            resp = httpx.post(url, json=payload, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            return (data["choices"][0]["message"]["content"] or "").strip()
        except Exception as e:
            logger.warning("auto-keywords failed: %s", e)
            return ""

    def _apply_autokeywords(self, docs) -> None:
        """Stash auto keywords/questions in each chunk's meta ``aux_terms`` (used
        by ``_write_documents`` for the embedding only — never shown in the
        citation snippet). Cached by content hash + the configured counts."""
        if not _autokw_active() or not docs:
            return
        tag = (
            f"akw-v1\x00{_env_int('RAG_AUTO_KEYWORDS_N')}\x00{_env_int('RAG_AUTO_QUESTIONS_N')}\x00"
        )

        def _one(d):
            chunk = d.content or ""
            if not chunk.strip():
                return
            h = hashlib.sha256((tag + chunk).encode("utf-8")).hexdigest()
            terms = _ctx_cache_get(h)
            if terms is None:
                terms = self._auto_terms(chunk)
                _ctx_cache_set(h, terms)
            if terms:
                d.meta["aux_terms"] = terms

        # One LLM call per chunk — fan out so a multi-chunk doc isn't serialized.
        _concurrent_map(_one, docs, _vlm_concurrency())

    def _assign_sections(self, docs) -> None:
        """Tag each chunk with ``seq`` (order in the doc) and a ``section_id``
        shared by its siblings, so retrieval can expand a small matched chunk to
        its surrounding section (Phase 10). Always runs (cheap metadata) so the
        expansion toggle works without a re-index discipline beyond this build."""
        if not docs:
            return
        source = str((docs[0].meta or {}).get("source") or "")
        for i, d in enumerate(docs):
            d.meta["seq"] = i
            key = _section_key(d.meta or {}, i)
            d.meta["section_id"] = hashlib.sha256(f"{source}\x00{key}".encode("utf-8")).hexdigest()[
                :16
            ]

    def _expand_to_parent(self, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Small-to-big: for each hit, attach an ``expanded`` field holding its
        whole section (sibling chunks with the same ``section_id``, in ``seq``
        order, capped). The matched chunk stays the citation; only the *injected*
        context grows. No-op (no ``expanded`` key) when disabled."""
        if not _expand_active() or not results or self._store is None:
            return results
        cap = _env_int("RAG_PARENT_MAX_CHARS") or 2000
        section_cache: Dict[Tuple[str, str], str] = {}
        for r in results:
            meta = r.get("metadata") or {}
            sid = meta.get("section_id")
            src = meta.get("source")
            if not sid or not src:
                continue
            ck = (str(src), str(sid))
            text = section_cache.get(ck)
            if text is None:
                try:
                    sibs = self._store.filter_documents(
                        filters={
                            "operator": "AND",
                            "conditions": [
                                {"field": "meta.source", "operator": "==", "value": src},
                                {"field": "meta.section_id", "operator": "==", "value": sid},
                            ],
                        }
                    )
                    sibs = sorted(sibs, key=lambda d: (d.meta or {}).get("seq", 0))
                    text = "\n\n".join((d.content or "") for d in sibs)
                except Exception as e:
                    logger.warning("parent expansion failed: %s", e)
                    text = ""
                section_cache[ck] = text
            if text:
                r["expanded"] = text[:cap]
        return results

    def _documents_for_file(self, path: str, meta: Dict[str, Any], stage_cb=None):
        """Route a file to its modality lane → Haystack Documents with metadata.

        The single ingest chokepoint for both UI uploads and dir/API ingest. A
        small dispatch keeps each modality's handling isolated and testable:
          * audio/video → ``_lane_av`` (opt-in ASR; rejects when disabled)
          * image-bearing PDF/Office (VLM lane on) → ``_lane_pdf_vlm`` /
            ``_lane_office_vlm`` (vision transcription; auto-selected only when
            the file actually has images)
          * rich docs/images → ``_lane_docling`` (layout-aware HybridChunk)
          * plain text/code/json → ``_lane_text`` (length splitter)

        ``stage_cb(done, total)`` is forwarded to the slow VLM lanes so the queue
        can show per-page/per-image progress instead of just 0%→done.
        """
        from src.docling_runtime import is_docling_format

        ext = Path(path).suffix.lower()
        if ext in _AV_EXTS:
            docs = self._lane_av(path, meta, stage_cb=stage_cb)
        elif _code_active() and ext in _CODE_LANGS:
            docs = self._lane_code(path, _CODE_LANGS[ext])
        elif _pdf_vlm_active() and ext in _VLM_DOC_EXTS and _file_has_images(path):
            docs = (
                self._lane_pdf_vlm(path, meta, stage_cb=stage_cb)
                if ext == ".pdf"
                else self._lane_office_vlm(path, meta, stage_cb=stage_cb)
            )
        elif is_docling_format(path):
            docs = self._lane_docling(path)
        else:
            docs = self._lane_text(path)

        # Caller metadata (source/filename/owner/scope …) is layered on top; the
        # lane only owns keys the caller doesn't set (e.g. start/end/modality),
        # which ``update`` preserves because they're absent from ``meta``.
        for d in docs:
            d.meta.update(meta)

        # Pixel lane (Phase 5): for images, ADDITIONALLY embed the pixels into
        # the visual collection — on top of the OCR/text docs above, not instead.
        # Uses the OCR text as the visual point's caption. No-op unless enabled.
        if ext in _IMAGE_EXTS and _image_active():
            caption = " ".join((d.content or "") for d in docs)[:2000]
            self._write_image_pixel(path, meta, caption)

        # Parent/child sections (Phase 10): tag seq + section_id so retrieval can
        # expand a small chunk to its surrounding section. Always on (metadata).
        self._assign_sections(docs)
        # Contextual Retrieval (Phase 8): tag each chunk with a situating blurb
        # (used at embed time, original text preserved). No-op unless enabled.
        self._apply_contextual(docs)
        # Auto keywords/questions (Phase 9): tag each chunk with extra search
        # terms (embed-only, not shown in citations). No-op unless enabled.
        self._apply_autokeywords(docs)
        return docs

    def _vlm_chat_url(self) -> str:
        """Normalize VLM_URL to an OpenAI ``/v1/chat/completions`` endpoint.

        The UI may store a base (``…/v1``) or a full chat URL; accept either."""
        url = os.getenv("VLM_URL", "").strip().rstrip("/")
        if not url:
            return ""
        if url.endswith("/chat/completions"):
            return url
        if url.endswith("/v1"):
            return url + "/chat/completions"
        return url + "/v1/chat/completions"

    # Default prompts for the two VLM modes: a whole rendered page vs. a single
    # image extracted from a document.
    _VLM_PAGE_PROMPT = (
        "Transcribe this document page into clean GitHub-flavored Markdown. "
        "Include ALL visible text and reproduce tables as Markdown tables. For "
        "screenshots, diagrams, charts or UI, add a concise description of what "
        "they show so the content is searchable. Ignore repeated logos and "
        "watermarks. Output only the Markdown, no preamble."
    )
    _VLM_IMAGE_PROMPT = (
        "Describe this image for search. Transcribe any text verbatim, and for "
        "screenshots, charts, diagrams or UI explain what they show and the data "
        "they contain. Ignore logos and watermarks. Output only the description."
    )

    def _vlm_transcribe_image(self, b64_png: str, prompt: Optional[str] = None) -> str:
        """Ask the vision model to transcribe/describe one image (Markdown).

        Reasoning is disabled (``enable_thinking=false``) so the whole budget
        goes to the transcript, not a chain-of-thought. Best-effort: returns ""
        on any error so a single bad page/image never fails the whole document.
        """
        import httpx

        url = self._vlm_chat_url()
        if not url:
            return ""
        model = os.getenv("VLM_MODEL", "").strip()
        prompt = prompt or self._VLM_PAGE_PROMPT
        payload: Dict[str, Any] = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{b64_png}"},
                        },
                    ],
                }
            ],
            "temperature": 0.0,
            "max_tokens": int(os.getenv("PDF_VLM_MAX_TOKENS", "3000") or 3000),
            # vLLM/Qwen3: skip the reasoning pass for a transcription task.
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if model:
            payload["model"] = model
        headers = {}
        if os.getenv("VLM_API_KEY"):
            headers["Authorization"] = f"Bearer {os.getenv('VLM_API_KEY')}"
        resp = httpx.post(url, json=payload, headers=headers, timeout=180)
        resp.raise_for_status()
        data = resp.json()
        msg = (data.get("choices") or [{}])[0].get("message") or {}
        # With thinking off the transcript is in ``content``; fall back to
        # ``reasoning`` only if a build still routed it there.
        return (msg.get("content") or msg.get("reasoning") or "").strip()

    def _lane_pdf_vlm(self, path: str, meta: Dict[str, Any], stage_cb=None):
        """RagFlow-style *selective* vision for PDFs.

        Docling supplies the cheap text/table layer (no LLM). A vision model is
        applied ONLY to image-dominant pages — measured by image-object area
        coverage (``PDF_VLM_PAGE_RATIO``, default 0.35) — so text pages cost
        nothing extra and slide/screenshot pages get fully read:
          * "mostly image" docs (≥ ``PDF_VLM_DOC_RATIO`` of pages image-heavy,
            e.g. a screenshot deck) → every page rendered + VLM-transcribed
            (Docling's OCR of screenshots is just noise), concurrently;
          * mixed docs → Docling text for the whole file PLUS a VLM transcription
            of only the image-heavy pages;
          * no image-heavy page → pure Docling text, zero VLM calls.
        ``stage_cb(done, total)`` reports progress over the rendered pages.
        Renders with pypdfium2 (a Docling dep, no system libs); degrades to
        ``_lane_docling`` on any failure so the lane never regresses.
        """
        try:
            import base64
            import io

            import pypdfium2 as pdfium
            import pypdfium2.raw as pdfium_c
        except Exception as e:
            logger.warning("pdf-vlm: pypdfium2 unavailable (%s); using Docling", e)
            return self._lane_docling(path)

        from haystack.dataclasses import Document

        def _fenv(name: str, default: float) -> float:
            try:
                return float(os.getenv(name, str(default)) or default)
            except Exception:
                return default

        page_thr = _fenv("PDF_VLM_PAGE_RATIO", 0.35)
        doc_thr = _fenv("PDF_VLM_DOC_RATIO", 0.5)

        try:
            pdf = pdfium.PdfDocument(path)
        except Exception as e:
            logger.warning("pdf-vlm: cannot open %s (%s); using Docling", path, e)
            return self._lane_docling(path)

        rendered: Dict[int, str] = {}
        n_pages = 0
        try:
            n_pages = len(pdf)
            # First pass: which pages are image-dominant? (cheap, no rendering)
            heavy: List[int] = []
            for i in range(n_pages):
                page = pdf[i]
                w, h = page.get_size()
                page_area = (w * h) or 1.0
                img_area = 0.0
                try:
                    for obj in page.get_objects():
                        if getattr(obj, "type", None) == pdfium_c.FPDF_PAGEOBJ_IMAGE:
                            try:
                                left, bottom, right, top = obj.get_pos()
                                img_area += abs((right - left) * (top - bottom))
                            except Exception:
                                img_area += page_area  # unknown extent → assume full
                except Exception:
                    img_area = page_area  # can't introspect → treat as image page
                if min(img_area / page_area, 1.0) >= page_thr:
                    heavy.append(i)

            mostly_image = n_pages > 0 and (len(heavy) / n_pages) >= doc_thr
            to_render = list(range(n_pages)) if mostly_image else heavy

            # Second pass: render the chosen pages serially (pypdfium2 isn't
            # thread-safe), capped to ~1500px on the long side.
            for i in to_render:
                page = pdf[i]
                w, h = page.get_size()
                scale = min(1500.0 / max(w, h), 3.0) if max(w, h) else 2.0
                bitmap = page.render(scale=max(scale, 1.0))
                buf = io.BytesIO()
                bitmap.to_pil().convert("RGB").save(buf, format="PNG")
                rendered[i] = base64.b64encode(buf.getvalue()).decode()
        finally:
            try:
                pdf.close()
            except Exception:
                pass

        idxs = list(rendered.keys())
        on_done = (lambda c: stage_cb(c, len(idxs))) if (stage_cb and idxs) else None
        # Fan the network-bound VLM calls out concurrently.
        texts = _concurrent_map(
            self._vlm_transcribe_image, [rendered[i] for i in idxs], _vlm_concurrency(), on_done=on_done
        )
        vlm_docs = [
            Document(content=t, meta={"modality": "pdf_page", "page": idxs[k] + 1, "pages": n_pages})
            for k, t in enumerate(texts)
            if t
        ]

        if len(idxs) == n_pages and n_pages > 0:
            # Whole-doc vision (screenshot deck): VLM replaces Docling's OCR noise.
            docs = vlm_docs or list(self._lane_docling(path))
        else:
            # Mixed/text doc: cheap Docling text + vision only on the image pages.
            docs = list(self._lane_docling(path)) + vlm_docs

        if not docs:
            logger.warning("pdf-vlm: nothing extracted for %s; using Docling", path)
            return self._lane_docling(path)
        logger.info(
            "pdf-vlm: %s/%s page(s) sent to vision for %s",
            len(idxs),
            n_pages,
            os.path.basename(path),
        )
        # Figure lane: additionally crop each embedded figure to a servable asset
        # so the model can *show* it inline (not just describe it). Additive and
        # best-effort — a failure here never loses the text/page transcription.
        try:
            docs.extend(self._extract_pdf_figures(path, meta, stage_cb=stage_cb))
        except Exception as e:
            logger.warning("pdf-figures: extraction failed for %s: %s", path, e)
        return docs

    # Figures small enough to be icons/bullets/rule-lines aren't worth showing.
    _FIG_MIN_PX = 96

    def _figures_dir(self) -> str:
        """Directory for extracted figure crops, under the managed uploads root
        so the existing path-confined ``/api/personal/rag-asset`` can serve them.
        """
        from core.constants import BASE_DIR

        d = os.path.join(BASE_DIR, "data", "personal_uploads", "_pdf_figures")
        os.makedirs(d, exist_ok=True)
        return d

    def _get_fig_converter(self):
        """Docling converter configured to materialize figure images (the default
        converter does not), cached so its ML models load once across files."""
        if self._fig_converter is not None:
            return self._fig_converter
        from docling.datamodel.base_models import InputFormat
        from docling.document_converter import DocumentConverter, PdfFormatOption

        # ~144 dpi crops (crisp enough to read a diagram), all cores like the main
        # docling lane. images_scale/generate_picture_images are the only behavior
        # changes vs. the default pipeline; the thread bump is result-preserving.
        opts = _docling_pdf_options(images_scale=2.0, generate_picture_images=True)
        self._fig_converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
        return self._fig_converter

    def _extract_pdf_figures(self, path: str, meta: Dict[str, Any], stage_cb=None):
        """Extract each embedded figure from a PDF as its own retrievable asset.

        Path A (Docling figure-level): Docling detects the pictures and crops
        each one for us (``PictureItem.get_image``), so we avoid hand-mapping
        bounding boxes onto a raster. Each crop is saved under the uploads root,
        VLM-captioned (the caption is the searchable text), and returned as a
        ``modality='figure'`` Document carrying an ``image_url`` — which
        ``_citation_media`` surfaces so the model can embed it inline. De-dupes by
        pixel hash so a logo repeated on every page is stored once. Best-effort:
        any failure yields no figures rather than breaking the page transcription.
        """
        import base64
        import hashlib
        import io
        from urllib.parse import quote

        from haystack.dataclasses import Document

        try:
            doc = self._get_fig_converter().convert(path).document
        except Exception as e:
            logger.warning("pdf-figures: docling convert failed for %s: %s", path, e)
            return []

        pictures = list(getattr(doc, "pictures", None) or [])
        if not pictures:
            return []

        figdir = self._figures_dir()
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(path).stem)[:60]
        crops: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        for pic in pictures:
            try:
                img = pic.get_image(doc)
            except Exception:
                img = None
            if img is None or img.width < self._FIG_MIN_PX or img.height < self._FIG_MIN_PX:
                continue
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="PNG")
            raw = buf.getvalue()
            digest = hashlib.sha1(raw).hexdigest()[:16]
            if digest in seen:
                continue
            seen.add(digest)
            page = None
            try:
                if pic.prov:
                    page = pic.prov[0].page_no
            except Exception:
                page = None
            asset_path = os.path.join(figdir, f"{stem}-{digest}.png")
            try:
                if not os.path.exists(asset_path):
                    with open(asset_path, "wb") as fh:
                        fh.write(raw)
            except OSError as e:
                logger.warning("pdf-figures: cannot write %s: %s", asset_path, e)
                continue
            docling_caption = ""
            try:
                docling_caption = (pic.caption_text(doc) or "").strip()
            except Exception:
                docling_caption = ""
            crops.append(
                {
                    "b64": base64.b64encode(raw).decode(),
                    "asset_path": asset_path,
                    "page": page,
                    "docling_caption": docling_caption,
                }
            )

        if not crops:
            return []

        # Caption each crop with the vision model (concurrent, like the page lane).
        total = len(crops)
        on_done = (lambda c: stage_cb(c, total)) if stage_cb else None
        captions = _concurrent_map(
            lambda b64: self._vlm_transcribe_image(b64, prompt=self._VLM_IMAGE_PROMPT),
            [c["b64"] for c in crops],
            _vlm_concurrency(),
            on_done=on_done,
        )

        out: List[Any] = []
        fname = os.path.basename(path)
        for i, c in enumerate(crops):
            caption = (captions[i] or c["docling_caption"] or "").strip()
            page_txt = f" (page {c['page']})" if c["page"] else ""
            # The Document's content is what the retriever matches on, so fall
            # back to a minimal locator when neither VLM nor Docling gave text.
            content = caption or f"Figure from {fname}{page_txt}"
            image_url = "/api/personal/rag-asset?source=" + quote(c["asset_path"], safe="")
            out.append(
                Document(
                    content=content,
                    meta={
                        "modality": "figure",
                        "page": c["page"],
                        "image_url": image_url,
                        "image_caption": caption or content,
                    },
                )
            )
        logger.info("pdf-figures: %s figure(s) extracted from %s", len(out), fname)
        return out

    def _ooxml_images(self, path: str):
        """Yield ``(member_name, png_base64)`` for each distinct, non-trivial
        raster image embedded in an OOXML (docx/pptx/xlsx) file.

        De-dupes by content hash (so a logo repeated on every slide is captioned
        once) and skips icon-sized images. Converts to PNG via Pillow so any
        supported raster format reaches the VLM uniformly.
        """
        import base64
        import hashlib
        import io
        import zipfile

        seen: Set[str] = set()
        try:
            from PIL import Image

            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    low = name.lower()
                    if "/media/" not in low or not low.endswith(_OOXML_IMG_EXTS):
                        continue
                    data = z.read(name)
                    h = hashlib.sha256(data).hexdigest()
                    if h in seen:
                        continue
                    seen.add(h)
                    try:
                        im = Image.open(io.BytesIO(data))
                        im.load()
                    except Exception:
                        continue
                    if im.width * im.height < 100 * 100:  # icons/bullets — skip
                        continue
                    buf = io.BytesIO()
                    im.convert("RGB").save(buf, format="PNG")
                    yield name, base64.b64encode(buf.getvalue()).decode()
        except Exception as e:
            logger.warning("ooxml image scan failed for %s: %s", path, e)

    def _lane_office_vlm(self, path: str, meta: Dict[str, Any], stage_cb=None):
        """Image-bearing Office docs (docx/pptx) → Docling text PLUS a VLM caption
        per embedded image, so figures/screenshots become searchable text.

        Office files have no page raster to render like a PDF, so this keeps
        Docling's (good) text extraction and *adds* one ``Document`` per embedded
        image describing it. ``stage_cb(done, total)`` reports per-image progress.
        """
        from haystack.dataclasses import Document

        docs = list(self._lane_docling(path))
        images = list(self._ooxml_images(path))
        total = len(images)
        on_done = (lambda c: stage_cb(c, total)) if stage_cb else None
        caps = _concurrent_map(
            lambda b64: self._vlm_transcribe_image(b64, prompt=self._VLM_IMAGE_PROMPT),
            [b64 for _name, b64 in images],
            _vlm_concurrency(),
            on_done=on_done,
        )
        for (name, _b64), cap in zip(images, caps):
            if cap:
                docs.append(
                    Document(content=cap, meta={"modality": "image_caption", "image": name})
                )
        logger.info(
            "office-vlm: %s + %s embedded image(s) for %s",
            "docling text",
            total,
            os.path.basename(path),
        )
        return docs

    def _lane_docling(self, path: str):
        """Rich docs/images → Docling HybridChunker (layout- and table-aware)."""
        from haystack_integrations.components.converters.docling import DoclingConverter

        if self._docling is None:
            # Default export_type=DOC_CHUNKS → Docling HybridChunker. We hand it a
            # converter whose accelerator uses all cores (Docling otherwise caps at
            # 4 threads); identical extraction, just faster. Fall back to the bare
            # converter if the docling internals ever shift under us.
            try:
                from docling.datamodel.base_models import InputFormat
                from docling.document_converter import DocumentConverter, PdfFormatOption

                converter = DocumentConverter(
                    format_options={
                        InputFormat.PDF: PdfFormatOption(pipeline_options=_docling_pdf_options())
                    }
                )
                self._docling = DoclingConverter(converter=converter)
            except Exception as e:
                logger.warning("docling: thread-tuned converter unavailable (%s); using default", e)
                self._docling = DoclingConverter()
        return self._docling.run(sources=[path]).get("documents", []) or []

    def _lane_code(self, path: str, language: str):
        """Source code → tree-sitter AST chunks, one per function/class/etc.,
        tagged with ``language``/``symbol``/``imports``. Falls back to the length
        splitter when tree-sitter (or the grammar) is missing or the file has no
        top-level definitions, so enabling the lane never breaks code ingest."""
        from haystack.dataclasses import Document

        source = Path(path).read_text(encoding="utf-8", errors="replace")
        if not source.strip():
            return []
        chunks = _code_chunks(source, language)
        if not chunks:  # None (no tree-sitter) or [] (no defs) → degrade safely
            return self._lane_text(path)
        imports = _extract_imports(source)
        return [
            Document(
                content=text, meta={"language": language, "symbol": symbol, "imports": imports}
            )
            for text, symbol in chunks
        ]

    def _lane_text(self, path: str):
        """Plain text/code/json → read directly and length-split."""
        from haystack.components.preprocessors import DocumentSplitter
        from haystack.dataclasses import Document

        text = Path(path).read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            return []
        if self._splitter is None:
            self._splitter = DocumentSplitter(split_by="word", split_length=250, split_overlap=40)
            try:
                self._splitter.warm_up()
            except Exception:
                pass
        return self._splitter.run(documents=[Document(content=text)]).get("documents", []) or []

    def _extract_audio_segments(self, path: str):
        """Demux + normalize audio to 16 kHz mono WAV via ffmpeg, split into
        ``VIDEO_ASR_CHUNK_SEC`` pieces. Returns ``(segments, tmpdir)`` where
        segments is ``[(wav_path, start_sec), …]``, or ``None`` if ffmpeg is
        unavailable (caller then sends the raw file).

        This is what makes *video* work: the vLLM ``/v1/audio/transcriptions``
        endpoint rejects a video container ("Invalid or unsupported audio file"),
        and the ASR model's small context (max_model_len 4096) can't take a long
        recording in one go — so we strip the video track and segment the audio.
        """
        import shutil

        if not shutil.which("ffmpeg"):
            return None
        import glob
        import subprocess
        import tempfile

        try:
            chunk = int(os.getenv("VIDEO_ASR_CHUNK_SEC", "120") or 120)
        except Exception:
            chunk = 120
        tmpdir = tempfile.mkdtemp(prefix="talos_asr_")
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-i", path, "-vn", "-ac", "1", "-ar", "16000",
        ]
        if chunk > 0:
            cmd += ["-f", "segment", "-segment_time", str(chunk),
                    os.path.join(tmpdir, "seg_%05d.wav")]
        else:
            cmd += [os.path.join(tmpdir, "seg_00000.wav")]
        subprocess.run(cmd, check=True, timeout=float(os.getenv("VIDEO_ASR_FFMPEG_TIMEOUT", "1800")))
        files = sorted(glob.glob(os.path.join(tmpdir, "seg_*.wav")))
        return [(f, i * chunk) for i, f in enumerate(files)], tmpdir

    def _transcribe_audio_file(self, wav_path: str, language: str) -> Dict[str, Any]:
        """POST one audio file to the ASR endpoint. Uses ``response_format=json``
        (vLLM Qwen3-ASR rejects ``verbose_json``) and surfaces the response body
        on error so the queue shows the real reason, not a bare status code."""
        import httpx

        url = os.getenv("VIDEO_ASR_URL", "").strip()
        timeout = float(os.getenv("VIDEO_ASR_TIMEOUT", "1800"))
        prompt = os.getenv("VIDEO_ASR_PROMPT", "").strip()
        with open(wav_path, "rb") as fh:
            if "/v1/audio/transcriptions" in url:
                data = {
                    "model": os.getenv("VIDEO_ASR_MODEL", "qwen3-asr"),
                    "response_format": "json",
                }
                # A real language code pins recognition; "auto"/empty omits the
                # field so the model auto-detects — better for code-switched
                # audio (German talk peppered with English terms), where forcing
                # one language mistranscribes the foreign words. (vLLM rejects an
                # empty language string, so we must drop the key entirely.)
                code = _asr_language_code(language)
                if code and code not in ("auto", "detect"):
                    data["language"] = code
                # Optional context to bias domain vocabulary / proper nouns.
                if prompt:
                    data["prompt"] = prompt
            else:
                data = {"language": language}
                if prompt:
                    data["prompt"] = prompt
            resp = httpx.post(
                url, files={"file": (os.path.basename(wav_path), fh)}, data=data, timeout=timeout
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"ASR endpoint {resp.status_code}: {resp.text[:300]}")
        return resp.json()

    def _asr_correct(self, text: str, glossary: str = "") -> str:
        """LLM cleanup of one transcript chunk: fix ASR errors and restore English
        technical terms/proper nouns to correct spelling, without translating or
        changing content. Best-effort — returns the original text on any error so
        ingest never blocks on it. No-op unless the cleanup lane is active."""
        url = os.getenv("RAG_LLM_URL", "").strip()
        if not url or not text.strip():
            return text
        try:
            import httpx

            sys_prompt = (
                "You are a transcript editor. The input is an automatic speech transcript "
                "(mainly German) that also contains English technical terms, product names "
                "and acronyms which the recognizer often mis-spells phonetically in German. "
                "Fix obvious transcription errors and restore those English terms to their "
                "correct English spelling. Do NOT translate — keep German text in German and "
                "English terms in English. Do not add, remove, summarize or reorder anything. "
                "Output ONLY the corrected transcript text."
            )
            user = (
                f"Known terms (spell these exactly when they occur): {glossary}\n\n" if glossary.strip() else ""
            ) + f"Transcript:\n{text}"
            payload: Dict[str, Any] = {
                "messages": [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.0,
                "max_tokens": min(12000, len(text) // 2 + 1000),
                "chat_template_kwargs": {"enable_thinking": False},
            }
            model = os.getenv("RAG_LLM_MODEL", "").strip()
            if model:
                payload["model"] = model
            headers = {}
            if os.getenv("RAG_LLM_API_KEY"):
                headers["Authorization"] = f"Bearer {os.getenv('RAG_LLM_API_KEY')}"
            resp = httpx.post(url, json=payload, headers=headers, timeout=120)
            resp.raise_for_status()
            out = (resp.json()["choices"][0]["message"]["content"] or "").strip()
            return out or text
        except Exception as e:
            logger.warning("asr correction failed: %s", e)
            return text

    def _lane_av(self, path: str, meta: Dict[str, Any], stage_cb=None):
        """Audio/video → ASR transcript, one Document per timed segment.

        Opt-in: when the ASR lane is disabled (the default), this raises a clear
        message so the queue shows *why* the file was skipped. Video is demuxed
        and long audio is chunked (see ``_extract_audio_segments``); chunks are
        transcribed concurrently and their timestamps offset by the chunk start.
        ``stage_cb(done, total)`` reports per-chunk progress.
        """
        if not _asr_active():
            raise RuntimeError(
                "ASR is disabled — enable Video / ASR in Advanced settings (and run the "
                "video-asr service) to index audio/video files"
            )
        from haystack.dataclasses import Document

        language = os.getenv("VIDEO_ASR_LANGUAGE", "German")
        extracted = self._extract_audio_segments(path)
        tmpdir = None
        if extracted is None:
            # No ffmpeg: send the raw file as a single segment. Works for plain
            # audio; a video container will surface the endpoint's own error.
            segments: List[Tuple[str, int]] = [(path, 0)]
        else:
            segments, tmpdir = extracted
        if not segments:
            raise RuntimeError("ffmpeg produced no audio (no audio track?)")

        try:
            total = len(segments)
            try:
                conc = int(os.getenv("VIDEO_ASR_CONCURRENCY", "2") or 2)
            except Exception:
                conc = 2
            on_done = (lambda c: stage_cb(c, total)) if stage_cb else None
            results = _concurrent_map(
                lambda item: (item[1], self._transcribe_audio_file(item[0], language)),
                segments,
                max(1, conc),
                on_done=on_done,
            )
        finally:
            if tmpdir:
                import shutil

                shutil.rmtree(tmpdir, ignore_errors=True)

        # Flatten ASR output to timed (start, end, text) entries.
        entries: List[Tuple[float, float, str]] = []
        for res in results:
            if not res:
                continue
            start_off, payload = res
            for seg in _asr_segments(payload):
                text = (seg.get("text") or "").strip()
                if not text:
                    continue
                entries.append(
                    (float(seg.get("start") or 0) + start_off, float(seg.get("end") or 0) + start_off, text)
                )

        # Optional LLM cleanup: fix ASR errors and restore English terms. One LLM
        # call per entry, fanned out concurrently. No-op unless the lane is on.
        if _asr_correct_active() and entries:
            glossary = os.getenv("VIDEO_ASR_PROMPT", "")
            fixed = _concurrent_map(
                lambda e: self._asr_correct(e[2], glossary), entries, _vlm_concurrency()
            )
            entries = [(s, en, (fx or t)) for (s, en, t), fx in zip(entries, fixed)]

        # A UI upload has no external video_url, so there's nothing to deep-link
        # to — the timestamps are still stored as metadata ("from minute X").
        base = meta.get("video_url") or meta.get("url")
        docs = []
        for start, end, text in entries:
            seg_meta: Dict[str, Any] = {"modality": "video", "start": start, "end": end}
            if base:
                sep = "&" if "?" in str(base) else "#"
                seg_meta["deeplink"] = f"{base}{sep}t={int(start)}"
            docs.append(Document(content=text, meta=seg_meta))
        if not docs:
            raise RuntimeError("ASR returned no transcript text")
        logger.info("asr: %s segment(s) → %s doc(s) for %s", len(segments), len(docs), os.path.basename(path))
        return docs

    # ------------------------------------------------------------------
    # Pixel image lane (Phase 5) — opt-in true-multimodal embedding
    # ------------------------------------------------------------------
    #
    # Images already get a *text* representation via Docling OCR (the main
    # collection). When the pixel lane is enabled we ADDITIONALLY embed the
    # image's pixels with a VL embedding model and write that vector to a
    # separate ``talos_rag_visual`` collection. Search then fans out to both and
    # lets the cross-encoder reranker merge them. Everything here is gated behind
    # ``_image_active()`` and uses the raw qdrant-client (Haystack's store only
    # models the fixed text dense+sparse vectors).

    def _visual_qdrant(self):
        if self._visual_client is None:
            from qdrant_client import QdrantClient

            api_key = os.getenv("QDRANT_API_KEY") or None
            self._visual_client = QdrantClient(
                url=os.getenv("QDRANT_URL", "").strip(), api_key=api_key
            )
        return self._visual_client

    def _vl_embed(self, value: Any) -> List[float]:
        """Embed text OR an image (data URL) with the VL model — they share one
        vector space, which is the whole point of pixel embedding.

        *** Phase-0 swap point ***: the exact request shape for image input
        depends on the VL embedding server (OpenAI ``/v1/embeddings`` with a data
        URL vs. vLLM ``/pooling``). Verify with the spike before relying on this;
        it is gated off by default so an unverified call never runs in prod.
        """
        import httpx

        url = os.getenv("IMAGE_EMBED_URL", "").strip()
        model = os.getenv("IMAGE_EMBED_MODEL", "").strip()
        payload: Dict[str, Any] = {"input": value}
        if model:
            payload["model"] = model
        headers = {}
        if os.getenv("IMAGE_EMBED_API_KEY"):
            headers["Authorization"] = f"Bearer {os.getenv('IMAGE_EMBED_API_KEY')}"
        resp = httpx.post(url, json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        item = (data.get("data") or [{}])[0]
        emb = item.get("embedding") if isinstance(item, dict) else None
        if not emb:
            raise RuntimeError("image embedding endpoint returned no vector")
        return emb

    def _embed_image(self, path: str) -> List[float]:
        import base64
        import mimetypes

        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        return self._vl_embed(f"data:{mime};base64,{b64}")

    def _ensure_visual_collection(self, dim: int) -> None:
        from qdrant_client.models import Distance, VectorParams

        client = self._visual_qdrant()
        existing = {c.name for c in client.get_collections().collections}
        if VISUAL_COLLECTION_NAME not in existing:
            client.create_collection(
                VISUAL_COLLECTION_NAME,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )
        self._visual_dim = dim

    def _write_image_pixel(self, path: str, meta: Dict[str, Any], caption: str = "") -> bool:
        """Embed an image's pixels and upsert one point into the visual
        collection. Best-effort: a failure must never break text ingest."""
        if not _image_active():
            return False
        try:
            import uuid as _uuid

            from qdrant_client.models import PointStruct

            vec = self._embed_image(path)
            if self._visual_dim is None:
                self._ensure_visual_collection(len(vec))
            payload = dict(meta)
            payload["modality"] = "image"
            # Caption (OCR/Docling text) gives the reranker a text view of the hit.
            payload["caption"] = (caption or "")[:2000]
            # Stable id per source so re-ingest overwrites rather than duplicates.
            pid = str(_uuid.uuid5(_uuid.NAMESPACE_URL, str(meta.get("source") or path)))
            self._visual_qdrant().upsert(
                VISUAL_COLLECTION_NAME, points=[PointStruct(id=pid, vector=vec, payload=payload)]
            )
            return True
        except Exception as e:
            logger.warning("image pixel embed failed for %s: %s", path, e)
            return False

    def _visual_search(self, query: str, k: int) -> List[Dict[str, Any]]:
        """Embed the text query with the VL model and search the visual
        collection. Returns candidate dicts in the same shape as hybrid hits so
        the reranker can merge them. Best-effort: errors yield no visual hits."""
        if not _image_active():
            return []
        try:
            existing = {c.name for c in self._visual_qdrant().get_collections().collections}
            if VISUAL_COLLECTION_NAME not in existing:
                return []
            vec = self._vl_embed(query)
            hits = (
                self._visual_qdrant()
                .query_points(VISUAL_COLLECTION_NAME, query=vec, limit=k, with_payload=True)
                .points
            )
            out: List[Dict[str, Any]] = []
            for h in hits:
                payload = dict(h.payload or {})
                out.append(
                    {
                        "id": str(h.id),
                        "document": payload.get("caption") or payload.get("filename") or "",
                        "metadata": payload,
                        "similarity": round(float(h.score or 0.0), 6),
                        "search_type": "visual",
                    }
                )
            return out
        except Exception as e:
            logger.warning("visual search failed: %s", e)
            return []

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
        processed = 0
        total = len(files)
        errors: List[Dict[str, str]] = []
        for fpath, meta in files:
            if cancel_cb and cancel_cb():
                return {
                    "success": False,
                    "cancelled": True,
                    "indexed_count": indexed,
                    "failed_count": failed,
                    "processed": processed,
                    "total": total,
                    "errors": errors,
                    "message": f"Cancelled after {indexed} chunks",
                }
            # Per-page/per-image sub-progress for the slow VLM lanes, so the queue
            # advances within a single large file instead of jumping 0%→done.
            def _stage(done: int, sub_total: int, _fp=fpath) -> None:
                if progress_cb:
                    progress_cb(
                        {
                            "file": _fp,
                            "indexed_count": indexed,
                            "failed_count": failed,
                            "processed": processed,
                            "total": total,
                            "sub_done": done,
                            "sub_total": sub_total,
                            "errors": errors,
                        }
                    )

            try:
                docs = self._documents_for_file(fpath, dict(meta or {}), stage_cb=_stage)
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
            processed += 1
            if progress_cb:
                progress_cb(
                    {
                        "file": fpath,
                        "indexed_count": indexed,
                        "failed_count": failed,
                        "processed": processed,
                        "total": total,
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

                        def _stage(done: int, sub_total: int, _fp=fpath) -> None:
                            if progress_cb:
                                progress_cb(
                                    {
                                        "file": _fp,
                                        "indexed_count": indexed,
                                        "failed_count": failed,
                                        "sub_done": done,
                                        "sub_total": sub_total,
                                        "errors": errors,
                                    }
                                )

                        docs = self._documents_for_file(fpath, meta, stage_cb=_stage)
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
            # Drop the visual collection too so a re-index (e.g. a VL-model swap
            # that changes the image vector dimension) starts clean.
            try:
                client = self._visual_qdrant()
                existing = {c.name for c in client.get_collections().collections}
                if VISUAL_COLLECTION_NAME in existing:
                    client.delete_collection(VISUAL_COLLECTION_NAME)
                self._visual_dim = None
            except Exception as e:
                logger.warning("visual collection rebuild cleanup failed: %s", e)
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

    def get_document_chunks(self, source: str) -> List[Dict[str, Any]]:
        """Return every indexed chunk for one source file, in ``seq`` order.

        Powers the ``/rag`` explorer's debug view: each row is the *stored* chunk
        text (exactly what the retriever sees) plus the meta that explains how it
        was indexed (section grouping, situating context, auto aux terms, code
        symbol/language, modality). Reads straight from Qdrant.
        """
        if not self.healthy:
            return []
        try:
            docs = self._store.filter_documents(
                filters={"field": "meta.source", "operator": "==", "value": source}
            )
            rows: List[Dict[str, Any]] = []
            for d in docs:
                meta = dict(d.meta or {})
                rows.append(
                    {
                        "id": d.id,
                        "content": d.content or "",
                        "seq": meta.get("seq", 0),
                        "section_id": meta.get("section_id", ""),
                        "context": meta.get("context", ""),
                        "aux_terms": meta.get("aux_terms", ""),
                        "symbol": meta.get("symbol", ""),
                        "language": meta.get("language", ""),
                        "modality": meta.get("modality", ""),
                        "metadata": meta,
                    }
                )
            return sorted(rows, key=lambda r: r.get("seq") or 0)
        except Exception as e:
            logger.error(f"get_document_chunks failed: {e}")
            return []

    def update_chunk(self, source: str, chunk_id: str, content: str) -> bool:
        """Replace one chunk's text and re-embed it in place (same id + meta).

        Backs the explorer's inline editor. Looks the chunk up by ``source`` +
        ``id`` (so a stale id from the UI can't clobber an unrelated point),
        swaps in the edited text, and re-runs the normal dense+sparse embedding
        via ``_write_documents`` with OVERWRITE so the point is replaced, not
        duplicated. Any previously-cached ingest enrichment (``context`` /
        ``aux_terms``, computed from the *old* text) is dropped so the new vector
        reflects exactly what the editor shows — predictable for debugging.
        """
        if not self.healthy:
            return False
        text = (content or "").strip()
        if not text:
            return False
        try:
            from haystack.dataclasses import Document

            docs = self._store.filter_documents(
                filters={"field": "meta.source", "operator": "==", "value": source}
            )
            target = next((d for d in docs if d.id == chunk_id), None)
            if target is None:
                return False
            meta = dict(target.meta or {})
            meta.pop("context", None)
            meta.pop("aux_terms", None)
            meta.pop("_ctx_orig", None)
            self._write_documents([Document(id=chunk_id, content=text, meta=meta)])
            return True
        except Exception as e:
            logger.error(f"update_chunk failed: {e}")
            return False

    def delete_chunk(self, source: str, chunk_id: str) -> bool:
        """Delete a single chunk by ``source`` + ``id`` (explorer debug action).

        Scoped to the source so a stale id from the UI can't remove an unrelated
        point. Returns True only when a matching chunk existed and was removed."""
        if not self.healthy:
            return False
        try:
            docs = self._store.filter_documents(
                filters={"field": "meta.source", "operator": "==", "value": source}
            )
            if not any(d.id == chunk_id for d in docs):
                return False
            self._store.delete_documents([chunk_id])
            return True
        except Exception as e:
            logger.error(f"delete_chunk failed: {e}")
            return False

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
            # Mirror the delete into the visual collection (best-effort).
            try:
                from qdrant_client.models import FieldCondition, Filter, MatchValue

                client = self._visual_qdrant()
                existing = {c.name for c in client.get_collections().collections}
                if VISUAL_COLLECTION_NAME in existing:
                    client.delete(
                        VISUAL_COLLECTION_NAME,
                        points_selector=Filter(
                            must=[FieldCondition(key="source", match=MatchValue(value=source))]
                        ),
                    )
            except Exception as e:
                logger.warning("visual delete_by_source failed: %s", e)
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
