"""Tests for src/context_optimizer.py (headroom-style tool output compression)."""

import json

import pytest

from src import context_optimizer as co


@pytest.fixture(autouse=True)
def _force_enabled(monkeypatch):
    monkeypatch.setattr(co, "compression_enabled", lambda: True)


def test_small_output_untouched():
    text = "short output"
    assert co.optimize_tool_output(text, tool_name="bash") == text


def test_large_json_array_is_crushed_and_reversible():
    rows = [
        {"id": i, "name": f"user{i}", "email": f"user{i}@example.com", "bio": "x" * 80}
        for i in range(500)
    ]
    text = json.dumps(rows)
    out = co.optimize_tool_output(text, tool_name="api_call")

    assert len(out) < len(text) / 2
    assert "items omitted" in out
    assert "expand_output" in out

    # Marker carries a retrievable id pointing at the FULL original.
    oid = out.split("id `")[1].split("`")[0]
    stored = co.get_stored_output(oid)
    assert stored is not None
    assert stored["text"] == text


def test_repeated_log_lines_collapse():
    lines = ["2026-06-10 12:00:00 INFO heartbeat ok"] * 300
    lines.append("2026-06-10 12:05:00 ERROR something broke")
    text = "\n".join(lines) + "\n" + ("filler " * 800)
    out = co.optimize_tool_output(text, tool_name="bash")
    assert "repeated" in out
    assert len(out) < len(text)


def test_head_tail_keeps_both_ends():
    text = (
        "START-MARKER\n" + "".join(f"middle filler line {i}\n" for i in range(3000)) + "END-MARKER"
    )
    out = co.optimize_tool_output(text, tool_name="read_file")
    assert out.startswith("START-MARKER")
    assert "END-MARKER" in out
    assert "chars omitted" in out


def test_disabled_passthrough(monkeypatch):
    monkeypatch.setattr(co, "compression_enabled", lambda: False)
    text = "x\n" * 50_000
    assert co.optimize_tool_output(text) == text


def test_expand_output_full_and_search_and_paging():
    original = "\n".join(f"line {i}: {'needle' if i == 777 else 'hay'}" for i in range(2000))
    oid = co._store_original(original, "bash")

    full = co.do_expand_output(oid)
    assert full["exit_code"] == 0
    assert "page 1/" in full["output"]

    found = co.do_expand_output(f"{oid}\nneedle")
    assert "line 777" in found["output"]

    page2 = co.do_expand_output(f"{oid}\n2")
    assert "page 2/" in page2["output"]


def test_expand_output_unknown_id():
    result = co.do_expand_output("out_doesnotexist")
    assert "error" in result


def test_store_eviction_bounded():
    for i in range(co._STORE_MAX_ENTRIES + 50):
        co._store_original(f"payload {i}", "bash")
    assert len(co._store) <= co._STORE_MAX_ENTRIES


def test_compact_threshold_clamps(monkeypatch):
    from src import context_compactor as cc

    monkeypatch.setattr("src.settings.load_settings", lambda: {"compact_threshold": 70})
    assert cc.get_compact_threshold() == 0.70

    monkeypatch.setattr("src.settings.load_settings", lambda: {"compact_threshold": 0.05})
    assert cc.get_compact_threshold() == 0.30

    monkeypatch.setattr("src.settings.load_settings", lambda: {"compact_threshold": "bogus"})
    assert cc.get_compact_threshold() == cc.COMPACT_THRESHOLD
