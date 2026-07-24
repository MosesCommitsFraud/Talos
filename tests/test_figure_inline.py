"""Unit tests for the model-placed inline figure feature:

  * the anti-hallucination guard that strips figure images the answer references
    but that weren't retrieved (routes.chat_helpers.strip_unauthorized_figures);
  * carrying inline figures through context compaction so they aren't flattened
    into prose (src.context_compactor._extract_figure_markdown).

Pure string logic — no network, DB, or model deps.
"""

import importlib

ch = importlib.import_module("routes.chat_helpers")
cc = importlib.import_module("src.context_compactor")

_OK = "/api/personal/rag-asset?source=%2Fu%2F_pdf_figures%2Fok.png"
_BAD = "/api/personal/rag-asset?source=%2Fu%2F_pdf_figures%2Fbad.png"


def test_strips_unauthorized_figure_keeps_authorized():
    answer = f"Here is the pump ![pump]({_OK}) and a fake ![nope]({_BAD})."
    out = ch.strip_unauthorized_figures(answer, [{"image_url": _OK}])
    assert _OK in out
    assert "bad.png" not in out
    assert "![nope]" not in out


def test_leaves_external_and_generated_images_untouched():
    answer = "![chart](https://example.com/a.png) ![gen](/api/generated-image/x.png)"
    assert ch.strip_unauthorized_figures(answer, []) == answer


def test_keeps_decoded_variant_of_authorized_url():
    # Models routinely percent-decode copied URLs (%2F → /); that must not get
    # an authorized figure stripped.
    decoded = "/api/personal/rag-asset?source=/u/_pdf_figures/ok.png"
    answer = f"![pump]({decoded})"
    assert ch.strip_unauthorized_figures(answer, [{"image_url": _OK}]) == answer


def test_still_strips_fabricated_url_even_decoded():
    fake = "/api/personal/rag-asset?source=/u/_pdf_figures/nope.png"
    out = ch.strip_unauthorized_figures(f"![x]({fake})", [{"image_url": _OK}])
    assert "nope.png" not in out


def test_noop_when_no_rag_asset_present():
    answer = "Plain answer with no images."
    assert ch.strip_unauthorized_figures(answer, [{"image_url": _OK}]) == answer


# --- append_missing_figures (server-side embed backstop) ---

_ANSWER = "The centrifugal pump impeller must be aligned before startup."
_USED_TEXT = {
    "filename": "pump-manual.pdf",
    "snippet": "centrifugal pump impeller alignment",
    "_text": "The centrifugal pump impeller alignment procedure requires the shaft to be level.",
}
_FIG = {
    "filename": "pump-manual.pdf",
    "image_url": _OK,
    "image_caption": "Impeller alignment diagram",
}


def test_appends_figure_when_source_used_and_no_image():
    out = ch.append_missing_figures(_ANSWER, [_USED_TEXT, _FIG])
    assert out == f"\n\n![Impeller alignment diagram]({_OK})"


def test_no_append_when_answer_already_embeds_figure():
    answer = f"{_ANSWER} ![diagram]({_OK})"
    assert ch.append_missing_figures(answer, [_USED_TEXT, _FIG]) == ""


def test_no_append_when_no_source_used():
    assert ch.append_missing_figures("Completely unrelated reply.", [_USED_TEXT, _FIG]) == ""


def test_no_append_without_figures():
    assert ch.append_missing_figures(_ANSWER, [_USED_TEXT]) == ""


def test_filename_mismatch_falls_back_to_first_figure():
    fig = dict(_FIG, filename="page3_fig1.png")
    out = ch.append_missing_figures(_ANSWER, [_USED_TEXT, fig])
    assert _OK in out


def test_append_caps_at_max_figures():
    fig2 = dict(_FIG, image_url=_BAD, image_caption="Second figure")
    out = ch.append_missing_figures(_ANSWER, [_USED_TEXT, _FIG, fig2])
    assert out.count("![") == 1


def test_same_pdf_filename_uses_exact_page_anchor_not_first_figure():
    answer = "Im macs Report Editor wird das Band per Rechtsklick eingefügt."
    source = "/u/training.pdf"
    band_text = {
        "filename": "training.pdf",
        "_id": "page6",
        "_source": source,
        "_page": 6,
        "_text": "Im macs Report Editor können Bereiche mit einem Rechtsklick hinzugefügt werden. Band einfügen.",
    }
    drill_text = {
        "filename": "training.pdf",
        "_id": "page27",
        "_source": source,
        "_page": 27,
        "_text": "Im DrillDownControl kann die gewünschte Zelle ausgewählt werden.",
    }
    band_fig = {
        "filename": "training.pdf",
        "_anchor_id": "page6",
        "_source": source,
        "_page": 6,
        "image_url": _OK,
        "image_caption": "Band einfügen",
        "_text": "Kontextmenü Band einfügen",
    }
    drill_fig = {
        "filename": "training.pdf",
        "_anchor_id": "page27",
        "_source": source,
        "_page": 27,
        "image_url": _BAD,
        "image_caption": "DrillDownControl",
        "_text": "DrillDownControl im Gruppenband",
    }

    out = ch.append_missing_figures(answer, [band_text, drill_text, drill_fig, band_fig])

    assert _OK in out
    assert _BAD not in out


def test_model_embedded_wrong_anchor_and_fabricated_figures_are_stripped():
    # Retrieval membership is necessary but no longer sufficient: the answer
    # uses page6, so a retrieved page27 figure and a fabricated URL are removed.
    fake = "/api/personal/rag-asset?source=%2Fu%2F_pdf_figures%2Ffabricated.png"
    answer = f"Band per Rechtsklick einfügen. ![fig]({_BAD}) ![nope]({fake})"
    source = "/u/training.pdf"
    sources = [
        {
            "filename": "training.pdf",
            "_id": "page6",
            "_source": source,
            "_page": 6,
            "_text": "Band per Rechtsklick einfügen.",
        },
        {
            "filename": "training.pdf",
            "_source": source,
            "_page": 6,
            "_anchor_id": "page6",
            "image_url": _OK,
            "image_caption": "Band einfügen",
        },
        {
            "filename": "training.pdf",
            "_source": source,
            "_page": 27,
            "_anchor_id": "page27",
            "image_url": _BAD,
            "image_caption": "DrillDownControl",
        },
    ]

    stripped = ch.strip_unauthorized_figures(answer, sources)

    assert _BAD not in stripped
    assert "fabricated.png" not in stripped
    # Once the irrelevant model choice is removed, the backstop can add the
    # actually eligible page6 figure.
    assert _OK in ch.append_missing_figures(stripped, sources)


def test_same_page_prefers_focused_figure_and_drops_extra_image_sources():
    answer = f"Die vertikale Toolbar enthält Textfeld, Bild, Seiteninfo, Formel und Sparkline. ![toolbar]({_OK})"
    source = "/u/training.pdf"
    page_text = {
        "filename": "training.pdf",
        "_id": "page28",
        "_source": source,
        "_page": 28,
        "_text": "Elementband mit Symbolen für Textfeld, Bild, Seiteninfo, Formel und Sparkline.",
    }
    generic = {
        "filename": "training.pdf",
        "_anchor_id": "page28",
        "_source": source,
        "_page": 28,
        "image_url": _BAD,
        "_text": "Allgemeine Oberfläche des Report Designers mit Raster und Tabs.",
    }
    focused = {
        "filename": "training.pdf",
        "_anchor_id": "page28",
        "_source": source,
        "_page": 28,
        "image_url": _OK,
        "_text": "Vertikale Toolbar: Textfeld, Bild, Seiteninfo, Formel und Sparkline.",
    }
    sources = [page_text, generic, focused]

    eligible = ch._eligible_figures_for_answer(answer, sources)
    used = ch.filter_used_rag_sources(answer, sources)
    with_extra = answer + f" ![generic]({_BAD})"
    stripped = ch.strip_unauthorized_figures(with_extra, sources)

    assert [s["image_url"] for s in eligible] == [_OK]
    assert [s["image_url"] for s in used if s.get("image_url")] == [_OK]
    # Both images were retrieved, but only the most relevant figure attached to
    # the used text anchor remains eligible in the final answer.
    assert _OK in stripped
    assert _BAD not in stripped


def test_strips_retrieved_figure_when_forecast_answer_did_not_use_its_anchor():
    answer = (
        "Die Prognose für 2024 und 2025 beträgt jeweils 62.826 Einheiten. "
        "Sie basiert auf 36 Monaten historischer Absatzdaten und einem stabilen "
        "saisonalen Muster aus der Tabelle ait_Absatzmenge_m_322_1."
    )
    source = "/u/02_macs_Report_Training.pdf"
    page_text = {
        "filename": "02_macs_Report_Training.pdf",
        "_id": "page7",
        "_source": source,
        "_page": 7,
        "_text": (
            "Datenquelle hinzufügen. Standard-Quellen sind Pivot und die "
            "erweiterte Datenquelle. Nach Veränderungen Schemas aktualisieren."
        ),
    }
    dropdown = {
        "filename": "02_macs_Report_Training.pdf",
        "_anchor_id": "page7",
        "_source": source,
        "_page": 7,
        "image_url": _OK,
        "image_caption": "Dropdown-Menü für Datenquellen",
        "_text": (
            "Erweiterte Datenquelle, Pivot, SQL Abfrage Datenquelle und "
            "Dimensions Tabelle."
        ),
    }

    with_image = answer + f"\n\n![Datenquellen]({_OK})"
    stripped = ch.strip_unauthorized_figures(with_image, [page_text, dropdown])

    assert _OK not in stripped
    assert stripped.strip() == answer


def test_keeps_retrieved_figure_when_answer_uses_its_exact_anchor():
    answer = f"Die Datenquelle wird über das Dropdown hinzugefügt. ![Menü]({_OK})"
    source = "/u/training.pdf"
    page_text = {
        "filename": "training.pdf",
        "_id": "page7",
        "_source": source,
        "_page": 7,
        "_text": "Die Datenquelle wird über das Dropdown hinzugefügt.",
    }
    dropdown = {
        "filename": "training.pdf",
        "_anchor_id": "page7",
        "_source": source,
        "_page": 7,
        "image_url": _OK,
        "_text": "Dropdown zum Hinzufügen einer Datenquelle.",
    }

    assert ch.strip_unauthorized_figures(answer, [page_text, dropdown]) == answer


def test_two_topic_answer_gets_one_figure_per_used_anchor():
    # The answer genuinely covers BOTH topics — each used text anchor may
    # contribute its own figure (one per anchor, capped by RAG_MAX_ANSWER_FIGURES).
    answer = (
        "Im macs Report Editor wird das Band per Rechtsklick eingefügt. "
        "Im DrillDownControl kann anschließend die gewünschte Zelle ausgewählt werden."
    )
    source = "/u/training.pdf"
    band_text = {
        "filename": "training.pdf",
        "_id": "page6",
        "_source": source,
        "_page": 6,
        "_text": "Im macs Report Editor wird das Band per Rechtsklick eingefügt.",
    }
    drill_text = {
        "filename": "training.pdf",
        "_id": "page27",
        "_source": source,
        "_page": 27,
        "_text": "Im DrillDownControl kann die gewünschte Zelle ausgewählt werden.",
    }
    band_fig = {
        "filename": "training.pdf",
        "_anchor_id": "page6",
        "_source": source,
        "_page": 6,
        "image_url": _OK,
        "image_caption": "Band einfügen",
        "_text": "Kontextmenü Band einfügen",
    }
    drill_fig = {
        "filename": "training.pdf",
        "_anchor_id": "page27",
        "_source": source,
        "_page": 27,
        "image_url": _BAD,
        "image_caption": "DrillDownControl",
        "_text": "DrillDownControl im Gruppenband",
    }

    eligible = ch._eligible_figures_for_answer(answer, [band_text, drill_text, drill_fig, band_fig])
    assert {fig["image_url"] for fig in eligible} == {_OK, _BAD}

    out = ch.append_missing_figures(answer, [band_text, drill_text, drill_fig, band_fig])
    assert _OK in out
    assert _BAD in out

    # A single-topic answer still gets exactly the one matching figure.
    single = "Im macs Report Editor wird das Band per Rechtsklick eingefügt."
    eligible_single = ch._eligible_figures_for_answer(
        single, [band_text, drill_text, drill_fig, band_fig]
    )
    assert [fig["image_url"] for fig in eligible_single] == [_OK]


def test_figure_cannot_jump_to_different_text_anchor_on_same_page():
    answer = "Band per Rechtsklick einfügen."
    source = "/u/training.pdf"
    text = {
        "filename": "training.pdf",
        "_id": "band-text",
        "_source": source,
        "_page": 6,
        "_text": "Band per Rechtsklick einfügen.",
    }
    correct = {
        "filename": "training.pdf",
        "_anchor_id": "band-text",
        "_source": source,
        "_page": 6,
        "image_url": _OK,
        "_text": "Band einfügen",
    }
    wrong_anchor = {
        "filename": "training.pdf",
        "_anchor_id": "other-text",
        "_source": source,
        "_page": 6,
        "image_url": _BAD,
        "_text": "Band einfügen generic overlap",
    }

    eligible = ch._eligible_figures_for_answer(answer, [text, wrong_anchor, correct])

    assert [fig["image_url"] for fig in eligible] == [_OK]


def test_compaction_extracts_and_dedupes_figures():
    md = f"![diagram]({_OK})"
    older = [
        {"role": "assistant", "content": f"As shown {md} here."},
        {"role": "user", "content": "and again?"},
        {"role": "assistant", "content": f"Yes {md} — same one."},
        # multimodal content shape (list of blocks) is flattened too
        {"role": "assistant", "content": [{"type": "text", "text": f"other ![b]({_BAD})"}]},
    ]
    out = cc._extract_figure_markdown(older)
    assert out == [md, f"![b]({_BAD})"]  # order preserved, first dupe kept


def test_compaction_no_figures_returns_empty():
    assert cc._extract_figure_markdown([{"role": "user", "content": "hi"}]) == []
