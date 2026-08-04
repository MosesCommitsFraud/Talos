# services/memory/shared_skills.py
"""Shared, user-uploaded skills (Claude-style SKILL.md packages).

Unlike the learned-skills library (services/memory/skills.py — per-owner,
agent-authored, draft/publish lifecycle), these are plain SKILL.md files any
admins upload once and every user can use. Storage is the `shared_skills` DB
table; the only required frontmatter is `name` and `description` — the body
is free-form markdown the model must follow verbatim.

Which skills are active is an admin decision for the whole deployment: the
`enabled` column on the row. There is no per-user opt-in — every user's agent
sees exactly the skills the admins have switched on.
"""

from __future__ import annotations

import logging
import re
from typing import List, Optional

from core.database import SessionLocal, SharedSkill, SharedSkillFile
from services.memory.skill_format import slugify

logger = logging.getLogger(__name__)

# Uploads are prompt-injected on demand, so keep them bounded.
MAX_SKILL_CHARS = 200_000

# Bundle limits (multi-file zip uploads).
MAX_BUNDLE_FILES = 100
MAX_BUNDLE_FILE_BYTES = 5_000_000
MAX_BUNDLE_TOTAL_BYTES = 25_000_000

# Legacy per-user opt-in pref. Kept only as the key the one-time migration in
# core.database reads; nothing writes it any more.
LEGACY_ENABLED_PREF_KEY = "shared_skills_enabled"

_FM_RE = re.compile(r"\A\s*---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
_FM_FIELD_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$")


def parse_frontmatter(content: str) -> dict:
    """Extract scalar frontmatter fields from a SKILL.md. Raises ValueError
    when the document has no frontmatter or is missing name/description."""
    m = _FM_RE.match(content or "")
    if not m:
        raise ValueError(
            "SKILL.md must start with YAML frontmatter (--- ... ---) "
            "containing at least `name` and `description`."
        )
    fields: dict = {}
    for line in m.group(1).splitlines():
        fm = _FM_FIELD_RE.match(line.strip())
        if fm:
            val = fm.group(2).strip().strip("'\"")
            fields[fm.group(1).lower()] = val
    name = slugify(fields.get("name", ""), fallback="")
    description = (fields.get("description") or "").strip()
    if not name:
        raise ValueError("Frontmatter is missing a usable `name` field.")
    if not description:
        raise ValueError("Frontmatter is missing a `description` field.")
    fields["name"] = name
    # Generous ceiling: official Anthropic skills ship trigger descriptions
    # around 1-1.5k chars. Keep A ceiling though — every enabled skill's
    # description is injected into context on every agent turn, so an
    # unbounded description would silently eat the prompt budget.
    fields["description"] = description[:4000]
    return fields


def _row_meta(row: SharedSkill, file_count: Optional[int] = None) -> dict:
    return {
        "name": row.name,
        "description": row.description or "",
        "uploaded_by": row.uploaded_by,
        "enabled": bool(row.enabled),
        "size": len(row.content or ""),
        "files": file_count if file_count is not None else 0,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _safe_bundle_path(raw: str) -> Optional[str]:
    """Normalize a zip member path; None = reject (unsafe or irrelevant)."""
    p = (raw or "").replace("\\", "/").strip()
    if not p or p.endswith("/"):
        return None  # directory entry
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if not parts or any(seg == ".." or seg.startswith("__MACOSX") for seg in parts):
        return None
    if parts[-1].startswith("."):
        return None  # hidden files (.DS_Store etc.)
    return "/".join(parts)


def save_skill(content: str, uploader: Optional[str], bundle_files: Optional[dict] = None) -> dict:
    """Create or update a shared skill from raw SKILL.md text.

    `bundle_files` maps relative path -> bytes for multi-file bundles; when
    given (even empty) it REPLACES the skill's stored bundle files.
    Re-uploading an existing name overwrites it — every writer is an admin
    curating one shared library, so there is no per-uploader ownership to
    defend. `uploaded_by` keeps recording who last wrote it.
    Returns the stored skill's metadata dict.
    """
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Empty skill file.")
    if len(content) > MAX_SKILL_CHARS:
        raise ValueError(f"Skill file too large (max {MAX_SKILL_CHARS} chars).")
    fields = parse_frontmatter(content)
    name = fields["name"]
    with SessionLocal() as db:
        row = db.get(SharedSkill, name)
        if row is None:
            row = SharedSkill(name=name, uploaded_by=uploader, enabled=False)
            db.add(row)
        elif uploader is not None:
            row.uploaded_by = uploader
        row.description = fields["description"]
        row.content = content
        if bundle_files is not None:
            db.query(SharedSkillFile).filter(SharedSkillFile.skill_name == name).delete()
            db.flush()
            for path, data in sorted(bundle_files.items()):
                db.add(SharedSkillFile(skill_name=name, path=path, content=data))
        db.commit()
        db.refresh(row)
        n_files = db.query(SharedSkillFile).filter(SharedSkillFile.skill_name == name).count()
        return _row_meta(row, n_files)


def save_bundle(zip_bytes: bytes, uploader: Optional[str]) -> dict:
    """Create or update a shared skill from a zip bundle.

    The zip must contain a SKILL.md either at the root or inside a single
    top-level directory (the usual `skill-name/SKILL.md` layout); every other
    member is stored as a bundle file relative to that SKILL.md.
    """
    import io
    import zipfile

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise ValueError("Not a valid zip file.")

    members: dict = {}
    total = 0
    with zf:
        for info in zf.infolist():
            path = _safe_bundle_path(info.filename)
            if path is None:
                continue
            if info.file_size > MAX_BUNDLE_FILE_BYTES:
                raise ValueError(
                    f"{path!r} is too large (max {MAX_BUNDLE_FILE_BYTES // 1_000_000} MB per file)."
                )
            total += info.file_size
            if total > MAX_BUNDLE_TOTAL_BYTES:
                raise ValueError(
                    f"Bundle too large (max {MAX_BUNDLE_TOTAL_BYTES // 1_000_000} MB total)."
                )
            if len(members) >= MAX_BUNDLE_FILES:
                raise ValueError(f"Too many files in bundle (max {MAX_BUNDLE_FILES}).")
            members[path] = zf.read(info)

    # Locate SKILL.md: root, or under exactly one shared top-level directory.
    skill_key = next((p for p in members if p.lower() == "skill.md"), None)
    prefix = ""
    if skill_key is None:
        tops = {p.split("/", 1)[0] for p in members}
        if len(tops) == 1:
            candidate = next(iter(tops)) + "/"
            skill_key = next(
                (p for p in members if p.lower() == (candidate + "skill.md").lower()), None
            )
            prefix = candidate
    if skill_key is None:
        raise ValueError("Bundle must contain a SKILL.md at its root (or in one top-level folder).")

    try:
        skill_md = members[skill_key].decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("SKILL.md is not valid UTF-8.")

    bundle_files = {
        p[len(prefix) :]: data
        for p, data in members.items()
        if p != skill_key and p.startswith(prefix)
    }
    return save_skill(skill_md, uploader, bundle_files=bundle_files)


# ── Bundled sample skills ──
# The skills shipped in the repo's `sample_skills/` folder are seeded into the
# shared library on startup so they appear in Settings → Skills next to
# everything users upload themselves. They are seeded, not special-cased: once
# in the table they are ordinary shared skills the admin can edit or delete.
#
# Two things this must never do:
#   1. Overwrite a copy the user has edited.
#   2. Resurrect a copy the user deleted.
# Both need memory of what we put there, which the table alone can't give us —
# hence the ledger below, mapping skill name -> hash of the SKILL.md we seeded.
# A row whose current content still hashes to the ledger value is an untouched
# seed and may be refreshed when the shipped version changes; anything else is
# the user's and is left alone.
SEED_LEDGER_FILENAME = "seeded_skills.json"


def _seed_ledger_path() -> str:
    import os

    from src.constants import DATA_DIR

    return os.path.join(DATA_DIR, SEED_LEDGER_FILENAME)


def _read_seed_ledger() -> dict:
    import json
    import os

    path = _seed_ledger_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_seed_ledger(ledger: dict) -> None:
    from core.atomic_io import atomic_write_json

    atomic_write_json(_seed_ledger_path(), ledger, indent=2)


def _content_hash(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_sample_skill(skill_dir: str) -> Optional[tuple]:
    """(skill_md_text, {relpath: bytes}) for one sample-skill folder, or None."""
    import os

    md_path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(md_path):
        return None
    with open(md_path, encoding="utf-8") as f:
        content = f.read()
    bundle: dict = {}
    total = 0
    for root, _dirs, files in os.walk(skill_dir):
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, skill_dir).replace("\\", "/")
            if rel.lower() == "skill.md":
                continue
            safe = _safe_bundle_path(rel)
            if safe is None:
                continue
            size = os.path.getsize(full)
            total += size
            if (
                size > MAX_BUNDLE_FILE_BYTES
                or total > MAX_BUNDLE_TOTAL_BYTES
                or len(bundle) >= MAX_BUNDLE_FILES
            ):
                logger.warning("sample skill %s exceeds bundle limits; truncating", skill_dir)
                return content, bundle
            with open(full, "rb") as bf:
                bundle[safe] = bf.read()
    return content, bundle


def seed_sample_skills(source_dir: Optional[str] = None) -> int:
    """Install the repo's bundled sample skills into the shared library.

    Idempotent and non-destructive: a skill the user edited or deleted stays
    that way. Returns the number of skills written.
    """
    import os

    if source_dir is None:
        from src.constants import BASE_DIR

        source_dir = os.path.join(BASE_DIR, "sample_skills")
    if not os.path.isdir(source_dir):
        return 0

    ledger = _read_seed_ledger()
    written = 0
    for entry in sorted(os.listdir(source_dir)):
        skill_dir = os.path.join(source_dir, entry)
        if not os.path.isdir(skill_dir):
            continue
        try:
            read = _read_sample_skill(skill_dir)
            if read is None:
                continue
            content, bundle = read
            name = parse_frontmatter(content)["name"]
        except Exception as e:
            logger.warning("Skipping sample skill %s: %s", entry, e)
            continue

        shipped_hash = _content_hash(content)
        with SessionLocal() as db:
            row = db.get(SharedSkill, name)
            existing = row.content if row is not None else None
        seeded_hash = ledger.get(name)

        if existing is None:
            # Never seen in the table. Only install it if we have never seeded
            # it — a name in the ledger with no row means the user deleted it.
            if seeded_hash is not None:
                continue
        elif seeded_hash is None or _content_hash(existing) != seeded_hash:
            # Either it predates the ledger or the user has changed it. Theirs.
            continue
        elif seeded_hash == shipped_hash:
            continue  # already current

        try:
            save_skill(content, uploader=None, bundle_files=bundle)
        except Exception as e:
            logger.warning("Could not seed sample skill %s: %s", name, e)
            continue
        ledger[name] = shipped_hash
        written += 1

    if written:
        try:
            _write_seed_ledger(ledger)
        except Exception as e:
            logger.warning("Could not persist the sample-skill ledger: %s", e)
        logger.info("Seeded %d sample skill(s) into the shared library", written)
    return written


def _file_counts(db) -> dict:
    from sqlalchemy import func as _func

    return dict(
        db.query(SharedSkillFile.skill_name, _func.count(SharedSkillFile.id))
        .group_by(SharedSkillFile.skill_name)
        .all()
    )


def list_skills() -> List[dict]:
    # `bundled` marks a skill that came from the repo's sample_skills folder, so
    # the UI can label it without inferring from a missing uploader (skills from
    # a pre-auth install also have no uploader and are NOT bundled).
    seeded = set(_read_seed_ledger())
    with SessionLocal() as db:
        counts = _file_counts(db)
        rows = db.query(SharedSkill).order_by(SharedSkill.name).all()
        out = []
        for r in rows:
            meta = _row_meta(r, counts.get(r.name, 0))
            meta["bundled"] = r.name in seeded
            out.append(meta)
        return out


def get_skill(name: str) -> Optional[dict]:
    with SessionLocal() as db:
        row = db.get(SharedSkill, slugify(name, fallback=""))
        if row is None:
            return None
        paths = [
            p
            for (p,) in db.query(SharedSkillFile.path)
            .filter(SharedSkillFile.skill_name == row.name)
            .order_by(SharedSkillFile.path)
            .all()
        ]
        meta = _row_meta(row, len(paths))
        meta["content"] = row.content or ""
        meta["file_paths"] = paths
        return meta


def get_skill_file(name: str, path: str) -> Optional[bytes]:
    """Raw bytes of one bundled file, or None."""
    clean = _safe_bundle_path(path)
    if clean is None:
        return None
    with SessionLocal() as db:
        row = (
            db.query(SharedSkillFile)
            .filter(
                SharedSkillFile.skill_name == slugify(name, fallback=""),
                SharedSkillFile.path == clean,
            )
            .first()
        )
        return None if row is None else bytes(row.content or b"")


def materialize(name: str, dest_dir: str) -> List[str]:
    """Write a skill's SKILL.md + bundle files under `dest_dir` so the agent's
    bash/python tools can use them (run scripts, open templates). Returns the
    list of relative paths written. Safe to call repeatedly (overwrites)."""
    import os

    skill = get_skill(name)
    if skill is None:
        return []
    written: List[str] = []
    os.makedirs(dest_dir, exist_ok=True)
    with open(os.path.join(dest_dir, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(skill["content"])
    written.append("SKILL.md")
    with SessionLocal() as db:
        rows = db.query(SharedSkillFile).filter(SharedSkillFile.skill_name == skill["name"]).all()
        for row in rows:
            rel = _safe_bundle_path(row.path)
            if rel is None:
                continue
            target = os.path.join(dest_dir, *rel.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(bytes(row.content or b""))
            written.append(rel)
    return written


def delete_skill(name: str, user: Optional[str], is_admin: bool = False) -> bool:
    with SessionLocal() as db:
        row = db.get(SharedSkill, slugify(name, fallback=""))
        if row is None:
            return False
        if not is_admin and user is not None and row.uploaded_by != user:
            raise PermissionError("Only the uploader (or an admin) can delete this skill.")
        db.delete(row)
        db.commit()
        return True


# ── Global enable/disable (admin-controlled) ──


def enabled_names() -> set:
    """Names of the skills admins have switched on for this deployment."""
    try:
        with SessionLocal() as db:
            return {
                n for (n,) in db.query(SharedSkill.name).filter(SharedSkill.enabled.is_(True)).all()
            }
    except Exception as e:
        logger.debug(f"shared-skills enabled read failed: {e}")
        return set()


def set_enabled(name: str, enabled: bool) -> bool:
    """Turn a skill on/off for everyone. False = no such skill."""
    with SessionLocal() as db:
        row = db.get(SharedSkill, slugify(name, fallback=""))
        if row is None:
            return False
        row.enabled = bool(enabled)
        db.commit()
        return True


def enabled_skills() -> List[dict]:
    """The `[{name, description}]` index of active skills — what gets injected
    into every agent's context. Skills an admin has not enabled stay invisible."""
    return [
        {"name": s["name"], "description": s["description"]} for s in list_skills() if s["enabled"]
    ]
