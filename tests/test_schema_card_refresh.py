"""The schema map is rebuilt when — and only when — the schema changes."""

import json
import sqlite3

import pytest

from src import tool_implementations as ti


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "shop.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE kunden (id INTEGER PRIMARY KEY, name TEXT)")
    con.commit()
    url = f"sqlite:///{path.as_posix()}"
    monkeypatch.setattr(ti, "_sql_connections", lambda: [{"name": "shop", "_url": url}])
    monkeypatch.setattr(ti, "_schema_card_cache", {})
    monkeypatch.setattr(ti, "_schema_card_locks", {})
    # Every call re-checks the fingerprint; the dedupe window is tested apart.
    monkeypatch.setattr(ti, "_SCHEMA_CARD_RECHECK_SECONDS", 0)
    builds = []
    real_build = ti._build_schema_card_sync

    def counting_build(u):
        builds.append(u)
        return real_build(u)

    monkeypatch.setattr(ti, "_build_schema_card_sync", counting_build)
    yield con, builds
    con.close()


def test_unchanged_schema_is_served_from_cache(db):
    con, builds = db
    first = ti.get_schema_card()
    assert "kunden" in first and len(builds) == 1
    # Row changes don't touch the structure fingerprint.
    con.execute("INSERT INTO kunden (name) VALUES ('Muster GmbH')")
    con.commit()
    assert ti.get_schema_card() == first
    assert len(builds) == 1


def test_schema_change_triggers_a_rebuild(db):
    con, builds = db
    ti.get_schema_card()
    con.execute("CREATE TABLE auftraege (id INTEGER PRIMARY KEY, kunde_id INTEGER)")
    con.commit()
    card = ti.get_schema_card()
    assert "auftraege" in card and len(builds) == 2
    con.execute("ALTER TABLE auftraege ADD COLUMN betrag REAL")
    con.commit()
    assert "betrag" in ti.get_schema_card() and len(builds) == 3


def test_recent_check_skips_the_catalog_query(db, monkeypatch):
    _, builds = db
    monkeypatch.setattr(ti, "_SCHEMA_CARD_RECHECK_SECONDS", 3600)
    ti.get_schema_card()
    monkeypatch.setattr(ti, "_schema_fingerprint_sync", lambda url: pytest.fail("re-checked"))
    ti.get_schema_card()
    assert len(builds) == 1


def test_engine_without_fingerprint_falls_back_to_ttl(db, monkeypatch):
    _, builds = db
    monkeypatch.setattr(ti, "_schema_fingerprint_sync", lambda url: None)
    ti.get_schema_card()
    ti.get_schema_card()
    assert len(builds) == 1
    monkeypatch.setattr(ti, "_SCHEMA_CARD_TTL_SECONDS", 0)
    ti.get_schema_card()
    assert len(builds) == 2


async def test_query_sql_schema_map_action(db):
    out = await ti.do_query_sql(json.dumps({"action": "schema_map"}))
    assert out["exit_code"] == 0 and "kunden" in out["output"]
    # "schema" without a table is the map, with a table it's describe.
    assert ti._normalize_sql_action("schema", {}) == "schema_map"
    assert ti._normalize_sql_action("schema", {"table": "kunden"}) == "describe"
