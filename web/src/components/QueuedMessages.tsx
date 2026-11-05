import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { uploadDownloadUrl } from '@/api/client';
import { useChat } from '@/state/chat';
import { AttachmentTile } from './AttachmentTile';
import { CollapsibleText } from './CollapsibleText';
import { ActionIcon, CopyAction } from './Messages';

/** Messages typed during a turn, as the bubbles they will become, waiting right
 *  above the input. The turn takes them in at its next round boundary; "Send
 *  now" interrupts it instead, the X takes the message back. */
export function QueuedMessages() {
  const { t } = useTranslation();
  const queued = useChat((s) => (s.sessionId ? s.runtimes[s.sessionId]?.queued : undefined));
  const sendNow = useChat((s) => s.sendQueuedNow);
  const remove = useChat((s) => s.removeQueued);
  if (!queued?.length) return null;
  return (
    <div className="mb-2.5 max-h-[40vh] space-y-2 overflow-y-auto" aria-label={t('composer.queuedMessages')}>
      {queued.map((item) => (
        <div key={item.id} className="group/queued attachment-tile-in flex flex-col items-end">
          {item.attachments.length > 0 && (
            <div className="mb-1.5 flex max-w-full flex-wrap justify-end gap-1.5">
              {item.attachments.map((file) => (
                <AttachmentTile
                  key={file.id}
                  url={uploadDownloadUrl(file.id)}
                  name={file.name || file.id}
                  mime={file.mime}
                  size={56}
                />
              ))}
            </div>
          )}
          {item.text && (
            <div className="max-w-[85%] rounded-[14px] bg-bubble px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-strong">
              <CollapsibleText>{item.text}</CollapsibleText>
            </div>
          )}
          <div className="mt-1 flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
            {item.text && <CopyAction text={item.text} />}
            <ActionIcon label={t('composer.removeQueued')} onClick={() => remove(item.id)}>
              <XIcon className="size-3" />
            </ActionIcon>
            <button
              type="button"
              onClick={() => sendNow(item.id)}
              className="ms-1.5 cursor-pointer transition-colors hover:text-foreground"
            >
              {t('composer.sendNow')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
