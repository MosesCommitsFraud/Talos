"""Map tile proxy (src/tile_proxy.py, routes/ui_routes.py) — OSM tile usage
policy: identified requests with a Referer, a real cache honouring the server's
headers (7 days when they say nothing), conditional revalidation, no requests
for tiles nobody asked for."""

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import interactive_ui, tile_proxy


@pytest.fixture
def proxy(monkeypatch, tmp_path):
    monkeypatch.setattr(tile_proxy, "cache_dir", lambda: str(tmp_path))
    settings = {
        "app_public_url": "https://talos.example.com/app",
        "ui_map_contact": "it@example.com",
    }
    monkeypatch.setattr(tile_proxy, "_setting", lambda k, d: settings.get(k, d))
    monkeypatch.setattr(
        interactive_ui,
        "map_config",
        lambda: {
            "enabled": True,
            "tileUrl": interactive_ui.TILE_PROXY_PATH,
            "upstream": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            "maxZoom": 19,
        },
    )
    seen = []
    real = httpx.AsyncClient  # captured once: install() may be called twice

    def install(handler):
        def transport(request):
            seen.append(request)
            return handler(request)

        class Client(real):
            def __init__(self, *a, **kw):
                kw.pop("http2", None)
                super().__init__(*a, transport=httpx.MockTransport(transport), **kw)

        monkeypatch.setattr(httpx, "AsyncClient", Client)

    tile_proxy._locks.clear()
    return install, seen


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100


def _get(z=3, x=4, y=2):
    return asyncio.run(tile_proxy.get_tile(z, x, y, "http://192.168.10.91:7000"))


def test_upstream_request_identifies_talos_and_sends_a_referer(proxy):
    install, seen = proxy
    install(lambda r: httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    body, _ = _get()
    assert body == PNG
    req = seen[0]
    assert str(req.url) == "https://tile.openstreetmap.org/3/4/2.png"
    ua = req.headers["user-agent"]
    assert ua.startswith("Talos/") and "it@example.com" in ua
    assert "python-httpx" not in ua
    # The configured public URL's origin, never a path.
    assert req.headers["referer"] == "https://talos.example.com/"


def test_a_cached_tile_is_not_fetched_again(proxy):
    install, seen = proxy
    install(
        lambda r: httpx.Response(
            200, content=PNG, headers={"content-type": "image/png", "cache-control": "max-age=3600"}
        )
    )
    _get()
    _get()
    _get()
    assert len(seen) == 1


def test_no_caching_headers_means_seven_days(proxy):
    install, seen = proxy
    install(lambda r: httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    _get()
    meta = tile_proxy._read_meta(tile_proxy._paths(3, 4, 2)[1])
    import time

    assert meta["expires_at"] - time.time() > tile_proxy.MIN_TTL_SECONDS - 60


def test_expired_tile_is_revalidated_conditionally(proxy):
    install, seen = proxy
    responses = iter(
        [
            httpx.Response(
                200,
                content=PNG,
                headers={
                    "content-type": "image/png",
                    "etag": '"abc"',
                    "cache-control": "max-age=0",
                },
            ),
            httpx.Response(304, headers={"cache-control": "max-age=600"}),
        ]
    )
    install(lambda r: next(responses))
    _get()
    body, etag = _get()
    assert body == PNG and etag == '"abc"'
    assert seen[1].headers["if-none-match"] == '"abc"'


def test_stale_tile_is_served_when_the_server_is_down(proxy):
    install, seen = proxy
    install(
        lambda r: httpx.Response(
            200, content=PNG, headers={"content-type": "image/png", "cache-control": "max-age=0"}
        )
    )
    _get()
    install(lambda r: httpx.Response(503))
    assert _get()[0] == PNG


@pytest.mark.parametrize("z, x, y", [(20, 0, 0), (3, 8, 0), (3, 0, -1), (-1, 0, 0)])
def test_invalid_coordinates_never_reach_the_tile_server(proxy, z, x, y):
    install, seen = proxy
    install(lambda r: httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    with pytest.raises(tile_proxy.TileError):
        _get(z, x, y)
    assert seen == []


def test_non_images_are_refused(proxy):
    install, _ = proxy
    install(lambda r: httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"}))
    with pytest.raises(tile_proxy.TileError):
        _get()


def test_prune_removes_least_recently_used(tmp_path, monkeypatch):
    import os

    monkeypatch.setattr(tile_proxy, "cache_dir", lambda: str(tmp_path))
    for i in range(5):
        path, meta = tile_proxy._paths(1, 0, i)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * 300_000)
        os.utime(path, (1000 + i, 1000 + i))
    removed = tile_proxy.prune(limit_mb=1)
    assert removed == 2
    left = sorted(os.listdir(os.path.join(tmp_path, "1", "0")))
    assert left == ["2.png", "3.png", "4.png"]


def test_route_and_frame_config(proxy):
    import routes.ui_routes as routes

    install, seen = proxy
    install(lambda r: httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    app = FastAPI()
    app.include_router(routes.setup_ui_routes())
    client = TestClient(app)
    res = client.get("/api/ui/tiles/3/4/2.png")
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    assert client.get("/api/ui/tiles/3/4/x.png").status_code == 404
    # The frame's CSP needs no outside host any more.
    assert "openstreetmap" not in interactive_ui.ui_shell_csp()


def test_public_config_hides_the_upstream(monkeypatch):
    import src.settings as settings

    monkeypatch.setattr(settings, "get_setting", lambda key, default=None: default)
    cfg = interactive_ui.public_map_config()
    assert cfg["tileUrl"] == interactive_ui.TILE_PROXY_PATH and "upstream" not in cfg
    assert cfg["osm"] is True and "fixthemap" in cfg["attribution"]
