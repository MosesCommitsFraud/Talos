# services/__init__.py
"""
Service layer — plug-in capabilities for the chat core.

Only the memory service remains; this build runs internally where web search
and other external-facing services are not available.
"""

from .memory import MemoryService, Memory, MemorySearchResult

__all__ = [
    "MemoryService",
    "Memory",
    "MemorySearchResult",
]
