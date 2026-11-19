"""Company export (scripts/company_export.py): real repositories on disk, the real rules."""

import os
import subprocess
from pathlib import Path

import pytest

from scripts import company_export as ce

REAL_RULES = (ce.ROOT / ce.RULES_PATH).read_text(encoding="utf-8")
COMPANY = ("Erika Muster", "erika@company.invalid")


def git(cwd, *args):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "dev",
        "GIT_AUTHOR_EMAIL": "dev@github.invalid",
        "GIT_COMMITTER_NAME": "dev",
        "GIT_COMMITTER_EMAIL": "dev@github.invalid",
    }
    done = subprocess.run(["git", *args], cwd=str(cwd), env=env, check=True, capture_output=True)
    return done.stdout.decode("utf-8").strip()


def write(root: Path, files: dict[str, str]):
    for rel, text in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")


def commit(repo: Path, subject: str) -> str:
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", subject)
    return git(repo, "rev-parse", "HEAD")


def files_of(repo: Path, rev: str) -> set[str]:
    return set(git(repo, "ls-tree", "-r", "--name-only", rev).splitlines())


@pytest.fixture
def source(tmp_path):
    """The GitHub side: product files next to everything the rules leave out."""
    repo = tmp_path / "github"
    repo.mkdir()
    git(repo, "init", "--quiet", "--initial-branch", "main")
    write(
        repo,
        {
            "app.py": "print('new')\n",
            "LICENSE.md": "terms\n",
            "TODO.md": "later\n",
            "Hardware.docx": "binary\n",
            "mkdocs.yml": "site_name: x\n",
            "requirements-docs.txt": "mkdocs\n",
            ".github/workflows/ci.yml": "on: push\n",
            "docs/index.md": "# docs\n",
            "docs/javascripts/mermaid.js": "//\n",
            "deploy/ionos-vllm/README.md": "how\n",
            "deploy/ionos-vllm/run.sh": "#!/bin/sh\n",
            "branding/README.md": "profiles\n",
            "branding/macs/brand.json": '{"name": "macs"}\n',
            "branding/talos/brand.json": '{"name": "Talos"}\n',
            "system_skills/ui-maps/SKILL.md": "skill\n",
            "sample_skills/dashboard/references/layout.md": "ref\n",
            "tests/snapshots/system_prompt.lean.md": "prompt\n",
            "static/ui-vendor/README.md": "vendored\n",
            "static/ui-vendor/chart.js@4.4.4/LICENSE.md": "MIT\n",
            ".data/workspaces/demo/grades.csv": "a,b\n",
            "scripts/company_export.py": "# tool\n",
            ce.RULES_PATH: REAL_RULES,
        },
    )
    commit(repo, "product with everything around it")
    return repo


@pytest.fixture
def company(tmp_path):
    """The company side: a bare repository that already has a history of its own."""
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "--quiet", "--initial-branch", "main")
    write(
        seed,
        {
            "app.py": "print('old')\n",
            "removed_upstream.py": "gone on GitHub\n",
            "docker-file/compose-stand.txt": "kept by hand\n",
        },
    )
    commit(seed, "earlier export")
    bare = tmp_path / "company.git"
    git(tmp_path, "clone", "--quiet", "--bare", str(seed), str(bare))
    return bare


def export(source, company, **kwargs):
    g = ce.Git(source)
    target = ce.fetch_target(g, str(company), "main")
    return g, ce.build(g, source_ref="HEAD", target=target, identity=COMPANY, **kwargs)


# ---------------------------------------------------------------- patterns


@pytest.mark.parametrize(
    "pattern, path, expected",
    [
        ("**/*.md", "TODO.md", True),
        ("**/*.md", "docs/plans/x.md", True),
        ("**/*.md", "docs/readme.mdx", False),
        ("*.docx", "Hardware.docx", True),
        ("*.docx", "docs/Hardware.docx", False),
        ("LICENSE.md", "static/ui-vendor/chart.js@4.4.4/LICENSE.md", False),
        (".github/**", ".github/workflows/ci.yml", True),
        (".github/**", ".githubx/ci.yml", False),
        ("docs/**", "docs", False),
        ("static/ui-vendor/**/LICENSE*", "static/ui-vendor/d3@7.9.0/LICENSE", True),
        ("static/ui-vendor/**/LICENSE*", "static/ui-vendor/LICENSE.md", True),
        ("branding/macs/**", "branding/macs2/brand.json", False),
    ],
)
def test_pattern(pattern, path, expected):
    assert bool(ce.first_match(path, (pattern,))) is expected


def test_rules_file_with_a_typo_is_refused():
    with pytest.raises(ce.ExportError, match=r"unknown section \[dorp\]"):
        ce.parse_rules("[dorp]\n*.md\n")
    with pytest.raises(ce.ExportError, match="before the first section"):
        ce.parse_rules("*.md\n")


def test_the_real_rules_on_the_layout_of_this_repository():
    """The rules as committed, on one path of every kind the repository has."""
    stays = [
        "app.py",
        "Dockerfile",
        "docker-compose.yml",
        ".env.example",
        "requirements.txt",
        "tests/test_branding.py",
        "tests/snapshots/system_prompt.classic.md",
        "scripts/ui_eval.py",
        "scripts/modelltest/plan.json",
        "system_skills/ui-data/SKILL.md",
        "sample_skills/dashboard-v2/references/legacy-builders.md",
        "static/ui-vendor/chart.js@4.4.4/LICENSE.md",
        "static/ui-vendor/echarts@5.5.1/LICENSE",
        "branding/macs/logo-small.svg",
        "deploy/ionos-vllm/docker-compose.yml",
        "deploy/ionos-vllm/models/qwen3.8-27b.yaml",
    ]
    goes = [
        ".github/workflows/ci.yml",
        ".github/dependabot.yml",
        "LICENSE.md",
        "TODO.md",
        "Talos_Hardware_Requirements_v0.1.docx",
        "mkdocs.yml",
        "requirements-docs.txt",
        "docs/index.md",
        "docs/javascripts/mermaid.min.js",
        "docs/overrides.css",
        "deploy/ionos-vllm/README.md",
        "scripts/modelltest/README.md",
        "static/ui-vendor/README.md",
        "branding/README.md",
        "branding/talos/brand.json",
        ".data/workspaces/demo/grades.csv",
        ".smoke/sales.csv",
        "scripts/company_export.py",
        "scripts/company_export.rules",
        "tests/test_company_export.py",
    ]
    selection = ce.select(stays + goes, ce.parse_rules(REAL_RULES))
    assert selection.exported == stays
    assert sorted(p for paths in selection.dropped.values() for p in paths) == sorted(goes)


# ---------------------------------------------------------------- export


def test_export_is_one_commit_on_top_of_the_company_branch(source, company):
    g, result = export(source, company)
    tip = git(company, "rev-parse", "main")

    assert git(source, "rev-parse", f"{result.commit}^") == tip
    assert files_of(source, result.commit) == {
        "app.py",
        "deploy/ionos-vllm/run.sh",
        "branding/macs/brand.json",
        "system_skills/ui-maps/SKILL.md",
        "sample_skills/dashboard/references/layout.md",
        "tests/snapshots/system_prompt.lean.md",
        "static/ui-vendor/chart.js@4.4.4/LICENSE.md",
        "docker-file/compose-stand.txt",
    }
    assert git(source, "show", f"{result.commit}:app.py") == "print('new')"
    assert git(source, "show", f"{result.commit}:docker-file/compose-stand.txt") == "kept by hand"
    assert ("D", "removed_upstream.py") in result.changes
    # Building alone leaves the company repository as it was.
    assert git(company, "rev-parse", "main") == tip


def test_commit_carries_the_company_identity_and_a_one_line_message(source, company):
    _, result = export(source, company)
    head = git(source, "rev-parse", "HEAD")

    who = git(source, "log", "-1", "--format=%an <%ae> / %cn <%ce>", result.commit)
    assert who == "Erika Muster <erika@company.invalid> / Erika Muster <erika@company.invalid>"
    # No release tag yet, so the commit itself names the state.
    assert git(source, "log", "-1", "--format=%B", result.commit) == f"update {head[:9]}"
    # The checkout's own identity is not what the export writes with, and stays unset.
    assert ce.Git(source).text("config", "--local", "--get-regexp", r"^user\.", check=False) == ""


def test_message_names_the_release_the_commit_belongs_to(source, company):
    git(source, "tag", "v1.2.3")
    _, tagged = export(source, company)
    assert git(source, "log", "-1", "--format=%B", tagged.commit) == "update v1.2.3"

    write(source, {"app.py": "print('after the release')\n"})
    commit(source, "Chat: answers arrive faster")
    _, later = export(source, company)
    assert git(source, "log", "-1", "--format=%B", later.commit) == "update v1.2.3"


def test_push_then_the_next_export_builds_on_it(source, company):
    g, first = export(source, company)
    ce.push(g, str(company), "main", first.commit)
    assert git(company, "rev-parse", "main") == first.commit

    _, again = export(source, company)
    assert again.commit is None and again.changes == []

    write(source, {"app.py": "print('newer')\n", "notes.md": "not exported\n"})
    commit(source, "Chat: answers arrive faster")
    g, second = export(source, company)
    assert second.changes == [("M", "app.py")]
    ce.push(g, str(company), "main", second.commit)
    assert git(company, "rev-list", "--count", "main") == "3"


def test_a_company_branch_that_moved_is_not_overwritten(source, company, tmp_path):
    g, result = export(source, company)
    other = tmp_path / "colleague"
    git(tmp_path, "clone", "--quiet", str(company), str(other))
    write(other, {"docker-file/compose-new.txt": "added in the web UI\n"})
    commit(other, "compose snapshot")
    git(other, "push", "--quiet", "origin", "main")
    moved = git(company, "rev-parse", "main")

    with pytest.raises(ce.ExportError, match="push"):
        ce.push(g, str(company), "main", result.commit)
    assert git(company, "rev-parse", "main") == moved

    g, rebuilt = export(source, company)
    assert "docker-file/compose-new.txt" in files_of(source, rebuilt.commit)


def test_a_commit_without_rules_is_not_exported(source, company):
    (source / ce.RULES_PATH).unlink()
    commit(source, "rules gone")
    with pytest.raises(ce.ExportError, match="has no scripts/company_export.rules"):
        export(source, company)
    # A rules file from outside can stand in, e.g. to try a rule before committing it.
    _, result = export(source, company, rules_text="[drop]\n**/*.md\n")
    assert "LICENSE.md" not in files_of(source, result.commit)
    assert ".github/workflows/ci.yml" in files_of(source, result.commit)
