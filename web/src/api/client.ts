import type { ChatEvent, ModelEndpoint, Session, SessionDetail } from './types';

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401 || res.redirected && res.url.endsWith('/login')) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export const fetchSessions = () => getJSON<Session[]>('/api/sessions');

export const fetchSession = (id: string) => getJSON<SessionDetail>(`/api/session/${id}`);

export const fetchModels = () => getJSON<ModelEndpoint[]>('/api/models');

export async function createSession(opts: { endpointId: string; model: string; name?: string }): Promise<Session> {
  const fd = new FormData();
  fd.set('name', opts.name ?? '');
  fd.set('endpoint_id', opts.endpointId);
  fd.set('model', opts.model);
  const res = await fetch('/api/session', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`createSession: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function renameSession(id: string, name: string): Promise<void> {
  const fd = new FormData();
  fd.set('name', name);
  await fetch(`/api/session/${id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/session/${id}`, { method: 'DELETE', credentials: 'same-origin' });
}

export async function archiveSession(id: string): Promise<void> {
  await fetch(`/api/session/${id}/archive`, { method: 'POST', credentials: 'same-origin' });
}

export async function markImportant(id: string, important: boolean): Promise<void> {
  const fd = new FormData();
  fd.set('important', String(important));
  await fetch(`/api/session/${id}/important`, { method: 'POST', body: fd, credentials: 'same-origin' });
}

export interface UploadedFile { id: string; name?: string; [key: string]: unknown }

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name || 'paste.png');
  const res = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || e.error || detail; } catch { /* noop */ }
    throw new Error(`Upload failed: ${detail}`);
  }
  const data = await res.json();
  return data.files ?? [];
}

export interface MemoryItem { id: string; content?: string; text?: string; created_at?: number; [key: string]: unknown }
export const fetchMemories = () => getJSON<MemoryItem[]>('/api/memory');

export interface LibraryDoc { id: string; title?: string; name?: string; updated_at?: number; [key: string]: unknown }
export async function fetchLibrary(): Promise<LibraryDoc[]> {
  const data = await getJSON<LibraryDoc[] | { documents?: LibraryDoc[]; library?: LibraryDoc[] }>('/api/documents/library');
  if (Array.isArray(data)) return data;
  return data.documents ?? data.library ?? [];
}

export interface AuthInfo { auth_enabled: boolean; user?: string; is_admin?: boolean }
export const fetchAuthInfo = () => getJSON<AuthInfo>('/api/auth/settings');

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/login';
}

export interface StreamFlags {
  planMode?: boolean;
  useRag?: boolean;
  useDb?: boolean;
  useWeb?: boolean;
  incognito?: boolean;
  attachments?: string[];
}

/**
 * Stream a chat turn. Parses the backend's SSE framing
 * (`data: {json}\n\n`, terminated by `data: [DONE]`) and invokes
 * onEvent for every event.
 */
export async function streamChat(opts: {
  message: string;
  sessionId: string;
  flags?: StreamFlags;
  signal?: AbortSignal;
  onEvent: (ev: ChatEvent) => void;
}): Promise<void> {
  const fd = new FormData();
  fd.set('message', opts.message);
  fd.set('session', opts.sessionId);
  const f = opts.flags ?? {};
  if (f.planMode) fd.set('plan_mode', 'true');
  if (f.useRag) fd.set('use_rag', 'true');
  if (f.useDb) fd.set('use_db', 'true');
  if (f.useWeb) fd.set('use_web', 'true');
  if (f.incognito) fd.set('incognito', 'true');
  if (f.attachments?.length) fd.set('attachments', JSON.stringify(f.attachments));

  const tzOffsetMin = -new Date().getTimezoneOffset();
  let tzName = '';
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* noop */ }

  const res = await fetch('/api/chat_stream', {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
    headers: { 'X-Tz-Offset': String(tzOffsetMin), 'X-Tz-Name': tzName },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let detail = `Error ${res.status}`;
    try {
      const text = await res.text();
      const m = text.match(/"message"\s*:\s*"([^"]+)"/);
      if (m) detail = m[1];
      else if (text.length < 200) detail = text;
    } catch { /* noop */ }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') return;
        try {
          opts.onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // Malformed frame — skip rather than kill the stream.
        }
      }
    }
  }
}
