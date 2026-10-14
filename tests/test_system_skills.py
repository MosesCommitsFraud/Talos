"""Built-in system skills (src/system_skills.py): always available, hidden from
the user's skill library, and combinable within one turn."""

import asyncio
import json
from pathlib import Path

import pytest

from src import system_skills

ROOT = Path(__file__).parents[1] / "system_skills"
EXPECTED = {"interactive-answers", "ui-apps", "ui-data", "ui-diagrams", "ui-maps", "ui-visualization"}


def test_all_system_skills_load_with_their_tool_gate():
    loaded = system_skills._load()
    assert set(loaded) == EXPECTED
    assert loaded["ui-maps"]["requires"] == ["render_ui"]
    assert set(loaded["interactive-answers"]["requires"]) == {"render_ui", "render_widget"}


def test_availability_follows_the_feature_not_a_switch():
    assert {s["name"] for s in system_skills.available()} == EXPECTED
    without_ui = {s["name"] for s in system_skills.available({"render_ui"})}
    assert "ui-maps" not in without_ui and "ui-diagrams" in without_ui
    assert system_skills.available({"render_ui", "render_widget"}) == []


def _examples():
    for md in sorted(ROOT.glob("*/SKILL.md")):
        text = md.read_text(encoding="utf-8")
        for i, block in enumerate(text.split("```json\n")[1:]):
            yield md.parent.name, i, json.loads(block.split("\n```", 1)[0])


@pytest.mark.parametrize("skill, index, call", list(_examples()))
def test_every_skill_example_is_a_valid_call(skill, index, call):
    """The examples are what the model copies: each must pass the tool's own
    validation (render_widget when it has a `type`, else render_ui)."""
    if "type" in call:
        from src.declarative_widgets import build

        widget = build(call)
        assert widget["type"] in ("ui", "table")
    else:
        from src.interactive_ui import normalize

        assert normalize(call)["sources"]


def test_read_skill_loads_system_skills_without_any_switch():
    from src.tool_implementations import do_read_skill

    async def load_all():
        return await asyncio.gather(*(do_read_skill(name) for name in sorted(EXPECTED)))

    results = asyncio.run(load_all())
    for name, result in zip(sorted(EXPECTED), results):
        assert "error" not in result, result
        assert f"=== SKILL: {name} ===" in result["results"]
        # Several skills in one turn is the intended use.
        assert "alongside" in result["results"]


def test_browse_skills_expands_matching_system_skills(monkeypatch):
    from services.memory import shared_skills
    from src.tool_implementations import do_browse_skills

    monkeypatch.setattr(shared_skills, "enabled_skills", lambda: [])
    out = asyncio.run(do_browse_skills(json.dumps({"query": "Karte mit Standorten und Diagramm"})))
    text = out["results"]
    assert "### SKILL: ui-maps" in text
    # Not presented as the user's library.
    assert "Your enabled skills" not in text


@pytest.fixture
def memory_db(monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import core.database as database
    from services.memory import shared_skills

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    database.SharedSkill.__table__.create(engine)
    database.SharedSkillFile.__table__.create(engine)
    monkeypatch.setattr(shared_skills, "SessionLocal", sessionmaker(bind=engine))
    ledger = tmp_path / "ledger.json"
    monkeypatch.setattr(shared_skills, "_seed_ledger_path", lambda: str(ledger))
    return shared_skills


def _skill_md(name, body="Do it."):
    return f"---\nname: {name}\ndescription: test skill {name}\n---\n\n{body}\n"


def test_library_never_shows_or_accepts_system_skill_names(memory_db):
    shared = memory_db
    with pytest.raises(ValueError, match="reserved"):
        shared.save_skill(_skill_md("interactive-answers"), uploader="admin")
    shared.save_skill(_skill_md("my-report"), uploader="admin")
    assert [s["name"] for s in shared.list_skills()] == ["my-report"]
    assert shared.get_skill("ui-maps") is None


def test_seeded_copy_from_an_older_version_is_retired(memory_db, tmp_path):
    shared = memory_db
    from core.database import SharedSkill

    # An older release seeded interactive-answers into the library.
    old = _skill_md("interactive-answers", "old copy")
    with shared.SessionLocal() as db:
        db.add(SharedSkill(name="interactive-answers", description="x", content=old, enabled=True))
        db.commit()
    shared._write_seed_ledger({"interactive-answers": shared._content_hash(old)})

    empty = tmp_path / "samples"
    empty.mkdir()
    shared.seed_sample_skills(str(empty))

    with shared.SessionLocal() as db:
        assert db.get(SharedSkill, "interactive-answers") is None
    assert "interactive-answers" not in shared._read_seed_ledger()
    assert "interactive-answers" not in shared.enabled_names()
