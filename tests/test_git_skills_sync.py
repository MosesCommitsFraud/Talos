"""Skills from a Git repository: a real repository on disk, the real skill library."""

import os
import subprocess

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import SharedSkill, SharedSkillFile
from services.memory import shared_skills
from src import git_skills_sync as gss
from src import rag_git_sync as gs


def git(cwd, *args):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.invalid",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.invalid",
    }
    subprocess.run(["git", *args], cwd=str(cwd), env=env, check=True, capture_output=True)


def skill_md(name, body="Do the thing.", description="How to do the thing"):
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


class Repo:
    def __init__(self, path, name="ai-context"):
        self.path = path / name
        self.path.mkdir()
        git(self.path, "init", "--quiet", "--initial-branch", "master")
        self.write("readme.md", "about")
        self.commit()

    def write(self, rel, text):
        target = self.path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def remove(self, rel):
        (self.path / rel).unlink()

    def commit(self):
        git(self.path, "add", "-A")
        git(self.path, "commit", "--quiet", "--allow-empty", "-m", "change")

    def config(self, folders=("skills",), interval=60):
        url = self.path.as_uri()
        return {
            "id": gs.repo_id_for(url),
            "url": url,
            "branch": "",
            "token": "",
            "mappings": [{"folder": f, "base": gs.SKILLS_TARGET} for f in folders],
            "skills_interval_minutes": interval,
        }


@pytest.fixture
def env(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SharedSkill.__table__.create(engine)
    SharedSkillFile.__table__.create(engine)
    monkeypatch.setattr(shared_skills, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(
        shared_skills, "_seed_ledger_path", lambda: str(tmp_path / "seeded_skills.json")
    )
    monkeypatch.setattr(gss, "_ledger_path", lambda: str(tmp_path / "git_skills.json"))
    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path / "rag"))
    monkeypatch.setattr(gs, "GIT_PROTOCOLS", "file")
    gss._checked.clear()
    return tmp_path


def library():
    return {s["name"]: s for s in shared_skills.list_skills()}


def test_a_skill_in_the_repository_lands_in_the_library_switched_on(env):
    repo = Repo(env)
    repo.write("Skills/angebot/SKILL.md", skill_md("angebot"))
    repo.write("Skills/angebot/references/preise.md", "Preisliste")
    repo.commit()

    state = gss.sync_repo(repo.config())

    assert state["ok"] is True and state["outcomes"]["new"] == 1
    assert library()["angebot"]["enabled"] is True
    assert shared_skills.get_skill_file("angebot", "references/preise.md") == b"Preisliste"
    assert gss.read_ledger()["angebot"]["repo"] == repo.config()["id"]


def test_changes_and_removals_follow_the_repository_and_uploads_stay(env):
    shared_skills.save_skill(skill_md("eigener"), uploader="anna")
    repo = Repo(env)
    repo.write("Skills/a/SKILL.md", skill_md("a", "erste Fassung"))
    repo.write("Skills/b/SKILL.md", skill_md("b"))
    repo.write("Skills/b/script.py", "print(1)")
    repo.commit()
    gss.sync_repo(repo.config())

    repo.write("Skills/b/script.py", "print(2)")
    repo.remove("Skills/a/SKILL.md")
    repo.commit()
    state = gss.sync_repo(repo.config())

    assert state["outcomes"]["updated"] == 1 and state["outcomes"]["removed"] == 1
    assert set(library()) == {"b", "eigener"}
    assert shared_skills.get_skill_file("b", "script.py") == b"print(2)"


def test_a_library_skill_of_the_same_name_is_taken_over_and_keeps_its_switch(env):
    shared_skills.save_skill(skill_md("dashboard", "alte Fassung"), uploader="anna")
    repo = Repo(env)
    repo.write("Skills/dashboard/SKILL.md", skill_md("dashboard", "Fassung aus dem Repository"))
    repo.commit()

    state = gss.sync_repo(repo.config())

    assert state["outcomes"]["taken_over"] == 1
    assert len(library()) == 1
    assert "Fassung aus dem Repository" in shared_skills.get_skill("dashboard")["content"]
    assert library()["dashboard"]["enabled"] is False


def test_a_sample_skill_that_moved_to_the_repository_is_not_seeded_over(env):
    samples = env / "sample_skills"
    (samples / "dashboard").mkdir(parents=True)
    (samples / "dashboard" / "SKILL.md").write_text(skill_md("dashboard", "v1"), encoding="utf-8")
    shared_skills.seed_sample_skills(str(samples))
    repo = Repo(env)
    repo.write("Skills/dashboard/SKILL.md", skill_md("dashboard", "v1"))
    repo.commit()

    state = gss.sync_repo(repo.config())
    assert state["outcomes"]["taken_over"] == 1 and len(library()) == 1

    # A release ships a newer sample; the repository's version stays.
    (samples / "dashboard" / "SKILL.md").write_text(skill_md("dashboard", "v2"), encoding="utf-8")
    assert shared_skills.seed_sample_skills(str(samples)) == 0
    assert "v1" in shared_skills.get_skill("dashboard")["content"]


def test_a_built_in_skill_is_not_duplicated_into_the_library(env):
    repo = Repo(env)
    repo.write("Skills/ui-maps/SKILL.md", skill_md("ui-maps"))
    repo.commit()

    state = gss.sync_repo(repo.config())

    assert state["ok"] is True and state["outcomes"]["builtin"] == 1
    assert library() == {}


def test_a_missing_folder_removes_nothing(env):
    repo = Repo(env)
    repo.write("Skills/a/SKILL.md", skill_md("a"))
    repo.commit()
    gss.sync_repo(repo.config())

    git(repo.path, "mv", "Skills", "Anleitungen")
    repo.commit()
    state = gss.sync_repo(repo.config())

    assert state["ok"] is False and "not in the repository" in state["message"]
    assert set(library()) == {"a"}


def test_a_deselected_folder_inside_the_skill_folder_brings_no_skills(env):
    repo = Repo(env)
    repo.write("Skills/a/SKILL.md", skill_md("a"))
    repo.write("Skills/Entwurf/b/SKILL.md", skill_md("b"))
    repo.commit()
    gss.sync_repo(repo.config())
    assert set(library()) == {"a", "b"}

    config = repo.config()
    config["mappings"].append({"folder": "skills/entwurf", "base": gs.NONE_TARGET})
    state = gss.sync_repo(config)

    assert state["ok"] is True and state["outcomes"]["removed"] == 1
    assert set(library()) == {"a"}


def test_a_broken_skill_is_reported_and_the_others_still_arrive(env):
    repo = Repo(env)
    repo.write("Skills/gut/SKILL.md", skill_md("gut"))
    repo.write("Skills/kaputt/SKILL.md", "kein Frontmatter")
    repo.commit()

    state = gss.sync_repo(repo.config())

    assert state["ok"] is False and "Skills/kaputt" in state["message"]
    assert set(library()) == {"gut"}


def test_a_skill_of_another_repository_is_refused(env):
    first, second = Repo(env, "first"), Repo(env, "second")
    for repo, body in ((first, "aus dem ersten"), (second, "aus dem zweiten")):
        repo.write("Skills/a/SKILL.md", skill_md("a", body))
        repo.commit()
    gss.sync_repo(first.config())

    state = gss.sync_repo(second.config())

    assert state["ok"] is False and "already comes from" in state["message"]
    assert "aus dem ersten" in shared_skills.get_skill("a")["content"]


def test_the_timer_respects_the_interval_and_skips_an_unchanged_repository(env, monkeypatch):
    repo = Repo(env)
    repo.write("Skills/a/SKILL.md", skill_md("a", "aus dem Repository"))
    repo.commit()
    monkeypatch.setattr(gs, "configured_repos", lambda: [repo.config(interval=10)])
    applied = []
    real_apply = gss.apply
    monkeypatch.setattr(gss, "apply", lambda *a, **kw: applied.append(1) or real_apply(*a, **kw))

    assert gss.check_due(now=1_000_000) == [repo.config()["id"]]
    assert set(library()) == {"a"} and len(applied) == 1
    # Not due yet.
    gss._checked[repo.config()["id"]] = 1_000_000
    assert gss.check_due(now=1_000_000 + 9 * 60) == []
    # Due, but nothing changed: fetched, not applied again.
    assert gss.check_due(now=1_000_000 + 11 * 60) == [repo.config()["id"]]
    assert len(applied) == 1

    # Edited in the app: the repository's version is put back on the next check.
    shared_skills.save_skill(skill_md("a", "in der App geändert"), uploader="anna")
    gss._checked.clear()
    gss.check_due(now=2_000_000)
    assert "aus dem Repository" in shared_skills.get_skill("a")["content"]


def test_the_timer_is_off_at_zero_and_for_repositories_without_skills(env, monkeypatch):
    repo = Repo(env)
    monkeypatch.setattr(
        gs, "configured_repos", lambda: [repo.config(interval=0), repo.config(folders=())]
    )
    assert gss.check_due(now=1_000_000) == []


def test_a_failed_fetch_is_recorded_and_changes_nothing(env):
    repo = Repo(env)
    repo.write("Skills/a/SKILL.md", skill_md("a"))
    repo.commit()
    gss.sync_repo(repo.config())

    state = gss.sync_repo({**repo.config(), "url": (env / "gone").as_uri()})

    assert state["ok"] is False and "git fetch failed" in state["message"]
    assert set(library()) == {"a"}


# ---------------------------------------------------------------------------
# Configuration and starting
# ---------------------------------------------------------------------------


def test_the_interval_is_clamped_and_defaults_to_an_hour():
    def interval(**extra):
        return gs.normalize_repos([{"url": "https://git.example/a", **extra}])[0][
            "skills_interval_minutes"
        ]

    assert interval() == 60
    assert interval(skills_interval_minutes=0) == 0
    assert interval(skills_interval_minutes=1) == 5
    assert interval(skills_interval_minutes="30") == 30
    with pytest.raises(ValueError):
        interval(skills_interval_minutes="oft")


def test_a_repository_with_only_skills_starts_no_ingest_job(monkeypatch):
    import src.rag_worker as worker

    repos = gs.normalize_repos(
        [{"url": "https://git.example/a", "mappings": [{"folder": "skills", "base": "@skills"}]}]
    )
    monkeypatch.setattr(gs, "configured_repos", lambda: repos)
    monkeypatch.setattr(gs, "_resolve_mappings", lambda repo: ([], []))
    started = []
    monkeypatch.setattr(gss, "start", lambda repo_id: started.append(repo_id) or True)

    def no_queue(plan):
        raise AssertionError("nothing to ingest")

    monkeypatch.setattr(worker, "start_git_sync", no_queue)

    job = gs.start()

    assert job["id"] is None and job["plan"]["skills"] is True
    assert started == [repos[0]["id"]]
    # Narrowed to one knowledge base, the skills are not part of the run.
    with pytest.raises(gs.GitSyncError, match="No folder"):
        gs.plan_sync(only_base="default")


def test_a_skill_folder_is_not_resolved_as_a_knowledge_base(monkeypatch):
    from src import rag_mini

    monkeypatch.setattr(rag_mini, "sync", lambda: [])
    repo = gs.normalize_repos(
        [{"url": "https://git.example/a", "mappings": [{"folder": "skills", "base": "@skills"}]}]
    )[0]
    assert gs._resolve_mappings(repo) == ([], [])
