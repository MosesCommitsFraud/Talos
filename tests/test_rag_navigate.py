"""Knowledge-base navigation tools: list / outline / read / grep.

The index is faked with the chunk shape ``VectorRAG.get_document_chunks``
returns, so these tests pin the behaviour the agent relies on: sections in
document order, overlap removed when chunks are joined, pages and video times
in the outline, paging that never loses text, and citations for read text.
"""

import asyncio
import importlib
import json

import pytest

nav = importlib.import_module("src.rag_navigate")


def _chunk(
    cid,
    seq,
    sid,
    content,
    heading,
    *,
    page=None,
    start=None,
    end=None,
    idx=None,
    src_end=None,
    modality="",
    **extra,
):
    meta = {"seq": seq, "section_id": sid, "heading_path": heading}
    if page is not None:
        meta["page"] = page
    if start is not None:
        meta.update(start=start, end=end)
    if idx is not None:
        meta.update(split_idx_start=idx, source_end=src_end)
    if modality:
        meta["modality"] = modality
    meta.update(extra)
    return {
        "id": cid,
        "content": content,
        "seq": seq,
        "section_id": sid,
        "modality": modality,
        "metadata": meta,
    }


SECTION_A = "Intro text. " * 10  # 120 chars
PART_1 = "x" * 100 + "OVERLAP"
PART_2 = "OVERLAP" + "y" * 50


class FakeManager:
    healthy = True

    def __init__(self, docs):
        self.docs = docs  # source -> chunks

    def list_documents(self, exclude_scopes=None):
        return [
            {"source": s, "filename": s.split("/")[-1], "type": ".pdf", "chunks": len(c)}
            for s, c in self.docs.items()
        ]

    def get_document_chunks(self, source):
        # Audit order (by page), deliberately not seq order.
        return list(reversed(self.docs[source]))

    def grep_chunks(self, query, limit=200, exclude_scopes=None):
        out = []
        for s, chunks in self.docs.items():
            for c in chunks:
                if query.lower() in c["content"].lower():
                    out.append(
                        {
                            "filename": s.split("/")[-1],
                            "page": c["metadata"].get("page"),
                            "snippet": c["content"][:40],
                        }
                    )
        return out


@pytest.fixture
def kb(monkeypatch):
    manual = [
        _chunk("a", 0, "s1", SECTION_A, ["Einleitung"], page=1),
        _chunk("b1", 1, "s2", PART_1, ["Einleitung", "Installation"], page=2, idx=0, src_end=107),
        _chunk("b2", 2, "s2", PART_2, ["Einleitung", "Installation"], page=3, idx=100, src_end=157),
        _chunk(
            "f",
            3,
            "fig-3",
            "Screenshot of the installer",
            [],
            page=3,
            modality="figure",
            image_url="/api/fig/1.png",
            image_caption="Installer dialog",
        ),
        _chunk("c", 4, "s3", "Fehlercode E-4711 bedeutet Überhitzung.", ["Fehler"], page=9),
    ]
    video = [
        _chunk("v1", 0, "t1", "Begrüßung und Witze.", [], start=0, end=95),
        _chunk("v2", 1, "t2", "Jetzt richten wir den Export ein.", [], start=95, end=600),
    ]
    manager = FakeManager({"/docs/Handbuch.pdf": manual, "/docs/Workshop.mp4": video})
    base = {"id": "default", "name": "Wissen"}
    monkeypatch.setattr(nav, "_bases", lambda: [(base, manager)])
    monkeypatch.setattr(nav, "_external", lambda: False)
    nav._doc_cache.clear()
    cited = []

    def fake_cite(session, src):
        cited.append(src)
        return len(cited)

    monkeypatch.setattr(importlib.import_module("src.citations"), "cite_rag", fake_cite)
    return manager, cited


def test_sections_follow_document_order_and_drop_overlap(kb):
    manager, _ = kb
    sections = nav.build_sections(nav._ordered_chunks(manager, "/docs/Handbuch.pdf"))
    assert [s["title"] for s in sections] == ["Einleitung", "Installation", "Fehler"]
    install = sections[1]
    # The 7-char overlap appears once, not twice.
    assert install["text"] == "x" * 100 + "OVERLAP" + "y" * 50
    assert install["pages"] == (2, 3)
    # The figure rides with the section it appears in.
    assert [f["id"] for f in install["figures"]] == ["f"]


def test_large_document_returns_outline(kb, monkeypatch):
    monkeypatch.setattr(nav, "FULL_DOC_CHARS", 50)
    text, sources, label = nav.read_knowledge({"document": "handbuch.pdf"})
    assert sources == []
    assert "OUTLINE" in text
    assert "2. Installation — p. 2–3" in text
    assert "1 fig." in text
    assert label.endswith("outline")


def test_small_document_comes_back_in_full(kb):
    text, sources, _ = nav.read_knowledge({"document": "Handbuch"})
    assert "Fehlercode E-4711" in text and "(complete)" in text
    assert len(sources) == 3


def test_read_section_is_verbatim_and_cited(kb):
    _, cited = kb
    text, sources, _ = nav.read_knowledge({"document": "Handbuch.pdf", "section": "2"}, "sess")
    assert "### [1] §2 Einleitung › Installation  (p. 2–3)" in text
    assert "![Installer dialog](/api/fig/1.png)" in text
    assert "Fehlercode" not in text
    assert sources[0]["n"] == 1 and sources[0]["_page"] == 2
    assert sources[0]["_id"] == "default:b1"


def test_read_by_pages_and_time(kb):
    text, _, _ = nav.read_knowledge({"document": "Handbuch.pdf", "pages": "9"})
    assert "E-4711" in text and "Installation" not in text
    text, sources, _ = nav.read_knowledge({"document": "Workshop.mp4", "time": "2:00-5:00"})
    assert "Export" in text and "Witze" not in text
    assert sources[0]["modality"] == "video" and sources[0]["start"] == 95


def test_paging_covers_everything_without_gaps(kb):
    seen = ""
    args = {"document": "Handbuch.pdf", "max_chars": 2000}
    text, _, _ = nav.read_knowledge(args)
    assert "(complete)" in text  # fits in one page
    # Force tiny pages through the floor of max_chars.
    nav_text = []
    offset = 0
    for _ in range(10):
        monkey_args = {"document": "Handbuch.pdf", "offset": offset}
        original = nav.DEFAULT_READ_CHARS
        try:
            nav.DEFAULT_READ_CHARS = 2000
            t, _, _ = nav.read_knowledge(monkey_args)
        finally:
            nav.DEFAULT_READ_CHARS = original
        nav_text.append(t)
        if "MORE TEXT FOLLOWS" not in t:
            break
        offset = int(t.split('"offset": ')[1].split()[0].rstrip("."))
    seen = "".join(nav_text)
    assert "E-4711" in seen


def test_unknown_and_ambiguous_documents(kb):
    with pytest.raises(nav.NavigationError, match="list_knowledge"):
        nav.read_knowledge({"document": "Nope.docx"})
    with pytest.raises(nav.NavigationError, match="several documents"):
        nav.resolve_document("docs")
    with pytest.raises(nav.NavigationError, match="sections 1–3"):
        nav.read_knowledge({"document": "Handbuch.pdf", "section": "7"})


def test_citation_label_prefix_is_ignored(kb):
    _, _, row = nav.resolve_document("[3] Handbuch.pdf")
    assert row["source"] == "/docs/Handbuch.pdf"


def test_grep_in_document_names_the_section(kb):
    out = nav.grep_knowledge({"pattern": "e-4711", "document": "Handbuch.pdf"})
    assert out.startswith("1 occurrence(s)")
    assert "§3 Fehler (p. 9)" in out
    assert "Sections with hits: §3 Fehler (1)" in out


def test_grep_everywhere_and_miss(kb):
    assert "Workshop.mp4" in nav.grep_knowledge({"pattern": "export"})
    assert "does not occur" in nav.grep_knowledge({"pattern": "zzz"})


def test_list_knowledge_filters(kb):
    out = nav.list_knowledge("work")
    assert "Workshop.mp4" in out and "Handbuch" not in out
    assert "No document name contains" in nav.list_knowledge("zzz")


def test_search_knowledge_document_filter_reaches_the_index(kb, monkeypatch):
    """`document` must become a source filter on the base that holds it."""
    ti = importlib.import_module("src.tool_implementations")
    calls = {}

    class _CP:
        def __init__(self, _m, rag_base_id=None):
            calls["base"] = rag_base_id

        def retrieve(self, query, **kw):
            calls.update(kw)
            return [{"filename": "Handbuch.pdf", "_id": "c", "snippet": "x"}], "[1] Handbuch.pdf\nx"

    monkeypatch.setattr(importlib.import_module("src.chat_processor"), "ChatProcessor", _CP)
    out = asyncio.run(
        ti.do_search_knowledge(json.dumps({"query": "E-4711", "document": "Handbuch", "k": 8}))
    )
    assert calls["sources"] == ["/docs/Handbuch.pdf"] and calls["top_k"] == 8
    assert calls["base"] == "default"
    assert out["rag_sources"][0]["_id"] == "default:c"


def test_read_tool_wraps_text_as_untrusted(kb):
    ti = importlib.import_module("src.tool_implementations")
    out = asyncio.run(ti.do_read_knowledge(json.dumps({"document": "Handbuch.pdf", "section": 3})))
    text = out["output"]
    assert text.index("(complete)") < text.index("<<<SUPPLIED_CONTEXT>>>") < text.index("E-4711")
    assert out["rag_sources"]
