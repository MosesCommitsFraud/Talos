"""Token/bigram overlap primitives shared by citation filtering and the
web-search leak guard.

Both features ask the same question — "how much of text A came from text B?" —
so they must tokenize identically. Kept stdlib-only and free of app imports so
`src.web_leak_guard` can use it without pulling in FastAPI via
`routes.chat_helpers`, which is where this logic originally lived.
"""

from __future__ import annotations

import re
from typing import List, Set, Tuple

# Common English + German function words — filtered out before measuring
# overlap so shared stopwords ("the", "und", …) don't make two unrelated texts
# look related.
STOPWORDS = frozenset(
    """
the a an and or but if then else of to in into on at for with without from by as is are was were be been being
this that these those it its they them their there here what which who whom whose how why when while where also
do does did done can could should would may might must will shall not no nor yes you your yours we our ours us
i me my mine he she him her his hers them about over under again more most some any each such only than too very
der die das den dem des ein eine einen einem einer und oder aber wenn dann sonst von zu im in an auf fuer für mit
ohne aus durch als ist sind war waren sein seine ich wir unser unsere du dein deine nicht kein keine ja was welche
welcher wer wie warum wann wo dies diese dieser jene jener es sie ihr ihre auch nur mehr sehr noch schon man
""".split()
)

WORD_RE = re.compile(r"[0-9A-Za-zÀ-ÿ_]+")


def content_tokens(text: str) -> List[str]:
    """Lowercased content words (≥3 chars, non-stopword) for overlap scoring."""
    return [
        w
        for w in (m.lower() for m in WORD_RE.findall(text or ""))
        if len(w) >= 3 and w not in STOPWORDS
    ]


def bigrams(tokens: List[str]) -> Set[Tuple[str, str]]:
    """Adjacent token pairs. Two texts sharing several of these are not
    coincidentally similar — they share phrasing."""
    return (
        {(tokens[i], tokens[i + 1]) for i in range(len(tokens) - 1)} if len(tokens) >= 2 else set()
    )
