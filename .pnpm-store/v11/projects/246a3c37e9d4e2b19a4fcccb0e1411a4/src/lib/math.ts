/* Math normalisation for chat markdown.
   remark-math only understands `$…$` / `$$…$$`. Models reach for two other
   habits that then render as literal source or as a code block: LaTeX's
   `\(…\)` / `\[…\]` delimiters, and fencing the formula as ```math /
   ```latex. Both are rewritten to dollar math here so a formula is shown as
   a formula. Code fences in any other language — and inline code spans — are
   left untouched, so `\(` inside a shell snippet stays literal. */

const MATH_LANGS = new Set(['math', 'latex', 'tex', 'katex']);

/** Split into fenced-code and prose segments, keeping the fences intact. */
function mathSegments(src: string): { code: boolean; text: string }[] {
  const segments: { code: boolean; text: string }[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  let mathFence = false;
  const flush = (code: boolean) => {
    if (buf.length) segments.push({ code, text: buf.join('\n') });
    buf = [];
  };
  for (const line of src.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (marker) {
        const lang = marker[2].trim().split(/[\s{,]/)[0].toLowerCase();
        flush(false);
        fence = marker[1];
        mathFence = MATH_LANGS.has(lang);
        if (!mathFence) buf.push(line);
        continue;
      }
      buf.push(line);
      continue;
    }
    const closes = marker && !marker[2].trim()
      && marker[1][0] === fence[0] && marker[1].length >= fence.length;
    if (closes) {
      if (mathFence) {
        // The whole fenced body becomes one display formula.
        segments.push({ code: false, text: `$$\n${buf.join('\n')}\n$$` });
        buf = [];
      } else {
        buf.push(line);
        flush(true);
      }
      fence = null;
      mathFence = false;
      continue;
    }
    buf.push(line);
  }
  // A fence that never closed (the message is still streaming) stays verbatim.
  flush(fence !== null);
  return segments;
}

// A LaTeX command inside a bracket pair is what separates a formula whose
// `\[`/`\(` delimiters lost their backslash from ordinary prose or JSON.
const LATEX_CMD = /\\[a-zA-Z]{2,}/;
const DISPLAY_ENVS = 'equation|align|gather|multline|eqnarray|alignat|flalign';

/** `[` … `]` on lines of their own around LaTeX: a `\[ … \]` block whose
 *  backslashes were dropped (models do this when they over-escape markdown). */
function bareBracketBlocks(text: string): string {
  return text.replace(/^([ \t]*)\[[ \t]*\n([\s\S]+?)\n[ \t]*\][ \t]*$/gm, (m, indent: string, body: string) =>
    LATEX_CMD.test(body) && !/^\s*"/.test(body) ? `${indent}$$\n${body.trim()}\n${indent}$$` : m,
  );
}

/** `( \sigma^2 )` — the inline twin of bareBracketBlocks. The spaces just inside
 *  the parentheses are part of the signature, so "(siehe \ref)" prose is rare. */
function bareParenInline(text: string): string {
  return text.replace(/\(\s([^()\n]*?)\s\)/g, (m, body: string) =>
    LATEX_CMD.test(body) ? `$${body.trim()}$` : m,
  );
}

/** A display environment written without any math delimiters. */
function bareEnvironments(text: string): string {
  const re = new RegExp(String.raw`(^|\n)([ \t]*\\begin\{(${DISPLAY_ENVS})\*?\}[\s\S]*?\\end\{\3\*?\})`, 'g');
  return text.replace(re, (m, lead: string, env: string, _name: string, offset: number) => {
    const before = text.slice(0, offset).trimEnd();
    return before.endsWith('$$') || before.endsWith('\\[') ? m : `${lead}$$\n${env.trim()}\n$$`;
  });
}

const MATH_HINT = /[\\^_{}=]/;

/** "Kostet 5 $ und 10 $": currency, not an inline formula. A `$` right after a
 *  number and before a break is escaped unless the text since the previous
 *  unescaped `$` on the line reads like math. */
function escapeCurrency(line: string): string {
  let out = '';
  let lastDollar = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== '$' || line[i - 1] === '\\') { out += ch; continue; }
    if (line[i + 1] === '$' || line[i - 1] === '$') { out += ch; lastDollar = -1; continue; }
    const afterNumber = /\d[ \t]?$/.test(line.slice(Math.max(0, i - 2), i));
    const beforeBreak = i + 1 >= line.length || /[\s.,;:!?)]/.test(line[i + 1]);
    const since = lastDollar >= 0 ? line.slice(lastDollar + 1, i) : '';
    if (afterNumber && beforeBreak && !MATH_HINT.test(since)) {
      out += '\\$';
      continue;
    }
    out += ch;
    lastDollar = lastDollar >= 0 ? -1 : i;
  }
  return out;
}

/** `|` inside inline math in a table row would split the cell. */
function tablePipes(line: string): string {
  if (!/^\s*\|/.test(line)) return line;
  return line.replace(/\$([^$\n]+)\$/g, (_m, body: string) => `$${body.replace(/\|/g, '\\vert ')}$`);
}

function convertDelimiters(text: string): string {
  return text
    // Inline code spans must survive untouched, so transform only the parts
    // between them.
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : bareParenInline(bareBracketBlocks(bareEnvironments(part)))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
      // `$$E = mc^2$$` alone on a line is meant as a display formula, but
      // remark-math reads a one-line `$$…$$` as inline math.
      .replace(/^([ \t]*)\$\$([^$\n]+)\$\$[ \t]*$/gm, (_m, indent: string, body: string) =>
        `${indent}$$\n${indent}${body.trim()}\n${indent}$$`)
      .split('\n')
      .map((line) => tablePipes(escapeCurrency(line)))
      .join('\n')))
    .join('');
}

/** Rewrite a message's LaTeX habits into the `$`-math remark-math parses. */
export function normalizeMath(src: string): string {
  if (!/[\\$`~]/.test(src)) {
    return src;
  }
  return mathSegments(src)
    .map((s) => (s.code ? s.text : convertDelimiters(s.text)))
    .join('\n');
}
