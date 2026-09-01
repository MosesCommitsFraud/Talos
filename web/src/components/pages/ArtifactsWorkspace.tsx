import { useQuery } from '@tanstack/react-query';
import { ShapesIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, fetchAllArtifacts } from '@/api/client';
import type { LibraryArtifact } from '@/api/types';
import { useUi } from '@/state/ui';
import { artifactDisplayName, displayName, fileTypeLabel, formatSize, isPreviewable, previewKind } from '@/lib/files';
import { formatRelativeTime } from '@/lib/utils';
import { FilePreviewFace } from '../AttachmentTile';
import { FileTypeIcon } from '../FileTypeIcon';
import { SearchInput } from '../ui/search';
import { CardGrid, EmptyState, Page } from './parts';

/** One artifact card: a thumbnail (images) or its file-type mark, then the
 *  name, the chat it came from, and when it last changed. */
function ArtifactCard({ artifact, onOpen }: { artifact: LibraryArtifact; onOpen?: () => void }) {
  const { t } = useTranslation();
  const path = String(artifact.path ?? artifact.name ?? '');
  const name = artifactDisplayName(path, typeof artifact.name === 'string' ? artifact.name : undefined);
  const mime = typeof artifact.mime === 'string' ? artifact.mime : undefined;
  const kind = previewKind(name, mime);
  const sessionId = artifact.session_id ?? null;
  const thumb = kind === 'image' && sessionId ? artifactDownloadUrl(sessionId, path) : undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={onOpen ? t('messages.openPreview', { name }) : name}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors enabled:cursor-pointer enabled:hover:border-ring/40 disabled:cursor-default"
    >
      {/* Preview face — a real thumbnail for images, otherwise the type mark on
          a muted plate, so a wall of documents still reads as distinct tiles. */}
      <div className="flex h-36 items-center justify-center overflow-hidden border-b bg-muted/40">
        {thumb ? (
          <FilePreviewFace url={thumb} name={name} mime={mime} width={320} height={144} />
        ) : (
          <FileTypeIcon path={name} mime={mime} className="size-9 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 p-3">
        <div className="truncate text-[13px] font-medium text-strong">{displayName(name)}</div>
        <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span className="font-medium uppercase tracking-wide">{fileTypeLabel(name, mime)}</span>
          {artifact.size != null && (
            <>
              <span>·</span>
              <span>{formatSize(artifact.size)}</span>
            </>
          )}
          {artifact.mtime ? (
            <>
              <span>·</span>
              <span>{formatRelativeTime(artifact.mtime)}</span>
            </>
          ) : null}
        </div>
        {artifact.session_name && (
          <div className="mt-1 truncate text-[11px] text-muted-foreground/80">
            {t('artifacts.fromChat', { name: artifact.session_name })}
          </div>
        )}
      </div>
    </button>
  );
}

/** The /artifacts page: everything the assistant has produced for this user,
 *  across every chat. Clicking a previewable file opens it in the same document
 *  panel the chat uses. */
export function ArtifactsWorkspace() {
  const { t } = useTranslation();
  const openPreview = useUi((s) => s.openPreview);
  const setView = useUi((s) => s.setView);
  const [query, setQuery] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['artifacts', 'all'],
    queryFn: fetchAllArtifacts,
    staleTime: 30_000,
  });

  const needle = query.trim().toLowerCase();
  const artifacts = (data ?? []).filter((a) => {
    if (!needle) return true;
    const haystack = `${a.name ?? ''} ${a.session_name ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });

  return (
    <Page
      title={t('sidebar.artifacts')}
      actions={
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('artifacts.searchPlaceholder')}
          wrapperClassName="w-56"
        />
      }
    >
      {isLoading && <p className="py-16 text-center text-sm text-muted-foreground">{t('common.loading')}</p>}
      {isError && (
        <p className="py-16 text-center text-sm text-destructive-foreground">{t('artifacts.loadError')}</p>
      )}
      {!isLoading && !isError && artifacts.length === 0 && (
        <EmptyState
          icon={<ShapesIcon />}
          title={t(needle ? 'artifacts.noMatches' : 'artifacts.emptyTitle')}
          hint={needle ? undefined : t('artifacts.emptyHint')}
        />
      )}
      {artifacts.length > 0 && (
        <CardGrid>
          {artifacts.map((a) => {
            const path = String(a.path ?? a.name ?? '');
            const name = artifactDisplayName(path, typeof a.name === 'string' ? a.name : undefined);
            const mime = typeof a.mime === 'string' ? a.mime : undefined;
            const sessionId = a.session_id ?? null;
            // The preview panel fetches through the chat's artifact routes, so
            // an artifact whose chat is gone can be listed but not opened.
            const canOpen = !!sessionId && isPreviewable(name, mime);
            return (
              <ArtifactCard
                key={`${sessionId ?? 'orphan'}:${path}`}
                artifact={a}
                onOpen={
                  canOpen
                    ? () => {
                        // The document panel is part of the chat surface, so
                        // opening one from here goes back to the chat with the
                        // panel already showing the file.
                        openPreview({ sessionId: sessionId!, path, name, mime });
                        setView('chat');
                      }
                    : undefined
                }
              />
            );
          })}
        </CardGrid>
      )}
    </Page>
  );
}
