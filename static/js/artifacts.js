// Chat Files (artifacts) viewer.
// Lists the files in a chat's sandbox workspace — uploads the user attached and
// results the agent produced (charts, exports, etc.) — with preview + download.
// Backed by GET /api/artifacts/{sessionId} and .../download?path=.

const API_BASE = '';

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function _downloadUrl(sessionId, path) {
  return `${API_BASE}/api/artifacts/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(path)}`;
}

function _close(overlay, onKey) {
  document.removeEventListener('keydown', onKey);
  overlay.remove();
}

/** Open a modal listing the current chat's sandbox files. */
export async function showChatFiles(sessionId) {
  if (!sessionId) return;

  const overlay = document.createElement('div');
  overlay.className = 'chat-files-overlay';

  const modal = document.createElement('div');
  modal.className = 'chat-files-modal';
  modal.innerHTML = `
    <div class="chat-files-header">
      <span class="chat-files-title">Chat files</span>
      <button type="button" class="chat-files-close" title="Close">&times;</button>
    </div>
    <div class="chat-files-body"><div class="chat-files-loading">Loading…</div></div>
  `;
  overlay.appendChild(modal);

  const onKey = (e) => { if (e.key === 'Escape') _close(overlay, onKey); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(overlay, onKey); });
  modal.querySelector('.chat-files-close').addEventListener('click', () => _close(overlay, onKey));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);

  const body = modal.querySelector('.chat-files-body');
  let artifacts = [];
  try {
    const res = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  } catch (e) {
    body.innerHTML = `<div class="chat-files-empty">Couldn't load files (sandbox unavailable).</div>`;
    return;
  }

  if (!artifacts.length) {
    body.innerHTML = `<div class="chat-files-empty">No files in this chat yet.<br><span style="opacity:.7">Uploads and results the assistant creates show up here.</span></div>`;
    return;
  }

  const list = document.createElement('div');
  list.className = 'chat-files-list';
  for (const a of artifacts) {
    const url = _downloadUrl(sessionId, a.path);
    const row = document.createElement('div');
    row.className = 'chat-files-row';

    const thumb = document.createElement('div');
    thumb.className = 'chat-files-thumb';
    if (a.is_image) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = a.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));
      thumb.appendChild(img);
    } else {
      thumb.textContent = (a.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
      thumb.classList.add('chat-files-thumb-ext');
    }
    row.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'chat-files-meta';
    meta.innerHTML = `<div class="chat-files-name" title="${_esc(a.path)}">${_esc(a.path)}</div>` +
                     `<div class="chat-files-sub">${_fmtSize(a.size)}</div>`;
    row.appendChild(meta);

    const dl = document.createElement('a');
    dl.className = 'chat-files-dl';
    dl.href = url;
    dl.download = a.name;
    dl.title = 'Download';
    dl.textContent = '⤓';
    row.appendChild(dl);

    list.appendChild(row);
  }
  body.innerHTML = '';
  body.appendChild(list);
}

export default { showChatFiles };
