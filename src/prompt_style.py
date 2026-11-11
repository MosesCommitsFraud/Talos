"""Which wording the model is given: the lean prompt or the classic one.

The classic prompt grew rule by rule: a policy in ``prompt_security`` and a
second, louder rule list in ``agent_loop``, each written against one observed
failure. Read together they contradicted each other (report a failed tool vs.
never explain a tool error; retry with a fix vs. do not retry variants), said
the same thing two or three times, and spent a third of their length on tools
the model does not have loaded. A local model follows a short, calm prompt more
reliably than a long one that shouts.

The lean style says each thing once, in plain sentences, and leaves a tool's
rules to that tool's description. This module holds the switch and the lean
tool descriptions; the lean prompt texts sit next to their classic
counterparts (``prompt_security.LEAN_SYSTEM_PROMPT``,
``agent_loop._LEAN_AGENT_RULES``).

``agent_prompt_style`` selects the style: "lean" (default) or "classic". Both
stay available so one can be measured against the other with the loop figures
each turn records (rejected calls, repeat reminders, rounds). Switching changes
the head of the prompt, so the server's prefix cache is rebuilt once per chat.
"""

from __future__ import annotations

from typing import Dict, Iterable, List

LEAN = "lean"
CLASSIC = "classic"


def prompt_style() -> str:
    """The configured style; anything unknown counts as lean."""
    try:
        from src.settings import get_setting

        value = str(get_setting("agent_prompt_style", LEAN) or LEAN).strip().lower()
    except Exception:
        return LEAN
    return CLASSIC if value == CLASSIC else LEAN


def is_lean() -> bool:
    return prompt_style() == LEAN


# Lean descriptions for the tools whose classic description shouts or repeats
# the system prompt. Same facts, said once. Tools not listed keep their
# description from tool_schemas.FUNCTION_TOOL_SCHEMAS.
LEAN_TOOL_DESCRIPTIONS: Dict[str, str] = {
    "bash": (
        "Run a shell command in your private workspace: inspect and process files, "
        "analyse data, generate documents, run scripts. Python libraries can be "
        "installed with `pip install` when the task needs them; sudo, system package "
        "managers, docker/services and commands that only inspect the system are "
        "rejected by policy. Questions about setting up the user's own machine are "
        "answered in text, not executed here. For inline Python use `python`; create "
        "and change files with `write_file`/`edit_file` rather than shell redirects. "
        "The workspace has no network and cannot reach the database: use "
        "`web_search`/`web_fetch` for the internet and `query_sql` for the database."
    ),
    "python": (
        "Run Python in the isolated workspace to compute or check something. If a run "
        "fails, call `python` again with `edits` (and no `code`) to patch the code you "
        "just ran; it is kept for you, so the script does not have to be sent again. "
        "Save a chart to a relative workspace path and show it with `show_image`; "
        "images under `output/` are shown automatically. For a dashboard, write one "
        "self-contained HTML file under `output/` with the vendored scaffold "
        "(`sys.path.insert(0, '/opt/talos/vendor'); import talos_dash as td`), which "
        "inlines the chart runtime; a CDN script tag cannot load here. Deliverables go "
        "under relative paths, not /tmp. The workspace has no network and no route to "
        "the SQL database: use `web_search`/`web_fetch` for the internet, and get rows "
        "with `query_sql`, which writes a CSV you can read here."
    ),
    "run_cell": (
        "Run Python in a persistent session, like a notebook: variables, imports and "
        "loaded data stay in memory between calls until the chat ends or you reset it. "
        "Worth it for data analysis in several steps, where a dataset is loaded once "
        "and explored over several cells; for one-off code use `python`. Save charts "
        "under `output/` or call `show_image`. If a cell fails, call run_cell again "
        "with `edits` (and no `code`) to patch it instead of sending it again."
    ),
    "edit_file": (
        "Change a file on disk by exact string replacement; shows a diff. This is the "
        "way to change an existing file: `write_file` is for creating one, and "
        "`edit_document` is for documents in the editor panel. Either one edit with "
        "`old_string`/`new_string`, or several in one call with `edits` (a list of "
        "{target, replacement}). Each target must match the file exactly and be "
        "unique, unless `replace_all`/`allow_multiple` is set."
    ),
    "create_document": (
        "Create a new document in the editor panel, for code, scripts or other longer "
        "content (more than about 15 lines) the user asks you to write, so it does not "
        "have to be pasted into the chat. When a document or e-mail draft that the "
        "request refers to is already open, edit that one instead of creating another."
    ),
    "edit_document": (
        "Edit the document open in the editor panel with find/replace pairs, several "
        "per call. Use it for every change short of a full rewrite. For a file on disk "
        "(anything with a path) use `edit_file`."
    ),
    "update_document": (
        "Replace the whole active document. For a real rewrite, when most of its lines "
        "change; smaller changes go through `edit_document`."
    ),
    "suggest_document": (
        "Suggest improvements to the active document without editing it: inline "
        "comments the user can accept or reject. Use it when the user asks for "
        "suggestions, feedback or a review of the open document, instead of listing "
        "ideas in the chat. To suggest an addition, set `find` to a short existing "
        "passage and `replace` to that passage plus the new content."
    ),
    "show_image": (
        "Show an image from your workspace in the chat (inline, enlargeable, with a "
        "download button). Save it first, for example with `fig.savefig('chart.png')`, "
        "then call this with its relative workspace path, not /tmp or an absolute "
        "path. png, jpg, gif, webp, bmp or svg; one image per call."
    ),
    "present_files": (
        "Hand the finished deliverable of this turn to the user: each file is shown as "
        "a card under your answer, with preview and download. Call it once, at the "
        "end, with what the user asked for (the report, spreadsheet, dashboard, deck, "
        "PDF, image), not the scripts or intermediate files written on the way; those "
        "stay in the chat's file list. Usually one file; several when the request was "
        "for several. Not needed when no file was the point of the request."
    ),
    "web_search": (
        "Search the live internet; returns titles, URLs and snippets. Use it for "
        "public or current facts you do not reliably know (news, prices, releases, "
        "versions, laws, people, companies) and whenever the user asks you to search "
        "or research something. Your training data ends before today's date: when "
        "something you remember as upcoming has a date that has passed, look up how it "
        "turned out. Searching needs no permission and no announcement. If knowledge "
        "from the user's own documents is already in your context and answers the "
        "question, use that instead. For research, run one query per sub-question, "
        "several in the same response, and rephrase when the results are weak. "
        "Snippets are thin; open the best URLs with `web_fetch`. Search in the language "
        "the answer lives in. Queries go to public search engines, so keep them free "
        "of anything from the user's documents or database (content, names of "
        "customers or employees, internal identifiers, figures) and search the "
        "general, public form of the question. Names of public figures, companies and "
        "products are fine."
    ),
    "ask_user": (
        "Ask the user a question and end your turn; their answer arrives as your next "
        "message. Use it when the task is ambiguous in a way that changes what you do "
        "next; otherwise choose a sensible default, say in one line what you assumed, "
        "and carry on. Give 2-6 `options` (shown as buttons) or leave them out for a "
        "free-text answer. A question with choices belongs in this tool: a menu "
        "written into the reply looks like buttons but cannot be clicked. Each option "
        "is a different way forward, not yes/no or proceed/cancel; put the one you "
        "recommend first, marked '(empfohlen)' or '(recommended)', and give each a "
        "`description` that names its trade-off. Not for confirming destructive "
        "actions that have their own confirmation flow."
    ),
    "browse_skills": (
        "Look through the user's enabled skill library for the current task. Returns "
        "the available skills and, for those that fit, their full instructions. "
        "Useful at the start of work a skill may cover; then work the way the skill "
        "describes."
    ),
    "read_skill": (
        "Load the full instructions of an enabled skill by name; the skills (name and "
        "description) are listed in your context. When a request matches a skill, "
        "load it before you start and work the way it describes."
    ),
}


def styled_schemas(schemas: Iterable[Dict]) -> List[Dict]:
    """The tool schemas as the configured style words them.

    Classic returns them unchanged. Lean swaps the description of the tools in
    ``LEAN_TOOL_DESCRIPTIONS``; every other schema is passed through as the same
    object, and nothing is modified in place.
    """
    schemas = list(schemas)
    if not is_lean():
        return schemas
    out: List[Dict] = []
    for schema in schemas:
        function = schema.get("function") or {}
        lean = LEAN_TOOL_DESCRIPTIONS.get(function.get("name"))
        if lean is None:
            out.append(schema)
        else:
            out.append({**schema, "function": {**function, "description": lean}})
    return out
