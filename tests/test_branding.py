import json

import pytest

from core import branding


@pytest.fixture
def profiles(tmp_path, monkeypatch):
    host, repo = tmp_path / "host", tmp_path / "repo"
    monkeypatch.setattr(branding, "_SEARCH_ROOTS", (str(host), str(repo)))
    branding.get_brand.cache_clear()
    yield host, repo
    branding.get_brand.cache_clear()


def _profile(root, name, brand_name=None, logos=()):
    folder = root / name
    folder.mkdir(parents=True)
    if brand_name:
        (folder / "brand.json").write_text(json.dumps({"name": brand_name}), encoding="utf-8")
    for logo in logos:
        (folder / logo).write_bytes(b"<svg/>")


def test_unset_profile_is_stock_talos(profiles, monkeypatch):
    monkeypatch.delenv("TALOS_BRAND", raising=False)
    assert branding.brand_public() == {"name": "Talos", "logoSmall": None, "logoLarge": None}


def test_profile_supplies_name_and_logos(profiles, monkeypatch):
    _, repo = profiles
    _profile(repo, "acme", "Acme AI", ["logo-small.svg", "logo-large.png"])
    monkeypatch.setenv("TALOS_BRAND", "acme")
    assert branding.brand_public() == {
        "name": "Acme AI",
        "logoSmall": "/branding/logo-small",
        "logoLarge": "/branding/logo-large",
    }
    assert branding.get_brand().logo_large.endswith("logo-large.png")


def test_host_profile_wins_over_repo(profiles, monkeypatch):
    host, repo = profiles
    _profile(repo, "acme", "Repo Name")
    _profile(host, "acme", "Host Name")
    monkeypatch.setenv("TALOS_BRAND", "acme")
    assert branding.get_brand().name == "Host Name"


@pytest.mark.parametrize("value", ["missing", "../etc", ""])
def test_unknown_or_invalid_profile_falls_back(profiles, monkeypatch, value):
    monkeypatch.setenv("TALOS_BRAND", value)
    assert branding.get_brand().name == "Talos"
    assert branding.get_brand().logo_small is None
