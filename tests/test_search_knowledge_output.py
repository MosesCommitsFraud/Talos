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

        def retrieve(self, _query):
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

    assert "No indexed document matched" in out["output"]
    assert "SUPPLIED_CONTEXT" not in out["output"]
    assert out["rag_sources"] == []
