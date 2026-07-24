---
name: skill-creator
description: "Use this skill whenever the user wants to create, build, author, write, or improve a reusable Talos skill — a packaged SKILL.md (plus optional references/scripts) that teaches the assistant a procedure it should follow for a class of tasks. Trigger on requests like 'make a skill for X', 'turn this workflow into a skill', 'create a skill that…', 'improve the skill Y', or when someone hands over a document/process and asks to capture it as a repeatable skill. Do NOT trigger for one-off tasks the assistant can just do directly, or for editing app settings."
license: MIT
---

# Skill creator (Talos)

You are authoring a **skill**: a `SKILL.md` file (YAML frontmatter + a Markdown
body), optionally bundled with `references/` docs and `scripts/` code. A good
skill makes the assistant reliably do a *class* of tasks the right way. This
guide is adapted for Talos — you draft the skill as files in your workspace,
then save it into the shared library with the `create_skill` tool.

## How skills are loaded (design for this)

Talos discloses a skill in three levels — keep each level small so the model
only pays for what it needs:

1. **Name + description** — always shown to the model. This is what decides
   whether the skill *triggers*. Get this right above all else.
2. **SKILL.md body** — loaded when the skill is consulted. Keep it under ~500
   lines; if it grows past that, move detail into reference files and point to
   them.
3. **Bundled files** (`references/…`, `scripts/…`) — loaded only on demand.
   Reference docs are read when the body points to them; scripts are
   materialized into the workspace and run.

## Workflow

### 1. Capture the intent
Before writing anything, be clear on:
- **What** the skill lets the assistant do, in one sentence.
- **When** it should trigger — the concrete phrasings and file types — and when
  it should NOT (adjacent tasks it must not hijack).
- **What the output is** — a file? an edited document? an answer in a set shape?
- **What it depends on** — tools, libraries, or scripts it needs.

Ask the user about edge cases and success criteria if any of this is unclear;
guessing here produces a skill that misfires.

### 2. Draft SKILL.md in a workspace folder
Create a folder for the skill and write `SKILL.md` into it with `write_file`,
e.g. `skillbuild/SKILL.md`. Frontmatter needs at least `name` and
`description`; the body holds the procedure.

```
skillbuild/
├── SKILL.md          (required)
├── references/       (optional — detailed docs loaded on demand)
└── scripts/          (optional — helper code the skill runs)
```

### 3. Write a *pushy* description
The description is the highest-leverage field — it is the only thing the model
sees when deciding to use the skill, so under-triggering is the common failure.
- State the triggers explicitly: the verbs, the file types, the casual phrasings
  ("the xlsx in my downloads").
- Add an explicit **"Do NOT trigger when…"** clause naming the nearby tasks it
  must not steal.
- Write it as one dense sentence or two; this is not the place to be terse.

### 4. Write the body: explain the *why*, don't shout
- Prefer explaining the reasoning over barking rules. A model follows a rule it
  understands better than one in ALL-CAPS. Reframe "NEVER hardcode values" as
  "write formulas, not computed results, so the sheet recalculates when inputs
  change."
- **Generalize** — don't overfit to one example; the skill should work across
  varied prompts of the same class.
- **Be lean** — cut anything that doesn't change what the assistant does.
- List concrete **requirements for every output** and **known pitfalls +
  recovery**, the way a good runbook does.

### 5. Push detail down into references and scripts
- When the body would exceed ~500 lines, move the deep material into
  `references/<topic>.md` and leave a one-line pointer ("for the full formula
  rules, read references/formulas.md").
- When you find yourself writing the same helper code every run, put it in
  `scripts/<name>.py` and have the body tell the assistant to run it. In Talos,
  a bundled skill's files are materialized under `skills/<name>/` in the
  workspace when the skill is loaded, so its script paths are relative to that
  directory — write the body to run them as `python skills/<name>/scripts/x.py`.

### 6. Save it into the library
Call `create_skill` with `source_dir` pointing at your folder:

```
create_skill  {"source_dir": "skillbuild"}
```

This packages the whole folder (SKILL.md + references + scripts), stores it, and
enables it for you. For a trivial one-file skill you can instead pass
`{"content": "<full SKILL.md text>"}`.

### 7. Test and iterate
Start a **fresh** request that should trigger the skill and watch what happens:
- Did it trigger? If not, the description isn't pushy enough — widen it.
- Did following it produce the intended output? If it stumbled, read where, then
  tighten that step, add a pitfall, or extract a script — and call `create_skill`
  again (same name updates it in place).
- Repeat until a cold run does the task correctly without hand-holding.

## Pitfalls
- **Vague description → the skill never fires.** This is the #1 failure; fix it
  first when a skill "isn't being used."
- **Over-long SKILL.md** buries the procedure. Split into references.
- **Overfitting to your test prompt** makes the skill brittle. Design for the
  class of task.
- **Scripts referenced by a bare `scripts/…` path** won't be found — in Talos
  they live under `skills/<name>/scripts/…` in the workspace once loaded.

## Verification
- The description names its triggers *and* its non-triggers.
- SKILL.md is under ~500 lines; anything longer lives in `references/`.
- A cold run (new chat) triggers the skill and completes the task correctly.
- `create_skill` returned the stored name and expected bundled-file count.
