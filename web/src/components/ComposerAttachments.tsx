import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadDownloadUrl, type UploadedFile } from '@/api/client';
import { cn } from '@/lib/utils';
import { AttachmentTile, hasVisualPreview, openUploadViewer } from './AttachmentTile';
import { Tooltip } from './ui/misc';

/** The composer's staged files as a row of square tiles.
 *
 *  `files` stays the truth about what gets sent: a removed file leaves it at
 *  once, so sending during the exit animation can't take it along. The strip
 *  keeps its own copy of the tile until the animation has played. Sending clears
 *  `files` without going through here, so those tiles simply go with the text. */
export function ComposerAttachments({
  files,
  sessionId,
  onRemove,
}: {
  files: UploadedFile[];
  sessionId: string | null;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState<Array<{ file: UploadedFile; index: number }>>([]);

  const remove = (file: UploadedFile) => {
    setLeaving((items) => [...items, { file, index: files.findIndex((f) => f.id === file.id) }]);
    onRemove(file.id);
  };

  const tiles = files.map((file) => ({ file, isLeaving: false }));
  for (const { file, index } of leaving) tiles.splice(Math.min(index, tiles.length), 0, { file, isLeaving: true });
  if (tiles.length === 0) return null;

  return (
    <div className={cn('attachment-strip flex flex-wrap gap-2 px-2.5 pt-2.5', files.length === 0 && 'attachment-strip-leaving')}>
      {tiles.map(({ file, isLeaving }) => {
        const name = String(file.name ?? file.id);
        const url = uploadDownloadUrl(file.id);
        return (
          <div
            key={file.id}
            className={cn('group/att relative shrink-0', isLeaving ? 'attachment-tile-leaving' : 'attachment-tile-in')}
            onAnimationEnd={(e) => {
              if (e.animationName !== 'attachment-tile-out') return;
              setLeaving((items) => items.filter((item) => item.file.id !== file.id));
            }}
          >
            <Tooltip label={name} side="top">
              {/* Images and PDFs open their viewer straight from the composer:
                  the same click they answer once sent. */}
              <button
                type="button"
                tabIndex={isLeaving ? -1 : undefined}
                onClick={() => openUploadViewer({ url, name, mime: file.mime, sessionId })}
                className={cn(
                  'block rounded-xl transition-opacity',
                  hasVisualPreview(name, file.mime) ? 'cursor-pointer hover:opacity-85' : 'cursor-default',
                )}
              >
                <AttachmentTile url={url} name={name} mime={file.mime} />
              </button>
            </Tooltip>
            {!isLeaving && (
              <button
                type="button"
                aria-label={t('composer.removeFile', { name })}
                onClick={() => remove(file)}
                className="absolute end-1.5 top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-foreground/10 bg-background/85 text-foreground/70 opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/att:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
