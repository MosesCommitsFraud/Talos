"""
widgets.py — structured UI payloads a tool can attach to its result.

A tool answers twice. Once in prose, for the model: `output`, the text that
lands in context. Once — optionally — as a `widget`: a small typed JSON payload
that the frontend renders as a real component (a weather card, a chart) instead
of the tool row's monospace dump. The two are independent, and that is the
point. The model never reads the widget, the user never reads the payload, so
neither answer has to be bent into a shape that also works for the other: the
model's copy stays terse and factual, the user's copy stays visual.

Adding a type is three edits: build the payload (in the tool, or here), list the
name in WIDGET_TYPES, and register a component in
`web/src/components/widgets/registry.tsx`. The frontend renders nothing at all
for a type it does not know, so a backend that is ahead of the deployed bundle
degrades to the ordinary tool row rather than crashing the message list.

`sanitize_widget` is the boundary. Everything a tool hands over passes through
it before it reaches the SSE stream and the `tool_events` metadata blob, because
both of those are also replayed into the UI on session load — a payload that is
unserialisable, unbounded, or of an unknown type has to be refused once, here,
rather than at three different render sites later.
"""

import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Widget types the frontend registry knows. A tool emitting anything else is a
# bug on the emitting side, so it is dropped and logged rather than forwarded.
WIDGET_TYPES = frozenset(
    {
        "weather",
        "news",
    }
)

# A widget rides along on every tool_output event and is persisted with the
# turn, so it is bounded like any other stream payload. The cap is generous for
# a card (a 7-day forecast with 24 hourly points is ~6 KB) and far below
# anything that would bloat a session row.
MAX_WIDGET_BYTES = 64_000


def make_widget(widget_type: str, data: Dict[str, Any], version: int = 1) -> Dict[str, Any]:
    """Build a widget envelope. `version` lets a component keep rendering old
    persisted turns after its payload shape changes — bump it there, branch on
    it in the component, never silently repurpose a field."""
    return {"type": widget_type, "version": version, "data": data}


def sanitize_widget(widget: Any) -> Optional[Dict[str, Any]]:
    """Validate and normalise a widget envelope; None when it may not be sent.

    Returns a *round-tripped* copy (through json), not the tool's own dict: the
    payload is about to be serialised into an SSE frame and a database column,
    and finding out there that it holds a datetime or a numpy float means a
    broken stream mid-turn. Failing here costs the widget; failing there costs
    the whole reply.
    """
    if not isinstance(widget, dict):
        return None

    widget_type = widget.get("type")
    if not isinstance(widget_type, str) or widget_type not in WIDGET_TYPES:
        logger.warning("Dropping widget with unknown type %r", widget_type)
        return None

    data = widget.get("data")
    if not isinstance(data, dict):
        logger.warning(
            "Dropping %s widget: data is %s, not a dict", widget_type, type(data).__name__
        )
        return None

    version = widget.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        version = 1

    envelope = {"type": widget_type, "version": version, "data": data}
    try:
        encoded = json.dumps(envelope, allow_nan=False)
    except (TypeError, ValueError) as e:
        logger.warning("Dropping %s widget: payload is not JSON-serialisable (%s)", widget_type, e)
        return None

    if len(encoded.encode("utf-8")) > MAX_WIDGET_BYTES:
        logger.warning(
            "Dropping %s widget: %d bytes exceeds the %d-byte cap",
            widget_type,
            len(encoded.encode("utf-8")),
            MAX_WIDGET_BYTES,
        )
        return None

    return json.loads(encoded)
