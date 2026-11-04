"""A small model titles a chat right away; the chat model waits for the answer."""

import asyncio
from types import SimpleNamespace

import pytest

from routes import chat_helpers, chat_routes
from src import endpoint_resolver, llm_core, settings

CHAT = ("http://llm:8000/v1/chat/completions", "qwen3-llm", {})
UTILITY = ("http://llm:8005/v1/chat/completions", "qwen3-small", {})
SUBAGENT = ("http://llm:8006/v1/chat/completions", "qwen3-helper", {})


def _fake_auto_name(calls, small_result):
    async def fake(session_manager, sess, lang=None, small_only=False):
        calls.append((lang, small_only))
        return small_result if small_only else True

    return fake


async def test_small_model_titles_without_waiting_for_the_stream(monkeypatch):
    calls = []
    monkeypatch.setattr(chat_routes, "auto_name_session", _fake_auto_name(calls, True))
    monkeypatch.setattr(chat_routes, "_active_streams", {"s0": {"status": "streaming"}})
    await asyncio.wait_for(chat_routes._auto_name_for_stream(None, None, "s0", lang="de"), 1)
    assert calls == [("de", True)]


async def test_chat_model_title_waits_for_the_stream_to_end(monkeypatch):
    calls = []
    monkeypatch.setattr(chat_routes, "auto_name_session", _fake_auto_name(calls, False))
    monkeypatch.setattr(chat_routes, "_active_streams", {})
    task = asyncio.create_task(chat_routes._auto_name_for_stream(None, None, "s1", lang="de"))
    await asyncio.sleep(0.1)
    chat_routes._active_streams["s1"] = {"status": "streaming"}
    await asyncio.sleep(1.2)
    assert calls == [("de", True)]  # still streaming
    chat_routes._active_streams.pop("s1")
    await asyncio.wait_for(task, 3)
    assert calls == [("de", True), ("de", False)]


async def test_title_still_comes_when_the_stream_never_starts(monkeypatch):
    calls = []
    monkeypatch.setattr(chat_routes, "auto_name_session", _fake_auto_name(calls, False))
    monkeypatch.setattr(chat_routes, "_active_streams", {})
    monkeypatch.setattr(chat_routes, "_AUTO_NAME_REGISTER_WAIT_S", 0.2)
    await asyncio.wait_for(chat_routes._auto_name_for_stream(None, None, "s2"), 3)
    assert calls == [(None, True), (None, False)]


@pytest.fixture
def naming(monkeypatch):
    """A chat with its first message; configure() sets the models, `asked` lists
    each model chain sent to the LLM."""
    state = SimpleNamespace(asked=[], reply="Zeiterfassung einrichten", names=[])

    def configure(utility=None, subagent=None):
        monkeypatch.setattr(
            endpoint_resolver,
            "resolve_endpoint",
            lambda prefix, url, model, headers, owner=None: utility or (url, model, headers),
        )
        monkeypatch.setattr(
            endpoint_resolver, "resolve_utility_fallback_candidates", lambda owner=None: []
        )
        monkeypatch.setattr(
            endpoint_resolver, "resolve_endpoint_by_id", lambda ep, model, owner=None: subagent
        )
        monkeypatch.setattr(
            settings,
            "get_setting",
            lambda key, default=None: "ep-small"
            if key == "subagent_endpoint_id" and subagent
            else default,
        )

    async def fake_llm(candidates, messages, **kwargs):
        state.asked.append([c[1] for c in candidates])
        if state.reply is None:
            raise RuntimeError("offline")
        return state.reply

    monkeypatch.setattr(llm_core, "llm_call_async_with_fallback", fake_llm)
    state.configure = configure
    state.sess = SimpleNamespace(
        id="s",
        owner=None,
        endpoint_url=CHAT[0],
        model=CHAT[1],
        headers=CHAT[2],
        history=[SimpleNamespace(role="user", content="Wie richte ich die Zeiterfassung ein?")],
    )
    state.manager = SimpleNamespace(update_session_name=lambda _id, name: state.names.append(name))
    return state


async def test_small_only_uses_the_utility_model(naming):
    naming.configure(utility=UTILITY)
    assert await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.asked == [["qwen3-small"]]
    assert naming.names == ["Zeiterfassung einrichten"]


async def test_small_only_uses_the_subagent_model_when_utility_is_unset(naming):
    naming.configure(subagent=SUBAGENT)
    assert await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.asked == [["qwen3-helper"]]


async def test_small_only_never_asks_the_chat_model(naming):
    naming.configure()
    assert not await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.asked == []
    assert naming.names == []


async def test_utility_set_to_the_chat_model_is_not_a_small_model(naming):
    naming.configure(utility=CHAT)
    assert not await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.asked == []


async def test_failed_small_model_leaves_the_placeholder_for_the_full_chain(naming):
    naming.configure(utility=UTILITY)
    naming.reply = None
    assert not await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.names == []


async def test_unusable_small_title_leaves_the_placeholder_for_the_full_chain(naming):
    naming.configure(utility=UTILITY)
    naming.reply = "x" * 200
    assert not await chat_helpers.auto_name_session(naming.manager, naming.sess, small_only=True)
    assert naming.names == []


async def test_full_chain_ends_on_the_chat_model(naming):
    naming.configure(utility=UTILITY, subagent=SUBAGENT)
    assert await chat_helpers.auto_name_session(naming.manager, naming.sess)
    assert naming.asked[0][0] == "qwen3-small"
    assert naming.asked[0][-1] == "qwen3-llm"


async def test_full_chain_without_small_model_starts_on_the_chat_model(naming):
    naming.configure()
    assert await chat_helpers.auto_name_session(naming.manager, naming.sess)
    assert naming.asked[0][0] == "qwen3-llm"
