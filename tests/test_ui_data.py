"""Live data sources and images for interactive answers (src/ui_data.py,
routes/ui_routes.py, image signing in src/interactive_ui.py)."""

import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from src import interactive_ui, ui_data
from src.ui_data import DataSourceError

SQL = {
    "id": "umsatz",
    "kind": "sql",
    "query": "SELECT monat, SUM(betrag) FROM dbo.orders WHERE jahr = :jahr AND region = :region GROUP BY monat",
    "params": {
        "jahr": {"type": "int", "min": 2018, "max": 2025, "default": 2025},
        "region": {"type": "enum", "values": ["Nord", "Süd"], "default": "Nord"},
    },
}


# ── spec validation ──


def test_valid_sql_source_is_normalised():
    (spec,) = ui_data.normalize_sources([SQL])
    assert spec["maxRows"] == ui_data.SQL_DEFAULT_ROWS
    assert spec["params"]["jahr"] == {"type": "int", "min": 2018, "max": 2025, "default": 2025}
    public = ui_data.public_spec(spec)
    assert "query" not in public and public["params"]["region"]["values"] == ["Nord", "Süd"]


@pytest.mark.parametrize(
    "change, needle",
    [
        ({"query": "DELETE FROM dbo.orders WHERE jahr = :jahr"}, "read-only"),
        ({"query": "SELECT 1 WHERE x = :undeclared"}, "without declaring"),
        ({"id": "Bad Id"}, "lowercase"),
        ({"kind": "shell"}, "kind must be"),
        ({"params": {"jahr": {"type": "int"}}}, "min` and `max"),
        ({"params": {"jahr": {"type": "enum", "values": []}}}, "1-100"),
    ],
)
def test_bad_sql_sources_are_refused(change, needle):
    with pytest.raises(DataSourceError, match=needle):
        ui_data.normalize_sources([{**SQL, **change}])


def test_web_source_may_not_parameterise_the_host():
    with pytest.raises(DataSourceError, match="host"):
        ui_data.normalize_source(
            {"id": "w", "kind": "web", "url": "https://{h}/x", "params": {"h": {"type": "string"}}}
        )
    with pytest.raises(DataSourceError, match="https"):
        ui_data.normalize_source({"id": "w", "kind": "web", "url": "http://example.org/x"})
    ok = ui_data.normalize_source(
        {
            "id": "w",
            "kind": "web",
            "url": "https://example.org/kurs?d={d}",
            "params": {"d": {"type": "date"}},
        }
    )
    assert ok["maxChars"] == ui_data.WEB_DEFAULT_CHARS


def test_duplicate_ids_and_too_many_sources():
    with pytest.raises(DataSourceError, match="unique"):
        ui_data.normalize_sources([SQL, SQL])
    many = [{**SQL, "id": f"s{i}"} for i in range(ui_data.MAX_SOURCES + 1)]
    with pytest.raises(DataSourceError, match="at most"):
        ui_data.normalize_sources(many)


# ── parameters at request time ──


def test_params_are_typed_bounded_and_defaulted():
    (spec,) = ui_data.normalize_sources([SQL])
    assert ui_data.resolve_params(spec, {"jahr": "2020"}) == {"jahr": 2020, "region": "Nord"}
    for bad, needle in (
        ({"jahr": 2030}, "range"),
        ({"jahr": 2020.5}, "whole number"),
        ({"jahr": True}, "whole number"),
        ({"region": "Ost"}, "allowed values"),
        ({"other": 1}, "Unknown parameter"),
        ("x", "object"),
    ):
        with pytest.raises(DataSourceError, match=needle):
            ui_data.resolve_params(spec, bad)


def test_strings_and_dates():
    spec = ui_data.normalize_source(
        {
            "id": "k",
            "kind": "knowledge",
            "query": "Wartung {teil} ab {ab}",
            "params": {
                "teil": {"type": "string", "maxLength": 5},
                "ab": {"type": "date", "min": "2024-01-01"},
            },
        }
    )
    assert ui_data.resolve_params(spec, {"teil": "Filt", "ab": "2024-05-01"})["ab"] == "2024-05-01"
    with pytest.raises(DataSourceError, match="too long"):
        ui_data.resolve_params(spec, {"teil": "Filterpatrone", "ab": "2024-05-01"})
    with pytest.raises(DataSourceError, match="range"):
        ui_data.resolve_params(spec, {"teil": "a", "ab": "2023-01-01"})


def test_web_template_values_are_url_encoded():
    assert (
        ui_data._fill("https://x.org/q?s={s}", {"s": "a b&c=/"}, quote=True)
        == "https://x.org/q?s=a%20b%26c%3D%2F"
    )


# ── storage ──


@pytest.fixture
def memory_db(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import core.database as database

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    database.UiDataSource.__table__.create(engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    return engine


def test_register_and_load_round_trip(memory_db):
    specs = ui_data.normalize_sources([SQL])
    ui_id = ui_data.register(specs, "alice", "sess-1")
    row = ui_data.load(ui_id, "umsatz")
    assert row["owner"] == "alice" and row["session_id"] == "sess-1"
    assert row["spec"]["query"] == SQL["query"]
    assert ui_data.load(ui_id, "nope") is None


def test_render_ui_registers_sources_and_hides_the_spec(memory_db, monkeypatch):
    import asyncio

    monkeypatch.setattr(interactive_ui, "_image_key", lambda: b"k" * 32)
    call = {
        "title": "T",
        "html": "<div></div>",
        "sources": [{"kind": "sql", "label": "x"}],
        "dataSources": [SQL],
    }
    result = asyncio.run(
        interactive_ui.do_render_ui(json.dumps(call), owner="alice", session_id="s")
    )
    payload = result["widget"]["data"]
    assert len(payload["uiId"]) == 32
    assert payload["dataSources"][0]["id"] == "umsatz"
    assert "query" not in json.dumps(payload["dataSources"])
    assert "_dataSourceSpecs" not in payload
    assert "umsatz (sql)" in result["output"]


# ── images ──


def test_images_are_rewritten_to_signed_proxy_urls(monkeypatch):
    monkeypatch.setattr(interactive_ui, "_image_key", lambda: b"k" * 32)
    payload = {
        "html": '<img src="https://img.example.org/a.jpg" alt=""><img src="data:image/png;base64,xx">',
        "js": "",
        "data": {"pics": ["https://img.example.org/b.webp?w=200"]},
    }
    interactive_ui.proxy_images(payload)
    assert 'src="/api/ui/img?u=https%3A%2F%2Fimg.example.org%2Fa.jpg&s=' in payload["html"]
    assert "data:image/png" in payload["html"]
    assert set(payload["images"]) == {
        "https://img.example.org/a.jpg",
        "https://img.example.org/b.webp?w=200",
    }
    url = "https://img.example.org/a.jpg"
    sig = payload["images"][url].rsplit("s=", 1)[1]
    assert interactive_ui.image_signature_ok(url, sig)
    assert not interactive_ui.image_signature_ok("https://evil.example/x.jpg", sig)


# ── routes ──


@pytest.fixture
def client(monkeypatch):
    import routes.ui_routes as routes

    monkeypatch.setattr(routes, "require_user", lambda request: "alice")
    monkeypatch.setattr(routes, "effective_user", lambda request: "alice")
    monkeypatch.setattr(interactive_ui, "enabled", lambda: True)
    monkeypatch.setattr(interactive_ui, "_image_key", lambda: b"k" * 32)
    monkeypatch.setattr(ui_data, "tool_allowed", lambda kind, owner: True)
    app = FastAPI()
    app.include_router(routes.setup_ui_routes())
    return TestClient(app)


def _stored(owner="alice"):
    (spec,) = ui_data.normalize_sources([SQL])
    return {"owner": owner, "session_id": "s", "spec": spec}


def test_refresh_runs_the_stored_spec_with_resolved_params(client, monkeypatch):
    seen = {}

    async def fake_run(spec, params, session_id=""):
        seen.update(params=params, query=spec["query"])
        return {
            "columns": ["monat", "umsatz"],
            "rows": [[1, 10]],
            "rowCount": 1,
            "truncated": False,
        }

    monkeypatch.setattr(ui_data, "load", lambda ui_id, sid: _stored())
    monkeypatch.setattr(ui_data, "run", fake_run)
    res = client.post(
        "/api/ui/data", json={"uiId": "a" * 32, "sourceId": "umsatz", "params": {"jahr": 2020}}
    )
    assert res.status_code == 200
    assert res.json()["data"]["rows"] == [[1, 10]]
    assert seen["params"] == {"jahr": 2020, "region": "Nord"}
    assert seen["query"] == SQL["query"]  # never anything from the request


def test_refresh_of_someone_elses_ui_looks_unknown(client, monkeypatch):
    monkeypatch.setattr(ui_data, "load", lambda ui_id, sid: _stored(owner="bob"))
    res = client.post("/api/ui/data", json={"uiId": "a" * 32, "sourceId": "umsatz"})
    assert res.status_code == 404


def test_refresh_rejects_bad_params_and_blocked_tools(client, monkeypatch):
    monkeypatch.setattr(ui_data, "load", lambda ui_id, sid: _stored())
    res = client.post(
        "/api/ui/data", json={"uiId": "a" * 32, "sourceId": "umsatz", "params": {"jahr": 1999}}
    )
    assert res.status_code == 422
    monkeypatch.setattr(ui_data, "tool_allowed", lambda kind, owner: False)
    res = client.post("/api/ui/data", json={"uiId": "a" * 32, "sourceId": "umsatz"})
    assert res.status_code == 403


def test_image_proxy_needs_a_valid_signature(client, monkeypatch):
    import routes.ui_routes as routes

    async def fake_fetch(url, label="Image"):
        return b"\x89PNG....", "image/png"

    monkeypatch.setattr(routes, "fetch_public_image", fake_fetch)
    url = "https://img.example.org/a.png"
    assert client.get("/api/ui/img", params={"u": url, "s": "0" * 32}).status_code == 403
    signed = interactive_ui.sign_image_url(url)
    res = client.get(signed)
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_image_proxy_surface_errors_from_the_fetch(client, monkeypatch):
    import routes.ui_routes as routes

    async def refused(url, label="Image"):
        raise HTTPException(403, "This image may not be loaded.")

    monkeypatch.setattr(routes, "fetch_public_image", refused)
    assert client.get(interactive_ui.sign_image_url("https://10.0.0.1/a.png")).status_code == 403
