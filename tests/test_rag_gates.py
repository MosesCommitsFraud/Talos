"""The sufficiency and grounding checks; the model's judgement itself is measured elsewhere."""

import json

import pytest

from src import rag_gates


@pytest.fixture
def model(monkeypatch):
    """The utility model, answering with whatever a test sets."""
    state = {"reply": "{}", "calls": []}

    def _call(url, model_name, messages, **kwargs):
        state["calls"].append(messages)
        if isinstance(state["reply"], Exception):
            raise state["reply"]
        return state["reply"]

    monkeypatch.setattr("src.llm_core.llm_call", _call)
    monkeypatch.setattr(
        "src.endpoint_resolver.resolve_endpoint",
        lambda *a, **k: ("http://x/v1/chat/completions", "qwen3-llm", {}),
    )
    return state


SOURCES = [{"n": 1, "filename": "a.pdf", "_text": "Der Export startet über den Button Export."}]


def test_unknown_or_missing_mode_falls_back_to_shadow():
    assert rag_gates.gate_mode({}, "grounding_gate") == "shadow"
    assert rag_gates.gate_mode({"grounding_gate": "banana"}, "grounding_gate") == "shadow"
    assert rag_gates.gate_mode({"grounding_gate": "ON"}, "grounding_gate") == "on"


def test_sufficiency_passes_only_when_everything_is_covered(model):
    model["reply"] = json.dumps({"covered": "all", "missing": "nichts"})
    assert rag_gates.check_sufficiency("F", "P")["passed"] is True
    model["reply"] = json.dumps({"covered": "part", "missing": "die Schritte"})
    verdict = rag_gates.check_sufficiency("F", "P")
    assert verdict["passed"] is False
    assert verdict["missing"] == "die Schritte"


@pytest.mark.parametrize("reply", ["kein json", '{"covered": "vielleicht"}', RuntimeError("down")])
def test_a_failed_check_never_blocks(model, reply):
    model["reply"] = reply
    verdict = rag_gates.check_sufficiency("F", "P")
    assert verdict["passed"] is True
    assert verdict["verdict"] == "error"


def test_thinking_around_the_json_is_ignored(model):
    model["reply"] = '<think>{"covered": "none"}</think>{"covered": "all"}'
    assert rag_gates.check_sufficiency("F", "P")["verdict"] == "all"


def test_numbers_only_count_when_the_sources_lack_them():
    source = "Entitäten ab 501 und Version 2.5 am 17.09.2026."
    assert rag_gates.unsupported_numbers("Ab 501, Version 2.5.", source) == []
    assert rag_gates.unsupported_numbers("Ab 502.", source) == ["502"]


def test_citations_ordinals_and_question_numbers_are_not_claims():
    assert rag_gates.unsupported_numbers("1. Öffnen [12]\n2. Prüfen [13]", "text") == []
    assert rag_gates.unsupported_numbers("Für 2026 gilt das.", "text", "Was gilt für 2026?") == []


def test_grounding_lists_what_the_model_found(model):
    model["reply"] = json.dumps({"unsupported": ["Button Start"]})
    verdict = rag_gates.check_grounding("F", "Klick auf Button Start.", "Button Export")
    assert verdict["passed"] is False
    assert verdict["unsupported"] == ["Button Start"]


def test_a_quote_the_answer_does_not_contain_is_dropped(model):
    model["reply"] = json.dumps({"unsupported": ["steht gar nicht drin"]})
    assert rag_gates.check_grounding("F", "Klick auf Export.", "Export")["passed"] is True


def test_grounding_adds_invented_numbers_the_model_missed(model):
    model["reply"] = json.dumps({"unsupported": []})
    verdict = rag_gates.check_grounding("F", "Das Limit ist 1048576 Zeilen.", "Kein Limit genannt.")
    assert verdict["passed"] is False
    assert verdict["unsupported"] == ["1048576"]


def test_grounding_ignores_thinking_in_the_answer(model):
    model["reply"] = json.dumps({"unsupported": []})
    assert rag_gates.check_grounding("F", "<think>99999</think>Export.", "Export")["passed"] is True


def test_grounding_still_reports_numbers_when_the_model_fails(model):
    model["reply"] = RuntimeError("down")
    verdict = rag_gates.check_grounding("F", "Limit 1048576.", "Kein Limit.")
    assert verdict["verdict"] == "error"
    assert verdict["unsupported"] == ["1048576"]


def test_shadow_changes_nothing_and_records_the_verdict(model):
    model["reply"] = json.dumps({"covered": "none", "missing": "alles"})
    before = len(rag_gates.recent_verdicts())
    assert rag_gates.sufficiency_note({}, "F", SOURCES) == ""
    rag_gates.settle(5)
    latest = rag_gates.recent_verdicts()
    assert len(latest) == before + 1
    assert latest[-1]["mode"] == "shadow"
    assert latest[-1]["verdict"] == "none"


def test_off_asks_nobody(model):
    cfg = {"sufficiency_gate": "off", "grounding_gate": "off"}
    assert rag_gates.sufficiency_note(cfg, "F", SOURCES) == ""
    assert rag_gates.grounding_note(cfg, "F", "A", SOURCES) == ""
    assert model["calls"] == []


def test_on_tells_the_model_what_is_missing(model):
    model["reply"] = json.dumps({"covered": "part", "missing": "die Schritte"})
    note = rag_gates.sufficiency_note({"sufficiency_gate": "on"}, "F", SOURCES)
    assert "die Schritte" in note
    model["reply"] = json.dumps({"covered": "all"})
    assert rag_gates.sufficiency_note({"sufficiency_gate": "on"}, "F", SOURCES) == ""


def test_on_warns_the_reader_in_the_answers_language(model):
    model["reply"] = json.dumps({"unsupported": ["Button Start"]})
    cfg = {"grounding_gate": "on"}
    german = rag_gates.grounding_note(cfg, "F", "Das ist der Button Start.", SOURCES)
    assert "Nicht durch die Quellen belegt" in german
    assert "Button Start" in german
    english = rag_gates.grounding_note(cfg, "F", "Press Button Start now.", SOURCES)
    assert "Not supported by the sources" in english


def test_no_sources_means_nothing_to_check(model):
    cfg = {"sufficiency_gate": "on", "grounding_gate": "on"}
    assert rag_gates.sufficiency_note(cfg, "F", []) == ""
    assert rag_gates.grounding_note(cfg, "F", "A", []) == ""
    assert model["calls"] == []


def test_passages_are_numbered_and_not_repeated():
    text = rag_gates.passages_from_sources(
        [
            {"n": 1, "filename": "a.pdf", "_text": "Eins"},
            {"n": 2, "filename": "a.pdf", "_text": "Eins"},
            {"n": 3, "filename": "b.pdf", "snippet": "Zwei"},
        ]
    )
    assert "[1] a.pdf\nEins" in text
    assert "[2]" not in text
    assert "[3] b.pdf\nZwei" in text
