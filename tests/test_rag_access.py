"""Per-knowledge-base access: who may retrieve from a restricted base."""

import pytest

import src.tool_security as tool_security
from src import rag_registry as registry

ADMINS = {"chef"}


@pytest.fixture
def bases(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        tool_security, "owner_is_admin_or_single_user", lambda owner: (owner or "") in ADMINS
    )
    registry.create_base("HR", rag_id="hr")
    registry.update_base("hr", chat_enabled=True, access={"restricted": True, "users": ["Anna"]})
    registry.create_base("Technik", rag_id="technik")
    registry.update_base("technik", chat_enabled=True)
    return registry


def test_restricted_base_is_visible_to_listed_users_and_admins_only(bases):
    hr = bases.get_base("hr")
    assert bases.access_of(hr) == {"restricted": True, "users": ["anna"]}
    assert bases.can_access(hr, "anna")
    assert bases.can_access(hr, "ANNA ")
    assert bases.can_access(hr, "chef")
    assert not bases.can_access(hr, "bob")
    assert not bases.can_access(hr, None), "no known user must fail closed"
    assert bases.can_access(bases.get_base("technik"), None)
    assert bases.blocked_ids("bob") == {"hr"}
    assert bases.blocked_ids("anna") == set()
    assert bases.describe(hr, with_counts=False)["access"]["restricted"] is True


def test_unrestricting_opens_the_base_again(bases):
    bases.update_base("hr", access={"restricted": False, "users": []})
    assert bases.can_access(bases.get_base("hr"), "bob")


class _Manager:
    healthy = True

    def __init__(self, name):
        self.name = name

    def search(self, query, **kwargs):
        return [
            {
                "id": f"{self.name}-1",
                "document": f"{self.name} Reisekosten Erstattung Regeln",
                "metadata": {"filename": f"{self.name}.md", "source": f"/{self.name}.md"},
                "similarity": 0.9,
                "rerank_score": 0.9,
            }
        ]

    def list_documents(self, **kwargs):
        return [{"source": f"/{self.name}.md", "filename": f"{self.name}.md", "chunks": 1}]


def test_chat_retrieval_only_searches_accessible_bases(bases, monkeypatch):
    import src.rag_singleton as singleton
    from src.chat_processor import ChatProcessor

    searched = []

    def manager_for(base_id=None, **kwargs):
        searched.append(base_id)
        return _Manager(base_id)

    monkeypatch.setattr(singleton, "get_rag_manager", manager_for)
    monkeypatch.setattr(ChatProcessor, "_rag_cfg", lambda self: {})

    ChatProcessor(None).retrieve("Reisekosten Erstattung", user="bob")
    assert "hr" not in searched and "technik" in searched
    searched.clear()
    ChatProcessor(None).retrieve("Reisekosten Erstattung", user="anna")
    assert "hr" in searched
    searched.clear()
    ChatProcessor(None).retrieve("Reisekosten Erstattung")
    assert "hr" not in searched


def test_knowledge_navigation_hides_restricted_documents(bases, monkeypatch):
    import src.rag_navigate as nav
    import src.rag_singleton as singleton

    monkeypatch.setattr(singleton, "get_rag_manager", lambda base_id=None, **kw: _Manager(base_id))
    monkeypatch.setattr(nav, "_doc_cache", {})
    assert "hr.md" not in nav.list_knowledge("", user="bob")
    assert "hr.md" in nav.list_knowledge("", user="anna")
    with pytest.raises(nav.NavigationError):
        nav.resolve_document("hr.md", user="bob")
    base, _, row = nav.resolve_document("hr.md", user="anna")
    assert base["id"] == "hr" and row["filename"] == "hr.md"


def test_mcp_token_owner_cannot_name_a_restricted_base(bases, monkeypatch):
    from src import mcp_public, mcp_settings

    monkeypatch.setattr(mcp_settings, "tool_enabled", lambda name: True)
    monkeypatch.setattr(mcp_settings, "rag_bases", lambda: None)
    monkeypatch.setattr(mcp_public, "_tool_rag_query", lambda args: f"searched {args}")
    granted = {mcp_public.scope_for_tool("rag_query")}

    text, is_error = mcp_public.call_tool(
        "rag_query", {"query": "x", "collections": ["hr"]}, granted_scopes=granted, owner="bob"
    )
    assert is_error and "hr" in text
    text, is_error = mcp_public.call_tool(
        "rag_query", {"query": "x", "collections": ["hr"]}, granted_scopes=granted, owner="anna"
    )
    assert not is_error, text
