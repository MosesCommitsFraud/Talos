from src.prompt_security import TALOS_SYSTEM_PROMPT


def test_talos_system_prompt_defines_workspace_policy_and_environment():
    assert "browser-based workspace" in TALOS_SYSTEM_PROMPT
    assert "ordinary tool results as useful working context" in TALOS_SYSTEM_PROMPT
    assert "not on the user's computer or host system" in TALOS_SYSTEM_PROMPT


def test_talos_system_prompt_allows_project_dependencies_with_safety_boundaries():
    assert "Install dependencies when they are needed" in TALOS_SYSTEM_PROMPT
    assert "existing package manager and lockfile conventions" in TALOS_SYSTEM_PROMPT
    assert "SQL tools are read-only" in TALOS_SYSTEM_PROMPT


def test_llm_language_prompt_covers_thinking_and_output():
    from routes.chat_helpers import llm_language_prompt

    german = llm_language_prompt("de")
    automatic = llm_language_prompt("auto")

    assert "Use German" in german
    assert "all reasoning and thinking" in german
    assert "final response" in german
    assert "user's current message" in automatic
    assert llm_language_prompt("unsupported") == ""


def test_protected_prompt_precedes_editable_prompt():
    from src.chat_processor import ChatProcessor

    preface, _ = ChatProcessor(None).build_context_preface(
        message="hello",
        session=None,
        use_rag=False,
        preset_system_prompt="editable preset",
        agent_mode=True,
    )

    assert preface[0] == {"role": "system", "content": TALOS_SYSTEM_PROMPT}
    assert preface[1] == {"role": "system", "content": "editable preset"}


def test_ask_user_forbids_rendering_the_options_as_prose():
    """A model that decides to ask, then writes `[Option A · Option B]` into its
    reply, produces something that looks like buttons and does nothing — the
    user has to retype a choice the model already had. Seen in the wild, so the
    rule is pinned in all three places the model can read a tool from: the
    agent-mode prompt section, the function schema, and the retrieval index.
    """
    from src.agent_loop import TOOL_SECTIONS
    from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

    section = TOOL_SECTIONS["ask_user"]
    assert "Offering a choice IS this tool" in section
    assert "Option A · Option B" in section

    schema = next(s for s in FUNCTION_TOOL_SCHEMAS if s["function"]["name"] == "ask_user")
    assert "OFFERING A CHOICE IS THIS TOOL, NOT PROSE" in schema["function"]["description"]

    assert "look like buttons and do nothing" in BUILTIN_TOOL_DESCRIPTIONS["ask_user"]
