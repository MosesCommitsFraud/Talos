"""
tool_parsing.py

Regex-based parsing of tool invocations from LLM response text.
Supports fenced code blocks, [TOOL_CALL] blocks, and XML-style <invoke> blocks.
"""

import json
import logging
import re
from typing import List, Optional

from src.agent_tools import TOOL_TAGS, ToolBlock

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

# Pattern 1: ```bash ... ``` fenced code blocks
_TOOL_BLOCK_RE = re.compile(
    r"```(" + "|".join(TOOL_TAGS) + r")\s*\n([\s\S]*?)```",
    re.IGNORECASE,
)

# Pattern 2: [TOOL_CALL] ... [/TOOL_CALL] blocks (some models use this format)
# Matches: {tool => "shell", args => {--command "ls -la"}} etc.
_TOOL_CALL_RE = re.compile(
    r"\[TOOL_CALL\]\s*\{([\s\S]*?)\}\s*\[/TOOL_CALL\]",
    re.IGNORECASE,
)

# Pattern 3: XML-style tool calls (minimax, some other models)
# <minimax:tool_call><invoke name="bash"><parameter name="command">...</parameter></invoke></minimax:tool_call>
# Also handles: <tool_call><invoke ...>, <function_call><invoke ...>, plain <invoke ...>
_XML_TOOL_CALL_RE = re.compile(
    r"<(?:[\w]+:)?(?:tool_call|function_call)>\s*([\s\S]*?)</(?:[\w]+:)?(?:tool_call|function_call)>",
    re.IGNORECASE,
)
_XML_INVOKE_RE = re.compile(
    r'<invoke\s+name=["\'](\w+)["\']>\s*([\s\S]*?)</invoke>',
    re.IGNORECASE,
)
_XML_PARAM_RE = re.compile(
    r'<parameter\s+name=["\'](\w+)["\']>([\s\S]*?)</parameter>',
    re.IGNORECASE,
)

# Pattern 4: <tool_code> blocks (MiniMax-M2.5 style)
# {tool => 'tool_name', args => '<param>value</param>'}
_TOOL_CODE_RE = re.compile(
    r"<tool_code>\s*\{([\s\S]*?)\}\s*</tool_code>",
    re.IGNORECASE,
)

# Pattern 5: DeepSeek DSML markup leaking into content. When deepseek
# models can't emit structured tool_calls (e.g. we sent no tool schemas
# that round, or the API didn't parse them), they fall back to raw
# markup using fullwidth-pipe delimiters:
#   <｜｜DSML｜｜tool_calls>
#     <｜｜DSML｜｜invoke name="web_search">
#       <｜｜DSML｜｜parameter name="query" string="true">QUERY</｜｜DSML｜｜parameter>
#     </｜｜DSML｜｜invoke>
#   </｜｜DSML｜｜tool_calls>
# We normalize it into the standard <invoke>/<parameter> form so the
# existing XML parser + stripper handle it (parse → execute; strip →
# never show the garbage to the user). The pipe run is tolerant of
# fullwidth (U+FF5C) and ascii '|' in any count.
_DSML_PIPES = r"[｜|]+"


def _normalize_dsml(text: str) -> str:
    if not isinstance(text, str):
        return ""
    if "DSML" not in text:
        return text
    t = text
    t = re.sub(
        rf"<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*tool_calls\s*>",
        "<tool_call>",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(
        rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*tool_calls\s*>",
        "</tool_call>",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(
        rf"<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*invoke\s+name=",
        "<invoke name=",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(
        rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*invoke\s*>",
        "</invoke>",
        t,
        flags=re.IGNORECASE,
    )
    # parameter open tag — drop any extra attrs (e.g. string="true").
    t = re.sub(
        rf'<\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*parameter\s+name=(["\'][^"\']+["\'])[^>]*>',
        r"<parameter name=\1>",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(
        rf"<\s*/\s*{_DSML_PIPES}\s*DSML\s*{_DSML_PIPES}\s*parameter\s*>",
        "</parameter>",
        t,
        flags=re.IGNORECASE,
    )
    return t


# Document tools stream their content into the editor panel and often carry
# Markdown that itself contains ``` code fences. The generic non-greedy
# `_TOOL_BLOCK_RE` mis-handles both: it stops at the FIRST inner ``` (truncating
# the document) and it needs a CLOSING fence at all (a create_document left
# unclosed at the end of a message — very common — is dropped entirely, so the
# document streams into the preview live but is never executed/saved and no
# artifact chip appears). Scan these fences depth-aware instead.
_DOC_FENCE_TAGS = ("create_document", "update_document", "edit_document", "suggest_document")
_DOC_FENCE_OPEN_RE = re.compile(
    r"^[ \t]*```(" + "|".join(_DOC_FENCE_TAGS) + r")[ \t]*$", re.IGNORECASE
)
_CODE_FENCE_RE = re.compile(r"^[ \t]*```([^\s`]*)[ \t]*$")


def _iter_document_fences(text: str):
    """Yield (tag, content, start_line, end_line_exclusive) for each document
    fence, tracking nested code fences so inner ``` blocks don't end the
    document early, and treating an unclosed fence as running to end-of-text."""
    lines = (text or "").split("\n")
    i = 0
    n = len(lines)
    while i < n:
        m = _DOC_FENCE_OPEN_RE.match(lines[i])
        if not m:
            i += 1
            continue
        tag = m.group(1).lower()
        start = i
        i += 1
        content_lines = []
        depth = 0
        while i < n:
            fence = _CODE_FENCE_RE.match(lines[i])
            if fence:
                lang = fence.group(1)
                if lang:  # ```lang — opens an inner code block
                    depth += 1
                    content_lines.append(lines[i])
                    i += 1
                    continue
                # bare ``` — closes an inner block, or the document block itself
                if depth > 0:
                    depth -= 1
                    content_lines.append(lines[i])
                    i += 1
                    continue
                i += 1  # depth 0: this closes the document fence
                break
            content_lines.append(lines[i])
            i += 1
        yield tag, "\n".join(content_lines).strip(), start, i


# Map model tool names to our tool types
_TOOL_NAME_MAP = {
    "shell": "bash",
    "bash": "bash",
    "terminal": "bash",
    "command": "bash",
    "execute": "bash",
    "run": "bash",
    "python": "python",
    "code": "python",
    "read": "read_file",
    "read_file": "read_file",
    "cat": "read_file",
    "write": "write_file",
    "write_file": "write_file",
    "save": "write_file",
    "document": "update_document",
    "update_document": "update_document",
    "create_document": "create_document",
    "edit": "edit_document",
    "edit_document": "edit_document",
    "search_chats": "search_chats",
    "search_conversations": "search_chats",
    "find_chat": "search_chats",
    "create_session": "create_session",
    "new_session": "create_session",
    "list_sessions": "list_sessions",
    "send_to_session": "send_to_session",
    "message_session": "send_to_session",
    "manage_session": "manage_session",
    "session_control": "manage_session",
    "list_models": "list_models",
    "models": "list_models",
    "available_models": "list_models",
    "api_call": "api_call",
    "api": "api_call",
    "integration": "api_call",
    "manage_skills": "manage_skills",
    "skills": "manage_skills",
    "skill": "manage_skills",
    "suggest_document": "suggest_document",
    "suggest": "suggest_document",
    "review_document": "suggest_document",
    "manage_endpoints": "manage_endpoints",
    "endpoints": "manage_endpoints",
    "manage_mcp": "manage_mcp",
    "mcp_servers": "manage_mcp",
    "manage_tokens": "manage_tokens",
    "tokens": "manage_tokens",
    "manage_documents": "manage_documents",
    "documents": "manage_documents",
    "manage_settings": "manage_settings",
    "settings": "manage_settings",
    "preferences": "manage_settings",
}


# ---------------------------------------------------------------------------
# Parsing functions
# ---------------------------------------------------------------------------


def _parse_tool_call_block(raw: str) -> Optional[ToolBlock]:
    """Parse a [TOOL_CALL] block into a ToolBlock.

    Handles formats like:
      {tool => "shell", args => {--command "ls -la"}}
      {tool: "shell", command: "ls -la"}
    """
    # Try to extract tool name
    tool_match = re.search(r'tool\s*(?:=>|:|=)\s*["\']?(\w+)["\']?', raw, re.IGNORECASE)
    if not tool_match:
        return None

    tool_name = tool_match.group(1).lower()
    # Fall back to the raw name when it's a real tool but not in the alias
    # map, so known tools (e.g. manage_documents) aren't silently dropped.
    mapped = _TOOL_NAME_MAP.get(tool_name) or (tool_name if tool_name in TOOL_TAGS else None)
    if not mapped:
        return None

    # Extract the command/content — try several patterns
    content = None

    # Pattern: --command "value" or --command 'value'
    cmd_match = re.search(r'--command\s+["\'](.+?)["\']', raw, re.DOTALL)
    if cmd_match:
        content = cmd_match.group(1)

    # Pattern: command => "value" or command: "value"
    if not content:
        cmd_match = re.search(r'command\s*(?:=>|:|=)\s*["\'](.+?)["\']', raw, re.DOTALL)
        if cmd_match:
            content = cmd_match.group(1)

    # Pattern: args => {content} — extract everything inside the nested braces
    if not content:
        args_match = re.search(r"args\s*(?:=>|:|=)\s*\{([\s\S]*)\}", raw, re.DOTALL)
        if args_match:
            inner = args_match.group(1).strip()
            # Strip quotes and key prefixes
            inner = re.sub(r"^--?\w+\s+", "", inner)
            inner = inner.strip("'\"")
            if inner:
                content = inner

    # Pattern: query/path/code => "value"
    if not content:
        for key in ("query", "path", "code", "content", "text", "file"):
            m = re.search(rf'{key}\s*(?:=>|:|=)\s*["\'](.+?)["\']', raw, re.DOTALL)
            if m:
                content = m.group(1)
                break

    # Last resort: take everything after the tool declaration
    if not content:
        rest = raw[tool_match.end() :].strip()
        rest = re.sub(r"^[,;]\s*", "", rest)
        rest = rest.strip("{} \t\n'\"")
        if rest:
            content = rest

    if content:
        return ToolBlock(mapped, content.strip())
    return None


def _parse_xml_invoke(inv_match) -> Optional[ToolBlock]:
    """Parse an <invoke name="tool"><parameter ...>...</parameter></invoke> match.

    Delegates content-shaping to function_call_to_tool_block — the SAME
    converter used for native function calls — so the full tool set (every
    name in TOOL_TAGS, plus MCP tools) and the correct per-tool
    content format are handled in ONE place. The previous version duplicated
    a partial, hand-maintained tool-name map plus a `key: value` serializer:
    any tool missing from that map was silently
    dropped, and JSON-arg tools got an unparseable `k: v` blob. Both bugs
    made deepseek's DSML `create_event` calls vanish with no execution.
    """
    # Lowercase the tool name: models often emit capitalized invoke names
    # (e.g. <invoke name="Bash">) and function_call_to_tool_block matches
    # case-sensitively against the lowercase _TOOL_NAME_MAP / TOOL_TAGS, so a
    # raw capitalized name would be silently dropped.
    tool_name = inv_match.group(1).lower()
    body = inv_match.group(2)
    params = {}
    for pm in _XML_PARAM_RE.finditer(body):
        params[pm.group(1)] = pm.group(2).strip()
    # Local import to avoid a circular import at module load.
    from src.tool_schemas import function_call_to_tool_block

    return function_call_to_tool_block(tool_name, json.dumps(params))


def _parse_tool_code_block(raw: str) -> Optional[ToolBlock]:
    """Parse a <tool_code>{tool => 'name', args => '...'}</tool_code> block (MiniMax style)."""
    # Extract tool name
    tool_match = re.search(r"tool\s*=>\s*['\"](\S+?)['\"]", raw)
    if not tool_match:
        return None
    tool_name = tool_match.group(1).lower().replace("-", "_")
    # Strip MCP prefixes like "mcp__server__" or "cli-mcp-server-"
    for prefix in ("mcp__", "cli_mcp_server_", "desktop_commander_", "mcp_code_executor_"):
        if tool_name.startswith(prefix):
            tool_name = tool_name[len(prefix) :]
            break

    mapped = _TOOL_NAME_MAP.get(tool_name)

    # Extract args content
    args_match = re.search(r"args\s*=>\s*['\"]?\s*([\s\S]*?)\s*['\"]?\s*$", raw, re.DOTALL)
    args_body = args_match.group(1).strip().strip("'\"") if args_match else ""

    # Parse XML params inside args (e.g. <command>ls</command>)
    xml_params = {}
    for pm in re.finditer(r"<(\w+)>([\s\S]*?)</\1>", args_body):
        xml_params[pm.group(1)] = pm.group(2).strip()

    # When the model gave structured params, hand them to the canonical
    # converter (same as native calls + <invoke>) so the full tool set and
    # correct per-tool content format apply — not a partial map + k:v blob.
    if xml_params:
        from src.tool_schemas import function_call_to_tool_block

        block = function_call_to_tool_block(mapped or tool_name, json.dumps(xml_params))
        if block:
            return block

    # No structured params: args_body is a raw single value (e.g. a bash
    # command). Keep the freeform special-casing for the simple tools.
    if mapped:
        if mapped == "bash":
            content = xml_params.get("command", args_body)
        elif mapped == "python":
            content = xml_params.get("code", args_body)
        elif mapped in ("read_file", "write_file"):
            content = xml_params.get("path", xml_params.get("file_path", args_body))
        else:
            content = (
                "\n".join(f"{k}: {v}" for k, v in xml_params.items()) if xml_params else args_body
            )
        if content:
            return ToolBlock(mapped, content.strip())
    elif tool_name and args_body:
        # Unknown tool — try as MCP tool call
        content = "\n".join(f"{k}: {v}" for k, v in xml_params.items()) if xml_params else args_body
        return ToolBlock(tool_name, content.strip())
    return None


def parse_tool_blocks(text: str) -> List[ToolBlock]:
    """Extract executable tool blocks from LLM response text.

    Supports multiple formats:
    1. ```bash ... ``` fenced code blocks (standard)
    2. [TOOL_CALL] ... [/TOOL_CALL] blocks (some models)
    3. XML-style <tool_call>/<invoke> blocks
    4. <tool_code> blocks (MiniMax-M2.5 style)
    5. DeepSeek DSML markup (normalized to <invoke> first)
    """
    blocks = []

    # Normalize DeepSeek DSML markup into standard <invoke> form so the
    # XML patterns below catch it.
    text = _normalize_dsml(text)

    # Document fences first: scanned depth-aware so Markdown documents with
    # inner ``` fences aren't truncated and an unclosed create_document at the
    # end of a message still runs (otherwise it streams to the preview but is
    # never saved as an artifact). The generic Pattern-1 pass below skips these
    # tags so it can't also emit a truncated duplicate.
    for tag, content, _s, _e in _iter_document_fences(text):
        if content:
            blocks.append(ToolBlock(tag, content))

    # Pattern 1: fenced code blocks
    for m in _TOOL_BLOCK_RE.finditer(text):
        tag = m.group(1).lower()
        if tag in _DOC_FENCE_TAGS:
            continue  # handled by the depth-aware document scanner above
        content = m.group(2).strip()
        if not content:
            continue
        # If a code block's content is an <invoke> XML call (some models wrap
        # tool calls in ```python or ```xml fences), parse the invoke instead.
        if "<invoke" in content:
            for inv in _XML_INVOKE_RE.finditer(content):
                block = _parse_xml_invoke(inv)
                if block:
                    blocks.append(block)
            # This fenced block is invoke markup, not literal code. If it cannot
            # be converted, do not fall through and execute raw XML as bash/python.
            continue
        blocks.append(ToolBlock(tag, content))

    # Pattern 2: [TOOL_CALL] blocks (only if no fenced blocks found)
    if not blocks:
        for m in _TOOL_CALL_RE.finditer(text):
            block = _parse_tool_call_block(m.group(1))
            if block:
                blocks.append(block)

    # Pattern 3: XML-style <tool_call>/<invoke> blocks
    if not blocks:
        # Try wrapped: <tool_call><invoke ...>...</invoke></tool_call>
        for m in _XML_TOOL_CALL_RE.finditer(text):
            for inv in _XML_INVOKE_RE.finditer(m.group(1)):
                block = _parse_xml_invoke(inv)
                if block:
                    blocks.append(block)
        # Try bare <invoke> without wrapper
        if not blocks:
            for inv in _XML_INVOKE_RE.finditer(text):
                block = _parse_xml_invoke(inv)
                if block:
                    blocks.append(block)

    # Pattern 4: <tool_code> blocks (MiniMax-M2.5 style)
    if not blocks:
        for m in _TOOL_CODE_RE.finditer(text):
            block = _parse_tool_code_block(m.group(1))
            if block:
                blocks.append(block)

    return blocks


def _strip_document_fences(text: str) -> str:
    """Drop document-fence regions (create_document/update_document/…) line-span
    aware, so a Markdown document with inner ``` fences — or an unclosed fence —
    is fully removed from the chat display instead of leaking its raw content."""
    spans = [(s, e) for _tag, _c, s, e in _iter_document_fences(text)]
    if not spans:
        return text
    lines = text.split("\n")
    drop = set()
    for s, e in spans:
        drop.update(range(s, e))
    return "\n".join(line for i, line in enumerate(lines) if i not in drop)


def strip_tool_blocks(text: str) -> str:
    """Remove executable tool blocks from text for clean display."""
    # Normalize DSML first so its markup gets stripped by the <invoke>
    # / <tool_call> removers below instead of leaking to the user.
    text = _normalize_dsml(text)
    # Document fences first (depth-aware; handles nested/unclosed fences the
    # generic regex below cannot), then the standard removers.
    text = _strip_document_fences(text)
    cleaned = _TOOL_BLOCK_RE.sub("", text)
    cleaned = _TOOL_CALL_RE.sub("", cleaned)
    cleaned = _XML_TOOL_CALL_RE.sub("", cleaned)
    cleaned = _TOOL_CODE_RE.sub("", cleaned)
    # Strip bare <invoke> blocks not wrapped in <tool_call>
    cleaned = re.sub(
        r'<invoke\s+name=["\'].*?</invoke>', "", cleaned, flags=re.DOTALL | re.IGNORECASE
    )
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()
