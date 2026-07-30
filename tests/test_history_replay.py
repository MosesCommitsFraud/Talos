"""Tests for replaying past tool calls into the prompt (``src.history_replay``).

The gap this closes: `ChatMessage` has only role/content/metadata, so a tool
exchange cannot be persisted as a message. Tool activity was saved in the
assistant message's `metadata.tool_events` for the UI and never fed back — so on
a later turn the model could see its own prose but not what any tool returned.
"""

import pytest

from src import history_replay as hr


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    """Isolate from the real settings file."""
    monkeypatch.setattr(hr, "replay_enabled", lambda: True)
    monkeypatch.setattr(hr, "_setting", lambda key, default: default)


def _turn(query, answer, events=None):
    msgs = [{"role": "user", "content": query}]
    assistant = {"role": "assistant", "content": answer}
    if events is not None:
        assistant["metadata"] = {"tool_events": events}
    msgs.append(assistant)
    return msgs


def _ev(tool="query_sql", command='{"query": "SELECT 1"}', output="| n |\n| 1 |", rc=0):
    return {"tool": tool, "command": command, "output": output, "exit_code": rc}


def _replayed(msgs):
    return [m for m in msgs if (m.get("metadata") or {}).get("source") == hr.REPLAY_SOURCE]


# ── The core behaviour ──


def test_tool_output_is_replayed():
    msgs = _turn("how many?", "One row.", [_ev()])
    out = hr.expand_tool_history(msgs)
    blocks = _replayed(out)
    assert len(blocks) == 1
    assert "SELECT 1" in blocks[0]["content"]
    assert "| 1 |" in blocks[0]["content"]


def test_replay_is_inserted_before_its_assistant_message():
    """Order must read: user asked -> tools returned this -> assistant answered."""
    msgs = _turn("q", "a", [_ev()])
    out = hr.expand_tool_history(msgs)
    roles = [(m["role"], (m.get("metadata") or {}).get("source")) for m in out]
    assert roles == [
        ("user", None),
        ("user", hr.REPLAY_SOURCE),
        ("assistant", None),
    ]


def test_turns_without_tools_are_untouched():
    msgs = _turn("hi", "hello")
    assert hr.expand_tool_history(msgs) == msgs


def test_empty_tool_events_list_is_untouched():
    msgs = _turn("hi", "hello", [])
    assert hr.expand_tool_history(msgs) == msgs


def test_input_list_is_not_mutated():
    msgs = _turn("q", "a", [_ev()])
    before = len(msgs)
    hr.expand_tool_history(msgs)
    assert len(msgs) == before


def test_multiple_turns_each_get_a_block():
    msgs = _turn("q1", "a1", [_ev()]) + _turn("q2", "a2", [_ev(tool="bash", command="ls")])
    out = hr.expand_tool_history(msgs)
    assert len(_replayed(out)) == 2


def test_disabled_is_a_passthrough():
    msgs = _turn("q", "a", [_ev()])
    assert hr.expand_tool_history(msgs, enabled=False) == msgs


def test_the_current_user_turn_stays_last():
    """Downstream code finds the live query as the LAST user message — a replay
    block must never end up after it."""
    msgs = _turn("q1", "a1", [_ev()]) + [{"role": "user", "content": "follow-up"}]
    out = hr.expand_tool_history(msgs)
    last_user = next(m for m in reversed(out) if m["role"] == "user")
    assert last_user["content"] == "follow-up"


# ── Formatting ──


def test_exit_code_is_shown_only_when_nonzero():
    assert "(exit 1)" in hr.format_tool_events([_ev(rc=1)])
    assert "exit" not in hr.format_tool_events([_ev(rc=0)])


def test_missing_output_is_labelled():
    assert "(no output)" in hr.format_tool_events([_ev(output="")])


def test_json_arguments_are_compacted():
    block = hr.format_tool_events([_ev(command='{\n  "query":  "SELECT 1"\n}')])
    assert '{"query": "SELECT 1"}' in block


def test_plain_shell_command_passes_through():
    assert "ls -la" in hr.format_tool_events([_ev(tool="bash", command="ls -la")])


def test_malformed_events_are_skipped():
    assert hr.format_tool_events(["not a dict", None]) == ""


def test_non_json_braced_argument_is_left_alone():
    block = hr.format_tool_events([_ev(command="{not json")])
    assert "{not json" in block


# ── Lossless by default ──


def test_shipped_defaults_are_unbounded():
    """Replay must not silently drop history. Capping it is the gradual loss that
    compaction exists to replace, so every cap ships at 0 = unbounded."""
    from src.settings import DEFAULT_SETTINGS

    for key in (
        "history_tool_output_max_chars",
        "history_retrieval_output_max_chars",
        "history_tool_turn_max_chars",
        "history_tool_total_max_chars",
    ):
        assert DEFAULT_SETTINGS[key] == 0, key
    assert DEFAULT_SETTINGS["history_tool_replay_enabled"] is True


def test_module_fallbacks_match_the_shipped_defaults():
    """These are used when settings can't be read — if they disagreed with
    DEFAULT_SETTINGS, a settings failure would silently reintroduce caps."""
    assert hr.DEFAULT_OUTPUT_MAX_CHARS == 0
    assert hr.DEFAULT_RETRIEVAL_OUTPUT_MAX_CHARS == 0
    assert hr.DEFAULT_TURN_MAX_CHARS == 0
    assert hr.DEFAULT_TOTAL_MAX_CHARS == 0


def test_nothing_is_truncated_with_default_caps():
    big = "P" * 60_000
    block = hr.format_tool_events([_ev(tool="search_knowledge", output=big)])
    assert "truncated" not in block
    assert big in block


def test_long_conversation_keeps_every_turn():
    msgs = []
    for i in range(30):
        msgs += _turn(f"q{i}", f"a{i}", [_ev(output=f"OUTPUT-{i} " + "z" * 2000)])
    out = hr.expand_tool_history(msgs)
    kept = "\n".join(m["content"] for m in _replayed(out))
    assert len(_replayed(out)) == 30
    assert "OUTPUT-0" in kept
    assert "OUTPUT-29" in kept


# ── Budgets, when explicitly set ──


def test_output_is_truncated_per_call():
    block = hr.format_tool_events([_ev(output="x" * 5000)], output_max_chars=100)
    assert "chars truncated" in block
    assert len(block) < 500


def test_turn_cap_applies():
    block = hr.format_tool_events(
        [_ev(output="y" * 900) for _ in range(20)],
        output_max_chars=1000,
        turn_max_chars=500,
    )
    assert len(block) < 700
    assert "truncated" in block


def test_total_budget_drops_oldest_turns_first(monkeypatch):
    """Recent tool output is what follow-ups ask about; stale records go first."""
    monkeypatch.setattr(
        hr,
        "_setting",
        lambda key, default: 300 if key == "history_tool_total_max_chars" else default,
    )
    msgs = []
    for i in range(6):
        msgs += _turn(f"q{i}", f"a{i}", [_ev(output=f"OUTPUT-{i} " + "z" * 150)])
    out = hr.expand_tool_history(msgs)
    kept = "\n".join(m["content"] for m in _replayed(out))
    assert "OUTPUT-5" in kept
    assert "OUTPUT-0" not in kept


def test_budget_zero_means_unbounded(monkeypatch):
    monkeypatch.setattr(hr, "_setting", lambda key, default: 0)
    msgs = []
    for i in range(4):
        msgs += _turn(f"q{i}", f"a{i}", [_ev(output=f"OUT-{i}")])
    out = hr.expand_tool_history(msgs)
    assert len(_replayed(out)) == 4


# ── Retrieval keeps a bigger share of the budget ──


def test_retrieval_output_is_not_cut_to_the_generic_cap():
    """A 13k knowledge-base hit truncated to 2k is a stub, and a stub is what
    invites the model to invent the rest."""
    kb = "PASSAGE " + "k" * 6000
    block = hr.format_tool_events(
        [_ev(tool="search_knowledge", command='{"query": "spark"}', output=kb)],
        output_max_chars=2000,
        turn_max_chars=100_000,
        retrieval_max_chars=8000,
    )
    assert "chars truncated" not in block
    assert len(block) > 6000


@pytest.mark.parametrize("tool", ["search_knowledge", "web_fetch", "web_search"])
def test_all_retrieval_tools_get_the_bigger_cap(tool):
    block = hr.format_tool_events(
        [_ev(tool=tool, output="r" * 5000)],
        output_max_chars=1000,
        turn_max_chars=100_000,
        retrieval_max_chars=8000,
    )
    assert "chars truncated" not in block


def test_shell_output_still_gets_the_generic_cap():
    block = hr.format_tool_events(
        [_ev(tool="bash", command="ls", output="b" * 5000)],
        output_max_chars=1000,
        turn_max_chars=100_000,
        retrieval_max_chars=8000,
    )
    assert "chars truncated" in block


# ── Artifact manifest ──


def _doc_event(doc_id="d1", title="Setup Guide"):
    return {
        "tool": "create_document",
        "command": "x",
        "output": "ok",
        "doc_id": doc_id,
        "doc_title": title,
    }


def test_manifest_lists_created_documents():
    msgs = _turn("make a doc", "done", [_doc_event()])
    manifest = hr.build_artifact_manifest(msgs)
    assert "Setup Guide" in manifest
    assert "#document-d1" in manifest
    assert "manage_documents" in manifest


def test_manifest_is_empty_without_artifacts():
    assert hr.build_artifact_manifest(_turn("hi", "hello", [_ev()])) == ""


def test_manifest_deduplicates_repeated_documents():
    msgs = _turn("a", "b", [_doc_event()]) + _turn("c", "d", [_doc_event(title="Renamed")])
    manifest = hr.build_artifact_manifest(msgs)
    assert manifest.count("#document-d1") == 1


def test_manifest_includes_created_files():
    ev = {"tool": "python", "command": "x", "output": "ok", "created_artifacts": ["chart.png"]}
    assert "chart.png" in hr.build_artifact_manifest(_turn("q", "a", [ev]))


def test_manifest_is_a_system_message_before_the_live_query():
    msgs = _turn("make a doc", "done", [_doc_event()]) + [{"role": "user", "content": "now what?"}]
    out = hr.expand_tool_history(msgs)
    manifest_idx = next(
        i
        for i, m in enumerate(out)
        if m["role"] == "system" and "Artifacts you created" in m["content"]
    )
    # Directly before the live query, and the query is still the last user message.
    assert out[manifest_idx + 1]["content"] == "now what?"
    assert next(m for m in reversed(out) if m["role"] == "user")["content"] == "now what?"


def test_manifest_appears_alongside_replayed_output():
    ev = _doc_event(doc_id="d9", title="Notes")
    ev["output"] = ""
    out = hr.expand_tool_history(_turn("q", "a", [ev]))
    assert any(m["role"] == "system" and "#document-d9" in m["content"] for m in out)


# ── The history-index interaction ──


def test_compactor_discounts_replayed_messages():
    """`_update_session_history` maps a prompt index onto session.history, which
    has no entry for a replayed record. Counting them would push the split past
    the real one and truncate stored history wrongly."""
    from src import context_compactor as cc

    msgs = [
        {"role": "user", "content": "q"},
        {"role": "user", "content": "replay", "metadata": {"source": hr.REPLAY_SOURCE}},
        {"role": "assistant", "content": "a"},
    ]
    assert cc._synthetic_count(msgs) == 1
    assert cc._synthetic_count([m for m in msgs if m["content"] != "replay"]) == 0
