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


# ── "Plan" as a name: queries from the model test that SQL Server rejected ──


def _adapted(query):
    return _adapt_sql_dialect(query, "mssql")


def test_plan_as_an_alias_is_bracketed_and_strings_stay():
    query = (
        "SELECT z.Jahr_Monat,\n"
        "       SUM(CASE WHEN f.Q='Plan' THEN f.W END) AS Plan,\n"
        "       SUM(CASE WHEN f.Q='Ist' THEN f.W END) AS Ist\n"
        "FROM (SELECT vdate, c101 AS W, 'Plan' AS Q FROM vspc26t02v01v1) f\n"
        "INNER JOIN dbo.mAI_Zeit z ON z.vdate=f.vdate GROUP BY z.Jahr_Monat"
    )
    rewritten, note = _adapted(query)
    assert rewritten == query.replace("END) AS Plan,", "END) AS [Plan],")
    assert note == "SQL Server: wrote the reserved word Plan as [Plan]"


def test_plan_is_bracketed_wherever_it_is_a_name():
    rewritten, _ = _adapted(
        "WITH ist AS (SELECT id323, SUM(c300) AS v FROM a GROUP BY id323), "
        "plan AS (SELECT id323, SUM(c300) AS v FROM b GROUP BY id323) "
        "SELECT p.v plan, COALESCE(j.plan, 0), SUM(j.Plan) FROM plan p "
        "JOIN j ON j.id323 = p.id323 WHERE plan.v > 0 ORDER BY Plan"
    )
    assert rewritten == (
        "WITH ist AS (SELECT id323, SUM(c300) AS v FROM a GROUP BY id323), "
        "[plan] AS (SELECT id323, SUM(c300) AS v FROM b GROUP BY id323) "
        "SELECT p.v [plan], COALESCE(j.[plan], 0), SUM(j.[Plan]) FROM [plan] p "
        "JOIN j ON j.id323 = p.id323 WHERE [plan].v > 0 ORDER BY [Plan]"
    )


def test_plan_in_text_comments_brackets_and_longer_names_is_left_alone():
    for query in (
        "SELECT 'Plan 2026' AS Quelle, N'It''s the plan' AS t FROM f",
        'SELECT c300 AS [Plan], "Plan" FROM f',
        "SELECT plan_voll, Planwert, p.planung, @plan FROM #plan p",
        "SELECT c300 FROM f -- Ist vs Plan je Monat\nWHERE x = 1 /* der Plan */",
        "SELECT c300 FROM f OPTION (KEEP PLAN)",
        "SELECT c300 FROM f OPTION (USE PLAN N'<ShowPlanXML/>')",
    ):
        assert _adapted(query) == (query, ""), query


def test_plan_and_limit_in_one_query_and_other_dialects():
    rewritten, note = _adapted("SELECT id323, SUM(c300) AS Plan FROM f GROUP BY id323 LIMIT 5")
    assert rewritten == "SELECT TOP 5 id323, SUM(c300) AS [Plan] FROM f GROUP BY id323"
    assert note == ("SQL Server: rewrote LIMIT 5 as TOP 5; wrote the reserved word Plan as [Plan]")
    query = "SELECT SUM(c300) AS Plan FROM f"
    assert _adapt_sql_dialect(query, "postgresql") == (query, "")


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
