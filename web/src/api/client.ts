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

/**
 * Stream a chat turn. Parses the backend's SSE framing
 * (`data: {json}\n\n`, terminated by `data: [DONE]`) and invokes
 * onEvent for every event.
 */
export async function streamChat(opts: {
  message: string;
  sessionId: string;
  signal?: AbortSignal;
  onEvent: (ev: ChatEvent) => void;
}): Promise<void> {
  const fd = new FormData();
  fd.set('message', opts.message);
  fd.set('session', opts.sessionId);

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
