"""A goal: one objective a chat keeps working on, round after round.

A normal turn ends when the model stops. A goal says "keep going until this is
done": after each turn another one starts with the same objective, until the
model reports it complete, reports what blocks it, the round limit is reached,
or the user pauses.

What is kept here, per chat, is the part that has to be right and has to
survive a reload: the objective, how many rounds it has had, and how it ended.
The model does not end a goal by writing a magic word in its answer. It calls
`update_goal`, and that call has rules:

* complete needs evidence — what shows the whole objective is achieved;
* blocked is only accepted once the same obstacle has stood for
  BLOCKED_AFTER_ROUNDS rounds. Difficult, uncertain or "more could be done" is
  not blocked.

Who starts the next round: the chat page, which asks for a "goal round"
instead of sending text. The round's wording, its number and the limit come
from here, not from the client. A goal found active after a reload is not
continued on its own: opening a chat is looking at it, not permission to spend
the model's time. The user resumes it.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "goals.json")
_lock = threading.Lock()

ACTIVE = "active"
PAUSED = "paused"
BLOCKED = "blocked"
COMPLETE = "complete"
STATUSES = (ACTIVE, PAUSED, BLOCKED, COMPLETE)

DEFAULT_MAX_ROUNDS = 256
# A blocker has to persist this many rounds before the model may report it.
BLOCKED_AFTER_ROUNDS = 3
OBJECTIVE_MAX_CHARS = 4000

# Ways a turn can end (agent_loop.STOP_REASONS) after which another round would
# only run into the same wall. The goal is blocked with the reason as its code.
_BLOCKING_STOP_REASONS = {
    "model_error": "The call to the model failed.",
    "context_overflow": "The conversation no longer fits the model's context window.",
    "agent_stalled": "The model kept returning nothing.",
    "output_truncated": "The answer was cut off at the output length limit.",
    "budget_exceeded": "The tool call limit was reached.",
}


class GoalError(ValueError):
    """A goal operation that cannot be carried out; the message says why."""


def max_rounds_setting() -> int:
    """Round limit for new goals (setting `goal_max_rounds`, 0 = no limit)."""
    try:
        from src.settings import get_setting

        value = int(get_setting("goal_max_rounds", DEFAULT_MAX_ROUNDS) or 0)
    except Exception:
        return DEFAULT_MAX_ROUNDS
    return max(0, min(value, 10_000))


def _load() -> Dict[str, Dict[str, Any]]:
    try:
        with open(_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        logger.warning("Could not read %s: %s", _PATH, exc)
        return {}


def _save(data: Dict[str, Dict[str, Any]]) -> None:
    atomic_write_json(_PATH, data, indent=2)


def _public(goal: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return dict(goal) if goal else None


def get(session_id: str) -> Optional[Dict[str, Any]]:
    """The chat's goal, whatever its status, or None."""
    if not session_id:
        return None
    with _lock:
        return _public(_load().get(session_id))


def is_active(session_id: str) -> bool:
    goal = get(session_id)
    return bool(goal and goal["status"] == ACTIVE)


def create(session_id: str, objective: str) -> Dict[str, Any]:
    """Set the chat's goal. Replaces a goal that has ended; a running one has
    to be cleared first, so two objectives never compete."""
    text = " ".join(str(objective or "").split())
    if not text:
        raise GoalError("A goal needs an objective.")
    if len(text) > OBJECTIVE_MAX_CHARS:
        raise GoalError(f"The objective is too long (at most {OBJECTIVE_MAX_CHARS} characters).")
    now = time.time()
    with _lock:
        data = _load()
        current = data.get(session_id)
        if current and current.get("status") in (ACTIVE, PAUSED):
            raise GoalError("This chat already has a goal. Clear it before setting a new one.")
        goal = {
            "objective": text,
            "status": ACTIVE,
            "round": 0,
            "max_rounds": max_rounds_setting(),
            "created_at": now,
            "updated_at": now,
            "reason_code": "",
            "reason": "",
            "evidence": "",
        }
        data[session_id] = goal
        _save(data)
        return _public(goal)


def _change(session_id: str, mutate) -> Dict[str, Any]:
    with _lock:
        data = _load()
        goal = data.get(session_id)
        if not goal:
            raise GoalError("This chat has no goal.")
        mutate(goal)
        goal["updated_at"] = time.time()
        _save(data)
        return _public(goal)


def pause(session_id: str) -> Dict[str, Any]:
    def mutate(goal):
        if goal["status"] != ACTIVE:
            raise GoalError("Only a running goal can be paused.")
        goal["status"] = PAUSED

    return _change(session_id, mutate)


def resume(session_id: str) -> Dict[str, Any]:
    """Continue a paused or blocked goal. Resuming at the round limit grants
    one more stretch of the same length, since the user asked for more."""

    def mutate(goal):
        if goal["status"] not in (PAUSED, BLOCKED):
            raise GoalError("Only a paused or blocked goal can be resumed.")
        if goal.get("reason_code") == "round-limit" and goal.get("max_rounds"):
            goal["max_rounds"] = goal["round"] + max(max_rounds_setting(), 1)
        goal.update(status=ACTIVE, reason_code="", reason="")

    return _change(session_id, mutate)


def clear(session_id: str) -> None:
    with _lock:
        data = _load()
        if data.pop(session_id, None) is not None:
            _save(data)


def begin_round(session_id: str) -> str:
    """Count one more round and return the message that starts it.

    Raises GoalError when no round may start; reaching the round limit blocks
    the goal, which the caller reports instead of running a turn.
    """
    limit_hit = False

    def mutate(goal):
        nonlocal limit_hit
        if goal["status"] != ACTIVE:
            raise GoalError(f"The goal is {goal['status']}, not running.")
        limit = int(goal.get("max_rounds") or 0)
        if limit and goal["round"] >= limit:
            goal.update(
                status=BLOCKED,
                reason_code="round-limit",
                reason=f"The limit of {limit} rounds was reached.",
            )
            limit_hit = True
            return
        goal["round"] += 1

    goal = _change(session_id, mutate)
    if limit_hit:
        raise GoalError(goal["reason"])
    return round_prompt(goal)


def round_prompt(goal: Dict[str, Any]) -> str:
    """What the model reads at the start of a goal round."""
    limit = int(goal.get("max_rounds") or 0)
    counter = f"{goal['round']}/{limit}" if limit else str(goal["round"])
    first = goal["round"] <= 1
    lead = (
        "Work toward this objective on your own until it is achieved."
        if first
        else "Continue working toward the objective in this same chat."
    )
    return (
        "<goal_round>\n"
        f"Objective: {json.dumps(goal['objective'], ensure_ascii=False)}\n"
        f"Round: {counter}\n\n"
        f"{lead} What counts is the current state of the files, data and tool results, "
        "not what an earlier message said about them: look before you rely on it. Make "
        "concrete progress this round and check the result.\n\n"
        "When the WHOLE objective is achieved and you have checked that it is, call "
        "`update_goal` with action `complete` and say in `evidence` what shows it. If work "
        "remains, do not call it: end the round by stating what you did and what comes "
        "next, and another round follows. Report `blocked` only when the same obstacle "
        f"has stopped you for {BLOCKED_AFTER_ROUNDS} rounds; a hard, uncertain or "
        "unfinished task is not blocked. Ask the user only for something you cannot find "
        "out or decide yourself.\n"
        "</goal_round>"
    )


def report(session_id: str, action: str, evidence: str = "", reason: str = "") -> Dict[str, Any]:
    """The model's `update_goal` call. Returns a tool result dict."""
    action = str(action or "").strip().lower()
    evidence = str(evidence or "").strip()
    reason = str(reason or "").strip()
    if action not in ("complete", "blocked"):
        return {"error": 'update_goal: action must be "complete" or "blocked".', "exit_code": 1}
    goal = get(session_id)
    if not goal or goal["status"] != ACTIVE:
        return {"error": "There is no running goal in this chat.", "exit_code": 1}

    if action == "complete":
        if not evidence:
            return {
                "error": "update_goal: `evidence` is required for complete — say what you "
                "checked that shows the whole objective is achieved. If you have not "
                "checked yet, do that first.",
                "exit_code": 1,
            }
        goal = _change(session_id, lambda g: g.update(status=COMPLETE, evidence=evidence[:4000]))
        return {
            "output": (
                "The goal is marked complete and this run ends here. Write the closing "
                "message to the user now: the outcome, what was done and how you checked "
                "it, and where the results are (files, documents, numbers). Report only "
                "what this chat's tool results actually show; if something is not there, "
                "say so. Name anything the user should look at or decide next. Do not call "
                "any more tools."
            ),
            "exit_code": 0,
            "goal": goal,
        }

    if not reason:
        return {
            "error": "update_goal: `blocked_reason` is required for blocked — the concrete "
            "obstacle, what you tried, and what you need from the user.",
            "exit_code": 1,
        }
    if goal["round"] < BLOCKED_AFTER_ROUNDS:
        return {
            "error": (
                f"update_goal: blocked is only accepted after {BLOCKED_AFTER_ROUNDS} rounds "
                f"with the same obstacle; this is round {goal['round']}. Try another way, or "
                "end the round saying what stops you and what you will try next."
            ),
            "exit_code": 1,
        }
    goal = _change(
        session_id,
        lambda g: g.update(status=BLOCKED, reason_code="reported", reason=reason[:4000]),
    )
    return {
        "output": (
            "The goal is marked blocked and this run ends here. Write the closing message "
            "to the user now: what is finished so far, the concrete obstacle and what you "
            "tried, and exactly what you need from them to continue. Do not call any more "
            "tools."
        ),
        "exit_code": 0,
        "goal": goal,
    }


def settle_turn(
    session_id: str, stop_reason: str = "", stopped_by_user: bool = False
) -> Optional[Dict[str, Any]]:
    """Called when a goal round's turn has ended. Returns the goal as it stands.

    A turn the user stopped pauses the goal. A turn that ended on an error
    blocks it with the stop reason as its code: starting another round would
    only repeat the failure. A turn that simply ended leaves the goal running,
    and the next round follows.
    """
    goal = get(session_id)
    if not goal or goal["status"] != ACTIVE:
        return goal
    if stopped_by_user:
        return _change(session_id, lambda g: g.update(status=PAUSED))
    if stop_reason in _BLOCKING_STOP_REASONS:
        return _change(
            session_id,
            lambda g: g.update(
                status=BLOCKED,
                reason_code=stop_reason.replace("_", "-"),
                reason=_BLOCKING_STOP_REASONS[stop_reason],
            ),
        )
    return goal
