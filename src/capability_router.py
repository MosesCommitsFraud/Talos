import re
from dataclasses import dataclass


@dataclass(frozen=True)
class CapabilityDecision:
    use_sandbox: bool
    reason: str = ""


_SANDBOX_PATTERNS = [
    r"\b(run|execute|install|build|compile|test|debug|fix|modify|edit|create|write|read|open|list)\b.*\b(code|file|script|command|shell|terminal|repo|project|tests?)\b",
    r"\b(code|file|script|command|shell|terminal|repo|project|tests?)\b.*\b(run|execute|install|build|compile|test|debug|fix|modify|edit|create|write|read|open|list)\b",
    r"\b(bash|shell|terminal|powershell|cmd|python|node|npm|pnpm|yarn|pip|pytest|docker|compose|git)\b",
    r"\b(create|write|edit|modify|delete|rename|move)\b.*\b[a-zA-Z0-9_.-]+\.(py|js|ts|tsx|jsx|json|yaml|yml|md|txt|csv|sql|html|css|sh|ps1)\b",
    r"\b(read|analyze|parse|inspect|load)\b.*\b(uploaded|attached|attachment|csv|json|excel|xlsx|file)\b",
    r"\b(sqlite|database|schema|migration|query the db|run sql)\b",
    r"\b(repo|repository|codebase|workspace|working tree)\b",
    r"\b(erstell|erstelle|schreib|bearbeit|ändere|aendere|lösche|loesche|führe|fuehre|starte|teste|baue|installier|debugg|reparier)\b.*\b(datei|code|skript|befehl|shell|terminal|repo|projekt|tests?)\b",
    r"\b(datei|code|skript|befehl|shell|terminal|repo|projekt|tests?)\b.*\b(erstell|erstelle|schreib|bearbeit|ändere|aendere|lösche|loesche|führe|fuehre|starte|teste|baue|installier|debugg|reparier)\b",
]

_CHAT_ONLY_PATTERNS = [
    r"\b(explain|describe|summarize|what is|what are|why|how does|compare|brainstorm)\b",
    r"\b(erklär|erklaer|beschreib|fass zusammen|was ist|warum|wie funktioniert|vergleiche)\b",
]


def route_capabilities(message: str | None, attachment_ids: list[str] | None = None) -> CapabilityDecision:
    text = (message or "").strip().lower()
    has_attachments = bool(attachment_ids)

    if not text and has_attachments:
        return CapabilityDecision(True, "attachment-only request")

    for pattern in _SANDBOX_PATTERNS:
        if re.search(pattern, text):
            return CapabilityDecision(True, f"matched sandbox pattern: {pattern}")

    if has_attachments and not any(re.search(pattern, text) for pattern in _CHAT_ONLY_PATTERNS):
        return CapabilityDecision(True, "attachments likely need workspace access")

    return CapabilityDecision(False, "chat response is sufficient")
