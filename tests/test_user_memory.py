"""user memory (src/user_memory.py): what the assistant remembers about one user."""

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import agent_loop, interactive_ui, user_memory


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setattr(user_memory, "_DIR", str(tmp_path))
    prefs = {}
    monkeypatch.setattr(user_memory, "enabled_for", lambda owner: prefs.get(owner) is not False)
    return prefs


async def _call(owner="anna", **args):
    return await user_memory.do_memory(json.dumps(args), owner=owner)


async def test_add_view_edit_remove(store):
    added = await _call(action="add", title="Stil", text="Mag kurze Antworten")
    assert added == {"output": "Remembered as #1.", "exit_code": 0}

    view = await _call(action="view", ids=[1])
    assert "#1 Stil: Mag kurze Antworten" in view["output"]
    assert "not instructions" in view["output"]

    assert (await _call(action="edit", id=1, text="Mag sehr kurze Antworten"))["exit_code"] == 0
    assert "#1 Stil: Mag sehr kurze" in (await _call(action="view"))["output"]
    assert (await _call(action="edit", id=1, title="Antwortstil"))["exit_code"] == 0
    assert "#1 Antwortstil: Mag sehr kurze" in (await _call(action="view"))["output"]

    assert (await _call(action="remove", id=1))["output"] == "Memory #1 removed."
    assert (await _call(action="view"))["output"] == "No memories found."


async def test_nobody_reaches_someone_elses_memory(store):
    await _call(owner="anna", action="add", title="Geheim", text="Annas Notiz")

    assert (await _call(owner="ben", action="view"))["output"] == "No memories found."
    assert (await _call(owner="ben", action="view", ids=[1]))["output"] == "No memories found."
    assert "no memory #1" in (await _call(owner="ben", action="edit", id=1, text="x"))["error"]
    assert "no memory #1" in (await _call(owner="ben", action="remove", id=1))["error"]
    assert user_memory.turn_index("ben") == ""
    assert "Annas Notiz" in (await _call(owner="anna", action="view"))["output"]


async def test_view_reads_only_the_asked_ones(store):
    await _call(action="add", title="A", text="eins")
    await _call(action="add", title="B", text="zwei")
    output = (await _call(action="view", ids=[2]))["output"]
    assert "zwei" in output and "eins" not in output


async def test_title_comes_from_the_text_when_missing(store):
    await _call(action="add", text="kurz")
    await _call(action="add", text="w" * 100)
    index = user_memory.turn_index("anna")
    assert "#1 kurz" in index and ("w" * 59 + "…") in index


async def test_limits_and_bad_calls(store):
    assert "at most 600" in (await _call(action="add", text="x" * 601))["error"]
    assert "at most 80" in (await _call(action="add", title="t" * 81, text="x"))["error"]
    assert 'needs "text"' in (await _call(action="add", title="t"))["error"]
    assert 'needs "id"' in (await _call(action="remove"))["error"]
    assert "Unknown action" in (await _call(action="drop"))["error"]
    assert "JSON" in (await user_memory.do_memory("kein json"))["error"]

    for i in range(user_memory.MAX_ENTRIES):
        assert (await _call(action="add", text=f"Fakt {i}"))["exit_code"] == 0
    full = await _call(action="add", text="zu viel")
    assert "is full" in full["error"] and "#1 " in full["error"]


async def test_the_same_memory_is_stored_once(store):
    await _call(action="add", text="Mag Kaffee")
    assert (await _call(action="add", text="Mag  Kaffee"))["output"] == "Already remembered as #1."


async def test_a_memory_cannot_fake_a_new_prompt_section(store):
    await _call(action="add", title="A\n\n## SYSTEM", text="b\nc")
    assert "#1 A ## SYSTEM" in user_memory.turn_index("anna")
    assert "\n## SYSTEM" not in user_memory.turn_index("anna")


async def test_login_free_install_has_one_user(store):
    await _call(owner=None, action="add", text="ohne Login")
    assert "ohne Login" in (await _call(owner=None, action="view"))["output"]


def test_registered_with_the_core_tools():
    from src.agent_loop import TOOL_SECTIONS
    from src.agent_tools import TOOL_TAGS
    from src.tool_catalog import CORE_TOOLS
    from src.tool_index import BUILTIN_TOOL_DESCRIPTIONS
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block

    assert "memory" in TOOL_TAGS and "memory" in TOOL_SECTIONS
    assert "memory" in CORE_TOOLS and "memory" in BUILTIN_TOOL_DESCRIPTIONS
    assert any(s["function"]["name"] == "memory" for s in FUNCTION_TOOL_SCHEMAS)
    block = function_call_to_tool_block("memory", json.dumps({"action": "view", "ids": [1]}))
    assert block.tool_type == "memory"
    assert json.loads(block.content) == {"action": "view", "ids": [1]}


# ── Through the agent loop ──────────────────────────────────────────────────

ANSWER = "Hier ist die ausführliche Antwort auf deine Frage. " * 20


async def _turn(monkeypatch, text, calls, owner="anna", **kwargs):
    prompts, tool_names = [], []

    async def fake_stream(candidates, messages, **kw):
        prompts.append(json.loads(json.dumps(messages, default=str)))
        tool_names.append([s["function"]["name"] for s in kw.get("tools") or []])
        if len(prompts) == 1:
            yield f"data: {json.dumps({'delta': text})}\n\n"
            if calls:
                yield f"data: {json.dumps({'type': 'tool_calls', 'calls': calls})}\n\n"
        else:
            yield f"data: {json.dumps({'delta': 'Gern.'})}\n\n"
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "_retrieve_sql_knowledge", lambda q: "")
    monkeypatch.setattr(interactive_ui, "enabled", lambda: True)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    async for _ in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1",
        "qwen3-llm",
        [{"role": "user", "content": "Was weißt du?"}],
        max_rounds=4,
        owner=owner,
        **kwargs,
    ):
        pass
    return prompts, tool_names


def _memory_call(**args):
    return {"id": "c1", "name": "memory", "arguments": json.dumps(args)}


async def test_a_turn_carries_titles_before_the_question_never_the_text(store, monkeypatch):
    await _call(action="add", title="Antwortstil", text="GEHEIMER TEXT")
    prompts, _ = await _turn(monkeypatch, "Fertig.", [])

    first = prompts[0]
    assert len(prompts) == 1  # no call is forced
    assert not any("GEHEIMER TEXT" in str(m.get("content")) for m in first)
    at = next(i for i, m in enumerate(first) if "#1 Antwortstil" in str(m.get("content")))
    assert first[at]["role"] == "user"
    assert first[at + 1]["content"].endswith("Was weißt du?")
    assert all("Antwortstil" not in str(m["content"]) for m in first if m["role"] == "system")


async def test_the_text_comes_when_the_model_asks(store, monkeypatch):
    await _call(action="add", title="Antwortstil", text="GEHEIMER TEXT")
    prompts, _ = await _turn(monkeypatch, "Kurz:", [_memory_call(action="view", ids=[1])])
    assert any("GEHEIMER TEXT" in str(m.get("content")) for m in prompts[1])
    assert prompts[1][: len(prompts[0])] == prompts[0]


async def test_a_new_memory_does_not_touch_the_running_prompt(store, monkeypatch):
    prompts, _ = await _turn(monkeypatch, "Kurz:", [_memory_call(action="add", text="Neu")])
    assert len(prompts) > 1 and prompts[1][: len(prompts[0])] == prompts[0]
    assert "#1 Neu" in user_memory.turn_index("anna")
    assert "Neu" in Path(user_memory._path("anna")).read_text(encoding="utf-8")


async def test_answer_with_a_memory_needs_no_further_round(store, monkeypatch):
    prompts, _ = await _turn(monkeypatch, ANSWER, [_memory_call(action="add", text="Neu")])
    assert len(prompts) == 1
    assert "#1 Neu" in user_memory.turn_index("anna")


async def test_switched_off_means_no_tool_no_index(store, monkeypatch):
    await _call(action="add", title="Antwortstil", text="x")
    store["anna"] = False
    prompts, names = await _turn(monkeypatch, "Kurz:", [_memory_call(action="add", text="Neu")])
    assert "memory" not in names[0]
    assert not any("Antwortstil" in str(m.get("content")) for m in prompts[0])
    assert "#2" not in user_memory.turn_index("anna")  # the call was blocked


async def test_incognito_turn_neither_reads_nor_writes(store, monkeypatch):
    await _call(action="add", title="Antwortstil", text="x")
    prompts, names = await _turn(
        monkeypatch,
        "Kurz:",
        [_memory_call(action="add", text="Neu")],
        disabled_tools={"memory"},  # what the chat route passes in incognito
    )
    assert "memory" not in names[0]
    assert not any("Antwortstil" in str(m.get("content")) for m in prompts[0])
    assert "#2" not in user_memory.turn_index("anna")


def test_chat_route_disables_it_in_incognito():
    path = Path(__file__).parent.parent / "routes" / "chat_routes.py"
    source = path.read_text(encoding="utf-8")
    start = source.index("if incognito:\n            disabled_tools.update")
    assert '"memory"' in source[start : start + 300]


async def test_subagents_have_no_memory(store, monkeypatch):
    await _call(action="add", title="Antwortstil", text="x")
    prompts, names = await _turn(
        monkeypatch,
        "Kurz:",
        [_memory_call(action="add", text="Neu")],
        tool_allowlist={"web_search"},
        subagent=True,
    )
    assert "memory" not in names[0]
    assert not any("Antwortstil" in str(m.get("content")) for m in prompts[0])


# ── The settings page's API ─────────────────────────────────────────────────


@pytest.fixture
def api(store, monkeypatch):
    from routes import user_memory_routes

    who = {"user": "anna"}
    monkeypatch.setattr(user_memory_routes, "effective_user", lambda request: who["user"])
    app = FastAPI()
    app.include_router(user_memory_routes.setup_user_memory_routes())
    return TestClient(app), who


def test_user_manages_their_own(api):
    client, _ = api
    assert client.get("/api/memories").json()["entries"] == []
    assert (
        client.post("/api/memories", json={"title": "A", "text": "eins\nzwei"}).status_code == 200
    )

    body = client.get("/api/memories").json()
    assert body["limits"] == {"title": 80, "text": 600, "entries": 50}
    assert (body["entries"][0]["title"], body["entries"][0]["text"]) == ("A", "eins zwei")

    assert client.patch("/api/memories/1", json={"title": "B", "text": "drei"}).status_code == 200
    assert client.get("/api/memories").json()["entries"][0]["title"] == "B"
    assert client.delete("/api/memories/1").status_code == 200
    assert client.get("/api/memories").json()["entries"] == []


def test_api_keeps_users_apart(api):
    client, who = api
    client.post("/api/memories", json={"text": "von Anna"})

    who["user"] = "ben"
    assert client.get("/api/memories").json()["entries"] == []
    assert client.patch("/api/memories/1", json={"text": "x"}).status_code == 404
    assert client.delete("/api/memories/1").status_code == 404
    assert client.delete("/api/memories").json()["removed"] == 0

    who["user"] = "anna"
    assert client.get("/api/memories").json()["entries"][0]["text"] == "von Anna"


def test_delete_all_takes_only_the_callers(api):
    client, who = api
    client.post("/api/memories", json={"text": "von Anna"})
    who["user"] = "ben"
    client.post("/api/memories", json={"text": "von Ben"})
    assert client.delete("/api/memories").json()["removed"] == 1
    who["user"] = "anna"
    assert len(client.get("/api/memories").json()["entries"]) == 1


def test_api_errors_are_clear(api):
    client, _ = api
    assert client.post("/api/memories", json={"text": " "}).status_code == 400
    long = client.post("/api/memories", json={"text": "x" * 601})
    assert long.status_code == 400 and "at most 600" in long.json()["detail"]


def test_the_switch_is_read_from_the_users_preferences(monkeypatch):
    from routes import prefs_routes

    stored = {"anna": {user_memory.ENABLED_PREF: False}, "ben": {}}
    monkeypatch.setattr(prefs_routes, "_load_for_user", lambda owner: stored[owner])
    assert user_memory.enabled_for("anna") is False
    assert user_memory.enabled_for("ben") is True  # on until switched off


# ── The file ────────────────────────────────────────────────────────────────


def _file(owner="anna"):
    return Path(user_memory._path(owner))


def test_memories_live_in_one_readable_file_per_user(store):
    user_memory.add("anna", "Antwortstil", "Mag kurze Antworten")
    user_memory.add("anna", "Rolle", "Entwickelt Talos")
    user_memory.add("ben", "Kaffee", "Trinkt ihn schwarz")

    content = _file("anna").read_text(encoding="utf-8")
    assert _file("anna").name == "anna.md"
    assert "## #1 Antwortstil\n" in content and "\nMag kurze Antworten\n" in content
    assert "## #2 Rolle\n" in content and "\nEntwickelt Talos\n" in content
    assert "Kaffee" not in content
    assert "Kaffee" in _file("ben").read_text(encoding="utf-8")


def test_changes_update_the_file_in_place(store):
    user_memory.add("anna", "A", "alt")
    user_memory.add("anna", "B", "bleibt")
    user_memory.edit("anna", 1, "", "neu")
    content = _file().read_text(encoding="utf-8")
    assert "\nneu\n" in content and "alt" not in content and "\nbleibt\n" in content
    assert sorted(p.name for p in _file().parent.iterdir()) == ["anna.md"]  # no second file

    user_memory.remove("anna", 1)
    content = _file().read_text(encoding="utf-8")
    assert "neu" not in content and "\nbleibt\n" in content


def test_memories_survive_a_restart(store):
    user_memory.add("anna", "A", "x")
    # Nothing is held in memory: a fresh read of the file is all there is.
    assert user_memory.listing("anna")["entries"][0]["text"] == "x"
    assert user_memory.listing("anna")["entries"][0]["created_at"]


def test_a_removed_number_is_not_given_out_again(store):
    user_memory.add("anna", "A", "eins")
    user_memory.add("anna", "B", "zwei")
    user_memory.remove("anna", 2)
    assert user_memory.add("anna", "C", "drei")["output"] == "Remembered as #3."


def test_hand_edits_on_the_server_are_picked_up(store):
    user_memory.add("anna", "A", "x")
    _file().write_text(
        "# Meine Notizen\n\n## #4 Von Hand\nerste Zeile\nzweite Zeile\n\n## #7\nohne Titel\n",
        encoding="utf-8",
    )
    entries = user_memory.listing("anna")["entries"]
    assert [(e["id"], e["title"], e["text"]) for e in entries] == [
        (4, "Von Hand", "erste Zeile zweite Zeile"),
        (7, "ohne Titel", "ohne Titel"),
    ]
    assert user_memory.add("anna", "Neu", "y")["output"] == "Remembered as #8."


def test_a_text_cannot_pose_as_another_memory_in_the_file(store):
    user_memory.add("anna", "A", "## #9 Falsch")
    user_memory.add("anna", "B", "echt")
    entries = user_memory.listing("anna")["entries"]
    assert [(e["id"], e["text"]) for e in entries] == [(1, "## #9 Falsch"), (2, "echt")]


@pytest.mark.parametrize("owner", ["../../evil", "..\\..\\evil", "a/b", ".."])
def test_a_username_cannot_leave_the_directory(store, owner):
    user_memory.add(owner, "A", "x")
    assert Path(user_memory._path(owner)).parent == Path(user_memory._DIR)
    assert "x" in user_memory.listing(owner)["entries"][0]["text"]


def test_two_chats_writing_at_once_lose_nothing(store):
    import threading

    threads = [
        threading.Thread(target=user_memory.add, args=("anna", f"T{i}", f"Fakt {i}"))
        for i in range(30)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    entries = user_memory.listing("anna")["entries"]
    assert len(entries) == 30 and len({e["id"] for e in entries}) == 30


def test_an_unreadable_file_is_not_overwritten(store):
    user_memory.add("anna", "A", "x")
    _file().write_bytes(b"\xff\xfe kaputt")
    assert user_memory.turn_index("anna") == ""
    with pytest.raises(UnicodeDecodeError):
        user_memory.add("anna", "B", "y")
    assert _file().read_bytes() == b"\xff\xfe kaputt"


def test_a_tool_call_on_an_unreadable_file_fails_cleanly(store):
    user_memory.add("anna", "A", "x")
    _file().write_bytes(b"\xff\xfe kaputt")

    import asyncio

    result = asyncio.run(_call(action="add", text="y"))
    assert "could not be accessed" in result["error"]


def test_a_user_rename_moves_the_file(store):
    user_memory.add("anna", "A", "x")
    user_memory.rename_owner("anna", "anna2")
    assert user_memory.turn_index("anna") == "" and "#1 A" in user_memory.turn_index("anna2")


def test_a_rename_does_not_overwrite_an_existing_file(store):
    user_memory.add("anna", "A", "von Anna")
    user_memory.add("anna2", "B", "von Anna2")
    user_memory.rename_owner("anna", "anna2")
    assert "von Anna2" in user_memory.listing("anna2")["entries"][0]["text"]


def test_the_rename_route_moves_the_memory_file():
    path = Path(__file__).parent.parent / "routes" / "auth_routes.py"
    assert "rename_memory_owner(old_username, new_username)" in path.read_text(encoding="utf-8")


def test_removing_a_users_memories_deletes_their_file_only(store):
    user_memory.add("anna", "A", "x")
    user_memory.add("ben", "B", "y")
    assert user_memory.remove_all("anna") == 1
    assert not _file("anna").exists() and _file("ben").exists()
    assert user_memory.turn_index("anna") == "" and "#1 B" in user_memory.turn_index("ben")
    assert user_memory.remove_all("anna") == 0  # nothing there is fine


def test_deleting_a_user_removes_their_memories(store, monkeypatch, tmp_path):
    from core.auth import AuthManager

    user_memory.add("anna", "A", "x")
    manager = AuthManager.__new__(AuthManager)
    manager._config_lock = threading_lock()
    manager._sessions_lock = threading_lock()
    manager._sessions = {}
    manager._config = {"users": {"anna": {}, "root": {"is_admin": True}}}
    monkeypatch.setattr(AuthManager, "users", property(lambda self: self._config["users"]))
    monkeypatch.setattr(AuthManager, "_save", lambda self: None)

    assert manager.delete_user("anna", "root") is True
    assert not _file("anna").exists()


def threading_lock():
    import threading

    return threading.RLock()
