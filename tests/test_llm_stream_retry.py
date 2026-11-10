"""A model call that failed before its first output, or came back with nothing,
is sent again; one that already wrote something never is."""

import json

import pytest

from src import llm_core

CAND = [("http://vllm.test:8000/v1", "qwen3-llm", {})]
TWO = CAND + [("http://other.test/v1", "backup", {})]


def _data(payload):
    return f"data: {json.dumps(payload)}\n\n"


def _error(status, text="boom", **extra):
    return f"event: error\ndata: {json.dumps({'status': status, 'text': text, **extra})}\n\n"


DONE = "data: [DONE]\n\n"
USAGE = _data({"type": "usage", "data": {"input_tokens": 100, "output_tokens": 0}})


@pytest.fixture
def scripted(monkeypatch):
    """Replace stream_llm with scripted attempts; returns the list of calls."""
    calls = []
    slept = []

    def install(*attempts, retries=5):
        async def fake_stream(url, model, messages, headers=None, **kwargs):
            calls.append(model)
            for chunk in attempts[min(len(calls), len(attempts)) - 1]:
                yield chunk

        async def fake_sleep(seconds):
            slept.append(seconds)

        monkeypatch.setattr(llm_core, "stream_llm", fake_stream)
        monkeypatch.setattr(llm_core.asyncio, "sleep", fake_sleep)
        monkeypatch.setattr(llm_core, "_stream_retry_limit", lambda: retries)
        return calls, slept

    return install


async def _collect(candidates=CAND):
    return [c async for c in llm_core.stream_llm_with_fallback(candidates, [{"role": "user"}])]


def _types(chunks):
    out = []
    for c in chunks:
        if c.startswith("event: error"):
            out.append("error")
        elif c == DONE:
            out.append("done")
        else:
            d = json.loads(c[6:])
            out.append(d.get("type") or ("delta" if "delta" in d else "?"))
    return out


async def test_a_busy_server_gets_the_same_request_again(scripted):
    calls, slept = scripted([_error(503)], [_error(502)], [_data({"delta": "Hallo"}), USAGE, DONE])
    chunks = await _collect()

    assert calls == ["qwen3-llm"] * 3
    assert _types(chunks) == ["retry", "retry", "delta", "usage", "done"]
    # The pause grows: about half a second, then about one.
    assert 0.4 < slept[0] < 0.6 and 0.8 < slept[1] < 1.2


async def test_an_empty_response_is_retried_and_its_usage_is_not_counted(scripted):
    calls, _ = scripted([USAGE, DONE], [_data({"delta": "Hallo"}), USAGE, DONE])
    chunks = await _collect()

    assert len(calls) == 2
    # Only the usage of the attempt that produced the answer is passed on.
    assert _types(chunks) == ["retry", "delta", "usage", "done"]
    assert json.loads(chunks[0][6:])["reason"] == "empty response"


async def test_thinking_alone_is_a_response(scripted):
    calls, _ = scripted([_data({"delta": "hm", "thinking": True}), DONE])
    chunks = await _collect()

    assert len(calls) == 1
    assert _types(chunks) == ["delta", "done"]


async def test_a_tool_call_alone_is_a_response(scripted):
    call = {"type": "tool_calls", "calls": [{"id": "c1", "name": "ls", "arguments": "{}"}]}
    calls, _ = scripted([_data(call), DONE])
    assert len(await _collect()) == 2 and len(calls) == 1


async def test_nothing_is_repeated_once_the_model_has_written(scripted):
    calls, _ = scripted([_data({"delta": "Hal"}), _error(502), DONE])
    chunks = await _collect()

    assert len(calls) == 1
    assert _types(chunks) == ["delta", "error", "done"]


async def test_an_error_about_the_request_itself_is_not_retried(scripted):
    calls, slept = scripted([_error(400, "context too long")])
    chunks = await _collect()

    assert len(calls) == 1 and not slept
    assert _types(chunks) == ["error"]


async def test_an_empty_stop_at_the_length_limit_is_not_retried(scripted):
    finish = _data({"type": "finish", "reason": "length"})
    calls, _ = scripted([USAGE, finish, DONE])
    chunks = await _collect()

    assert len(calls) == 1
    assert _types(chunks) == ["usage", "finish", "done"]


async def test_after_the_last_retry_the_error_or_the_empty_round_is_passed_on(scripted):
    calls, _ = scripted([_error(503)], retries=2)
    chunks = await _collect()
    assert len(calls) == 3
    assert _types(chunks) == ["retry", "retry", "error"]


async def test_a_response_that_stays_empty_ends_normally(scripted):
    calls, _ = scripted([USAGE, DONE], retries=1)
    chunks = await _collect()
    assert len(calls) == 2
    assert _types(chunks) == ["retry", "usage", "done"]


async def test_a_read_timeout_is_tried_once_more_only(scripted):
    timeout = f"event: error\ndata: {json.dumps({'error': 'Read timeout', 'status': 504})}\n\n"
    calls, _ = scripted([timeout])
    chunks = await _collect()
    assert len(calls) == 2
    assert _types(chunks) == ["retry", "error"]


async def test_retries_come_before_the_fallback_model(scripted):
    calls, _ = scripted([_error(503)], [_error(503)], [_data({"delta": "Hallo"}), DONE], retries=1)
    chunks = await _collect(TWO)

    assert calls == ["qwen3-llm", "qwen3-llm", "backup"]
    assert _types(chunks) == ["retry", "fallback", "delta", "done"]


async def test_zero_retries_keeps_the_old_behaviour(scripted):
    calls, slept = scripted([_error(503)], [_data({"delta": "Hallo"}), DONE], retries=0)
    chunks = await _collect(TWO)

    assert calls == ["qwen3-llm", "backup"] and not slept
    assert _types(chunks) == ["fallback", "delta", "done"]
