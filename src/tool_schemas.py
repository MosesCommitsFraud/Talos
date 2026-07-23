"""
tool_schemas.py

OpenAI-compatible function tool schemas and the converter that turns
native function calls back into ToolBlocks for the execution pipeline.

Extracted from agent_tools.py to keep schema definitions separate from
tool parsing / execution logic.
"""

import json
import logging
from typing import Optional

from src.agent_tools import TOOL_TAGS, ToolBlock
from src.tool_parsing import _TOOL_NAME_MAP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# OpenAI-compatible function tool schemas
# ---------------------------------------------------------------------------
FUNCTION_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command in your private workspace to produce work results: file inspection/processing, data analysis, document/spreadsheet/PDF/chart generation, SQL, calculations, running scripts. The ONLY allowed installs are Python libraries via `pip install` needed for the current task — sudo, system package managers (apt/dpkg/...), docker/services, and system inspection commands are rejected by policy. Setup/infrastructure how-tos are questions about the USER'S machine: answer them in text, never execute them here. To run inline Python use the `python` tool. To create or edit files use write_file/edit_file, not shell redirects.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to execute"}
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "python",
            "description": "Execute Python code to compute a result or check something in the isolated workspace. For charts, save the finished image to a relative workspace path and call `show_image`; images under `output/` are also shown automatically. Do not save deliverables under /tmp or absolute paths.",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string", "description": "Python code to execute"}},
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_cell",
            "description": "Run Python in a PERSISTENT session (like a Jupyter notebook): variables, imports, and loaded data PERSIST between calls. For one-off computations use the `python` tool; reach for run_cell only for MULTI-STEP data analysis where keeping data in memory between steps saves real work (load a dataset once, then explore/transform/plot it across cells without reloading). State persists until the chat ends or you reset it. For charts, save to an `output/` path or call show_image.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python code to run in the persistent kernel",
                    }
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_image",
            "description": "Display an image from your workspace to the user in the chat (rendered inline, click-to-enlarge, with a download button). Use this to PRESENT a finished chart/plot/diagram/visual result. Workflow: first save the image with python (e.g. seaborn/matplotlib `fig.savefig('chart.png')`), then call show_image with that path. The path must be INSIDE your workspace — use a relative path like 'chart.png' or 'output/chart.png', never /tmp or absolute paths. Supports png/jpg/gif/webp/bmp/svg. Call once per image.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the image file to display",
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional short caption shown beneath the image",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_sql",
            "description": "Read-only access to the configured external SQL database. Use for database questions, schema/table inspection, metrics, reports, and SELECT queries. Credentials are loaded by the backend from environment variables and are never needed in the prompt.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list_tables", "describe", "query"],
                        "description": "Operation to perform",
                    },
                    "table": {"type": "string", "description": "Table name for describe"},
                    "query": {
                        "type": "string",
                        "description": "Read-only SQL statement for action=query",
                    },
                    "max_rows": {
                        "type": "integer",
                        "description": "Optional maximum result rows to return. Omit or pass 0 for no row limit.",
                    },
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from disk. Optionally read a line range with offset/limit for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"},
                    "offset": {
                        "type": "integer",
                        "description": "1-based line to start reading from (optional)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of lines to read from offset (optional)",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search file contents for a regular expression across a directory tree (uses ripgrep when available, respecting .gitignore). Returns file:line:match. PREFER this over `bash grep/rg` for code search — confined to the allowed roots, structured output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for",
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory or file to search (optional; defaults to the project root)",
                    },
                    "glob": {
                        "type": "string",
                        "description": "Only search files matching this glob, e.g. '*.py' (optional)",
                    },
                    "ignore_case": {
                        "type": "boolean",
                        "description": "Case-insensitive match (optional)",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Max matches to return (optional)",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Find files by glob pattern (recursive), newest first. e.g. '**/*.py'. PREFER this over `bash find/ls` for locating files — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern, e.g. '**/*.ts' or 'src/**/test_*.py'",
                    },
                    "path": {
                        "type": "string",
                        "description": "Base directory (optional; defaults to the project root)",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ls",
            "description": "List the entries of a directory (folders first, then files with sizes). PREFER this over `bash ls` — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory to list (optional; defaults to the project root)",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write/save a file to disk",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to write to"},
                    "content": {"type": "string", "description": "File content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file ON DISK by exact string replacement — the right way to FIX or change code/files without rewriting them (PREFER this over write_file for any change to an existing file; it's faster and shows a diff). NOT edit_document (that's for editor-panel docs). Two modes: (1) single edit via old_string/new_string, or (2) MULTIPLE edits in one call via `edits` (an array of {target, replacement}) — use this to fix several spots at once. Each target must match the file exactly and be unique unless you set replace_all/allow_multiple. Use write_file only to CREATE a new file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to edit"},
                    "old_string": {
                        "type": "string",
                        "description": "Single-edit mode: exact text to replace (must match the file, including indentation)",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Single-edit mode: replacement text",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace all occurrences of old_string instead of requiring a unique match",
                    },
                    "edits": {
                        "type": "array",
                        "description": "Multi-edit mode: list of independent find/replace edits applied in order. Use to fix several places in one call.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "target": {
                                    "type": "string",
                                    "description": "Exact text to find (match the file exactly, including indentation)",
                                },
                                "replacement": {
                                    "type": "string",
                                    "description": "Replacement text",
                                },
                                "start_line": {
                                    "type": "integer",
                                    "description": "Optional 1-indexed line to start the search (scopes the match)",
                                },
                                "end_line": {
                                    "type": "integer",
                                    "description": "Optional 1-indexed inclusive line to end the search",
                                },
                                "allow_multiple": {
                                    "type": "boolean",
                                    "description": "Allow replacing multiple matches of this target",
                                },
                            },
                            "required": ["target", "replacement"],
                        },
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": "Create a new document in the editor panel. Use this when the user asks to write, create, build, or generate code, scripts, programs, games, apps, or any substantial content (>15 lines) AND there is no already-open document/email draft that the request refers to. If an email compose draft is open, edit that draft instead of creating another document. NEVER put large code blocks directly in chat — use this tool instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short, topic-specific human title used as the artifact filename. Never use Untitled, Document, an internal ID, or a generic label such as Code.",
                    },
                    "language": {
                        "type": "string",
                        "description": "Programming language or format (e.g. python, javascript, markdown, text)",
                    },
                    "content": {"type": "string", "description": "The document content"},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_document",
            "description": "Edit a document OPEN IN THE EDITOR PANEL (created via create_document) — NOT a file on disk. For files on disk (home folder, project files, anything with a path like ~/x.txt or /path/to/file) use edit_file instead. Targeted find-and-replace with multiple FIND/REPLACE pairs per call; use for any edit smaller than a full rewrite. Do NOT send the whole file back via update_document for small edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "description": "List of find/replace edits (first match only per edit)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {
                                    "type": "string",
                                    "description": "Exact text to find in the document",
                                },
                                "replace": {
                                    "type": "string",
                                    "description": "Text to replace it with",
                                },
                            },
                            "required": ["find", "replace"],
                        },
                    }
                },
                "required": ["edits"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_document",
            "description": "Suggest improvements to the active document WITHOUT editing it. Creates inline comment bubbles the user can accept or reject. Use when the user asks for suggestions, review, improvements, or feedback.",
            "parameters": {
                "type": "object",
                "properties": {
                    "suggestions": {
                        "type": "array",
                        "description": "List of suggested changes with reasons",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {
                                    "type": "string",
                                    "description": "Exact text in the document to suggest changing",
                                },
                                "replace": {
                                    "type": "string",
                                    "description": "Suggested replacement text",
                                },
                                "reason": {
                                    "type": "string",
                                    "description": "Brief explanation of why this change helps",
                                },
                            },
                            "required": ["find", "replace", "reason"],
                        },
                    }
                },
                "required": ["suggestions"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_document",
            "description": "Replace the ENTIRE active document. ONLY use for genuine full rewrites (>50% of lines changed). For any smaller change, use edit_document — echoing back the whole file for small edits is wasteful.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Complete new document content"}
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "expand_output",
            "description": "Retrieve the FULL original of a compressed tool output. Large tool outputs are automatically compressed before reaching you, with a marker like [Output compressed ... id `out_xxxxxxxx`]. Call this with that id to read the omitted details — optionally pass a search term to find specific lines, or a page number to page through it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stored output id from the compression marker, e.g. out_3fa9c2ab",
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional: a search term to return only matching lines (with context), or a page number to page through the full text",
                    },
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_chats",
            "description": "Search the user's past chat conversations by keyword. Use when the user asks about previous chats, past conversations, or wants to find a discussion they had before. Returns matching sessions with clickable links.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search keyword(s) to find in past conversations",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_session",
            "description": "Create a new chat for ongoing conversations with a specific model. (The UI calls these 'chats'; 'session' is the internal term.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the new chat"},
                    "model": {"type": "string", "description": "Model name or model@endpoint_name"},
                },
                "required": ["name", "model"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_sessions",
            "description": "List the user's chats (the UI calls them 'chats') as clickable markdown links. Use this to enumerate chats before opening, renaming, archiving, or deleting them. When replying to the user, preserve the returned [title](#session-id) links; do not strip them into plain text. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Optional keyword to filter chats by name",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_to_session",
            "description": "Send a message to an existing chat and get the model's response. The chat keeps its conversation history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "The id of the chat to send the message to",
                    },
                    "message": {"type": "string", "description": "The message to send"},
                },
                "required": ["session_id", "message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_session",
            "description": "Manage a chat: rename, archive, unarchive, delete, mark important, truncate history, or fork it. (The UI calls these 'chats'; 'session' is the internal term.) For destructive actions like delete, call list_sessions first and pass the exact id returned there; never invent ids.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "rename",
                            "archive",
                            "unarchive",
                            "delete",
                            "important",
                            "unimportant",
                            "truncate",
                            "fork",
                        ],
                        "description": "The action to perform",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Exact target chat id from list_sessions, or 'current' for the active chat where supported",
                    },
                    "value": {
                        "type": "string",
                        "description": "Action parameter: new name (rename), keep_count (truncate/fork)",
                    },
                },
                "required": ["action", "session_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List all available AI models across configured endpoints. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional keyword to filter models"}
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": "Ask the user a question to get a decision, clarification, or input when the task is genuinely ambiguous and the answer changes what you do next (e.g. pick between approaches, confirm an assumption, choose a target, or gather a missing detail). Provide 2-6 `options` for a multiple-choice question (the user sees clickable buttons) OR omit `options` entirely for an open question (the user types a free-text answer). Calling this ENDS your turn and the user's answer arrives as your next message. Prefer sensible defaults over asking — only ask when you truly cannot proceed well without the user's input. Do NOT use it to confirm irreversible/destructive actions that have a dedicated confirmation flow.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask. Be specific and self-contained.",
                    },
                    "options": {
                        "type": "array",
                        "description": "Optional. 2-6 mutually exclusive choices for a multiple-choice question. Each is an object with a short `label` and an optional `description` explaining the trade-off. Omit this entirely to ask an open question answered with free text.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "Concise choice text the user clicks (1-5 words).",
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Optional one-line explanation of this choice.",
                                },
                            },
                            "required": ["label"],
                        },
                    },
                    "multi": {
                        "type": "boolean",
                        "description": "Set true to let the user select multiple options instead of one. Default false. Ignored for open (free-text) questions.",
                    },
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "Update the active approved plan checklist while executing it. Pass the complete markdown checklist with completed steps marked - [x].",
            "parameters": {
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "string",
                        "description": "The full updated markdown checklist.",
                    }
                },
                "required": ["plan"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "api_call",
            "description": "Call a registered API integration (RSS reader, git forge, bookmark manager, smart home, etc.). Check the system context for available integrations and their endpoints.",
            "parameters": {
                "type": "object",
                "properties": {
                    "integration": {
                        "type": "string",
                        "description": "Integration name or ID (e.g. 'Miniflux', 'Gitea')",
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                        "description": "HTTP method",
                    },
                    "path": {
                        "type": "string",
                        "description": "API endpoint path (e.g. '/v1/entries?status=unread&limit=20')",
                    },
                    "body": {
                        "type": "object",
                        "description": "JSON request body (for POST/PUT/PATCH)",
                    },
                },
                "required": ["integration", "method", "path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_skills",
            "description": (
                "Read or modify the user's skill library. Skills are SKILL.md files "
                "(YAML frontmatter + structured body: When to Use / Procedure / "
                "Pitfalls / Verification) and follow a draft → published lifecycle. "
                "Use progressive disclosure: 'list' to see what exists, 'view' to "
                "load full content for a single skill, 'view_ref' for sub-files. "
                "Use 'patch' for surgical text edits and 'edit' for full rewrites. "
                "'publish' once you've verified the procedure works. For add, "
                "always provide an explicit name slug and only tell the user the "
                "exact name returned by the tool."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "list",
                            "view",
                            "view_ref",
                            "add",
                            "edit",
                            "patch",
                            "publish",
                            "delete",
                            "search",
                        ],
                        "description": "list = name+description summary; view = full SKILL.md; view_ref = sub-file under the skill dir; add = create; edit = full rewrite (content); patch = old_string→new_string; publish = flip status; delete; search = relevance match on published skills.",
                    },
                    "name": {
                        "type": "string",
                        "description": "Slug/name of the skill. Required for add/view/view_ref/edit/patch/publish/delete. For add, choose the exact kebab-case name the user should see and report only the returned name.",
                    },
                    "path": {
                        "type": "string",
                        "description": "Sub-path under the skill directory for view_ref (e.g. 'references/example.md').",
                    },
                    "description": {
                        "type": "string",
                        "description": "One-line summary surfaced in the skills index (for add).",
                    },
                    "category": {
                        "type": "string",
                        "description": "Organizational grouping like 'dev', 'email', 'system' (for add).",
                    },
                    "when_to_use": {
                        "type": "string",
                        "description": "Trigger conditions in plain English (for add).",
                    },
                    "procedure": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Numbered steps (for add).",
                    },
                    "pitfalls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Known failure modes + recovery (for add).",
                    },
                    "verification": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "How to confirm the procedure succeeded (for add).",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Keyword tags (for add).",
                    },
                    "platforms": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Restrict to OSes (for add).",
                    },
                    "requires_toolsets": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Hide unless these toolsets are active (for add).",
                    },
                    "fallback_for_toolsets": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Hide when these toolsets are active (for add).",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["draft", "published"],
                        "description": "Defaults to 'draft' on add.",
                    },
                    "version": {
                        "type": "string",
                        "description": "Semver-ish, e.g. '1.0.0' (for add).",
                    },
                    "confidence": {"type": "number", "description": "0-1 (for add/publish)."},
                    "content": {"type": "string", "description": "Full SKILL.md text (for edit)."},
                    "old_string": {
                        "type": "string",
                        "description": "Exact substring to replace (for patch). Must appear exactly once.",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text (for patch).",
                    },
                    "query": {"type": "string", "description": "Search query (for search)."},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_endpoints",
            "description": "Manage model API endpoints: list configured endpoints, add new ones, delete, enable or disable them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "add", "delete", "enable", "disable"],
                    },
                    "endpoint_id": {
                        "type": "string",
                        "description": "Endpoint ID (for delete/enable/disable)",
                    },
                    "name": {"type": "string", "description": "Display name (for add)"},
                    "base_url": {
                        "type": "string",
                        "description": "API base URL e.g. https://api.openai.com/v1 (for add)",
                    },
                    "api_key": {"type": "string", "description": "API key (for add)"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_mcp",
            "description": "Manage MCP (Model Context Protocol) tool servers: list servers and their tools, add new servers, delete, enable/disable, reconnect, or list all available tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "list",
                            "add",
                            "delete",
                            "enable",
                            "disable",
                            "reconnect",
                            "list_tools",
                        ],
                    },
                    "server_id": {
                        "type": "string",
                        "description": "Server ID (for delete/enable/disable/reconnect)",
                    },
                    "name": {"type": "string", "description": "Server name (for add)"},
                    "command": {
                        "type": "string",
                        "description": "Command to run e.g. npx (for add)",
                    },
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Command arguments (for add)",
                    },
                    "env": {"type": "object", "description": "Environment variables (for add)"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_tokens",
            "description": "Manage API access tokens: list existing tokens, create new ones, or delete them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "create", "delete"]},
                    "token_id": {"type": "string", "description": "Token ID (for delete)"},
                    "name": {"type": "string", "description": "Token name (for create)"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_documents",
            "description": "Manage documents: list all documents (with optional search/language filter), delete documents, or run tidy cleanup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "delete", "tidy"]},
                    "document_id": {"type": "string", "description": "Document ID (for delete)"},
                    "search": {"type": "string", "description": "Search query (for list)"},
                    "language": {"type": "string", "description": "Filter by language (for list)"},
                    "limit": {
                        "type": "integer",
                        "description": "Max results (for list, default 50)",
                    },
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_settings",
            "description": "Manage user preferences and settings. Use `disable_tool`/`enable_tool`/`list_tools` to turn individual tools on or off globally (e.g. shell, browser, documents, skills, images, notes, calendar, email). Use list/get/set/delete for free-form preferences.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "list",
                            "get",
                            "set",
                            "delete",
                            "disable_tool",
                            "enable_tool",
                            "list_tools",
                        ],
                    },
                    "key": {"type": "string", "description": "Setting key (for get/set/delete)"},
                    "value": {
                        "description": "Setting value (for set) — can be string, number, boolean, or object"
                    },
                    "tool": {
                        "type": "string",
                        "description": "Tool name to disable/enable (for disable_tool/enable_tool). Accepts aliases: shell, browser, documents, skills, images, notes, calendar, email — or a raw tool name like 'bash'.",
                    },
                },
                "required": ["action"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Converter: native function call -> ToolBlock
# ---------------------------------------------------------------------------


def function_call_to_tool_block(name: str, arguments: str) -> Optional[ToolBlock]:
    """Convert a native function call into a ToolBlock for the existing execution pipeline."""
    try:
        if not arguments or (isinstance(arguments, str) and not arguments.strip()):
            args = {}
        else:
            args = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (json.JSONDecodeError, TypeError):
        logger.error(f"Failed to parse function call arguments for {name}: {arguments}")
        return None

    # Some models emit valid JSON that isn't an object (e.g. a bare array
    # ["ls -la"], string, or number) as the function arguments. Every branch
    # below assumes a dict and calls args.get(...), so a non-dict would raise
    # AttributeError and abort the whole agent stream. Coerce to {} instead.
    if not isinstance(args, dict):
        logger.warning(
            f"Non-object function call arguments for {name}: {args!r}; treating as empty"
        )
        args = {}

    tool_type = _TOOL_NAME_MAP.get(name, name)

    # Allow MCP tools through (namespaced as mcp__serverid__toolname)
    if tool_type.startswith("mcp__"):
        content = json.dumps(args) if args else "{}"
        return ToolBlock(tool_type, content)
    if tool_type not in TOOL_TAGS:
        logger.warning(f"Unknown function call: {name}")
        return None

    # Convert structured args back to the text format each tool expects
    if tool_type == "bash":
        content = args.get("command", "")
    elif tool_type == "python":
        content = args.get("code", "")
    elif tool_type == "read_file":
        # Plain path (back-compat) unless a line range is requested → JSON.
        if args.get("offset") or args.get("limit"):
            content = json.dumps(args)
        else:
            content = args.get("path", "")
    elif tool_type in ("grep", "glob", "ls"):
        content = json.dumps(args) if args else "{}"
    elif tool_type == "write_file":
        content = args.get("path", "") + "\n" + args.get("content", "")
    elif tool_type == "edit_file":
        content = json.dumps(args)
    elif tool_type == "create_document":
        parts = [args.get("title", "Untitled")]
        if args.get("language"):
            parts.append(args["language"])
        parts.append(args.get("content", ""))
        content = "\n".join(parts)
    elif tool_type == "edit_document":
        blocks = []
        for edit in args.get("edits", []):
            blocks.append(
                f"<<<FIND>>>\n{edit.get('find', '')}\n<<<REPLACE>>>\n{edit.get('replace', '')}\n<<<END>>>"
            )
        content = "\n".join(blocks)
    elif tool_type == "suggest_document":
        blocks = []
        for s in args.get("suggestions", []):
            blocks.append(
                f"<<<FIND>>>\n{s.get('find', '')}\n<<<SUGGEST>>>\n{s.get('replace', '')}\n<<<REASON>>>\n{s.get('reason', '')}\n<<<END>>>"
            )
        content = "\n".join(blocks)
    elif tool_type == "update_document":
        content = args.get("content", "")
    elif tool_type == "search_chats":
        content = args.get("query", "")
    elif tool_type == "expand_output":
        content = args.get("id", "")
        if args.get("query"):
            content += "\n" + str(args["query"])
    elif tool_type == "create_session":
        content = args.get("name", "Untitled") + "\n" + args.get("model", "")
    elif tool_type == "list_sessions":
        content = args.get("filter", "")
    elif tool_type == "send_to_session":
        content = args.get("session_id", "") + "\n" + args.get("message", "")
    elif tool_type == "manage_session":
        action = args.get("action", "")
        value = args.get("value", "")
        # `list` is the only action that takes an OPTIONAL keyword
        # filter — never a session_id. Don't leak the "current" default
        # into the filter slot (was producing "No sessions found
        # matching 'current'" when the agent omitted session_id).
        if action == "list":
            keyword = args.get("session_id", "") or args.get("keyword", "") or value
            content = "list" + (
                ("\n" + keyword) if keyword and keyword.lower() != "current" else ""
            )
        else:
            sid = args.get("session_id", "current")
            content = action + "\n" + sid
            if value:
                content += "\n" + value
    elif tool_type == "list_models":
        content = args.get("filter", "")
    elif tool_type in (
        "manage_skills",
        "api_call",
        "manage_endpoints",
        "manage_mcp",
        "manage_tokens",
        "manage_documents",
        "manage_settings",
    ):
        content = json.dumps(args)
    else:
        content = json.dumps(args)

    return ToolBlock(tool_type, content)
