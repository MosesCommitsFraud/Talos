"""Finding a term in document text the way people and manuals actually write it.

A plain substring search misses "Strg + M" for "Strg+M", "Daten-Transfer" for
"Daten Transfer" and "Übersetzen" for "Uebersetzen". The match stays literal in
everything that matters: every letter of the term has to be there, in order.
"""

from __future__ import annotations

import re
from typing import List, Pattern

# What may stand between two parts of a term.
_GAP = r"[\s\-‐‑–—_+/.]*"
_SPELLINGS = {
    "ä": "(?:ä|ae)",
    "ö": "(?:ö|oe)",
    "ü": "(?:ü|ue)",
    "ß": "(?:ß|ss)",
    "ae": "(?:ae|ä)",
    "oe": "(?:oe|ö)",
    "ue": "(?:ue|ü)",
    "ss": "(?:ss|ß)",
}
_WORD_CHAR = r"[^\W_]"


def term_parts(term: str) -> List[str]:
    return re.findall(r"[^\W_]+", (term or "").lower())


def _part_regex(part: str) -> str:
    out, i = [], 0
    while i < len(part):
        pair = part[i : i + 2]
        if pair in _SPELLINGS:
            out.append(_SPELLINGS[pair])
            i += 2
        else:
            out.append(_SPELLINGS.get(part[i], re.escape(part[i])))
            i += 1
    return "".join(out)


def term_regex(term: str) -> Pattern[str]:
    """A term's spellings. A short end part must stand alone, so the "M" of "Strg+M"
    doesn't match the start of "Strg Menü"; longer ones keep matching inside words,
    so "Datenart" finds "Datenarten"."""
    parts = term_parts(term)
    if not parts:
        return re.compile(re.escape((term or "").strip()), re.IGNORECASE)
    body = _GAP.join(_part_regex(p) for p in parts)
    if len(parts[0]) < 3:
        body = f"(?<!{_WORD_CHAR})" + body
    if len(parts[-1]) < 3:
        body += f"(?!{_WORD_CHAR})"
    return re.compile(body, re.IGNORECASE)


def word_regexes(term: str) -> List[Pattern[str]]:
    """One pattern per word, for "all these words somewhere" when the phrase itself is absent."""
    parts = term_parts(term)
    return [term_regex(p) for p in parts] if len(parts) > 1 else []
