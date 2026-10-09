"""deep_research.py — the "Deep research" chat mode.

What the big assistants call deep research (Claude Research, ChatGPT / Gemini
Deep Research) is one recipe, and Talos already has every part of it:

1. **Scope** — settle what a complete answer must cover; ask one clarifying
   question only when the request is too ambiguous to research (``ask_user``).
2. **Plan** — break the question into a few non-overlapping sub-questions and
   show them (``update_plan``), scaled to the question: a narrow question gets
   two or three, a broad comparison or overview five or six.
3. **Fan out** — the main model is the lead researcher; it hands the
   sub-questions to parallel research subagents (``delegate``, src/subagents.py),
   each with a fresh context, its own search loop (broad first, then narrow)
   and a fixed report format. That is the orchestrator-worker pattern from
   Anthropic's write-up of its research system: parallel contexts cover more
   ground in less wall-clock time, and the lead only reads digests.
4. **Check gaps** — the lead reads the reports critically, verifies decisive
   claims itself and sends one or two follow-up waves for what is thin,
   contradictory or outdated (``continue_task`` / ``delegate``).
5. **Report** — a structured, cited report: short answer first, sections by
   theme, tables for comparisons, open questions last.

This module only supplies the instructions and budgets. The protocol rides as
turn context directly before the user's message (src/turn_context.py) — never
in the system prompt — so switching the mode on or off leaves the prefix cache
of the chat intact.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple

# The report and the waves need more rounds and a longer final answer than a
# normal turn; these are floors, an admin's higher limits stay.
_MIN_ROUNDS = 40
_DEFAULT_REPORT_TOKENS = 16384


def _setting(key: str, default):
    try:
        from src.settings import get_setting

        value = get_setting(key, default)
        return default if value is None else value
    except Exception:
        return default


def turn_budget(max_rounds: int, max_tokens: int) -> Tuple[int, int]:
    """Round and output-token limits for a deep-research turn. ``max_tokens``
    0 means "no cap" and stays that way."""
    rounds = max(int(max_rounds or 0), _MIN_ROUNDS)
    if max_tokens and max_tokens > 0:
        try:
            floor = int(_setting("research_max_tokens", _DEFAULT_REPORT_TOKENS))
        except (TypeError, ValueError):
            floor = _DEFAULT_REPORT_TOKENS
        max_tokens = max(int(max_tokens), floor)
    return rounds, max_tokens


_HEAD = """\
## DEEP RESEARCH MODE
The user switched on deep research for this message. Treat it as a research \
project, not a quick answer: being thorough, current and well-sourced matters \
more than being fast. If the message is a plain follow-up that needs no new \
research (a thank-you, a formatting change of your last report, a question \
about it), just answer it normally.

Work in these phases:

**1. Scope.** Decide what a complete answer must cover. Only when the request \
is so ambiguous that the research would likely go in the wrong direction \
(unclear subject, time frame, region, audience or purpose) ask ONE question \
with `ask_user` (2–4 concrete options) and end your turn. Otherwise make a \
sensible interpretation, name it in the plan, and start. If the message \
answers your earlier clarifying question, start the research now.

**2. Plan.** Call `update_plan` with a checklist in the user's language: the \
sub-questions (each one line), then "check gaps" and "write report". Scale \
the effort to the question: a narrow factual question needs 2–3 \
sub-questions, a comparison of several options or a market/literature \
overview 4–6. Sub-questions must not overlap, and together they must cover \
the whole request. Keep the plan current (tick off steps) as you go.
"""

_FANOUT = """\
**3. Research in parallel.** Hand all sub-questions to `delegate` in ONE call \
— one `research` subagent per sub-question, model `small`, NOT in the \
background (you need the reports in this turn). Each prompt must stand \
alone, because the subagent sees nothing else. Write in it:
- the sub-question and how it fits into the overall question;
- what to collect: concrete figures, dates, names, definitions, \
prices/versions, and opposing views or criticism;
- which sources count: primary and official sources, original studies and \
documentation over blogs, SEO pages and aggregators; recent sources when the \
topic changes over time (today's date is in your context);
- the search strategy: start with short, broad queries, look at what exists, \
then narrow down; open and read the most relevant pages instead of relying on \
snippets; several searches in parallel;
- the report format: key findings as bullet points, each with its citation; \
a line on how reliable and how recent the sources are; what stayed open.
Put what you already know into `context` (the user's constraints, names, \
documents, URLs) so the subagent does not search for it again.

**4. Check gaps.** Read the reports critically. Which sub-questions are thin, \
contradicted, outdated, or rest on a single weak source? Verify every claim \
the answer hinges on yourself (`web_fetch` the cited page, `read_knowledge` \
the section). Then send ONE follow-up wave for the gaps: `continue_task` when \
a subagent should dig deeper into material it already has, `delegate` for new \
angles. At most two follow-up waves; stop as soon as new searches only repeat \
what you already have.
"""

_SOLO = """\
**3. Research.** Work through the sub-questions yourself. Start each with \
short, broad searches, then narrow down; run several searches or reads in \
parallel in one round; open and read the most relevant sources instead of \
relying on snippets. Prefer primary and official sources, original studies \
and documentation over blogs and aggregators; prefer recent sources when the \
topic changes over time.

**4. Check gaps.** Before writing, list for yourself which sub-questions are \
thin, contradicted, outdated or rest on a single weak source, and search \
specifically for those. Stop as soon as new searches only repeat what you \
already have.
"""

_REPORT = """\
**5. Write the report** in the user's language, as your final answer in the \
chat (not as a file, unless the user asked for one):
- `#` title, then a short summary: the direct answer to the question in 3–6 \
bullet points;
- sections by theme (not by subagent or by source), with concrete figures, \
dates and names; a table wherever options, products, studies or periods are \
compared;
- a final section on uncertainties: conflicting sources, gaps, what could not \
be verified, and how current the information is;
- a citation right after every factual claim, with the [n] numbers exactly \
as the tool results and reports show them. Never cite a source you did not \
get from a tool, and never present an unverified claim as fact.
Be complete but not padded: no restating of the question, no description of \
your process, no generic advice.
"""


def protocol(*, subagents: bool, web: bool, knowledge: bool, database: bool) -> str:
    """The deep-research instructions for this turn, adapted to the sources
    and helpers the turn actually has."""
    sources = [
        name
        for on, name in (
            (web, "the web (`web_search`, `web_fetch`)"),
            (knowledge, "the user's knowledge base (search/read/grep_knowledge)"),
            (database, "the user's SQL database (`query_sql`)"),
        )
        if on
    ]
    if sources:
        where = "Sources available for this research: " + "; ".join(sources) + "."
        if knowledge:
            where += (
                " When the question concerns the user's own company, products or "
                "documents, research the knowledge base first and the web second."
            )
        if not web:
            where += (
                " The web is switched off for this message: research only these "
                "sources, and say in the report if the question needs current "
                "public information you could not check."
            )
    else:
        where = (
            "No research source is switched on for this message (web, knowledge "
            "base and database are all off). Tell the user in one or two sentences "
            "that deep research needs at least one of them (the composer's + menu), "
            "and do not answer from memory as if it were research."
        )
        return _HEAD.split("Work in these phases:")[0] + "\n" + where
    return "\n".join((_HEAD, where + "\n", _FANOUT if subagents else _SOLO, _REPORT))


def protocol_message(
    *, subagents: bool, web: bool, knowledge: bool, database: bool
) -> Optional[Dict]:
    from src.turn_context import turn_context_message

    return turn_context_message(
        protocol(subagents=subagents, web=web, knowledge=knowledge, database=database)
    )


# Appended to every research subagent's instruction head while the turn runs
# in deep-research mode. Constant text, so the whole wave still shares one
# cacheable prefix.
SUBAGENT_HEAD = """\
- This is part of a deep research project: be thorough. Use several searches \
(broad first, then narrower), open and read the best sources in full, and \
cross-check important figures in a second source. Prefer primary, official \
and recent sources. Report concrete facts (numbers, dates, names, versions), \
note where sources disagree, and end with one line on how reliable and how \
current your sources are and what stayed open.
"""
