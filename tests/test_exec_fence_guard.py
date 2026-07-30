"""Tests for the documentation guard on executable fences (``src.tool_parsing``).

A ```bash fence inside a written answer is documentation, not a tool call. The
regression this guards against: a "how do I set up a DGX Spark with Qwen3.6"
answer contained ~15 ```bash blocks of instructions for the USER'S machine, and
every one of them was submitted to the sandbox for execution.
"""

import pytest

from src.tool_parsing import looks_like_documentation, parse_tool_blocks, strip_tool_blocks


def _types(blocks):
    return [b.tool_type for b in blocks]


# ── A real tool round still executes ──


def test_single_bash_call_executes():
    blocks = parse_tool_blocks("Let me check the files.\n\n```bash\nls -la output/\n```")
    assert _types(blocks) == ["bash"]


def test_two_calls_with_short_prose_execute():
    text = "First the listing, then the row count.\n\n```bash\nls -la\n```\n\n```bash\nwc -l data.csv\n```"
    assert _types(parse_tool_blocks(text)) == ["bash", "bash"]


def test_python_call_executes():
    assert _types(parse_tool_blocks("```python\nprint(1 + 1)\n```")) == ["python"]


# ── Documentation is suppressed ──


def test_many_exec_fences_are_documentation():
    text = "\n\n".join(f"```bash\nstep {i}\n```" for i in range(6))
    assert parse_tool_blocks(text) == []


def test_headed_guide_is_documentation():
    text = """Here is how to set it up.

## 1. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

## 2. Pull the model

```bash
ollama pull qwen3.6:27b
```
"""
    assert parse_tool_blocks(text) == []


def test_table_answer_is_documentation():
    text = """| Model | Size |
|---|---|
| Qwen3.6-27B | 56 GB |

```bash
vllm serve Qwen/Qwen3.6-27B
```
"""
    assert parse_tool_blocks(text) == []


def test_shell_comments_do_not_count_as_headings():
    """`# Install the package` inside a bash block is a comment, not a Markdown
    heading — a legitimate one-command round must survive it."""
    text = "```bash\n# install the parser we need\npip install openpyxl\n```"
    assert _types(parse_tool_blocks(text)) == ["bash"]


# ── Native mode: exec fences are never tool calls ──


def test_native_mode_drops_exec_fences():
    text = "Running the listing now.\n\n```bash\nls -la\n```"
    assert _types(parse_tool_blocks(text)) == ["bash"]
    assert parse_tool_blocks(text, allow_exec_fences=False) == []


def test_native_mode_keeps_non_exec_fences():
    """A model that fumbles the native channel shouldn't lose its document."""
    text = "```create_document\nNotes\nmarkdown\nHello world\n```"
    blocks = parse_tool_blocks(text, allow_exec_fences=False)
    assert _types(blocks) == ["create_document"]


def test_native_mode_keeps_file_tools():
    text = "```read_file\nreport.txt\n```"
    assert _types(parse_tool_blocks(text, allow_exec_fences=False)) == ["read_file"]


# ── The heuristic itself ──


@pytest.mark.parametrize(
    "text,count,expected",
    [
        ("plain prose", 0, False),
        ("```bash\nls\n```", 1, False),
        ("## Setup\n\n```bash\nls\n```", 1, True),
        ("| a | b |\n|---|---|\n\n```bash\nls\n```", 1, True),
        ("no structure at all", 3, True),
    ],
)
def test_looks_like_documentation(text, count, expected):
    assert looks_like_documentation(text, count) is expected


# ── Suppressed fences must stay VISIBLE ──
#
# parse_tool_blocks and strip_tool_blocks have to make the same call. If they
# disagree, the user gets the setup guide with every command block deleted out
# of it — a worse outcome than executing them.


def test_suppressed_fences_are_kept_in_the_displayed_answer():
    text = """Here is how to set it up.

## 1. Install Ollama

```bash
ollama pull qwen3.6:27b
```

## 2. Serve it

```bash
vllm serve Qwen/Qwen3.6-27B
```
"""
    assert parse_tool_blocks(text) == []
    shown = strip_tool_blocks(text)
    assert "ollama pull qwen3.6:27b" in shown
    assert "vllm serve Qwen/Qwen3.6-27B" in shown
    assert "## 1. Install Ollama" in shown


def test_suppressed_fences_kept_in_native_mode_too():
    text = "Run this on the Spark:\n\n```bash\nollama pull qwen3.6:27b\n```"
    assert parse_tool_blocks(text, allow_exec_fences=False) == []
    assert "ollama pull qwen3.6:27b" in strip_tool_blocks(text, allow_exec_fences=False)


def test_executed_fences_are_still_stripped_from_display():
    """The unchanged path: a fence that RAN is work-in-progress, not answer."""
    text = "Let me look.\n\n```bash\nls -la\n```"
    assert _types(parse_tool_blocks(text)) == ["bash"]
    assert "ls -la" not in strip_tool_blocks(text)


def test_non_exec_fences_are_stripped_even_when_exec_fences_survive():
    text = """## Guide

```bash
ollama pull qwen3.6:27b
```

```read_file
notes.txt
```

```bash
vllm serve X
```
"""
    shown = strip_tool_blocks(text)
    assert "ollama pull qwen3.6:27b" in shown
    assert "notes.txt" not in shown


def test_documentation_guard_ignores_zero_exec_fences():
    """Prose with headings and no exec fence must not be flagged — otherwise
    the guard would start suppressing things it was never meant to see."""
    assert looks_like_documentation("## Heading\n\nSome prose.", 0) is False
