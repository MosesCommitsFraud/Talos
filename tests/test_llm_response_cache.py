"""llm_call's response cache must never swallow a sampled request."""

from src import llm_core


def test_sampled_calls_are_not_cached():
    msgs = [{"role": "user", "content": "wer ist markus rühl"}]
    assert llm_core._get_cache_key("u", "m", msgs, 0.3, 100) is None
    assert llm_core._get_cached_response(None) is None
    llm_core._set_cached_response(None, "Titel")  # no-op, must not raise


def test_deterministic_calls_expire(monkeypatch):
    monkeypatch.setattr(llm_core, "_response_cache", {})
    key = llm_core._get_cache_key("u", "m", [{"role": "user", "content": "x"}], 0.0, 100)
    llm_core._set_cached_response(key, "cached")
    assert llm_core._get_cached_response(key) == "cached"
    monkeypatch.setattr(llm_core, "_RESPONSE_CACHE_TTL_SECONDS", -1)
    assert llm_core._get_cached_response(key) is None


def test_reasoning_mode_is_part_of_the_key():
    msgs = [{"role": "user", "content": "x"}]
    on = llm_core._get_cache_key("u", "m", msgs, 0.0, 100, True, "low")
    off = llm_core._get_cache_key("u", "m", msgs, 0.0, 100, False, None)
    assert on != off
