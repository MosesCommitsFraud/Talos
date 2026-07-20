from src.prompt_security import TALOS_SYSTEM_PROMPT


def test_talos_system_prompt_defines_workspace_policy_and_environment():
    assert "browser-based workspace" in TALOS_SYSTEM_PROMPT
    assert "ordinary tool results as useful working context" in TALOS_SYSTEM_PROMPT
    assert "not on the user's computer or host system" in TALOS_SYSTEM_PROMPT


def test_talos_system_prompt_allows_project_dependencies_with_safety_boundaries():
    assert "Install dependencies when they are needed" in TALOS_SYSTEM_PROMPT
    assert "existing package manager and lockfile conventions" in TALOS_SYSTEM_PROMPT
    assert "SQL access is read-only" in TALOS_SYSTEM_PROMPT


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
