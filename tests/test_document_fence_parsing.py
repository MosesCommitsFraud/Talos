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
