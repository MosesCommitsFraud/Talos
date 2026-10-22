"""File formats the RAG ingest reads beyond what Docling handles directly.

* **Containers** — ZIP archives and e-mails (.eml, .msg) hold other files.
  ``container_members`` unpacks them into a managed directory so every member
  becomes a document of its own (with its own hash, version and lane), and an
  e-mail additionally contributes its own text (``email_text``).
* **Legacy and macro Office** — .doc/.ppt/.rtf are converted with LibreOffice
  (headless); .docm/.pptm/.xlsm are the OOXML formats under another name.
* **Subtitles** — .srt/.vtt become timed transcript segments, like ASR output.
* **Anything else** — text if it decodes as text, MarkItDown otherwise.

Everything here is pure file handling: no Qdrant, no embeddings, so it is
testable without the RAG stack.
"""

from __future__ import annotations

import email
import email.policy
import logging
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

ARCHIVE_EXTS = {".zip"}
EMAIL_EXTS = {".eml", ".msg"}
CONTAINER_EXTS = ARCHIVE_EXTS | EMAIL_EXTS
SUBTITLE_EXTS = {".srt", ".vtt"}
# Converted with LibreOffice before the usual Office lanes see them.
LEGACY_OFFICE = {".doc": "docx", ".rtf": "docx", ".ppt": "pptx"}
# Same container format as .docx/.pptx/.xlsx, with macros: read as such.
MACRO_OFFICE = {".docm": ".docx", ".pptm": ".pptx", ".xlsm": ".xlsx"}

# Unpacking limits: a hostile or broken archive must not fill the disk or
# turn one upload into an unbounded ingest.
MAX_MEMBERS = int(os.getenv("RAG_ARCHIVE_MAX_MEMBERS", "2000"))
MAX_UNPACKED_BYTES = int(os.getenv("RAG_ARCHIVE_MAX_BYTES", str(4 * 1024**3)))
MAX_DEPTH = 3
_SKIP_PARTS = {"__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini"}


class FormatError(RuntimeError):
    """A file this module cannot read, with a message meant for the user."""


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------


def _safe_member_path(name: str) -> Optional[str]:
    """Archive member name → safe relative path, or None to skip it."""
    parts = [p for p in PurePosixPath(name.replace("\\", "/")).parts if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or parts[0].endswith(":"):
        return None
    if any(p in _SKIP_PARTS or p.startswith("._") for p in parts):
        return None
    return "/".join(parts)


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for n in range(2, 10000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise FormatError(f"Too many files named {path.name}")


def unpack_zip(path: str, target: Path) -> List[Tuple[str, Path]]:
    """Extract an archive's files into ``target``; returns (member path, file)."""
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise FormatError(f"Not a readable ZIP archive: {e}") from e
    out: List[Tuple[str, Path]] = []
    total = 0
    with archive:
        infos = [i for i in archive.infolist() if not i.is_dir()]
        if len(infos) > MAX_MEMBERS:
            raise FormatError(
                f"Archive holds {len(infos)} files; the limit is {MAX_MEMBERS} "
                "(RAG_ARCHIVE_MAX_MEMBERS)."
            )
        for info in infos:
            if info.flag_bits & 0x1:
                raise FormatError("Encrypted ZIP archives cannot be indexed.")
            rel = _safe_member_path(info.filename)
            if rel is None:
                continue
            total += info.file_size
            if total > MAX_UNPACKED_BYTES:
                raise FormatError(
                    "Archive unpacks to more than the allowed size (RAG_ARCHIVE_MAX_BYTES)."
                )
            dest = target / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(dest, "wb") as fh:
                shutil.copyfileobj(src, fh, 1024 * 1024)
            out.append((rel, dest))
    return out


def _decode_header(value: Any) -> str:
    return str(value or "").strip()


def _html_to_text(html: str) -> str:
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "head"]):
            tag.decompose()
        text = soup.get_text("\n")
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _parse_eml(path: str) -> Dict[str, Any]:
    with open(path, "rb") as fh:
        msg = email.message_from_binary_file(fh, policy=email.policy.default)
    plain = html = ""
    attachments: List[Tuple[str, bytes]] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        disposition = (part.get_content_disposition() or "").lower()
        if filename or disposition == "attachment":
            payload = part.get_payload(decode=True) or b""
            if part.get_content_type() == "message/rfc822" and not payload:
                inner = part.get_payload()
                payload = inner[0].as_bytes() if isinstance(inner, list) and inner else b""
            attachments.append((filename or "attachment.eml", payload))
            continue
        ctype = part.get_content_type()
        try:
            content = part.get_content()
        except Exception:
            content = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
        if ctype == "text/plain" and not plain:
            plain = str(content)
        elif ctype == "text/html" and not html:
            html = str(content)
    return {
        "subject": _decode_header(msg.get("subject")),
        "from": _decode_header(msg.get("from")),
        "to": _decode_header(msg.get("to")),
        "cc": _decode_header(msg.get("cc")),
        "date": _decode_header(msg.get("date")),
        "body": plain.strip() or _html_to_text(html),
        "attachments": attachments,
    }


def _parse_msg(path: str) -> Dict[str, Any]:
    try:
        import extract_msg  # optional dependency (requirements-optional.txt)
    except ImportError as e:
        raise FormatError(
            "Outlook .msg files need the optional 'extract-msg' package "
            "(requirements-optional.txt). Save the mail as .eml instead."
        ) from e
    msg = extract_msg.Message(path)
    try:
        attachments = []
        for att in msg.attachments:
            name = getattr(att, "longFilename", None) or getattr(att, "shortFilename", None)
            data = getattr(att, "data", None)
            if isinstance(data, bytes):
                attachments.append((name or "attachment", data))
            elif data is not None and hasattr(data, "asBytes"):
                # An attached Outlook item: keep it as a .msg of its own.
                attachments.append(((name or "attachment") + ".msg", data.asBytes()))
        body = msg.body or ""
        if not body.strip() and getattr(msg, "htmlBody", None):
            raw = msg.htmlBody
            body = _html_to_text(raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw)
        return {
            "subject": _decode_header(msg.subject),
            "from": _decode_header(msg.sender),
            "to": _decode_header(msg.to),
            "cc": _decode_header(msg.cc),
            "date": _decode_header(msg.date),
            "body": body.strip(),
            "attachments": attachments,
        }
    finally:
        try:
            msg.close()
        except Exception:
            pass


def parse_email(path: str) -> Dict[str, Any]:
    ext = Path(path).suffix.lower()
    if ext == ".msg":
        return _parse_msg(path)
    return _parse_eml(path)


def email_text(path: str) -> Tuple[str, Dict[str, Any]]:
    """The mail itself as indexable text, plus header metadata for its chunks."""
    mail = parse_email(path)
    lines = [f"# {mail['subject'] or '(no subject)'}", ""]
    for label, key in (("From", "from"), ("To", "to"), ("Cc", "cc"), ("Date", "date")):
        if mail[key]:
            lines.append(f"{label}: {mail[key]}")
    names = [n for n, _ in mail["attachments"]]
    if names:
        lines.append("Attachments: " + ", ".join(names))
    lines += ["", mail["body"]]
    meta = {
        "email_subject": mail["subject"],
        "email_from": mail["from"],
        "email_to": mail["to"],
        "email_date": mail["date"],
    }
    return "\n".join(lines).strip(), meta


def unpack_email(path: str, target: Path) -> List[Tuple[str, Path]]:
    out: List[Tuple[str, Path]] = []
    for name, data in parse_email(path)["attachments"]:
        rel = _safe_member_path(os.path.basename(name.replace("\\", "/"))) or "attachment"
        dest = _unique(target / rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        out.append((dest.relative_to(target).as_posix(), dest))
    return out


def container_members(path: str, target: Path) -> List[Tuple[str, Path]]:
    """Unpack a ZIP or the attachments of an e-mail into ``target`` (emptied first)."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    ext = Path(path).suffix.lower()
    if ext in ARCHIVE_EXTS:
        return unpack_zip(path, target)
    if ext in EMAIL_EXTS:
        return unpack_email(path, target)
    raise FormatError(f"{ext} is not a container format")


# ---------------------------------------------------------------------------
# Office conversion
# ---------------------------------------------------------------------------


def soffice() -> Optional[str]:
    return shutil.which("soffice") or shutil.which("libreoffice")


def converted_copy(path: str, workdir: str) -> str:
    """A copy of a legacy/macro Office file the regular lanes can read."""
    ext = Path(path).suffix.lower()
    if ext in MACRO_OFFICE:
        dest = os.path.join(workdir, Path(path).stem + MACRO_OFFICE[ext])
        shutil.copyfile(path, dest)
        return dest
    target = LEGACY_OFFICE.get(ext)
    if not target:
        raise FormatError(f"No conversion for {ext}")
    binary = soffice()
    if not binary:
        raise FormatError(
            f"{ext} files need LibreOffice for conversion, which is not installed in the "
            "ingest worker. Save the file as ."
            + target
            + " (or build the image with INSTALL_OPTIONAL=true)."
        )
    timeout = int(os.getenv("RAG_SOFFICE_TIMEOUT", "300"))
    # A private profile per call: concurrent soffice runs sharing one profile
    # fail with a lock error, and the worker may have no writable $HOME.
    profile = Path(workdir) / "lo-profile"
    cmd = [
        binary,
        f"-env:UserInstallation={profile.as_uri()}",
        "--headless",
        "--convert-to",
        target,
        "--outdir",
        workdir,
        path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise FormatError(f"LibreOffice conversion timed out after {timeout}s") from e
    except subprocess.CalledProcessError as e:
        detail = (e.stderr or b"").decode("utf-8", "replace").strip()[:300]
        raise FormatError(f"LibreOffice could not convert the file: {detail}") from e
    out = os.path.join(workdir, Path(path).stem + "." + target)
    if not os.path.isfile(out):
        raise FormatError("LibreOffice produced no output file")
    return out


class Workdir:
    """Temporary directory for one conversion, removed afterwards."""

    def __enter__(self) -> str:
        self.path = tempfile.mkdtemp(prefix="talos-convert-")
        return self.path

    def __exit__(self, *exc) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


# ---------------------------------------------------------------------------
# Subtitles
# ---------------------------------------------------------------------------

_CUE_TIME = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
)


def _seconds(h, m, s, ms) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000


def subtitle_cues(text: str) -> List[Tuple[float, float, str]]:
    """Parse SRT or WebVTT into (start, end, text) cues."""
    cues: List[Tuple[float, float, str]] = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n")):
        lines = [ln for ln in block.strip().split("\n") if ln.strip()]
        for i, line in enumerate(lines):
            m = _CUE_TIME.search(line)
            if not m:
                continue
            start = _seconds(*m.group(1, 2, 3, 4))
            end = _seconds(*m.group(5, 6, 7, 8))
            body = " ".join(re.sub(r"<[^>]+>", "", ln).strip() for ln in lines[i + 1 :])
            if body.strip():
                cues.append((start, end, body.strip()))
            break
    return cues


def subtitle_segments(
    cues: List[Tuple[float, float, str]], window: float = 60.0
) -> List[Tuple[float, float, str]]:
    """Merge cues into ~``window``-second segments (what ASR produces too)."""
    segments: List[Tuple[float, float, str]] = []
    start = end = None
    parts: List[str] = []
    for s, e, t in cues:
        if start is None:
            start = s
        if s - start >= window and parts:
            segments.append((start, end, " ".join(parts)))
            start, parts = s, []
        parts.append(t)
        end = e
    if parts:
        segments.append((start, end, " ".join(parts)))
    return segments


# ---------------------------------------------------------------------------
# Unknown formats
# ---------------------------------------------------------------------------


def looks_like_text(path: str, probe: int = 8192) -> bool:
    """True when the file's head decodes as UTF-8 (or Latin-1) text without NULs."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(probe)
    except OSError:
        return False
    if not head:
        return True
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError as e:
        # A multi-byte character cut by the probe boundary is still text.
        if e.start >= len(head) - 4:
            return True
    printable = sum(1 for b in head if b in (9, 10, 13) or 32 <= b < 127 or b >= 160)
    return printable / len(head) > 0.95
