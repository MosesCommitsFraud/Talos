/** File-type classification shared by the artifact chips (which icon, whether a
 *  file can be previewed) and the preview panel (how to render it). */

export type PreviewKind = 'markdown' | 'text' | 'code' | 'csv' | 'excel' | 'word' | 'pdf' | 'image' | 'none';

export function fileExt(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml',
  'html', 'htm', 'css', 'scss', 'rs', 'go', 'java', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp',
  'rb', 'php', 'kt', 'swift', 'xml', 'toml', 'ini', 'cfg', 'dockerfile', 'lua', 'r',
]);

const TEXT_EXTS = new Set(['txt', 'text', 'log', 'rtf', 'env']);

/** How (or whether) a workspace file can be rendered in the preview panel. */
export function previewKind(path: string, mime?: string): PreviewKind {
  const ext = fileExt(path);
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(ext)) return 'image';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc' || m.includes('wordprocessingml')) return 'word';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || m.includes('spreadsheetml')) return 'excel';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (CODE_EXTS.has(ext)) return 'code';
  if (TEXT_EXTS.has(ext) || m.startsWith('text/')) return 'text';
  return 'none';
}

export function isPreviewable(path: string, mime?: string): boolean {
  return previewKind(path, mime) !== 'none';
}

/** Short, uppercase data-type label for a file chip (e.g. "PDF", "XLSX", "PNG").
 *  Falls back to the preview kind when there is no useful extension. */
export function fileTypeLabel(path: string, mime?: string): string {
  const ext = fileExt(path);
  if (ext) return ext.toUpperCase();
  const kind = previewKind(path, mime);
  return kind === 'none' ? 'FILE' : kind.toUpperCase();
}

export function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
