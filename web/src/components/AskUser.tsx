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
 *  questions end in a "something else" line to type into. Every question can
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
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const q = questions[page];
  const d = drafts[page] ?? emptyDraft();
  const freeText = q ? q.options.length === 0 : false;
  const last = page === questions.length - 1;
  const disabled = !!msg.answered || streaming;
  const answer = q ? draftAnswer(q, d) : '';

  // The text box gets focus whenever it is the answer (free-text page, or
  // "something else" just ticked), so the user can type straight away. Otherwise the card keeps
  // it after a page change, or focus would drop to <body> along with the
  // unmounted control and the 1-9 / Ctrl+Enter shortcuts would stop working.
  // Focus held elsewhere (the user typing in the composer) is left alone.
  useEffect(() => {
    if (freeText) textRef.current?.focus();
    else if (d.other) inputRef.current?.focus();
    else if (!document.activeElement || document.activeElement === document.body) cardRef.current?.focus();
  }, [freeText, d.other, page]);

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
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
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
        'pop-in rounded-2xl border border-border bg-popover p-1.5 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)] outline-none dark:shadow-none',
        disabled && 'opacity-60',
      )}
    >
      <div className="px-2.5 pt-2 pb-1.5">
        {q.header && (
          <span className="mb-1.5 inline-flex rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {q.header}
          </span>
        )}
        <div className="text-[15px] leading-snug font-semibold text-strong">{q.question}</div>
        {q.multi && <div className="mt-0.5 text-xs text-muted-foreground">{t('askUser.chooseMany')}</div>}
      </div>

      {/* Keyed by page, so each question's rows rise in afresh. */}
      <div key={page}>
        {!freeText && (
          <div role={q.multi ? 'group' : 'radiogroup'} className="flex flex-col">
            {q.options.map((opt, i) => (
              <OptionRow
                key={opt.label}
                multi={q.multi}
                on={d.picked.includes(opt.label)}
                disabled={disabled}
                label={opt.label}
                description={opt.description}
                onClick={() => choose(opt.label)}
                delay={i * 40}
              />
            ))}
            {/* "Something else": not a row that opens a box, but the box itself.
                Typing in it is choosing it. */}
            <div
              className="fade-up flex items-center gap-2.5 rounded-lg px-2.5 py-1.5"
              style={{ animationDelay: `${q.options.length * 40}ms` }}
            >
              <button
                type="button"
                role={q.multi ? 'checkbox' : 'radio'}
                aria-checked={d.other}
                aria-label={t('askUser.other')}
                disabled={disabled}
                onClick={toggleOther}
                className="shrink-0 disabled:pointer-events-none"
              >
                <Marker multi={q.multi} on={d.other} />
              </button>
              <input
                ref={inputRef}
                value={d.text}
                disabled={disabled}
                onChange={(e) =>
                  patch(q.multi ? { text: e.target.value, other: true } : { text: e.target.value, other: true, picked: [] })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && answer) {
                    e.preventDefault();
                    advance(false);
                  }
                }}
                placeholder={t('askUser.somethingElse')}
                aria-label={t('askUser.other')}
                className="min-w-0 flex-1 bg-transparent text-[15px] text-strong outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
              />
            </div>
          </div>
        )}

        {freeText && (
          <div className="px-1 pt-0.5">
            <textarea
              ref={textRef}
              value={d.text}
              disabled={disabled}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder={t('askUser.placeholder')}
              rows={3}
              className="fade-up w-full resize-y rounded-lg bg-muted px-3 py-2 text-[15px] text-strong outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-1 pt-2 pb-0.5">
        {questions.length > 1 && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <button
              type="button"
              aria-label={t('askUser.prev')}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <span className="tabular-nums" aria-label={t('askUser.pageOf', { n: page + 1, total: questions.length })}>
              {page + 1}/{questions.length}
            </span>
            <button
              type="button"
              aria-label={t('askUser.next')}
              disabled={last}
              onClick={() => setPage(page + 1)}
              className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => advance(true)}>
            {t('askUser.skip')}
          </Button>
          <Button size="sm" disabled={disabled || !answer} onClick={() => advance(false)}>
            {last ? t('askUser.submit') : t('askUser.next')}
            <KeybindingPill value="mod+enter" className="bg-primary-foreground/20 text-primary-foreground" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The round (one of) or square (any of) mark in front of an option. */
function Marker({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center border-[1.5px] transition-colors',
        multi ? 'rounded-[5px]' : 'rounded-full',
        on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/45',
      )}
    >
      {on && (multi ? <CheckIcon className="size-2.5" strokeWidth={3.5} /> : <span className="size-1.5 rounded-full bg-primary-foreground" />)}
    </span>
  );
}

function OptionRow({
  multi,
  on,
  disabled,
  label,
  description,
  onClick,
  delay,
}: {
  multi: boolean;
  on: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  onClick: () => void;
  delay: number;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      className="fade-up flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
    >
      <span className="flex h-[1.375rem] shrink-0 items-center">
        <Marker multi={multi} on={on} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px] leading-[1.375rem] text-strong">{label}</span>
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
