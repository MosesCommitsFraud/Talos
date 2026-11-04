"""Reworded searches that find nothing new must stop the turn's lookups."""

import json

from src import agent_loop
from src.knowledge_progress import STOP_SEARCHING_NOTE, KnowledgeProgress


def _search(*ids):
    return {"output": "text", "rag_sources": [{"_id": i} for i in ids]}


def _round(progress, *calls):
    for tool, result in calls:
        progress.observe(tool, result)
    return progress.end_round()


def test_three_rounds_without_anything_new_trip():
    p = KnowledgeProgress()
    assert not _round(p, ("search_knowledge", _search("a", "b")))
    assert not _round(p, ("search_knowledge", _search("a")))
    assert not _round(p, ("search_knowledge", {"output": "x", "no_hits": True}))
    assert _round(p, ("search_knowledge", _search("b")))


def test_a_new_passage_resets_the_count():
    p = KnowledgeProgress()
    _round(p, ("search_knowledge", _search("a")))
    _round(p, ("search_knowledge", _search("a")))
    _round(p, ("search_knowledge", _search("a")))
    assert p.dry_rounds == 2
    _round(p, ("search_knowledge", _search("a", "c")))
    assert p.dry_rounds == 0


def test_an_empty_first_search_counts_as_dry():
    p = KnowledgeProgress()
    _round(p, ("search_knowledge", {"output": "x", "no_hits": True}))
    assert p.dry_rounds == 1


def test_failed_lookup_is_dry():
    p = KnowledgeProgress()
    _round(p, ("read_knowledge", {"error": "not found"}))
    assert p.dry_rounds == 1


def test_outlines_and_term_lookups_count_by_their_text():
    p = KnowledgeProgress()
    _round(p, ("grep_knowledge", {"output": "3 occurrences"}))
    assert p.dry_rounds == 0
    _round(p, ("grep_knowledge", {"output": "3 occurrences"}))
    assert p.dry_rounds == 1
    _round(p, ("read_knowledge", {"output": "Outline: ...", "rag_sources": []}))
    assert p.dry_rounds == 0


def test_other_work_is_never_a_stall():
    p = KnowledgeProgress()
    for _ in range(5):
        assert not _round(p, ("web_fetch", {"output": "page"}))
    assert p.dry_rounds == 0


def test_a_round_with_other_work_resets_a_dry_streak():
    p = KnowledgeProgress()
    _round(p, ("search_knowledge", _search("a")))
    _round(p, ("search_knowledge", _search("a")))
    _round(p, ("search_knowledge", _search("a")), ("web_fetch", {"output": "page"}))
    assert p.dry_rounds == 0


async def test_the_loop_stops_reworded_searches(monkeypatch):
    calls = []

    async def fake_stream(candidates, messages, **kwargs):
        calls.append(list(messages))
        if any(m.get("content") == STOP_SEARCHING_NOTE for m in messages):
            yield f"data: {json.dumps({'delta': 'Nicht hinterlegt.'})}\n\n"
        else:
            call = {
                "id": f"c{len(calls)}",
                "name": "search_knowledge",
                "arguments": json.dumps({"query": f"Umschreibung {len(calls)}"}),
            }
            yield f"data: {json.dumps({'type': 'tool_calls', 'calls': [call]})}\n\n"
        yield "data: [DONE]\n\n"

    async def fake_tool(block, **kwargs):
        return "search_knowledge", {"output": "Nothing", "rag_sources": [], "no_hits": True}

    monkeypatch.setattr(agent_loop, "stream_llm_with_fallback", fake_stream)
    monkeypatch.setattr(agent_loop, "execute_tool_block", fake_tool)
    monkeypatch.setenv("TALOS_ASSUME_NATIVE_TOOLS", "1")

    text = ""
    async for chunk in agent_loop.stream_agent_loop(
        "http://vllm.test:8000/v1",
        "qwen3-llm",
        [{"role": "user", "content": "Wie geht das?"}],
        max_rounds=12,
        use_rag=True,
    ):
        if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
            event = json.loads(chunk[6:])
            text += event.get("delta") or ""

    assert len(calls) == 4
    assert "Nicht hinterlegt." in text
