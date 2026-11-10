"""git_skills_sync.py

Keeps the shared skill library in step with a folder of a Git repository, the way
``src/rag_git_sync.py`` keeps the knowledge bases in step with the others.

A repository folder mapped to ``SKILLS_TARGET`` holds skills: every folder below it
with a ``SKILL.md`` is one, its other files are the skill's bundle. They land in the
shared library (services/memory/shared_skills.py), because that is the curated one
every user's agent reads from.

Runs in the app, not in the ingest worker: the library lives in the app database,
which the worker does not share. Hence a checkout of its own, so it never touches the
one the worker syncs documents from. Started with every sync of the repository and
checked on a timer (``check_due``, driven from app.py), since nobody calls
``update_rag`` for a changed skill.

One skill per name
------------------
A skill is its name, so that is what makes two of them the same:

* A library skill with the name of a repository skill is taken over: the repository's
  version replaces it and it keeps its on/off switch. That covers the sample skills
  shipped with Talos once they move to the repository. The sample seeder leaves such a
  name alone from then on, or a later release would overwrite the repository's version.
* A name of a built-in system skill (src/system_skills.py) is skipped: that one ships
  with the code and is used anyway.
* A name another repository already brought in is refused, and reported.

A ledger records which skills a repository brought in. Only those are removed when
they leave the repository, and as with documents only after a run that saw every
configured folder. The repository decides: a synced skill edited in the app is put
back to the repository's version on the next run.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src import rag_git_sync as gs

logger = logging.getLogger(__name__)

SKILLS_TARGET = gs.SKILLS_TARGET
LEDGER_FILENAME = "git_skills.json"
SKILL_FILE = "skill.md"

_lock = threading.Lock()
# repo id -> when it was last checked, in this process. A restart checks at once.
_checked: Dict[str, float] = {}


# ---------------------------------------------------------------------------
# Ledger and state
# ---------------------------------------------------------------------------


def _ledger_path() -> str:
    from src.constants import DATA_DIR

    return os.path.join(DATA_DIR, LEDGER_FILENAME)


def read_ledger() -> Dict[str, Dict[str, str]]:
    """Skill name -> ``{"repo": id, "hash": bundle hash}`` for every synced skill."""
    try:
        with open(_ledger_path(), encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_ledger(ledger: Dict[str, Dict[str, str]]) -> None:
    from core.atomic_io import atomic_write_json

    atomic_write_json(_ledger_path(), ledger, indent=2)


def _state_path(repo_id: str) -> Path:
    return gs._root() / f"{repo_id}.skills.json"


def read_state(repo_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_state_path(repo_id), encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_state(repo_id: str, state: Dict[str, Any]) -> Dict[str, Any]:
    from core.atomic_io import atomic_write_json

    state = {**state, "finished_at": time.time()}
    try:
        _state_path(repo_id).parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(str(_state_path(repo_id)), state)
    except OSError as e:
        logger.warning("could not record the skill sync state of %s: %s", repo_id, e)
    return state


# ---------------------------------------------------------------------------
# Reading the repository
# ---------------------------------------------------------------------------


def skill_folders(repo: Dict[str, Any]) -> List[str]:
    return [m["folder"] for m in repo["mappings"] if m["base"] == SKILLS_TARGET]


def _fetch(repo: Dict[str, Any]) -> Tuple[Path, str]:
    checkout = gs._root() / ".skills" / repo["id"]
    checkout.mkdir(parents=True, exist_ok=True)
    token = repo["token"]
    if not (checkout / ".git").is_dir():
        gs._git(["init", "--quiet"], checkout, token)
    gs._clear_stale_locks(checkout)
    ref = repo["branch"] or "HEAD"
    gs._git(["fetch", "--quiet", "--depth", "1", "--no-tags", repo["url"], ref], checkout, token)
    commit = gs._git(["rev-parse", "FETCH_HEAD"], checkout, token)
    return checkout, commit


def _checkout(repo: Dict[str, Any], checkout: Path) -> None:
    token = repo["token"]
    gs._git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], checkout, token)
    gs._git(["clean", "--quiet", "-ffdx"], checkout, token)


def _skill_dirs(folder: Path) -> List[str]:
    """Every folder with a SKILL.md at or below ``folder``. A skill's own subfolders
    are its bundle, so the walk does not look for further skills inside one."""
    found = []
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        if any(name.lower() == SKILL_FILE for name in filenames):
            found.append(dirpath)
            dirnames[:] = []
    return found


def bundle_hash(content: str, files: Dict[str, bytes]) -> str:
    """One hash over a skill's SKILL.md and its bundle, so a changed script counts."""
    digest = hashlib.sha256(content.encode("utf-8"))
    for path in sorted(files):
        digest.update(b"\x00" + path.encode("utf-8") + b"\x00")
        digest.update(hashlib.sha256(files[path]).digest())
    return digest.hexdigest()


def _library_hash(name: str) -> Optional[str]:
    """The same hash for what the library holds under this name; None if nothing."""
    from services.memory import shared_skills

    skill = shared_skills.get_skill(name)
    if skill is None:
        return None
    files = {path: shared_skills.get_skill_file(name, path) or b"" for path in skill["file_paths"]}
    return bundle_hash(skill["content"], files)


def _read_skills(
    checkout: Path, folders: List[str], mapped: Optional[List[str]] = None
) -> Tuple[Dict[str, Tuple[str, Dict[str, bytes]]], List[str], List[str]]:
    """``(name -> (SKILL.md, bundle), missing folders, problems)``.

    ``mapped`` is every mapped folder of the repository: a skill inside a more specific
    one, such as a deselected subfolder, is not this folder's.
    """
    from services.memory.shared_skills import _read_sample_skill, parse_frontmatter

    skills: Dict[str, Tuple[str, Dict[str, bytes]]] = {}
    missing: List[str] = []
    problems: List[str] = []
    for folder in folders:
        root = gs._find_folder(checkout, folder)
        if root is None:
            missing.append(f"Folder '{folder}' is not in the repository")
            continue
        for skill_dir in _skill_dirs(root):
            rel = os.path.relpath(skill_dir, checkout).replace(os.sep, "/")
            if gs.claimed_deeper(rel, folder, mapped or []):
                continue
            try:
                content, files = _read_sample_skill(skill_dir)
                name = parse_frontmatter(content)["name"]
            except (ValueError, OSError, UnicodeDecodeError, TypeError) as e:
                problems.append(f"{rel}: {e}")
                continue
            if name in skills:
                problems.append(f"{rel}: a second skill named '{name}'")
                continue
            skills[name] = (content, files)
    return skills, missing, problems


# ---------------------------------------------------------------------------
# Syncing
# ---------------------------------------------------------------------------


def apply(
    repo_id: str, skills: Dict[str, Tuple[str, Dict[str, bytes]]], *, prune: bool
) -> Tuple[Dict[str, int], List[str]]:
    """Make the library hold ``skills`` for this repository. Returns outcomes, problems."""
    from services.memory import shared_skills
    from src import system_skills

    ledger = read_ledger()
    builtin = system_skills.names()
    outcomes = {"new": 0, "updated": 0, "taken_over": 0, "unchanged": 0, "builtin": 0, "removed": 0}
    problems: List[str] = []
    for name, (content, files) in sorted(skills.items()):
        if name in builtin:
            outcomes["builtin"] += 1
            continue
        owner = (ledger.get(name) or {}).get("repo")
        if owner and owner != repo_id:
            problems.append(f"Skill '{name}' already comes from repository {owner}")
            continue
        wanted = bundle_hash(content, files)
        current = _library_hash(name)
        if current != wanted:
            try:
                shared_skills.save_skill(content, uploader=None, bundle_files=files)
            except ValueError as e:
                problems.append(f"Skill '{name}': {e}")
                continue
            if current is None:
                # Putting it in the repository was the decision to use it. An existing
                # skill keeps whatever an admin set.
                shared_skills.set_enabled(name, True)
        if current is None:
            outcomes["new"] += 1
        elif not owner:
            outcomes["taken_over"] += 1
        elif current != wanted:
            outcomes["updated"] += 1
        else:
            outcomes["unchanged"] += 1
        ledger[name] = {"repo": repo_id, "hash": wanted}

    if prune:
        for name in [n for n, e in ledger.items() if e.get("repo") == repo_id and n not in skills]:
            shared_skills.delete_skill(name, None, is_admin=True)
            del ledger[name]
            outcomes["removed"] += 1
    _write_ledger(ledger)
    return outcomes, problems


def _message(commit: str, outcomes: Dict[str, int], problems: List[str], pruned: bool) -> str:
    labels = (
        ("new", "new"),
        ("updated", "updated"),
        ("taken_over", "taken over"),
        ("unchanged", "unchanged"),
        ("removed", "removed"),
        ("builtin", "built in, skipped"),
    )
    parts = [f"{outcomes[key]} {label}" for key, label in labels if outcomes.get(key)]
    message = f"@{commit[:7]}: " + (", ".join(parts) or "no skills found")
    if problems:
        message += ". " + "; ".join(problems[:5])
        if not pruned:
            message += ". Nothing was removed"
    return message


def sync_repo(repo: Dict[str, Any], *, force: bool = True) -> Optional[Dict[str, Any]]:
    """Sync one repository's skills now. None when it has no skill folder.

    Without ``force`` a repository whose commit was already synced cleanly is left
    alone, which is what makes the timer cheap.
    """
    folders = skill_folders(repo)
    if not folders:
        return None
    with _lock:
        _checked[repo["id"]] = time.time()
        try:
            checkout, commit = _fetch(repo)
            last = read_state(repo["id"]) or {}
            if not force and last.get("ok") and last.get("commit") == commit:
                # Still what the repository holds, unless someone changed the library.
                if _library_matches(repo["id"]):
                    return last
            _checkout(repo, checkout)
            mapped = [m["folder"] for m in repo["mappings"]]
            skills, missing, problems = _read_skills(checkout, folders, mapped)
            prune = not missing
            outcomes, refused = apply(repo["id"], skills, prune=prune)
        except gs.GitSyncError as e:
            return _write_state(repo["id"], {"ok": False, "message": str(e)})
        except Exception as e:
            logger.exception("skill sync of %s failed", repo["id"])
            return _write_state(repo["id"], {"ok": False, "message": f"{type(e).__name__}: {e}"})
        problems = missing + problems + refused
        return _write_state(
            repo["id"],
            {
                "ok": not problems,
                "commit": commit,
                "outcomes": outcomes,
                "message": _message(commit, outcomes, problems, prune),
            },
        )


def _library_matches(repo_id: str) -> bool:
    """Whether every skill this repository brought in is still as it was synced."""
    return all(
        _library_hash(name) == entry.get("hash")
        for name, entry in read_ledger().items()
        if entry.get("repo") == repo_id
    )


def start(repo_id: str) -> bool:
    """Sync one configured repository's skills in the background. False = it has none."""
    repo = next((r for r in gs.configured_repos() if r["id"] == repo_id), None)
    if repo is None or not skill_folders(repo):
        return False
    threading.Thread(
        target=sync_repo, args=(repo,), name=f"git-skills-{repo_id}", daemon=True
    ).start()
    return True


def check_due(now: Optional[float] = None) -> List[str]:
    """Check every repository whose interval has passed. Returns the ids checked.

    Blocking (git, database): app.py calls it from a worker thread once a minute.
    """
    now = time.time() if now is None else now
    checked = []
    for repo in gs.configured_repos():
        minutes = repo.get("skills_interval_minutes") or 0
        if not minutes or not skill_folders(repo):
            continue
        if now - _checked.get(repo["id"], 0.0) < minutes * 60:
            continue
        sync_repo(repo, force=False)
        checked.append(repo["id"])
    return checked
