import type { ToolCall } from '@/api/types';

/** Minimal shape of i18next's `t` — keeps this module free of react-i18next
 *  types so it stays plain and unit-testable. */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Tool families that share one phrasing. Anything not listed falls back to the
 *  generic "Running <tool>" / "Ran <tool>" wording, so a new backend tool (or an
 *  MCP tool with an arbitrary name) still renders sensibly. */
const FAMILY: Record<string, string> = {
  bash: 'command',
  // Not 'command': a shell line reads as a label, a Python block does not —
  // "Ran import pandas as pd" is the first line of a 60-line script.
  python: 'code',
  run_cell: 'code',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  create_document: 'document',
  edit_document: 'document',
  update_document: 'document',
  suggest_document: 'document',
  grep: 'grep',
  glob: 'glob',
  ls: 'ls',
  query_sql: 'sql',
  search_knowledge: 'knowledge',
  web_search: 'web',
  web_fetch: 'fetch',
  get_weather: 'weather',
  get_news: 'news',
  generate_image: 'image',
  show_image: 'image',
  browse_skills: 'skills',
  read_skill: 'skills',
  manage_skills: 'skillManage',
  create_skill: 'skillNew',
  search_chats: 'chats',
  background_task: 'task',
  expand_output: 'expand',
  update_plan: 'plan',
  ask_user: 'ask',
  // The UI calls a session a "chat", so the labels must too.
  create_session: 'chatNew',
  list_sessions: 'chatsList',
  send_to_session: 'chatSend',
  manage_session: 'chatManage',
  manage_documents: 'docsManage',
  manage_settings: 'settings',
  list_models: 'models',
  api_call: 'api',
  // The three server-admin tools share one phrasing: they are rare, and their
  // `action` argument already says which knob was turned.
  manage_endpoints: 'admin',
  manage_mcp: 'admin',
  manage_tokens: 'admin',
};

/** Families whose subject is their `action` argument ("Changed settings: set").
 *  These tools are dispatchers — the action is the only part worth a label. */
const ACTION_SUBJECT = new Set(['chatManage', 'docsManage', 'settings', 'skillManage', 'admin']);

export function toolFamily(tool: string): string {
  return FAMILY[tool] ?? 'generic';
}

/** First line only. `command` carries the raw tool block, and for write_file
 *  that is `path\n<entire file>` — never put the body in a label. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/** A subject is only elided when the LINE is too wide for the chat column,
 *  which is a CSS question the label box answers with `text-overflow`. Cutting
 *  at a character count here instead put an ellipsis on labels that had room to
 *  spare. This cap exists purely so a pathological argument — a pasted file, a
 *  minified blob — cannot put kilobytes of text into the DOM to be measured; it
 *  sits far past anything a chat column can show. */
const SUBJECT_MAX = 300;

function clip(text: string): string {
  return text.length > SUBJECT_MAX ? `${text.slice(0, SUBJECT_MAX - 1)}…` : text;
}

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const cut = clean.split(/[\\/]/).pop() ?? clean;
  return cut || path;
}

/** The object of the sentence: a filename, a search pattern, a URL host. Tools
 *  send either a JSON argument blob or a bare first line (see
 *  `_parse_sandbox_file_payload` on the backend), so try JSON first. */
export function callSubject(call: ToolCall): string {
  const raw = (call.command ?? '').trim();
  if (!raw) return '';
  let args: Record<string, unknown> = {};
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      /* not JSON after all — fall through to the first-line reading */
    }
  }
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  switch (toolFamily(call.tool)) {
    // No per-call description comes from the backend, so a row full of "Ran a
    // command" would be unreadable. Show the command itself — the group summary
    // uses its own counted phrasing and stays clean.
    case 'command':
      return clip(firstLine(raw));
    // Nothing worth naming: the family wording says it all, and the block
    // itself is one click away in the row. `ask` and `chatSend` carry their
    // text in a card of their own, so repeating it here would be noise.
    case 'code':
    case 'plan':
    case 'ask':
    case 'models':
    case 'chatsList':
    case 'chatSend':
    case 'skillNew':
      return '';
    case 'skills':
    case 'chats':
      return pick('query', 'name', 'skill') || firstLine(raw);
    case 'task':
      return clip(pick('description', 'prompt', 'task'));
    case 'chatNew':
      return clip(pick('title', 'name'));
    case 'api':
      return clip(pick('url', 'endpoint', 'name'));
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return basename(pick('path', 'file', 'filename') || firstLine(raw));
    case 'grep':
    case 'glob':
      return pick('pattern', 'query') || firstLine(raw);
    case 'web':
    case 'knowledge':
    case 'news':
      return pick('query', 'q', 'topic') || firstLine(raw);
    case 'fetch':
      return pick('url') || firstLine(raw);
    case 'weather':
      return clip(pick('location', 'place', 'city') || firstLine(raw));
    case 'sql': {
      const action = pick('action');
      if (action && action !== 'query') return action.replace(/_/g, ' ');
      const sql = pick('sql', 'query');
      return sql ? clip(sql.replace(/\s+/g, ' ')) : '';
    }
    case 'image':
      return clip(pick('prompt', 'description', 'caption'));
    case 'document':
      return clip(pick('title', 'name', 'path'));
    default: {
      if (ACTION_SUBJECT.has(toolFamily(call.tool))) {
        return clip(pick('action', 'key', 'name').replace(/_/g, ' '));
      }
      // MCP tools and anything else the FAMILY map doesn't know: show the first
      // meaningful string argument so a live row says what it is working on
      // rather than just naming the tool.
      const first = Object.entries(args).find(
        ([, value]) => typeof value === 'string' && value.trim().length > 0,
      );
      if (first) return clip((first[1] as string).replace(/\s+/g, ' ').trim());
      return raw.startsWith('{') ? '' : clip(firstLine(raw));
    }
  }
}

/** Families whose wording is built around a subject ("Reading {{subject}}").
 *  Without one they would render a dangling "Reading " / "Searched for ", so
 *  they fall back to the generic tool-name phrasing instead. */
const NEEDS_SUBJECT = new Set(['read', 'write', 'edit', 'ls', 'grep', 'glob', 'fetch']);

/** Families whose subject is a FILE. The UI prints those at full text
 *  brightness — the filename is what a reader scans the row for. Grep patterns
 *  and shell commands are subjects too, but they are long and would light up
 *  half the line. */
const FILE_SUBJECT = new Set(['read', 'write', 'edit', 'ls']);

/** A label cut into styled pieces. Position cannot do this job: English fronts
 *  the verb ("Edited test.py"), German ends on the participle ("test.py
 *  bearbeitet"), so "colour the first word" would hit the wrong one in German
 *  and "the last" the wrong one in English. */
export type LabelSegment = { text: string; kind: 'plain' | 'verb' | 'name' };
export type LabelParts = LabelSegment[];

/** Placeholders interpolated where the verb and the filename belong, then split
 *  back out. Control characters cannot collide with real content the way `*`
 *  would — glob patterns are full of asterisks ("Searched *.md"). */
const VERB_MARK = String.fromCharCode(0);
const NAME_MARK = String.fromCharCode(1);

/** Cuts a rendered phrase apart at the two placeholders, keeping order. */
function toSegments(rendered: string, verb: string, name: string): LabelParts {
  const out: LabelParts = [];
  let buf = '';
  for (const ch of rendered) {
    if (ch !== VERB_MARK && ch !== NAME_MARK) {
      buf += ch;
      continue;
    }
    if (buf) out.push({ text: buf, kind: 'plain' });
    buf = '';
    out.push(ch === VERB_MARK ? { text: verb, kind: 'verb' } : { text: name, kind: 'name' });
  }
  if (buf) out.push({ text: buf, kind: 'plain' });
  const trimmed = out.filter((s) => s.text);
  // Trim the outer edges only; inner spacing holds the phrase together.
  if (trimmed.length) {
    const last = trimmed.length - 1;
    trimmed[0] = { ...trimmed[0], text: trimmed[0].text.trimStart() };
    trimmed[last] = { ...trimmed[last], text: trimmed[last].text.trimEnd() };
  }
  return trimmed.filter((s) => s.text);
}

export function partsToString(parts: LabelParts): string {
  return parts.map((s) => s.text).join('').trim();
}

/** Label for ONE call. `tense: 'running'` yields the live present participle
 *  ("Reading TODO.md") and carries no verb segment — a call in flight has no
 *  pass/fail to show. `'past'` yields the settled form ("Read TODO.md").
 *
 *  Both tenses say as much as they can about the call: "Searching the web for
 *  WM 2026 winner" while it runs, "Searched the web for WM 2026 winner" once it
 *  settles. A row is read one call at a time, so naming the subject is what
 *  makes the list scannable — the short recap ("Searched the web") belongs to
 *  the collapsed group header, which `summarizeCalls` builds instead. Families
 *  whose plain `past` carries no subject supply that detail via `pastNamed`,
 *  the mirror of `runningNamed`. */
export function describeCall(call: ToolCall, t: Translate, tense: 'running' | 'past'): LabelParts {
  const family = toolFamily(call.tool);
  const subject = callSubject(call);
  // A shell/python call names the command it ran; without one it falls back to
  // the plain "Running a command" wording.
  const named = family === 'command' && subject;
  const usable = named || subject || !NEEDS_SUBJECT.has(family) ? family : 'generic';
  let key = named ? `toolGroup.command.${tense}Named` : `toolGroup.${usable}.${tense}`;
  // Rows prefer the detailed phrasing when the family defines one and the call
  // actually carries a subject. `defaultValue` keeps this optional: a family
  // without `runningNamed` / `pastNamed` just keeps its plain wording.
  if (subject && !named) {
    const detailed = `toolGroup.${usable}.${tense}Named`;
    if (t(detailed, { defaultValue: '' })) key = detailed;
  }
  const isFile = !!subject && FILE_SUBJECT.has(usable);
  const rendered = t(key, {
    subject: isFile ? NAME_MARK : subject,
    tool: call.tool,
    count: 1,
    verb: tense === 'past' ? VERB_MARK : '',
  });
  return toSegments(rendered, tense === 'past' ? t(`toolGroup.${usable}.verbPast`) : '', subject);
}

/** How many times an action repeated, as a suffix: "" / "twice" / "7 times".
 *  Plain digits past two — the exact number is the useful part. */
function repeatSuffix(count: number, t: Translate): string {
  if (count <= 1) return '';
  if (count === 2) return t('toolGroup.twice');
  return t('toolGroup.nTimes', { count });
}

/** Groups adjacent calls by family, preserving first-seen order. */
function byFamily(calls: ToolCall[]): Array<{ family: string; calls: ToolCall[] }> {
  const out: Array<{ family: string; calls: ToolCall[] }> = [];
  for (const call of calls) {
    const family = toolFamily(call.tool);
    const last = out[out.length - 1];
    if (last && last.family === family) last.calls.push(call);
    else out.push({ family, calls: [call] });
  }
  return out;
}

export interface Clause {
  segments: LabelParts;
  /** True when any call in the clause failed, so its verb reads red. */
  failed: boolean;
}

/** De-capitalizes every clause after the first so the line reads as one
 *  sentence. That is an English convention: German clauses start with a noun
 *  ("Dateien gelesen"), which must keep its capital, so callers pass false for
 *  those languages.
 *
 *  Kept separate from `summarizeCalls` because a caller may put its own clause
 *  in front (the group header prepends "Thought"), and only the clause that
 *  ends up FIRST may keep its capital. */
export function joinClauses(clauses: Clause[], lowerJoin: boolean): Clause[] {
  if (!lowerJoin || clauses.length < 2) return clauses;
  return clauses.map((clause, i) => {
    if (i === 0) return clause;
    // Lower-case the leading glyph wherever it sits — static text or verb,
    // depending on word order. Never a filename: its case is meaningful, and
    // "Test.py" is not the same file as "test.py".
    const at = clause.segments.findIndex((s) => s.kind !== 'name');
    if (at < 0) return clause;
    return {
      ...clause,
      segments: clause.segments.map((s, j) =>
        j === at ? { ...s, text: s.text.charAt(0).toLocaleLowerCase() + s.text.slice(1) } : s,
      ),
    };
  });
}

/** Past-tense summary for a settled group, Claude-style: one clause per action
 *  family — "Edited agent_loop.py", "ran a command". Run the result through
 *  `joinClauses` before rendering. */
export function summarizeCalls(calls: ToolCall[], t: Translate): Clause[] {
  if (calls.length === 0) return [];
  const clauses: Clause[] = byFamily(calls).map(({ family, calls: group }) => {
    const count = group.length;
    const subject = count === 1 ? callSubject(group[0]) : '';
    const failed = group.some((c) => c.status === 'error');

    const build = (key: string, usable: string, extra: Record<string, unknown> = {}): Clause => {
      const isFile = !!subject && FILE_SUBJECT.has(usable);
      const rendered = t(key, {
        count,
        subject: isFile ? NAME_MARK : subject,
        tool: group[0].tool,
        verb: VERB_MARK,
        ...extra,
      });
      return {
        segments: toSegments(rendered, t(`toolGroup.${usable}.verbPast`), subject),
        failed,
      };
    };

    // A batch has no single subject to name, so a subject-hungry family needs
    // its own counted plural — without one, "Searched for {{subject}}" renders
    // as a dangling "Searched for twice". `count > 1` therefore keeps the
    // family alive here even when NEEDS_SUBJECT would drop it to 'generic'.
    const usable = subject || count > 1 || !NEEDS_SUBJECT.has(family) ? family : 'generic';
    // A real plural ("Ran 3 commands", "Listed 2 directories") reads better
    // than a repeat suffix ("Ran a command 3 times"). Families without
    // `summary` keys fall through to the suffix wording below.
    if (t(`toolGroup.${usable}.summary`, { count, defaultValue: '' })) {
      return build(`toolGroup.${usable}.summary`, usable);
    }

    const times = repeatSuffix(count, t);
    if (times) {
      // The repeat count cannot be appended language-neutrally: English puts it
      // last ("Queried SQL twice"), German before the participle ("Datenbank
      // zweimal abgefragt"). So the placement lives in the `pastN` phrasing.
      const repeated = t(`toolGroup.${usable}.pastN`, {
        count,
        subject,
        tool: group[0].tool,
        verb: VERB_MARK,
        times,
        defaultValue: '',
      }).trim();
      if (repeated) {
        return { segments: toSegments(repeated, t(`toolGroup.${usable}.verbPast`), subject), failed };
      }
    }
    const base = build(`toolGroup.${usable}.past`, usable);
    if (!times) return base;
    return { ...base, segments: [...base.segments, { text: ` ${times}`, kind: 'plain' as const }] };
  });

  return clauses;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Count changed lines in a unified diff (the format `_unified_diff` emits).
 *  `+++`/`---` file headers are not changes and must not be counted. */
export function diffStat(diff: string | undefined): DiffStat | null {
  // Belt and braces: callers normalise persisted rows, but this is the function
  // a bad `diff` would take the whole message list down through.
  if (!diff || typeof diff !== 'string') return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return added || removed ? { added, removed } : null;
}

/** Combined +/- across every diff in a group, for the collapsed header. */
export function groupDiffStat(calls: ToolCall[]): DiffStat | null {
  let added = 0;
  let removed = 0;
  for (const call of calls) {
    const stat = diffStat(call.diff);
    if (stat) {
      added += stat.added;
      removed += stat.removed;
    }
  }
  return added || removed ? { added, removed } : null;
}
