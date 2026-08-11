"""The news-card thumbnail proxy (routes/news_routes.py).

It exists so the browser never requests an image from a publisher directly. That
makes the app itself the fetcher, which is why every test here is about refusing
things: the URL comes out of a search engine's result set, not from anything a
user typed, and the app sits on a network that can reach vLLM, Qdrant, Redis and
the LAN.
"""

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from routes.news_routes import MAX_BYTES, setup_news_routes

PIXEL = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def client(monkeypatch):
    # Patched where it is USED, not where it is defined: news_routes imports the
    # name at module load, so the module-level binding is what the handler calls.
    monkeypatch.setattr("routes.news_routes.require_user", lambda request: "tester")
    app = FastAPI()
    app.include_router(setup_news_routes())
    return TestClient(app, raise_server_exceptions=False)


def _transport(monkeypatch, handler):
    """Replace the outbound client with one driven by `handler(request)`."""

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            return handler(url, headers or {})

    monkeypatch.setattr(httpx, "AsyncClient", _Client)


def _response(status=200, content=PIXEL, content_type="image/png", location=None):
    headers = {"content-type": content_type}
    if location:
        headers["location"] = location
    return httpx.Response(status, content=content, headers=headers)


def _allow_all(monkeypatch):
    monkeypatch.setattr("src.web_search._validate_fetch_url", lambda url: None)


# ── the happy path ──


def test_serves_the_image_from_this_origin(monkeypatch, client):
    _allow_all(monkeypatch)
    seen = {}

    def _handler(url, headers):
        seen.update(url=url, headers=headers)
        return _response()

    _transport(monkeypatch, _handler)
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/img.png"})

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.content == PIXEL
    assert seen["url"] == "https://pub.example/img.png"
    # The publisher is not told which page asked for the image.
    assert "Referer" not in seen["headers"]
    # Third-party bytes: never sniffable into something executable.
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "max-age" in r.headers["cache-control"]


# ── refusals ──


def test_missing_url_is_a_400(client):
    assert client.get("/api/news/thumbnail").status_code == 400


def test_private_and_blocked_hosts_are_refused(monkeypatch, client):
    """The real guard is web_fetch's: scheme, host, admin domain policy, and a
    DNS check that every resolved address is publicly routable."""

    def _refuse(url):
        return "Refusing to fetch 'qdrant': it resolves to a private address."

    monkeypatch.setattr("src.web_search._validate_fetch_url", _refuse)
    r = client.get("/api/news/thumbnail", params={"url": "http://qdrant:6333/collections"})
    assert r.status_code == 403
    # The refusal reason is for the log, not for the caller.
    assert "qdrant" not in r.text


def test_a_non_image_response_is_refused(monkeypatch, client):
    """Checked on the RESPONSE, not the URL: '.jpg' in a path is a claim by
    whoever wrote the link, and this one came off a search engine."""
    _allow_all(monkeypatch)
    _transport(monkeypatch, lambda url, headers: _response(content_type="text/html"))
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/not-an-image.jpg"})
    assert r.status_code == 415


def test_svg_is_not_an_allowed_image_type(monkeypatch, client):
    """SVG is a document that can carry script, so it stays out of the set even
    though it is nominally an image."""
    _allow_all(monkeypatch)
    _transport(monkeypatch, lambda url, headers: _response(content_type="image/svg+xml"))
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/x.svg"})
    assert r.status_code == 415


def test_oversized_images_are_refused(monkeypatch, client):
    _allow_all(monkeypatch)
    _transport(monkeypatch, lambda url, headers: _response(content=b"\x00" * (MAX_BYTES + 1)))
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/huge.png"})
    assert r.status_code == 413


def test_upstream_failures_become_502(monkeypatch, client):
    _allow_all(monkeypatch)
    _transport(monkeypatch, lambda url, headers: _response(status=404, content=b""))
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/gone.png"})
    assert r.status_code == 502


def test_a_too_long_url_is_rejected_before_any_request(monkeypatch, client):
    called = {"n": 0}

    def _handler(url, headers):
        called["n"] += 1
        return _response()

    _allow_all(monkeypatch)
    _transport(monkeypatch, _handler)
    r = client.get("/api/news/thumbnail", params={"url": "https://e.com/" + "a" * 3000})
    assert r.status_code == 400
    assert called["n"] == 0


# ── redirects ──


def test_a_redirect_is_re_validated(monkeypatch, client):
    """The redirect target is a second URL chosen by the first one's owner. An
    image host redirecting to 127.0.0.1 must not walk past the guard."""
    checked = []

    def _validate(url):
        checked.append(url)
        return "private address" if "127.0.0.1" in url else None

    monkeypatch.setattr("src.web_search._validate_fetch_url", _validate)
    _transport(
        monkeypatch,
        lambda url, headers: _response(status=302, location="http://127.0.0.1:6333/x.png"),
    )
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/img.png"})
    assert r.status_code == 403
    assert any("127.0.0.1" in u for u in checked)


def test_a_redirect_chain_terminates(monkeypatch, client):
    _allow_all(monkeypatch)
    _transport(
        monkeypatch,
        lambda url, headers: _response(status=302, location="https://pub.example/again.png"),
    )
    r = client.get("/api/news/thumbnail", params={"url": "https://pub.example/img.png"})
    assert r.status_code == 502


# ── auth ──


def test_unauthenticated_callers_are_rejected(monkeypatch):
    """An open image proxy on the public internet is someone else's bandwidth
    and someone else's abuse report."""

    def _reject(request):
        raise HTTPException(401, "Not authenticated")

    monkeypatch.setattr("routes.news_routes.require_user", _reject)
    app = FastAPI()
    app.include_router(setup_news_routes())
    unauth = TestClient(app, raise_server_exceptions=False)
    r = unauth.get("/api/news/thumbnail", params={"url": "https://pub.example/img.png"})
    assert r.status_code == 401


def test_route_is_mounted_on_the_app():
    import app as app_module

    paths = {getattr(r, "path", "") for r in app_module.app.routes}
    assert "/api/news/thumbnail" in paths
