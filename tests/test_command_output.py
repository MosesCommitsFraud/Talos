"""Long command output keeps its end, where the error is, and the complete
output stays readable."""

import re

import pytest

from src import context_optimizer, sandbox_client, tool_execution
from src.tool_execution import (
    MAX_OUTPUT_CHARS,
    OUTPUT_HEAD_CHARS,
    OUTPUT_TAIL_CHARS,
    shorten_output,
    shorten_output_to_workspace,
)

LONG = "START\n" + "\n".join(f"line {i}" for i in range(5000)) + "\nTraceback: ValueError: boom"


def test_short_output_is_untouched():
    assert shorten_output("ok\n", "bash") == "ok\n"
    assert shorten_output("x" * MAX_OUTPUT_CHARS, "bash") == "x" * MAX_OUTPUT_CHARS


def test_long_output_keeps_start_and_end_and_points_to_the_rest():
    short = shorten_output(LONG, "bash")

    assert short.startswith("START\nline 0")
    assert short.endswith("Traceback: ValueError: boom")
    assert short[:OUTPUT_HEAD_CHARS] == LONG[:OUTPUT_HEAD_CHARS]
    assert short[-OUTPUT_TAIL_CHARS:] == LONG[-OUTPUT_TAIL_CHARS:]
    assert len(short) < MAX_OUTPUT_CHARS + 400
    assert f"of {len(LONG):,} characters are left out" in short

    # The complete output can be read back through expand_output.
    oid = re.search(r"id `(out_[0-9a-f]+)`", short).group(1)
    assert context_optimizer.get_stored_output(oid)["text"] == LONG
    assert "line 2500" in context_optimizer.do_expand_output(f"{oid}\nline 2500")["output"]


async def test_with_a_workspace_the_complete_output_becomes_a_file(monkeypatch):
    written = {}

    async def fake_file_tool(*, owner, session_id, operation, payload):
        written.update(owner=owner, session_id=session_id, operation=operation, **payload)
        return {"exit_code": 0}

    monkeypatch.setattr(sandbox_client, "file_tool_in_sandbox", fake_file_tool)
    short = await shorten_output_to_workspace(LONG, "python", "anna", "chat-1")

    assert written["operation"] == "write" and written["content"] == LONG
    assert (written["owner"], written["session_id"]) == ("anna", "chat-1")
    # In the working-data folder the sandbox hides from the user's file list.
    assert re.fullmatch(r"\.talos-data/python_[0-9a-f]{10}\.log", written["path"])
    assert f"`{written['path']}`" in short and "read_file" in short and "grep" in short
    assert short.endswith("Traceback: ValueError: boom")
    assert "expand_output" not in short


async def test_without_a_workspace_or_when_the_write_fails_the_store_takes_over(monkeypatch):
    async def broken_file_tool(**kwargs):
        raise RuntimeError("sandbox down")

    monkeypatch.setattr(sandbox_client, "file_tool_in_sandbox", broken_file_tool)
    failed = await shorten_output_to_workspace(LONG, "bash", "anna", "chat-1")
    no_session = await shorten_output_to_workspace(LONG, "bash", "anna", None)

    for short in (failed, no_session):
        assert "expand_output" in short and ".talos-data" not in short
        assert short.endswith("Traceback: ValueError: boom")


async def test_sandboxed_commands_return_the_end_of_their_output(monkeypatch):
    async def fake_exec(**kwargs):
        return {"stdout": LONG, "stderr": "final error line", "exit_code": 1}

    async def fake_file_tool(**kwargs):
        return {"exit_code": 0}

    monkeypatch.setattr(sandbox_client, "sandbox_enabled", lambda: True)
    monkeypatch.setattr(sandbox_client, "exec_in_sandbox", fake_exec)
    monkeypatch.setattr(sandbox_client, "file_tool_in_sandbox", fake_file_tool)
    result = await tool_execution._try_sandbox_exec(
        tool="python", content="print(1)", session_id="chat-1", owner="anna", timeout=0
    )

    assert result["exit_code"] == 1
    assert "STDERR: final error line" in result["output"][-200:]
    assert result["output"].startswith("START")


@pytest.mark.parametrize("size", [MAX_OUTPUT_CHARS + 1, 50_000, 3_000_000])
def test_the_result_stays_bounded_whatever_the_output_size(size):
    assert len(shorten_output("z" * size, "bash")) < MAX_OUTPUT_CHARS + 400
