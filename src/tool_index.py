"""
RAG-based tool selection for agent mode.

Instead of injecting all tool descriptions into the system prompt,
embed them in a ChromaDB collection and retrieve only the top-K
relevant ones per user message.
"""

import hashlib
import logging
import re
import time
from typing import Dict, List, Optional, Set

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

logger = logging.getLogger(__name__)

# Tools that are ALWAYS included regardless of retrieval results.
# These are the most commonly needed and should never be missing.
ALWAYS_AVAILABLE = frozenset(
    {
        "bash",
        "python",
        # File tools: read AND write/edit. An agent with disk access should always
        # be able to change files, not just read them — otherwise a bare "edit X"
        # request can miss write_file/edit_file (RAG-only) and the model wrongly
        # falls back to edit_document (editor panel). All admin-gated by tool_security.
        "read_file",
        "write_file",
        "edit_file",
        "grep",
        "glob",
        "ls",  # code-navigation tools (admin-gated by tool_security)
        "show_image",  # display a workspace image inline (charts/plots/results)
        "run_cell",  # persistent Python kernel (stateful, Jupyter-like) for iterative work
        "api_call",  # For configured integrations (Miniflux, Gitea, Linkding, etc.)
        # Ask the user a multiple-choice question for a decision/clarification.
        # Always reachable so the agent can pause and ask at any point.
        "ask_user",
        "update_plan",
        # Retrieve the full original of a compressed tool output. Compression
        # markers can appear after ANY tool runs, so the retrieval tool must
        # always be in reach (RAG would never select it from the user's message).
        "expand_output",
        # Load a shared uploaded skill's full instructions. The enabled-skills
        # index is injected silently into context, so the tool it points at
        # must always be callable (RAG can't infer it from the user message).
        "read_skill",
        # The forced 'look at your skills' tool — must always be reachable so
        # the agent loop can compel it when skills are active.
        "browse_skills",
    }
)

# Tools that the Personal Assistant always has access to during scheduled
# check-ins and proactive tasks, in addition to RAG-selected tools.
ASSISTANT_ALWAYS_AVAILABLE = frozenset(
    {
        "read_file",
        "create_document",
        "update_document",
        "search_chats",
        "api_call",  # For Miniflux/Gitea/Linkding/etc. integrations
    }
)

COLLECTION_NAME = "talos_tool_index"

# ── Tool description registry ──
# Each tool gets a searchable description that helps retrieval.
# These are richer than the system prompt one-liners — they're for embedding.
BUILTIN_TOOL_DESCRIPTIONS: Dict[str, str] = {
    "bash": "Run shell commands in the private workspace for work tasks: check/process files, run scripts, data analysis, document generation, pip install of Python libraries. No system administration or system info.",
    "python": "Execute Python code for computation, data processing, math, scripting, parsing, API calls. Not for writing code for the user.",
    "read_file": "Read a file from disk and return its contents. View source code, config files, logs. Supports an optional line range (offset/limit) for large files.",
    "grep": "Search file CONTENTS for a regex across a directory tree (ripgrep-backed, honours .gitignore). Returns file:line:match. Use to find where code/symbols/strings live — prefer over bash grep.",
    "glob": "Find FILES by glob pattern (e.g. '**/*.py'), newest first. Use to locate files by name/extension — prefer over bash find/ls.",
    "ls": "List a directory's entries (folders then files with sizes). Use to see what's in a folder — prefer over bash ls.",
    "show_image": "Display an image from the workspace to the user inline in chat (click-to-enlarge + download). Use to present a finished chart, plot, diagram, or visual result after saving it with python/seaborn.",
    "run_cell": "Run Python in a persistent, stateful kernel (Jupyter-like) where variables and loaded data survive between calls. Use for iterative data analysis: load data once, then explore/transform/plot it across multiple cells without reloading.",
    "write_file": "Write/create or fully rewrite a file ON DISK (source code, configs, project files). Use for new files or full rewrites — NOT create_document (editor panel) and NOT a bash heredoc.",
    "edit_file": "Edit an existing file ON DISK by exact string replacement (fix a bug, change a function). Shows a diff. The tool for changing files on disk — NOT edit_document (editor panel) and NOT bash sed/heredoc.",
    "create_document": "Create a new document in the editor panel. For code, articles, text content longer than 15 lines, unless an already-open document/email draft is the obvious target. If an email compose draft is open, edit that draft instead of creating another document.",
    "edit_document": "Preferred tool for editing an existing document — targeted find-and-replace. Use for any small change: add a function, fix a bug, tweak a section, rename things.",
    "update_document": "Replace the entire active document content. ONLY for full rewrites (>50% changed). Do not use for small edits — use edit_document instead.",
    "suggest_document": "Suggest changes to the active document with explanations. For code review, proofreading, feedback requests.",
    "generate_image": "Generate an AI image from a text prompt. Specify model, size, and quality. Art, illustrations, photos.",
    "update_plan": "Update the approved plan checklist while executing it. Mark completed steps with - [x] and keep unchecked steps as - [ ]. Use after finishing each plan step.",
    "expand_output": "Retrieve the full original of a compressed tool output by its stored id (out_xxxxxxxx). Supports searching for specific lines or paging through large outputs.",
    "list_models": "List all available AI models and their endpoints.",
    "manage_session": "Chat management: rename, archive, delete, or fork chats (the UI calls these 'chats'; internally 'sessions'). Use for 'rename my chats', 'rename this chat', 'archive/delete a chat'.",
    "manage_skills": "Skill management: add, update, publish, or search reusable skills/presets.",
    "read_skill": "Load the full instructions of an enabled shared skill (user-uploaded SKILL.md) by name, then follow its method exactly.",
    "browse_skills": "Review the enabled skill library for the current task; returns matching skills' full instructions inline to follow exactly.",
    "create_skill": "Author/save a shared skill (SKILL.md + optional references/scripts) into the library from a workspace folder or inline content. Use when creating or updating a reusable skill.",
    "manage_endpoints": "Endpoint management: list, add, delete, enable, or disable model API endpoints.",
    "manage_mcp": "MCP server management: list, add, delete, reconnect servers, or list available tools.",
    "manage_tokens": "API token management: list, create, or delete API access tokens.",
    "manage_documents": "List, read, delete, or tidy documents in the editor panel. action='list' returns clickable rows (most-recent first) so the user can open any doc by clicking. action='read' (aka view/open/get) with document_id returns the content. action='delete' with document_id removes a doc (only way to delete). Use this for ANY 'show/read/list/open my documents/docs/files/notes' request — never shell or curl.",
    "manage_settings": "Change ANY real app setting (the ones the Settings panel writes) so the user never has to open it: TTS voice/provider/speed, STT, default/utility/vision/image models, image quality, reminder channel (browser/email/ntfy), agent timeout/tool-call budget, and more. action=set with key (friendly aliases ok: voice, 'default model', 'image quality', 'reminder channel'...) + value; get/list/reset too. Also toggles tools on/off (disable_tool/enable_tool/list_tools). Secrets/API keys are read-only. Use for any 'change my…/set my…/use X for…/turn on…' preference request.",
    "create_session": "Create a new chat with a name and model.",
    "list_sessions": "List all chats with their metadata (the UI calls these 'chats'). Use for 'list my chats', 'rename all my chats' (list first, then manage_session to rename each).",
    "send_to_session": "Send a message to another chat. Cross-chat communication.",
    "search_chats": "Search through chat history across all sessions.",
    "ask_user": "Ask the user a question to get a decision, clarification, or input. Use this when the task is genuinely ambiguous and the answer changes what you do next — pick between approaches, confirm an assumption, choose among options, gather a missing detail — instead of guessing. Provide a clear `question` plus either 2-6 `options` (each with a short `label`, optional `description`) for clickable buttons, or no options for an open free-text answer. Calling this ENDS your turn: the user's answer arrives as your next message. Don't use it for things you can decide from context or sensible defaults, or for irreversible-action confirmation if a dedicated flow exists.",
    "query_sql": "Read-only SQL access to the configured external database using backend .env credentials. Use when the user asks for database data, SQL, tables, schema, rows, metrics, reports, counts, customers, orders, products, invoices, or anything stored in the DB. Supports list_tables, describe table, and read-only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/PRAGMA queries with optional max_rows; omit max_rows or pass 0 for no row limit. The model never needs DB passwords.",
}


class ToolIndex:
    """ChromaDB-backed tool index for RAG-based tool selection."""

    def __init__(self):
        from src.chroma_client import get_chroma_client
        from src.embeddings import get_embedding_client

        self._embedder = get_embedding_client()
        if not self._embedder:
            raise RuntimeError("No embedding client available")

        client = get_chroma_client()
        self._collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        self._fingerprint = ""
        self._mcp_generation = -1
        self._healthy = True
        logger.info("ToolIndex initialized")

    @property
    def healthy(self):
        return self._healthy

    def _embed(self, texts: List[str]) -> List[List[float]]:
        vecs = self._embedder.encode(texts, normalize_embeddings=True)
        if np is not None:
            return np.array(vecs, dtype=np.float32).tolist()
        # Fallback without numpy
        return [list(v) for v in vecs]

    def index_builtin_tools(self):
        """Index all built-in tool descriptions."""
        docs = []
        ids = []
        metadatas = []
        for name, desc in BUILTIN_TOOL_DESCRIPTIONS.items():
            doc_text = f"Tool: {name}\n{desc}"
            docs.append(doc_text)
            ids.append(f"builtin_{name}")
            metadatas.append({"tool_name": name, "tool_type": "builtin"})

        if not docs:
            return

        # Drop any stale builtin_* entries that aren't in the current
        # registry (e.g. removed tools like the old vault_* set).
        # Without this, upsert leaves them in place and RAG keeps
        # surfacing tools that no longer exist.
        try:
            existing = self._collection.get(where={"tool_type": "builtin"})
            existing_ids = (existing or {}).get("ids") or []
            stale = [i for i in existing_ids if i not in set(ids)]
            if stale:
                self._collection.delete(ids=stale)
                logger.info(f"Pruned {len(stale)} stale builtin tool entries from index")
        except Exception as e:
            logger.debug(f"Stale-pruning skipped: {e}")

        embeddings = self._embed(docs)
        self._collection.upsert(
            ids=ids,
            documents=docs,
            embeddings=embeddings,
            metadatas=metadatas,
        )
        self._fingerprint = hashlib.sha256(
            ",".join(sorted(BUILTIN_TOOL_DESCRIPTIONS.keys())).encode()
        ).hexdigest()
        logger.info(f"Indexed {len(docs)} built-in tools")

    def index_mcp_tools(self, mcp_mgr, disabled_map: Optional[Dict] = None):
        """Index MCP tool descriptions. Call after MCP servers connect/disconnect."""
        if not mcp_mgr:
            return

        # Get current MCP generation to avoid redundant reindexing
        gen = getattr(mcp_mgr, "_generation", 0)
        if gen == self._mcp_generation:
            return
        self._mcp_generation = gen

        # Remove old MCP entries
        try:
            existing = self._collection.get(where={"tool_type": "mcp"})
            if existing and existing["ids"]:
                self._collection.delete(ids=existing["ids"])
        except Exception:
            pass

        # Get current MCP tools
        try:
            all_tools = mcp_mgr.get_tool_descriptions_for_prompt(disabled_map or {})
        except Exception:
            all_tools = ""

        if not all_tools:
            return

        # Parse MCP tool descriptions from the prompt text
        docs = []
        ids = []
        metadatas = []
        current_server = ""
        for line in all_tools.strip().split("\n"):
            line = line.strip()
            # Track which server section we're in (for context in descriptions)
            if line.startswith("**") and line.endswith(":**"):
                current_server = line.strip("*: ")
            elif line.startswith("- ") and ":" in line:
                # Format: "- tool_name: description"
                name_desc = line[2:].split(":", 1)
                if len(name_desc) == 2:
                    name = name_desc[0].strip()
                    desc = name_desc[1].strip()
                    # Include server identity in the indexed text so RAG can
                    # distinguish "list_emails for server-a" from "list_emails for server-b"
                    server_ctx = f" (server: {current_server})" if current_server else ""
                    doc_text = f"Tool: {name}{server_ctx}\n{desc}"
                    docs.append(doc_text)
                    ids.append(f"mcp_{name}")
                    metadatas.append({"tool_name": name, "tool_type": "mcp"})

        if not docs:
            return

        embeddings = self._embed(docs)
        self._collection.upsert(
            ids=ids,
            documents=docs,
            embeddings=embeddings,
            metadatas=metadatas,
        )
        logger.info(f"Indexed {len(docs)} MCP tools")

    def retrieve(self, query: str, k: int = 8) -> List[str]:
        """Retrieve the top-K most relevant tool names for a query."""
        try:
            query_embedding = self._embed([query])
            results = self._collection.query(
                query_embeddings=query_embedding,
                n_results=min(k, self._collection.count() or k),
                include=["metadatas", "distances"],
            )
            if not results or not results.get("metadatas"):
                return []

            tool_names = []
            for meta_list in results["metadatas"]:
                for meta in meta_list:
                    name = meta.get("tool_name", "")
                    if name and name not in tool_names:
                        tool_names.append(name)
            return tool_names
        except Exception as e:
            logger.warning(f"Tool retrieval failed: {e}")
            return []

    # Keyword hints: if the query mentions these words, force-include the tools.
    _KEYWORD_HINTS = {
        # NOTE: "tell" was removed from this set. It fired on any "tell me ..."
        # request (e.g. "visit <url> and tell me the title"), force-including the
        # whole email toolset and crowding out the relevant tools — the model then
        # believed it had only email tools and refused web/other tasks (#1707).
        frozenset(
            {"sql", "database", "db", "table", "tables", "schema", "rows", "query", "select"}
        ): {"query_sql"},
        # Chat/session management. "rename" alone maps to documents below, so a
        # request like "rename the last 12 sessions/chats" needs these session
        # keywords to surface the right tools.
        frozenset(
            {
                "sessions",
                "my chats",
                "these chats",
                "those chats",
                "chat history",
                "rename chat",
                "rename session",
                "rename the chat",
                "rename my chat",
                "rename the session",
                "archive chat",
                "archive session",
                "delete chat",
                "delete session",
                "fork chat",
                "fork session",
                "name the chats",
                "name my chats",
                "rename them",
            }
        ): {"list_sessions", "manage_session"},
        # Settings-change intent — "change my…/set my…/use X for…/turn on…".
        frozenset(
            {
                "change my",
                "set my",
                "use the voice",
                "change the voice",
                "my voice",
                "tts voice",
                "default model",
                "image quality",
                "reminder channel",
                "send reminders to",
                "remind me by",
                "speak faster",
                "speak slower",
                "agent timeout",
                "token budget",
                "max tool calls",
                "use this model for",
                "use that model for",
                "my settings",
                "change setting",
                "change a setting",
                "set setting",
                "preference",
                "preferences",
                "configure",
            }
        ): {"manage_settings"},
        # Document edit/update intent
        frozenset(
            {
                "edit",
                "change",
                "fix",
                "rewrite",
                "update",
                "replace",
                "add a",
                "tweak",
                "modify",
                "rename",
                "paragraph",
                "section",
                "line",
                "the doc",
                "the document",
                "in the doc",
            }
        ): {"edit_document", "update_document", "create_document", "suggest_document"},
        # Document deletion / management — include generic open/find/read/show
        # verbs + file/doc synonyms so "open my <X>", "find the <X>", "delete
        # <X>" reach manage_documents even without the literal word "document".
        frozenset(
            {
                "delete this doc",
                "delete the doc",
                "delete document",
                "remove document",
                "remove the doc",
                "trash",
                "list documents",
                "list docs",
                "all my docs",
                "my documents",
                "my docs",
                "my files",
                "open the",
                "open my",
                "open document",
                "open doc",
                "find the",
                "find my",
                "find document",
                "read the",
                "read my",
                "show me the",
                "show my",
                "the file",
                "my file",
                "the report",
                "the write-up",
                "the writeup",
                "saved document",
                "in my library",
                "in the library",
            }
        ): {"manage_documents", "edit_document"},
        # Tool on/off intent — user says "turn off shell", "disable search".
        # Handled by manage_settings (disable_tool/enable_tool).
        frozenset(
            {
                "turn off",
                "turn on",
                "disable",
                "enable",
                "shell off",
                "shell on",
                "search off",
                "search on",
                "research off",
                "research on",
            }
        ): {"manage_settings"},
        # Skill authoring intent — surface create_skill (and browse for the
        # skill-creator workflow) when the user wants to build/save a skill.
        frozenset(
            {
                "create a skill",
                "make a skill",
                "build a skill",
                "write a skill",
                "new skill",
                "author a skill",
                "save this as a skill",
                "turn this into a skill",
                "skill creator",
                "skill-creator",
            }
        ): {"create_skill", "browse_skills"},
        # Document creation intent
        frozenset(
            {
                "write a",
                "create a doc",
                "draft",
                "compose",
                "poem",
                "story",
                "essay",
                "outline",
                "letter",
            }
        ): {"create_document", "edit_document", "update_document"},
    }

    def get_tools_for_query(
        self, query: str, k: int = 8, always_include: Optional[Set[str]] = None
    ) -> Set[str]:
        """Get the set of tool names to include for a given user query."""
        base = set(always_include or ALWAYS_AVAILABLE)
        retrieved = self.retrieve(query, k=k)
        base.update(retrieved)
        # Keyword-based force-include for common intents. Match on word
        # boundaries, not raw substrings, so short hints like "fix", "line",
        # "serve", "reply" or "unread" don't fire inside unrelated words
        # ("prefix", "deadline"/"online", "observe"/"reserve", "replying",
        # "unreadable"). Same word-boundary matching used in topic_analyzer.
        ql = query.lower()
        for keywords, tools in self._KEYWORD_HINTS.items():
            if any(re.search(rf"\b{re.escape(kw)}\b", ql) for kw in keywords):
                base.update(tools)
        return base


# ── Singleton ──

_tool_index: Optional[ToolIndex] = None
_last_attempt = 0.0
_RETRY_INTERVAL = 30.0


def get_tool_index() -> Optional[ToolIndex]:
    """Get or create the singleton ToolIndex. Returns None if unavailable."""
    global _tool_index, _last_attempt

    if _tool_index is not None and _tool_index.healthy:
        return _tool_index

    now = time.monotonic()
    if now - _last_attempt < _RETRY_INTERVAL:
        return None
    _last_attempt = now

    try:
        _tool_index = ToolIndex()
        _tool_index.index_builtin_tools()
        return _tool_index
    except Exception as e:
        logger.warning(f"ToolIndex init failed (will retry in {_RETRY_INTERVAL}s): {e}")
        _tool_index = None
        return None
