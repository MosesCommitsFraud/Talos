import { create } from 'zustand';
import { compactSession, createSession, deleteMessages, editMessage, fetchSession, streamChat } from '@/api/client';
import type { Attachment, Metrics, RagSource, ToolCall } from '@/api/types';
import { timestampMs } from '@/lib/utils';
import { usePrefs } from './prefs';

export interface UiMessage {
  id: string;
  /** Backend row id (metadata._db_id / message_saved) — needed for edit/delete. */
  dbId?: string;
  role: 'user' | 'assistant';
  content: string;
  /** Wall-clock (ms) the message was created — drives the relative timestamp
   *  shown under the bubble. Stamped live on send; cold-loaded turns read it
   *  from the backend's metadata.timestamp. */
  createdAt?: number;
  thinking?: string;
  tools?: ToolCall[];
  attachments?: Attachment[];
  metrics?: Metrics;
  /** RAG knowledge-base chunks cited for this answer. */
  sources?: RagSource[];
  streaming?: boolean;
  error?: boolean;
  /** Wall-clock the whole turn took, stamped on the terminal assistant bubble
   *  when streaming ends. Drives the settled "Worked for Xs" fold (t3code style);
   *  turns loaded cold from history fall back to summed metrics.response_time. */
  turnElapsedMs?: number;
  /** An `ask_user` tool call ended the turn with a question — rendered as an
   *  interactive card. Free-text when `options` is empty, else multiple-choice. */
  pendingQuestion?: { question: string; options: { label: string; description?: string }[]; multi: boolean };
  /** Latest `update_plan` checklist (markdown) emitted during this turn. */
  plan?: string;
  /** This turn ran in plan mode and proposed a plan — its content gets an
   *  "Implement plan" / "Revise" approval card. */
  planProposed?: boolean;
  /** Set once the user answers a pendingQuestion or acts on a plan card, so the
   *  card goes inert (a new turn has started from it). */
  answered?: boolean;
  /** Auto-compaction ran before this turn — earlier messages were summarized
   *  to fit the context window. Renders a marker above the bubble. */
  compacted?: { contextLength?: number };
}

/** Live runtime for one session, kept in the store keyed by session id so it
 *  survives switching chats. A turn that is mid-flight keeps streaming into its
 *  own runtime even while a different session (or a fresh draft) is on screen —
 *  the top-level mirror fields below only ever reflect the *active* session. */
interface SessionRuntime {
  messages: UiMessage[];
  streaming: boolean;
  turnStartedAt: number | null;
  abort: AbortController | null;
  /** True between an `ask_user` turn ending and the user's answer — drives the
   *  sidebar "Needs you" status and suppresses the "Done" badge. */
  awaitingInput: boolean;
  goal: GoalRun | null;
}

export interface GoalRun {
  objective: string;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  iteration: number;
}

const emptyRuntime = (): SessionRuntime => ({ messages: [], streaming: false, turnStartedAt: null, abort: null, awaitingInput: false, goal: null });

interface ChatState {
  /** Per-session live state. Outlives chat switches so background turns keep
   *  accumulating thinking/tool/delta events into the right session. */
  runtimes: Record<string, SessionRuntime>;

  /** Sessions whose last turn finished while the user was looking elsewhere and
   *  that haven't been opened since — surfaced as "Done" in the sidebar. Cleared
   *  when the chat is opened. */
  completed: Record<string, true>;

  sessionId: string | null;
  // ── Mirror of runtimes[sessionId] for the active session ──────────────────
  // These exist so every view selector (s.messages, s.streaming, …) keeps
  // working unchanged; they are recomputed on every runtime write.
  messages: UiMessage[];
  streaming: boolean;
  /** ms epoch when the current turn began (set on send, cleared when it ends).
   *  Drives the "Working for Xs" timer so it counts from send through every
   *  agent round, t3code-style, instead of resetting per assistant bubble. */
  turnStartedAt: number | null;
  goal: GoalRun | null;
  /** Model used when the next send has to create a session first. */
  pendingModel: { endpointId: string; model: string } | null;

  setPendingModel: (m: ChatState['pendingModel']) => void;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  send: (text: string, opts?: { attachments?: Attachment[]; onSessionCreated?: (id: string) => void; approvedPlan?: string; planMode?: boolean; goalIteration?: boolean; targetSessionId?: string }) => Promise<void>;
  stop: () => void;
  startGoal: (objective: string) => Promise<void>;
  pauseGoal: () => void;
  resumeGoal: (sessionId?: string) => Promise<void>;
  cancelGoal: () => void;
  compact: () => Promise<void>;
  edit: (msgId: string, content: string) => Promise<void>;
  remove: (msgId: string) => Promise<void>;
  /** Dismiss the active session's pending proposed plan without executing it
   *  (the "Cancel" action on the approval bar). */
  cancelPlan: () => void;
}

const PLAN_CHECKLIST_RE = /[-*]\s*\[[ xX]\]/;

/** True iff a turn is currently streaming for `id`. Used by the sidebar to
 *  render a running indicator on chats other than the one on screen. */
export const selectIsStreaming = (id: string | null | undefined) => (s: ChatState) =>
  !!id && !!s.runtimes[id]?.streaming;

/** The active session's proposed plan (a plan-mode turn that produced a
 *  checklist), or null. Drives the side plan panel and the approval bar. */
export const selectActivePlan = (s: ChatState): UiMessage | null => {
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    const m = s.messages[i];
    if (m.role === 'assistant' && m.planProposed && PLAN_CHECKLIST_RE.test(m.content)) return m;
  }
  return null;
};
/** The active plan only while it still needs a decision (not yet accepted or
 *  cancelled) — drives the composer's approval bar. */
export const selectPendingPlan = (s: ChatState): UiMessage | null => {
  const p = selectActivePlan(s);
  return p && !p.answered ? p : null;
};

/** The active session's unanswered `ask_user` question, or null — rendered as a
 *  card docked above the composer rather than inline in the transcript. */
export const selectPendingQuestion = (s: ChatState): UiMessage | null => {
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    const m = s.messages[i];
    if (m.role === 'assistant' && m.pendingQuestion && !m.answered) return m;
  }
  return null;
};

/** Sidebar status for a chat row: 'working' while a turn streams, 'awaiting'
 *  when a turn ended on a question and needs the user, 'completed' once it
 *  finishes in the background until the chat is opened, else null. */
export type ChatStatus = 'working' | 'awaiting' | 'completed' | null;
export const selectChatStatus = (id: string | null | undefined) => (s: ChatState): ChatStatus => {
  if (!id) return null;
  const rt = s.runtimes[id];
  if (rt?.streaming) return 'working';
  if (rt?.awaitingInput) return 'awaiting';
  return s.completed[id] ? 'completed' : null;
};

let nextId = 0;
const uid = () => `m${Date.now()}-${nextId++}`;

function metricsFromMetadata(metadata: Record<string, unknown> | undefined): Metrics | undefined {
  if (!metadata) return undefined;
  const keys: Array<keyof Metrics> = [
    'model',
    'response_time',
    'tokens_per_second',
    'output_tokens',
    'input_tokens',
    'context_percent',
    'context_length',
    'context_tokens',
    'usage_source',
    'context_breakdown',
  ];
  const metrics: Metrics = {};
  for (const key of keys) {
    const value = metadata[key];
    if (value != null) (metrics as Record<string, unknown>)[key] = value;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function thinkingFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const thinking = metadata?.thinking;
  return typeof thinking === 'string' && thinking.trim() ? thinking : undefined;
}

function ragSourcesFromMetadata(metadata: Record<string, unknown> | undefined): RagSource[] | undefined {
  const raw = metadata?.rag_sources;
  if (!Array.isArray(raw)) return undefined;
  const sources = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      filename: String(item.filename ?? item.source ?? 'unknown'),
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      similarity: typeof item.similarity === 'number' ? item.similarity : 0,
      // Media fields must survive a cold load, or reopened chats lose their
      // image previews / video deeplinks that the live stream showed.
      modality: item.modality === 'image' || item.modality === 'video' ? (item.modality as 'image' | 'video') : undefined,
      image_url: typeof item.image_url === 'string' ? item.image_url : undefined,
      image_caption: typeof item.image_caption === 'string' ? item.image_caption : undefined,
      video_url: typeof item.video_url === 'string' ? item.video_url : undefined,
      deeplink: typeof item.deeplink === 'string' ? item.deeplink : undefined,
      start: typeof item.start === 'number' ? item.start : undefined,
      end: typeof item.end === 'number' ? item.end : undefined,
    }));
  return sources.length > 0 ? sources : undefined;
}

function attachmentsFromMetadata(metadata: Record<string, unknown> | undefined): Attachment[] | undefined {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return undefined;
  const attachments = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      ...item,
      id: String(item.id ?? item.file_id ?? ''),
      name: item.name != null ? String(item.name) : item.original_name != null ? String(item.original_name) : undefined,
      mime: item.mime != null ? String(item.mime) : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
      sandbox_path: item.sandbox_path != null ? String(item.sandbox_path) : undefined,
    }))
    .filter((item) => item.id);
  return attachments.length > 0 ? attachments : undefined;
}

/** A persisted tool event keeps its 1-based agent `round` so cold-loaded turns
 *  can be split back into the per-round bubbles the live stream produced. */
type RoundedToolCall = ToolCall & { round?: number };

function mapToolEvent(item: Record<string, unknown>): RoundedToolCall {
  const exitCode = typeof item.exit_code === 'number' ? item.exit_code : typeof item.exitCode === 'number' ? item.exitCode : undefined;
  return {
    ...item,
    tool: String(item.tool ?? 'tool'),
    command: item.command != null ? String(item.command) : undefined,
    output: item.output != null ? String(item.output) : undefined,
    exitCode,
    round: typeof item.round === 'number' ? item.round : undefined,
    status: exitCode == null || exitCode === 0 ? 'done' as const : 'error' as const,
  };
}

function toolCallsFromMetadata(metadata: Record<string, unknown> | undefined): RoundedToolCall[] | undefined {
  const raw = metadata?.tool_events;
  if (!Array.isArray(raw)) return undefined;
  const tools = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(mapToolEvent);
  return tools.length > 0 ? tools : undefined;
}

const THINK_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

/** Pull inline `<think>` blocks (persisted in round_texts) out of a round's text
 *  into a separate thinking string, matching how the live stream routes thinking
 *  deltas into their own field rather than the message body. */
function splitThinking(text: string): { thinking?: string; content: string } {
  const thinks: string[] = [];
  const content = text.replace(THINK_RE, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thinks.push(trimmed);
    return '';
  }).trim();
  return { thinking: thinks.join('\n\n') || undefined, content };
}

function displayUserContent(content: string): string {
  return content
    .split(/\n\s*\[Attachment file available to tools:/)[0]
    .split(/\n\s*\[Attached document:/)[0]
    .trimEnd();
}

/** A cold-loaded history message. The backend persists a whole multi-round
 *  agent turn as one assistant row, but keeps `round_texts` (cleaned text per
 *  round, with inline `<think>`) and tags each tool event with its `round`. We
 *  use those to rebuild the per-round bubbles the live stream produced, so a
 *  reopened chat folds the same way it did right after finishing — one thinking
 *  block + tool rows per round, the final round's text as the answer — instead
 *  of collapsing into a single bubble with all thinking and tools merged. */
interface HistoryMessage {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function coldLoadMessage(m: HistoryMessage): UiMessage[] {
  const createdAt = timestampMs(m.metadata?.timestamp as string | undefined) || undefined;
  if (m.role !== 'assistant') {
    return [{
      id: uid(),
      dbId: m.metadata?._db_id as string | undefined,
      role: 'user',
      createdAt,
      content: displayUserContent(m.content),
      attachments: attachmentsFromMetadata(m.metadata),
    }];
  }

  const dbId = m.metadata?._db_id as string | undefined;
  const metrics = metricsFromMetadata(m.metadata);
  const sources = ragSourcesFromMetadata(m.metadata);
  const tools = toolCallsFromMetadata(m.metadata);
  const roundTexts = m.metadata?.round_texts;

  // Single-round / no-tool replies don't persist round_texts — keep the flat
  // one-bubble shape the live stream also produced for them.
  if (!Array.isArray(roundTexts) || roundTexts.length <= 1) {
    return [{
      id: uid(),
      dbId,
      role: 'assistant',
      createdAt,
      content: m.content,
      thinking: thinkingFromMetadata(m.metadata),
      metrics,
      tools,
      sources,
    }];
  }

  // Multi-round turn: one bubble per round, mirroring the live agent loop. Each
  // round carries its own thinking + interim text and the tools it ran; the
  // terminal fields (db id, metrics, RAG sources) land on the last bubble, which
  // AssistantTurn treats as the turn's answer.
  const rounds = roundTexts.map((rt) => splitThinking(String(rt ?? '')));
  const lastIdx = rounds.length - 1;
  return rounds.map((round, i) => {
    const roundNum = i + 1;
    const roundTools = tools?.filter((t) => t.round === roundNum);
    const terminal = i === lastIdx;
    return {
      id: uid(),
      dbId: terminal ? dbId : undefined,
      role: 'assistant' as const,
      createdAt,
      content: round.content,
      thinking: round.thinking,
      tools: roundTools?.length ? roundTools : undefined,
      metrics: terminal ? metrics : undefined,
      sources: terminal ? sources : undefined,
    };
  });
}

declare global {
  interface Window { __talosChat?: typeof useChat }
}

export const useChat = create<ChatState>((set, get) => {
  /** Write into one session's runtime, keyed by id rather than "the active
   *  session", and mirror to the top-level fields when that session is the one
   *  on screen. This is the single mutation path so a background turn and the
   *  visible view never fight over the same `messages` array. */
  const writeRuntime = (id: string, updater: (rt: SessionRuntime) => Partial<SessionRuntime>) => {
    set((s) => {
      const prev = s.runtimes[id] ?? emptyRuntime();
      const next: SessionRuntime = { ...prev, ...updater(prev) };
      const runtimes = { ...s.runtimes, [id]: next };
      return s.sessionId === id
        ? { runtimes, messages: next.messages, streaming: next.streaming, turnStartedAt: next.turnStartedAt, goal: next.goal }
        : { runtimes };
    });
  };

  /** Point the view at a session and mirror its runtime (or a blank draft for
   *  the null/new-chat case). Never tears down a runtime, so the previous
   *  session keeps streaming in the background. */
  const activate = (id: string | null) => {
    const rt = (id && get().runtimes[id]) || emptyRuntime();
    set((s) => {
      // Opening a chat clears its "Done" badge.
      const completed = id && s.completed[id] ? { ...s.completed } : s.completed;
      if (id && completed !== s.completed) delete completed[id];
      return { sessionId: id, messages: rt.messages, streaming: rt.streaming, turnStartedAt: rt.turnStartedAt, goal: rt.goal, completed };
    });
  };

  return {
  runtimes: {},
  completed: {},
  sessionId: null,
  messages: [],
  streaming: false,
  turnStartedAt: null,
  goal: null,
  pendingModel: null,

  setPendingModel: (pendingModel) => set({ pendingModel }),

  newChat: () => {
    // Switch to a fresh draft without aborting any in-flight turn — that turn
    // keeps streaming into its own runtime and can be returned to.
    activate(null);
  },

  openSession: async (id) => {
    // Instant switch to whatever we already have in memory (no blank flash).
    activate(id);
    // A runtime we built this page session — whether mid-stream or finished —
    // is authoritative and richer than a refetch (it holds the live-streamed
    // thinking/tool detail). Only cold-load from the server when we have none;
    // a full reload (runtimes empty) is what re-syncs from the backend.
    if (get().runtimes[id]) return;

    const detail = await fetchSession(id);
    // A later click may have switched sessions while we were fetching.
    if (get().sessionId !== id) return;
    // Guard against a turn that started streaming into this id meanwhile.
    if (get().runtimes[id]?.streaming) return;

    const messages = (detail.history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .flatMap((m) => coldLoadMessage(m as HistoryMessage));
    writeRuntime(id, () => ({ ...emptyRuntime(), messages }));
  },

  send: async (text, opts) => {
    const state = get();
    // Block re-entry only for the session we'd send into, not globally — a
    // different chat may legitimately be streaming.
    const requestedSessionId = opts?.targetSessionId ?? state.sessionId;
    const activeRt = requestedSessionId ? state.runtimes[requestedSessionId] : undefined;
    if (activeRt?.streaming || (!text.trim() && !opts?.attachments?.length)) return;

    let sessionId = requestedSessionId;
    if (!sessionId) {
      const pm = state.pendingModel;
      if (!pm) throw new Error('No model selected');
      const session = await createSession({ endpointId: pm.endpointId, model: pm.model });
      sessionId = session.id;
      // Seed an empty runtime and activate it before the user message lands.
      writeRuntime(sessionId, () => emptyRuntime());
      activate(sessionId);
      opts?.onSessionCreated?.(sessionId);
    }
    const sid = sessionId;

    const attachments = opts?.attachments ?? [];
    const userMsg: UiMessage = { id: uid(), role: 'user', content: text, attachments, createdAt: Date.now() };
    const aiMsg: UiMessage = { id: uid(), role: 'assistant', content: '', streaming: true, createdAt: Date.now() };
    const abort = new AbortController();
    // A new turn supersedes any open question/plan card: mark them answered so
    // they go inert, and clear the "needs you" flag.
    writeRuntime(sid, (rt) => ({
      messages: [
        ...rt.messages.map((m) =>
          m.pendingQuestion || m.planProposed ? { ...m, answered: true } : m,
        ),
        userMsg,
        aiMsg,
      ],
      streaming: true,
      turnStartedAt: Date.now(),
      awaitingInput: false,
      abort,
    }));

    // The agent loop emits multiple assistant rounds per turn, delimited by
    // agent_step events. Each round gets its own message bubble (with its own
    // thinking block and tool rows), so this tracks the bubble currently
    // receiving deltas rather than closing over aiMsg.
    let aiId = aiMsg.id;
    const patchAi = (patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) => {
      writeRuntime(sid, (rt) => ({
        messages: rt.messages.map((m) =>
          m.id === aiId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m,
        ),
      }));
    };
    const startNewRound = () => {
      const current = get().runtimes[sid]?.messages.find((m) => m.id === aiId);
      // Nothing rendered yet — reuse the empty bubble instead of stacking one.
      if (current && !current.content && !current.thinking && !current.tools?.length) return;
      patchAi({ streaming: false });
      const next: UiMessage = { id: uid(), role: 'assistant', content: '', streaming: true, createdAt: Date.now() };
      aiId = next.id;
      writeRuntime(sid, (rt) => ({ messages: [...rt.messages, next] }));
    };

    const prefs = usePrefs.getState();
    // Plan-mode applies to this turn unless the caller overrides it (e.g. an
    // "Implement plan" approval forces it off and passes the approved checklist).
    const planMode = opts?.planMode ?? prefs.planMode;
    try {
      await streamChat({
        message: text,
        sessionId: sid,
        flags: {
          planMode,
          approvedPlan: opts?.approvedPlan,
          useRag: prefs.useRag,
          useDb: prefs.useDb,
          reasoning: prefs.reasoning,
          incognito: prefs.incognito,
          lang: prefs.lang,
          attachments: attachments.map((file) => file.id),
        },
        signal: abort.signal,
        onEvent: (ev) => {
          if ('delta' in ev && typeof ev.delta === 'string') {
            if (ev.thinking) patchAi((m) => ({ thinking: (m.thinking ?? '') + ev.delta }));
            else patchAi((m) => ({ content: m.content + ev.delta }));
            return;
          }
          switch (ev.type) {
            case 'agent_step':
              startNewRound();
              break;
            case 'tool_start':
              patchAi((m) => ({
                tools: [...(m.tools ?? []), { tool: String(ev.tool), command: ev.command as string | undefined, status: 'running' }],
              }));
              break;
            case 'tool_output':
              patchAi((m) => ({
                tools: (m.tools ?? []).map((t, i, arr) =>
                  i === arr.length - 1 && t.status === 'running'
                    ? {
                        ...t,
                        output: ev.output as string | undefined,
                        exitCode: ev.exit_code as number | undefined,
                        status: (ev.exit_code ?? 0) === 0 ? 'done' : 'error',
                        image_url: ev.image_url as string | undefined,
                        image_prompt: ev.image_prompt as string | undefined,
                        image_model: ev.image_model as string | undefined,
                        image_size: ev.image_size as string | undefined,
                        image_quality: ev.image_quality as string | undefined,
                        image_note: ev.image_note as string | undefined,
                        screenshot: ev.screenshot as string | undefined,
                        created_images: Array.isArray(ev.created_images) ? ev.created_images as ToolCall['created_images'] : undefined,
                      }
                    : t,
                ),
              }));
              break;
            case 'metrics':
              // Merge rather than replace: per-round events carry only the live
              // context fields, while the final event fills in the rest.
              patchAi((m) => ({ metrics: { ...m.metrics, ...(ev.data as Metrics) } }));
              break;
            case 'compacted':
              // Auto-compaction ran before this turn streamed — surface it so
              // the user knows older messages were summarized to fit context.
              patchAi({ compacted: { contextLength: ev.context_length as number | undefined } });
              break;
            case 'content_final':
              // Server-side figure guards (hallucination strip / vision judge)
              // can remove image markdown that already streamed as deltas —
              // replace the accumulated content with the authoritative text
              // that gets persisted.
              if (typeof ev.content === 'string') patchAi({ content: ev.content });
              break;
            case 'rag_sources':
              if (Array.isArray(ev.data)) patchAi({ sources: ev.data as RagSource[] });
              break;
            case 'message_saved':
              if (typeof ev.id === 'string') patchAi({ dbId: ev.id });
              break;
            case 'ask_user': {
              // The agent posed a question and ended the turn — render the card
              // and flag the session as needing the user.
              const q = ev.data as UiMessage['pendingQuestion'];
              if (q && q.question) {
                patchAi({
                  pendingQuestion: {
                    question: q.question,
                    options: Array.isArray(q.options) ? q.options : [],
                    multi: !!q.multi,
                  },
                });
                writeRuntime(sid, () => ({ awaitingInput: true }));
              }
              break;
            }
            case 'plan_update': {
              const plan = (ev.data as { plan?: string } | undefined)?.plan;
              if (typeof plan === 'string' && plan.trim()) patchAi({ plan });
              break;
            }
          }
        },
      });
      // Quiet re-sync: the stream only reports the assistant row id; pull
      // history once so the user message gets its db id too (enables
      // edit/delete without a manual reload).
      try {
        const detail = await fetchSession(sid);
        const hist = (detail.history ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
        const msgs = get().runtimes[sid]?.messages ?? [];
        if (hist.length === msgs.length) {
          writeRuntime(sid, () => ({ messages: msgs.map((m, i) => ({ ...m, dbId: hist[i]?.metadata?._db_id ?? m.dbId })) }));
        }
      } catch { /* best-effort */ }
    } catch (err) {
      if (!abort.signal.aborted) {
        patchAi((m) => ({
          content: m.content || (err instanceof Error ? err.message : 'Request failed'),
          error: true,
        }));
      }
    } finally {
      // Stamp the turn's wall-clock onto the terminal bubble before the start
      // time is cleared, so the settled "Worked for Xs" fold has a duration.
      const startedAt = get().runtimes[sid]?.turnStartedAt;
      patchAi((m) => ({
        streaming: false,
        turnElapsedMs: startedAt != null ? Date.now() - startedAt : m.turnElapsedMs,
        // A plan-mode turn proposes a plan — its terminal bubble gets an approval card.
        planProposed: planMode || m.planProposed,
      }));
      // Clear only this session's turn flags — a different chat may be active.
      writeRuntime(sid, () => ({ streaming: false, turnStartedAt: null, abort: null }));
      // Badge it "Done" if it finished in the background (user is elsewhere) — but
      // not when it ended on a question; that's surfaced as "Needs you" instead.
      const awaiting = get().runtimes[sid]?.awaitingInput;
      if (!awaiting && get().sessionId !== sid) set((s) => ({ completed: { ...s.completed, [sid]: true } }));

      // A goal is a bounded Ralph-style loop: after each completed turn, inspect
      // the explicit completion signal and otherwise schedule another turn.
      // setTimeout avoids re-entering send() before this turn's cleanup settles.
      const rt = get().runtimes[sid];
      const goal = rt?.goal;
      if (goal?.status === 'running' && !rt.awaitingInput) {
        const answer = [...rt.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
        if (/\[GOAL_COMPLETE\]/i.test(answer)) {
          writeRuntime(sid, () => ({
            goal: { ...goal, status: 'completed' },
            messages: rt.messages.map((m) => ({ ...m, content: m.content.replace(/\s*\[GOAL_COMPLETE\]\s*/gi, '') })),
          }));
        } else {
          setTimeout(() => { void get().resumeGoal(sid); }, 0);
        }
      }
    }
  },

  startGoal: async (objective) => {
    const clean = objective.trim();
    if (!clean) return;
    // Ensure a session exists through the normal send path, then attach goal
    // state as soon as onSessionCreated fires (or immediately for an open chat).
    const install = (sid: string) => writeRuntime(sid, () => ({
      goal: { objective: clean, status: 'running', iteration: 1 },
    }));
    const sid = get().sessionId;
    if (sid) install(sid);
    await get().send(
      `GOAL: ${clean}\n\nWork autonomously toward this objective. Check your result before stopping. If the objective is fully satisfied, end with [GOAL_COMPLETE]. Otherwise state concrete progress and the next action; the goal runner will continue you. Ask the user only when genuinely blocked.`,
      { planMode: false, goalIteration: true, onSessionCreated: install },
    );
  },

  pauseGoal: () => {
    const { sessionId } = get();
    if (!sessionId) return;
    writeRuntime(sessionId, (rt) => rt.goal ? ({ goal: { ...rt.goal, status: 'paused' } }) : ({}));
  },

  resumeGoal: async (requestedSessionId) => {
    const sessionId = requestedSessionId ?? get().sessionId;
    if (!sessionId) return;
    const rt = get().runtimes[sessionId];
    const goal = rt?.goal;
    if (!goal || rt.streaming || ['completed', 'cancelled'].includes(goal.status)) return;
    const next = { ...goal, status: 'running' as const, iteration: goal.iteration + 1 };
    writeRuntime(sessionId, () => ({ goal: next }));
    await get().send(
      `Continue goal (iteration ${next.iteration}): ${next.objective}\n\nReview all progress so far, perform the next useful work, and verify it. End with [GOAL_COMPLETE] only when the objective is fully satisfied. Ask the user only if genuinely blocked.`,
      { planMode: false, goalIteration: true, targetSessionId: sessionId },
    );
  },

  cancelGoal: () => {
    const { sessionId, runtimes } = get();
    if (!sessionId) return;
    const goal = runtimes[sessionId]?.goal;
    if (goal) writeRuntime(sessionId, () => ({ goal: { ...goal, status: 'cancelled' } }));
    runtimes[sessionId]?.abort?.abort();
    fetch(`/api/chat/stop/${sessionId}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  },

  compact: async () => {
    const { sessionId, streaming } = get();
    if (!sessionId || streaming) return;
    await compactSession(sessionId);
    const detail = await fetchSession(sessionId);
    const messages = (detail.history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .flatMap((m) => coldLoadMessage(m as HistoryMessage));
    writeRuntime(sessionId, (rt) => ({ messages, goal: rt.goal }));
  },

  stop: () => {
    const { sessionId, runtimes } = get();
    if (!sessionId) return;
    runtimes[sessionId]?.abort?.abort();
    fetch(`/api/chat/stop/${sessionId}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  },

  edit: async (msgId, content) => {
    const { sessionId, messages, streaming } = get();
    if (streaming) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    const msg = messages[idx];
    if (!sessionId || !msg?.dbId) throw new Error('Message not editable yet');

    if (msg.role !== 'user') {
      // Assistant rows are edited in place (no resend semantics).
      await editMessage(sessionId, msg.dbId, content);
      writeRuntime(sessionId, (rt) => ({ messages: rt.messages.map((m) => (m.id === msgId ? { ...m, content } : m)) }));
      return;
    }

    // Editing a user message resends the conversation from that point:
    // drop the old turn and every later message, then send the edited text
    // through the normal stream path with the original attachments.
    const dropIds = messages.slice(idx).map((m) => m.dbId).filter((id): id is string => !!id);
    await deleteMessages(sessionId, dropIds);
    writeRuntime(sessionId, () => ({ messages: messages.slice(0, idx) }));
    await get().send(content, { attachments: msg.attachments });
  },

  remove: async (msgId) => {
    const { sessionId, messages } = get();
    const msg = messages.find((m) => m.id === msgId);
    if (!sessionId || !msg?.dbId) throw new Error('Message not deletable yet');
    await deleteMessages(sessionId, [msg.dbId]);
    writeRuntime(sessionId, (rt) => ({ messages: rt.messages.filter((m) => m.id !== msgId) }));
  },

  cancelPlan: () => {
    const { sessionId, messages } = get();
    if (!sessionId) return;
    const p = [...messages].reverse().find((m) => m.role === 'assistant' && m.planProposed && !m.answered);
    if (!p) return;
    writeRuntime(sessionId, (rt) => ({
      messages: rt.messages.map((m) => (m.id === p.id ? { ...m, answered: true } : m)),
    }));
  },
  };
});

// Dev-only handle so the store can be driven from the console / preview evals
// (dynamic import() in DevTools resolves a second module instance under HMR).
if (import.meta.env.DEV) window.__talosChat = useChat;
