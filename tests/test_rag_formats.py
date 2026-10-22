"""Formats beyond Docling: containers, e-mails, legacy Office, subtitles, unknown files."""

import os
import zipfile
from email.message import EmailMessage

import pytest

from src import rag_documents as rd
from src import rag_formats as rf
from tests.test_rag_document_register import contents, env, upload  # noqa: F401  (fixture)


def make_zip(path, members):
    with zipfile.ZipFile(path, "w") as z:
        for name, text in members.items():
            z.writestr(name, text)
    return str(path)


def make_eml(path, body, attachments=()):
    msg = EmailMessage()
    msg["Subject"] = "Angebot Projekt Nord"
    msg["From"] = "Anna <anna@example.com>"
    msg["To"] = "team@example.com"
    msg["Date"] = "Tue, 20 Oct 2026 10:00:00 +0200"
    msg.set_content(body)
    for name, data in attachments:
        msg.add_attachment(data, maintype="text", subtype="markdown", filename=name)
    path.write_bytes(bytes(msg))
    return str(path)


# --------------------------------------------------------------- units


def test_zip_unpacking_skips_traversal_and_junk(tmp_path):
    archive = make_zip(
        tmp_path / "a.zip",
        {
            "docs/plan.md": "plan",
            "../evil.md": "x",
            "__MACOSX/._plan.md": "junk",
            "docs/.DS_Store": "junk",
        },
    )
    members = rf.container_members(archive, tmp_path / "out")
    assert [rel for rel, _ in members] == ["docs/plan.md"]
    assert not (tmp_path / "evil.md").exists()


def test_zip_member_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(rf, "MAX_MEMBERS", 2)
    archive = make_zip(tmp_path / "a.zip", {f"{n}.md": "x" for n in range(3)})
    with pytest.raises(rf.FormatError, match="limit"):
        rf.container_members(archive, tmp_path / "out")


def test_email_text_and_attachments(tmp_path):
    mail = make_eml(
        tmp_path / "m.eml", "Hallo Team,\nanbei das Angebot.", [("Angebot.md", b"Preis 10")]
    )
    text, meta = rf.email_text(mail)
    assert text.startswith("# Angebot Projekt Nord")
    assert "From: Anna <anna@example.com>" in text and "Attachments: Angebot.md" in text
    assert "anbei das Angebot" in text
    assert meta["email_subject"] == "Angebot Projekt Nord"
    [(rel, path)] = rf.container_members(mail, tmp_path / "att")
    assert rel == "Angebot.md" and path.read_bytes() == b"Preis 10"


def test_msg_without_extract_msg_explains_what_to_do(tmp_path, monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_extract_msg(name, *args, **kwargs):
        if name == "extract_msg":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_extract_msg)
    path = tmp_path / "m.msg"
    path.write_bytes(b"\xd0\xcf\x11\xe0")
    with pytest.raises(rf.FormatError, match=r"\.eml"):
        rf.email_text(str(path))


def test_subtitles_become_timed_segments():
    srt = (
        "1\n00:00:01,000 --> 00:00:04,000\nHallo und willkommen.\n\n"
        "2\n00:00:30,500 --> 00:00:33,000\n<i>Heute geht es um</i> Reisekosten.\n\n"
        "3\n00:01:05,000 --> 00:01:08,000\nZweiter Teil.\n"
    )
    cues = rf.subtitle_cues(srt)
    assert cues[1] == (30.5, 33.0, "Heute geht es um Reisekosten.")
    segments = rf.subtitle_segments(cues, window=60)
    assert [(s, e) for s, e, _ in segments] == [(1.0, 33.0), (65.0, 68.0)]
    vtt = "WEBVTT\n\n00:00:02.000 --> 00:00:03.500\nKurz.\n"
    assert rf.subtitle_cues(vtt) == [(2.0, 3.5, "Kurz.")]


def test_text_sniffing(tmp_path):
    text = tmp_path / "notes.log"
    text.write_text("Fehler beim Import: Größe überschritten\n" * 50, encoding="utf-8")
    binary = tmp_path / "blob.bin"
    binary.write_bytes(bytes(range(256)) * 10)
    assert rf.looks_like_text(str(text))
    assert not rf.looks_like_text(str(binary))


def test_legacy_office_without_libreoffice_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(rf, "soffice", lambda: None)
    doc = tmp_path / "alt.doc"
    doc.write_bytes(b"\xd0\xcf\x11\xe0")
    with rf.Workdir() as work, pytest.raises(rf.FormatError, match="LibreOffice"):
        rf.converted_copy(str(doc), work)
    docm = tmp_path / "makro.docm"
    docm.write_bytes(b"PK")
    with rf.Workdir() as work:
        assert rf.converted_copy(str(docm), work).endswith("makro.docx")


# --------------------------------------------------------------- through the register


def test_zip_members_are_documents_and_follow_new_versions(env):  # noqa: F811
    rag, uploads, _ = env
    archive = make_zip(
        uploads / "Akte-a.zip", {"Vertrag.md": "Vertrag v1", "Anlage/Plan.md": "Plan"}
    )
    meta = {"source": archive, "filename": "Akte.zip", **rd.upload_identity("Akte.zip")}
    result = rag.index_files([(archive, meta)])
    assert result["outcomes"]["indexed"] == 2 and result["outcomes"]["container"] == 1
    rows = {d["filename"]: d for d in rag.list_documents()}
    assert rows["Akte.zip"]["status"] == "container"
    assert rows["Plan.md"]["logical_path"] == "Akte.zip/Anlage/Plan.md"

    again = rag.index_files([(archive, dict(meta))])
    assert again["outcomes"]["unchanged"] == 1

    archive2 = make_zip(uploads / "Akte-b.zip", {"Vertrag.md": "Vertrag v2"})
    meta2 = {"source": archive2, "filename": "Akte.zip", **rd.upload_identity("Akte.zip")}
    result = rag.index_files([(archive2, meta2)])
    assert result["outcomes"]["updated"] == 1 and result["outcomes"]["deleted"] == 1
    assert contents(rag) == ["Vertrag v2"]

    container = rd.make_doc_id("Akte.zip")
    rag.delete_document(doc_id=container)
    assert contents(rag) == []
    assert rag.list_documents() == []
    assert not (uploads / "_extracted" / container).exists()


def test_email_is_a_document_with_its_attachments(env):  # noqa: F811
    rag, uploads, _ = env
    mail = make_eml(uploads / "Angebot-a.eml", "Bitte prüfen.", [("Kalkulation.md", b"Summe 42")])
    meta = {"source": mail, "filename": "Angebot.eml", **rd.upload_identity("Angebot.eml")}
    result = rag.index_files([(mail, meta)])
    assert result["outcomes"]["indexed"] == 2
    texts = contents(rag)
    assert any("Bitte prüfen." in t and "Angebot Projekt Nord" in t for t in texts)
    assert "Summe 42" in texts
    rows = {d["filename"]: d for d in rag.list_documents()}
    assert rows["Kalkulation.md"]["logical_path"] == "Angebot.eml/Kalkulation.md"
    rag.delete_document(source=mail)
    assert contents(rag) == []


def test_unknown_binary_is_not_indexed_as_garbage(env, monkeypatch):  # noqa: F811
    rag, uploads, _ = env
    import src.markitdown_runtime as mdr

    monkeypatch.setattr(mdr, "convert_to_markdown", lambda path: None)
    blob = uploads / "daten-a.bin"
    blob.write_bytes(bytes(range(256)) * 20)
    meta = {"source": str(blob), "filename": "daten.bin", **rd.upload_identity("daten.bin")}
    result = rag.index_files([(str(blob), meta)])
    assert result["outcomes"]["failed"] == 1
    assert "Unsupported format" in result["errors"][0]["error"]
    assert contents(rag) == []


def test_subtitle_upload_is_searchable_by_time(env):  # noqa: F811
    rag, uploads, _ = env
    sub = uploads / "Schulung-a.srt"
    sub.write_text("1\n00:02:00,000 --> 00:02:05,000\nReisekosten erklärt.\n", encoding="utf-8")
    meta = {"source": str(sub), "filename": "Schulung.srt", **rd.upload_identity("Schulung.srt")}
    rag.index_files([(str(sub), meta)])
    [doc] = rag._read_documents()
    assert doc.meta["start"] == 120.0 and doc.meta["modality"] == "video"
    assert os.path.basename(doc.meta["source"]) == "Schulung-a.srt"


# --------------------------------------------------------------- folder uploads


def test_relative_paths_are_cleaned():
    assert rd.clean_relative_path("Projekte\\Nord/../x/./Plan.pdf") == "Projekte/Nord/x/Plan.pdf"
    assert rd.clean_relative_path("C:/Users/a/b.md") == "Users/a/b.md"
    assert rd.upload_identity("Plan.pdf", "Nord/Plan.pdf") == {
        "logical_path": "Nord/Plan.pdf",
        "origin": "upload",
        "folder": "Nord",
    }
    assert rd.upload_identity("Plan.pdf", "Plan.pdf")["logical_path"] == "Plan.pdf"
    assert rd.upload_identity("Plan.pdf", "")["logical_path"] == "Plan.pdf"


def test_same_name_in_different_folders_are_two_documents(env):  # noqa: F811
    rag, uploads, _ = env
    for folder, text, suffix in (("Nord", "Protokoll Nord", "a"), ("Sued", "Protokoll Süd", "b")):
        path = uploads / f"Protokoll-{suffix}.md"
        path.write_text(text, encoding="utf-8")
        meta = {
            "source": str(path),
            "filename": "Protokoll.md",
            **rd.upload_identity("Protokoll.md", f"Projekte/{folder}/Protokoll.md"),
        }
        rag.index_files([(str(path), meta)])
    assert contents(rag) == ["Protokoll Nord", "Protokoll Süd"]
    assert sorted(d["logical_path"] for d in rag.list_documents()) == [
        "Projekte/Nord/Protokoll.md",
        "Projekte/Sued/Protokoll.md",
    ]


def test_upload_route_passes_folder_paths(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import routes.personal_routes as personal
    import src.rag_worker as worker
    from core.middleware import require_admin

    monkeypatch.setattr(personal, "UPLOADS_DIR", str(tmp_path))
    queued = []
    monkeypatch.setattr(
        worker,
        "start_index_files",
        lambda files, owner=None, base_id=None: queued.append(files) or {"id": "j1"},
    )
    app = FastAPI()
    app.include_router(personal.setup_personal_routes(None, None, False))
    app.dependency_overrides[require_admin] = lambda: None
    client = TestClient(app)
    res = client.post(
        "/api/personal/upload",
        files=[
            ("files", ("Protokoll.md", b"nord", "text/markdown")),
            ("files", ("Lose.md", b"lose", "text/markdown")),
        ],
        data={"paths": ["Projekte/Nord/Protokoll.md", ""]},
    )
    assert res.status_code == 200, res.text
    [(first, nord), (_, lose)] = queued[0]
    assert (
        nord["logical_path"] == "Projekte/Nord/Protokoll.md" and nord["folder"] == "Projekte/Nord"
    )
    assert lose["logical_path"] == "Lose.md" and "folder" not in lose
    assert os.path.dirname(first) == os.path.join(str(tmp_path), "global")
