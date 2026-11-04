"""Two checks around a knowledge answer.

Sufficiency, before the answer: do the retrieved passages cover the question? Asked of
the utility model.

Grounding, after the answer: does the answer say anything the passages don't? Asked of
the model that wrote the answer, because a small helper model isn't up to it: on one
real document with 39 answers and 22 forgeries, a 4B model flagged 12 sound answers and
missed 4 forgeries where a 27B model flagged 1 and missed 1.

Each runs in one of three modes (rag_pipeline ``sufficiency_gate``, ``grounding_gate``):
``off``; ``shadow`` judges in the background and only records the verdict, so nothing
waits and nothing changes; ``on`` waits for the verdict and tells the model or the
reader. A check that fails for any reason counts as passed: it must never block an
answer.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

GATE_MODES = ("off", "shadow", "on")
DEFAULT_SUFFICIENCY_GATE = "off"
DEFAULT_GROUNDING_GATE = "on"
_DEFAULTS = {"sufficiency_gate": DEFAULT_SUFFICIENCY_GATE, "grounding_gate": DEFAULT_GROUNDING_GATE}
_MAX_PASSAGE_CHARS = 24000
_MAX_ANSWER_CHARS = 6000

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rag-gate")
_verdicts: "deque[Dict[str, Any]]" = deque(maxlen=200)
_pending: "set[Future]" = set()
_lock = threading.Lock()

_SUFFICIENCY_PROMPT = (
    "You check whether retrieved passages are enough to answer a question. Do not answer "
    "the question yourself. A passage that says outright that something is not documented "
    "covers that point. Reply with JSON only: "
    '{"covered": "all" | "part" | "none", "missing": "what is missing, in a few words"}'
)
_GROUNDING_PROMPT = (
    "You check an answer against the passages it was written from. List every factual "
    "claim in the answer that the passages do not support: invented names, numbers, steps "
    "or options, and claims that contradict a passage. Rewording and summarising are fine. "
    "Statements that something is not documented, source numbers like [3], and remarks "
    "about the answer itself are not claims. Reply with JSON only: "
    '{"unsupported": ["short exact quote from the answer", ...]}, with an empty list if '
    "the passages support everything."
)


def gate_mode(cfg: Optional[Dict[str, Any]], name: str) -> str:
    default = _DEFAULTS[name]
    mode = str((cfg or {}).get(name) or default).strip().lower()
    return mode if mode in GATE_MODES else default


def passages_from_sources(sources: List[Dict[str, Any]], answer: str = "") -> str:
    """The text the turn's sources put in front of the model, numbered as it saw it.

    A long turn can read more than the check takes, so what the answer cites goes first.
    """
    from src.citations import cited_numbers

    cited = cited_numbers(answer)
    parts = []
    seen = set()
    for source in sorted(sources or [], key=lambda s: s.get("n") not in cited):
        text = source.get("_text") or source.get("snippet") or ""
        if not text or text in seen:
            continue
        seen.add(text)
        label = f"[{source['n']}] " if source.get("n") else ""
        parts.append(f"{label}{source.get('filename') or ''}\n{text}")
    return "\n\n---\n\n".join(parts)[:_MAX_PASSAGE_CHARS]


def _parse_json(text: str) -> Dict[str, Any]:
    cleaned = re.sub(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", "", text or "", flags=re.I)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON in {cleaned[:80]!r}")
    return json.loads(cleaned[start : end + 1])


def _ask(
    system: str,
    user: str,
    owner: Optional[str],
    max_tokens: int,
    endpoint: Optional[Tuple[str, str, Optional[Dict[str, str]]]] = None,
) -> Dict[str, Any]:
    from src.endpoint_resolver import resolve_endpoint
    from src.llm_core import llm_call

    url, model, headers = endpoint or resolve_endpoint("utility", owner=owner)
    if not url or not model:
        raise RuntimeError("no model configured")
    if "qwen" in model.lower():
        user += " /no_think"
    out = llm_call(
        url,
        model,
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        headers=headers,
        temperature=0.0,
        max_tokens=max_tokens,
        prompt_type="utility",
        enable_thinking=False,
    )
    return _parse_json(out)


def check_sufficiency(question: str, passages: str, owner: Optional[str] = None) -> Dict[str, Any]:
    started = time.time()
    try:
        data = _ask(
            _SUFFICIENCY_PROMPT,
            f"Question: {question}\n\nPassages:\n{passages[:_MAX_PASSAGE_CHARS]}",
            owner,
            120,
        )
        covered = str(data.get("covered") or "").lower()
        if covered not in ("all", "part", "none"):
            raise ValueError(f"unexpected verdict {covered!r}")
        passed = covered == "all"
        return {
            "gate": "sufficiency",
            "passed": passed,
            "verdict": covered,
            "missing": "" if passed else str(data.get("missing") or "")[:300],
            "seconds": round(time.time() - started, 2),
        }
    except Exception as e:
        logger.warning("sufficiency check failed: %s", e)
        return {"gate": "sufficiency", "passed": True, "verdict": "error", "error": str(e)[:200]}


_NUMBER_RE = re.compile(r"\d+(?:[.,:/-]\d+)*")


def unsupported_numbers(answer: str, sources_text: str, question: str = "") -> List[str]:
    """Numbers of two or more digits in the answer that neither the passages nor the question hold."""
    prose = re.sub(r"\[\d{1,3}(?:\s*,\s*\d{1,3})*\]", " ", answer or "")
    known = set(_NUMBER_RE.findall(sources_text or "")) | set(_NUMBER_RE.findall(question or ""))
    out = []
    for number in _NUMBER_RE.findall(prose):
        if sum(c.isdigit() for c in number) >= 2 and number not in known and number not in out:
            out.append(number)
    return out


def check_grounding(
    question: str,
    answer: str,
    passages: str,
    owner: Optional[str] = None,
    endpoint: Optional[Tuple[str, str, Optional[Dict[str, str]]]] = None,
) -> Dict[str, Any]:
    started = time.time()
    visible = re.sub(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", "", answer or "", flags=re.I)
    numbers = unsupported_numbers(visible, passages, question)
    try:
        data = _ask(
            _GROUNDING_PROMPT,
            f"Question: {question}\n\nPassages:\n{passages[:_MAX_PASSAGE_CHARS]}\n\n"
            f"Answer:\n{visible.strip()[:_MAX_ANSWER_CHARS]}",
            owner,
            400,
            endpoint,
        )
        claims = data.get("unsupported")
        if not isinstance(claims, list):
            raise ValueError("unsupported is not a list")
    except Exception as e:
        logger.warning("grounding check failed: %s", e)
        return {
            "gate": "grounding",
            "passed": not numbers,
            "verdict": "error",
            "unsupported": numbers,
            "numbers": numbers,
            "error": str(e)[:200],
        }
    claims = [str(c).strip()[:200] for c in claims if str(c).strip()]
    # A quote the answer doesn't contain is the checker's own invention.
    claims = [c for c in claims if c.lower() in visible.lower()]
    unsupported = claims + [n for n in numbers if not any(n in c for c in claims)]
    return {
        "gate": "grounding",
        "passed": not unsupported,
        "verdict": "unsupported" if unsupported else "grounded",
        "unsupported": unsupported,
        "numbers": numbers,
        "seconds": round(time.time() - started, 2),
    }


def record(verdict: Dict[str, Any], question: str, mode: str) -> Dict[str, Any]:
    entry = {**verdict, "question": (question or "")[:200], "mode": mode, "at": time.time()}
    with _lock:
        _verdicts.append(entry)
    logger.info(
        "RAG gate %s (%s): %s for %r",
        verdict.get("gate"),
        mode,
        verdict.get("verdict"),
        (question or "")[:60],
    )
    return verdict


def recent_verdicts() -> List[Dict[str, Any]]:
    with _lock:
        return list(_verdicts)


def run_in_shadow(check: Callable[..., Dict[str, Any]], question: str, *args: Any) -> Future:
    """Judge in the background: the turn goes on, the verdict only lands in the log."""

    def job() -> None:
        record(check(question, *args), question, "shadow")

    future = _executor.submit(job)
    with _lock:
        _pending.add(future)
    future.add_done_callback(lambda f: _discard(f))
    return future


def _discard(future: Future) -> None:
    with _lock:
        _pending.discard(future)


def settle(timeout: float = 120.0) -> None:
    """Wait for background checks; for evaluation runs, which read the verdicts."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            if not _pending:
                return
        time.sleep(0.1)


def sufficiency_note(
    cfg: Optional[Dict[str, Any]],
    question: str,
    sources: List[Dict[str, Any]],
    owner: Optional[str] = None,
) -> str:
    """Note for the model when the passages fall short; empty in shadow mode and when they don't."""
    mode = gate_mode(cfg, "sufficiency_gate")
    passages = passages_from_sources(sources)
    if mode == "off" or not passages:
        return ""
    if mode == "shadow":
        run_in_shadow(check_sufficiency, question, passages, owner)
        return ""
    verdict = record(check_sufficiency(question, passages, owner), question, mode)
    if verdict["passed"]:
        return ""
    missing = verdict.get("missing") or "part of the question"
    return (
        f"A check found these passages don't fully cover the question. Missing: {missing}. "
        "Look once more for exactly that; if it stays missing, say that it is not stored "
        "rather than filling it in."
    )


def grounding_note(
    cfg: Optional[Dict[str, Any]],
    question: str,
    answer: str,
    sources: List[Dict[str, Any]],
    owner: Optional[str] = None,
    endpoint: Optional[Tuple[str, str, Optional[Dict[str, str]]]] = None,
) -> str:
    """Line to append for the reader when an answer goes beyond its sources; else empty.

    ``endpoint`` is the (url, model, headers) that wrote the answer.
    """
    mode = gate_mode(cfg, "grounding_gate")
    passages = passages_from_sources(sources, answer)
    if mode == "off" or not passages or not (answer or "").strip():
        return ""
    if mode == "shadow":
        run_in_shadow(check_grounding, question, answer, passages, owner, endpoint)
        return ""
    verdict = record(check_grounding(question, answer, passages, owner, endpoint), question, mode)
    if verdict["passed"]:
        return ""
    german = re.search(r"\b(der|die|das|und|nicht|ist|ein|eine)\b", answer, re.I)
    lead = (
        "Nicht durch die Quellen belegt, bitte prüfen"
        if german
        else "Not supported by the sources, please check"
    )
    claims = "; ".join(f"„{c}“" if german else f'"{c}"' for c in verdict["unsupported"][:5])
    return f"\n\n> ⚠️ {lead}: {claims}"
