import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchLibrary, fetchMemories } from '@/api/client';
import { formatRelativeTime } from '@/lib/utils';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';

/* Native read views for Brain (memory) and Library. Management actions
   (tidy, import/export, editing) still live in the legacy UI — linked
   below the list until they're ported. */

function LegacyLink({ label }: { label: string }) {
  return (
    <a
      href="/legacy"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      <ExternalLinkIcon className="size-3.5" />
      {label}
    </a>
  );
}

export function BrainDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({ queryKey: ['memory'], queryFn: fetchMemories, enabled: open });
  const items = data ?? [];
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('toolDialogs.brainTitle')}>
        <DialogSection className="space-y-2">
          {isLoading && <div className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>}
          {isError && <div className="py-6 text-center text-sm text-muted-foreground">{t('toolDialogs.errorMemories')}</div>}
          {!isLoading && !isError && items.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('toolDialogs.noMemories')}</div>
          )}
          {items.map((m) => (
            <div key={m.id} className="rounded-xl border bg-card px-3.5 py-2.5">
              <div className="text-sm leading-relaxed">{m.content ?? m.text ?? ''}</div>
              {m.created_at != null && (
                <div className="mt-1 text-[11px] text-muted-foreground">{formatRelativeTime(m.created_at)}</div>
              )}
            </div>
          ))}
          <div className="pt-2">
            <LegacyLink label={t('toolDialogs.tidyBrain')} />
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({ queryKey: ['library'], queryFn: fetchLibrary, enabled: open });
  const docs = data ?? [];
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('toolDialogs.libraryTitle')}>
        <DialogSection className="space-y-2">
          {isLoading && <div className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>}
          {isError && <div className="py-6 text-center text-sm text-muted-foreground">{t('toolDialogs.errorDocs')}</div>}
          {!isLoading && !isError && docs.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('toolDialogs.noDocs')}</div>
          )}
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-xl border bg-card px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{d.title ?? d.name ?? t('common.untitled')}</span>
              {d.updated_at != null && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeTime(d.updated_at)}</span>
              )}
            </div>
          ))}
          <div className="pt-2">
            <LegacyLink label={t('toolDialogs.editLibrary')} />
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}
