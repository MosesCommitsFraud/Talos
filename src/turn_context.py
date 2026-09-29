"""Per-turn context that must sit at the END of the prompt, not the start.

vLLM's prefix cache reuses the prompt from token 0 up to the first byte that
differs from the previous request. Anything that changes every turn — the
clock, the database-mode note — therefore has to come after the conversation
history, or every turn re-prefills the whole chat. This module carries those
notes as one user-role message placed directly before the current question.

It is deliberately a user turn, not a system message: providers need a single
leading system turn, so a system message anywhere else is either hoisted to the
front (cache miss) or rejected outright (Qwen3.5+).
"""

from typing import Dict, List, Optional

TURN_CONTEXT_SOURCE = "turn context"
# Metadata source of the RAG figure rule, which rides along with the retrieved
# sections into the current turn (see routes/chat_helpers.build_chat_context).
FIGURE_RULE_SOURCE = "figure rule"
_HEADER = "[Context for this message — from the system, not written by the user]"


def turn_context_message(*parts: Optional[str]) -> Optional[Dict]:
    """Build the turn-context message from the non-empty parts, or None."""
    body = "\n\n".join(p.strip() for p in parts if p and p.strip())
    if not body:
        return None
    return {
        "role": "user",
        "content": f"{_HEADER}\n\n{body}",
        "metadata": {"source": TURN_CONTEXT_SOURCE},
    }


def insert_before_last_user(messages: List[Dict], msg: Optional[Dict]) -> List[Dict]:
    """Insert `msg` right before the last user message (appended if there is none).

    Mutates and returns `messages`.
    """
    if not msg:
        return messages
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            messages.insert(i, msg)
            return messages
    messages.append(msg)
    return messages
