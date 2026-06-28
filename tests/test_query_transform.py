"""Unit tests for Phase 7 conversation-aware query rewrite.

The utility-LLM call is injected via ``sys.modules`` so these stay pure (no real
endpoint, no heavy imports).
"""

import importlib
import sys
import types

cp_mod = importlib.import_module("src.chat_processor")


class _Msg:
    def __init__(self, role, content):
        self.role = role
        self.content = content


class _Session:
    def __init__(self, history):
        self.history = history


def _cp():
    return cp_mod.ChatProcessor(None, None)


def _inject_llm(monkeypatch, *, resolve, llm_call):
    er = types.ModuleType("src.endpoint_resolver")
    er.resolve_endpoint = resolve
    lc = types.ModuleType("src.llm_core")
    lc.llm_call = llm_call
    monkeypatch.setitem(sys.modules, "src.endpoint_resolver", er)
    monkeypatch.setitem(sys.modules, "src.llm_core", lc)


def test_rewrite_disabled_returns_raw(monkeypatch):
    cp = _cp()
    monkeypatch.setattr(cp, "_rag_cfg", lambda: {})  # toggle off
    sess = _Session([_Msg("user", "hi"), _Msg("assistant", "hello")])
    assert cp._maybe_rewrite_query("and the second?", sess, None) == "and the second?"


def test_rewrite_no_prior_turn_returns_raw(monkeypatch):
    cp = _cp()
    monkeypatch.setattr(cp, "_rag_cfg", lambda: {"query_rewrite_enabled": True})
    sess = _Session([_Msg("user", "only one turn")])
    # Nothing to disambiguate against → no LLM call, raw message back.
    assert cp._maybe_rewrite_query("only one turn", sess, None) == "only one turn"


def test_rewrite_uses_history(monkeypatch):
    cp = _cp()
    monkeypatch.setattr(cp, "_rag_cfg", lambda: {"query_rewrite_enabled": True})
    _inject_llm(
        monkeypatch,
        resolve=lambda *a, **k: ("http://u/v1/chat/completions", "util", {}),
        llm_call=lambda *a, **k: "Qwen3-VL embedding dimension",
    )
    sess = _Session(
        [
            _Msg("user", "what dimension does the embedder return"),
            _Msg("assistant", "1024"),
            _Msg("user", "and the second one?"),
        ]
    )
    assert (
        cp._maybe_rewrite_query("and the second one?", sess, None) == "Qwen3-VL embedding dimension"
    )


def test_rewrite_falls_back_on_llm_error(monkeypatch):
    cp = _cp()
    monkeypatch.setattr(cp, "_rag_cfg", lambda: {"query_rewrite_enabled": True})

    def _boom(*a, **k):
        raise RuntimeError("llm down")

    _inject_llm(monkeypatch, resolve=lambda *a, **k: ("http://u", "util", {}), llm_call=_boom)
    sess = _Session([_Msg("user", "a"), _Msg("assistant", "b")])
    assert cp._maybe_rewrite_query("c", sess, None) == "c"


def test_rewrite_falls_back_when_no_endpoint(monkeypatch):
    cp = _cp()
    monkeypatch.setattr(cp, "_rag_cfg", lambda: {"query_rewrite_enabled": True})
    _inject_llm(
        monkeypatch,
        resolve=lambda *a, **k: (None, None, None),  # utility model unconfigured
        llm_call=lambda *a, **k: "should not be called",
    )
    sess = _Session([_Msg("user", "a"), _Msg("assistant", "b")])
    assert cp._maybe_rewrite_query("c", sess, None) == "c"
