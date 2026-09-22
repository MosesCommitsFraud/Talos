"""SQL Server slips that used to cost whole agent rounds."""

from src.tool_implementations import _adapt_sql_dialect, _sql_error_hint, _validate_readonly_sql


def test_trailing_limit_becomes_top_on_mssql():
    q, note = _adapt_sql_dialect(
        "SELECT * FROM dbo.ent273 WITH (NOLOCK) ORDER BY id273 LIMIT 50", "mssql"
    )
    assert q == "SELECT TOP 50 * FROM dbo.ent273 WITH (NOLOCK) ORDER BY id273"
    assert "TOP 50" in note
    q, _ = _adapt_sql_dialect("SELECT DISTINCT id321 FROM f LIMIT 5", "mssql")
    assert q == "SELECT DISTINCT TOP 5 id321 FROM f"


def test_limit_left_alone_elsewhere_or_when_ambiguous():
    assert _adapt_sql_dialect("SELECT * FROM t LIMIT 5", "postgresql") == (
        "SELECT * FROM t LIMIT 5",
        "",
    )
    assert _adapt_sql_dialect("SELECT TOP 20 * FROM t LIMIT 5", "mssql")[1] == ""
    assert _adapt_sql_dialect("WITH x AS (SELECT 1) SELECT * FROM x LIMIT 5", "mssql")[1] == ""


def test_error_hints_and_multi_statement_message():
    assert "describe" in _sql_error_hint("Invalid column name 'yearseq'", "mssql")
    assert "list_tables" in _sql_error_hint("Invalid object name 'dim273'", "mssql")
    assert "DATENAME" in _sql_error_hint(
        "'MONTHNAME' is not a recognized built-in function name", "mssql"
    )
    assert _sql_error_hint("deadlock", "mssql") == ""
    assert "UNION ALL" in _validate_readonly_sql("SELECT 1; SELECT 2")


def test_file_tool_paths_are_mapped_to_the_workspace():
    from src.tool_execution import _workspace_relative_path

    guessed = "/home/talos/talos_8c69/workspaces/65b15dad8a7d43bf/output/dashboard.html"
    assert _workspace_relative_path(guessed, writing=True) == ("output/dashboard.html", None)
    assert _workspace_relative_path("output/build_dashboard.py", writing=True) == (
        "output/build_dashboard.py",
        None,
    )
    path, problem = _workspace_relative_path("/tmp/make_dashboard.py", writing=True)
    assert "output/make_dashboard.py" in problem
    assert _workspace_relative_path("/opt/talos/vendor/talos_dash.py", writing=False)[1] is None
