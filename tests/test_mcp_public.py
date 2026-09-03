"""Tests for the outward-facing MCP server (src/mcp_public.py + /mcp route).

No server and no Qdrant: the RAG manager and SkillsManager are faked, and the
JSON-RPC handler is driven directly with a stub request. What matters here is
the contract an external MCP client sees — scope gating, tool-error shape, and
JSON-RPC framing.
"""

import asyncio
import types

import pytest

from src import mcp_public

RAG = mcp_public.SCOPE_RAG_READ
SKILLS = mcp_public.SCOPE_SKILLS_READ
WEB = mcp_public.SCOPE_WEB_READ
BOTH = {RAG, SKILLS}
ALL = {RAG, SKILLS, WEB}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeRag:
    healthy = True

    def __init__(self, results=None, documents=None, chunks=None):
        self._results = results if results is not None else []
        self._documents = documents if documents is not None else []
        self._chunks = chunks if chunks is not None else []
        self.search_calls = []
        self.list_calls = []

    def search(self, query, k=5, owner=None, candidate_k=None, scope=None, exclude_scopes=None):
        self.search_calls.append(
            {
                "query": query,
                "k": k,
                "owner": owner,
                "candidate_k": candidate_k,
                "scope": scope,
                "exclude_scopes": exclude_scopes,
            }
        )
        return self._results

    def list_documents(self, scope=None, exclude_scopes=None):
        self.list_calls.append({"scope": scope, "exclude_scopes": exclude_scopes})
        return self._documents

    def get_document_chunks(self, source):
        return self._chunks


class FakeSkills:
    def __init__(self, index=None, skills=None, md=None, refs=None):
        self._index = index if index is not None else []
        self._skills = skills if skills is not None else []
        self._md = md or {}
        self._refs = refs or {}
        self.owners_seen = []

    def index_for(self, owner=None, **kwargs):
        self.owners_seen.append(owner)
        return self._index

    def load(self, owner=None):
        self.owners_seen.append(owner)
        return self._skills

    def get_relevant_skills(self, query, skills=None, max_items=5, published_only=False, **kw):
        self.last_published_only = published_only
        self.last_max_items = max_items
        return (skills or self._skills)[:max_items]

    def read_skill_md(self, name, owner=None):
        return self._md.get(name)

    def read_skill_reference(self, name, ref_path, owner=None):
        return self._refs.get((name, ref_path))


@pytest.fixture
def fake_rag(monkeypatch):
    rag = FakeRag()
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})
    return rag


def call(name, args, scopes=ALL, owner=None, sm=None):
    return mcp_public.call_tool(name, args, granted_scopes=scopes, owner=owner, skills_manager=sm)


# ---------------------------------------------------------------------------
# Scope gating
# ---------------------------------------------------------------------------


def test_list_tools_filters_by_scope():
    # An empty skills manager, so the per-skill tools (which are per-owner and
    # would otherwise be read off this machine's disk) don't make this flaky.
    empty = FakeSkills(index=[])
    rag_only = {t["name"] for t in mcp_public.list_tools({RAG}, skills_manager=empty)}
    skills_only = {t["name"] for t in mcp_public.list_tools({SKILLS}, skills_manager=empty)}
    web_only = {t["name"] for t in mcp_public.list_tools({WEB}, skills_manager=empty)}

    assert rag_only == {
        "rag_query",
        "rag_list_collections",
        "rag_list_documents",
        "rag_get_document",
    }
    assert skills_only == {
        "skills_list",
        "skills_search",
        "skills_get",
        "skills_read_reference",
    }
    assert web_only == {"web_search", "web_fetch"}
    assert rag_only.isdisjoint(skills_only) and web_only.isdisjoint(rag_only | skills_only)
    assert mcp_public.list_tools(set()) == []


def test_web_scope_is_independent_of_the_knowledge_scopes():
    """A knowledge token must not come with a route to the public internet."""
    assert {
        t["name"] for t in mcp_public.list_tools({RAG, SKILLS}, skills_manager=FakeSkills(index=[]))
    }.isdisjoint({"web_search", "web_fetch"})


def test_list_tools_strips_internal_scope_metadata():
    for tool in mcp_public.list_tools(ALL, skills_manager=FakeSkills(index=[])):
        assert "_scope" not in tool
        assert set(tool) <= {"name", "title", "description", "inputSchema"}
        assert tool["inputSchema"]["type"] == "object"


def test_call_tool_refuses_out_of_scope_tool(fake_rag):
    text, is_error = call("rag_query", {"query": "x"}, scopes={SKILLS})
    assert is_error is True
    assert "rag:read" in text
    # The tool must not have run at all.
    assert fake_rag.search_calls == []


def test_call_tool_rejects_unknown_tool():
    text, is_error = call("rag_delete_everything", {}, scopes=BOTH)
    assert is_error is True
    assert "Unknown tool" in text


def test_scopes_match_the_mintable_token_scopes():
    """A scope this module gates on must be one the token routes can issue."""
    from routes.api_token_routes import ALLOWED_SCOPES, TOKEN_PROFILES

    assert ALL <= ALLOWED_SCOPES
    assert set(TOKEN_PROFILES["mcp"]) == {RAG, SKILLS}
    assert set(TOKEN_PROFILES["mcp_web"]) == ALL


# ---------------------------------------------------------------------------
# RAG tools
# ---------------------------------------------------------------------------


def test_rag_query_excludes_the_sql_namespace_by_default(fake_rag):
    call("rag_query", {"query": "urlaubsantrag"})
    assert fake_rag.search_calls[0]["exclude_scopes"] == ["sql"]
    assert fake_rag.search_calls[0]["scope"] is None


def test_rag_query_with_explicit_scope_drops_the_default_exclusion(fake_rag):
    """The tool body's own contract, which the REST service shares.

    Whether an *MCP* caller may name a scope at all is a separate question,
    answered by `mcp_rag_allowed_scopes` — see tests/test_mcp_settings.py.
    """
    mcp_public._tool_rag_query({"query": "schema", "scope": "sql"})
    assert fake_rag.search_calls[0]["scope"] == "sql"
    assert fake_rag.search_calls[0]["exclude_scopes"] is None


# 99 lands on 10, not 20: `mcp_rag_max_results` caps an MCP caller before
# `_clamp_k`'s own 1–20 bound is reached. Pinned to the shipped default rather
# than read from this machine's settings.json.
@pytest.mark.parametrize("requested,expected", [(0, 1), (99, 10), (7, 7), ("nonsense", 5)])
def test_rag_query_clamps_k(fake_rag, monkeypatch, requested, expected):
    monkeypatch.setattr("src.mcp_settings.rag_max_results", lambda: 10)
    call("rag_query", {"query": "q", "k": requested})
    assert fake_rag.search_calls[-1]["k"] == expected


def test_rag_query_requires_a_query(fake_rag):
    text, is_error = call("rag_query", {"query": "   "})
    assert is_error is True
    assert "query" in text
    assert fake_rag.search_calls == []


def test_rag_query_formats_hits_with_source_and_score(monkeypatch):
    rag = FakeRag(
        results=[
            {
                "document": "Der Urlaubsantrag geht an die Personalabteilung.",
                "similarity": 0.71,
                "rerank_score": 0.93,
                "metadata": {
                    "source": "/data/hr/handbuch.pdf",
                    "filename": "handbuch.pdf",
                    "page": 12,
                },
            }
        ]
    )
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})

    text, is_error = call("rag_query", {"query": "urlaub"})
    assert is_error is False
    assert "handbuch.pdf" in text
    assert "page 12" in text
    assert "/data/hr/handbuch.pdf" in text
    # The reranker ordered this, so its score is the one shown.
    assert "rerank: 0.9300" in text
    assert "Personalabteilung" in text


def test_rag_query_returns_the_whole_section_not_a_snippet(monkeypatch):
    """One call has to be enough.

    The retrieval pipeline attaches the matched chunk's whole section as
    ``expanded`` (small-to-big). Rendering the chunk alone forced every caller
    into a second rag_get_document round trip.
    """
    section = "Abschnitt 4.2 — " + ("Urlaub muss schriftlich beantragt werden. " * 40)
    rag = FakeRag(
        results=[
            {
                "document": "Urlaub muss schriftlich beantragt werden.",
                "expanded": section,
                "rerank_score": 0.9,
                "metadata": {"source": "/data/hr.pdf", "filename": "hr.pdf"},
            }
        ]
    )
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})

    text, is_error = call("rag_query", {"query": "urlaub"})
    assert is_error is False
    assert "Abschnitt 4.2" in text
    assert len(text) > mcp_public.SNIPPET_CHARS
    assert "full section" in text


def test_rag_query_passage_budget_shrinks_as_hits_grow(monkeypatch):
    """Twenty long hits must still fit inside the per-tool output budget."""
    long_text = "x" * 20_000
    rag = FakeRag(
        results=[
            {
                "document": long_text,
                "rerank_score": 0.5,
                "metadata": {"source": f"/data/{i}.pdf", "filename": f"{i}.pdf"},
            }
            for i in range(20)
        ]
    )
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})

    text, is_error = call("rag_query", {"query": "q", "topK": 20})
    assert is_error is False
    # Every hit is represented — none dropped off the end by the outer cap.
    assert "19.pdf" in text
    # Inside the per-tool budget, so the outer cap never had to cut the tail.
    assert len(text) <= mcp_public.MAX_TEXT_CHARS


def test_rag_query_accepts_topk_as_well_as_k(fake_rag):
    call("rag_query", {"query": "q", "topK": 9})
    assert fake_rag.search_calls[-1]["k"] == 9


def test_rag_search_is_still_accepted_as_the_old_name(fake_rag):
    """A client with the pre-rename name in its config keeps working, even
    though the catalogue no longer advertises it."""
    text, is_error = call("rag_search", {"query": "q"})
    assert is_error is False
    assert fake_rag.search_calls
    listed = {t["name"] for t in mcp_public.list_tools({RAG}, skills_manager=FakeSkills(index=[]))}
    assert "rag_search" not in listed


def test_rag_query_searches_every_named_collection_and_merges_by_score(monkeypatch):
    calls = []

    def fake_rag_for(cid=None):
        rag = FakeRag(
            results=[
                {
                    "document": f"treffer aus {cid}",
                    "rerank_score": 0.9 if cid == "technik" else 0.4,
                    "metadata": {"source": f"/data/{cid}.pdf", "filename": f"{cid}.pdf"},
                }
            ]
        )
        calls.append(cid)
        return rag

    monkeypatch.setattr(mcp_public, "_rag", fake_rag_for)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})
    monkeypatch.setattr(mcp_public, "_known_collection_ids", lambda: ["hr", "technik"])

    text, is_error = call("rag_query", {"query": "q", "collections": ["hr", "technik"]})
    assert is_error is False
    assert calls == ["hr", "technik"]
    # Merged across bases by score, and each hit says where it came from — the
    # id rag_get_document needs.
    assert text.index("technik.pdf") < text.index("hr.pdf")
    assert "collection: `technik`" in text


def test_rag_query_names_the_real_collections_when_one_is_unknown(monkeypatch):
    monkeypatch.setattr(mcp_public, "_known_collection_ids", lambda: ["hr", "technik"])
    text, is_error = call("rag_query", {"query": "q", "collections": ["tippfehler"]})
    assert is_error is True
    assert "tippfehler" in text and "hr" in text and "technik" in text


def test_rag_query_survives_one_unreachable_collection(monkeypatch):
    def maybe_rag(cid=None):
        if cid == "kaputt":
            return None
        return FakeRag(
            results=[
                {
                    "document": "treffer",
                    "rerank_score": 0.8,
                    "metadata": {"source": "/data/hr.pdf", "filename": "hr.pdf"},
                }
            ]
        )

    monkeypatch.setattr(mcp_public, "_rag", maybe_rag)
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})
    monkeypatch.setattr(mcp_public, "_known_collection_ids", lambda: ["hr", "kaputt"])

    text, is_error = call("rag_query", {"query": "q", "collections": ["hr", "kaputt"]})
    assert is_error is False
    assert "hr.pdf" in text
    assert "kaputt" in text  # the caller is told what was skipped


def test_rag_get_document_reads_from_the_named_collection(monkeypatch):
    seen = []

    def fake_rag_for(cid=None):
        seen.append(cid)
        return FakeRag(chunks=[{"content": "inhalt"}])

    monkeypatch.setattr(mcp_public, "_rag", fake_rag_for)
    monkeypatch.setattr(mcp_public, "_known_collection_ids", lambda: ["technik"])

    text, is_error = call("rag_get_document", {"source": "/data/x.pdf", "collection": "technik"})
    assert is_error is False
    assert seen == ["technik"]


def test_rag_query_reports_an_empty_index_without_erroring(fake_rag):
    text, is_error = call("rag_query", {"query": "nichts"})
    assert is_error is False
    assert "No passages found" in text


def test_rag_tools_report_an_unavailable_index_as_a_tool_error(monkeypatch):
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: None)
    monkeypatch.setattr(mcp_public, "_rag_unavailable_text", lambda: "KB down (qdrant refused)")

    for tool, args in [
        ("rag_query", {"query": "q"}),
        ("rag_list_documents", {}),
        ("rag_get_document", {"source": "/x"}),
    ]:
        text, is_error = call(tool, args)
        assert is_error is True, tool
        assert "qdrant refused" in text, tool


def test_rag_list_documents_filters_case_insensitively(monkeypatch):
    rag = FakeRag(
        documents=[
            {"filename": "Handbuch.pdf", "source": "/data/Handbuch.pdf", "chunks": 12},
            {"filename": "preisliste.xlsx", "source": "/data/preisliste.xlsx", "chunks": 3},
        ]
    )
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)

    text, is_error = call("rag_list_documents", {"filter": "handbuch"})
    assert is_error is False
    assert "Handbuch.pdf" in text
    assert "preisliste" not in text


def test_rag_get_document_rejects_an_unindexed_source(monkeypatch):
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: FakeRag(chunks=[]))
    text, is_error = call("rag_get_document", {"source": "/etc/passwd"})
    assert is_error is True
    assert "No indexed document" in text


def test_rag_get_document_joins_chunks_in_order(monkeypatch):
    rag = FakeRag(chunks=[{"content": "erster teil"}, {"content": "zweiter teil"}])
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)

    text, is_error = call("rag_get_document", {"source": "/data/doc.pdf"})
    assert is_error is False
    assert text.index("erster teil") < text.index("zweiter teil")


def test_rag_get_document_notes_when_chunks_are_capped(monkeypatch):
    rag = FakeRag(chunks=[{"content": f"chunk {i}"} for i in range(10)])
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)

    text, _ = call("rag_get_document", {"source": "/data/doc.pdf", "max_chunks": 3})
    assert "Showing 3 of 10 chunks" in text
    assert "chunk 9" not in text


def test_tool_output_is_truncated(monkeypatch):
    rag = FakeRag(chunks=[{"content": "x" * (mcp_public.MAX_TEXT_CHARS * 2)}])
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: rag)

    text, is_error = call("rag_get_document", {"source": "/data/big.pdf"})
    assert is_error is False
    assert "truncated" in text
    assert len(text) < mcp_public.MAX_TEXT_CHARS * 1.1


def test_unexpected_tool_exception_becomes_a_tool_error(monkeypatch):
    def boom(*_):
        raise RuntimeError("qdrant exploded")

    monkeypatch.setattr(mcp_public, "_rag", boom)
    text, is_error = call("rag_query", {"query": "q"})
    assert is_error is True
    assert "RuntimeError" in text


# ---------------------------------------------------------------------------
# Skills tools
# ---------------------------------------------------------------------------


def test_skills_list_uses_the_token_owner():
    sm = FakeSkills(index=[{"name": "deploy", "description": "Ship it", "category": "ops"}])
    text, is_error = call("skills_list", {}, owner="moritz", sm=sm)

    assert is_error is False
    assert sm.owners_seen == ["moritz"]
    assert "deploy" in text and "ops" in text


def test_skills_list_explains_an_empty_result_by_owner():
    text, is_error = call("skills_list", {}, owner="moritz", sm=FakeSkills(index=[]))
    assert is_error is False
    assert "moritz" in text  # tells the caller *why* it's empty


def test_skills_list_filters_by_category():
    sm = FakeSkills(
        index=[
            {"name": "deploy", "description": "", "category": "ops"},
            {"name": "invoice", "description": "", "category": "finance"},
        ]
    )
    text, _ = call("skills_list", {"category": "finance"}, sm=sm)
    assert "invoice" in text
    assert "deploy" not in text


def test_skills_search_never_returns_drafts():
    sm = FakeSkills(skills=[{"name": "x", "description": "d", "procedure": ["a", "b"]}])
    text, is_error = call("skills_search", {"query": "how do i x"}, sm=sm)

    assert is_error is False
    # published_only is the guard that keeps unreviewed procedures away from a
    # model that will follow them as proven.
    assert sm.last_published_only is True
    assert "a → b" in text


def test_skills_search_requires_a_query():
    text, is_error = call("skills_search", {"query": ""}, sm=FakeSkills())
    assert is_error is True
    assert "query" in text


def test_skills_get_returns_the_markdown():
    sm = FakeSkills(md={"deploy": "# deploy\n\nSteps..."})
    text, is_error = call("skills_get", {"name": "deploy"}, sm=sm)
    assert is_error is False
    assert text.startswith("# deploy")


def test_skills_get_reports_a_missing_skill():
    text, is_error = call("skills_get", {"name": "nope"}, sm=FakeSkills())
    assert is_error is True
    assert "nope" in text


def test_skills_read_reference_returns_the_file():
    sm = FakeSkills(refs={("deploy", "references/check.md"): "checklist"})
    text, is_error = call(
        "skills_read_reference", {"name": "deploy", "path": "references/check.md"}, sm=sm
    )
    assert is_error is False
    assert text == "checklist"


def test_skills_read_reference_refuses_traversal():
    """SkillsManager returns None for anything outside the skill dir."""
    text, is_error = call(
        "skills_read_reference",
        {"name": "deploy", "path": "../../../.env"},
        sm=FakeSkills(refs={}),
    )
    assert is_error is True
    assert ".env" not in text or "No reference" in text


# ---------------------------------------------------------------------------
# Per-skill tools
# ---------------------------------------------------------------------------
# One MCP tool per published skill, so a client that gates tools by name can
# hand a role its skills through the tool list itself.


def _sm_with(*names):
    return FakeSkills(
        index=[{"name": n, "description": f"{n} beschreibung", "category": "ops"} for n in names],
        skills=[{"name": n, "when_to_use": f"wenn {n}"} for n in names],
        md={n: f"# {n}\n\nSchritte..." for n in names},
    )


def test_each_published_skill_becomes_its_own_tool():
    tools = mcp_public.list_tools({SKILLS}, owner="moritz", skills_manager=_sm_with("deploy"))
    by_name = {t["name"]: t for t in tools}

    assert "skill_deploy" in by_name
    tool = by_name["skill_deploy"]
    assert "deploy beschreibung" in tool["description"]
    assert "wenn deploy" in tool["description"]
    # A skill is a procedure to follow, not something Talos executes — the
    # description has to say so or the model waits for side effects.
    assert "own tools" in tool["description"]
    assert tool["inputSchema"] == {"type": "object", "properties": {}}


def test_calling_a_skill_tool_returns_that_skills_markdown():
    text, is_error = call("skill_deploy", {}, owner="moritz", sm=_sm_with("deploy"))
    assert is_error is False
    assert text.startswith("# deploy")


def test_skill_tools_need_the_skills_scope():
    tools = mcp_public.list_tools({RAG}, skills_manager=_sm_with("deploy"))
    assert not any(t["name"].startswith("skill_") for t in tools)

    text, is_error = call("skill_deploy", {}, scopes={RAG}, sm=_sm_with("deploy"))
    assert is_error is True
    assert "skills:read" in text


def test_a_skill_tool_this_caller_cannot_see_is_an_unknown_tool():
    """Never 'permission denied' — a name that was never offered to this token
    must not confirm that the skill exists somewhere else."""
    text, is_error = call("skill_geheim", {}, owner="moritz", sm=_sm_with("deploy"))
    assert is_error is True
    assert "Unknown tool" in text


def test_skill_tool_names_are_sanitised_and_collision_free():
    tools = mcp_public.list_tools(
        {SKILLS}, skills_manager=_sm_with("Rechnung prüfen", "rechnung-prüfen")
    )
    names = [t["name"] for t in tools if t["name"].startswith("skill_")]
    assert len(names) == len(set(names))  # a name can only mean one skill
    # Safe as an identifier in any client: ASCII alphanumerics, - and _ only.
    assert all((c.isalnum() and c.isascii()) or c in "-_" for name in names for c in name), names


def test_the_skill_tool_list_is_capped(monkeypatch):
    monkeypatch.setattr(mcp_public, "MAX_SKILL_TOOLS", 3)
    tools = mcp_public.list_tools(
        {SKILLS}, skills_manager=_sm_with(*[f"skill{i}" for i in range(10)])
    )
    assert len([t for t in tools if t["name"].startswith("skill_")]) == 3


def test_skill_tools_disappear_when_skills_are_switched_off(monkeypatch):
    from src import mcp_settings

    monkeypatch.setattr(mcp_settings, "skills_enabled", lambda: False)
    tools = mcp_public.list_tools({SKILLS}, skills_manager=_sm_with("deploy"))
    assert tools == []

    text, is_error = call("skill_deploy", {}, sm=_sm_with("deploy"))
    assert is_error is True
    assert "disabled" in text


def test_a_gated_skill_gets_no_tool(monkeypatch):
    """The administrator's MCP skill allowlist narrows the tool list too."""
    monkeypatch.setattr(mcp_public, "_skill_filter", lambda: (lambda name: name != "geheim"))
    tools = mcp_public.list_tools({SKILLS}, skills_manager=_sm_with("deploy", "geheim"))
    names = {t["name"] for t in tools}
    assert "skill_deploy" in names
    assert "skill_geheim" not in names


# ---------------------------------------------------------------------------
# Web tools
# ---------------------------------------------------------------------------
# src.web_search is patched wholesale: these tests assert the marshalling and
# error mapping this module owns, never SearxNG or the network.


@pytest.fixture
def fake_web(monkeypatch):
    """Stand in for src.web_search, recording how it was called."""
    import sys

    calls = {"search": [], "fetch": []}

    async def _search(**kwargs):
        calls["search"].append(kwargs)
        return calls.get("search_result", {"results": "Web search: results here"})

    async def _fetch(**kwargs):
        calls["fetch"].append(kwargs)
        return calls.get("fetch_result", {"results": "Fetched: page text"})

    module = types.SimpleNamespace(
        search=_search,
        fetch=_fetch,
        DEFAULT_RESULTS=6,
        DEFAULT_FETCH_CHARS=8_000,
        MAX_FETCH_CHARS=20_000,
    )
    monkeypatch.setitem(sys.modules, "src.web_search", module)
    return calls


def test_web_search_passes_arguments_through(fake_web):
    text, is_error = call(
        "web_search",
        {
            "query": "dgx spark vllm",
            "max_results": 3,
            "language": "de",
            "category": "news",
            "time_range": "week",
            "page": 2,
        },
    )
    assert is_error is False
    assert "results here" in text

    sent = fake_web["search"][0]
    assert sent["query"] == "dgx spark vllm"
    assert sent["max_results"] == 3
    assert sent["language"] == "de"
    assert sent["category"] == "news"
    assert sent["time_range"] == "week"
    assert sent["page"] == 2


def test_web_search_sends_no_session_to_the_leak_guard(fake_web):
    """An MCP caller has no Talos chat session, so there's no context to leak."""
    call("web_search", {"query": "wetter berlin"})
    assert fake_web["search"][0]["session_id"] == ""


def test_web_search_defaults_are_left_to_the_backend(fake_web):
    call("web_search", {"query": "q"})
    sent = fake_web["search"][0]
    assert sent["max_results"] == 6
    assert sent["page"] == 1
    assert sent["language"] == "" and sent["category"] == "" and sent["time_range"] == ""


@pytest.mark.parametrize("requested,expected", [(0, 6), (99, 20), (5, 5), ("nope", 6)])
def test_web_search_clamps_max_results(fake_web, requested, expected):
    call("web_search", {"query": "q", "max_results": requested})
    assert fake_web["search"][-1]["max_results"] == expected


def test_web_search_requires_a_query(fake_web):
    text, is_error = call("web_search", {"query": "  "})
    assert is_error is True
    assert "query" in text
    assert fake_web["search"] == []


def test_web_search_maps_a_backend_error_to_a_tool_error(fake_web):
    fake_web["search_result"] = {
        "error": "SearxNG is not reachable at http://searxng:8080",
        "exit_code": 1,
    }
    text, is_error = call("web_search", {"query": "q"})
    assert is_error is True
    assert "not reachable" in text


def test_web_search_surfaces_a_domain_policy_refusal(fake_web):
    """The admin's allow/deny list is enforced in web_search, not here."""
    fake_web["search_result"] = {"results": "All 8 result(s) were removed by the administrator"}
    text, is_error = call("web_search", {"query": "q"})
    assert is_error is False
    assert "removed by the administrator" in text


def test_web_fetch_passes_url_and_clamps_max_chars(fake_web):
    text, is_error = call("web_fetch", {"url": "https://example.org", "max_chars": 999_999})
    assert is_error is False
    assert "page text" in text
    assert fake_web["fetch"][0]["url"] == "https://example.org"
    assert fake_web["fetch"][0]["max_chars"] == 20_000


def test_web_fetch_falls_back_to_the_default_char_budget(fake_web):
    call("web_fetch", {"url": "https://example.org"})
    assert fake_web["fetch"][0]["max_chars"] == 8_000


def test_web_fetch_requires_a_url(fake_web):
    text, is_error = call("web_fetch", {"url": ""})
    assert is_error is True
    assert "url" in text
    assert fake_web["fetch"] == []


def test_web_fetch_maps_an_ssrf_refusal_to_a_tool_error(fake_web):
    """The SSRF guard lives in web_search.fetch; we must not swallow it."""
    fake_web["fetch_result"] = {
        "error": "http://192.168.10.91:6333 resolves to a private address.",
        "exit_code": 1,
    }
    text, is_error = call("web_fetch", {"url": "http://192.168.10.91:6333"})
    assert is_error is True
    assert "private address" in text


def test_web_tools_are_scope_gated(fake_web):
    for tool, args in [("web_search", {"query": "q"}), ("web_fetch", {"url": "https://x.org"})]:
        text, is_error = call(tool, args, scopes=BOTH)
        assert is_error is True, tool
        assert "web:read" in text, tool
    assert fake_web["search"] == [] and fake_web["fetch"] == []


def test_web_tool_output_is_truncated(fake_web):
    fake_web["fetch_result"] = {"results": "y" * (mcp_public.MAX_TEXT_CHARS * 2)}
    text, is_error = call("web_fetch", {"url": "https://example.org"})
    assert is_error is False
    assert "truncated" in text


def test_run_async_works_from_inside_a_running_loop(fake_web):
    """call_tool is sync, but a caller may reach it from async code."""

    async def _outer():
        return call("web_search", {"query": "q"})

    text, is_error = asyncio.run(_outer())
    assert is_error is False
    assert "results here" in text


# ---------------------------------------------------------------------------
# JSON-RPC layer
# ---------------------------------------------------------------------------


def _request(*, api_token=True, scopes=(RAG, SKILLS, WEB), owner="moritz", user=None):
    """A stub carrying only what _caller_context reads off request.state."""
    state = types.SimpleNamespace(
        api_token=api_token,
        api_token_scopes=list(scopes),
        api_token_owner=owner,
        api_token_id="tok123",
    )
    if user is not None:
        state.current_user = user
    return types.SimpleNamespace(state=state)


def handle(message, request=None, sm=None):
    from routes.mcp_public_routes import _handle_message

    return asyncio.run(_handle_message(message, request or _request(), sm))


def test_initialize_echoes_a_supported_protocol_version():
    from routes.mcp_public_routes import SUPPORTED_PROTOCOL_VERSIONS

    for version in SUPPORTED_PROTOCOL_VERSIONS:
        out = handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": version},
            }
        )
        assert out["result"]["protocolVersion"] == version


def test_initialize_falls_back_for_an_unknown_protocol_version():
    from routes.mcp_public_routes import LATEST_PROTOCOL_VERSION

    out = handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "1999-01-01"},
        }
    )
    assert out["result"]["protocolVersion"] == LATEST_PROTOCOL_VERSION
    assert out["result"]["capabilities"]["tools"] == {"listChanged": False}
    assert out["result"]["serverInfo"]["name"] == "talos"


def test_notifications_get_no_response():
    assert handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_ping_returns_an_empty_result():
    out = handle({"jsonrpc": "2.0", "id": "p", "method": "ping"})
    assert out == {"jsonrpc": "2.0", "id": "p", "result": {}}


def test_tools_list_reflects_the_tokens_scopes():
    out = handle(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        request=_request(scopes=(SKILLS,)),
        sm=FakeSkills(index=[]),
    )
    names = {t["name"] for t in out["result"]["tools"]}
    assert names == {"skills_list", "skills_search", "skills_get", "skills_read_reference"}


def test_tools_list_carries_the_per_skill_tools(monkeypatch):
    """The route has to hand the catalogue the caller's owner and manager —
    without them the skill tools silently vanish from the palette."""
    sm = _sm_with("deploy")
    out = handle(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        request=_request(scopes=(SKILLS,), owner="moritz"),
        sm=sm,
    )
    assert "skill_deploy" in {t["name"] for t in out["result"]["tools"]}
    assert "moritz" in sm.owners_seen


def test_a_skill_tool_is_callable_over_jsonrpc():
    out = handle(
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "skill_deploy", "arguments": {}},
        },
        sm=_sm_with("deploy"),
    )
    assert out["result"]["isError"] is False
    assert out["result"]["content"][0]["text"].startswith("# deploy")


def test_a_browser_session_gets_the_full_read_catalogue():
    sm = FakeSkills(index=[])
    out = handle(
        {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
        request=_request(api_token=False, user="moritz"),
        sm=sm,
    )
    assert len(out["result"]["tools"]) == len(
        mcp_public.list_tools(ALL, owner="moritz", skills_manager=sm)
    )


def test_tools_call_wraps_output_in_mcp_content(monkeypatch):
    monkeypatch.setattr(mcp_public, "_rag", lambda *_: FakeRag(results=[]))
    monkeypatch.setattr(mcp_public, "_search_config", lambda *_: {})

    out = handle(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "rag_query", "arguments": {"query": "hallo"}},
        }
    )
    result = out["result"]
    assert result["isError"] is False
    assert result["content"][0]["type"] == "text"
    assert "No passages found" in result["content"][0]["text"]


def test_a_failing_tool_is_a_successful_call_with_isError():
    """MCP models tool failure as isError, not as a JSON-RPC error."""
    out = handle(
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "skills_get", "arguments": {"name": "ghost"}},
        },
        sm=FakeSkills(),
    )
    assert "error" not in out
    assert out["result"]["isError"] is True


def test_tools_call_without_a_name_is_a_jsonrpc_error():
    out = handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {}})
    assert out["error"]["code"] == -32602


def test_unknown_method_is_method_not_found():
    out = handle({"jsonrpc": "2.0", "id": 7, "method": "completion/complete"})
    assert out["error"]["code"] == -32601


def test_non_jsonrpc_message_is_rejected():
    out = handle({"id": 8, "method": "tools/list"})
    assert out["error"]["code"] == -32600


@pytest.mark.parametrize(
    "method,key",
    [
        ("resources/list", "resources"),
        ("resources/templates/list", "resourceTemplates"),
        ("prompts/list", "prompts"),
    ],
)
def test_unadvertised_capabilities_return_empty_lists(method, key):
    out = handle({"jsonrpc": "2.0", "id": 9, "method": method})
    assert out["result"][key] == []
