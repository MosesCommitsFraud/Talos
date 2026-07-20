import ast
from pathlib import Path


def _load_policy_function():
    source = Path("sandbox/sandboxd.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    selected = []
    for node in tree.body:
        is_policy_assignment = isinstance(node, (ast.Assign, ast.AnnAssign)) and (
            "_DISALLOWED_INSTALL_RE" in ast.unparse(node)
        )
        is_policy_function = (
            isinstance(node, ast.FunctionDef) and node.name == "_blocked_install_reason"
        )
        if is_policy_assignment or is_policy_function:
            selected.append(node)
    module = ast.Module(body=[ast.Import(names=[ast.alias(name="re")]), *selected], type_ignores=[])
    module = ast.fix_missing_locations(module)
    namespace = {}
    exec(compile(module, "sandbox/sandboxd.py", "exec"), namespace)
    return namespace["_blocked_install_reason"]


def test_non_python_package_managers_are_blocked():
    blocked = _load_policy_function()
    for command in (
        "apt-get install ffmpeg",
        "sudo apt install curl",
        "npm install lodash",
        "npx playwright install chromium",
        "pnpm dlx create-vite",
        "yarn add react",
        "cargo install ripgrep",
        "echo ok && brew install jq",
    ):
        assert blocked(command), command


def test_python_packages_and_normal_commands_are_allowed():
    blocked = _load_policy_function()
    for command in (
        "python -m pip install python-dateutil",
        "pip install openpyxl",
        "python report.py",
        "sqlite3 data.db 'select 1'",
        "npm test",
    ):
        assert blocked(command) is None, command
