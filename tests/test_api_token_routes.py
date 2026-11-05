"""API tokens: the generator in Settings → MCP Server talks to these routes."""

from contextlib import contextmanager

import bcrypt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from core.database import ApiToken
from routes import api_token_routes


@pytest.fixture
def client(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    ApiToken.__table__.create(engine)
    Session = sessionmaker(bind=engine)

    @contextmanager
    def session():
        db = Session()
        try:
            yield db
            db.commit()
        finally:
            db.close()

    monkeypatch.setattr(api_token_routes, "get_db_session", session)
    monkeypatch.setattr(api_token_routes, "require_admin", lambda request: None)
    monkeypatch.setattr(api_token_routes, "get_current_user", lambda request: "admin")
    app = FastAPI()
    app.include_router(api_token_routes.setup_api_token_routes())
    client = TestClient(app)
    client.session_factory = Session
    return client


def create(client, **fields):
    return client.post("/api/tokens", data={"name": "CI", **fields})


def test_the_update_profile_carries_only_the_update_scope(client):
    row = create(client, profile="mcp_update").json()
    assert row["scopes"] == ["rag:update"]


def test_the_token_is_answered_once_and_stored_only_as_a_hash(client):
    row = create(client, profile="mcp_update").json()
    token = row["token"]
    assert token.startswith("ody_") and row["token_prefix"] == token[:8]

    with client.session_factory() as db:
        stored = db.query(ApiToken).one()
        assert token not in (stored.token_hash, stored.token_prefix)
        assert bcrypt.checkpw(token.encode(), stored.token_hash.encode())

    listed = client.get("/api/tokens")
    assert token not in listed.text
    assert "token_hash" not in listed.text
    assert listed.json()[0]["token_prefix"] == token[:8]


def test_a_name_is_required_and_an_unknown_profile_refused(client):
    assert client.post("/api/tokens", data={"name": "  "}).status_code == 400
    assert create(client, profile="root").status_code == 400


def test_a_revoked_token_is_gone(client):
    row = create(client, profile="mcp").json()
    assert client.delete(f"/api/tokens/{row['id']}").status_code == 200
    assert client.get("/api/tokens").json() == []
    assert client.delete(f"/api/tokens/{row['id']}").status_code == 404
