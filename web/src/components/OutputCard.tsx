import {
  ChevronDownIcon, CodeIcon, DownloadIcon, ExternalLinkIcon, EyeIcon, FileIcon, FileTextIcon, FolderArchiveIcon,
  GlobeIcon, PresentationIcon, Sheet as SheetIcon, type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { artifactDownloadUrl, artifactRenderUrl, downloadArtifact, downloadArtifactsZip } from '@/api/client';
import { displayName, fileTypeLabel, isPreviewable, previewKind, type PreviewKind } from '@/lib/files';
import type { SessionFile } from '@/lib/useSessionFiles';
import { cn } from '@/lib/utils';
import { useUi } from '@/state/ui';
import { FilePreviewFace } from './AttachmentTile';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';

/** Open an output where it belongs: the preview panel when Talos can render it,
 *  otherwise straight to a download. */
export function openSessionFile(sessionId: string, f: SessionFile) {
  if (isPreviewable(f.name, f.mime)) {
    useUi.getState().openPreview({ sessionId, path: f.path, name: f.name, mime: f.mime, version: f.version });
  } else {
    void downloadArtifact(sessionId, f.path, f.name);
  }
}

/** Per-kind tile look. Literal class strings so Tailwind sees them. */
const KIND_STYLE: Partial<Record<PreviewKind, { icon: LucideIcon; tile: string }>> = {
  excel: { icon: SheetIcon, tile: 'border-emerald-500/45 bg-emerald-500/10 text-emerald-500' },
  csv: { icon: SheetIcon, tile: 'border-emerald-500/45 bg-emerald-500/10 text-emerald-500' },
  word: { icon: FileTextIcon, tile: 'border-sky-500/45 bg-sky-500/10 text-sky-500' },
  markdown: { icon: FileTextIcon, tile: 'border-sky-500/45 bg-sky-500/10 text-sky-500' },
  text: { icon: FileTextIcon, tile: 'border-sky-500/45 bg-sky-500/10 text-sky-500' },
  presentation: { icon: PresentationIcon, tile: 'border-orange-500/45 bg-orange-500/10 text-orange-500' },
  pdf: { icon: FileTextIcon, tile: 'border-red-500/45 bg-red-500/10 text-red-500' },
  html: { icon: GlobeIcon, tile: 'border-violet-500/45 bg-violet-500/10 text-violet-500' },
  code: { icon: CodeIcon, tile: 'border-amber-500/45 bg-amber-500/10 text-amber-500' },
};
const FALLBACK_STYLE = { icon: FileIcon, tile: 'border-border bg-muted text-muted-foreground' };

/** The file's tile: a sheet in the type's colour (or the image itself) that
 *  lifts and fans a second sheet out from behind it while the card is hovered. */
export function OutputTile({ sessionId, file, size = 'md' }: { sessionId: string; file: SessionFile; size?: 'sm' | 'md' }) {
  const kind = previewKind(file.name, file.mime);
  const style = KIND_STYLE[kind] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  const box = size === 'md' ? 'h-[60px] w-[52px]' : 'h-10 w-9';
  const px = size === 'md' ? { w: 52, h: 60 } : { w: 36, h: 40 };
  return (
    <div className={cn('relative shrink-0', box)}>
      {/* The sheet behind: hidden flush under the tile until hover fans it out. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-lg border opacity-0 transition-all duration-300 ease-out',
          'group-hover/out:-translate-x-1.5 group-hover/out:translate-y-0.5 group-hover/out:-rotate-[9deg] group-hover/out:opacity-100',
          kind === 'image' ? 'border-border bg-muted' : style.tile,
        )}
      />
      <div
        className={cn(
          'relative flex size-full items-center justify-center overflow-hidden rounded-lg border shadow-sm transition-transform duration-300 ease-out',
          'group-hover/out:-translate-y-1 group-hover/out:translate-x-0.5 group-hover/out:rotate-[4deg]',
          kind === 'image' ? 'border-border bg-muted' : cn(style.tile, 'bg-card'),
        )}
      >
        {kind === 'image' ? (
          <FilePreviewFace url={artifactDownloadUrl(sessionId, file.path)} name={file.name} mime={file.mime} width={px.w} height={px.h} />
        ) : (
          <>
            {/* Tint over the card colour, so the tile reads as solid when it
                covers the fanned sheet. */}
            <div className={cn('absolute inset-0', style.tile, 'border-0')} />
            <Icon className={cn('relative transition-transform duration-300 group-hover/out:scale-110', size === 'md' ? 'size-5' : 'size-4')} strokeWidth={1.75} />
          </>
        )}
      </div>
    </div>
  );
}

/** Human type name for the subtitle ("Tabelle · XLSX"). */
export function useKindLabel() {
  const { t } = useTranslation();
  return (f: SessionFile) => t(`outputs.kind.${previewKind(f.name, f.mime)}`);
}

/** Claude-style banner for a turn's headline output: tile, name, type, and a
 *  split Download button whose chevron holds the other ways to open it. The
 *  whole card opens the preview panel. */
export function OutputCard({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const kind = previewKind(file.name, file.mime);
  const previewable = isPreviewable(file.name, file.mime);
  const ext = fileTypeLabel(file.name, file.mime);

  return (
    // A container, so the Download label folds to an icon when the chat column
    // (not the viewport) is narrow — next to an open preview panel, say.
    <div className="group/out @container/out relative flex w-full max-w-[560px] items-center gap-3 rounded-xl border bg-card py-3 pl-3 pr-3 transition-colors hover:border-foreground/20">
      <button
        type="button"
        onClick={() => openSessionFile(sessionId, file)}
        title={previewable ? t('messages.openPreview', { name: file.name }) : file.name}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left @sm/out:gap-4 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
      >
        <OutputTile sessionId={sessionId} file={file} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-foreground">{displayName(file.name)}</div>
          <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
            {kindLabel(file)}{kind !== 'none' || ext !== 'FILE' ? ` · ${ext}` : ''}
          </div>
        </div>
      </button>
      {/* Above the card-wide click target (after:inset-0), so these buttons
          get their own clicks. */}
      <div className="relative z-10 flex shrink-0 items-stretch overflow-hidden rounded-lg border bg-popover text-sm shadow-xs/5 dark:bg-input/30">
        <button
          type="button"
          onClick={() => { void downloadArtifact(sessionId, file.path, file.name); }}
          aria-label={t('artifacts.download', { name: file.name })}
          className="flex cursor-pointer items-center px-2 py-1.5 font-medium text-foreground transition-colors hover:bg-accent @sm/out:px-3"
        >
          <DownloadIcon className="size-4 @sm/out:hidden" />
          <span className="hidden @sm/out:inline">{t('outputs.download')}</span>
        </button>
        <Menu>
          <MenuTrigger
            aria-label={t('outputs.moreActions')}
            className="flex cursor-pointer items-center border-l px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          >
            <ChevronDownIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            {previewable && (
              <MenuItem onSelect={() => openSessionFile(sessionId, file)}>
                <EyeIcon /> {t('outputs.open')}
              </MenuItem>
            )}
            {kind === 'html' && (
              <MenuItem onSelect={() => window.open(artifactRenderUrl(sessionId, file.path), '_blank', 'noopener')}>
                <ExternalLinkIcon /> {t('preview.openInTab')}
              </MenuItem>
            )}
            {(previewable || kind === 'html') && <MenuSeparator />}
            <MenuItem onSelect={() => { void downloadArtifactsZip(sessionId); }}>
              <FolderArchiveIcon /> {t('artifacts.downloadZip')}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
