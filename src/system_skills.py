"""
system_skills.py — built-in skills that belong to Talos itself.

Two kinds of skills reach the agent:

  * the shared skill library (services/memory/shared_skills.py): uploaded or
    seeded by admins, switched on and off per deployment, listed to users in
    Settings → Skills — the user's own methods for their own work;
  * system skills, here: the method behind one of Talos's OWN features (today:
    interactive answers — render_ui / render_widget). They are part of the
    product, like a tool description, not something to curate. So they are:
      - always available while the feature they belong to is (gated by the
        tools in `requires-tools`, not by an admin switch or the user's skill
        toggle);
      - never shown in the skill library, never editable or deletable there,
        and their names are reserved so an upload cannot shadow them;
      - read with the same `read_skill` tool, as many per turn as the task
        needs — there is no per-turn cap, and they combine freely with each
        other and with library skills.

A system skill is a folder under `system_skills/` with a SKILL.md (frontmatter
`name`, `description`, optional `requires-tools: a, b` — available when ANY of
them is enabled) and optional bundled files (references/...).
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)


def _root() -> str:
    from src.constants import BASE_DIR

    return os.path.join(BASE_DIR, "system_skills")


@lru_cache(maxsize=1)
def _load() -> Dict[str, dict]:
    """name → {name, description, requires, content, files{path: bytes}}.
    Read once per process: these ship with the code and change with it."""
    from services.memory.shared_skills import _read_sample_skill, parse_frontmatter

    root = _root()
    out: Dict[str, dict] = {}
    if not os.path.isdir(root):
        return out
    for entry in sorted(os.listdir(root)):
        folder = os.path.join(root, entry)
        if not os.path.isdir(folder):
            continue
        try:
            read = _read_sample_skill(folder)
            if read is None:
                continue
            content, files = read
            fields = parse_frontmatter(content)
        except Exception as e:
            logger.warning("Skipping system skill %s: %s", entry, e)
            continue
        requires = [
            t.strip() for t in str(fields.get("requires-tools") or "").split(",") if t.strip()
        ]
        out[fields["name"]] = {
            "name": fields["name"],
            "description": fields["description"],
            # Trigger words (German and English) for browse_skills matching;
            # the description is English and written for the model.
            "keywords": str(fields.get("keywords") or ""),
            "requires": requires,
            "content": content,
            "files": files,
        }
    return out


def names() -> set:
    """Reserved: the shared library may not hold or show a skill by these names."""
    return set(_load())


def available(disabled_tools: Optional[Iterable[str]] = None) -> List[dict]:
    """System skills whose feature is on (any required tool not disabled)."""
    disabled = set(disabled_tools or ())
    out = []
    for skill in _load().values():
        req = skill["requires"]
        if req and all(t in disabled for t in req):
            continue
        out.append({"name": skill["name"], "description": skill["description"]})
    return out


def get(name: str) -> Optional[dict]:
    from services.memory.skill_format import slugify

    skill = _load().get(slugify(name or "", fallback=""))
    if skill is None:
        return None
    return {**skill, "file_paths": sorted(skill["files"])}


def get_file(name: str, path: str) -> Optional[bytes]:
    from services.memory.shared_skills import _safe_bundle_path

    skill = get(name)
    clean = _safe_bundle_path(path or "")
    if skill is None or clean is None:
        return None
    return skill["files"].get(clean)


def matches(query: str, disabled_tools: Optional[Iterable[str]] = None) -> List[dict]:
    """System skills relevant to a browse_skills query, restricted to the ones
    currently available.

    Matched on the skill's `keywords` as word STEMS, Unicode-aware, one hit is
    enough: German compounds ("Ablaufdiagramm", "Standorten") contain the stem
    ("ablauf", "standort") but never equal it, and a wrong extra skill costs a
    few hundred tokens while a missed one costs the method."""
    import re

    words = [w for w in re.findall(r"\w+", (query or "").lower()) if len(w) >= 3]
    if not words:
        return []
    out = []
    for s in available(disabled_tools):
        skill = _load()[s["name"]]
        stems = {
            k.strip().lower()
            for k in skill["keywords"].replace(";", ",").split(",")
            if len(k.strip()) >= 3 and " " not in k.strip()
        }
        stems.add(s["name"].lower())
        if any(
            w.startswith(stem) or stem in w for w in words for stem in stems if len(stem) >= 4
        ) or any(w == stem for w in words for stem in stems):
            out.append(s)
    # The specialised UI skills build on the base one: whenever one of them
    # fits, interactive-answers comes along.
    base = next((s for s in available(disabled_tools) if s["name"] == "interactive-answers"), None)
    if out and base and base not in out:
        out.insert(0, base)
    return out
