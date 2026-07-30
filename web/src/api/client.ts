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
export const fetchArchivedSessions = () => getJSON<Session[]>('/api/sessions/archived');

/** Which build this container was started from. `build` is the git sha CI
 *  compiled, or "dev-build" for a locally built image. */
export const fetchBuildInfo = () =>
  getJSON<{ version: string; build: string; tag: string }>('/api/version/build');

/** Newest published release vs. the running one. The server answers
 *  latest === current whenever it can't reach GitHub or the check is disabled,
 *  so callers never have to render an error state for this. */
export const fetchVersionUpdates = () =>
  getJSON<{ current: string; latest: string; enabled: boolean; dev: boolean }>(
    '/api/version/updates',
  );

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
  // Taking a chat out of its folder is sent as an explicit flag: an empty
  // `folder` value is indistinguishable from "field not sent" by the time it
  // has been through a form parser, so removal quietly did nothing.
  if (!folder) fd.set('clear_folder', 'true');
  const res = await fetch(`/api/session/${id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`setSessionFolder: ${res.status} ${await res.text()}`);
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/session/${id}`, { method: 'DELETE', credentials: 'same-origin' });
}

export async function archiveSession(id: string): Promise<void> {
  await fetch(`/api/session/${id}/archive`, { method: 'POST', credentials: 'same-origin' });
}

export async function unarchiveSession(id: string): Promise<void> {
  await fetch(`/api/session/${id}/unarchive`, { method: 'POST', credentials: 'same-origin' });
}

export async function markImportant(id: string, important: boolean): Promise<void> {
  const fd = new FormData();
  fd.set('important', String(important));
  await fetch(`/api/session/${id}/important`, { method: 'POST', body: fd, credentials: 'same-origin' });
}

export interface CompactResult { ok: boolean; summarized: number; kept: number; message_count: number }

/** Run the backend's real conversation compactor and persist the shortened history. */
export const compactSession = (id: string) =>
  postJSON<CompactResult>(`/api/session/${encodeURIComponent(id)}/compact`);

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

/** Aggregated usage stats for the empty-chat home screen. */
export interface UsageStats {
  sessions: number;
  messages: number;
  total_tokens: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  /** 0–23 in the client's local time, or null with no messages yet. */
  peak_hour: number | null;
  favorite_model: string | null;
  /** Daily message counts, oldest→today (~26 weeks) — feeds the heatmap. */
  daily: { date: string; count: number }[];
}

/** days=0 → all time; otherwise tile stats cover the last N local days
 *  (the heatmap always spans the full window). */
export const fetchUsageStats = (days = 0) =>
  getJSON<UsageStats>(`/api/stats?tz_offset=${-new Date().getTimezoneOffset()}&days=${days}`);

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
  const data = await getJSON<{ artifacts?: import('./types').Artifact[] }>(`/api/artifacts/${encodeURIComponent(sessionId)}`);
  return data.artifacts ?? [];
}

export const artifactDownloadUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(path)}`;

export const artifactPreviewUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${encodeURIComponent(sessionId)}/preview?path=${encodeURIComponent(path)}`;

/** Fetch a workspace file's raw bytes — used by the preview panel to render
 *  Word/Excel/PDF (which need the binary) and text/markdown (decoded to text). */
export async function fetchArtifactBlob(sessionId: string, path: string): Promise<Blob> {
  const res = await fetch(artifactDownloadUrl(sessionId, path), { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`artifact ${path}: ${res.status}`);
  return res.blob();
}

export async function fetchArtifactPreviewBlob(sessionId: string, path: string): Promise<Blob> {
  const res = await fetch(artifactPreviewUrl(sessionId, path), { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) notifyUnauthenticated();
  if (!res.ok) throw new Error(`artifact preview ${path}: ${res.status}`);
  return res.blob();
}

export async function downloadArtifact(sessionId: string, path: string, name: string): Promise<void> {
  const blob = await fetchArtifactBlob(sessionId, path);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export interface DocumentRecord {
  id: string;
  title: string;
  language?: string;
  current_content: string;
  version_count: number;
}

export interface DocumentVersion {
  id: string;
  version_number: number;
  content: string;
  summary?: string;
  source?: string;
  created_at?: string;
}

export async function updateDocument(docId: string, content: string): Promise<DocumentRecord> {
  const res = await fetch(`/api/document/${encodeURIComponent(docId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, summary: 'Edited in Preview' }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Document save failed (HTTP ${res.status})`);
  return res.json() as Promise<DocumentRecord>;
}

export const fetchDocumentVersions = (docId: string) =>
  getJSON<DocumentVersion[]>(`/api/document/${encodeURIComponent(docId)}/versions`);

export const restoreDocumentVersion = (docId: string, version: number) =>
  postJSON<DocumentRecord>(`/api/document/${encodeURIComponent(docId)}/restore/${version}`, {});

export const artifactsZipUrl = (sessionId: string) => `/api/artifacts/${encodeURIComponent(sessionId)}/zip`;

export async function downloadArtifactsZip(sessionId: string): Promise<void> {
  const res = await fetch(artifactsZipUrl(sessionId), { credentials: 'same-origin' });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`Artifact archive failed (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chat-files.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export const uploadDownloadUrl = (id: string) => `/api/upload/${encodeURIComponent(id)}`;

/** Admin: download the raw debug dump of a chat — every message with its full
 *  content and metadata (per-round reasoning, tool calls with commands, outputs
 *  and exit codes, turn metrics), plus the live in-memory history. */
export async function downloadChatDebugDump(sessionId: string): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/debug-dump`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`Debug dump failed (HTTP ${res.status})`);
  // Honour the filename the server picked (debug_<chat>_<timestamp>.json).
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `debug_${sessionId}.json`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

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

/* ── Named AI endpoints (assistant profiles) ── */
import type { AssistantEndpoint } from './types';

export const fetchAssistants = () => getJSON<AssistantEndpoint[]>('/api/assistants');

async function assistantWrite(url: string, method: string, body: Partial<AssistantEndpoint>): Promise<AssistantEndpoint> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}

export const createAssistant = (body: Partial<AssistantEndpoint>) =>
  assistantWrite('/api/assistants', 'POST', body);

export const updateAssistant = (id: string, body: Partial<AssistantEndpoint>) =>
  assistantWrite(`/api/assistants/${id}`, 'PATCH', body);

export async function deleteAssistant(id: string): Promise<void> {
  const res = await fetch(`/api/assistants/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

/* ── Per-user preferences (server-side key/value store) ── */

export async function fetchUserPref<T>(key: string): Promise<T | null> {
  const data = await getJSON<{ key: string; value: T | null }>(`/api/prefs/${encodeURIComponent(key)}`);
  return data.value ?? null;
}

export async function saveUserPref(key: string, value: unknown): Promise<void> {
  const res = await fetch(`/api/prefs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
}

/* ── Shared uploaded skills (Claude-style SKILL.md library) ── */

export interface SharedSkill {
  name: string;
  description: string;
  uploaded_by?: string | null;
  size: number;
  files: number;
  created_at?: string | null;
  updated_at?: string | null;
  enabled: boolean;
  mine: boolean;
}

export const fetchSharedSkills = () =>
  getJSON<{ skills: SharedSkill[]; count: number }>('/api/shared-skills');

export async function uploadSharedSkill(content: string): Promise<void> {
  const res = await fetch('/api/shared-skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `Upload failed (HTTP ${res.status})`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
}

export async function uploadSharedSkillBundle(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/shared-skills/upload', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `Upload failed (HTTP ${res.status})`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
}

export async function deleteSharedSkill(name: string): Promise<void> {
  const res = await fetch(`/api/shared-skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

export async function setSharedSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const res = await fetch(`/api/shared-skills/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Update failed (HTTP ${res.status})`);
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
  can_use_documents?: boolean;
  can_use_research?: boolean;
  can_generate_images?: boolean;
  can_manage_memory?: boolean;
  max_messages_per_day?: number;
  allowed_models?: string[];
}

export interface AppUser { username: string; display_name?: string | null; is_admin: boolean; privileges?: UserPrivileges }
export const fetchUsers = async () =>
  (await getJSON<{ users?: AppUser[] }>('/api/auth/users')).users ?? [];

export async function createUser(username: string, password: string, isAdmin = false, displayName = ''): Promise<void> {
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, is_admin: isAdmin, display_name: displayName || null }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

export const setDisplayName = (displayName: string) =>
  postJSON<{ ok?: boolean; display_name?: string | null }>('/api/auth/display-name', { display_name: displayName }, 'PUT');

export const adminSetDisplayName = (username: string, displayName: string) =>
  postJSON<{ ok?: boolean; display_name?: string | null }>(
    `/api/auth/users/${encodeURIComponent(username)}/display-name`, { display_name: displayName }, 'PUT');

export const adminResetPassword = (username: string, newPassword: string) =>
  postJSON<{ ok?: boolean }>(
    `/api/auth/users/${encodeURIComponent(username)}/password`, { new_password: newPassword }, 'PUT');

export const renameUser = (username: string, next: string) =>
  postJSON<{ ok?: boolean; renamed_self?: boolean }>(
    `/api/auth/users/${encodeURIComponent(username)}/rename`, { username: next }, 'PUT');

export const setUserPrivileges = (username: string, patch: UserPrivileges) =>
  postJSON(`/api/auth/users/${encodeURIComponent(username)}/privileges`, patch, 'PUT');

/* ── Admin usage analytics (Users workspace) ──
   Backed by the `usage_events` table; see routes/admin_usage_routes.py. The
   `tz_offset` argument is minutes east of UTC, matching /api/stats — day
   buckets have to land on the admin's local calendar, not UTC's. */

const tzOffset = () => -new Date().getTimezoneOffset();

export interface UsageUserRow {
  username: string;
  display_name?: string | null;
  is_admin: boolean;
  /** Activity from an account that no longer exists. */
  orphaned: boolean;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  sessions: number;
  active_days: number;
  web_searches: number;
  skill_loads: number;
  skills_created: number;
  top_tool: string | null;
  modes: Record<string, number>;
  last_active: string | null;
  rank: number;
}

export interface UsageOverview {
  days: number;
  users: UsageUserRow[];
  totals: {
    turns: number; tool_calls: number; total_tokens: number;
    input_tokens: number; output_tokens: number; sessions: number; active_users: number;
  };
  median: { turns: number; total_tokens: number; tool_calls: number };
  /** Model → turn count. One entry = single-model deployment; the UI hides
   *  the breakdown until a second model shows up. */
  models: Record<string, number>;
}

export interface UsageDetail {
  username: string;
  days: number;
  tiles: {
    turns: number; tool_calls: number; tool_errors: number;
    input_tokens: number; output_tokens: number; total_tokens: number;
    sessions: number; active_days: number; web_searches: number; skill_loads: number;
    avg_tokens_per_turn: number; peak_hour: number | null; last_active: string | null;
    first_seen: string | null;
    /** Wall-clock generation time. Raw-retention window only — the daily
     *  rollup drops per-turn durations. */
    avg_response_ms: number; total_compute_ms: number; avg_rounds: number;
    busiest_day: string | null; busiest_day_tokens: number;
  };
  daily: Array<{ date: string; turns: number; tokens: number; input: number; output: number; tools: number }>;
  hours: number[];
  /** Monday-first turn counts. */
  weekday: number[];
  tools: Array<{ tool: string; count: number; errors: number }>;
  /** chat | knowledge | sql | full → turn count. Empty for history recorded
   *  before the knowledge mode was persisted (see the backfill script). */
  modes: Record<string, number>;
  models: Record<string, number>;
  skills: { used: Array<{ name: string; count: number }>; authored: string[] };
  comparison: {
    rank: number; of: number;
    median_tokens: number; median_turns: number; median_tools: number;
  };
  limit: { max_messages_per_day: number; hit_days: number };
}

export interface StorageCategory {
  kind: string;
  count: number;
  detail: string | null;
  bytes: number;
}

export interface StorageOverview {
  username: string;
  categories: StorageCategory[];
  total_bytes: number;
  /** Uploads sit in a flat directory with no per-user subtree, so they can't
   *  be attributed; the UI says so rather than showing a wrong number. */
  uploads_attributable: boolean;
}

/* Usernames are email addresses, so they go in the POST body — never in the
   URL. A path like /api/admin/usage/user/name%40company.com puts personal data
   in the server access log and browser history, and content blockers drop
   email-shaped URLs outright, which fails as an unexplained "Failed to fetch"
   with no request ever reaching the server. Only the overview, which names
   nobody, stays a GET. */

export const fetchUsageOverview = (days: number) =>
  getJSON<UsageOverview>(`/api/admin/usage/overview?tz_offset=${tzOffset()}&days=${days}`);

export const fetchUsageDetail = (username: string, days: number) =>
  postJSON<UsageDetail>('/api/admin/usage/detail', { username, tz_offset: tzOffset(), days });

export const fetchUserStorage = (username: string) =>
  postJSON<StorageOverview>('/api/admin/storage/detail', { username });

export const deleteUserStorage = (username: string, kind: string) =>
  postJSON<{ count: number }>('/api/admin/storage/delete', { username, kind });

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
  /** Auto-inject retrieved context on every RAG/Full-Knowledge turn (default on).
   *  When off, knowledge reaches the model only via the `search_knowledge` tool. */
  auto_inject_enabled?: boolean;
  /** Advanced — opt-in audio/video transcription lane (off by default). */
  video_asr_enabled?: boolean;
  video_asr_url?: string;
  video_asr_language?: string;
  video_asr_prompt?: string;
  video_asr_correct_enabled?: boolean;
  /** Advanced — opt-in video keyframe lane: index what's shown on screen (off by default). */
  video_frames_enabled?: boolean;
  video_frames_interval_sec?: number;
  video_frames_max?: number;
  /** Advanced — opt-in pixel image embedding lane (off by default). */
  image_pixel_enabled?: boolean;
  image_embed_url?: string;
  image_embed_model?: string;
  /** Advanced — opt-in tree-sitter AST code chunking (off by default). */
  code_lane_enabled?: boolean;
  /** Advanced — conversation-aware query rewrite before retrieval (off by default). */
  query_rewrite_enabled?: boolean;
  /** Advanced — ingest-time Contextual Retrieval + the LLM endpoint it uses. */
  contextual_retrieval_enabled?: boolean;
  llm_url?: string;
  llm_model?: string;
  /** Advanced — auto keyword/question generation per chunk (0 = off). */
  auto_keywords_n?: number;
  auto_questions_n?: number;
  /** Advanced — small-to-big: inject the matched chunk's whole section. */
  expand_to_parent_enabled?: boolean;
  parent_max_chars?: number;
  /** Advanced — per-page VLM transcription for image-heavy PDFs + its endpoint. */
  pdf_vlm_enabled?: boolean;
  vlm_url?: string;
  vlm_model?: string;
  /** Output language for VLM figure captions (""/"auto" = infer). */
  caption_language?: string;
  /** Advanced — redact PII from extracted text before indexing (off by default;
   *  overridable per upload). */
  redact_pii_enabled?: boolean;
}
/** Which knowledge sources are configured — drives the composer's mode control. */
export const fetchCapabilities = () =>
  getJSON<{ rag: boolean; sql: boolean; voice: boolean; voice_streaming: boolean }>(
    '/api/capabilities',
  );

/** Send a dictation clip to the backend ASR proxy; returns the transcript. */
export async function transcribeVoice(blob: Blob, signal?: AbortSignal): Promise<string> {
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
  const fd = new FormData();
  fd.append('file', blob, `dictation.${ext}`);
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
    signal,
  });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
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

/** Probe a single RAG endpoint with the (possibly unsaved) form values. */
export const testRagEndpoint = (body: { kind: string; url: string; model?: string; api_key?: string; dataset_id?: string }) =>
  postJSON<{ ok?: boolean; detail?: string }>('/api/rag/test-endpoint', body);

/** Recreate the Qdrant collection (drops vectors, keeps uploaded files). Used
 *  after an embedding-model change alters the vector dimension. */
export const ragRebuildIndex = () => postJSON<{ ok?: boolean; message?: string }>('/api/rag/rebuild');

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
  display_name?: string | null;
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

export async function personalUpload(
  files: File[],
  opts?: { redactPii?: boolean | null },
): Promise<Record<string, unknown>> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  // Explicit per-upload PII-redaction choice; omitted → server uses the global toggle.
  if (opts?.redactPii != null) fd.append('redact_pii', String(opts.redactPii));
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
  /** Files processed / total. total_count is 0 for directory ingest (no upfront
   *  count) → render an indeterminate state instead of a percentage. */
  processed_count?: number;
  total_count?: number;
  /** Sub-progress within the current file (VLM lanes report pages/images), so the
   *  bar advances during a single large document instead of jumping 0%→done. */
  sub_done?: number;
  sub_total?: number;
  /** Which sub-step is running (e.g. 'asr', 'frames_vlm') — i18n key suffix
   *  for a label next to the sub-progress numbers. */
  stage?: string;
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

/** One indexed chunk, as stored in Qdrant — the ground truth the retriever
 *  sees. Used by the /rag explorer's debug/edit view. */
export interface RagChunk {
  id: string;
  content: string;
  seq: number;
  section_id: string;
  context: string;
  context_error: string;
  aux_terms: string;
  aux_terms_error: string;
  symbol: string;
  language: string;
  modality: string;
  metadata: Record<string, unknown>;
}
/** Download URL for the Markdown dump of everything indexed for one source
 *  file (ingest-quality audit; served as an attachment). */
export const ragDocumentExportUrl = (source: string) =>
  `/api/rag/documents/export?source=${encodeURIComponent(source)}`;
export const fetchRagChunks = (source: string) =>
  getJSON<{ available: boolean; source: string; chunks: RagChunk[]; error?: string }>(
    `/api/rag/documents/chunks?source=${encodeURIComponent(source)}`,
  );
export const updateRagChunk = (source: string, id: string, content: string) =>
  postJSON<{ ok: boolean; id: string }>(
    `/api/rag/documents/chunks/${encodeURIComponent(id)}`,
    { source, content },
    'PUT',
  );
export async function deleteRagChunk(source: string, id: string): Promise<void> {
  const res = await fetch(
    `/api/rag/documents/chunks/${encodeURIComponent(id)}?source=${encodeURIComponent(source)}`,
    { method: 'DELETE', credentials: 'same-origin' },
  );
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}
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
  /** Model reasoning/thinking. When false the backend disables it (vLLM
   *  `enable_thinking: false`). Omitted/true leaves the model's default on. */
  reasoning?: boolean;
  incognito?: boolean;
  attachments?: string[];
  /** UI language ("de"/"en") — the backend writes auto-generated session
   *  titles in this language. */
  lang?: string;
  /** Language for model reasoning/thinking and final responses. */
  llmLanguage?: string;
  /** Database-backed document currently selected in Preview. */
  activeDocId?: string;
  artifactSelection?: import('./types').ArtifactSelection;
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
  if (f.reasoning === false) fd.set('reasoning', 'false');
  if (f.incognito) fd.set('incognito', 'true');
  if (f.lang) fd.set('lang', f.lang);
  if (f.llmLanguage) fd.set('llm_language', f.llmLanguage);
  if (f.activeDocId) fd.set('active_doc_id', f.activeDocId);
  if (f.artifactSelection) fd.set('artifact_selection', JSON.stringify(f.artifactSelection));
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

  await readSse(res, opts.onEvent);
}

/** Reattach to a turn that is still running server-side (the run is detached
 *  from the request that started it, so a reload/tab close doesn't kill it).
 *  The server replays the run's whole event log before going live, so the
 *  caller rebuilds the turn from the start exactly as it originally streamed. */
export async function resumeChat(opts: {
  sessionId: string;
  signal?: AbortSignal;
  onEvent: (ev: ChatEvent) => void;
}): Promise<void> {
  const res = await fetch(`/api/chat/resume/${opts.sessionId}`, {
    credentials: 'same-origin',
    signal: opts.signal,
  });
  // 404 = the run finished (or was evicted) between discovery and reconnect.
  if (res.status === 404) return;
  if (!res.ok || !res.body) throw new Error(`resumeChat: ${res.status}`);
  await readSse(res, opts.onEvent);
}

/** Session ids whose turn is still running server-side — asked once on page
 *  load so the UI can reattach to background runs it knows nothing about. */
export async function fetchActiveRuns(): Promise<string[]> {
  try {
    const data = await getJSON<{ sessions?: string[] }>('/api/chat/active_runs');
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return []; // older server without the endpoint — nothing to reattach to
  }
}

/** Parse an SSE body frame-by-frame, dispatching each `data:` payload. Returns
 *  when the stream ends or a `[DONE]` sentinel arrives. */
async function readSse(res: Response, onEvent: (ev: ChatEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
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
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // Malformed frame — skip rather than kill the stream.
        }
      }
    }
  }
}
