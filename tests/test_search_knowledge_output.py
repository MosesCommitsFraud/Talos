"""search_knowledge must tell the model its `[filename]` labels are not paths.

Without it the model reads the label as a file path, calls read_file on an
indexed document, gets 'not found', and answers from the web instead of the
knowledge base it just searched.
"""

import asyncio
import importlib

ti = importlib.import_module("src.tool_implementations")


def _run(query, sources, block, monkeypatch):
    """Call do_search_knowledge with ChatProcessor.retrieve stubbed out."""

    class _ChatProcessor:
        def __init__(self, _docs_manager):
            pass

        def retrieve(self, _query, **_kwargs):
            return sources, block

    monkeypatch.setattr(
        importlib.import_module("src.chat_processor"), "ChatProcessor", _ChatProcessor
    )
    return asyncio.run(ti.do_search_knowledge(f'{{"query": "{query}"}}'))


def test_output_says_labels_are_not_paths(monkeypatch):
    sources = [{"filename": "Setup_Guide.docx", "snippet": "vllm", "similarity": 0.7}]
    out = _run("dgx setup", sources, "[Setup_Guide.docx]\nvllm serve ...", monkeypatch)

    assert "NOT a file path" in out["output"]
    assert "read_file" in out["output"]
    # It must also say what to do instead, or the model just dead-ends.
    assert "search_knowledge again" in out["output"]
    assert out["rag_sources"] == sources


def test_guidance_sits_outside_the_untrusted_markers(monkeypatch):
    """Retrieved text is a prompt-injection surface. Our instruction must not sit
    inside SUPPLIED_CONTEXT, where a malicious document could imitate it."""
    out = _run("dgx setup", [{"filename": "d.docx"}], "[d.docx]\nbody", monkeypatch)
    text = out["output"]

    assert text.index("NOT a file path") < text.index("<<<SUPPLIED_CONTEXT>>>")


def test_empty_result_stays_a_plain_answer(monkeypatch):
    """No hits means no context block — and no path guidance to attach it to."""
    out = _run("nothing", [], "", monkeypatch)

    assert "returned no passage" in out["output"]
    assert "SUPPLIED_CONTEXT" not in out["output"]
    assert out["rag_sources"] == []
    assert out["no_hits"] is True


def test_empty_result_does_not_invite_general_knowledge(monkeypatch):
    """The old "use another source" wording made the model invent answers."""
    out = _run("Pivot Definition Bedeutung", [], "", monkeypatch)["output"]

    assert "another source" not in out
    assert "literal" in out
    assert "general knowledge" in out


def test_a_broken_search_may_not_be_reported_as_nothing_stored():
    out = ti._empty_search_output(
        "Pivot", {"cause": "engine_error", "detail": "Qdrant down"}, ["pivot"], []
    )
    assert "Qdrant down" in out
    assert "Do NOT tell the user that nothing is stored" in out
    assert "tell the user that nothing on this is stored" not in out


def test_passages_below_the_bar_are_told_apart_from_an_empty_index():
    below = ti._empty_search_output(
        "Pivot", {"cause": "below_threshold", "candidates": 12}, ["pivot"], []
    )
    assert "12 passage(s)" in below
    assert "none is relevant enough" in below
    empty = ti._empty_search_output("Pivot", {"cause": "no_candidates"}, ["pivot"], [])
    assert "returned no passage" in empty


def test_no_knowledge_base_is_not_a_miss():
    out = ti._empty_search_output("Pivot", {"cause": "no_bases"}, [], [])
    assert "No knowledge base is available" in out
    assert "try" not in out.lower()


def test_literal_mentions_come_marked_as_untrusted_and_point_at_read_knowledge():
    out = ti._empty_search_output(
        "Pivot", {"cause": "no_candidates"}, ["pivot"], ['- "pivot" in a.pdf: Eine Pivot ...']
    )
    assert "read_knowledge" in out
    assert out.index("read_knowledge") < out.index("<<<SUPPLIED_CONTEXT>>>")
    assert "in a.pdf" in out.split("<<<SUPPLIED_CONTEXT>>>")[1]


def test_empty_search_uses_the_literal_lookup(monkeypatch):
    nav = importlib.import_module("src.rag_navigate")
    monkeypatch.setattr(
        nav,
        "literal_mentions",
        lambda query, document, owner: (["pivot"], ['- "pivot" in a.pdf: Text']),
    )
    out = _run("Pivot", [], "", monkeypatch)
    assert "in a.pdf" in out["output"]
    assert out["no_hits"] is True


def test_a_part_of_the_knowledge_base_that_failed_is_mentioned(monkeypatch):
    class _ChatProcessor:
        def __init__(self, _docs_manager):
            self.last_miss = {"cause": "partial", "detail": "Handbuch is not available"}

        def retrieve(self, _query, **_kwargs):
            return [{"filename": "d.docx"}], "[d.docx]\nbody"

    monkeypatch.setattr(
        importlib.import_module("src.chat_processor"), "ChatProcessor", _ChatProcessor
    )
    out = asyncio.run(ti.do_search_knowledge('{"query": "x"}'))["output"]
    assert "Handbuch is not available" in out
    assert out.index("Handbuch") < out.index("<<<SUPPLIED_CONTEXT>>>")
