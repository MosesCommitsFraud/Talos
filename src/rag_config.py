"""rag_config.py

Resolves the RAG pipeline configuration **for one knowledge base**.

Talos has one `rag_pipeline` settings block. With several knowledge bases
(``src/rag_registry.py``) that block became the *defaults*: each base stores
only the keys it deliberately changes, and everything else is inherited. Change
the global reranker and every base that never overrode it follows along.

Two kinds of keys:

* ``GLOBAL_KEYS`` — infrastructure shared by every base (the Qdrant instance,
  the external-provider switch, the global kill-switch). A base cannot override
  these: there is one vector store, and letting a base point at a different one
  would turn a settings mistake into a silent split-brain index.
* everything else — per base. Embedding model, reranker, the retrieval tuning
  and all ingest lanes. Different bases legitimately want different pipelines:
  a base of scanned PDFs wants the VLM lane that a base of Markdown notes would
  only be slowed down by.

Overrides live in the registry entry (``data/rag/registry.json``) rather than in
settings.json, because the ingest worker runs in a separate container that
shares the data volume but not the app database — the same reason the catalogue
itself lives there.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Mapping, Optional, Set

logger = logging.getLogger(__name__)

# Infrastructure — one per deployment, never per base.
GLOBAL_KEYS: Set[str] = {
    "enabled",
    "provider",
    "qdrant_url",
    "qdrant_api_key",
    "external_url",
    "external_api_key",
    "external_dataset_id",
    "external_top_k",
}

# Secrets are stored but never echoed back to a client; the UI shows a
# "…_set" boolean instead (mirrors routes/rag_routes.py `_public`).
SECRET_KEYS: Set[str] = {"qdrant_api_key", "rerank_api_key", "external_api_key"}


def global_config() -> Dict[str, Any]:
    """The saved `rag_pipeline` block — the defaults every base inherits."""
    try:
        from src.settings import get_setting

        cfg = get_setting("rag_pipeline", {})
    except Exception as e:
        logger.warning("could not read rag_pipeline settings: %s", e)
        return {}
    return dict(cfg) if isinstance(cfg, dict) else {}


def overrides_for(base_id: Optional[str]) -> Dict[str, Any]:
    """The keys this base deliberately sets. Empty for a base that inherits all."""
    try:
        from src.rag_registry import get_base

        raw = get_base(base_id).get("overrides")
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    # A stored global key would silently do nothing; drop it so the effective
    # config can never disagree with what the UI shows.
    return {k: v for k, v in raw.items() if k not in GLOBAL_KEYS}


def effective_config(base_id: Optional[str] = None) -> Dict[str, Any]:
    """The configuration one knowledge base actually runs with.

    Global defaults with the base's overrides layered on top. Callers can treat
    the result exactly like the old flat `rag_pipeline` dict — that is the point,
    so every existing consumer keeps working by passing a base id.
    """
    cfg = global_config()
    cfg.update(overrides_for(base_id))
    return cfg


# Extraction lanes that read a file at all (speech, scanned pages, video
# frames, code structure). Each has a mode: "auto" runs it as soon as the
# endpoint it needs is configured, so dropping in a video or a scanned PDF
# just works once the infrastructure exists; "on"/"off" pin it. Enrichment
# (contextual blurbs, keywords, pixel vectors) stays explicitly opt-in: it is
# tuning, and it costs one model call per chunk.
LANE_MODES = ("auto", "on", "off")
LANES: Dict[str, str] = {
    "video_asr": "video_asr_enabled",
    "video_frames": "video_frames_enabled",
    "pdf_vlm": "pdf_vlm_enabled",
    "code_lane": "code_lane_enabled",
}
_LANE_ENV = {
    "video_asr": "VIDEO_ASR_ENABLED",
    "video_frames": "VIDEO_FRAMES_ENABLED",
    "pdf_vlm": "PDF_VLM_ENABLED",
    "code_lane": "CODE_LANE_ENABLED",
}


def lane_mode(cfg: Mapping[str, Any], lane: str) -> str:
    """A lane's mode. Configs saved before modes existed carry only the old
    boolean: True stays "on", anything else becomes "auto"."""
    mode = str(cfg.get(f"{lane}_mode") or "").strip().lower()
    if mode in LANE_MODES:
        return mode
    return "on" if cfg.get(LANES[lane]) else "auto"


def _endpoint(cfg: Mapping[str, Any], key: str, env_name: str, env: Mapping[str, str]) -> str:
    return str(cfg.get(key) or env.get(env_name) or "").strip()


def lane_status(
    cfg: Mapping[str, Any], env: Optional[Mapping[str, str]] = None
) -> Dict[str, Dict[str, Any]]:
    """Per lane: mode, whether it runs, and what it is waiting for if not."""
    env = os.environ if env is None else env
    needs = {
        "video_asr": _endpoint(cfg, "video_asr_url", "VIDEO_ASR_URL", env),
        "pdf_vlm": _endpoint(cfg, "vlm_url", "VLM_URL", env),
        "video_frames": _endpoint(cfg, "vlm_url", "VLM_URL", env),
        "code_lane": "built-in",
    }
    missing = {
        "video_asr": "video_asr_url",
        "pdf_vlm": "vlm_url",
        "video_frames": "vlm_url",
        "code_lane": "",
    }
    out: Dict[str, Dict[str, Any]] = {}
    for lane in ("video_asr", "pdf_vlm", "code_lane", "video_frames"):
        mode = lane_mode(cfg, lane)
        ready = bool(needs[lane])
        waiting = "" if ready else missing[lane]
        if lane == "video_frames" and ready and not out["video_asr"]["active"]:
            ready, waiting = False, "video_asr"
        out[lane] = {"mode": mode, "active": mode != "off" and ready, "waiting_for": waiting}
    return out


def lane_env(cfg: Mapping[str, Any], env: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """The lane toggles as the env flags the ingest code reads."""
    status = lane_status(cfg, env)
    return {_LANE_ENV[lane]: "true" if s["active"] else "" for lane, s in status.items()}


def instance_config(base_id: Optional[str] = None) -> Dict[str, Any]:
    """``effective_config`` plus catalogue facts the engine needs.

    The base's language is catalogue metadata, not a pipeline setting (it must
    never show up as an override in the settings form), but the keyword (BM25)
    side stems and filters stopwords by it — so it is added here, for the app
    instance and the ingest worker's job snapshot alike.
    """
    cfg = effective_config(base_id)
    try:
        from src.rag_registry import get_base

        cfg["base_language"] = str(get_base(base_id).get("language") or "")
    except Exception:
        cfg.setdefault("base_language", "")
    return cfg


def set_overrides(base_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Replace a base's overrides with `patch` and return the stored result.

    Only non-global keys are kept. A key whose value equals the global default
    is dropped rather than stored, so "inherited" stays the honest default and a
    later change to the global value still propagates.
    """
    from src.rag_registry import set_overrides as _store

    defaults = global_config()
    clean: Dict[str, Any] = {}
    for key, value in (patch or {}).items():
        if key in GLOBAL_KEYS:
            continue
        if key in defaults and defaults[key] == value:
            continue
        clean[key] = value
    return _store(base_id, clean)


def is_overridden(base_id: Optional[str], key: str) -> bool:
    return key in overrides_for(base_id)
