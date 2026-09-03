"""Tests for the outward-MCP policy layer (src/mcp_settings.py).

The question under test throughout: can an administrator hold an external MCP
client to a *different* policy than the browser agent — and does the tool layer
actually honour that separation, both when listing tools and when running them.

Settings are faked at `src.settings.get_setting`, which is where
`mcp_settings._get` reads from, so nothing touches data/settings.json.
"""

import pytest

from src import mcp_public, mcp_settings, web_search

WEB = mcp_public.SCOPE_WEB_READ
SKILLS = mcp_public.SCOPE_SKILLS_READ
RAG = mcp_public.SCOPE_RAG_READ
ALL = {RAG, SKILLS, WEB}


@pytest.fixture
def settings(monkeypatch):
    """Override individual settings; everything else keeps its default."""
    values = {}

    def fake_get_setting(key, default=None):
        return values.get(key, default)

    monkeypatch.setattr("src.settings.get_setting", fake_get_setting)
    return values


class FakeSkills:
    def __init__(self, index=None, md=None):
        self._index = index or []
        self._md = md or {}

    def index_for(self, owner=None, **kwargs):
        return self._index

    def load(self, owner=None):
        return self._index

    def get_relevant_skills(self, query, skills=None, max_items=5, published_only=False, **kw):
        return (skills or [])[:max_items]

    def read_skill_md(self, name, owner=None):
        return self._md.get(name)

    def read_skill_reference(self, name, ref_path, owner=None):
        return "ref body"


def call(name, args, scopes=ALL, owner=None, sm=None):
    return mcp_public.call_tool(name, args, granted_scopes=scopes, owner=owner, skills_manager=sm)


# ---------------------------------------------------------------------------
# Web policy
# ---------------------------------------------------------------------------


def test_web_policy_is_none_while_inheriting(settings):
    # None is the signal web_search reads as "use the admin settings" — an
    # empty dict there would silently drop the admin's domain lists.
    assert mcp_settings.web_policy() is None


def test_web_policy_carries_the_mcp_lists_when_not_inheriting(settings):
    settings.update(
        {
            "mcp_web_inherit": False,
            "mcp_web_searxng_url": "http://searx.internal:8080/",
            "mcp_web_domain_allowlist": ["docs.python.org"],
            "mcp_web_domain_blocklist": ["pastebin.com"],
        }
    )
    policy = mcp_settings.web_policy()

    assert policy == {
        "searxng_url": "http://searx.internal:8080/",
        "allowlist": ["docs.python.org"],
        "blocklist": ["pastebin.com"],
    }


def test_mcp_policy_replaces_the_web_ui_domain_lists(settings):
    """The separation that the whole feature exists for."""
    settings.update(
        {
            # What the browser agent is held to:
            "web_domain_allowlist": ["intranet.example"],
            # What MCP callers are held to:
            "mcp_web_inherit": False,
            "mcp_web_domain_allowlist": ["docs.python.org"],
        }
    )
    policy = mcp_settings.web_policy()

    assert web_search.check_domain("docs.python.org", policy) is None
    assert web_search.check_domain("intranet.example", policy) is not None
    # …and the web UI's own policy is untouched by any of it.
    assert web_search.check_domain("intranet.example") is None


def test_inherited_policy_still_applies_the_web_ui_lists(settings):
    settings["web_domain_blocklist"] = ["pastebin.com"]
    policy = mcp_settings.web_policy()  # None — inheriting

    assert web_search.check_domain("pastebin.com", policy) is not None


def test_mcp_searxng_url_overrides_the_admin_instance(settings):
    settings.update({"searxng_url": "http://ui:8080", "mcp_web_searxng_url": "http://mcp:8080"})

    assert web_search.get_searxng_url() == "http://ui:8080"
    assert web_search.get_searxng_url({"searxng_url": "http://mcp:8080"}) == "http://mcp:8080"


@pytest.mark.parametrize(
    "configured,expected",
    [(None, 6), (12, 12), (0, 1), (999, 20), ("nonsense", 6)],
)
def test_web_max_results_is_clamped(settings, configured, expected):
    if configured is not None:
        settings["mcp_web_max_results"] = configured
    assert mcp_settings.web_max_results() == expected


@pytest.mark.parametrize(
    "configured,expected",
    [(None, 8000), (12000, 12000), (10, 500), (99999, 20000)],
)
def test_web_max_fetch_chars_is_clamped(settings, configured, expected):
    if configured is not None:
        settings["mcp_web_max_fetch_chars"] = configured
    assert mcp_settings.web_max_fetch_chars() == expected


# ---------------------------------------------------------------------------
# Tool availability
# ---------------------------------------------------------------------------


def test_tools_are_all_offered_by_default(settings):
    # Empty skills manager: the per-skill tools are covered in
    # tests/test_mcp_public.py, and reading this machine's skills here would
    # make the catalogue non-deterministic.
    assert {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=FakeSkills())} == {
        "rag_query",
        "rag_list_collections",
        "rag_list_documents",
        "rag_get_document",
        "skills_list",
        "skills_search",
        "skills_get",
        "skills_read_reference",
        "web_search",
        "web_fetch",
    }


def test_disabling_web_hides_both_web_tools(settings):
    settings["mcp_web_enabled"] = False
    names = {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=FakeSkills())}

    assert "web_search" not in names and "web_fetch" not in names
    assert "rag_query" in names  # other families untouched


def test_disabling_skills_hides_the_whole_family(settings):
    settings["mcp_skills_enabled"] = False
    sm = FakeSkills(index=[{"name": "deploy", "description": "Ship it", "category": "ops"}])
    names = {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=sm)}

    # Both halves of the family: the skills_* tools and the per-skill tools.
    assert not any(n.startswith("skill") for n in names)
    assert "web_search" in names


def test_selected_mode_also_narrows_the_per_skill_tools(settings):
    """The allowlist is one gate over both shapes of the same library."""
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    sm = FakeSkills(
        index=[
            {"name": "deploy", "description": "", "category": "ops"},
            {"name": "invoice", "description": "", "category": "finance"},
        ]
    )
    names = {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=sm)}

    assert "skill_deploy" in names
    assert "skill_invoice" not in names


def test_a_disabled_tool_is_refused_even_with_the_scope(settings):
    """A client may have cached an older tool list — listing isn't the gate."""
    settings["mcp_web_enabled"] = False
    text, is_error = call("web_search", {"query": "anything"})

    assert is_error is True
    assert "disabled" in text.lower()


# ---------------------------------------------------------------------------
# RAG gating
# ---------------------------------------------------------------------------


@pytest.fixture
def registry(monkeypatch):
    """Two registered knowledge bases, with no Qdrant behind them."""
    bases = [
        {"id": "default", "name": "Talos", "description": "everything"},
        {"id": "hr", "name": "HR", "description": "personnel files"},
    ]
    monkeypatch.setattr("src.rag_registry.list_bases", lambda: bases)
    monkeypatch.setattr("src.rag_registry.describe", lambda e, with_counts=True: dict(e))
    return bases


def test_disabling_rag_hides_the_whole_family(settings):
    settings["mcp_rag_enabled"] = False
    names = {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=FakeSkills())}

    assert not any(n.startswith("rag_") for n in names)
    assert "web_search" in names  # other families untouched


def test_a_deselected_rag_tool_is_neither_listed_nor_callable(settings):
    settings["mcp_rag_tools"] = ["rag_query", "rag_list_collections"]
    names = {t["name"] for t in mcp_public.list_tools(ALL, skills_manager=FakeSkills())}

    assert names >= {"rag_query", "rag_list_collections"}
    assert "rag_get_document" not in names
    text, is_error = call("rag_get_document", {"source": "/x.pdf"})
    assert is_error is True
    assert "disabled" in text.lower()


def test_the_retired_rag_search_name_obeys_the_same_switch(settings):
    """`rag_search` resolves to rag_query — including for the allow-list."""
    settings["mcp_rag_tools"] = ["rag_list_collections"]
    text, is_error = call("rag_search", {"query": "anything"})

    assert is_error is True
    assert "disabled" in text.lower()


def test_settings_from_before_the_setting_existed_offer_every_rag_tool(settings):
    assert mcp_settings.rag_tools() == set(mcp_settings.RAG_TOOLS)


def test_inheriting_lists_every_registered_base(settings, registry):
    text, is_error = call("rag_list_collections", {})

    assert is_error is False
    assert "default" in text and "hr" in text


def test_selected_mode_hides_the_other_bases_from_the_catalogue(settings, registry):
    settings.update({"mcp_rag_inherit": False, "mcp_rag_allowed": ["default"]})
    text, _ = call("rag_list_collections", {})

    assert "default" in text
    assert "personnel files" not in text


def test_naming_a_withheld_base_is_refused(settings, registry):
    settings.update({"mcp_rag_inherit": False, "mcp_rag_allowed": ["default"]})
    text, is_error = call("rag_query", {"query": "salaries", "collections": ["hr"]})

    assert is_error is True
    assert "'hr'" in text
    # The refusal names what the caller *may* use, so it stops guessing.
    assert "default" in text


def test_omitting_the_base_searches_the_allowed_ones_not_the_default(settings, registry):
    """The default base may be exactly the one being withheld."""
    settings.update({"mcp_rag_inherit": False, "mcp_rag_allowed": ["hr"]})
    seen = {}

    def fake_query(args):
        seen.update(args)
        return "ok"

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mcp_public, "_tool_rag_query", fake_query)
        call("rag_query", {"query": "leave policy"})

    assert seen["collections"] == ["hr"]


def test_sharing_nothing_refuses_every_query(settings, registry):
    settings.update({"mcp_rag_inherit": False, "mcp_rag_allowed": []})
    text, is_error = call("rag_query", {"query": "anything"})

    assert is_error is True
    assert "no knowledge bases" in text.lower()


def test_topk_is_capped_but_a_smaller_request_survives(settings, registry):
    settings["mcp_rag_max_results"] = 3
    seen = []

    def fake_query(args):
        seen.append(args.get("topK"))
        return "ok"

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mcp_public, "_tool_rag_query", fake_query)
        call("rag_query", {"query": "a", "topK": 20})
        call("rag_query", {"query": "a", "topK": 2})

    assert seen == [3, 2]


def test_the_cap_does_not_leak_into_the_rest_service(settings, registry):
    """src/rag_api.py calls the tool bodies directly; policy lives above them."""
    settings.update({"mcp_rag_inherit": False, "mcp_rag_allowed": ["default"]})

    assert mcp_public._tool_rag_list_collections().count("- **") == 2


# ---------------------------------------------------------------------------
# Skills gating
# ---------------------------------------------------------------------------


def test_inheriting_exposes_the_whole_published_library(settings):
    sm = FakeSkills(index=[{"name": "deploy", "description": "Ship it", "category": "ops"}])
    text, is_error = call("skills_list", {}, sm=sm)

    assert is_error is False
    assert "deploy" in text


def test_selected_mode_lists_only_the_chosen_skills(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    sm = FakeSkills(
        index=[
            {"name": "deploy", "description": "", "category": "ops"},
            {"name": "invoice", "description": "", "category": "finance"},
        ]
    )
    text, _ = call("skills_list", {}, sm=sm)

    assert "deploy" in text
    assert "invoice" not in text


def test_selection_is_case_insensitive(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["Deploy"]})
    assert mcp_settings.skill_filter()("deploy") is True


def test_a_skill_without_a_name_is_never_shared(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    assert mcp_settings.skill_filter()(None) is False


def test_skills_get_refuses_a_skill_that_is_not_shared(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    sm = FakeSkills(md={"invoice": "# Invoice\n"})
    text, is_error = call("skills_get", {"name": "invoice"}, sm=sm)

    assert is_error is True
    # Distinguishable from a typo, so the client stops re-spelling the name.
    assert "not shared" in text.lower()


def test_skills_read_reference_refuses_a_skill_that_is_not_shared(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    args = {"name": "invoice", "path": "r.md"}
    text, is_error = call("skills_read_reference", args, sm=FakeSkills())

    assert is_error is True
    assert "not shared" in text.lower()


def test_skills_search_never_ranks_a_gated_skill_into_the_window(settings):
    settings.update({"mcp_skills_inherit": False, "mcp_skills_allowed": ["deploy"]})
    sm = FakeSkills(
        index=[
            {"name": "invoice", "description": "", "procedure": ["a"]},
            {"name": "deploy", "description": "", "procedure": ["b"]},
        ]
    )
    text, _ = call("skills_search", {"query": "how"}, sm=sm)

    assert "deploy" in text
    assert "invoice" not in text
