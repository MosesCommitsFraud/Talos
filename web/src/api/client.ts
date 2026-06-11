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

export async function editMessage(sessionId: string, msgId: string, content: string): Promise<void> {
  const res = await fetch(`/api/session/${sessionId}/edit-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_id: msgId, content }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Edit failed (HTTP ${res.status})`);
}

export async function deleteMessages(sessionId: string, msgIds: string[]): Promise<void> {
  const res = await fetch(`/api/session/${sessionId}/delete-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_ids: msgIds }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

export async function fetchArtifacts(sessionId: string): Promise<import('./types').Artifact[]> {
  const data = await getJSON<{ artifacts?: import('./types').Artifact[] }>(`/api/artifacts/${sessionId}`);
  return data.artifacts ?? [];
}

export const artifactDownloadUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${sessionId}/download?path=${encodeURIComponent(path)}`;

export const artifactsZipUrl = (sessionId: string) => `/api/artifacts/${sessionId}/zip`;

/** Admin: register a model endpoint (matches legacy "Add Models"). */
export async function addModelEndpoint(opts: { name: string; baseUrl: string; apiKey?: string }): Promise<void> {
  const fd = new FormData();
  fd.set('name', opts.name);
  fd.set('base_url', opts.baseUrl);
  if (opts.apiKey) fd.set('api_key', opts.apiKey);
  const res = await fetch('/api/model-endpoints', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

/* ── Admin settings (flat dict at /api/auth/settings) ── */
export type AppSettings = Record<string, unknown>;
export const fetchAppSettings = () => getJSON<AppSettings>('/api/auth/settings');

export async function saveAppSettings(patch: AppSettings): Promise<void> {
  const res = await fetch('/api/auth/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
}

export type Features = Record<string, boolean>;
export const fetchFeatures = () => getJSON<Features>('/api/auth/features');

export async function saveFeatures(features: Features): Promise<void> {
  const res = await fetch('/api/auth/features', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(features),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
}

export interface AppUser { username: string; is_admin: boolean }
export const fetchUsers = async () =>
  (await getJSON<{ users?: AppUser[] }>('/api/auth/users')).users ?? [];

export async function createUser(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

export async function deleteUser(username: string): Promise<void> {
  const res = await fetch('/api/auth/users', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

export async function setUserAdmin(username: string, isAdmin: boolean): Promise<void> {
  const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}/admin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_admin: isAdmin }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Update failed (HTTP ${res.status})`);
}

export interface RagConfig {
  enabled: boolean;
  embedding_url: string;
  embedding_model: string;
  qdrant_url: string;
  qdrant_api_key: string;
  rerank_url: string;
  rerank_model: string;
  rerank_api_key: string;
  chat_top_k: number;
  search_top_k: number;
  candidate_top_k: number;
}
export const fetchRagConfig = () => getJSON<RagConfig>('/api/rag/config');

export async function saveRagConfig(cfg: RagConfig): Promise<void> {
  const res = await fetch('/api/rag/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
}

export const testRagConfig = async (): Promise<{ ok?: boolean; [key: string]: unknown }> => {
  const res = await fetch('/api/rag/test', { method: 'POST', credentials: 'same-origin' });
  return res.json();
};

export interface Integration { id?: string; name?: string; enabled?: boolean; [key: string]: unknown }
export const fetchIntegrations = async () =>
  (await getJSON<{ integrations?: Integration[] }>('/api/auth/integrations')).integrations ?? [];

export const fetchRuntime = () => getJSON<Record<string, unknown>>('/api/runtime');

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
