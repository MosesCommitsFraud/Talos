# src/ingest_redaction.py
"""Opt-in PII redaction for RAG ingest.

Rule set ported from opendataloader-pdf's ``FilterConfig`` defaults
(Apache-2.0, Hancom Inc.): coarse regexes that replace personally
identifiable strings with typed placeholders *before* text is chunked,
embedded, and indexed — so PII never reaches Qdrant or an LLM.

Strictly opt-in (``RAG_REDACT_PII=true``): the IP/URL/number rules are
deliberately aggressive and would mangle technical corpora (server docs,
code, logs). Enable it for HR/customer-document collections, not for
engineering ones.

Rule-order notes vs. upstream: MAC comes before IPv6 (upstream's IPv6 rule
matched MAC addresses first and mislabeled them), and upstream's separate
IMEI rule (15 digits) is dropped because the account rule (10–18 digits)
already consumes it. The IPv6 rule also matches other colon-separated hex/
digit runs (e.g. ``12:30:45`` timestamps) — inherited from upstream and
accepted for an opt-in coarse filter.
"""

import logging
import os
import re
from typing import List, Tuple

logger = logging.getLogger(__name__)

_RULES: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
    (re.compile(r"[+]\d+(?:-\d+)+"), "[phone]"),
    (re.compile(r"\b[A-Z]{1,2}\d{6,9}\b"), "[id]"),  # passport-style
    (re.compile(r"\b\d{4}-?\d{4}-?\d{4}-?\d{4}\b"), "[card]"),
    (re.compile(r"\b\d{10,18}\b"), "[account]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[ip]"),
    (re.compile(r"\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b"), "[mac]"),
    (re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b"), "[ipv6]"),
    (re.compile(r"https?://[A-Za-z0-9.-]+(?::\d+)?(?:/\S*)?"), "[url]"),
]


def redaction_active() -> bool:
    """True when ``RAG_REDACT_PII`` is set to a truthy value. Off by default."""
    return bool(os.getenv("RAG_REDACT_PII", "").strip())


def redact_pii(text: str) -> str:
    """Replace PII matches with typed placeholders. Rules run in order; the
    placeholders they insert contain no digits, so later rules can't re-match
    inside an earlier replacement."""
    if not text:
        return text
    for pattern, placeholder in _RULES:
        text = pattern.sub(placeholder, text)
    return text
