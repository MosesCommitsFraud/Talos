import { FileIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RagSource } from '@/api/types';

/** Citations for a RAG-backed answer: the knowledge-base files whose chunks
 *  were fed into the model. Deduped by filename (a file can contribute several
 *  chunks); the snippet shows on hover. */
export function RagSources({ sources }: { sources: RagSource[] }) {
  const { t } = useTranslation();
  if (!sources?.length) return null;

  const byFile = new Map<string, RagSource>();
  for (const s of sources) {
    const prev = byFile.get(s.filename);
    if (!prev || s.similarity > prev.similarity) byFile.set(s.filename, s);
  }
  const unique = [...byFile.values()];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground/80">{t('messages.sources')}:</span>
      {unique.map((s) => (
        <span
          key={s.filename}
          title={s.snippet || s.filename}
          className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <FileIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{s.filename}</span>
        </span>
      ))}
    </div>
  );
}
