"""Per-user custom instructions appended to the system prompt."""

from routes.chat_helpers import MAX_USER_INSTRUCTIONS_CHARS, user_instructions_prompt


def test_enabled_instructions_are_framed_as_user_preferences():
    out = user_instructions_prompt(
        {"custom_instructions": {"enabled": True, "text": "  Antworte knapp.  "}}
    )
    assert "<user_instructions>\nAntworte knapp.\n</user_instructions>" in out
    assert "unless they conflict" in out


def test_disabled_empty_or_malformed_add_nothing():
    for prefs in (
        {},
        None,
        {"custom_instructions": {"enabled": False, "text": "x"}},
        {"custom_instructions": {"enabled": True, "text": "   "}},
        {"custom_instructions": "raw string"},
    ):
        assert user_instructions_prompt(prefs) == ""


def test_length_is_capped():
    out = user_instructions_prompt(
        {"custom_instructions": {"text": "a" * (MAX_USER_INSTRUCTIONS_CHARS + 50)}}
    )
    assert out.count("a" * MAX_USER_INSTRUCTIONS_CHARS) == 1
    assert "a" * (MAX_USER_INSTRUCTIONS_CHARS + 1) not in out
