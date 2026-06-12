import { create } from 'zustand';
import { createSession, deleteMessages, editMessage, fetchSession, streamChat } from '@/api/client';
import type { Attachment, Metrics, ToolCall } from '@/api/types';
import { usePrefs } from './prefs';

export interface UiMessage {
  id: string;
  /** Backend row id (metadata._db_id / message_saved) — needed for edit/delete. */
  dbId?: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  attachments?: Attachment[];
  metrics?: Metrics;
  streaming?: boolean;
  error?: boolean;
}

interface ChatState {
  sessionId: string | null;
  messages: UiMessage[];
  streaming: boolean;
  /** Model used when the next send has to create a session first. */
  pendingModel: { endpointId: string; model: string } | null;
  abort: AbortController | null;

  setPendingModel: (m: ChatState['pendingModel']) => void;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  send: (text: string, opts?: { attachments?: Attachment[]; onSessionCreated?: (id: string) => void }) => Promise<void>;
  stop: () => void;
  edit: (msgId: string, content: string) => Promise<void>;
  remove: (msgId: string) => Promise<void>;
}

let nextId = 0;
const uid = () => `m${Date.now()}-${nextId++}`;

function metricsFromMetadata(metadata: Record<string, unknown> | undefined): Metrics | undefined {
  if (!metadata) return undefined;
  const keys: Array<keyof Metrics> = [
    'model',
    'response_time',
    'tokens_per_second',
    'output_tokens',
    'context_percent',
    'context_length',
  ];
  const metrics: Metrics = {};
  for (const key of keys) {
    const value = metadata[key];
    if (value != null) (metrics as Record<string, unknown>)[key] = value;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
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

function toolCallsFromMetadata(metadata: Record<string, unknown> | undefined): ToolCall[] | undefined {
  const raw = metadata?.tool_events;
  if (!Array.isArray(raw)) return undefined;
  const tools = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : typeof item.exitCode === 'number' ? item.exitCode : undefined;
      return {
        ...item,
        tool: String(item.tool ?? 'tool'),
        command: item.command != null ? String(item.command) : undefined,
        output: item.output != null ? String(item.output) : undefined,
        exitCode,
        status: exitCode == null || exitCode === 0 ? 'done' as const : 'error' as const,
      };
    });
  return tools.length > 0 ? tools : undefined;
}

function displayUserContent(content: string): string {
  return content
    .split(/\n\s*\[Attachment file available to tools:/)[0]
    .split(/\n\s*\[Attached document:/)[0]
    .trimEnd();
}

declare global {
  interface Window { __talosChat?: typeof useChat }
}

export const useChat = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  streaming: false,
  pendingModel: null,
  abort: null,

  setPendingModel: (pendingModel) => set({ pendingModel }),

  newChat: () => {
    get().abort?.abort();
    set({ sessionId: null, messages: [], streaming: false, abort: null });
  },

  openSession: async (id) => {
    get().abort?.abort();
    set({ sessionId: id, messages: [], streaming: false, abort: null });
    const detail = await fetchSession(id);
    // A later click may have switched sessions while we were fetching.
    if (get().sessionId !== id) return;
    set({
      messages: (detail.history ?? [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: uid(),
          dbId: m.metadata?._db_id,
          role: m.role as 'user' | 'assistant',
          content: m.role === 'user' ? displayUserContent(m.content) : m.content,
          attachments: m.role === 'user' ? attachmentsFromMetadata(m.metadata) : undefined,
          metrics: m.role === 'assistant' ? metricsFromMetadata(m.metadata) : undefined,
          tools: m.role === 'assistant' ? toolCallsFromMetadata(m.metadata) : undefined,
        })),
    });
  },

  send: async (text, opts) => {
    const state = get();
    if (state.streaming || (!text.trim() && !opts?.attachments?.length)) return;

    let sessionId = state.sessionId;
    if (!sessionId) {
      const pm = state.pendingModel;
      if (!pm) throw new Error('No model selected');
      const session = await createSession({ endpointId: pm.endpointId, model: pm.model });
      sessionId = session.id;
      set({ sessionId });
      opts?.onSessionCreated?.(sessionId);
    }

    const attachments = opts?.attachments ?? [];
    const userMsg: UiMessage = { id: uid(), role: 'user', content: text, attachments };
    const aiMsg: UiMessage = { id: uid(), role: 'assistant', content: '', streaming: true };
    const abort = new AbortController();
    set({ messages: [...get().messages, userMsg, aiMsg], streaming: true, abort });

    // The agent loop emits multiple assistant rounds per turn, delimited by
    // agent_step events. Each round gets its own message bubble (with its own
    // thinking block and tool rows), so this tracks the bubble currently
    // receiving deltas rather than closing over aiMsg.
    let aiId = aiMsg.id;
    const patchAi = (patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) => {
      set({
        messages: get().messages.map((m) =>
          m.id === aiId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m,
        ),
      });
    };
    const startNewRound = () => {
      const current = get().messages.find((m) => m.id === aiId);
      // Nothing rendered yet — reuse the empty bubble instead of stacking one.
      if (current && !current.content && !current.thinking && !current.tools?.length) return;
      patchAi({ streaming: false });
      const next: UiMessage = { id: uid(), role: 'assistant', content: '', streaming: true };
      aiId = next.id;
      set({ messages: [...get().messages, next] });
    };

    const prefs = usePrefs.getState();
    try {
      await streamChat({
        message: text,
        sessionId,
        flags: {
          planMode: prefs.planMode,
          useRag: prefs.useRag,
          useDb: prefs.useDb,
          incognito: prefs.incognito,
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
              patchAi({ metrics: ev.data as Metrics });
              break;
            case 'message_saved':
              if (typeof ev.id === 'string') patchAi({ dbId: ev.id });
              break;
          }
        },
      });
      // Quiet re-sync: the stream only reports the assistant row id; pull
      // history once so the user message gets its db id too (enables
      // edit/delete without a manual reload).
      try {
        const detail = await fetchSession(sessionId);
        const hist = (detail.history ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
        const msgs = get().messages;
        if (get().sessionId === sessionId && hist.length === msgs.length) {
          set({ messages: msgs.map((m, i) => ({ ...m, dbId: hist[i]?.metadata?._db_id ?? m.dbId })) });
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
      patchAi({ streaming: false });
      set({ streaming: false, abort: null });
    }
  },

  stop: () => {
    const { abort, sessionId } = get();
    abort?.abort();
    if (sessionId) {
      fetch(`/api/chat/stop/${sessionId}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    }
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
      set({ messages: get().messages.map((m) => (m.id === msgId ? { ...m, content } : m)) });
      return;
    }

    // Editing a user message resends the conversation from that point:
    // drop the old turn and every later message, then send the edited text
    // through the normal stream path with the original attachments.
    const dropIds = messages.slice(idx).map((m) => m.dbId).filter((id): id is string => !!id);
    await deleteMessages(sessionId, dropIds);
    set({ messages: messages.slice(0, idx) });
    await get().send(content, { attachments: msg.attachments });
  },

  remove: async (msgId) => {
    const { sessionId, messages } = get();
    const msg = messages.find((m) => m.id === msgId);
    if (!sessionId || !msg?.dbId) throw new Error('Message not deletable yet');
    await deleteMessages(sessionId, [msg.dbId]);
    set({ messages: get().messages.filter((m) => m.id !== msgId) });
  },
}));

// Dev-only handle so the store can be driven from the console / preview evals
// (dynamic import() in DevTools resolves a second module instance under HMR).
if (import.meta.env.DEV) window.__talosChat = useChat;
