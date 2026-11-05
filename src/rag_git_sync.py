"""rag_git_sync.py

Keeps knowledge bases in step with folders of a Git repository: what ``update_rag``
(src/mcp_public.py) and the "sync now" button in Settings → MCP start.

The administrator lists repositories in the ``rag_git_repos`` setting, one of them
the default, and says per repository which folder goes to which knowledge base or
mini RAG. A caller can only name a repository from that list, never a URL: otherwise
a token could point the instance at any host and have it fetch and index whatever
is there.

What a repository owns
----------------------
A synced document has origin ``git`` in the document register and carries the
repository's id in its metadata (``rag_documents.GIT_REPO_META``). Its logical path
is ``git/<repo id>/<path in the repo>``, so equal file names from two repositories
are different documents. A sync adds, updates and removes only documents marked with
its own repository, so other repositories are out of reach by construction. So are
uploads, with one exception, below.

Duplicates
----------
An update must not take anyone's hand, so a file that was uploaded before it came from
Git is taken over: an upload in the same base with the name or the content of a
repository file is the same document, and the repository's version replaces it. Nobody
has to delete anything, and no old version stays behind next to the new one. Uploads
under other names with other content stay untouched. Beyond that, Git documents take
part in the register's content check as uploads do: content another repository already
holds is recorded as a duplicate, not indexed twice, and takes its place when that copy
goes (``_promote_duplicates``).

Removing
--------
A document that left the repository leaves the base, but only after a run that could
see the whole picture. If the fetch failed, a configured folder is missing or a target
base is gone, nothing is removed: a renamed folder or a typo in a mapping must not
empty a knowledge base.

The fetch and the ingest run in the rag-ingest-worker (``rag_worker.git_sync_job``).
The checkout stays on the shared volume because a document's ``source`` points at it,
which is what re-indexing and downloading the original read.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple
from urllib.parse import urlsplit

from src import rag_documents as rd
from src.rag_registry import (
    DEFAULT_ID,
    RagNotFound,
    base_for_collection,
    get_base,
    registry_path,
    slugify,
)

logger = logging.getLogger(__name__)

SETTING = "rag_git_repos"
# A mapping target meaning "the mini RAG of the default database": the first enabled
# one, resolved at each sync so it follows the databases in Integrations.
DEFAULT_DB_TARGET = "@default-db"
DEFAULT_EXCLUDE = ["readme.*"]
# A note to whoever edits the folder, not knowledge. .sql is on top of what a directory
# sync takes: the schema scripts belong in a mini RAG.
EXTRA_EXTENSIONS = {".sql"}

GIT_TIMEOUT_SECONDS = 300
# Enforced by git itself, for every URL including redirects and submodules.
GIT_PROTOCOLS = "http:https"
_URL_SCHEMES = ("http", "https")
_BRANCH_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$")


class GitSyncError(Exception):
    """A sync that can't run. The message is safe to hand to the caller."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _clean_url(value: Any) -> str:
    url = str(value or "").strip()
    if not url:
        raise ValueError("Every repository needs a URL")
    parts = urlsplit(url)
    if parts.scheme.lower() not in _URL_SCHEMES or not parts.hostname:
        raise ValueError(f"Not an http(s) repository URL: {url}")
    if parts.username or parts.password:
        raise ValueError("Credentials don't belong in the repository URL: use the token field")
    if re.search(r"\s", url):
        raise ValueError(f"Not an http(s) repository URL: {url}")
    return url.rstrip("/")


def repo_id_for(url: str) -> str:
    """A stable id derived from the URL: readable, and the same after a re-add.

    A document's identity contains it, so an entry removed and added again finds
    its documents. A different URL is a different repository.
    """
    normalized = url.strip().rstrip("/").lower()
    normalized = normalized[:-4] if normalized.endswith(".git") else normalized
    tail = normalized.rsplit("/", 1)[-1]
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    return f"{slugify(tail)[:40]}-{digest}"


def _clean_mappings(value: Any) -> List[Dict[str, str]]:
    seen = set()
    mappings: List[Dict[str, str]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        folder = rd.clean_relative_path(item.get("folder"))
        base = str(item.get("base") or "").strip()
        if not base:
            raise ValueError(f"Folder '{folder or '/'}' has no target knowledge base")
        if (folder.lower(), base) not in seen:
            seen.add((folder.lower(), base))
            mappings.append({"folder": folder, "base": base})
    return mappings


def normalize_repos(raw: Any) -> List[Dict[str, Any]]:
    """Validate the setting into its stored shape; ``ValueError`` says what's wrong.

    Exactly one repository ends up as the default.
    """
    if not isinstance(raw, list):
        raise ValueError(f"{SETTING} must be a list")
    repos: List[Dict[str, Any]] = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f"{SETTING} must be a list of repositories")
        url = _clean_url(item.get("url"))
        repo_id = repo_id_for(url)
        if repo_id in seen:
            raise ValueError(f"Repository listed twice: {url}")
        seen.add(repo_id)
        branch = str(item.get("branch") or "").strip()
        if branch and (not _BRANCH_RE.match(branch) or ".." in branch):
            raise ValueError(f"Not a branch name: {branch}")
        exclude = item.get("exclude", DEFAULT_EXCLUDE)
        exclude = exclude if isinstance(exclude, list) else str(exclude or "").split(",")
        repos.append(
            {
                "id": repo_id,
                "url": url,
                "branch": branch,
                "token": str(item.get("token") or "").strip(),
                "default": bool(item.get("default")),
                "exclude": [str(p).strip() for p in exclude if str(p).strip()],
                "mappings": _clean_mappings(item.get("mappings")),
            }
        )
    default = next((r for r in repos if r["default"]), repos[0] if repos else None)
    for repo in repos:
        repo["default"] = repo is default
    return repos


def configured_repos() -> List[Dict[str, Any]]:
    from src.settings import get_setting

    try:
        return normalize_repos(get_setting(SETTING, []) or [])
    except ValueError as e:
        # Saving validates, so this is a hand-edited settings file.
        logger.error("%s is invalid: %s", SETTING, e)
        return []


def find_repo(repo_id: Optional[str] = None) -> Dict[str, Any]:
    """A configured repository by id; the default one when none is named."""
    repos = configured_repos()
    if not repos:
        raise GitSyncError(
            "No Git repository is configured on this instance (Settings → MCP Server)."
        )
    if not repo_id:
        return next(r for r in repos if r["default"])
    for repo in repos:
        if repo["id"] == repo_id:
            return repo
    known = ", ".join(r["id"] for r in repos)
    raise GitSyncError(f"Unknown repository {repo_id!r}. Configured: {known}.")


def _resolve_mappings(repo: Dict[str, Any]) -> Tuple[List[Dict[str, str]], List[str]]:
    """Mappings with a real base id, and what could not be resolved."""
    from src import rag_mini

    rag_mini.sync()
    resolved: List[Dict[str, str]] = []
    problems: List[str] = []
    for mapping in repo["mappings"]:
        label = mapping["folder"] or "/"
        base = mapping["base"]
        if base == DEFAULT_DB_TARGET:
            base = rag_mini.default_base_id() or ""
            if not base:
                problems.append(f"Folder '{label}': no SQL database is enabled")
                continue
        else:
            try:
                get_base(base)
            except RagNotFound:
                problems.append(f"Folder '{label}': knowledge base '{base}' no longer exists")
                continue
            if rag_mini.is_orphaned(base):
                problems.append(f"Folder '{label}': the database of '{base}' was removed")
                continue
        resolved.append({"folder": mapping["folder"], "base": base})
    return resolved, problems


def plan_sync(repo_id: Optional[str] = None, only_base: Optional[str] = None) -> Dict[str, Any]:
    """What one run is to do, with every target resolved. Carries no token: it goes
    through the job queue, and the worker reads the token from the settings."""
    repo = find_repo(repo_id)
    mappings, problems = _resolve_mappings(repo)
    if only_base:
        mappings = [m for m in mappings if m["base"] == only_base]
    if not mappings and not problems:
        what = f" to knowledge base {only_base!r}" if only_base else ""
        raise GitSyncError(f"No folder of {repo['url']} is mapped{what}.")
    return {
        "repo_id": repo["id"],
        "url": repo["url"],
        "branch": repo["branch"],
        "exclude": repo["exclude"],
        "mappings": mappings,
        "problems": problems,
        "only_base": only_base,
    }


def start(repo_id: Optional[str] = None, only_base: Optional[str] = None) -> Dict[str, Any]:
    """Queue a sync. Returns the job, with ``plan`` so a caller can say what it does."""
    from src import rag_worker

    plan = plan_sync(repo_id, only_base)
    try:
        job = rag_worker.start_git_sync(plan)
    except Exception as e:
        logger.error("could not queue the Git sync of %s: %s", plan["repo_id"], e)
        raise GitSyncError("The ingest queue is unavailable. Is Redis (rag-redis) running?")
    return {**job, "plan": plan}


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def _root() -> Path:
    """On the shared volume, next to the catalogue, because the worker fetches here
    and the app serves the originals from here."""
    return registry_path().parent / "git_sync"


def _checkout_dir(repo_id: str) -> Path:
    return _root() / repo_id


def _auth_header(token: str) -> str:
    # Basic with any user name and the token as password is what Azure DevOps,
    # GitHub and GitLab all accept for a personal access token.
    raw = base64.b64encode(f"git:{token}".encode("utf-8")).decode("ascii")
    return f"Authorization: Basic {raw}"


def _git_env(token: str) -> Dict[str, str]:
    """Environment for every git call.

    The token travels in an environment-only setting, so it never reaches a command
    line, a URL or ``.git/config``. Redirects are off with a token, or it would follow
    to wherever the server points. Nothing from the host's git configuration applies.
    """
    config = [
        # A symlink in a repository could otherwise point at any file on this host,
        # which would then be indexed. This writes it as a plain file holding the path.
        ("core.symlinks", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", os.devnull),
        ("credential.helper", ""),
        # Our own checkout; the volume may be owned by another uid.
        ("safe.directory", "*"),
    ]
    if token:
        config += [("http.extraHeader", _auth_header(token)), ("http.followRedirects", "false")]
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GCM_INTERACTIVE="never",
        GIT_ALLOW_PROTOCOL=GIT_PROTOCOLS,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_LFS_SKIP_SMUDGE="1",
        GIT_CONFIG_COUNT=str(len(config)),
    )
    for i, (key, value) in enumerate(config):
        env[f"GIT_CONFIG_KEY_{i}"] = key
        env[f"GIT_CONFIG_VALUE_{i}"] = value
    return env


def _scrub(text: str, token: str) -> str:
    if token:
        text = text.replace(token, "***").replace(_auth_header(token), "***")
    return text


def _git(args: List[str], cwd: Path, token: str) -> str:
    try:
        done = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            env=_git_env(token),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        raise GitSyncError("git is not installed on this host")
    except subprocess.TimeoutExpired:
        raise GitSyncError(f"git {args[0]} took longer than {GIT_TIMEOUT_SECONDS}s")
    if done.returncode != 0:
        tail = " ".join((done.stderr or "").strip().splitlines()[-3:])
        raise GitSyncError(_scrub(f"git {args[0]} failed: {tail}", token))
    return (done.stdout or "").strip()


def _clear_stale_locks(checkout: Path) -> None:
    """A worker killed mid-fetch leaves lock files that would fail every later run.
    Past the timeout of any git call, a lock has no live owner."""
    now = time.time()
    for lock in (checkout / ".git").glob("*.lock"):
        try:
            if now - lock.stat().st_mtime > GIT_TIMEOUT_SECONDS:
                lock.unlink()
        except OSError as e:
            logger.warning("could not clear stale git lock %s: %s", lock, e)


def fetch(plan: Dict[str, Any], token: str = "") -> Tuple[Path, str]:
    """Bring the checkout to the tip of the branch. Returns ``(path, commit)``.

    Shallow, and the URL is passed per call rather than stored as a remote, so a
    changed URL or branch needs no migration.
    """
    checkout = _checkout_dir(plan["repo_id"])
    checkout.mkdir(parents=True, exist_ok=True)
    if not (checkout / ".git").is_dir():
        _git(["init", "--quiet"], checkout, token)
    _clear_stale_locks(checkout)
    ref = plan.get("branch") or "HEAD"
    _git(["fetch", "--quiet", "--depth", "1", "--no-tags", plan["url"], ref], checkout, token)
    _git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], checkout, token)
    _git(["clean", "--quiet", "-ffdx"], checkout, token)
    return checkout, _git(["rev-parse", "HEAD"], checkout, token)


# ---------------------------------------------------------------------------
# Which files
# ---------------------------------------------------------------------------


def _extensions() -> set:
    from src import rag_formats as rf
    from src.rag_vector import DEFAULT_FILE_EXTENSIONS

    # An archive would unpack into documents this module can't see in the repository.
    return (set(DEFAULT_FILE_EXTENSIONS) | EXTRA_EXTENSIONS) - set(rf.CONTAINER_EXTS)


def _find_folder(root: Path, folder: str) -> Optional[Path]:
    """A folder of the checkout, ignoring case: ``knowledge`` finds ``Knowledge``."""
    current = root
    for part in folder.split("/") if folder else []:
        try:
            names = os.listdir(current)
        except OSError:
            return None
        match = part if part in names else None
        if match is None:
            match = next((n for n in names if n.lower() == part.lower()), None)
        if match is None or match == ".git":
            return None
        current = current / match
        if current.is_symlink() or not current.is_dir():
            return None
    return current


def _excluded(rel: str, patterns: List[str]) -> bool:
    name = rel.rsplit("/", 1)[-1].lower()
    rel = rel.lower()
    return any(
        fnmatch.fnmatchcase(name, p.lower()) or fnmatch.fnmatchcase(rel, p.lower())
        for p in patterns
    )


def _repo_files(
    root: Path, start_dir: Path, exclude: List[str], extensions: set
) -> Iterator[Tuple[str, str]]:
    """``(absolute path, path inside the repository)`` of every file to index."""
    for dirpath, dirnames, filenames in os.walk(start_dir, followlinks=False):
        dirnames[:] = sorted(
            d for d in dirnames if d != ".git" and not os.path.islink(os.path.join(dirpath, d))
        )
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            if os.path.islink(path) or Path(name).suffix.lower() not in extensions:
                continue
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if not _excluded(rel, exclude):
                yield path, rel


def _file_meta(repo_id: str, path: str, rel: str) -> Dict[str, Any]:
    name = rel.rsplit("/", 1)[-1]
    return {
        "source": path,
        "filename": name,
        "directory": os.path.dirname(path),
        "type": Path(name).suffix.lower(),
        "logical_path": f"git/{repo_id}/{rel}",
        "origin": rd.ORIGIN_GIT,
        rd.GIT_REPO_META: repo_id,
    }


# ---------------------------------------------------------------------------
# Syncing
# ---------------------------------------------------------------------------


def _shared_uploads(register, collection: str) -> List[Dict[str, Any]]:
    """Uploads a sync may take over: not someone's personal file, not a namespace of a
    feature, and not a member of an archive, which belongs to the archive."""
    return [
        row
        for row in register.list(collection)
        if row["origin"] == rd.ORIGIN_UPLOAD
        and row["status"] in (rd.INDEXED, rd.DUPLICATE)
        and not row.get("owner")
        and not row.get("scope")
        and not (row.get("ingest_meta") or {}).get("container_doc_id")
    ]


def _same_document(
    logical_path: str,
    sha: str,
    current: Optional[Dict[str, Any]],
    uploads: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """The uploads that are this repository file under another origin.

    Same name, because that is what makes two uploads one document in the register
    (``upload_identity``), and it finds the older version a repository has moved on
    from. A folder upload must match the path as well, so ``Nord/x.md`` is not ``x.md``.
    Same content, because it is then the same document whatever it is called. And the
    upload this file was recorded as a copy of, whose content it may have left behind.
    """
    rel = rd.normalize_logical_path(logical_path.split("/", 2)[-1])
    twin = (current or {}).get("duplicate_of")
    matches = []
    for upload in uploads:
        name = rd.normalize_logical_path(upload["logical_path"])
        if (
            rel == name
            or rel.endswith("/" + name)
            or (sha and upload.get("content_sha256") == sha)
            or upload["doc_id"] == twin
        ):
            matches.append(upload)
    return matches


def sync_base(
    rag,
    repo_id: str,
    files: Dict[str, Tuple[str, Dict[str, Any]]],
    *,
    prune: bool,
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Make one base hold ``files`` (doc id → path, metadata) for this repository.

    The register decides what is work: unchanged files cost a hash at most. Only
    documents marked with ``repo_id`` are ever removed, and a new file with the content
    of one that left is a rename, which replaces it rather than being its duplicate.
    An upload of the same document is taken over (``_same_document``), once the file
    that replaces it has been indexed.
    """
    register = rag._register()
    if register is None:
        raise GitSyncError("The document register is unavailable")
    coll = rag.collection_name
    current = register.live_from_repo(repo_id, coll)
    by_id = {row["doc_id"]: row for row in current}
    gone = [row for row in current if row["doc_id"] not in files] if prune else []
    gone_by_sha = {row["content_sha256"]: row for row in gone if row.get("content_sha256")}
    uploads = _shared_uploads(register, coll)

    queue: List[Tuple[str, Dict[str, Any]]] = []
    renamed = set()
    takeovers: List[Tuple[str, Dict[str, Any]]] = []
    primaries = set()
    for doc_id, (path, meta) in files.items():
        sha = rd.file_sha256(path) if gone_by_sha or uploads else ""
        old = gone_by_sha.pop(sha, None) if doc_id not in by_id else None
        matches = _same_document(meta["logical_path"], sha, by_id.get(doc_id), uploads)
        uploads = [u for u in uploads if u not in matches]
        # A skipped copy holds no chunks, and deleting it now keeps it from being
        # indexed in its own right when the document it copies is replaced.
        for copy in [m for m in matches if m["status"] == rd.DUPLICATE]:
            rag.delete_document(doc_id=copy["doc_id"])
            rd.delete_managed_file(copy["source"])
            takeovers.append((doc_id, copy))
        indexed = [m for m in matches if m["status"] != rd.DUPLICATE]
        if old:
            meta = {**meta, "_replaces": old["doc_id"]}
            renamed.add(old["doc_id"])
        elif indexed:
            # The one with this content first: the register must not take the new file
            # for a copy of it. A failed index keeps it, like any replacement.
            indexed.sort(key=lambda m: m.get("content_sha256") != sha)
            meta = {**meta, "_replaces": indexed[0]["doc_id"]}
            primaries.add(indexed[0]["doc_id"])
        takeovers += [(doc_id, m) for m in indexed]
        queue.append((path, meta))

    result = rag.index_files(queue, progress_cb=progress_cb)
    if not result.get("success"):
        raise GitSyncError(result.get("message") or "Indexing failed")
    for row in gone:
        if row["doc_id"] in renamed:
            continue
        outcome = rag.delete_document(doc_id=row["doc_id"])
        if outcome.get("error"):
            result["failed_count"] += 1
            result["errors"].append({"file": row["display_name"], "error": outcome["error"]})
        else:
            result["outcomes"]["deleted"] = result["outcomes"].get("deleted", 0) + 1

    # Only where the repository's file arrived: a failed one leaves the upload in place.
    taken_over: List[str] = []
    for doc_id, upload in takeovers:
        row = register.get(coll, doc_id) or {}
        if row.get("status") not in (rd.INDEXED, rd.DUPLICATE) or row.get("error"):
            continue
        still_there = (register.get(coll, upload["doc_id"]) or {}).get("status") != rd.DELETED
        if still_there:
            rag.delete_document(doc_id=upload["doc_id"])
            rd.delete_managed_file(upload["source"])
        taken_over.append(upload["display_name"])
        if upload["doc_id"] in primaries:
            # Counted as a takeover, not as a rename.
            result["outcomes"]["replaced"] = max(0, result["outcomes"].get("replaced", 0) - 1)
    if taken_over:
        logger.info("Git sync of %s took over uploads in %s: %s", repo_id, coll, taken_over)
        result["outcomes"]["taken_over"] = len(taken_over)
        result["taken_over"] = taken_over
    return result


def _wanted_files(
    plan: Dict[str, Any], checkout: Path
) -> Tuple[Dict[str, Dict[str, Tuple[str, Dict[str, Any]]]], List[str]]:
    """The files each base should hold, and the configured folders that don't exist."""
    extensions = _extensions()
    wanted: Dict[str, Dict[str, Tuple[str, Dict[str, Any]]]] = {}
    missing: List[str] = []
    for mapping in plan["mappings"]:
        files = wanted.setdefault(mapping["base"], {})
        folder = _find_folder(checkout, mapping["folder"])
        if folder is None:
            missing.append(f"Folder '{mapping['folder']}' is not in the repository")
            continue
        for path, rel in _repo_files(checkout, folder, plan.get("exclude") or [], extensions):
            meta = _file_meta(plan["repo_id"], path, rel)
            files[rd.make_doc_id(meta["logical_path"])] = (path, meta)
    return wanted, missing


def _other_bases(repo_id: str, wanted: Dict[str, Any]) -> List[str]:
    """Bases still holding this repository's documents that no mapping leads to any
    more: the folder was pointed at another base, so its documents have to leave."""
    register = rd.DocumentRegister(str(registry_path().parent))
    bases = {
        base_for_collection(r["collection"]) or DEFAULT_ID for r in register.live_from_repo(repo_id)
    }
    return sorted(bases - set(wanted))


def _write_state(repo_id: str, state: Dict[str, Any]) -> None:
    """The last run, on the shared volume: finished jobs expire from the queue."""
    path = _root() / f"{repo_id}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".state-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError as e:
        logger.warning("could not record the Git sync state of %s: %s", repo_id, e)


def _read_state(repo_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_root() / f"{repo_id}.json", "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _token_for(repo_id: str) -> str:
    return next((r["token"] for r in configured_repos() if r["id"] == repo_id), "")


def _message(
    plan: Dict[str, Any], commit: str, outcomes: Dict[str, int], problems: List[str]
) -> str:
    parts = [f"{plan['url'].rsplit('/', 1)[-1]}@{commit[:7]}"]
    for key, label in (
        ("indexed", "new"),
        ("updated", "updated"),
        ("reindexed", "re-indexed"),
        ("replaced", "renamed"),
        ("taken_over", "upload(s) replaced"),
        ("unchanged", "unchanged"),
        ("duplicate", "duplicate"),
        ("deleted", "removed"),
        ("failed", "failed"),
    ):
        if outcomes.get(key):
            parts.append(f"{outcomes[key]} {label}")
    message = ", ".join(parts)
    if problems:
        message += ". Nothing was removed: " + "; ".join(problems)
    return message


def run(
    plan: Dict[str, Any],
    rag_for: Callable[[str], Any],
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """One sync, from fetch to removal. ``rag_for`` gives the VectorRAG of a base."""
    repo_id = plan["repo_id"]
    problems = list(plan.get("problems") or [])
    try:
        checkout, commit = fetch(plan, _token_for(repo_id))
    except GitSyncError as e:
        _write_state(repo_id, {"ok": False, "finished_at": time.time(), "message": str(e)})
        raise

    wanted, missing = _wanted_files(plan, checkout)
    problems += missing
    # A run that doesn't see every target can't tell "left the repository" from "wasn't
    # looked at", so it only adds and updates.
    prune = not problems
    targets = sorted(wanted)
    if prune and not plan.get("only_base"):
        targets += _other_bases(repo_id, wanted)

    outcomes: Dict[str, int] = {}
    errors: List[Dict[str, str]] = []
    files: List[Dict[str, Any]] = []
    taken_over: List[str] = []
    indexed = failed = 0
    for base in targets:
        try:
            result = sync_base(
                rag_for(base),
                repo_id,
                wanted.get(base, {}),
                prune=prune,
                progress_cb=progress_cb,
            )
        except Exception as e:
            logger.error("Git sync of %s into %s failed: %s", repo_id, base, e)
            errors.append({"file": base, "error": f"{type(e).__name__}: {e}"})
            failed += 1
            continue
        indexed += int(result.get("indexed_count") or 0)
        failed += int(result.get("failed_count") or 0)
        errors += result.get("errors") or []
        files += result.get("files") or []
        taken_over += result.get("taken_over") or []
        for key, count in (result.get("outcomes") or {}).items():
            outcomes[key] = outcomes.get(key, 0) + int(count or 0)

    errors += [{"file": plan["url"].rsplit("/", 1)[-1], "error": p} for p in problems]
    failed += len(problems)
    message = _message(plan, commit, outcomes, problems)
    if taken_over:
        # An upload left the base, so whoever reads this should see which.
        message += f" (replaced: {', '.join(sorted(taken_over)[:5])})"
    _write_state(
        repo_id,
        {
            "ok": not errors,
            "commit": commit,
            "finished_at": time.time(),
            "message": message,
            "outcomes": outcomes,
            "errors": errors[:10],
        },
    )
    return {
        "success": not errors,
        "message": message,
        "commit": commit,
        "indexed_count": indexed,
        "failed_count": failed,
        "total": len(files),
        "processed": len(files),
        "errors": errors,
        "outcomes": outcomes,
        "files": files[:500],
    }


def status() -> List[Dict[str, Any]]:
    """Every configured repository with its last run and any job under way. No tokens."""
    from src import rag_worker

    active = [
        j
        for j in rag_worker.list_jobs(limit=100)
        if j.get("type") == "git_sync" and j.get("status") in ("queued", "running")
    ]
    return [
        {
            "id": repo["id"],
            "url": repo["url"],
            "default": repo["default"],
            "last": _read_state(repo["id"]),
            "job": next((j for j in active if j.get("repo_id") == repo["id"]), None),
        }
        for repo in configured_repos()
    ]
