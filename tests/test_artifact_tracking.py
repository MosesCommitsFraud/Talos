from pathlib import Path

from sandbox.sandboxd import _artifact_snapshot, _changed_artifacts


def test_changed_artifacts_reports_new_and_modified_files(tmp_path: Path):
    existing = tmp_path / "report.txt"
    existing.write_text("before", encoding="utf-8")
    before = _artifact_snapshot(tmp_path)

    existing.write_text("after with more content", encoding="utf-8")
    (tmp_path / "results.xlsx").write_bytes(b"sheet")

    assert _changed_artifacts(tmp_path, before) == ["report.txt", "results.xlsx"]


def test_artifact_snapshot_ignores_runtime_noise(tmp_path: Path):
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "module.pyc").write_bytes(b"bytecode")
    (tmp_path / "answer.csv").write_text("a,b\n1,2\n", encoding="utf-8")

    assert _artifact_snapshot(tmp_path) == {
        "answer.csv": (
            (tmp_path / "answer.csv").stat().st_size,
            (tmp_path / "answer.csv").stat().st_mtime_ns,
        )
    }
