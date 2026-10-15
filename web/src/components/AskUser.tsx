import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { selectPendingQuestion, useChat, type AskAnswer, type AskQuestion, type UiMessage } from '@/state/chat';
import { Button } from './ui/button';
import { KeybindingPill } from './ui/kbd';
import { cn } from '@/lib/utils';

/** The active session's pending question, docked at composer width directly
 *  above the chat input (rendered by App, not inline in the transcript). */
export function PendingQuestion() {
  const question = useChat(selectPendingQuestion);
  if (!question) return null;
  return (
    <div className="mx-auto mb-3 w-full max-w-[800px] px-4">
      {/* Keyed by message so a new question starts with a fresh draft. */}
      <AskUser key={question.id} msg={question} />
    </div>
  );
}

/** One question's draft: the options ticked, plus the "Other" free text. */
interface Draft {
  picked: string[];
  other: boolean;
  text: string;
}

const emptyDraft = (): Draft => ({ picked: [], other: false, text: '' });

function draftAnswer(q: AskQuestion, d: Draft): string {
  const typed = d.text.trim();
  if (q.options.length === 0) return typed;
  const parts = [...d.picked];
  if (d.other && typed) parts.push(typed);
  return parts.join(', ');
}

/** Interactive card for an `ask_user` turn: 1-4 questions paged through one at
 *  a time. Each is free-text (no options), single- or multiple-choice; choice
 *  questions also get an "Other" row with its own text box. Every question can
 *  be skipped. Submitting sends one message holding all answers, and attaches
 *  the question/answer pairs so the transcript shows them as a summary card. */
export function AskUser({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  const send = useChat((s) => s.send);
  const streaming = useChat((s) => s.streaming);
  const questions = msg.pendingQuestion?.questions ?? [];
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
  const [skipped, setSkipped] = useState<boolean[]>(() => questions.map(() => false));
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const q = questions[page];
  const d = drafts[page] ?? emptyDraft();
  const freeText = q ? q.options.length === 0 : false;
  const showText = freeText || d.other;
  const last = page === questions.length - 1;
  const disabled = !!msg.answered || streaming;
  const answer = q ? draftAnswer(q, d) : '';

  // The text box gets focus whenever it appears (free-text page, or "Other"
  // just ticked), so the user can type straight away. Otherwise the card keeps
  // it after a page change, or focus would drop to <body> along with the
  // unmounted control and the 1-9 / Ctrl+Enter shortcuts would stop working.
  // Focus held elsewhere (the user typing in the composer) is left alone.
  useEffect(() => {
    if (showText) textRef.current?.focus();
    else if (!document.activeElement || document.activeElement === document.body) cardRef.current?.focus();
  }, [showText, page]);

  if (!q) return null;

  const patch = (next: Partial<Draft>) =>
    setDrafts((prev) => prev.map((x, i) => (i === page ? { ...x, ...next } : x)));

  const choose = (label: string) => {
    if (disabled) return;
    if (q.multi) {
      patch({ picked: d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label] });
    } else {
      patch({ picked: [label], other: false });
    }
  };

  const toggleOther = () => {
    if (disabled) return;
    patch(q.multi ? { other: !d.other } : { other: true, picked: [] });
  };

  const finish = (skips: boolean[]) => {
    const pairs: AskAnswer[] = questions.map((qq, i) => ({
      question: qq.question,
      answer: skips[i] ? '' : draftAnswer(qq, drafts[i]),
    }));
    const none = t('askUser.noPreference');
    // What the model reads: the bare answer for a single question (as before),
    // question → answer lines when several were asked together.
    const text =
      pairs.length === 1
        ? pairs[0].answer || none
        : pairs.map((p) => `${p.question}\n→ ${p.answer || none}`).join('\n\n');
    void send(text, { askAnswers: pairs });
  };

  const advance = (skip: boolean) => {
    if (disabled) return;
    const skips = skipped.map((s, i) => (i === page ? skip : s));
    setSkipped(skips);
    if (last) finish(skips);
    else setPage(page + 1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (answer) advance(false);
      return;
    }
    // Number keys pick an option while focus isn't in the text box.
    if (e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1) {
      if (n <= q.options.length) choose(q.options[n - 1].label);
      else if (n === q.options.length + 1 && !freeText) toggleOther();
    }
  };

  return (
    <div
      ref={cardRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard shortcuts (1-9, Ctrl+Enter) need focus on the card
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-popover text-sm shadow-sm outline-none',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3 border-b border-border bg-muted/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          {q.header && (
            <span className="mb-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {q.header}
            </span>
          )}
          <div className="text-[15px] font-medium leading-snug text-strong">{q.question}</div>
          {q.multi && <div className="mt-0.5 text-xs text-muted-foreground">{t('askUser.chooseMany')}</div>}
        </div>
        {questions.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <button
              type="button"
              aria-label={t('askUser.prev')}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="rounded p-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
            <span className="tabular-nums">{t('askUser.pageOf', { n: page + 1, total: questions.length })}</span>
            <button
              type="button"
              aria-label={t('askUser.next')}
              disabled={last}
              onClick={() => setPage(page + 1)}
              className="rounded p-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
        )}
      </div>

      {!freeText && (
        <div role={q.multi ? 'group' : 'radiogroup'} className="divide-y divide-border">
          {q.options.map((opt) => (
            <OptionRow
              key={opt.label}
              multi={q.multi}
              on={d.picked.includes(opt.label)}
              disabled={disabled}
              label={opt.label}
              description={opt.description}
              onClick={() => choose(opt.label)}
            />
          ))}
          <OptionRow multi={q.multi} on={d.other} disabled={disabled} label={t('askUser.other')} onClick={toggleOther} />
        </div>
      )}

      {showText && (
        <div className={cn('px-4', freeText ? 'pt-3' : 'pb-1 pl-11')}>
          <textarea
            ref={textRef}
            value={d.text}
            disabled={disabled}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder={t('askUser.placeholder')}
            rows={freeText ? 3 : 1}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => advance(true)}>
          {t('askUser.skip')}
        </Button>
        <Button size="sm" disabled={disabled || !answer} onClick={() => advance(false)}>
          {last ? t('askUser.submit') : t('askUser.next')}
          <KeybindingPill value="mod+enter" className="bg-primary-foreground/20 text-primary-foreground" />
        </Button>
      </div>
    </div>
  );
}

function OptionRow({
  multi,
  on,
  disabled,
  label,
  description,
  onClick,
}: {
  multi: boolean;
  on: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60 disabled:pointer-events-none"
    >
      <span
        className={cn(
          'mt-0.5 flex size-[18px] shrink-0 items-center justify-center border transition-colors',
          multi ? 'rounded' : 'rounded-full',
          on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
        )}
      >
        {on && (multi ? <CheckIcon className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-primary-foreground" />)}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] text-strong">{label}</span>
        {description && <span className="text-[13px] leading-snug text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

/** A user message that answered an `ask_user` card, drawn as the list of
 *  questions with the answer under each instead of a plain text bubble. */
export function AskAnswers({ answers }: { answers: AskAnswer[] }) {
  const { t } = useTranslation();
  return (
    <div className="w-full divide-y divide-border overflow-hidden rounded-xl border border-border text-sm">
      {answers.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list, questions may repeat
        <div key={i} className="px-4 py-2.5">
          <div className="font-medium leading-snug text-strong">{a.question}</div>
          <div className={cn('mt-0.5 whitespace-pre-wrap', a.answer ? 'text-muted-foreground' : 'italic text-muted-foreground/70')}>
            {a.answer || t('askUser.skipped')}
          </div>
        </div>
      ))}
    </div>
  );
}
