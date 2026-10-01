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


def _expand(listing: str) -> set:
    """Rebuild every table name from a compact listing (inverse of the format)."""
    import re

    names = set()
    lines = listing.splitlines()[1:]
    for line in lines:
        m = re.match(r"^(.*)<N> \(\d+\): (.*)$", line)
        if m:
            stem = m.group(1)
            for part in m.group(2).split(", "):
                lo, _, hi = part.partition("–")
                width = len(lo) if lo.startswith("0") and len(lo) > 1 else 0
                for n in range(int(lo), int(hi or lo) + 1):
                    names.add(stem + (str(n).zfill(width) if width else str(n)))
        elif line != "Other tables/views:":
            names.add(line)
    return names


def test_compact_table_list_is_lossless():
    names = (
        [f"dbo.ent{n}" for n in (200, 202, *range(244, 264), 561, 3002)]
        + [f"dbo.dim{n}" for n in range(1, 125)]
        + [f"sales.log_{y}" for y in (2023, 2024, 2025)]
        + [f"dbo.t{n:02d}" for n in range(1, 13)]  # zero-padded: t01…t12
        + ["dbo.t1", "dbo.t2", "dbo.entdef", "dbo.MACSTABS", "public.kunden", "x5"]
    )
    names = sorted(names)
    out = ti._compact_table_list(names)
    assert _expand(out) == set(names)
    assert "dbo.dim<N> (124): 1–124" in out
    assert len(out) < len("\n".join(names)) / 3


def test_short_listing_stays_plain():
    names = ["a1", "a2", "a3", "b"]
    assert ti._compact_table_list(names) == "a1\na2\na3\nb"


def test_table_pattern_filter():
    names = ["dbo.kunden_2024", "dbo.kunden_2025", "sales.Kunden_alt", "dbo.orders"]
    assert ti._filter_table_names(names, "kunden%") == names[:3]
    assert ti._filter_table_names(names, "dbo.%2025") == ["dbo.kunden_2025"]


async def test_list_tables_with_pattern(db):
    con, _ = db
    for y in (2023, 2024, 2025):
        con.execute(f"CREATE TABLE log_{y} (id INTEGER)")
    con.commit()
    out = await ti.do_query_sql(json.dumps({"action": "list_tables", "pattern": "%log%"}))
    assert out["exit_code"] == 0
    assert "log_2024" in out["output"] and "kunden" not in out["output"]
