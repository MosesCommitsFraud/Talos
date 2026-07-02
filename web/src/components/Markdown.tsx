import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { copyTextToClipboard } from '@/lib/utils';
import { useUi } from '@/state/ui';

/* ── hast helpers: extract plain text/structure from the syntax tree the
      renderers receive, so copy/download get the raw content even after
      highlighting wrapped everything in spans. ── */

interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function hastFind(node: HastNode | undefined, tagName: string): HastNode | undefined {
  if (!node?.children) return undefined;
  for (const child of node.children) {
    if (child.tagName === tagName) return child;
    const nested = hastFind(child, tagName);
    if (nested) return nested;
  }
  return undefined;
}

/** All rows of a <table> hast node as cell-text matrices. */
function tableRows(node: HastNode | undefined): string[][] {
  const rows: string[][] = [];
  const walk = (n: HastNode | undefined) => {
    if (!n?.children) return;
    for (const child of n.children) {
      if (child.tagName === 'tr') {
        rows.push((child.children ?? [])
          .filter((c) => c.tagName === 'th' || c.tagName === 'td')
          .map((c) => hastText(c).trim()));
      } else {
        walk(child);
      }
    }
  };
  walk(node);
  return rows;
}

const LANG_EXT: Record<string, string> = {
  python: 'py', javascript: 'js', typescript: 'ts', tsx: 'tsx', jsx: 'jsx',
  bash: 'sh', shell: 'sh', zsh: 'sh', sql: 'sql', json: 'json', yaml: 'yml',
  html: 'html', css: 'css', rust: 'rs', go: 'go', java: 'java', csharp: 'cs',
  cpp: 'cpp', c: 'c', ruby: 'rb', php: 'php', kotlin: 'kt', swift: 'swift',
  markdown: 'md', xml: 'xml', toml: 'toml', dockerfile: 'dockerfile',
};

export function downloadBlob(content: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/* ── Shared hover toolbar for blocks ── */

function BlockButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md border bg-popover/90 text-muted-foreground shadow-xs backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function CopyBlockButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <BlockButton
      label={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void copyTextToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </BlockButton>
  );
}

/* ── Code block: copy + download with a language-derived extension ── */

function CodeBlock({ node, children }: { node?: HastNode; children: React.ReactNode }) {
  const codeNode = hastFind(node, 'code') ?? node;
  const text = hastText(codeNode).replace(/\n$/, '');
  const classNames = codeNode?.properties?.className;
  const lang = (Array.isArray(classNames) ? classNames : [])
    .map(String)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length);
  const ext = (lang && (LANG_EXT[lang] ?? lang)) || 'txt';
  return (
    <div className="group/block relative">
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover/block:opacity-100">
        <CopyBlockButton text={text} />
        <BlockButton label="Download" onClick={() => downloadBlob(text, `code.${ext}`, 'text/plain;charset=utf-8')}>
          <DownloadIcon className="size-3" />
        </BlockButton>
      </div>
      {children}
    </div>
  );
}

/* ── Table: copy as TSV (pastes into spreadsheets), download as CSV ── */

function TableBlock({ node, children }: { node?: HastNode; children: React.ReactNode }) {
  const rows = tableRows(node);
  const tsv = rows.map((r) => r.join('\t')).join('\n');
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  return (
    <div className="group/block relative">
      <div className="absolute -top-1 right-0 flex -translate-y-full gap-1 opacity-0 transition-opacity group-hover/block:opacity-100">
        <CopyBlockButton text={tsv} />
        <BlockButton label="Download CSV" onClick={() => downloadBlob(csv, 'table.csv', 'text/csv;charset=utf-8')}>
          <DownloadIcon className="size-3" />
        </BlockButton>
      </div>
      {children}
    </div>
  );
}

/* Stable plugin/component references so react-markdown doesn't see a fresh
   config object every render while a sibling message streams. */
const REMARK_PLUGINS = [remarkGfm];
const HIGHLIGHT_PLUGINS = [rehypeHighlight];
const NO_PLUGINS: [] = [];

const MD_COMPONENTS = {
  pre: ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
    <CodeBlock node={node as HastNode}>
      <pre {...props}>{children}</pre>
    </CodeBlock>
  ),
  table: ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
    <TableBlock node={node as HastNode}>
      <table {...props}>{children}</table>
    </TableBlock>
  ),
  // Inline images (e.g. RAG figures the model embeds) are constrained so a
  // high-DPI crop doesn't blow out the message width; click opens the in-app
  // lightbox (zoom + download) instead of a new tab, same as generated images.
  // Same-origin /api/personal/rag-asset requests carry the session cookie.
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <button
      type="button"
      onClick={() => src && useUi.getState().openLightbox({ src, label: alt || undefined })}
      className="block cursor-zoom-in border-0 bg-transparent p-0"
    >
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        className="my-2 max-h-96 max-w-full rounded-md border"
      />
    </button>
  ),
} as const;

/** Assistant message body. Memoized — re-renders only when the text changes,
 *  which matters while sibling messages stream.
 *
 *  Highlighting is skipped while `streaming`: re-running rehypeHighlight on every
 *  token re-classifies still-incomplete code (colors flash), thrashes the DOM
 *  (janky scroll), and pops the horizontal scrollbar in and out (vertical jump).
 *  Code stays plain while it streams and colorizes once the message settles. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-markdown text-[15px]">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={streaming ? NO_PLUGINS : HIGHLIGHT_PLUGINS}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
