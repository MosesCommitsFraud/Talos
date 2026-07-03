# src/chat_processor.py
import logging
import math
import os
import re
import time
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from src.prompt_security import UNTRUSTED_CONTEXT_POLICY, untrusted_context_message

logger = logging.getLogger(__name__)

# Extensions used to tag a citation's modality so the UI can show an image
# thumbnail or a video timestamp/deeplink.
_IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"})
_AV_EXTS = frozenset(
    {
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
)


# Trusted instruction injected only when a retrieved section carries a figure, so
# the model knows it *may* show the image inline. Emitting the image as Markdown in
# its own reply (rather than via a tool) means it renders in the transcript, is
# saved with the message, and — via the compaction figure-preservation pass —
# survives context compaction instead of vanishing as hidden tool output.
_FIGURE_EMBED_RULE = (
    "Some retrieved sections include a figure marked as [figure image_url: ... — "
    "caption: ...]. These are real screenshots/diagrams from the documentation and "
    "render inline in the chat. When you answer from a document that has such a "
    "figure, you MUST embed the figure in your answer as Markdown image syntax "
    "![caption](image_url), placed where it is relevant. Default to showing it: "
    "omit a figure only when it is clearly unrelated to the question. Never "
    "describe a figure in words instead of embedding it. Copy the image_url exactly, "
    "character-for-character, as given in the retrieved section — never invent, "
    "shorten, or alter one, and only use image_url values that appear in the "
    "retrieved context. Do not copy image references from inside document text "
    "(e.g. ![...] in a transcription) — only the [figure image_url: ...] entries "
    "are real, servable images."
)


def _citation_media(meta: Dict[str, Any]) -> Dict[str, Any]:
    """Derive optional citation media fields (image preview / video deeplink)
    from a chunk's metadata. Returns only the keys that apply, so it can be
    splatted into a source dict without adding noise for plain text/docs."""
    out: Dict[str, Any] = {}
    modality = meta.get("modality")
    ftype = (meta.get("type") or os.path.splitext(meta.get("filename") or "")[1] or "").lower()
    source = meta.get("source") or ""
    if modality == "video" or ftype in _AV_EXTS:
        out["modality"] = "video"
        for key in ("start", "end", "deeplink", "video_url"):
            if meta.get(key) is not None and meta.get(key) != "":
                out[key] = meta.get(key)
    elif meta.get("image_url"):
        # A figure/crop chunk (e.g. a picture extracted from a PDF page) carries
        # its own asset URL — surface it directly so the citation shows the crop
        # and the model can embed it inline.
        out["modality"] = "image"
        out["image_url"] = meta["image_url"]
        if meta.get("image_caption"):
            out["image_caption"] = meta["image_caption"]
    elif ftype in _IMAGE_EXTS and source:
        out["modality"] = "image"
        # Served by GET /api/personal/rag-asset (path-confined + image-only).
        out["image_url"] = "/api/personal/rag-asset?source=" + quote(str(source), safe="")
    return out


# ── Stopwords & tokenizer ──

_STOPWORDS = frozenset(
    "a an the is am are was were be been being have has had do does did "
    "will would shall should can could may might must need ought dare "
    "i me my mine we us our ours you your yours he him his she her hers "
    "it its they them their theirs this that these those "
    "and but or nor not no so if then else than too also very "
    "in on at to for of by with from up out about into over after "
    "what when where which who whom how why all each every some any "
    "just very really actually like well also still already even "
    "oh ok okay yes yeah hey hi hello thanks thank please sorry "
    "much more most own other another such only same here there "
    "because while during before until since through between both "
    "few many several some none nothing something anything everything "
    "get got make made go going went been come came take took "
    "know think want let say tell give see look find way thing "
    "don doesn didn won wouldn couldn shouldn wasn weren isn aren haven hasn "
    "don't doesn't didn't won't wouldn't couldn't shouldn't "
    "it's i'm i've i'll i'd you're you've you'll he's she's we're we've they're they've "
    "that's there's here's what's who's how's let's can't".split()
)


def _content_tokens(text: str) -> list:
    """Extract meaningful content words: no stopwords, min 3 chars, lowercase."""
    words = re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", text.lower())
    return [w for w in words if len(w) >= 3 and w not in _STOPWORDS]


def _chunk_relevant_to_query(query: str, document: str) -> bool:
    """Cheap relevance gate used when no reranker is available.

    Raw hybrid (RRF) scores don't reflect true relevance — the top result is
    "top" even for an unrelated query — so the top-k can't be trusted blindly.
    A chunk counts as relevant only when it shares distinctive content words with
    the query. Short queries need one solid shared term; longer queries need two.
    Precision over recall: better to inject nothing than off-topic knowledge that
    only confuses the model and produces misleading citations."""
    q = _content_tokens(query)
    if not q:
        return False
    d = set(_content_tokens(document))
    if not d:
        return False
    shared = set(q) & d
    need = 1 if len(set(q)) <= 2 else 2
    return len(shared) >= need


class ChatProcessor:
    def __init__(
        self, memory_manager, personal_docs_manager, memory_vector=None, skills_manager=None
    ):
        self.memory_manager = memory_manager
        self.personal_docs_manager = personal_docs_manager
        self.memory_vector = memory_vector
        self.skills_manager = skills_manager

    # OpenWebUI-style RAG: inject the top retrieved/reranked chunks instead of
    # dropping everything behind a hard similarity gate. Embedding/reranker
    # scales differ between providers, so a fixed threshold is brittle.
    RAG_SIMILARITY_THRESHOLD = 0.0
    RAG_RERANK_MIN_SCORE = 0.10

    def _rag_k_setting(self, key: str, default: int) -> int:
        try:
            from src.settings import get_setting

            cfg = get_setting("rag_pipeline", {})
            if isinstance(cfg, dict):
                return max(1, min(int(cfg.get(key) or default), 100))
        except Exception:
            pass
        return default

    def _rag_cfg(self) -> dict:
        try:
            from src.settings import get_setting

            cfg = get_setting("rag_pipeline", {})
            return cfg if isinstance(cfg, dict) else {}
        except Exception:
            return {}

    def _rag_float_setting(self, key: str, default: float) -> float:
        val = self._rag_cfg().get(key)
        try:
            return float(val) if val is not None and val != "" else default
        except Exception:
            return default

    def _maybe_rewrite_query(self, message: str, session: Any, owner: Optional[str]) -> str:
        """Conversation-aware query transformation (Phase 7).

        Rewrites a context-dependent message ("and the second one?") into a
        standalone retrieval query using the recent turns + the utility LLM.
        Returns the **raw message** unchanged when disabled, on any error, or
        when there's no prior turn to disambiguate against — so retrieval never
        blocks on the rewrite and the default behaviour is identical to before.
        """
        if not self._rag_cfg().get("query_rewrite_enabled"):
            return message
        history = getattr(session, "history", None) or []
        turns: List[str] = []
        for m in list(history)[-7:]:
            role = getattr(m, "role", "") or (m.get("role") if isinstance(m, dict) else "")
            content = getattr(m, "content", "") or (m.get("content") if isinstance(m, dict) else "")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                turns.append(f"{role}: {content.strip()[:500]}")
        # Need at least one prior turn besides the current message to be worth it.
        if len(turns) <= 1:
            return message
        try:
            from src.endpoint_resolver import resolve_endpoint
            from src.llm_core import llm_call

            url, model, headers = resolve_endpoint("utility", owner=owner)
            if not url or not model:
                return message
            sys_prompt = (
                "Rewrite the user's latest message into a single standalone search query "
                "for a knowledge base. Resolve pronouns and references using the "
                "conversation. Output ONLY the query text — no quotes, no preamble."
            )
            user_prompt = (
                f"Conversation so far:\n{chr(10).join(turns)}\n\n"
                f"Latest message: {message}\n\nStandalone search query:"
            )
            out = llm_call(
                url,
                model,
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                headers=headers,
                temperature=0.0,
                max_tokens=120,
                prompt_type="utility",
            )
            rewritten = (out or "").strip().strip('"').splitlines()[0].strip()
            if rewritten and len(rewritten) >= 3:
                logger.info("RAG query rewrite: %r -> %r", message[:60], rewritten[:60])
                return rewritten
        except Exception as e:
            logger.warning("query rewrite failed, using raw query: %s", e)
        return message

    def _hybrid_retrieve(self, message: str, mem_entries: list, k: int = 5) -> list:
        """Retrieve memories relevant to the message.

        Uses BM25-style keyword scoring + optional vector similarity.
        Recency is a tiebreaker only, never the primary signal.
        """
        if not mem_entries or not message.strip():
            return []

        now = time.time()
        query_tokens = _content_tokens(message)

        # If the query has no meaningful tokens, skip keyword retrieval entirely
        if not query_tokens:
            # Fall back to vector-only if available
            if not (self.memory_vector and self.memory_vector.healthy):
                return []

        # ── Build IDF from the memory corpus ──
        N = len(mem_entries)
        doc_freq = Counter()  # token -> how many memories contain it
        mem_token_cache = {}  # mem_id -> set of content tokens
        for mem in mem_entries:
            toks = set(_content_tokens(mem["text"]))
            mem_token_cache[mem["id"]] = toks
            for t in toks:
                doc_freq[t] += 1

        def _bm25_score(query_toks, mem_id):
            """BM25-inspired score between query and a memory."""
            mem_toks = mem_token_cache.get(mem_id, set())
            if not mem_toks or not query_toks:
                return 0.0
            score = 0.0
            mem_len = len(mem_toks)
            avg_len = max(sum(len(v) for v in mem_token_cache.values()) / N, 1)
            k1, b = 1.5, 0.75
            for qt in query_toks:
                if qt not in mem_toks:
                    continue
                df = doc_freq.get(qt, 0)
                idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
                tf = 1  # binary presence (memory entries are short)
                tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * mem_len / avg_len))
                score += idf * tf_norm
            return score

        # ── Score all candidates ──
        has_vector = self.memory_vector and self.memory_vector.healthy
        vector_scores = {}

        if has_vector:
            results = self.memory_vector.search(message, k=min(k * 3, 20))
            mem_by_id = {m["id"]: m for m in mem_entries}
            for r in results:
                if r["memory_id"] in mem_by_id:
                    vector_scores[r["memory_id"]] = max(r["score"], 0.0)

        scored = []
        for mem in mem_entries:
            mid = mem["id"]
            vs = vector_scores.get(mid, 0.0)
            kw = _bm25_score(query_tokens, mid)

            # Normalize BM25 to roughly 0-1 range (cap at a reasonable max)
            kw_norm = min(kw / 6.0, 1.0) if kw > 0 else 0.0

            # Category-aware boost for identity/contact queries
            category = mem.get("category", "fact")
            msg_lower = message.lower()
            mem_lower = mem["text"].lower()
            cat_boost = 1.0
            if any(w in msg_lower for w in ["name", "who am i", "my name"]):
                if category == "identity" or any(
                    w in mem_lower for w in ["name is", "i am", "called"]
                ):
                    cat_boost = 1.4
            elif any(w in msg_lower for w in ["phone", "email", "address", "contact"]):
                if category == "contact" or "@" in mem_lower:
                    cat_boost = 1.3
            elif any(w in msg_lower for w in ["like", "prefer", "favorite"]):
                if category == "preference":
                    cat_boost = 1.2

            kw_norm = min(kw_norm * cat_boost, 1.0)

            # Recency — tiebreaker only (max 5% contribution)
            ts = mem.get("timestamp", 0)
            days_old = max((now - ts) / 86400, 0)
            recency = 1.0 / (1.0 + days_old * 0.05)

            # Gate: need real relevance, not just recency
            if has_vector:
                if vs < 0.20 and kw_norm < 0.08:
                    continue
                final = (0.55 * vs) + (0.40 * kw_norm) + (0.05 * recency)
            else:
                if kw_norm < 0.08:
                    continue
                final = (0.95 * kw_norm) + (0.05 * recency)

            if final > 0.12:
                scored.append((final, mem))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [mem for _, mem in scored[:k]]

    def build_context_preface(
        self,
        message: str,
        session: Any,
        use_web: bool = False,
        use_rag: bool = True,
        use_memory: bool = True,
        time_filter: Optional[str] = None,
        preset_system_prompt: Optional[str] = None,
        owner: Optional[str] = None,
        character_name: Optional[str] = None,
        agent_mode: bool = False,
        incognito: bool = False,
        use_skills: bool = True,
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, Any]], List[Dict[str, str]]]:
        """Build the context preface for LLM calls.

        Returns:
            Tuple of (preface messages, rag_sources list)
        """
        preface = []
        rag_sources = []

        # Add preset system prompt if specified
        if preset_system_prompt:
            preface.append({"role": "system", "content": preset_system_prompt})
        if not agent_mode:
            try:
                from src.user_time import current_datetime_prompt

                preface.append(
                    {
                        "role": "system",
                        "content": current_datetime_prompt(),
                    }
                )
            except Exception:
                logger.debug("Failed to add current date/time context", exc_info=True)
        preface.append(
            {
                "role": "system",
                "content": UNTRUSTED_CONTEXT_POLICY,
            }
        )

        # Memory: pinned (always included) + extended (RAG-retrieved when relevant)
        self._last_used_memories = []  # track what was injected
        if use_memory:
            mem_entries = self.memory_manager.load(owner=owner)

            pinned = [m for m in mem_entries if m.get("pinned")]
            extended = [m for m in mem_entries if not m.get("pinned")]

            _used_ids: list = []
            if pinned:
                pinned_text = "\n- ".join([m["text"] for m in pinned])
                preface.append(
                    untrusted_context_message(
                        "saved memory: pinned user facts",
                        f"Core facts about the user:\n- {pinned_text}",
                    )
                )
                for m in pinned:
                    self._last_used_memories.append(
                        {"text": m["text"], "category": m.get("category", "fact"), "type": "pinned"}
                    )
                    if m.get("id"):
                        _used_ids.append(m["id"])

            if extended:
                relevant = self._hybrid_retrieve(message, extended, k=3)
                if relevant:
                    ext_text = "\n".join([f"- {m['text']}" for m in relevant])
                    preface.append(
                        untrusted_context_message(
                            "saved memory: retrieved context",
                            (
                                "Memory context. Do not reference unless the user asks "
                                f"about these topics.\n{ext_text}"
                            ),
                        )
                    )
                    for m in relevant:
                        self._last_used_memories.append(
                            {
                                "text": m["text"],
                                "category": m.get("category", "fact"),
                                "type": "recalled",
                            }
                        )
                        if m.get("id"):
                            _used_ids.append(m["id"])

            # Bump usage counters for the memories that were actually injected.
            if _used_ids and hasattr(self.memory_manager, "increment_uses"):
                try:
                    self.memory_manager.increment_uses(_used_ids)
                except Exception as _e:
                    logger.warning("Failed to increment memory uses: %s", _e)

            # (skills index injection moved out — see below; only fires in
            # agent mode so chat mode and incognito stay clean.)

        # RAG: search if enabled and rag_manager available, inject only above threshold
        if use_rag:
            try:
                # External provider (e.g. RagFlow) replaces the internal Qdrant
                # manager but returns the same result shape, so everything below
                # the search() call is shared.
                if str(self._rag_cfg().get("provider") or "internal").strip().lower() == "external":
                    from src.rag_external import ExternalRagClient

                    rag_manager = ExternalRagClient(self._rag_cfg())
                    if not rag_manager.configured:
                        rag_manager = None
                else:
                    rag_manager = getattr(self.personal_docs_manager, "rag_manager", None)
                    if not rag_manager:
                        from src.rag_singleton import get_rag_manager

                        rag_manager = get_rag_manager()
                        if rag_manager and self.personal_docs_manager is not None:
                            self.personal_docs_manager.rag_manager = rag_manager
                if rag_manager:
                    # RAG is a global admin-managed knowledge base. Do not owner-filter here:
                    # when enabled, indexed knowledge is available to every user.
                    rag_k = min(self._rag_k_setting("chat_top_k", 5), 20)
                    candidate_k = max(rag_k, min(self._rag_k_setting("candidate_top_k", 40), 100))
                    rerank_min = self._rag_float_setting(
                        "rerank_min_score", self.RAG_RERANK_MIN_SCORE
                    )
                    sim_threshold = self._rag_float_setting(
                        "similarity_threshold", self.RAG_SIMILARITY_THRESHOLD
                    )
                    # Conversation-aware query transformation (Phase 7): resolve
                    # follow-ups like "and the second one?" into a standalone
                    # retrieval query. Off by default; degrades to the raw message.
                    search_query = self._maybe_rewrite_query(message, session, owner)
                    # Keep the SQL-only knowledge namespace out of ordinary RAG;
                    # those schema files are injected separately when the SQL
                    # source is active (see agent_loop force_db). The external
                    # client has no scope concept, so only pass it internally.
                    if (
                        str(self._rag_cfg().get("provider") or "internal").strip().lower()
                        == "external"
                    ):
                        results = rag_manager.search(
                            search_query, k=rag_k, owner=None, candidate_k=candidate_k
                        )
                    else:
                        results = rag_manager.search(
                            search_query,
                            k=rag_k,
                            owner=None,
                            candidate_k=candidate_k,
                            exclude_scopes=["sql"],
                        )
                    # Decide which retrieved chunks are relevant enough to inject.
                    # When nothing clears the bar we inject NOTHING — no forced
                    # top-k fallback. Off-topic context confuses the model and
                    # yields misleading citations, so on a query the index has
                    # nothing useful for, RAG stays silent.
                    has_rerank_scores = any(r.get("rerank_score") is not None for r in results)
                    if has_rerank_scores:
                        # The reranker is a reliable relevance oracle, so trust
                        # its score directly. A vector-only match with no keyword
                        # overlap is fine here — the reranker already vetted it.
                        relevant = [
                            r
                            for r in results
                            if r.get("rerank_score") is not None
                            and float(r.get("rerank_score") or 0) >= rerank_min
                        ]
                    else:
                        # No reranker: raw hybrid (RRF) scores can't tell a
                        # relevant query from an unrelated one, so require the
                        # chunk to actually share distinctive query terms before
                        # injecting it.
                        relevant = [
                            r
                            for r in results
                            if r.get("similarity", 0) >= sim_threshold
                            and _chunk_relevant_to_query(search_query, r.get("document", ""))
                        ]
                    if relevant:
                        logger.info(
                            f"RAG: {len(relevant)}/{len(results)} results above threshold {sim_threshold}"
                        )
                        rag_sources = [
                            {
                                "filename": r["metadata"].get(
                                    "filename", r["metadata"].get("source", "unknown")
                                ),
                                "snippet": r["document"][:200],
                                "similarity": round(r.get("similarity", 0), 3),
                                # Larger slice of the chunk, kept ONLY for the
                                # post-generation "was this actually used?" check
                                # (filter_used_rag_sources). Stripped (underscore
                                # key) before the source is emitted or saved, so
                                # it never reaches the client or the DB.
                                "_text": r["document"][:1500],
                                # Optional image-preview / video-timestamp fields
                                # so citations can render a thumbnail or a #t=
                                # deeplink (absent for plain text/docs).
                                **_citation_media(r["metadata"] or {}),
                            }
                            for r in relevant
                        ]
                        # Admin-overridable instruction prefacing the retrieved context.
                        context_prompt = (self._rag_cfg().get("context_prompt") or "").strip() or (
                            "Retrieved knowledge base context. Use this context to answer the user's current question. "
                            "If the answer is present here, prefer it over general knowledge."
                        )

                        # Inject the expanded parent section when small-to-big is
                        # on (r["expanded"]); otherwise the matched chunk. The
                        # citation snippet (rag_sources) still uses the chunk.
                        def _rag_section(s, r):
                            body = f"[{s['filename']}]\n{r.get('expanded') or r['document']}"
                            # Expose the figure as a ready-made Markdown line with an
                            # imperative right next to it: small local models follow an
                            # instruction adjacent to the data far more reliably than
                            # the separate _FIGURE_EMBED_RULE system message alone.
                            if s.get("image_url"):
                                cap = (
                                    s.get("image_caption") or s.get("filename") or "figure"
                                ).strip()
                                # First line only, brackets sanitized, capped — the full
                                # VLM description makes unusable alt text.
                                cap = (
                                    cap.splitlines()[0]
                                    .replace("[", "(")
                                    .replace("]", ")")[:120]
                                    .strip()
                                    or "figure"
                                )
                                body += (
                                    "\n[This section is a real figure from the document above. "
                                    "If you use this document in your answer, you MUST display "
                                    "the figure to the user by copying this exact Markdown line "
                                    "into your answer:]\n"
                                    f"![{cap}]({s['image_url']})"
                                )
                            return body

                        # Figure sections (caption + image_url, tiny) must survive
                        # the context-size cut below — they ride at the END of the
                        # result list, so a plain tail truncation would drop exactly
                        # them while the embed rule still promises the model figures.
                        # Budget the text sections around them instead.
                        text_secs, fig_secs = [], []
                        for s, r in zip(rag_sources, relevant):
                            sec = _rag_section(s, r)
                            (fig_secs if s.get("image_url") else text_secs).append(sec)
                        rag_content = (context_prompt + "\n\n") + "\n\n---\n\n".join(text_secs)
                        try:
                            max_chars = int(self._rag_cfg().get("max_context_chars") or 10000)
                        except Exception:
                            max_chars = 10000
                        max_chars = max(500, min(max_chars, 100000))
                        fig_block = "\n\n---\n\n".join(fig_secs)
                        budget = max(500, max_chars - len(fig_block))
                        if len(rag_content) > budget:
                            rag_content = rag_content[:budget] + "\n[Truncated]"
                        if fig_block:
                            rag_content += "\n\n---\n\n" + fig_block
                            logger.info(
                                "RAG: injected %s figure section(s) with image_url", len(fig_secs)
                            )
                        preface.append(
                            untrusted_context_message("retrieved documents", rag_content)
                        )
                        # Authorize inline figure embedding only when a retrieved
                        # section actually has one (keeps the rule out of context
                        # otherwise). Trusted system message, not untrusted data.
                        if any(s.get("image_url") for s in rag_sources):
                            preface.append({"role": "system", "content": _FIGURE_EMBED_RULE})
            except Exception as e:
                logger.warning(f"RAG retrieval failed: {e}")

        # Web search and URL auto-fetch removed — this build runs internally
        # with no outbound web access.
        web_sources = []

        # Skills index — progressive disclosure. Only injected when the
        # model has the `manage_skills` tool available (agent_mode), and
        # never in incognito mode (the user has explicitly opted out of
        # context retention this turn). In plain chat mode the model can't
        # call the tool anyway, so the index would be noise.
        if agent_mode and not incognito and use_skills and self.skills_manager:
            try:
                idx = self.skills_manager.index_for(owner=owner)
            except Exception as e:
                logger.debug(f"Skills index unavailable: {e}")
                idx = []
            if idx:
                by_cat: Dict[str, list] = {}
                for s in idx:
                    by_cat.setdefault(s.get("category") or "general", []).append(s)
                lines = [
                    "[Available skills — call manage_skills(action='view', name='...') to load one when relevant]"
                ]
                for cat in sorted(by_cat):
                    lines.append(f"  {cat}:")
                    for s in sorted(by_cat[cat], key=lambda x: x["name"]):
                        desc = s.get("description") or ""
                        lines.append(f"    - {s['name']}: {desc}" if desc else f"    - {s['name']}")
                preface.append(
                    untrusted_context_message("available skills index", "\n".join(lines))
                )

        return preface, rag_sources, web_sources
