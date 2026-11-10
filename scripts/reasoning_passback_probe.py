#!/usr/bin/env python3
"""Does the model server's chat template use reasoning that is passed back?

Talos can send an assistant step's reasoning back with the conversation
(setting ``reasoning_passback``). Whether that reaches the model depends on the
server's chat template: it has to render the field into the prompt. This script
renders a made-up two-turn conversation through the template and reports, for
each field name in use, which steps' reasoning ended up in the prompt.

Only ``/tokenize`` and ``/detokenize`` are called. Nothing is generated, so it
is safe to run against a busy server.

Usage:
    python scripts/reasoning_passback_probe.py http://host:8000 qwen3-llm
    python scripts/reasoning_passback_probe.py http://host:8000 qwen3-llm --show

Reading the result:
* "none" for every field: the template drops passed-back reasoning. Switching
  ``reasoning_passback`` on changes nothing for this model.
* reasoning kept for the steps of the turn in flight only: the template keeps
  it between the tool calls of one turn and drops it afterwards.
* reasoning kept for all steps: the template keeps every turn's reasoning. That
  is the case ``reasoning_passback`` is built for.

Exit code: 0 if some field is rendered, 1 if none is, 2 if the server could not
be queried.
"""

from __future__ import annotations

import argparse
import json
import sys

import httpx

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "Look something up.",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        },
    }
]

# Marker text per step, in conversation order.
STEPS = {
    "REASON-T1-ROUND1": "turn 1, tool step",
    "REASON-T1-FINAL": "turn 1, answer",
    "REASON-T2-ROUND1": "turn 2 (in flight), tool step 1",
    "REASON-T2-ROUND2": "turn 2 (in flight), tool step 2",
}


def conversation(field: str | None) -> list[dict]:
    """Two turns; the second is in flight after two tool steps."""

    def assistant(content, reasoning, calls=None):
        message = {"role": "assistant", "content": content}
        if field:
            message[field] = reasoning
        if calls:
            message["tool_calls"] = calls
        return message

    def call(i):
        return [
            {
                "id": f"c{i}",
                "type": "function",
                "function": {"name": "lookup", "arguments": json.dumps({"q": f"q{i}"})},
            }
        ]

    return [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "TURN1-QUESTION"},
        assistant(None, "REASON-T1-ROUND1", call(1)),
        {"role": "tool", "tool_call_id": "c1", "content": "RESULT1"},
        assistant("TURN1-ANSWER", "REASON-T1-FINAL"),
        {"role": "user", "content": "TURN2-QUESTION"},
        assistant(None, "REASON-T2-ROUND1", call(2)),
        {"role": "tool", "tool_call_id": "c2", "content": "RESULT2"},
        assistant(None, "REASON-T2-ROUND2", call(3)),
        {"role": "tool", "tool_call_id": "c3", "content": "RESULT3"},
    ]


def render(base: str, model: str, messages: list[dict]) -> tuple[str, int]:
    body = {"model": model, "messages": messages, "tools": TOOLS, "add_generation_prompt": True}
    tokenized = httpx.post(f"{base}/tokenize", json=body, timeout=30)
    tokenized.raise_for_status()
    tokens = tokenized.json()["tokens"]
    text = httpx.post(f"{base}/detokenize", json={"model": model, "tokens": tokens}, timeout=30)
    text.raise_for_status()
    return text.json()["prompt"], len(tokens)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("url", help="server base URL, e.g. http://host:8000")
    parser.add_argument("model", help="served model name")
    parser.add_argument("--show", action="store_true", help="print the rendered prompts")
    args = parser.parse_args()
    base = args.url.rstrip("/").removesuffix("/v1")

    rendered_any = False
    for field in (None, "reasoning", "reasoning_content"):
        try:
            prompt, count = render(base, args.model, conversation(field))
        except httpx.HTTPError as exc:
            print(f"The server could not be queried: {exc}", file=sys.stderr)
            return 2
        kept = [label for marker, label in STEPS.items() if marker in prompt]
        name = f"field `{field}`" if field else "no reasoning sent"
        print(f"{name}: {count} prompt tokens")
        if field:
            print("  reasoning in the prompt: " + ("; ".join(kept) if kept else "none"))
            rendered_any = rendered_any or bool(kept)
        if args.show:
            print("  --- rendered prompt ---")
            print(prompt)
            print("  --- end ---")
    return 0 if rendered_any else 1


if __name__ == "__main__":
    sys.exit(main())
