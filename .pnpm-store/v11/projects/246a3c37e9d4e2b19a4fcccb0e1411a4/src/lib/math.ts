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

function convertDelimiters(text: string): string {
  return text
    // Inline code spans must survive untouched, so transform only the parts
    // between them.
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)))
    .join('');
}

/** Rewrite a message's LaTeX habits into the `$`-math remark-math parses. */
export function normalizeMath(src: string): string {
  if (!src.includes('\\[') && !src.includes('\\(') && !src.includes('```') && !src.includes('~~~')) {
    return src;
  }
  return mathSegments(src)
    .map((s) => (s.code ? s.text : convertDelimiters(s.text)))
    .join('\n');
}
