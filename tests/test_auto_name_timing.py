"""Chat titles are generated after the first response, not alongside it."""

import asyncio

from routes import chat_routes


async def test_title_waits_for_the_stream_to_end(monkeypatch):
    calls = []

    async def fake_auto_name(session_manager, sess, lang=None):
        calls.append(lang)

    monkeypatch.setattr(chat_routes, "auto_name_session", fake_auto_name)
    monkeypatch.setattr(chat_routes, "_active_streams", {})
    task = asyncio.create_task(chat_routes._auto_name_after_stream(None, None, "s1", lang="de"))
    await asyncio.sleep(0.1)
    chat_routes._active_streams["s1"] = {"status": "streaming"}
    await asyncio.sleep(1.2)
    assert calls == []  # still streaming
    chat_routes._active_streams.pop("s1")
    await asyncio.wait_for(task, 3)
    assert calls == ["de"]


async def test_title_still_comes_when_the_stream_never_starts(monkeypatch):
    calls = []

    async def fake_auto_name(session_manager, sess, lang=None):
        calls.append(lang)

    monkeypatch.setattr(chat_routes, "auto_name_session", fake_auto_name)
    monkeypatch.setattr(chat_routes, "_active_streams", {})
    monkeypatch.setattr(chat_routes, "_AUTO_NAME_REGISTER_WAIT_S", 0.2)
    await asyncio.wait_for(chat_routes._auto_name_after_stream(None, None, "s2"), 3)
    assert calls == [None]
