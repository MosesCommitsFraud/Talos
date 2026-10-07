"""`delegate`: parallel subagents inside one turn.

The nested agent turn is stubbed with a fake ``stream_agent_loop`` that emits
the SSE frames a real one would, so these tests pin the contract the tray and
the delegating turn rely on: one ``subagent`` job per task, a live step list,
read-only tools only, no recursion, reports returned in task order, and every
job settled even when the turn is stopped.
"""

import asyncio
import importlib
import json

import pytest

sub = importlib.import_module("src.subagents")
bg_jobs = importlib.import_module("src.bg_jobs")
agent_loop = importlib.import_module("src.agent_loop")


def _frame(data):
    return "data: " + json.dumps(data) + "\n\n"


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(bg_jobs, "_JOBS_DIR", tmp_path / "bg_jobs")
    monkeypatch.setattr(bg_jobs, "_STORE", tmp_path / "bg_jobs.json")
    monkeypatch.setattr(sub, "_setting", lambda key, default: default)
    sub.set_turn_context(
        {"endpoint_url": "http://llm", "model": "m", "session_id": "s1", "use_rag": True}
    )
    return tmp_path


def _fake_loop(calls, delay=0.0, fail=None):
    async def fake(endpoint_url, model, messages, **kw):
        calls.append({"messages": messages, **kw})
        prompt = messages[-1]["content"]
        yield _frame(
            {"type": "tool_start", "tool": "search_knowledge", "command": '{"query": "x"}'}
        )
        if delay:
            await asyncio.sleep(delay)
        yield _frame({"type": "tool_output", "tool": "search_knowledge", "exit_code": 0})
        yield _frame({"type": "rag_sources_partial", "data": [{"filename": "a.pdf", "n": 1}]})
        yield _frame({"delta": "thinking aloud", "thinking": True})
        if fail and fail in prompt:
            raise RuntimeError("boom")
        yield _frame({"delta": f"Report for: {prompt.rsplit(chr(10), 1)[-1]} [1]"})
        yield "data: [DONE]\n\n"

    return fake


def _run(content, monkeypatch, **fake_kw):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _fake_loop(calls, **fake_kw))
    out = asyncio.run(sub.run_tasks(json.dumps(content), session_id="s1"))
    return out, calls


def test_parse_tasks_accepts_common_shapes():
    assert sub.parse_tasks('{"tasks": ["read chapter 2"]}')[0]["title"] == "read chapter 2"
    got = sub.parse_tasks('[{"name": "A", "task": "do a"}]')
    assert got == [
        {"title": "A", "prompt": "do a", "type": "research", "model": "small", "context": ""}
    ]
    with pytest.raises(ValueError, match="Unknown subagent model"):
        sub.parse_tasks('{"tasks": [{"prompt": "x", "model": "huge"}]}')
    with pytest.raises(ValueError, match="Unknown subagent type"):
        sub.parse_tasks('{"tasks": [{"prompt": "x", "type": "admin"}]}')
    with pytest.raises(ValueError):
        sub.parse_tasks('{"tasks": []}')
    with pytest.raises(ValueError):
        sub.parse_tasks(json.dumps({"tasks": ["x"] * (sub.MAX_TASKS + 1)}))


def test_runs_each_task_as_a_readonly_subagent_job(jobs_dir, monkeypatch):
    out, calls = _run(
        {
            "tasks": [
                {"title": "Kapitel 1", "prompt": "lies K1"},
                {"title": "Kapitel 2", "prompt": "lies K2"},
            ]
        },
        monkeypatch,
    )
    assert out["exit_code"] == 0
    # Reports come back in task order, thinking text excluded, citations kept.
    text = out["output"]
    assert text.index("Task 1 — Kapitel 1") < text.index("Task 2 — Kapitel 2")
    assert "Report for: lies K1 [1]" in text and "thinking aloud" not in text
    assert out["rag_sources"] and out["rag_sources"][0]["filename"] == "a.pdf"
    # Each nested turn: fresh context, read-only allowlist, marked as subagent.
    for call in calls:
        assert len(call["messages"]) == 1
        assert call["subagent"] is True
        assert call["tool_allowlist"] == sub.SUBAGENT_TOOLS
        assert "delegate" not in call["tool_allowlist"]
        assert "bash" not in call["tool_allowlist"]
        assert call["reasoning"] is False
        assert call["session_id"] == "s1"
    # One finished subagent job per task, with its step list for the tray.
    recs = [r for r in bg_jobs.list_for_session("s1") if r["kind"] == "subagent"]
    assert sorted(r["command"] for r in recs) == ["Kapitel 1", "Kapitel 2"]
    assert all(r["status"] == "done" and r["followed_up"] for r in recs)
    assert len({r["group"] for r in recs}) == 1
    steps = bg_jobs.read_steps(recs[0])
    assert steps[0]["tool"] == "search_knowledge" and steps[0]["status"] == "done"


def test_a_failing_subagent_does_not_sink_the_others(jobs_dir, monkeypatch):
    out, _ = _run(
        {"tasks": [{"title": "ok", "prompt": "fine"}, {"title": "bad", "prompt": "boom"}]},
        monkeypatch,
        fail="boom",
    )
    assert "(done)" in out["output"] and "(FAILED)" in out["output"]
    assert "1/2 subagent task(s) finished" in out["output"]
    statuses = {r["command"]: r["status"] for r in bg_jobs.list_for_session("s1")}
    assert statuses == {"ok": "done", "bad": "failed"}


def test_subagents_cannot_delegate(jobs_dir, monkeypatch):
    sub.set_turn_context({"endpoint_url": "http://llm", "model": "m", "subagent": True})
    out = asyncio.run(sub.run_tasks('{"tasks": ["x"]}', session_id="s1"))
    assert out["exit_code"] == 1 and "cannot delegate" in out["error"]


def test_stopping_the_turn_settles_every_job(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _fake_loop(calls, delay=5))

    async def main():
        task = asyncio.create_task(sub.run_tasks('{"tasks": ["a", "b"]}', session_id="s1"))
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    recs = bg_jobs.list_for_session("s1")
    assert len(recs) == 2 and all(r["status"] == "failed" for r in recs)


def test_live_step_list_is_written_while_running(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _fake_loop(calls, delay=0.5))

    async def main():
        task = asyncio.create_task(sub.run_tasks('{"tasks": ["a"]}', session_id="s1"))
        await asyncio.sleep(0.2)
        rec = bg_jobs.list_for_session("s1")[0]
        mid = (rec["status"], bg_jobs.read_steps(rec))
        await task
        return mid

    status, steps = asyncio.run(main())
    assert status == "running"
    assert steps and steps[0]["status"] == "running"


def test_bg_task_route_exposes_subagent_fields(jobs_dir, monkeypatch):
    routes = importlib.import_module("routes.bg_task_routes")
    _run({"tasks": [{"title": "T", "prompt": "P"}]}, monkeypatch)
    rec = bg_jobs.list_for_session("s1")[0]
    public = routes._public(rec)
    assert public["kind"] == "subagent" and public["prompt"] == "P"
    assert public["steps"][0]["tool"] == "search_knowledge"
    assert "log_path" not in public


def _slow_for(word):
    """Fake turn that stalls (until stopped) when its prompt contains `word`."""

    async def fake(endpoint_url, model, messages, **kw):
        prompt = messages[-1]["content"]
        yield _frame({"type": "tool_start", "tool": "read_knowledge", "command": "{}"})
        yield _frame({"delta": "Zwischenstand. "})
        if word in prompt:
            await asyncio.sleep(30)
        yield _frame({"type": "tool_output", "tool": "read_knowledge", "exit_code": 0})
        yield _frame({"delta": "fertig"})

    return fake


def _stop_when_running(title):
    async def wait_and_stop():
        for _ in range(100):
            await asyncio.sleep(0.02)
            for rec in bg_jobs.list_for_session("s1"):
                if rec["command"] == title and rec["status"] == "running":
                    if sub.stop(rec["id"]):
                        return rec["id"]
        raise AssertionError(f"{title} never became stoppable")

    return wait_and_stop


def test_stopping_one_subagent_keeps_the_others(jobs_dir, monkeypatch):
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _slow_for("langsam"))

    async def main():
        call = asyncio.create_task(
            sub.run_tasks(
                json.dumps(
                    {
                        "tasks": [
                            {"title": "A", "prompt": "langsam"},
                            {"title": "B", "prompt": "schnell"},
                        ]
                    }
                ),
                session_id="s1",
            )
        )
        stopped_id = await _stop_when_running("A")()
        return await asyncio.wait_for(call, 5), stopped_id

    out, stopped_id = asyncio.run(main())
    text = out["output"]
    assert "Task 1 — A (STOPPED BY THE USER)" in text and "Zwischenstand." in text
    assert "Task 2 — B (done)" in text and "fertig" in text
    recs = {r["command"]: r for r in bg_jobs.list_for_session("s1")}
    assert recs["A"]["stopped"] is True and recs["A"]["status"] == "failed"
    assert recs["B"]["status"] == "done" and not recs["B"].get("stopped")
    # Finished subagents can no longer be stopped.
    assert sub.stop(stopped_id) is False


def test_a_queued_subagent_stopped_before_it_starts_never_runs(jobs_dir, monkeypatch):
    calls = []
    slow = _slow_for("langsam")

    async def counting(endpoint_url, model, messages, **kw):
        calls.append(messages[-1]["content"])
        async for chunk in slow(endpoint_url, model, messages, **kw):
            yield chunk

    monkeypatch.setattr(agent_loop, "stream_agent_loop", counting)
    monkeypatch.setattr(sub, "_setting", lambda k, d: 1 if k == "subagent_parallelism" else d)

    async def main():
        call = asyncio.create_task(
            sub.run_tasks(
                json.dumps(
                    {"tasks": [{"title": "A", "prompt": "erst"}, {"title": "B", "prompt": "zweit"}]}
                ),
                session_id="s1",
            )
        )
        await asyncio.sleep(0)
        b = next(r for r in bg_jobs.list_for_session("s1") if r["command"] == "B")
        assert sub.stop(b["id"])
        return await asyncio.wait_for(call, 5)

    out = asyncio.run(main())
    assert "Task 2 — B (STOPPED BY THE USER)" in out["output"]
    assert all("zweit" not in c for c in calls)


def test_stop_route_only_stops_running_subagents_of_the_chat(jobs_dir, monkeypatch):
    routes = importlib.import_module("routes.bg_task_routes")
    monkeypatch.setattr(routes, "_verify_session_owner", lambda request, sid: None)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(routes.setup_bg_task_routes())
    client = TestClient(app)
    rec = bg_jobs.launch_agent("p", "s1", label="T", kind="subagent")
    shell_like = bg_jobs.launch_agent("p", "s1", label="X", kind="agent")
    stopped = []
    monkeypatch.setattr(sub, "stop", lambda job_id: stopped.append(job_id) or True)

    assert client.post(f"/api/bg-tasks/{rec['id']}/stop?session_id=other").status_code == 404
    assert client.post(f"/api/bg-tasks/{shell_like['id']}/stop?session_id=s1").status_code == 400
    assert client.post(f"/api/bg-tasks/{rec['id']}/stop?session_id=s1").json() == {"stopped": True}
    assert stopped == [rec["id"]]


# ── types, context, own model, background, continue ─────────────────────────


def _recording_loop(calls, reply="Bericht"):
    """Fake turn that records its arguments and fills the wire sink like the
    real loop: the messages as sent plus a tool round."""

    async def fake(endpoint_url, model, messages, **kw):
        calls.append({"endpoint_url": endpoint_url, "model": model, "messages": messages, **kw})
        sink = kw.get("wire_sink")
        if sink is not None:
            sink["messages"] = list(messages) + [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "read_knowledge", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c1", "content": "Kapiteltext"},
            ]
        yield _frame({"delta": reply})

    return fake


def test_worker_type_gets_files_and_code_and_a_folder(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    content = {"tasks": [{"title": "Analyse", "prompt": "werte q3.csv aus", "type": "worker"}]}
    asyncio.run(sub.run_tasks(json.dumps(content), session_id="s1"))
    (call,) = calls
    assert call["tool_allowlist"] == sub.WORKER_TOOLS
    assert {"python", "write_file"} <= call["tool_allowlist"]
    assert "run_cell" not in call["tool_allowlist"]
    assert "delegate" not in call["tool_allowlist"]
    rec = bg_jobs.list_for_session("s1")[0]
    assert f"subagents/{rec['id']}/" in call["messages"][0]["content"]
    assert rec["agent_type"] == "worker"


def test_context_is_passed_and_the_head_is_shared(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    content = {
        "tasks": [
            {"title": "A", "prompt": "lies A", "context": "Kapitel 7, S. 40-44"},
            {"title": "B", "prompt": "lies B"},
        ]
    }
    asyncio.run(sub.run_tasks(json.dumps(content), session_id="s1"))
    first = [c["messages"][0]["content"] for c in calls]
    a = next(m for m in first if "lies A" in m)
    b = next(m for m in first if "lies B" in m)
    assert "Kapitel 7, S. 40-44" in a and "Kapitel 7" not in b
    # Everything up to the assignment is identical: the prefix cache reuses it
    # across the whole batch.
    head = a.split("Assignment:")[0]
    assert head and b.startswith(head)


def test_configured_subagent_model_is_used(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    settings = {"subagent_endpoint_id": "ep-small", "subagent_model": "qwen3-4b"}
    monkeypatch.setattr(sub, "_setting", lambda k, d: settings.get(k, d))
    resolver = importlib.import_module("src.endpoint_resolver")
    monkeypatch.setattr(
        resolver,
        "resolve_endpoint_by_id",
        lambda ep, model, owner=None: ("http://small/v1/chat/completions", model, {"x": "1"}),
    )
    monkeypatch.setattr(
        importlib.import_module("src.model_context"), "get_context_length", lambda u, m: 32768
    )
    asyncio.run(sub.run_tasks('{"tasks": ["x"]}', session_id="s1"))
    (call,) = calls
    assert call["endpoint_url"] == "http://small/v1/chat/completions"
    assert call["model"] == "qwen3-4b" and call["context_length"] == 32768
    assert call["fallbacks"] is None


def test_unresolvable_subagent_model_falls_back_to_the_chat_model(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    monkeypatch.setattr(sub, "_setting", lambda k, d: "gone" if k == "subagent_endpoint_id" else d)
    resolver = importlib.import_module("src.endpoint_resolver")
    monkeypatch.setattr(resolver, "resolve_endpoint_by_id", lambda *a, **k: None)
    asyncio.run(sub.run_tasks('{"tasks": ["x"]}', session_id="s1"))
    assert calls[0]["endpoint_url"] == "http://llm" and calls[0]["model"] == "m"


def test_background_returns_at_once_and_delivers_one_followup(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls, "Ergebnis"))
    routes = importlib.import_module("routes.bg_task_routes")

    async def main():
        out = await sub.run_tasks('{"tasks": ["a", "b"], "background": true}', session_id="s1")
        assert "background" in out["output"] and out["exit_code"] == 0
        holder = next(r for r in bg_jobs.list_for_session("s1") if r["kind"] == "delegate")
        assert holder["status"] == "running" and not holder["followed_up"]
        await asyncio.gather(*list(sub._background))
        return holder["id"]

    holder_id = asyncio.run(main())
    recs = bg_jobs.list_for_session("s1")
    holder = next(r for r in recs if r["id"] == holder_id)
    assert holder["status"] == "done"
    # Exactly one follow-up: the holder. The subagents are born followed_up.
    assert [r["id"] for r in bg_jobs.pending_followups()] == [holder_id]
    text = bg_jobs.result_text(bg_jobs.get(holder_id))
    assert text.count("Ergebnis") == 2 and "task_id:" in text
    # Background reports cite by name: [n] numbers would be stale by then.
    assert all("Do not use [n] numbers" in c["messages"][0]["content"] for c in calls)
    listed = [routes._public(r)["kind"] for r in recs if r.get("kind") != "delegate"]
    assert listed == ["subagent", "subagent"]


def test_continue_task_resumes_with_the_full_history(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls, "Antwort"))
    content = {"tasks": [{"title": "K7", "prompt": "lies K7", "type": "worker"}]}
    out = asyncio.run(sub.run_tasks(json.dumps(content), session_id="s1"))
    task_id = out["output"].split("task_id: ")[1].split()[0]

    follow = asyncio.run(
        sub.continue_task(
            json.dumps({"task_id": task_id, "prompt": "und Kapitel 8?"}), session_id="s1"
        )
    )
    assert follow["exit_code"] == 0
    resumed = calls[-1]
    contents = [m.get("content") for m in resumed["messages"]]
    # The original assignment, the tool round and its result, the first answer,
    # then the follow-up: nothing has to be read again.
    assert "lies K7" in contents[0]
    assert "Kapiteltext" in contents
    assert contents[-2] == "Antwort" and contents[-1] == "und Kapitel 8?"
    assert resumed["tool_allowlist"] == sub.WORKER_TOOLS
    new = next(r for r in bg_jobs.list_for_session("s1") if r.get("continues") == task_id)
    assert new["kind"] == "subagent" and new["status"] == "done"


def test_continue_task_refuses_unknown_or_running_tasks(jobs_dir, monkeypatch):
    out = asyncio.run(sub.continue_task('{"task_id": "nope", "prompt": "x"}', session_id="s1"))
    assert out["exit_code"] == 1 and "No subagent" in out["error"]
    rec = bg_jobs.launch_agent("p", "s1", label="T", kind="subagent")
    out = asyncio.run(
        sub.continue_task(json.dumps({"task_id": rec["id"], "prompt": "x"}), session_id="s1")
    )
    assert "still running" in out["error"]


def test_the_main_agent_picks_small_or_large_per_task(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    settings = {"subagent_endpoint_id": "ep-small", "subagent_model": "qwen3-4b"}
    monkeypatch.setattr(sub, "_setting", lambda k, d: settings.get(k, d))
    resolver = importlib.import_module("src.endpoint_resolver")
    monkeypatch.setattr(
        resolver,
        "resolve_endpoint_by_id",
        lambda ep, model, owner=None: ("http://small/v1/chat/completions", model, {}),
    )
    monkeypatch.setattr(
        importlib.import_module("src.model_context"), "get_context_length", lambda u, m: 32768
    )
    content = {
        "tasks": [
            {"title": "Fakten", "prompt": "lies K7"},
            {"title": "Abwägen", "prompt": "vergleiche die Quellen", "model": "large"},
        ]
    }
    out = asyncio.run(sub.run_tasks(json.dumps(content), session_id="s1"))
    by_prompt = {c["messages"][0]["content"].split("Assignment:")[1].strip(): c for c in calls}
    assert by_prompt["lies K7"]["model"] == "qwen3-4b"
    assert by_prompt["vergleiche die Quellen"]["model"] == "m"
    assert by_prompt["vergleiche die Quellen"]["endpoint_url"] == "http://llm"
    recs = {r["command"]: r for r in bg_jobs.list_for_session("s1")}
    assert recs["Fakten"]["model_size"] == "small" and recs["Abwägen"]["model_size"] == "large"

    # A follow-up stays on the model the subagent ran on, unless asked otherwise.
    large_id = recs["Abwägen"]["id"]
    asyncio.run(sub.continue_task(json.dumps({"task_id": large_id, "prompt": "und?"}), "s1"))
    assert calls[-1]["model"] == "m"
    small_id = recs["Fakten"]["id"]
    asyncio.run(
        sub.continue_task(
            json.dumps({"task_id": small_id, "prompt": "genauer", "model": "large"}), "s1"
        )
    )
    assert calls[-1]["model"] == "m"
    assert "task_id:" in out["output"]


def test_small_without_a_configured_model_runs_on_the_chat_model(jobs_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(agent_loop, "stream_agent_loop", _recording_loop(calls))
    asyncio.run(sub.run_tasks('{"tasks": [{"prompt": "x", "model": "small"}]}', session_id="s1"))
    assert calls[0]["model"] == "m"
    # Recorded honestly: it did not run on a small model.
    assert bg_jobs.list_for_session("s1")[0]["model_size"] == "large"
