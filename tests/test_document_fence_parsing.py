"""Parsing of ``` create_document / update_document fenced blocks.

These documents routinely carry Markdown that itself contains ``` code fences,
and models frequently leave the closing fence off when the document is the last
thing in a message. The generic non-greedy fenced-block regex truncated the
first case and dropped the second entirely — so the doc streamed into the
preview live but was never executed/saved and no artifact chip appeared. The
depth-aware document scanner fixes both. Pure string logic — no deps.
"""

import importlib

tp = importlib.import_module("src.tool_parsing")


def _doc_blocks(text):
    return [b for b in tp.parse_tool_blocks(text) if b.tool_type == "create_document"]


def test_unclosed_create_document_still_parses():
    # No trailing ``` — the common "create_document is the last thing" case.
    text = "Here you go:\n```create_document\nMy Title\nmarkdown\n# Heading\n\nBody text."
    blocks = _doc_blocks(text)
    assert len(blocks) == 1
    assert blocks[0].content.startswith("My Title")
    assert "Body text." in blocks[0].content


def test_nested_code_fence_not_truncated():
    text = (
        "```create_document\n"
        "Guide\n"
        "markdown\n"
        "# Guide\n"
        "```python\n"
        "print('hello')\n"
        "```\n"
        "Done.\n"
        "```\n"
        "trailing chat that is not part of the doc"
    )
    blocks = _doc_blocks(text)
    assert len(blocks) == 1
    # The inner python fence and everything up to the outer close is preserved.
    assert "print('hello')" in blocks[0].content
    assert "Done." in blocks[0].content
    assert "trailing chat" not in blocks[0].content


def test_two_documents_stay_separate():
    text = (
        "```create_document\nA\nmarkdown\nalpha\n```\n"
        "some prose\n"
        "```create_document\nB\nmarkdown\nbeta\n```"
    )
    blocks = _doc_blocks(text)
    assert [b.content.splitlines()[0] for b in blocks] == ["A", "B"]


def test_simple_closed_document_unchanged():
    text = "```create_document\nTitle\nmarkdown\nbody line\n```"
    blocks = _doc_blocks(text)
    assert len(blocks) == 1
    assert blocks[0].content == "Title\nmarkdown\nbody line"


def test_strip_removes_unclosed_document_from_chat():
    text = "Sure!\n```create_document\nMy Title\nmarkdown\n# Heading\nBody."
    cleaned = tp.strip_tool_blocks(text)
    assert "My Title" not in cleaned
    assert "# Heading" not in cleaned
    assert cleaned.strip() == "Sure!"


def test_strip_removes_nested_fence_document_but_keeps_trailing_chat():
    text = (
        "```create_document\n"
        "Guide\nmarkdown\n# Guide\n```python\nprint(1)\n```\n```\n"
        "Anything else?"
    )
    cleaned = tp.strip_tool_blocks(text)
    assert "print(1)" not in cleaned
    assert "Anything else?" in cleaned


# ── orphan tool-call markup ──


def test_orphan_tool_call_tag_is_stripped():
    """qwen3 opens `<tool_call>` and then emits the call through the native
    tool_calls field, so no closing tag ever arrives and the literal markup
    used to reach the user."""
    from src.tool_parsing import strip_tool_blocks

    out = strip_tool_blocks("Kurze Antwort.\n<tool_call>\n")
    assert "<tool_call>" not in out
    assert "Kurze Antwort." in out


def test_orphan_closing_and_namespaced_tags_are_stripped():
    from src.tool_parsing import strip_tool_blocks

    out = strip_tool_blocks("A</tool_call>B<minimax:tool_call>C</function_call>D")
    assert "tool_call" not in out and "function_call" not in out
    assert "A" in out and "D" in out


def test_balanced_tool_call_block_still_removed_entirely():
    from src.tool_parsing import strip_tool_blocks

    out = strip_tool_blocks(
        'Text.<tool_call><invoke name="bash"><parameter name="command">ls</parameter>'
        "</invoke></tool_call>"
    )
    assert "ls" not in out and "invoke" not in out
    assert out.strip() == "Text."
