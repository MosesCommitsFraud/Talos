"""The query_sql result table (`_build_table_widget`) and its size budget.

This widget is the clearest case of a tool answering twice: the model gets a
25-row preview because rows in context are expensive and it only needs the shape
to write the pandas that does the real work, while the user gets a scrollable,
sortable table an order of magnitude larger. The two must not be able to drift
into each other.
"""

import json

from src.tool_implementations import _SQL_WIDGET_ROWS, _build_table_widget
from src.widgets import MAX_WIDGET_BYTES, sanitize_widget, trim_rows_to_budget

# ── the payload ──


def _rows(n, **overrides):
    base = [{"id": i, "name": f"row {i}", "total": i * 1.5} for i in range(n)]
    for row in base:
        row.update(overrides)
    return base


def test_rows_travel_as_arrays_not_dicts():
    """A result set in dict form repeats every column name once per row, which
    on a wide query is most of the payload and buys nothing — the header already
    carries the names."""
    widget = _build_table_widget(["id", "name"], _rows(3), row_count=3, label="SELECT …")
    data = widget["data"]
    assert data["columns"] == ["id", "name"]
    assert data["rows"] == [[0, "row 0"], [1, "row 1"], [2, "row 2"]]


def test_columns_survive_an_empty_result_set():
    """The columns come from the cursor, not from the rows — otherwise a query
    that matched nothing would render as a table with no headers."""
    widget = _build_table_widget(["id", "name"], [], row_count=0, label="SELECT …")
    assert widget["data"]["columns"] == ["id", "name"]
    assert widget["data"]["rows"] == []
    assert widget["data"]["rowCount"] == 0


def test_a_missing_cell_becomes_null_not_a_gap():
    """Rows are positional once flattened, so a key the row lacks has to hold its
    place — otherwise every later cell shifts one column left."""
    widget = _build_table_widget(["id", "name", "total"], [{"id": 1}], row_count=1, label="")
    assert widget["data"]["rows"] == [[1, None, None]]


def test_the_three_counts_are_reported_separately():
    """How many the query matched, how many are in this payload, and whether the
    rest went to a file — the table shows all three when they disagree."""
    widget = _build_table_widget(
        ["id"], _rows(50), row_count=1284, label="SELECT …", spill_path="orders.csv"
    )
    data = widget["data"]
    assert (data["rowCount"], data["shown"], data["spillPath"]) == (1284, 50, "orders.csv")


def test_the_label_is_capped():
    widget = _build_table_widget(["id"], _rows(1), row_count=1, label="S" * 5000)
    assert len(widget["data"]["label"]) <= 300


def test_the_widget_survives_sanitisation():
    widget = _build_table_widget(["id", "name", "total"], _rows(200), row_count=200, label="q")
    assert sanitize_widget(widget) is not None


def test_the_model_preview_and_the_table_are_different_budgets():
    from src.tool_implementations import _SQL_PREVIEW_ROWS

    assert _SQL_WIDGET_ROWS > _SQL_PREVIEW_ROWS * 10


# ── the size budget ──


def test_narrow_rows_pass_through_untouched():
    rows = [[i, i * 2] for i in range(500)]
    fitted, dropped = trim_rows_to_budget(rows)
    assert dropped == 0
    assert fitted == rows


def test_wide_cells_are_trimmed_rather_than_refused():
    """A single TEXT column full of paragraphs can be worth more than a thousand
    numeric rows. A table showing the first N rows is useful; no table is not."""
    rows = [[i, "x" * 4000] for i in range(200)]
    fitted, dropped = trim_rows_to_budget(rows)
    assert 0 < len(fitted) < 200
    assert dropped == 200 - len(fitted)
    encoded = len(json.dumps(fitted, ensure_ascii=False).encode("utf-8"))
    assert encoded <= MAX_WIDGET_BYTES


def test_a_trimmed_table_still_passes_sanitisation():
    """The point of trimming: `sanitize_widget` would otherwise drop the whole
    widget and the user would get nothing."""
    huge = [{"id": i, "blob": "y" * 5000} for i in range(300)]
    widget = _build_table_widget(["id", "blob"], huge, row_count=300, label="q")
    assert widget["data"]["trimmed"] is True
    assert widget["data"]["shown"] < 300
    assert sanitize_widget(widget) is not None


def test_a_single_unencodable_row_yields_nothing_rather_than_raising():
    fitted, dropped = trim_rows_to_budget([[object()]])
    assert fitted == []
    assert dropped == 1


def test_empty_input_is_not_a_trim():
    assert trim_rows_to_budget([]) == ([], 0)


# ── wiring ──


def test_a_schema_listing_is_split_into_two_columns():
    """`list_tables` is the LONGEST thing query_sql ever returns — a BI schema
    runs to thousands of names. It reached the user as a newline-joined blob
    because the widget was only wired to `query` and `describe`."""
    rows = [
        {"schema": "dbo", "table": "dim1"},
        {"schema": "client_spark_user20", "table": "pivot_ctx_1234"},
        {"schema": "", "table": "unqualified"},
    ]
    widget = _build_table_widget(["schema", "table"], rows, row_count=5800, label="5800 tables")
    data = widget["data"]
    assert data["columns"] == ["schema", "table"]
    assert data["rows"][0] == ["dbo", "dim1"]
    assert data["rows"][1] == ["client_spark_user20", "pivot_ctx_1234"]
    # A name with no schema keeps its column rather than shifting left.
    assert data["rows"][2] == ["", "unqualified"]
    # The total is the whole schema, not the windowed payload.
    assert data["rowCount"] == 5800


def test_table_is_a_registered_widget_type():
    from src.widgets import WIDGET_TYPES

    assert "table" in WIDGET_TYPES


def test_the_table_payload_is_not_echoed_into_model_context():
    """`output` already carries the markdown preview; the payload would put the
    same rows in context a second time as raw JSON."""
    from src.tool_execution import format_tool_result

    widget = _build_table_widget(["id", "secretcol"], [{"id": 1, "secretcol": "leaked"}], 1, "q")
    text = format_tool_result(
        "query_sql",
        {"output": "| id |\n| 1 |", "widget": widget, "rows": [], "exit_code": 0},
    )
    assert "leaked" not in text
    assert "secretcol" not in text
