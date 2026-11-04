"""Whether a turn's knowledge lookups still turn up anything new.

The loop-breaker in agent_loop only sees identical tool calls. A model that keeps
rewording a search it can't satisfy never repeats a call, so it rides on for many
rounds and pays for the same passages each time. What counts here is the result: a
round of knowledge lookups that delivers no passage or text the turn hasn't seen.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Set

KNOWLEDGE_LOOKUP_TOOLS = frozenset(
    {"search_knowledge", "read_knowledge", "grep_knowledge", "list_knowledge"}
)
# One miss is normal and a reworded retry can land; a third round without anything
# new means the knowledge base doesn't have it.
DRY_ROUND_LIMIT = 3

STOP_SEARCHING_NOTE = (
    "Your last knowledge lookups found nothing new. STOP looking things up and write the "
    "answer now from the passages you already have. For any part they don't cover, say "
    "plainly that it is not stored in the knowledge base; do not fill it from general "
    "knowledge."
)


def _source_key(source: Dict[str, Any]) -> str:
    return str(source.get("_id") or (source.get("filename"), (source.get("snippet") or "")[:80]))


class KnowledgeProgress:
    def __init__(self, limit: int = DRY_ROUND_LIMIT):
        self.limit = limit
        self.dry_rounds = 0
        self._seen: Set[str] = set()
        self._new_this_round = False
        self._looked_up_this_round = False
        self._other_tool_this_round = False

    def observe(self, tool: str, result: Dict[str, Any]) -> None:
        if tool not in KNOWLEDGE_LOOKUP_TOOLS:
            self._other_tool_this_round = True
            return
        self._looked_up_this_round = True
        if result.get("error") or result.get("no_hits"):
            return
        keys = {_source_key(s) for s in result.get("rag_sources") or []}
        if not keys:
            # Outlines and term lookups list text without numbered sources.
            digest = hashlib.sha1(str(result.get("output") or "").encode("utf-8")).hexdigest()
            keys = {f"text:{digest}"}
        if keys - self._seen:
            self._new_this_round = True
        self._seen |= keys

    def end_round(self) -> bool:
        """Close the round; True once the turn should stop looking things up."""
        dry = self._looked_up_this_round and not self._new_this_round
        if dry and not self._other_tool_this_round:
            self.dry_rounds += 1
        elif self._looked_up_this_round or self._other_tool_this_round:
            self.dry_rounds = 0
        self._new_this_round = False
        self._looked_up_this_round = False
        self._other_tool_this_round = False
        return self.dry_rounds >= self.limit
