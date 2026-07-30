"""Tests for the default-settings leak in ``src.settings``.

The regression: routes persist config as ``save_settings(load_settings())``, and
``load_settings`` merges DEFAULT_SETTINGS — so saving unrelated RAG or SQL
config wrote every default key to disk. `agent_input_token_budget` then looked
explicitly set at its 6000 default, which pinned the agent input budget to 6000
on a 262k-context model, held tool-output compression at full aggression in
every session, and trimmed conversation history to 6000 tokens.
"""

import json

import pytest

from src import settings as st


@pytest.fixture(autouse=True)
def _settings_file(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    monkeypatch.setattr(st, "SETTINGS_FILE", str(path))
    monkeypatch.setattr(st, "_settings_cache", None, raising=False)
    return path


def _write(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


# ── is_setting_overridden: presence is not intent ──


def test_default_valued_key_is_not_an_override(_settings_file):
    default = st.DEFAULT_SETTINGS["agent_input_token_budget"]
    _write(_settings_file, {"agent_input_token_budget": default})
    assert st.is_setting_overridden("agent_input_token_budget") is False


def test_non_default_value_is_an_override(_settings_file):
    _write(_settings_file, {"agent_input_token_budget": 64000})
    assert st.is_setting_overridden("agent_input_token_budget") is True


def test_absent_key_is_not_an_override(_settings_file):
    _write(_settings_file, {"something_else": 1})
    assert st.is_setting_overridden("agent_input_token_budget") is False


def test_missing_file_is_not_an_override(_settings_file):
    assert st.is_setting_overridden("agent_input_token_budget") is False


# ── save_settings: stop writing the whole default set ──


def test_saving_merged_defaults_does_not_persist_them(_settings_file):
    """The exact failing path: a route saves one key from a merged dict."""
    _write(_settings_file, {"rag_pipeline": {"enabled": False}})
    st._settings_cache = None

    merged = st.load_settings()
    merged["rag_pipeline"] = {"enabled": True}
    st.save_settings(merged)

    saved = _read(_settings_file)
    assert saved["rag_pipeline"] == {"enabled": True}
    assert "agent_input_token_budget" not in saved
    assert "agent_max_rounds" not in saved


def test_genuine_non_default_choice_survives(_settings_file):
    _write(_settings_file, {})
    st._settings_cache = None

    merged = st.load_settings()
    merged["agent_input_token_budget"] = 200000
    st.save_settings(merged)

    assert _read(_settings_file)["agent_input_token_budget"] == 200000


def test_already_present_key_is_not_pruned(_settings_file):
    """A user who deliberately pinned a value equal to the default keeps it in
    the file — we only decline to ADD default-valued keys."""
    _write(_settings_file, {"agent_input_token_budget": 6000})
    st._settings_cache = None

    merged = st.load_settings()
    merged["theme"] = "dark"
    st.save_settings(merged)

    assert _read(_settings_file)["agent_input_token_budget"] == 6000


def test_non_default_keys_unknown_to_defaults_are_kept(_settings_file):
    _write(_settings_file, {})
    st._settings_cache = None
    st.save_settings({"sql_databases": [{"id": "x"}]})
    assert _read(_settings_file)["sql_databases"] == [{"id": "x"}]


# ── The end-to-end consequence ──


def test_budget_scales_to_the_window_after_an_unrelated_save(_settings_file):
    """With the leak, this returned 6000 for a 262k model."""
    from src.context_budget import compute_input_token_budget

    _write(_settings_file, {"rag_pipeline": {"enabled": False}})
    st._settings_cache = None
    merged = st.load_settings()
    merged["rag_pipeline"] = {"enabled": True}
    st.save_settings(merged)
    st._settings_cache = None

    budget = compute_input_token_budget(
        st.get_setting("agent_input_token_budget", 6000),
        262_144,
        st.is_setting_overridden("agent_input_token_budget"),
    )
    assert budget == 200_000
