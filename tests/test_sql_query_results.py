"""query_sql result handling against a throwaway SQLite database."""

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
    yield con, url
    con.close()


def test_dialect_note_follows_the_connection_url(db):
    _, url = db
    assert "LIMIT n" in ti.sql_dialect_note({"_url": url})
    assert "TOP n" in ti.sql_dialect_note({"_url": "mssql+pymssql://u:p@h/db"})
    assert ti.sql_dialect_note({"_url": "oracle://u:p@h/db"}) == ""


def test_schema_action_alias_is_describe():
    assert ti._normalize_sql_action("schema", {}) == "describe"


async def test_narrow_long_results_stay_inline(db):
    con, _ = db
    con.executemany("INSERT INTO kunden (name) VALUES (?)", [(f"K{i}",) for i in range(300)])
    con.commit()
    out = await ti.do_query_sql(json.dumps({"query": "SELECT id, name FROM kunden"}))
    assert out["exit_code"] == 0
    assert "K299" in out["output"] and "written to" not in out["output"]
