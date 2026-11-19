"""A tool that is off for the turn: what the model is told before and after it calls it.

In the model test of 2026-11 a switched-off ``web_search`` was called 18 times.
The model's reasoning showed why: the date note in every turn sends dated claims
"to the web", nothing said the web was off, and the refusal ("disabled by user")
did not say how to go on.
"""

import pytest

from src import tool_execution, user_time


class _Block:
    def __init__(self, tool_type, content):
        self.tool_type = tool_type
        self.content = content


def test_the_date_note_sends_dated_claims_to_the_web_only_when_there_is_one():
    with_web = user_time.current_datetime_prompt()
    without = user_time.current_datetime_prompt(web=False)
    assert "otherwise the web" in with_web and "not available" not in with_web
    assert "otherwise the web" not in without
    assert "Web search is not available in this turn" in without
    assert "not checked against current sources" in without
    # The rest of the note is the same either way.
    assert with_web.split("Look it up")[0] == without.split("Look it up")[0]
    assert with_web.endswith("you do know.\n\n") and without.endswith("you do know.\n\n")


@pytest.mark.asyncio
async def test_a_call_of_a_switched_off_tool_says_how_to_go_on():
    desc, result = await tool_execution.execute_tool_block(
        _Block("web_search", '{"query": "Feiertage 2027"}'),
        session_id=None,
        disabled_tools={"web_search", "web_fetch"},
    )
    assert desc == "web_search: BLOCKED" and result["exit_code"] == 1
    assert "`web_search` is not available in this turn" in result["error"]
    assert "do not call it again" in result["error"]
    # A tool is also off by mode or by an admin's setting, so nobody is named.
    assert "by user" not in result["error"]
