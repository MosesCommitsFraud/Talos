"""Tests for src/context_optimizer.py (headroom-style tool output compression)."""

import json
import re

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


def test_low_pressure_passes_through_untouched():
    """With context to spare, a large output must NOT be truncated."""
    text = "START-MARKER\n" + "".join(f"line {i}\n" for i in range(3000)) + "END-MARKER"
    out = co.optimize_tool_output(
        text, tool_name="read_file", used_tokens=20_000, budget_tokens=200_000
    )
    assert out == text


def test_high_pressure_compresses_aggressively():
    text = "START-MARKER\n" + "".join(f"line {i}\n" for i in range(3000)) + "END-MARKER"
    out = co.optimize_tool_output(
        text, tool_name="read_file", used_tokens=190_000, budget_tokens=200_000
    )
    assert len(out) < len(text) / 2
    assert "expand_output" in out
    # At/above the ceiling the aggressive target applies.
    assert len(out) < co.TARGET_CHARS + 500


def test_mid_pressure_is_gentler_than_high_pressure():
    text = "START-MARKER\n" + "".join(f"line {i}\n" for i in range(6000)) + "END-MARKER"
    mid = co.optimize_tool_output(
        text, tool_name="read_file", used_tokens=150_000, budget_tokens=200_000
    )
    high = co.optimize_tool_output(
        text, tool_name="read_file", used_tokens=190_000, budget_tokens=200_000
    )
    assert len(text) > len(mid) > len(high)


def test_unmeasurable_pressure_falls_back_to_aggressive():
    """Callers that pass no budget keep the old unconditional behaviour."""
    text = "START-MARKER\n" + "".join(f"line {i}\n" for i in range(3000)) + "END-MARKER"
    assert len(co.optimize_tool_output(text, tool_name="read_file", budget_tokens=0)) < len(text)


def test_pressure_floor_boundary():
    assert co._thresholds_for_pressure(co.PRESSURE_FLOOR - 0.01) is None
    assert co._thresholds_for_pressure(co.PRESSURE_FLOOR) == (
        co.RELAXED_COMPRESS_CHARS,
        co.RELAXED_TARGET_CHARS,
    )
    assert co._thresholds_for_pressure(co.PRESSURE_CEILING) == (
        co.MIN_COMPRESS_CHARS,
        co.TARGET_CHARS,
    )
    # Above the ceiling stays clamped, never inverts.
    assert co._thresholds_for_pressure(3.0) == (co.MIN_COMPRESS_CHARS, co.TARGET_CHARS)


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


# ── The expand_output recursion ──
#
# The regression: expanding a compressed output produced a result large enough
# to be compressed and re-stored, so the model expanded the expansion — 8 rounds
# of out_a41c8662 -> out_f4ef04cc -> out_3bffd6e5 before giving up and inventing
# the content it never reached.


def test_expand_output_is_never_recompressed():
    text = "START\n" + "".join(f"retrieved line {i}\n" for i in range(4000)) + "END"
    out = co.optimize_tool_output(
        text, tool_name="expand_output", used_tokens=190_000, budget_tokens=200_000
    )
    assert out == text
    assert "Output compressed" not in out


def test_expand_page_cannot_reach_the_gentlest_compression_floor():
    """Defence in depth: even if the exemption were lost, a full page must be
    too small for the relaxed floor to catch it."""
    assert co.EXPAND_PAGE_CHARS < co.RELAXED_COMPRESS_CHARS


def test_expanding_a_compressed_output_round_trips_in_one_hop():
    original = "HEAD-MARKER\n" + "".join(f"row {i}\n" for i in range(6000)) + "TAIL-MARKER"
    compressed = co.optimize_tool_output(
        original, tool_name="api_call", used_tokens=190_000, budget_tokens=200_000
    )
    oid = re.search(r"`(out_[0-9a-f]{8})`", compressed).group(1)

    expanded = co.do_expand_output(oid)["output"]
    # The expansion is real content, not another "Stored output" wrapper.
    assert "HEAD-MARKER" in expanded
    assert expanded.count("Stored output") == 1
    # And it survives the optimizer untouched, so no second id is minted.
    assert (
        co.optimize_tool_output(
            expanded, tool_name="expand_output", used_tokens=190_000, budget_tokens=200_000
        )
        == expanded
    )


# ── Which tools are exempt ──


@pytest.mark.parametrize(
    "tool", ["browse_skills", "read_skill", "expand_output", "search_knowledge", "web_fetch"]
)
def test_retrieval_and_instruction_tools_pass_through(tool):
    text = "A\n" + "".join(f"passage line {i}\n" for i in range(1500)) + "Z"
    assert co.RELAXED_COMPRESS_CHARS < len(text) < co.EXEMPTION_CEILING_CHARS
    out = co.optimize_tool_output(
        text, tool_name=tool, used_tokens=190_000, budget_tokens=200_000
    )
    assert out == text


@pytest.mark.parametrize("tool", ["bash", "python", "run_cell", "query_sql", "api_call"])
def test_capped_tools_still_compress_under_real_pressure(tool):
    """These are capped upstream (10k), so they only reach compression when the
    context is genuinely full — exactly when it's the right trade."""
    text = "START-MARKER\n" + "".join(f"line {i}\n" for i in range(3000)) + "END-MARKER"
    out = co.optimize_tool_output(
        text, tool_name=tool, used_tokens=190_000, budget_tokens=200_000
    )
    assert len(out) < len(text)
    assert "expand_output" in out


def test_exemption_has_a_ceiling():
    """search_knowledge has no upstream cap; an enormous retrieval must not
    blow the window just because the tool is on the exempt list."""
    text = "x" * (co.EXEMPTION_CEILING_CHARS + 50_000)
    out = co.optimize_tool_output(
        text, tool_name="search_knowledge", used_tokens=190_000, budget_tokens=200_000
    )
    assert len(out) < len(text)
    assert "expand_output" in out


def test_expand_output_has_no_ceiling():
    text = "y" * (co.EXEMPTION_CEILING_CHARS + 50_000)
    assert (
        co.optimize_tool_output(
            text, tool_name="expand_output", used_tokens=190_000, budget_tokens=200_000
        )
        == text
    )


# ── Page-argument parsing ──


@pytest.mark.parametrize(
    "arg,expected",
    [
        ("2", 2),
        ("page 2", 2),
        ("page2", 2),
        ("p2", 2),
        ("Seite 3", 3),
        ("#4", 4),
        ("page: 5", 5),
        ("needle", None),
        ("", None),
        ("page", None),
    ],
)
def test_page_argument_forms(arg, expected):
    assert co._page_number(arg) == expected


def test_page_word_is_not_treated_as_a_search_term():
    """`page 1` used to fall through to search mode and return "No lines
    matching 'page 1'", burning rounds while the content stayed unreachable."""
    original = "\n".join(f"line {i}" for i in range(4000))
    oid = co._store_original(original, "search_knowledge")
    out = co.do_expand_output(f"{oid}\npage 1")["output"]
    assert "No lines matching" not in out
    assert "page 1/" in out


def test_partial_page_says_so_and_names_the_next_call():
    original = "\n".join(f"line {i}" for i in range(8000))
    oid = co._store_original(original, "search_knowledge")
    out = co.do_expand_output(f"{oid}\n1")["output"]
    assert "PARTIAL" in out
    assert oid in out
    assert "`2`" in out


def test_failed_search_points_at_paging():
    original = "\n".join(f"line {i}" for i in range(4000))
    oid = co._store_original(original, "search_knowledge")
    out = co.do_expand_output(f"{oid}\nzzz-not-present")["output"]
    assert "page" in out.lower()


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
