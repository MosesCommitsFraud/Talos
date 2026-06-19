import type { Attachment, ChatEvent, ModelEndpoint, Session, SessionDetail } from './types';

/** Fired when any API call hits a 401 — the AuthGate listens and flips to the
 *  in-app login screen (e.g. after the server restarted and forgot all
 *  sessions). */
export const UNAUTHENTICATED_EVENT = 'talos:unauthenticated';

function notifyUnauthenticated() {
  window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export const fetchSessions = () => getJSON<Session[]>('/api/sessions');

export async function fetchSession(id: string): Promise<SessionDetail> {
  const data = await getJSON<Omit<SessionDetail, 'id'> & { id?: string }>(`/api/history/${id}`);
  return { id: data.id ?? id, name: data.name ?? '', history: Array.isArray(data.history) ? data.history : [] };
}

interface ApiModelItem {
  endpoint_id?: string;
  endpoint_name?: string;
  url?: string;
  models?: unknown;
  model_type?: string;
  offline?: boolean;
}

export async function fetchModels(): Promise<ModelEndpoint[]> {
  const data = await getJSON<ModelEndpoint[] | { items?: ApiModelItem[] }>('/api/models');
  if (Array.isArray(data)) return data;
  return (Array.isArray(data.items) ? data.items : []).map((item) => ({
    id: String(item.endpoint_id ?? item.url ?? ''),
    name: String(item.endpoint_name ?? item.url ?? 'Model endpoint'),
    base_url: String(item.url ?? ''),
    models: Array.isArray(item.models) ? item.models.map(String) : [],
    model_type: String(item.model_type ?? 'llm'),
    is_enabled: !item.offline,
  }));
}

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

export async function setSessionFolder(id: string, folder: string | null): Promise<void> {
  const fd = new FormData();
  fd.set('folder', folder ?? '');
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

export interface UploadedFile extends Attachment {}

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
  notifyUnauthenticated();
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

export const uploadDownloadUrl = (id: string) => `/api/upload/${encodeURIComponent(id)}`;

/** Admin: register a model endpoint (matches legacy "Add Models"). */
export async function addModelEndpoint(opts: { name?: string; baseUrl: string; apiKey?: string; modelType?: string }): Promise<void> {
  const fd = new FormData();
  fd.set('name', opts.name ?? '');
  fd.set('base_url', opts.baseUrl);
  if (opts.apiKey) fd.set('api_key', opts.apiKey);
  if (opts.modelType) fd.set('model_type', opts.modelType);
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

export interface UserPrivileges {
  can_use_agent?: boolean;
  can_use_browser?: boolean;
  can_use_bash?: boolean;
  can_use_documents?: boolean;
  can_use_research?: boolean;
  can_generate_images?: boolean;
  can_manage_memory?: boolean;
  max_messages_per_day?: number;
  allowed_models?: string[];
}

export interface AppUser { username: string; is_admin: boolean; privileges?: UserPrivileges }
export const fetchUsers = async () =>
  (await getJSON<{ users?: AppUser[] }>('/api/auth/users')).users ?? [];

export async function createUser(username: string, password: string, isAdmin = false): Promise<void> {
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, is_admin: isAdmin }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

export const renameUser = (username: string, next: string) =>
  postJSON<{ ok?: boolean; renamed_self?: boolean }>(
    `/api/auth/users/${encodeURIComponent(username)}/rename`, { username: next }, 'PUT');

export const setUserPrivileges = (username: string, patch: UserPrivileges) =>
  postJSON(`/api/auth/users/${encodeURIComponent(username)}/privileges`, patch, 'PUT');

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
  provider?: string;
  external_url?: string;
  external_api_key?: string;
  external_api_key_set?: boolean;
  external_dataset_id?: string;
  external_top_k?: number;
  embedding_url: string;
  embedding_model: string;
  qdrant_url: string;
  qdrant_api_key: string;
  rerank_url: string;
  rerank_model: string;
  rerank_api_key: string;
  sparse_model: string;
  chat_top_k: number;
  search_top_k: number;
  candidate_top_k: number;
  similarity_threshold: number;
  rerank_min_score: number;
  max_context_chars: number;
  query_prefix: string;
  context_prompt: string;
}
/** Which knowledge sources are configured — drives the composer's mode control. */
export const fetchCapabilities = () => getJSON<{ rag: boolean; sql: boolean }>('/api/capabilities');

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

/* ── Account: password + 2FA ── */
async function postJSON<T = Record<string, unknown>>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 401 && !url.startsWith('/api/auth/login')) notifyUnauthenticated();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || e.error || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json().catch(() => ({}) as T);
}

export const changePassword = (currentPassword: string, newPassword: string) =>
  postJSON('/api/auth/change-password', { current_password: currentPassword, new_password: newPassword });

export interface TotpStatus { enabled: boolean }
export const fetchTotpStatus = () => getJSON<TotpStatus>('/api/auth/2fa/status');
export const totpSetup = () => postJSON<{ secret: string; uri: string; qr_code: string }>('/api/auth/2fa/setup');
export const totpConfirm = (code: string) => postJSON<{ ok: boolean; backup_codes: string[] }>('/api/auth/2fa/confirm', { code });
export const totpDisable = (password: string) => postJSON('/api/auth/2fa/disable', { password });

/* ── Auth: status + login/setup/signup ── */
export interface AuthStatus {
  configured?: boolean;
  authenticated?: boolean;
  username?: string;
  is_admin?: boolean;
  privileges?: UserPrivileges;
  signup_enabled?: boolean;
  auth_enabled?: boolean;
  [key: string]: unknown;
}
export const fetchAuthStatus = () => getJSON<AuthStatus>('/api/auth/status');
export const toggleSignup = () => postJSON<{ signup_enabled: boolean }>('/api/auth/signup-toggle');

export interface LoginResult { ok: boolean; requires_totp?: boolean; username?: string }
export const login = (username: string, password: string, totpCode?: string) =>
  postJSON<LoginResult>('/api/auth/login', {
    username,
    password,
    ...(totpCode ? { totp_code: totpCode } : {}),
  });

export const setupAdmin = (username: string, password: string) =>
  postJSON<{ ok: boolean }>('/api/auth/setup', { username, password });

export const signup = (username: string, password: string) =>
  postJSON<{ ok: boolean }>('/api/auth/signup', { username, password });

/* ── Model endpoints extras ── */
export async function testModelEndpoint(baseUrl: string, apiKey?: string): Promise<Record<string, unknown>> {
  const fd = new FormData();
  fd.set('base_url', baseUrl);
  if (apiKey) fd.set('api_key', apiKey);
  const res = await fetch('/api/model-endpoints/test', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}

export const discoverEndpoints = () => getJSON<Record<string, unknown>>('/api/discover');

/* ── Integrations CRUD ── */
export const fetchIntegrationPresets = () =>
  getJSON<Record<string, { name?: string; base_url?: string;[key: string]: unknown }>>('/api/auth/integrations/presets');
export const createIntegration = (body: Record<string, unknown>) => postJSON('/api/auth/integrations', body);
export const updateIntegration = (id: string, patch: Record<string, unknown>) =>
  postJSON(`/api/auth/integrations/${encodeURIComponent(id)}`, patch, 'PUT');
export const deleteIntegration = (id: string) =>
  postJSON(`/api/auth/integrations/${encodeURIComponent(id)}`, undefined, 'DELETE');

/* ── RAG documents ── */
export const ragSearch = (q: string, k: number) =>
  getJSON<Record<string, unknown>>(`/api/rag/search?q=${encodeURIComponent(q)}&k=${k}`);
export const personalAddDirectory = (directory: string) => postJSON('/api/personal/add_directory', { directory });
export const personalReload = () => postJSON('/api/personal/reload');

export async function personalUpload(files: File[]): Promise<Record<string, unknown>> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  const res = await fetch('/api/personal/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.detail).catch(() => null);
    throw new Error(detail || `Upload failed (HTTP ${res.status})`);
  }
  return res.json();
}

/* ── RAG ingest jobs (RQ queue) + indexed documents ── */
export interface RagJob {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  directory: string;
  indexed_count: number;
  failed_count: number;
  current_file: string;
  message: string;
  errors: { file: string; error: string }[];
  created_at: number | null;
  started_at: number | null;
  ended_at: number | null;
}
export interface RagWorkerDiag {
  active_worker_count: number;
  active_workers: string[];
  multi_worker_warning: boolean;
  message: string;
}
export interface RagDocument {
  source: string;
  filename: string;
  type: string;
  directory: string;
  chunks: number;
}

export const fetchRagJobs = () => getJSON<{ jobs: RagJob[] }>('/api/rag/jobs');
export const fetchRagWorkerDiag = () => getJSON<RagWorkerDiag>('/api/rag/jobs/diagnostics');
export const cancelRagJob = (id: string) => postJSON(`/api/rag/jobs/${id}/cancel`);
export const clearRagJobs = () => postJSON('/api/rag/jobs/clear');
export async function deleteRagJob(id: string): Promise<void> {
  const res = await fetch(`/api/rag/jobs/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}
export const fetchRagDocuments = () =>
  getJSON<{ available: boolean; documents: RagDocument[]; error?: string }>('/api/rag/documents');
export async function deleteRagDocument(source: string): Promise<void> {
  const res = await fetch(`/api/rag/documents?source=${encodeURIComponent(source)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

/* ── SQL database (query_sql tool, MSSQL etc.) ── */
export interface SqlConfig {
  id?: string;
  name: string;
  enabled: boolean;
  db_type: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password?: string;
  password_set?: boolean;
  odbc_driver: string;
}
export const fetchSqlConfig = async (): Promise<SqlConfig[]> =>
  (await getJSON<{ databases?: SqlConfig[] }>('/api/sql/config')).databases ?? [];
export const saveSqlConfig = (databases: SqlConfig[]) => postJSON('/api/sql/config', { databases }, 'PUT');
export const deleteSqlConfig = (id?: string) =>
  postJSON(`/api/sql/config${id ? `?id=${encodeURIComponent(id)}` : ''}`, undefined, 'DELETE');
export const testSqlConfig = (id?: string) =>
  postJSON<{ ok?: boolean; error?: string; output?: string }>(`/api/sql/test${id ? `?id=${encodeURIComponent(id)}` : ''}`);

/* ── SQL knowledge (scoped mini-RAG over uploaded schema files) ── */
export const fetchSqlKnowledge = () =>
  getJSON<{ available: boolean; documents: RagDocument[]; error?: string }>('/api/sql/knowledge');
export async function uploadSqlKnowledge(files: File[]): Promise<Record<string, unknown>> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  const res = await fetch('/api/sql/knowledge/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.detail).catch(() => null);
    throw new Error(detail || `Upload failed (HTTP ${res.status})`);
  }
  return res.json();
}
export async function deleteSqlKnowledge(source: string): Promise<void> {
  const res = await fetch(`/api/sql/knowledge?source=${encodeURIComponent(source)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

/* ── Built-in agent tools ── */
export interface BuiltinTool { id: string; enabled: boolean }
export const fetchBuiltinTools = async () =>
  (await getJSON<{ tools?: BuiltinTool[] }>('/api/tools')).tools ?? [];
export const saveDisabledTools = (disabled: string[]) => postJSON('/api/tools', { disabled });

/* ── System: backup + danger zone ── */
export const importData = (data: unknown) => postJSON<{ ok?: boolean; message?: string }>('/api/import', data);
export const wipeData = (kind: string) => postJSON<{ ok?: boolean;[key: string]: unknown }>(`/api/admin/wipe/${kind}`, undefined, 'DELETE');

export interface StreamFlags {
  planMode?: boolean;
  /** A previously proposed plan the user approved — the turn executes it. */
  approvedPlan?: string;
  useRag?: boolean;
  useDb?: boolean;
  useWeb?: boolean;
  /** Model reasoning/thinking. When false the backend disables it (vLLM
   *  `enable_thinking: false`). Omitted/true leaves the model's default on. */
  reasoning?: boolean;
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
  if (f.approvedPlan) fd.set('approved_plan', f.approvedPlan);
  if (f.useRag) fd.set('use_rag', 'true');
  if (f.useDb) fd.set('use_db', 'true');
  if (f.useWeb) fd.set('use_web', 'true');
  if (f.reasoning === false) fd.set('reasoning', 'false');
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
