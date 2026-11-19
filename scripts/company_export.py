#!/usr/bin/env python3
"""Put a filtered copy of this repository onto the company repository.

The company repository gets the product without what belongs to the GitHub
project: no CI, no licence, no documentation, one brand. Which files that
means is written down in scripts/company_export.rules, read from the commit
that is exported, so the same commit always gives the same copy.

Each export is one commit on top of the company branch as it is: the files of
the source commit minus the rules, plus the paths the company repository keeps
for itself. Nothing is rewritten and nothing is forced, so the company history
only ever grows. The commit message is one line, "update v0.6.0": the release
the source commit belongs to, and nothing else.

Without --push the script only builds that commit locally and shows what it
would change:

    python scripts/company_export.py
    git diff --stat refs/company-export/main refs/company-export/preview
    python scripts/company_export.py --push

Where the company repository lives and who signs the commit is local
configuration, deliberately not part of this repository:

    git config companyexport.url   <https url of the company repository>
    git config companyexport.name  "<your name>"
    git config companyexport.email <your company address>

The identity is handed to the one commit the export creates. user.name and
user.email of this checkout stay untouched.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = "scripts/company_export.rules"
REF_PREFIX = "refs/company-export"
SECTIONS = ("drop", "keep", "preserve")


class ExportError(Exception):
    """Something the person running the export has to fix; shown without a traceback."""


# ---------------------------------------------------------------- rules


@dataclass(frozen=True)
class Rules:
    drop: tuple[str, ...] = ()
    keep: tuple[str, ...] = ()
    preserve: tuple[str, ...] = ()


def parse_rules(text: str) -> Rules:
    found: dict[str, list[str]] = {name: [] for name in SECTIONS}
    section = None
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            if section not in found:
                raise ExportError(f"{RULES_PATH}:{number}: unknown section [{section}]")
            continue
        if section is None:
            raise ExportError(f"{RULES_PATH}:{number}: pattern before the first section")
        found[section].append(line)
    return Rules(*(tuple(found[name]) for name in SECTIONS))


def pattern_regex(pattern: str) -> re.Pattern[str]:
    """`*`/`?` within one segment, `**/` across folders, trailing `/**` = all below."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:[^/]+/)*")
            i += 3
        elif pattern.startswith("/**", i) and i + 3 == len(pattern):
            out.append("/.+")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


def first_match(path: str, patterns: tuple[str, ...]) -> str | None:
    return next((p for p in patterns if pattern_regex(p).fullmatch(path)), None)


@dataclass
class Selection:
    """What the rules do to the files of one commit."""

    exported: list[str] = field(default_factory=list)
    dropped: dict[str, list[str]] = field(default_factory=dict)  # drop pattern -> paths
    kept: dict[str, list[str]] = field(default_factory=dict)  # keep pattern -> paths


def select(paths: list[str], rules: Rules) -> Selection:
    result = Selection()
    for path in paths:
        drop = first_match(path, rules.drop)
        keep = first_match(path, rules.keep) if drop else None
        if drop and not keep:
            result.dropped.setdefault(drop, []).append(path)
            continue
        if keep:
            result.kept.setdefault(keep, []).append(path)
        result.exported.append(path)
    return result


# ---------------------------------------------------------------- git


class Git:
    def __init__(self, repo: Path, env: dict[str, str] | None = None):
        self.repo = str(repo)
        self.env = {**os.environ, **(env or {})}

    def run(
        self,
        *args: str,
        stdin: bytes | None = None,
        env: dict[str, str] | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[bytes]:
        done = subprocess.run(
            ["git", *args],
            cwd=self.repo,
            input=stdin,
            env={**self.env, **(env or {})},
            capture_output=True,
        )
        if check and done.returncode != 0:
            message = done.stderr.decode("utf-8", "replace").strip()
            raise ExportError(f"git {' '.join(args[:2])} failed: {message}")
        return done

    def text(self, *args: str, **kwargs) -> str:
        return self.run(*args, **kwargs).stdout.decode("utf-8", "replace").strip()

    def config(self, key: str) -> str:
        return self.text("config", "--get", key, check=False)


def tree_entries(git: Git, commit: str) -> list[tuple[bytes, str]]:
    """Every file of a commit as (raw ls-tree record, path)."""
    raw = git.run("ls-tree", "-r", "-z", "--full-tree", commit).stdout
    entries = []
    for record in raw.split(b"\0"):
        if record:
            path = record.split(b"\t", 1)[1].decode("utf-8", "surrogateescape")
            entries.append((record, path))
    return entries


def encode(paths: list[str]) -> bytes:
    return b"".join(p.encode("utf-8", "surrogateescape") + b"\0" for p in paths)


# ---------------------------------------------------------------- export


@dataclass
class Export:
    source: str
    describe: str
    target: str
    commit: str | None  # None: the company branch already has exactly this content
    selection: Selection
    preserved: list[str]
    changes: list[tuple[str, str]]  # (status letter, path) against the company branch
    message: str


def _message(git: Git, source: str) -> str:
    """One line and nothing else: the newest release tag the source commit contains."""
    version = git.text("describe", "--tags", "--abbrev=0", source, check=False)
    return f"update {version or source[:9]}\n"


def build(
    git: Git,
    *,
    source_ref: str,
    target: str,
    identity: tuple[str, str],
    rules_text: str | None = None,
) -> Export:
    """Create the export commit on top of `target` (a commit of the company branch)."""
    source = git.text("rev-parse", "--verify", f"{source_ref}^{{commit}}")
    describe = git.text("describe", "--tags", "--always", source)
    if rules_text is None:
        shown = git.run("show", f"{source}:{RULES_PATH}", check=False)
        if shown.returncode != 0:
            raise ExportError(
                f"{source[:9]} has no {RULES_PATH}. Export a commit that contains the rules, "
                "or pass --rules <file>."
            )
        rules_text = shown.stdout.decode("utf-8")
    rules = parse_rules(rules_text)

    selection = select([path for _, path in tree_entries(git, source)], rules)
    dropped = [p for paths in selection.dropped.values() for p in paths]
    preserved = [
        (record, path)
        for record, path in tree_entries(git, target)
        if first_match(path, rules.preserve)
    ]

    with tempfile.TemporaryDirectory() as scratch:
        index = {"GIT_INDEX_FILE": os.path.join(scratch, "index")}
        git.run("read-tree", source, env=index)
        if dropped:
            git.run(
                "update-index", "--force-remove", "-z", "--stdin", stdin=encode(dropped), env=index
            )
        if preserved:
            records = b"".join(record + b"\0" for record, _ in preserved)
            git.run("update-index", "-z", "--index-info", stdin=records, env=index)
        tree = git.text("write-tree", env=index)

    # The rules are applied by construction; this reads the result back so a
    # mistake in the plumbing above cannot put a dropped file into the company repo.
    for _, path in tree_entries(git, tree):
        if first_match(path, rules.preserve):
            continue
        if first_match(path, rules.drop) and not first_match(path, rules.keep):
            raise ExportError(f"internal error: {path} is in the export despite the rules")

    message = _message(git, source)
    changes = [
        (line.split("\t", 1)[0], line.split("\t", 1)[1])
        for line in git.text("diff", "--name-status", "--no-renames", target, tree).splitlines()
    ]
    commit = None
    if changes:
        name, email = identity
        commit = git.text(
            "commit-tree",
            tree,
            "-p",
            target,
            stdin=message.encode("utf-8"),
            env={
                "GIT_AUTHOR_NAME": name,
                "GIT_AUTHOR_EMAIL": email,
                "GIT_COMMITTER_NAME": name,
                "GIT_COMMITTER_EMAIL": email,
            },
        )
    return Export(
        source=source,
        describe=describe,
        target=target,
        commit=commit,
        selection=selection,
        preserved=[path for _, path in preserved],
        changes=changes,
        message=message,
    )


def fetch_target(git: Git, url: str, branch: str) -> str:
    """Fetch the company branch into a ref of its own and return its commit."""
    ref = f"{REF_PREFIX}/{branch}"
    git.run("fetch", "--quiet", "--no-tags", url, f"+refs/heads/{branch}:{ref}")
    return git.text("rev-parse", "--verify", ref)


def push(git: Git, url: str, branch: str, commit: str) -> None:
    """Fast-forward the company branch. Never forced: a branch that moved since the
    fetch makes the push fail, and the next run builds on the new tip."""
    git.run("push", "--quiet", url, f"{commit}:refs/heads/{branch}")
    git.run("update-ref", f"{REF_PREFIX}/{branch}", commit)


# ---------------------------------------------------------------- command line


def _report(export: Export, branch: str, pushed: bool) -> str:
    sel = export.selection
    dropped = sum(len(paths) for paths in sel.dropped.values())
    out = [
        f"Source   {export.source[:9]}  ({export.describe})",
        f"Company  {export.target[:9]}  ({branch})",
        "",
        f"{len(sel.exported)} files exported, {dropped} left out, "
        f"{len(export.preserved)} kept from the company repository.",
        "",
        "Left out, by rule:",
    ]
    out += [f"  {len(paths):5}  {pattern}" for pattern, paths in sel.dropped.items()]
    if sel.kept:
        out += ["", "Kept as exceptions:"]
        out += [f"  {len(paths):5}  {pattern}" for pattern, paths in sel.kept.items()]

    if export.commit is None:
        return "\n".join(out + ["", "The company branch already has exactly this content."])

    counts = {
        letter: sum(1 for status, _ in export.changes if status == letter) for letter in "AMD"
    }
    out += [
        "",
        f"Against the company branch: {counts['A']} added, {counts['M']} changed, "
        f"{counts['D']} deleted.",
    ]
    deleted = [path for status, path in export.changes if status == "D"]
    if deleted:
        out.append("Deleted there:")
        out += [f"  {path}" for path in deleted[:40]]
        if len(deleted) > 40:
            out.append(f"  ... and {len(deleted) - 40} more")
    out += ["", f"Commit   {export.commit[:9]}  {export.message.splitlines()[0]}"]
    if pushed:
        out.append(f"Pushed to {branch}.")
    else:
        out += [
            "",
            "Nothing was pushed. Look at it with",
            f"  git diff --stat {REF_PREFIX}/{branch} {REF_PREFIX}/preview",
            "and send it with --push.",
        ]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the company copy of a commit; push it only with --push."
    )
    parser.add_argument("--source", default="origin/main", help="commit to export")
    parser.add_argument("--branch", default="main", help="branch of the company repository")
    parser.add_argument("--url", help="company repository (default: git config companyexport.url)")
    parser.add_argument("--rules", help="rules file to use instead of the one in the source commit")
    parser.add_argument("--push", action="store_true", help="push the export commit")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    git = Git(ROOT)
    try:
        url = args.url or git.config("companyexport.url")
        name, email = git.config("companyexport.name"), git.config("companyexport.email")
        missing = [
            key for key, value in (("url", url), ("name", name), ("email", email)) if not value
        ]
        if missing:
            raise ExportError(
                "not configured: "
                + ", ".join(f"companyexport.{key}" for key in missing)
                + ". Set each with `git config companyexport.<key> <value>`."
            )
        rules_text = Path(args.rules).read_text(encoding="utf-8") if args.rules else None

        target = fetch_target(git, url, args.branch)
        export = build(
            git,
            source_ref=args.source,
            target=target,
            identity=(name, email),
            rules_text=rules_text,
        )
        if export.commit:
            if args.push:
                push(git, url, args.branch, export.commit)
            else:
                git.run("update-ref", f"{REF_PREFIX}/preview", export.commit)
        print(_report(export, args.branch, pushed=bool(args.push and export.commit)))
    except ExportError as e:
        print(f"company export: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
