"""Reminders for a model that keeps making the same tool call.

A model stuck on one call re-issues it with the same arguments: the failing
search again, the unchanged file again. Each repeat costs a round and adds
nothing. The reminders here are advice the model reads after the repeated
call's result. They never stop a call: polling something on purpose stays
possible, and the choice between another approach and finishing is the model's.
The loop-breaker in agent_loop is the backstop for a model that ignores them.

Two calls are the same when the tool and its complete arguments match. Comparing
only the start of the arguments would count two scripts with the same imports,
or two queries with the same SELECT list, as one call.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional, Tuple

# Consecutive identical calls at which a reminder is sent: a short one first,
# then one that names the call.
REMINDER_THRESHOLDS: Tuple[int, ...] = (3, 5)

# Bookkeeping tools neither count nor break a chain, so a plan update between
# two identical searches does not hide the repetition.
UNTRACKED_TOOLS = frozenset({"update_plan"})

# How much of the repeated arguments the detailed reminder quotes.
ARGUMENTS_PREVIEW_CHARS = 500

GENTLE_REMINDER = (
    "You have made the same tool call with the same arguments several times in a "
    "row. Read the last result carefully before calling again. If the task is not "
    "done, try a different approach or different arguments instead of repeating "
    "the call."
)


def detailed_reminder(tool: str, count: int, arguments: str) -> str:
    preview = arguments.strip()
    if len(preview) > ARGUMENTS_PREVIEW_CHARS:
        preview = preview[:ARGUMENTS_PREVIEW_CHARS] + " …"
    return (
        "Repeated tool call:\n"
        f"- tool: {tool}\n"
        f"- calls in a row: {count}\n"
        f"- arguments: {preview}\n"
        "These calls are not getting you further. Do not make this call with these "
        "arguments again. Look at the latest result and choose a different action "
        "or different arguments, or finish with what you have if it is enough."
    )


def call_signature(block: Any) -> str:
    """Identity of a tool call: the tool and its complete arguments."""
    content = (getattr(block, "content", "") or "").strip()
    digest = hashlib.sha1(content.encode("utf-8", "replace")).hexdigest()
    return f"{getattr(block, 'tool_type', '')}:{digest}"


class RepeatGuard:
    """Counts consecutive identical calls of one agent turn."""

    def __init__(self, thresholds: Tuple[int, ...] = REMINDER_THRESHOLDS):
        self.thresholds = tuple(sorted(thresholds))
        self.reminders_sent = 0
        self._last: Optional[str] = None
        self._run = 0

    def reset(self) -> None:
        """A message from the user changes the situation: what follows is not
        a continuation of the same loop."""
        self._last = None
        self._run = 0

    def observe(self, block: Any) -> Optional[str]:
        """Record one executed call. Returns a reminder when its repeat count
        reaches a threshold."""
        tool = getattr(block, "tool_type", "")
        if tool in UNTRACKED_TOOLS:
            return None
        signature = call_signature(block)
        if signature == self._last:
            self._run += 1
        else:
            self._last = signature
            self._run = 1
        if self._run not in self.thresholds:
            return None
        self.reminders_sent += 1
        if self._run == self.thresholds[0]:
            return GENTLE_REMINDER
        return detailed_reminder(tool, self._run, getattr(block, "content", "") or "")
