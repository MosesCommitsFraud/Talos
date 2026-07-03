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
