"""Stable tool surface for native function calling — core tools plus a catalog.

vLLM's prefix cache reuses the prompt from token 0 up to the first difference,
and Qwen's chat template renders the `tools` list at the very top of the
prompt. Picking a different tool subset per message (the old retrieval-based
selection) therefore re-prefilled the entire conversation whenever the subset
changed. Sending every tool schema every turn is stable but large, and a small
model picks worse from a long list.

So, like Claude Code's deferred tools, the surface is split:

* **Core tools** — the everyday set, sent with full schemas on every request,
  in a fixed order. Per-turn switches (web, database, knowledge base) do NOT
  remove tools from this list; they are enforced at execution time instead,
  so toggling them never changes the prompt's head.
* **Catalog** — everything else (session/admin tools, MCP tools). The system
  prompt lists each by name with a one-line summary. The model loads a full
  schema with `find_tools`, whose result lands at the END of the conversation,
  and calls it through `run_tool`. The `tools` list itself never changes.
"""

import json
from contextvars import ContextVar
from typing import Dict, Iterable, List, Optional, Set, Tuple

from src.tool_index import ALWAYS_AVAILABLE

FIND_TOOLS = "find_tools"
RUN_TOOL = "run_tool"

# Always sent with full schemas. The retrieval-independent set plus the tools
# a per-turn switch or an open document makes relevant — those used to join
# the list only on the turns that needed them, which is exactly the churn this
# module exists to avoid.
CORE_TOOLS = frozenset(
    ALWAYS_AVAILABLE
    | {
        "query_sql",
        "search_knowledge",
        "create_document",
        "edit_document",
        "suggest_document",
        "update_document",
    }
)

_SUMMARY_MAX = 140
_FIND_LIMIT = 5

META_TOOL_SCHEMAS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": FIND_TOOLS,
            "description": (
                "Load the full definition of tools from the 'More tools' catalog in your "
                "instructions. Pass the exact names you want, or a short description of "
                "the task to search the catalog. Then call the tool with `run_tool`."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Exact catalog tool names to load.",
                    },
                    "query": {
                        "type": "string",
                        "description": "What you want to do, when you don't know the name.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": RUN_TOOL,
            "description": (
                "Call a tool from the 'More tools' catalog. Load its definition with "
                "`find_tools` first, then pass its name and its arguments."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Catalog tool name."},
                    "arguments": {
                        "type": "object",
                        "description": "Arguments matching the tool's parameters.",
                    },
                },
                "required": ["name"],
            },
        },
    },
]


def _name(schema: Dict) -> str:
    return (schema.get("function") or {}).get("name") or ""


def _summary(schema: Dict) -> str:
    desc = " ".join(str((schema.get("function") or {}).get("description") or "").split())
    first = desc.split(". ")[0].rstrip(".")
    return first if len(first) <= _SUMMARY_MAX else first[: _SUMMARY_MAX - 1].rstrip() + "…"


def split_tools(
    function_schemas: Iterable[Dict], mcp_schemas: Iterable[Dict], hidden: Set[str]
) -> Tuple[List[Dict], List[Dict]]:
    """Return (core schemas to send, catalog schemas), both in a stable order.

    `hidden` holds tools this owner never gets (privileges, admin settings) —
    those are omitted everywhere. Core keeps the registry order; the catalog is
    sorted by name, since MCP servers register in connection order.
    """
    core, catalog = [], []
    for schema in function_schemas:
        name = _name(schema)
        if not name or name in hidden:
            continue
        (core if name in CORE_TOOLS else catalog).append(schema)
    catalog += [s for s in mcp_schemas if _name(s) and _name(s) not in hidden]
    catalog.sort(key=_name)
    if catalog:
        core = core + META_TOOL_SCHEMAS
    return core, catalog


def catalog_prompt(catalog: List[Dict]) -> str:
    """The catalog listing for the system prompt — one line per tool."""
    if not catalog:
        return ""
    lines = [
        "## More tools (load on demand)",
        "These tools are available but not loaded. To use one, call `find_tools` with "
        "its name to get its parameters, then call it via `run_tool` with "
        '`{"name": "<tool>", "arguments": {...}}`. Do not guess parameters.',
    ]
    lines += [f"- `{_name(s)}` — {_summary(s)}" for s in catalog]
    return "\n".join(lines)


def find_tools(catalog: List[Dict], names: Iterable[str] = (), query: str = "") -> str:
    """Render full definitions for the requested catalog tools."""
    by_name = {_name(s): s for s in catalog}
    picked: List[Dict] = []
    for n in names or ():
        s = by_name.get(str(n).strip())
        if s and s not in picked:
            picked.append(s)
    q_words = {w for w in str(query or "").lower().split() if len(w) > 2}
    if q_words and len(picked) < _FIND_LIMIT:
        scored = []
        for s in catalog:
            if s in picked:
                continue
            fn = s.get("function") or {}
            hay = f"{fn.get('name', '')} {fn.get('description', '')}".lower().replace("_", " ")
            score = sum(1 for w in q_words if w in hay)
            if score:
                scored.append((-score, _name(s), s))
        picked += [s for _, _, s in sorted(scored)[: _FIND_LIMIT - len(picked)]]
    if not picked:
        return (
            "No matching tool in the catalog. Available: "
            + ", ".join(sorted(by_name))
            + ". Pass exact names in `names`."
        )
    out = []
    for s in picked:
        fn = s.get("function") or {}
        out.append(
            json.dumps(
                {
                    "name": fn.get("name"),
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                },
                ensure_ascii=False,
            )
        )
    return (
        "Loaded. Call these with run_tool "
        '({"name": "<name>", "arguments": {...}}):\n' + "\n".join(out)
    )


# The catalog of the agent turn running in this context. Set by the agent loop
# before its first round; tool tasks it spawns inherit it.
_current_catalog: ContextVar[Optional[List[Dict]]] = ContextVar("tool_catalog", default=None)


def set_current_catalog(catalog: Optional[List[Dict]]) -> None:
    _current_catalog.set(catalog)


def do_find_tools(content: str) -> Dict:
    """Executor entry point for `find_tools`."""
    catalog = _current_catalog.get()
    if not catalog:
        return {"error": "No additional tools are available in this chat.", "exit_code": 1}
    try:
        args = json.loads(content) if content and content.strip() else {}
    except json.JSONDecodeError:
        args = {"query": content}
    if not isinstance(args, dict):
        args = {}
    names = args.get("names") or []
    if isinstance(names, str):
        names = [n.strip() for n in names.split(",")]
    if args.get("name"):
        names = list(names) + [str(args["name"])]
    return {"output": find_tools(catalog, names, str(args.get("query") or "")), "exit_code": 0}


def unwrap_run_tool(arguments) -> Optional[Tuple[str, str]]:
    """(inner tool name, inner arguments JSON) from a run_tool call, or None."""
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(args, dict):
        return None
    name = str(args.get("name") or args.get("tool") or "").strip()
    if not name or name in (RUN_TOOL, FIND_TOOLS):
        return None
    inner = args.get("arguments", args.get("args", {}))
    if isinstance(inner, str):
        # Some models double-encode the nested object.
        try:
            inner = json.loads(inner) if inner.strip() else {}
        except json.JSONDecodeError:
            return None
    if not isinstance(inner, dict):
        return None
    return name, json.dumps(inner, ensure_ascii=False)
