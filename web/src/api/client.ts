import type { Attachment, ChatEvent, ModelEndpoint, Session, SessionDetail } from './types';
import { relativePathOf, uploadBatches } from '@/lib/uploadItems';

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
  const data = await getJSON<{
    id?: string;
    name?: string;
    history?: SessionDetail['history'];
    read_only?: boolean;
    owner?: string | null;
    project_id?: string | null;
  }>(`/api/history/${id}`);
  return {
    id: data.id ?? id,
    name: data.name ?? '',
    history: Array.isArray(data.history) ? data.history : [],
    readOnly: !!data.read_only,
    owner: data.owner ?? null,
    projectId: data.project_id ?? null,
  };
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

export async function setSessionProject(id: string, projectId: string | null): Promise<void> {
  const fd = new FormData();
  // Taking a chat out is an explicit flag: an empty value is indistinguishable
  // from "field not sent" by the time it has been through a form parser.
  if (projectId) fd.set('project_id', projectId);
  else fd.set('clear_project', 'true');
  const res = await fetch(`/api/session/${id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`setSessionProject: ${res.status} ${await res.text()}`);
}

export async function setSessionSection(id: string, section: string | null): Promise<void> {
  const fd = new FormData();
  fd.set('section', section ?? '');
  // An explicit flag for the same reason as clear_folder above.
  if (!section) fd.set('clear_section', 'true');
  const res = await fetch(`/api/session/${id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`setSessionSection: ${res.status} ${await res.text()}`);
}

export async function setSessionUnread(id: string, unread: boolean): Promise<void> {
  const fd = new FormData();
  fd.set('unread', String(unread));
  const res = await fetch(`/api/session/${id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`setSessionUnread: ${res.status} ${await res.text()}`);
}

export interface ForkResult { id: string; name: string; files_forked: boolean }

/** Duplicate a chat with everything in it; see src/session_fork.py. A message id
 *  ends the copy there, or just ahead of it with `before`. */
export const forkSession = (id: string, at?: { messageId: string; before: boolean }) =>
  postJSON<ForkResult>(
    `/api/session/${encodeURIComponent(id)}/fork`,
    at && { message_id: at.messageId, before_message: at.before },
  );

/** Make a message a chapter of its chat; the server has the title written. */
export const setChapter = (sessionId: string, messageId: string, lang: string) =>
  postJSON<{ title: string }>(`/api/session/${encodeURIComponent(sessionId)}/chapter`, { message_id: messageId, lang });

export const removeChapter = (sessionId: string, messageId: string) =>
  postJSON(`/api/session/${encodeURIComponent(sessionId)}/chapter`, { message_id: messageId, remove: true });

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

/** Every artifact the user owns, across all their chats — the Artifacts page.
 *  Documents, generated images and the files the assistant wrote into each
 *  chat's workspace; each row carries the chat it came from and its pin. */
export async function fetchAllArtifacts(): Promise<import('./types').LibraryArtifact[]> {
  const data = await getJSON<{ artifacts?: import('./types').LibraryArtifact[] }>('/api/artifacts');
  return data.artifacts ?? [];
}

/** Pin/unpin or rename (`name` without extension) one library artifact.
 *  Resolves to the artifact's path afterwards — a renamed workspace file moves. */
export async function updateLibraryArtifact(
  ref: { path: string; sessionId?: string | null },
  change: { pinned?: boolean; name?: string },
): Promise<string> {
  const data = await postJSON<{ path?: string }>(
    '/api/artifacts',
    { path: ref.path, session_id: ref.sessionId ?? null, ...change },
    'PATCH',
  );
  return data.path ?? ref.path;
}

export async function deleteLibraryArtifact(ref: { path: string; sessionId?: string | null }): Promise<void> {
  const qs = new URLSearchParams({ path: ref.path });
  if (ref.sessionId) qs.set('session_id', ref.sessionId);
  await postJSON(`/api/artifacts?${qs}`, undefined, 'DELETE');
}

/** Detached background jobs belonging to a session — running and recently
 *  finished alike, oldest first. Polled by the task tray; the message stream
 *  says nothing about a job once the turn that launched it has ended. */
export async function fetchBgTasks(sessionId: string): Promise<import('./types').BgTask[]> {
  const data = await getJSON<{ tasks?: import('./types').BgTask[] }>(
    `/api/bg-tasks?session_id=${encodeURIComponent(sessionId)}`,
  );
  return data.tasks ?? [];
}

/** Stop one running subagent; the others and the chat turn keep going. */
export const stopBgTask = (sessionId: string, taskId: string) =>
  postJSON<{ stopped?: boolean }>(
    `/api/bg-tasks/${encodeURIComponent(taskId)}/stop?session_id=${encodeURIComponent(sessionId)}`,
  );

export const artifactDownloadUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(path)}`;

export const artifactPreviewUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${encodeURIComponent(sessionId)}/preview?path=${encodeURIComponent(path)}`;

/** Serves an HTML artifact as a real page (not a download) so it can be shown
 *  live in the preview iframe or opened in a new tab. The route sets a CSP that
 *  blocks all network access from the page. */
export const artifactRenderUrl = (sessionId: string, path: string) =>
  `/api/artifacts/${encodeURIComponent(sessionId)}/render?path=${encodeURIComponent(path)}`;

/** Raw bytes from any same-origin URL — the preview panel's path for files that
 *  aren't workspace artifacts (chat uploads, which live under /api/upload). */
export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.blob();
}

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

/** Save a preview file: a workspace artifact by session+path, or (for chat
 *  uploads, which carry their own URL) whatever that URL serves. */
export async function downloadPreviewFile(file: { sessionId: string; path: string; name: string; url?: string }): Promise<void> {
  if (!file.url) return downloadArtifact(file.sessionId, file.path, file.name);
  const blob = await fetchBlob(file.url);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
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
  await saveAttachment(res, `debug_${sessionId}.json`);
}

/** Download a chat's turn metrics (TTFT, response time, tokens, tokens/s,
 *  tool rounds and calls) as CSV for a German Excel: one row per turn plus a
 *  total row. */
export async function downloadChatMetrics(sessionId: string): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/metrics-export`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401) {
    notifyUnauthenticated();
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`Metrics export failed (HTTP ${res.status})`);
  await saveAttachment(res, `metriken_${sessionId}.csv`);
}

/** Where a turn's output tokens, time and context went — the `detail` block of
 *  src/turn_metrics_export.py. Times are seconds. */
export interface TurnMetricsDetail {
  reasoning_tokens: number;
  answer_tokens: number;
  tool_call_tokens: number;
  /** Output from before the split was recorded; not guessed into a bucket. */
  unsplit_tokens: number;
  split_source: 'backend' | 'proportional' | 'estimated' | 'mixed' | 'none';
  cached_tokens: number;
  prefill_tps: number | null;
  context_length: number;
  context_breakdown: Record<string, number> | null;
  time: { context_build: number; prep: number; wait: number; thinking: number; writing: number; tools: number };
  tools: Record<string, { calls: number; errors: number }>;
}

/** One row of the turn-metrics table (same column names as the CSV export). */
export interface TurnMetricsRow {
  Turn: number | 'Gesamt';
  Frage: string;
  Modell: string;
  Zeitpunkt: string;
  'TTFT [s]': number | null;
  'Antwortzeit [s]': number;
  'Ausgabe-Tokens': number;
  'Input-Tokens (Summe)': number;
  'Kontext-Tokens': number;
  'Tokens/s': number | null;
  Runden: number;
  'Tool-Calls': number;
  'Fehlerhafte Tool-Calls': number;
  'Sub-Agenten': number;
  usage_source: string;
  detail: TurnMetricsDetail;
}

/** Admin: the open chat's turn metrics with their detail, for the charts. */
export const fetchSessionMetrics = (sessionId: string) =>
  getJSON<{ turns: TurnMetricsRow[]; total: TurnMetricsRow | null }>(
    `/api/session/${encodeURIComponent(sessionId)}/metrics`,
  );

/** Save a response as a file, under the filename the server picked. */
async function saveAttachment(res: Response, fallback: string): Promise<void> {
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallback;
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
  if (!res.ok) {
    // The server says what's wrong with a value it refused, e.g. a repository URL.
    const detail = await res.json().then((e) => e.detail).catch(() => '');
    throw new Error(typeof detail === 'string' && detail ? detail : `Save failed (HTTP ${res.status})`);
  }
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
  /** Shipped with Talos (seeded from sample_skills), not uploaded by a user. */
  bundled?: boolean;
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

/** Whole skill package as a zip (SKILL.md + bundled files), re-uploadable as-is. */
export const sharedSkillDownloadUrl = (name: string) =>
  `/api/shared-skills/${encodeURIComponent(name)}/download`;

export function downloadSharedSkill(name: string): void {
  const a = document.createElement('a');
  a.href = sharedSkillDownloadUrl(name);
  a.download = `${name}.zip`;
  a.click();
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
  /* Tool groups — see src/tool_security.py TOOL_PRIVILEGE_GROUPS. */
  can_use_shell?: boolean;
  can_use_files?: boolean;
  can_search_chats?: boolean;
  can_use_mcp?: boolean;
  can_use_vault?: boolean;
  can_manage_instance?: boolean;
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
  /** Null on the self-service endpoint. */
  comparison: {
    rank: number; of: number;
    median_tokens: number; median_turns: number; median_tools: number;
  } | null;
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

/** The signed-in user's own usage (Settings → Usage). Same shape as the admin
 *  detail, with `comparison` null — it never ranks against other users. */
export const fetchMyUsage = (days: number) =>
  getJSON<UsageDetail>(`/api/usage/me?tz_offset=${tzOffset()}&days=${days}`);

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

export type RagGateMode = 'off' | 'shadow' | 'on';

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
  qdrant_api_key_set?: boolean;
  rerank_url: string;
  rerank_model: string;
  rerank_api_key: string;
  rerank_api_key_set?: boolean;
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
  sufficiency_gate?: RagGateMode;
  grounding_gate?: RagGateMode;
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
  chunk_max_chars?: number;
  chunk_overlap_chars?: number;
  context_window?: number;
  embedding_tokenizer?: string;
  embedding_max_tokens?: number;
  /** Extraction lane modes: "auto" runs a lane once its endpoint is set. */
  video_asr_mode?: RagLaneMode;
  video_frames_mode?: RagLaneMode;
  pdf_vlm_mode?: RagLaneMode;
  code_lane_mode?: RagLaneMode;
  /** Read-only, from the server: which lanes run with the saved config. */
  lanes?: Partial<Record<RagLane, { mode: RagLaneMode; active: boolean; waiting_for: string }>>;
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

/** The effort levels Qwen3.8's chat template branches on. `high` is accepted by
 *  the served checkpoint but aliases to `xhigh`, so it is not offered. */
export type ReasoningEffortLevel = 'low' | 'medium' | 'xhigh';

/** Which reasoning-effort levels a model actually honours. Empty means the model
 *  only has the thinking on/off switch (Qwen3.6 and older), so the composer
 *  shows that toggle instead of the effort slider. Probed per model because the
 *  served name stays the same across checkpoint swaps. */
export const fetchReasoningEfforts = (endpointId: string, model: string) =>
  getJSON<{ efforts: ReasoningEffortLevel[] }>(
    `/api/capabilities/reasoning?endpoint_id=${encodeURIComponent(endpointId)}&model=${encodeURIComponent(model)}`,
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

/* ── Knowledge bases (RAG DBs) ──
 *  Several named indexes, each backed by its own Qdrant collection. Everything
 *  document-shaped below takes an optional `ragId`; omitting it targets the
 *  `default` base. Knowledge modes search only bases with chat_enabled set. */

export interface RagBase {
  id: string;
  chat_enabled: boolean;
  name: string;
  description: string;
  language: string;
  collection: string;
  created_at: number;
  updated_at: number;
  /** Indexed source files. Absent when the row was fetched without counts. */
  content_count?: number;
  /** Embedded passages behind those files. */
  chunk_count?: number;
  /** False when Qdrant/the embedder can't be reached for this base. */
  available?: boolean;
  error?: string;
  /** How many pipeline settings this base changes vs. the global defaults. */
  override_count?: number;
  /** Who may retrieve from this base. Admins always may. */
  access?: RagBaseAccess;
  /** A mini RAG (src/rag_mini.py): a small base bound to one SQL database, which
   *  only the SQL feature reads. Absent on an ordinary knowledge base. */
  kind?: 'mini';
  connection_id?: string;
  /** The bound database from Integrations; null once it has been removed there. */
  connection?: { id: string; name: string; enabled: boolean } | null;
  /** Default base only: schema files that have not moved to a mini RAG yet. */
  legacy_sql_count?: number;
}

/** Append `rag_id` only when a base is actually named, so the URLs a plain
 *  default-base install produces stay exactly what they were before. */
function withRag(url: string, ragId?: string): string {
  if (!ragId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}rag_id=${encodeURIComponent(ragId)}`;
}

export const fetchRagBases = () => getJSON<{ bases: RagBase[] }>('/api/rag/bases');

export const createRagBase = (body: {
  name: string;
  description?: string;
  language?: string;
  id?: string;
}) => postJSON<RagBase>('/api/rag/bases', body);

export interface RagBaseAccess {
  restricted: boolean;
  users: string[];
}
export const updateRagBase = (
  id: string,
  body: {
    name?: string;
    description?: string;
    language?: string;
    chat_enabled?: boolean;
    access?: RagBaseAccess;
    /** Mini RAGs only: the database from Integrations it belongs to. */
    connection_id?: string;
  },
) => postJSON<RagBase>(`/api/rag/bases/${encodeURIComponent(id)}`, body, 'PATCH');

export async function deleteRagBase(id: string, dropData = true): Promise<void> {
  const res = await fetch(
    `/api/rag/bases/${encodeURIComponent(id)}?drop_data=${dropData ? 'true' : 'false'}`,
    { method: 'DELETE', credentials: 'same-origin' },
  );
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.detail).catch(() => null);
    throw new Error(detail || `Delete failed (HTTP ${res.status})`);
  }
}

/** One knowledge base's pipeline settings.
 *
 *  `config` is what the base actually runs with, `inherited` the global
 *  defaults behind it, and `overridden` the keys this base sets itself — so a
 *  field can be marked "inherited" or "changed" without a second request.
 *  `global_keys` are infrastructure a base cannot override (one Qdrant). */
export type RagLaneMode = 'auto' | 'on' | 'off';
export type RagLane = 'video_asr' | 'video_frames' | 'pdf_vlm' | 'code_lane';

export interface RagBaseConfig {
  rag_id: string;
  config: RagConfig;
  inherited: RagConfig;
  overridden: string[];
  global_keys: string[];
}

export const fetchRagBaseConfig = (id: string) =>
  getJSON<RagBaseConfig>(`/api/rag/bases/${encodeURIComponent(id)}/config`);

/** Replace a base's overrides. `inherit` names the keys to hand back to the
 *  global defaults; everything else in `config` that differs from global is
 *  stored as an override. */
export const saveRagBaseConfig = (id: string, config: RagConfig, inherit: string[]) =>
  postJSON<RagBaseConfig>(
    `/api/rag/bases/${encodeURIComponent(id)}/config`,
    { config, inherit },
    'PUT',
  );

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
export const ragRebuildIndex = (ragId?: string) =>
  postJSON<{ ok?: boolean; message?: string }>(withRag('/api/rag/rebuild', ragId));

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

/** Admin view of every configured endpoint, disabled ones included —
 *  /api/models only returns enabled endpoints, so it can't back a manage list. */
export interface AdminModelEndpoint extends ModelEndpoint {
  has_key: boolean;
  status: 'online' | 'offline' | 'empty';
}
export const fetchAdminModelEndpoints = () => getJSON<AdminModelEndpoint[]>('/api/model-endpoints');

export const updateModelEndpoint = (
  id: string,
  body: Partial<{ name: string; base_url: string; api_key: string; model_type: string; is_enabled: boolean }>,
) => postJSON(`/api/model-endpoints/${encodeURIComponent(id)}`, body, 'PATCH');

export const fetchModelEndpointDependents = (id: string) =>
  getJSON<{ dependents: string[] }>(`/api/model-endpoints/${encodeURIComponent(id)}/dependents`);

export const deleteModelEndpoint = (id: string) =>
  postJSON(`/api/model-endpoints/${encodeURIComponent(id)}`, undefined, 'DELETE');

/* ── Integrations CRUD ── */
export const fetchIntegrationPresets = () =>
  getJSON<Record<string, { name?: string; base_url?: string;[key: string]: unknown }>>('/api/auth/integrations/presets');
export const createIntegration = (body: Record<string, unknown>) => postJSON('/api/auth/integrations', body);
export const updateIntegration = (id: string, patch: Record<string, unknown>) =>
  postJSON(`/api/auth/integrations/${encodeURIComponent(id)}`, patch, 'PUT');
export const deleteIntegration = (id: string) =>
  postJSON(`/api/auth/integrations/${encodeURIComponent(id)}`, undefined, 'DELETE');

/* ── RAG documents ── */
export const ragSearch = (q: string, k: number, ragId?: string) =>
  getJSON<Record<string, unknown>>(withRag(`/api/rag/search?q=${encodeURIComponent(q)}&k=${k}`, ragId));
export const personalAddDirectory = (directory: string, ragId?: string) =>
  postJSON('/api/personal/add_directory', { directory, rag_id: ragId });
export interface RagQueuedFiles {
  ok: boolean;
  queued: number;
  skipped: string[];
  job_id?: string | null;
}
/** Re-index every document of one base with its current settings. */
export const reindexRagBase = (id: string) =>
  postJSON<RagQueuedFiles>(`/api/rag/bases/${encodeURIComponent(id)}/reindex`);
/** Move the schema files still in the default base into this mini RAG. */
export const adoptLegacySql = (id: string) =>
  postJSON<RagQueuedFiles>(`/api/rag/bases/${encodeURIComponent(id)}/adopt-legacy-sql`);

/* ── API tokens (routes/api_token_routes.py) ── */

export interface ApiToken {
  id: string;
  name: string;
  owner: string | null;
  token_prefix: string;
  scopes: string[];
  is_active: boolean;
  last_used_at: string | null;
  created_at: string | null;
}

export const fetchApiTokens = () => getJSON<ApiToken[]>('/api/tokens');

/** The answer is the only time the full token exists: only its hash is stored. */
export async function createApiToken(name: string, profile: string): Promise<ApiToken & { token: string }> {
  const body = new FormData();
  body.set('name', name);
  body.set('profile', profile);
  const res = await fetch('/api/tokens', { method: 'POST', body, credentials: 'same-origin' });
  if (!res.ok) {
    const detail = await res.json().then((e) => e.detail).catch(() => '');
    throw new Error(typeof detail === 'string' && detail ? detail : `HTTP ${res.status}`);
  }
  return res.json();
}

export const deleteApiToken = (id: string) =>
  postJSON(`/api/tokens/${encodeURIComponent(id)}`, undefined, 'DELETE');

/* ── Git sync of the knowledge bases (src/rag_git_sync.py) ── */

/** Mapping target: the mini RAG of the default database, resolved at each sync. */
export const GIT_DEFAULT_DB_TARGET = '@default-db';

/** One entry of the `rag_git_repos` setting. `id` comes from the server on save. */
export interface GitRepoConfig {
  id?: string;
  url: string;
  branch: string;
  token: string;
  default: boolean;
  exclude: string[];
  mappings: { folder: string; base: string }[];
}

export interface GitSyncRepo {
  id: string;
  url: string;
  default: boolean;
  last: { ok: boolean; finished_at: number; message: string; commit?: string } | null;
  job: { id: string; status: string; message: string } | null;
}

export const fetchGitSync = () => getJSON<{ repos: GitSyncRepo[] }>('/api/rag/git-sync');
/** The folders of a repository, saved or not; an empty token falls back to the saved one. */
export const fetchGitFolders = (repo: Pick<GitRepoConfig, 'url' | 'branch' | 'token'>) =>
  postJSON<{ folders: string[] }>('/api/rag/git-sync/folders', {
    url: repo.url.trim(),
    branch: repo.branch.trim(),
    token: repo.token,
  });
export const startGitSync = (id: string) =>
  postJSON<{ ok: boolean; job_id: string; already_queued: boolean }>(`/api/rag/git-sync/${encodeURIComponent(id)}`);

export const personalReload = () => postJSON('/api/personal/reload');

export async function personalUpload(
  files: File[],
  opts?: { redactPii?: boolean | null; ragId?: string },
): Promise<{ uploaded: string[]; failed_count: number; errors: string[]; job_ids: string[] }> {
  // A dropped folder can hold thousands of files: send it in several
  // requests (each one ingest job) instead of one giant body.
  const total = { uploaded: [] as string[], failed_count: 0, errors: [] as string[], job_ids: [] as string[] };
  for (const batch of uploadBatches(files)) {
    const fd = new FormData();
    for (const f of batch) {
      fd.append('files', f, f.name);
      // Path inside an uploaded folder ("" for a loose file): the server
      // uses it as the document's identity.
      fd.append('paths', relativePathOf(f));
    }
    // Explicit per-upload PII-redaction choice; omitted → server uses the global toggle.
    if (opts?.redactPii != null) fd.append('redact_pii', String(opts.redactPii));
    // Which knowledge base receives the files; omitted → the default base.
    if (opts?.ragId) fd.append('rag_id', opts.ragId);
    const res = await fetch('/api/personal/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!res.ok) {
      const detail = await res.json().then((j) => j?.detail).catch(() => null);
      throw new Error(detail || `Upload failed (HTTP ${res.status})`);
    }
    const r = (await res.json()) as { uploaded?: string[]; failed_count?: number; errors?: string[]; job_id?: string };
    total.uploaded.push(...(r.uploaded ?? []));
    total.failed_count += Number(r.failed_count ?? 0);
    total.errors.push(...(r.errors ?? []));
    if (r.job_id) total.job_ids.push(r.job_id);
  }
  return total;
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
  /** Document-register outcomes: indexed / updated / reindexed / unchanged /
   *  duplicate / skipped / failed / deleted → count. */
  outcomes?: Record<string, number>;
  /** Per-file register results (finished jobs only, capped server-side). */
  files?: RagJobFile[];
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
export interface RagJobFile {
  file: string;
  status: string;
  doc_id?: string | null;
  version?: number | null;
  chunks: number;
  error?: string | null;
  duplicate_of?: string | null;
}
export type RagDocumentStatus = 'indexed' | 'failed' | 'duplicate' | 'deleted' | 'container';
export interface RagDocument {
  source: string;
  filename: string;
  type: string;
  directory: string;
  chunks: number;
  /** False for documents indexed before the document register existed. */
  registered?: boolean;
  doc_id?: string;
  logical_path?: string;
  origin?: string;
  status?: RagDocumentStatus;
  version?: number;
  content_sha256?: string;
  /** Hash of the normalised extracted text: equal for re-saved copies. */
  text_sha256?: string;
  size_bytes?: number | null;
  indexed_at?: number | null;
  updated_at?: number | null;
  duplicate_of?: string | null;
  /** How many other listed documents have exactly the same content. */
  duplicate_count?: number;
  lane?: string;
  parse_cached?: boolean;
  pipeline_fingerprint?: string;
  error?: string;
  warnings?: string[];
  /** Name of the archive or e-mail this document was unpacked from. */
  container?: string;
}
export interface RagDocumentVersion {
  version: number;
  content_sha256: string;
  size_bytes: number | null;
  status: 'current' | 'superseded' | 'deleted' | string;
  chunks: number;
  created_at: number;
  file_available: boolean;
}
export interface RagDocumentDetail extends RagDocument {
  owner?: string | null;
  scope?: string | null;
  created_at?: number | null;
  deleted_at?: number | null;
  duplicate_of_name?: string;
  duplicate_of_source?: string;
  duplicates: { doc_id: string; filename: string }[];
  versions: RagDocumentVersion[];
}

export const fetchRagJobs = () => getJSON<{ jobs: RagJob[] }>('/api/rag/jobs');
export const fetchRagWorkerDiag = () => getJSON<RagWorkerDiag>('/api/rag/jobs/diagnostics');
export interface RerankHealth {
  failures_last_hour: number;
  /** Unix time in seconds. */
  last_failed_at: number | null;
  last_error: string;
}
export const fetchRerankHealth = () => getJSON<RerankHealth>('/api/rag/rerank-health');
export const cancelRagJob = (id: string) => postJSON(`/api/rag/jobs/${id}/cancel`);
export const clearRagJobs = () => postJSON('/api/rag/jobs/clear');
export async function deleteRagJob(id: string): Promise<void> {
  const res = await fetch(`/api/rag/jobs/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}
/** The base's ordinary corpus. Purpose-bound sub-indexes are excluded and
 *  reported under `scopes`; pass `scope` to list one of them instead. */
export const fetchRagDocuments = (ragId?: string) =>
  getJSON<{
    available: boolean;
    documents: RagDocument[];
    error?: string;
    /** Keyword (BM25) side: language the vectors were built with vs. configured. */
    sparse?: RagSparseStatus | null;
  }>(withRag('/api/rag/documents', ragId));

/** Register view of one document: stable id, content hash, version history. */
export const fetchRagDocumentDetail = (docId: string, ragId?: string) =>
  getJSON<RagDocumentDetail>(
    withRag(`/api/rag/documents/detail?doc_id=${encodeURIComponent(docId)}`, ragId),
  );
/** Queue a re-index of one document; `reparse` also bypasses the parse cache. */
export const reindexRagDocument = (docId: string, reparse: boolean, ragId?: string) =>
  postJSON<{ ok: boolean; job_id?: string }>(withRag('/api/rag/documents/reindex', ragId), {
    doc_id: docId,
    reparse,
  });
/** Make a retained older version current again (indexed as a new version). */
export const restoreRagDocumentVersion = (docId: string, version: number, ragId?: string) =>
  postJSON<{ ok: boolean; job_id?: string }>(withRag('/api/rag/documents/restore', ragId), {
    doc_id: docId,
    version,
  });
/** Replace an uploaded document with another file: the new file is indexed
 *  first, the old document is deleted only once that succeeded. */
export async function replaceRagDocument(
  docId: string,
  file: File,
  ragId?: string,
): Promise<{ ok: boolean; job_id?: string }> {
  const fd = new FormData();
  fd.append('doc_id', docId);
  fd.append('file', file, file.name);
  const res = await fetch(withRag('/api/rag/documents/replace', ragId), {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j) => j?.detail)
      .catch(() => null);
    throw new Error(detail || `Replace failed (HTTP ${res.status})`);
  }
  return res.json();
}
export interface RagSparseStatus {
  model: string;
  indexed_language: string | null;
  configured_language: string | null;
  stale: boolean;
}
/** Re-encode the base's keyword (BM25) vectors in its configured language. */
export const rebuildRagSparse = (ragId?: string) =>
  postJSON<{ ok: boolean; job_id?: string }>(withRag('/api/rag/sparse/rebuild', ragId));
/** Adopt documents indexed before the register existed (hashes every file). */
export const syncRagRegister = (ragId?: string) =>
  postJSON<{ ok: boolean; job_id?: string }>(withRag('/api/rag/register/sync', ragId));

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
export const ragDocumentExportUrl = (source: string, ragId?: string) =>
  withRag(`/api/rag/documents/export?source=${encodeURIComponent(source)}`, ragId);
/** Download URL for the original, unmodified file that was ingested. */
export const ragDocumentOriginalUrl = (source: string, ragId?: string) =>
  withRag(`/api/rag/documents/original?source=${encodeURIComponent(source)}`, ragId);
export interface RagChunkHit {
  id: string;
  source: string;
  filename: string;
  seq: number;
  page?: number | null;
  modality: string;
  snippet: string;
}
/** Literal keyword scan across every indexed chunk (explorer search box). */
export const searchRagChunks = (q: string, ragId?: string) =>
  getJSON<{ available: boolean; query: string; count: number; hits: RagChunkHit[]; error?: string }>(
    withRag(`/api/rag/documents/search?q=${encodeURIComponent(q)}`, ragId),
  );
export const fetchRagChunks = (source: string, ragId?: string) =>
  getJSON<{ available: boolean; source: string; chunks: RagChunk[]; error?: string }>(
    withRag(`/api/rag/documents/chunks?source=${encodeURIComponent(source)}`, ragId),
  );
export const updateRagChunk = (source: string, id: string, content: string, ragId?: string) =>
  postJSON<{ ok: boolean; id: string }>(
    withRag(`/api/rag/documents/chunks/${encodeURIComponent(id)}`, ragId),
    { source, content },
    'PUT',
  );
export async function deleteRagChunk(source: string, id: string, ragId?: string): Promise<void> {
  const res = await fetch(
    withRag(
      `/api/rag/documents/chunks/${encodeURIComponent(id)}?source=${encodeURIComponent(source)}`,
      ragId,
    ),
    { method: 'DELETE', credentials: 'same-origin' },
  );
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}
export async function deleteRagDocument(source: string, ragId?: string): Promise<void> {
  const res = await fetch(
    withRag(`/api/rag/documents?source=${encodeURIComponent(source)}`, ragId),
    { method: 'DELETE', credentials: 'same-origin' },
  );
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

/* ── Built-in agent tools ── */
export interface BuiltinTool { id: string; enabled: boolean }
export const fetchBuiltinTools = async () =>
  (await getJSON<{ tools?: BuiltinTool[] }>('/api/tools')).tools ?? [];
export const saveDisabledTools = (disabled: string[]) => postJSON('/api/tools', { disabled });

/* ── Support tickets ── */
export interface TicketAttachmentInfo {
  id: string;
  session_id: string | null;
  session_name: string;
  message_count: number;
  /** Files the chat produced, frozen with the transcript. */
  artifact_count?: number;
  /** 1 = the old text-only snapshot; 2 = full messages with reasoning, tool
   *  calls and citations. Old tickets keep rendering, with less in them. */
  format_version?: number;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: 'open' | 'archived';
  created_by: string | null;
  created_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  attachment_count: number;
}

export interface TicketDetail extends Omit<Ticket, 'attachment_count'> {
  updated_at: string | null;
  attachments: TicketAttachmentInfo[];
}

export interface TicketTranscriptMessage {
  role: string;
  content: string;
  /** Format 2: the message's own metadata — thinking, tool_events, round_texts,
   *  rag_sources, attachments — i.e. everything the chat UI renders a turn from.
   *  Absent on format-1 snapshots, which carried a flat timestamp instead. */
  metadata?: Record<string, unknown>;
  timestamp?: string | null;
  /** The turn was still streaming when the ticket was filed — this is the
   *  answer as far as it had come, not the finished one. */
  partial?: boolean;
}

/** One file the attached chat produced. `media_ref` is this snapshot's own
 *  handle on the bytes — see the ticket media route. */
export interface TicketArtifact {
  path: string;
  name: string;
  size?: number;
  mime?: string;
  is_image?: boolean;
  source?: string;
  media_ref?: string;
}

export interface TicketTranscript extends TicketAttachmentInfo {
  transcript: TicketTranscriptMessage[];
  artifacts: TicketArtifact[];
}

/** File a ticket. Attached chats are snapshotted server-side at this moment. */
export const createTicket = (body: { title: string; body: string; session_ids: string[] }) =>
  postJSON<{ id: string }>('/api/tickets', body);

export const fetchTickets = (status: 'open' | 'archived' | 'all') =>
  getJSON<Ticket[]>(`/api/tickets?status=${status}`);

export const fetchTicket = (id: string) =>
  getJSON<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`);

export const fetchTicketTranscript = (ticketId: string, attachmentId: string) =>
  getJSON<TicketTranscript>(
    `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );

export const ticketAttachmentDownloadUrl = (ticketId: string, attachmentId: string, format: 'md' | 'json' = 'md') =>
  `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/download?format=${format}`;

/** Bytes of one frozen file: `inline` to view, `download` to save, `render` to
 *  open an HTML artifact as a page. */
export const ticketMediaUrl = (
  ticketId: string,
  attachmentId: string,
  ref: string,
  mode: 'inline' | 'download' | 'render' = 'inline',
) =>
  `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/media` +
  `?ref=${encodeURIComponent(ref)}&mode=${mode}`;

export const setTicketStatus = (id: string, status: 'open' | 'archived') =>
  postJSON<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`, { status }, 'PATCH');

export async function deleteTicket(id: string): Promise<void> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
}

/* ── What the model remembers about the databases ──
   routes/db_memory_routes.py. Admin-only. */
export interface MemoryEntry {
  id: number;
  text: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface MemoryDatabase {
  id: string;
  name: string;
  enabled: boolean;
  /** The connection is gone from the settings; its notes are still stored. */
  removed: boolean;
  used: number;
  entries: MemoryEntry[];
}

export interface MemoriesOverview {
  entry_limit: number;
  total_limit: number;
  databases: MemoryDatabase[];
}

export const fetchMemories = () => getJSON<MemoriesOverview>('/api/admin/memories');

export const addMemory = (connectionId: string, text: string) =>
  postJSON('/api/admin/memories', { connection_id: connectionId, text });

export const updateMemory = (id: number, text: string) =>
  postJSON(`/api/admin/memories/${id}`, { text }, 'PATCH');

export const deleteMemory = (id: number) => postJSON(`/api/admin/memories/${id}`, undefined, 'DELETE');

/* ── What the assistant remembers about the signed-in user ──
   routes/user_memory_routes.py. The switch is the pref `memories_enabled`. */
export interface UserMemoryEntry {
  id: number;
  title: string;
  text: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface UserMemories {
  limits: { title: number; text: number; entries: number };
  entries: UserMemoryEntry[];
}

export const fetchUserMemories = () => getJSON<UserMemories>('/api/memories');

export const addUserMemory = (title: string, text: string) =>
  postJSON('/api/memories', { title, text });

export const updateUserMemory = (id: number, title: string, text: string) =>
  postJSON(`/api/memories/${id}`, { title, text }, 'PATCH');

export const deleteUserMemory = (id: number) => postJSON(`/api/memories/${id}`, undefined, 'DELETE');

export const deleteAllUserMemories = () => postJSON('/api/memories', undefined, 'DELETE');

/* ── Projects ──
   routes/project_routes.py. Everyone in a project reads its chats and works in its
   files and memories; only the creator changes the project or who is in it. */

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  owner: string | null;
  is_creator: boolean;
  member_count: number;
  chat_count: number;
  created_at: string | null;
  updated_at: string | null;
  last_active_at: string | null;
}

export interface ProjectChat {
  id: string;
  name: string;
  owner: string | null;
  owner_display_name: string | null;
  message_count: number;
  last_message_at: string | null;
}

export interface ProjectMember {
  username: string;
  display_name: string | null;
  is_creator: boolean;
}

export interface ProjectFile {
  path: string;
  name?: string;
  size?: number;
  mime?: string;
  mtime?: number;
  source?: string;
  version?: number;
  /** A chat id, or the project's `ref` for what lives in the shared workspace. */
  session_id: string;
}

export interface ProjectFiles {
  ref: string;
  dirs: string[];
  artifacts: ProjectFile[];
  error?: string;
}

const projectUrl = (id: string, rest = '') => `/api/projects/${encodeURIComponent(id)}${rest}`;

export const fetchProjects = async () =>
  (await getJSON<{ projects: ProjectSummary[] }>('/api/projects')).projects;

export const fetchProject = (id: string) => getJSON<ProjectSummary>(projectUrl(id));

export const createProject = (name: string, description = '') =>
  postJSON<ProjectSummary>('/api/projects', { name, description });

export const updateProject = (id: string, change: { name?: string; description?: string }) =>
  postJSON<ProjectSummary>(projectUrl(id), change, 'PATCH');

export const deleteProject = (id: string) => postJSON(projectUrl(id), undefined, 'DELETE');

export const fetchProjectChats = async (id: string) =>
  (await getJSON<{ chats: ProjectChat[] }>(projectUrl(id, '/chats'))).chats;

export const fetchProjectMembers = async (id: string) =>
  (await getJSON<{ members: ProjectMember[] }>(projectUrl(id, '/members'))).members;

export const fetchProjectCandidates = async (id: string) =>
  (await getJSON<{ users: Array<{ username: string; display_name: string | null }> }>(
    projectUrl(id, '/candidates'),
  )).users;

export const addProjectMember = (id: string, username: string) =>
  postJSON(projectUrl(id, '/members'), { username });

export const removeProjectMember = (id: string, username: string) =>
  postJSON(projectUrl(id, `/members/${encodeURIComponent(username)}`), undefined, 'DELETE');

export const fetchProjectFiles = (id: string) => getJSON<ProjectFiles>(projectUrl(id, '/files'));

export const createProjectFolder = (id: string, path: string) =>
  postJSON(projectUrl(id, '/folders'), { path });

export async function uploadProjectFile(id: string, file: File, folder = ''): Promise<void> {
  const fd = new FormData();
  fd.set('file', file);
  fd.set('folder', folder);
  const res = await fetch(projectUrl(id, '/files'), { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

export const fetchProjectMemories = (id: string) => getJSON<UserMemories>(projectUrl(id, '/memories'));

export const addProjectMemory = (id: string, title: string, text: string) =>
  postJSON(projectUrl(id, '/memories'), { title, text });

export const updateProjectMemory = (id: string, entry: number, title: string, text: string) =>
  postJSON(projectUrl(id, `/memories/${entry}`), { title, text }, 'PATCH');

export const deleteProjectMemory = (id: string, entry: number) =>
  postJSON(projectUrl(id, `/memories/${entry}`), undefined, 'DELETE');

/* ── External MCP servers Talos connects to as a client ──
   routes/mcp_routes.py. Admin-only: a stdio server runs an arbitrary command
   inside the app container. Writes take form fields, the tool list takes JSON. */
export type McpTransport = 'stdio' | 'sse' | 'http';

export interface McpServerInfo {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  is_enabled: boolean;
  status: string;
  tool_count: number;
  enabled_tool_count: number;
  disabled_tool_count: number;
  error?: string | null;
  auth_url?: string | null;
  has_oauth?: boolean;
  needs_oauth?: boolean;
}

export interface McpServerTool {
  name: string;
  qualified_name: string;
  description: string;
  is_disabled: boolean;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

async function sendForm<T = Record<string, unknown>>(url: string, fields: Record<string, string>, method = 'POST'): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await fetch(url, { method, body: fd, credentials: 'same-origin' });
  if (res.status === 401) notifyUnauthenticated();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const e = await res.json(); detail = e.detail || e.error || detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json().catch(() => ({}) as T);
}

export const fetchMcpServers = () => getJSON<McpServerInfo[]>('/api/mcp/servers');

export const addMcpServer = (s: McpServerInput) => {
  const fields: Record<string, string> = {
    name: s.name,
    transport: s.transport,
    args: JSON.stringify(s.args ?? []),
    env: JSON.stringify(s.env ?? {}),
  };
  if (s.command) fields.command = s.command;
  if (s.url) fields.url = s.url;
  return sendForm<{ id: string; connected: boolean; status: string; tool_count: number; error?: string | null }>(
    '/api/mcp/servers', fields);
};

export interface McpPreset { id: string; name: string; available: boolean; added: boolean }

export const fetchMcpPresets = () => getJSON<McpPreset[]>('/api/mcp/presets');

export const addMcpPreset = (id: string) =>
  sendForm<{ id: string; connected: boolean; status: string; tool_count: number; error?: string | null }>(
    `/api/mcp/presets/${encodeURIComponent(id)}`, {});

export const setMcpServerEnabled = (id: string, enabled: boolean) =>
  sendForm(`/api/mcp/servers/${encodeURIComponent(id)}`, { is_enabled: String(enabled) }, 'PATCH');

export const reconnectMcpServer = (id: string) =>
  postJSON<{ connected: boolean; status: string; tool_count: number; error?: string | null }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/reconnect`);

export const deleteMcpServer = (id: string) =>
  postJSON(`/api/mcp/servers/${encodeURIComponent(id)}`, undefined, 'DELETE');

export const fetchMcpServerTools = (id: string) =>
  getJSON<McpServerTool[]>(`/api/mcp/servers/${encodeURIComponent(id)}/tools`);

export const setMcpDisabledTools = (id: string, disabled: string[]) =>
  postJSON(`/api/mcp/servers/${encodeURIComponent(id)}/tools`, { disabled }, 'PATCH');

/* ── System: backup + danger zone ── */
export const importData = (data: unknown) => postJSON<{ ok?: boolean; message?: string }>('/api/import', data);
export const wipeData = (kind: string) => postJSON<{ ok?: boolean;[key: string]: unknown }>(`/api/admin/wipe/${kind}`, undefined, 'DELETE');

export interface StreamFlags {
  useRag?: boolean;
  useDb?: boolean;
  /** Whether the turn may reach the web. `false` makes the backend withhold
   *  the web_search / web_fetch tools for this turn; omitted/true leaves the
   *  admin-configured toolset alone. */
  useWeb?: boolean;
  /** Model reasoning/thinking. When false the backend disables it (vLLM
   *  `enable_thinking: false`). Omitted/true leaves the model's default on. */
  reasoning?: boolean;
  /** How long the model may think when reasoning is on — Qwen3.8's
   *  `reasoning_effort` chat-template kwarg. Ignored when reasoning is off. */
  reasoningEffort?: ReasoningEffortLevel;
  /** Deep research mode: plan → parallel research subagents → gap check →
   *  cited report. */
  deepResearch?: boolean;
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
  /** Question/answer pairs when the message answers an ask_user card. */
  askAnswers?: { question: string; answer: string }[];
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
}): Promise<boolean> {
  const fd = new FormData();
  fd.set('message', opts.message);
  fd.set('session', opts.sessionId);
  const f = opts.flags ?? {};
  fd.set('use_rag', f.useRag === true ? 'true' : 'false');
  fd.set('use_db', f.useDb === true ? 'true' : 'false');
  if (f.useWeb === false) fd.set('use_web', 'false');
  if (f.reasoning === false) fd.set('reasoning', 'false');
  if (f.reasoningEffort) fd.set('reasoning_effort', f.reasoningEffort);
  if (f.deepResearch) fd.set('deep_research', 'true');
  if (f.incognito) fd.set('incognito', 'true');
  if (f.lang) fd.set('lang', f.lang);
  if (f.llmLanguage) fd.set('llm_language', f.llmLanguage);
  if (f.activeDocId) fd.set('active_doc_id', f.activeDocId);
  if (f.artifactSelection) fd.set('artifact_selection', JSON.stringify(f.artifactSelection));
  if (f.attachments?.length) fd.set('attachments', JSON.stringify(f.attachments));
  if (f.askAnswers?.length) fd.set('ask_answers', JSON.stringify(f.askAnswers));

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

  return readSse(res, opts.onEvent);
}

/** Reattach to a turn that is still running server-side (the run is detached
 *  from the request that started it, so a reload/tab close doesn't kill it).
 *  The server replays the run's whole event log before going live, so the
 *  caller rebuilds the turn from the start exactly as it originally streamed.
 *  Resolves like streamChat: true once the run has finished. */
export async function resumeChat(opts: {
  sessionId: string;
  signal?: AbortSignal;
  onEvent: (ev: ChatEvent) => void;
}): Promise<boolean> {
  const res = await fetch(`/api/chat/resume/${opts.sessionId}`, {
    credentials: 'same-origin',
    signal: opts.signal,
  });
  // 404 = the run finished (or was evicted) between discovery and reconnect.
  if (res.status === 404) return true;
  if (!res.ok || !res.body) throw new Error(`resumeChat: ${res.status}`);
  return readSse(res, opts.onEvent);
}

/** Sessions whose turn is still running server-side — asked once on page load
 *  so the UI can reattach to background runs it knows nothing about. `elapsedMs`
 *  is how long that turn has already been going (server-measured span, rebased
 *  on the local clock by the caller) so the working timer survives a reload. */
/** Stop a running turn. Resolves once the server has saved what it had. */
export async function stopChatRun(sessionId: string): Promise<void> {
  await fetch(`/api/chat/stop/${sessionId}`, { method: 'POST', credentials: 'same-origin' });
}

/** Hand a running turn a message for its next round boundary. */
export async function queueChatMessage(sessionId: string, id: string, text: string): Promise<void> {
  await fetch(`/api/chat/queue/${sessionId}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text }),
  });
}

/** Take a queued message back, if the turn hasn't received it yet. */
export async function unqueueChatMessage(sessionId: string, id: string): Promise<void> {
  await fetch(`/api/chat/queue/${sessionId}/${id}`, { method: 'DELETE', credentials: 'same-origin' });
}

export async function fetchActiveRuns(): Promise<{ sessionId: string; elapsedMs: number | null }[]> {
  try {
    const data = await getJSON<{ sessions?: string[]; elapsed_ms?: Record<string, number> }>('/api/chat/active_runs');
    if (!Array.isArray(data.sessions)) return [];
    return data.sessions.map((sessionId) => {
      const ms = data.elapsed_ms?.[sessionId];
      return { sessionId, elapsedMs: typeof ms === 'number' ? ms : null };
    });
  } catch {
    return []; // older server without the endpoint — nothing to reattach to
  }
}

/** Parse an SSE body frame-by-frame, dispatching each `data:` payload. Resolves
 *  true at the `[DONE]` sentinel, false when the connection ends without it —
 *  a dropped connection, while the detached run may well still be going. */
async function readSse(res: Response, onEvent: (ev: ChatEvent) => void): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') return true;
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // Malformed frame — skip rather than kill the stream.
        }
      }
    }
  }
}
