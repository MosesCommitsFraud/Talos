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
      <span class="chat-files-actions">
        <button type="button" class="chat-files-zip" title="Download all as .zip">⤓ All</button>
        <button type="button" class="chat-files-close" title="Close">&times;</button>
      </span>
    </div>
    <div class="chat-files-body"><div class="chat-files-loading">Loading…</div></div>
  `;
  overlay.appendChild(modal);
  const zipBtn = modal.querySelector('.chat-files-zip');
  if (zipBtn) zipBtn.addEventListener('click', () => {
    window.open(`${API_BASE}/api/artifacts/${encodeURIComponent(sessionId)}/zip`, '_blank');
  });

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
    const ext = (a.name.split('.').pop() || '').toLowerCase();
    const row = document.createElement('div');
    row.className = 'chat-files-row';

    const open = async () => {
      if (!a.is_image && TEXT_EXTS.has(ext)) {
        // Open editable text/code in the document editor — edits save back to the file.
        try {
          const dm = (await import('./document.js')).default;
          if (dm && dm.openArtifact) {
            dm.openArtifact(sessionId, a.path);
            document.querySelectorAll('.chat-files-overlay').forEach((o) => o.remove());
            return;
          }
        } catch (_) { /* fall through to preview */ }
      }
      if (!a.is_image && TEXT_EXTS.has(ext)) { _previewText(url, a.path); return; }
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    const thumb = document.createElement('div');
    thumb.className = 'chat-files-thumb';
    if (a.is_image) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = a.name;
      img.loading = 'lazy';
      img.addEventListener('click', open);
      thumb.appendChild(img);
    } else {
      thumb.textContent = (ext || 'file').slice(0, 4).toUpperCase();
      thumb.classList.add('chat-files-thumb-ext');
      thumb.addEventListener('click', open);
    }
    row.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'chat-files-meta';
    meta.innerHTML = `<div class="chat-files-name" title="${_esc(a.path)}">${_esc(a.path)}</div>` +
                     `<div class="chat-files-sub">${_fmtSize(a.size)}</div>`;
    meta.addEventListener('click', open);
    row.appendChild(meta);

    if (RUNNABLE_EXTS.has(ext)) {
      const run = document.createElement('button');
      run.className = 'chat-files-run';
      run.type = 'button';
      run.title = 'Run in sandbox';
      run.textContent = '▶';
      run.addEventListener('click', (e) => {
        e.stopPropagation();
        _runFile(sessionId, a.path, run);
      });
      row.appendChild(run);
    }

    const dl = document.createElement('a');
    dl.className = 'chat-files-dl';
    dl.href = url;
    dl.download = a.name;
    dl.title = 'Download';
    dl.textContent = '⤓';
    dl.addEventListener('click', (e) => e.stopPropagation());
    row.appendChild(dl);

    const del = document.createElement('button');
    del.className = 'chat-files-del';
    del.type = 'button';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      del.disabled = true;
      try {
        const r = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(sessionId)}?path=${encodeURIComponent(a.path)}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        row.remove();
        if (!list.children.length) body.innerHTML = `<div class="chat-files-empty">No files in this chat yet.</div>`;
      } catch (_) {
        del.disabled = false;
        del.textContent = '!';
        setTimeout(() => { del.textContent = '✕'; }, 1500);
      }
    });
    row.appendChild(del);

    list.appendChild(row);
  }
  body.innerHTML = '';
  body.appendChild(list);
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'log', 'py', 'js', 'ts', 'html', 'css',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'sql', 'c', 'cpp', 'h', 'java',
  'go', 'rs', 'rb', 'php', 'r',
]);

const RUNNABLE_EXTS = new Set(['py', 'js', 'mjs', 'cjs', 'sh', 'bash']);

async function _runFile(sessionId, path, btn) {
  const overlay = document.createElement('div');
  overlay.className = 'chat-files-overlay';
  const modal = document.createElement('div');
  modal.className = 'chat-files-modal';
  modal.innerHTML = `
    <div class="chat-files-header">
      <span class="chat-files-title" title="${_esc(path)}">▶ ${_esc(path)}</span>
      <button type="button" class="chat-files-close" title="Close">&times;</button>
    </div>
    <pre class="chat-files-preview chat-files-run-output">Running…</pre>
  `;
  overlay.appendChild(modal);
  const onKey = (e) => { if (e.key === 'Escape') _close(overlay, onKey); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(overlay, onKey); });
  modal.querySelector('.chat-files-close').addEventListener('click', () => _close(overlay, onKey));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  const pre = modal.querySelector('.chat-files-preview');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(sessionId)}/run?path=${encodeURIComponent(path)}`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
      pre.textContent = 'Run failed: ' + msg;
      return;
    }
    const j = await r.json();
    pre.textContent = j.output || '(no output)';
    pre.classList.toggle('chat-files-run-error', (j.exit_code || 0) !== 0);
  } catch (_) {
    pre.textContent = 'Run failed (network error).';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _previewText(url, name) {
  const overlay = document.createElement('div');
  overlay.className = 'chat-files-overlay';
  const modal = document.createElement('div');
  modal.className = 'chat-files-modal';
  modal.innerHTML = `
    <div class="chat-files-header">
      <span class="chat-files-title" title="${_esc(name)}">${_esc(name)}</span>
      <button type="button" class="chat-files-close" title="Close">&times;</button>
    </div>
    <pre class="chat-files-preview">Loading…</pre>
  `;
  overlay.appendChild(modal);
  const onKey = (e) => { if (e.key === 'Escape') _close(overlay, onKey); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(overlay, onKey); });
  modal.querySelector('.chat-files-close').addEventListener('click', () => _close(overlay, onKey));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  const pre = modal.querySelector('.chat-files-preview');
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    const text = await r.text();
    pre.textContent = text.length > 200000 ? text.slice(0, 200000) + '\n… [truncated]' : text;
  } catch (_) {
    pre.textContent = 'Could not load file.';
  }
}

export default { showChatFiles };
