# services/memory/__init__.py
"""Skills service — reusable skill library (SKILL.md format)."""

from .skill_format import Skill, slugify
from .skills import SkillsManager

__all__ = [
    "Skill",
    "SkillsManager",
    "slugify",
]
