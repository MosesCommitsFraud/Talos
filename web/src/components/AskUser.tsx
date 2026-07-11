import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SendIcon } from 'lucide-react';
import { selectPendingQuestion, useChat, type UiMessage } from '@/state/chat';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/** The active session's pending question, docked at composer width directly
 *  above the chat input (rendered by App, not inline in the transcript). */
export function PendingQuestion() {
  const question = useChat(selectPendingQuestion);
  if (!question) return null;
  return (
    <div className="mx-auto mb-3 w-full max-w-[800px] px-4">
      <AskUser msg={question} />
    </div>
  );
}

/** Interactive card rendered when the agent ended a turn with an `ask_user`
 *  question. Three shapes: free-text (no options), single-choice, multi-select.
 *  Answering sends the user's response as the next turn; once a turn has started
 *  the card is marked `answered` and goes inert. */
export function AskUser({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  const send = useChat((s) => s.send);
  const streaming = useChat((s) => s.streaming);
  const q = msg.pendingQuestion;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  if (!q) return null;

  const done = !!msg.answered;
  const disabled = done || streaming;
  const freeText = q.options.length === 0;

  const submit = (answer: string) => {
    const value = answer.trim();
    if (!value || disabled) return;
    void send(value);
  };

  const toggle = (label: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <div
      className={cn(
        'mt-3 rounded-md border border-primary/30 bg-primary/[0.04] p-3',
        done && 'opacity-60',
      )}
    >
      {!freeText && (
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {q.multi ? t('askUser.chooseMany') : t('askUser.chooseOne')}
        </div>
      )}

      {freeText ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(text);
            }}
            placeholder={t('askUser.placeholder')}
            rows={2}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <Button size="sm" className="self-end" disabled={disabled || !text.trim()} onClick={() => submit(text)}>
            <SendIcon /> {t('askUser.send')}
          </Button>
        </div>
      ) : q.multi ? (
        <div className="flex flex-col gap-1.5">
          {q.options.map((opt) => {
            const on = picked.has(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                disabled={disabled}
                onClick={() => toggle(opt.label)}
                className={cn(
                  'flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:pointer-events-none disabled:opacity-60',
                  on ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent',
                )}
              >
                <span className="font-medium">{opt.label}</span>
                {opt.description && <span className="text-xs text-muted-foreground">{opt.description}</span>}
              </button>
            );
          })}
          <Button
            size="sm"
            className="mt-1 self-end"
            disabled={disabled || picked.size === 0}
            onClick={() => submit([...picked].join(', '))}
          >
            {t('askUser.submit')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {q.options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              disabled={disabled}
              onClick={() => submit(opt.label)}
              className="flex w-full flex-col items-start rounded-lg border border-input px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="font-medium">{opt.label}</span>
              {opt.description && <span className="text-xs text-muted-foreground">{opt.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
