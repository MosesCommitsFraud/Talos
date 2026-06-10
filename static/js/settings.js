// static/js/settings.js — Settings panel module (ES6)
// User-facing preferences: AI models, search, appearance

import uiModule from './ui.js';
import { makeWindowDraggable } from './windowDrag.js';
import { clearDockSide } from './modalSnap.js';
import { sortModelIds } from './modelSort.js';
import { isAltGrEvent } from './platform.js';

let initialized = false;
let modalEl = null;

function el(id) { return document.getElementById(id); }
function esc(s) { return uiModule.esc(s); }
function safeRasterDataUrl(raw) {
  const value = String(raw || '').trim();
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
}

/* ── Tab switching ── */
const ADMIN_TABS = new Set(['services', 'ai', 'integrations', 'tools', 'rag', 'users', 'system']);

function initTabs() {
  modalEl.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab;
      // Lazy-init admin when first clicking an admin tab
      if (ADMIN_TABS.has(tab) && window.adminModule && typeof window.adminModule.open === 'function') {
        window.adminModule.open(tab);
        return;
      }
      modalEl.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
      modalEl.querySelectorAll('[data-settings-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.settingsPanel !== tab));
      // Mark when the Appearance tab is open so the modal can go
      // semi-transparent — lets the user see the rest of the UI react as
      // they flip toggles instead of having to close + reopen the modal.
      document.body.classList.toggle('settings-appearance-open', tab === 'appearance');
      syncAppearanceOpacity(tab === 'appearance');
      if (tab === 'ai') refreshAiModelEndpoints();
    });
  });
}

/* ── Dragging ── */
function initDrag() {
  const header = modalEl.querySelector('.modal-header');
  const content = modalEl.querySelector('.settings-modal-content');
  if (!header || !content) return;
  // Skip interactive controls in the header (e.g. the opacity slider) so
  // grabbing them doesn't start a window-drag.
  makeWindowDraggable(modalEl, {
    content,
    header,
    skipSelector: 'button, input, select, .theme-opacity-wrap',
    enableDock: false,
  });
}

function resetWindowPlacement() {
  const content = modalEl && modalEl.querySelector('.settings-modal-content');
  if (!content) return;
  const hadLeft = modalEl.classList.contains('modal-left-docked');
  const hadRight = modalEl.classList.contains('modal-right-docked');
  modalEl.classList.remove('modal-left-docked', 'modal-right-docked');
  if (hadLeft) clearDockSide('left', modalEl);
  if (hadRight) clearDockSide('right', modalEl);
  if (content._leftDockNavObs) {
    try { content._leftDockNavObs.navObs && content._leftDockNavObs.navObs.disconnect(); } catch (_) {}
    try { window.removeEventListener('resize', content._leftDockNavObs.reanchor); } catch (_) {}
    delete content._leftDockNavObs;
  }
  delete content._preDockSnapshot;
  delete content._dockSide;
  delete content._dockSuspended;
  delete content.dataset._tilePreSnap;
  delete content.dataset._tileZone;
  [
    'position', 'left', 'top', 'right', 'bottom', 'margin', 'transform',
    'width', 'height', 'max-width', 'max-height', 'border-radius', 'transition',
  ].forEach(prop => content.style.removeProperty(prop));
}

/* ── Close on backdrop / X ── */
function initClose() {
  modalEl.querySelector('.close-btn').addEventListener('click', close);
  modalEl.addEventListener('mousedown', e => {
    if (uiModule.isTouchInsideModal()) return;
    if (e.target === modalEl) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !modalEl || modalEl.classList.contains('hidden')) return;
    // If an integration edit/add form is open inside the modal, close
    // just that — don't dismiss the whole settings modal. (Pressing
    // ESC mid-edit and losing the modal was a fast-typing footgun.)
    const innerForm = modalEl.querySelector('#unified-intg-form');
    if (innerForm && innerForm.style.display !== 'none' && innerForm.children.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      innerForm.style.display = 'none';
      innerForm.innerHTML = '';
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  });
}

/* ── Appearance-tab opacity slider ──
   Mirrors the Theme customizer's slider: fades the settings modal's
   background (and inner cards) via color-mix so the user can watch the
   rest of the UI react to toggles, while keeping text/controls crisp
   (no element opacity). Only shown/active on the Appearance tab. */
const _SETTINGS_PEEK = 55; // % opacity when the Peek toggle is on
function _applySettingsOpacity(on) {
  const content = modalEl && modalEl.querySelector('.settings-modal-content, .modal-content');
  if (!content) return;
  const cards = content.querySelectorAll('.admin-card');
  if (on) {
    const bgMix = `color-mix(in srgb, var(--bg) ${_SETTINGS_PEEK}%, transparent)`;
    const panelMix = `color-mix(in srgb, var(--panel) ${_SETTINGS_PEEK}%, transparent)`;
    content.style.setProperty('background', bgMix, 'important');
    content.style.setProperty('backdrop-filter', 'none', 'important');
    content.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    cards.forEach(c => {
      c.style.setProperty('background', panelMix, 'important');
      c.style.setProperty('backdrop-filter', 'none', 'important');
      c.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    });
  } else {
    content.style.removeProperty('background');
    content.style.removeProperty('backdrop-filter');
    content.style.removeProperty('-webkit-backdrop-filter');
    cards.forEach(c => {
      c.style.removeProperty('background');
      c.style.removeProperty('backdrop-filter');
      c.style.removeProperty('-webkit-backdrop-filter');
    });
  }
}

// Show/hide the Peek toggle for the Appearance tab and apply or clear the fade.
function syncAppearanceOpacity(active) {
  const toggle = el('settings-opacity-wrap');
  if (toggle) toggle.classList.toggle('hidden', !active);
  if (active) {
    _applySettingsOpacity(toggle ? toggle.classList.contains('active') : false);
  } else {
    _applySettingsOpacity(false); // clear the fade off the Appearance tab
  }
}

function initOpacityToggle() {
  const toggle = el('settings-opacity-wrap');
  if (!toggle || toggle.dataset.bound === '1') return;
  toggle.dataset.bound = '1';
  toggle.addEventListener('click', () => {
    const on = !toggle.classList.contains('active');
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    _applySettingsOpacity(on);
  });
}

/* ═══════════════════════════════════════════
   AI TAB
   ═══════════════════════════════════════════ */

const _aiEndpointRefreshers = new Set();
let _aiEndpointRefreshInFlight = null;

async function _fetchModelEndpoints() {
  const epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
  const endpoints = await epRes.json();
  return Array.isArray(endpoints) ? endpoints : [];
}

function _endpointLabel(ep) {
  return ep.name + (ep.online ? '' : ' (offline)');
}

function _fillEndpointSelect(selectEl, endpoints, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  (endpoints || []).forEach(function(ep) {
    if (!ep.is_enabled) return;
    const opt = document.createElement('option');
    opt.value = ep.id;
    opt.textContent = _endpointLabel(ep);
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
}

function _fillModelSelect(selectEl, models, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  sortModelIds(models).forEach(function(m) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).split('/').pop();
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
}

function _registerAiEndpointRefresh(fn) {
  _aiEndpointRefreshers.add(fn);
}

export async function refreshAiModelEndpoints() {
  if (_aiEndpointRefreshInFlight) return _aiEndpointRefreshInFlight;
  _aiEndpointRefreshInFlight = (async function() {
    try {
      const endpoints = await _fetchModelEndpoints();
      _aiEndpointRefreshers.forEach(function(fn) {
        try { fn(endpoints); } catch (e) { console.warn('[settings] endpoint refresh handler failed', e); }
      });
    } catch (e) {
      console.warn('[settings] failed to refresh model endpoints', e);
    } finally {
      _aiEndpointRefreshInFlight = null;
    }
  })();
  return _aiEndpointRefreshInFlight;
}

/* Shared fallback-chain widget — mirrors the Default Chat Model fallback UI
 * for other model cards (Utility, Vision, …). Pass in the container/button
 * IDs, the endpoints list, the settings key to persist under, and the
 * model-filter (for Vision we exclude non-chat-capable models).
 */
function _bindFallbackWidget(opts) {
  var fbContainer = el(opts.containerId);
  var addBtn = el(opts.addBtnId);
  var endpointsRef = opts.endpoints;       // mutable list reference
  var modelsFilter = opts.modelsFilter || function() { return true; };
  var settingKey = opts.settingKey;
  var current = opts.initial || [];        // [{endpoint_id, model}]

  if (!fbContainer || !addBtn) return { setEndpoints: function() {}, setInitial: function() {} };

  function enabledEps() { return (endpointsRef() || []).filter(function(e) { return e.is_enabled; }); }

  function fillModels(selectEl, epId, selected) {
    while (selectEl.options.length) selectEl.remove(0);
    var ep = (endpointsRef() || []).find(function(e) { return e.id === epId; });
    if (ep && ep.models) {
      sortModelIds(ep.models).forEach(function(m) {
        if (!modelsFilter(m, ep)) return;
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m.split('/').pop();
        selectEl.appendChild(o);
      });
    }
    if (selected) selectEl.value = selected;
  }

  async function save() {
    var clean = current.filter(function(f) { return f.endpoint_id && f.model; });
    var body = {};
    body[settingKey] = clean;
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { console.warn('[fallback] save failed for ' + settingKey, e); }
  }

  function render() {
    fbContainer.innerHTML = '';
    current.forEach(function(fb, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';

      var epS = document.createElement('select');
      epS.className = 'settings-select';
      enabledEps().forEach(function(ep) {
        var o = document.createElement('option');
        o.value = ep.id;
        o.textContent = ep.name + (ep.online ? '' : ' (offline)');
        epS.appendChild(o);
      });
      var first = enabledEps()[0];
      epS.value = fb.endpoint_id || (first ? first.id : '');

      var mS = document.createElement('select');
      mS.className = 'settings-select';
      fillModels(mS, epS.value, fb.model);

      fb.endpoint_id = epS.value;
      fb.model = mS.value;

      epS.addEventListener('change', function() {
        fb.endpoint_id = epS.value;
        fillModels(mS, epS.value, '');
        fb.model = mS.value;
        save();
      });
      mS.addEventListener('change', function() { fb.model = mS.value; save(); });

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = '&times;';
      rm.addEventListener('click', function() {
        current.splice(idx, 1);
        render();
        save();
      });

      row.appendChild(num);
      row.appendChild(epS);
      row.appendChild(mS);
      row.appendChild(rm);
      fbContainer.appendChild(row);
    });
  }

  addBtn.addEventListener('click', function() {
    var first = enabledEps()[0];
    current.push({ endpoint_id: first ? first.id : '', model: '' });
    render();
    save();
  });

  render();

  return {
    setInitial: function(list) { current = (list || []).slice(); render(); },
    refresh: render,
  };
}

/* ── Default Chat Model ── */
async function initDefaultChat() {
  var epSel = el('set-defaultEpSelect');
  var modelSel = el('set-defaultModelSelect');
  var msg = el('set-defaultChatMsg');
  var fbContainer = el('set-defaultFallbacks');
  var addFbBtn = el('set-defaultAddFallback');
  var _endpoints = [];
  var _fallbacks = []; // [{endpoint_id, model}] — tried in order if primary fails

  function enabledEndpoints() {
    return _endpoints.filter(function(e) { return e.is_enabled; });
  }

  // Fill any <select> with the models for a given endpoint id.
  function fillModels(selectEl, epId, selected) {
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(selectEl, ep ? ep.models : [], selected, false);
  }

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, false);
  } catch (e) { console.warn('Failed to load endpoints for default chat', e); }

  function refreshModels(selectedModel) { fillModels(modelSel, epSel.value, selectedModel); }
  function refreshEndpointOptions(selectedEndpoint, selectedModel) {
    _fillEndpointSelect(epSel, _endpoints, selectedEndpoint !== undefined ? selectedEndpoint : epSel.value, false);
    refreshModels(selectedModel !== undefined ? selectedModel : modelSel.value);
    renderFallbacks();
  }

  // Render the fallback chain. Each row is endpoint + model + remove.
  function renderFallbacks() {
    fbContainer.innerHTML = '';
    _fallbacks.forEach(function(fb, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';

      var epS = document.createElement('select');
      epS.className = 'settings-select';
      enabledEndpoints().forEach(function(ep) {
        var o = document.createElement('option');
        o.value = ep.id;
        o.textContent = ep.name + (ep.online ? '' : ' (offline)');
        epS.appendChild(o);
      });
      var first = enabledEndpoints()[0];
      epS.value = fb.endpoint_id || (first ? first.id : '');

      var mS = document.createElement('select');
      mS.className = 'settings-select';
      fillModels(mS, epS.value, fb.model);

      // Keep the model in sync with the values actually shown.
      fb.endpoint_id = epS.value;
      fb.model = mS.value;

      epS.addEventListener('change', function() {
        fb.endpoint_id = epS.value;
        fillModels(mS, epS.value, '');
        fb.model = mS.value;
        saveDefault();
      });
      mS.addEventListener('change', function() { fb.model = mS.value; saveDefault(); });

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = '&times;';
      rm.addEventListener('click', function() {
        _fallbacks.splice(idx, 1);
        renderFallbacks();
        saveDefault();
      });

      row.appendChild(num);
      row.appendChild(epS);
      row.appendChild(mS);
      row.appendChild(rm);
      fbContainer.appendChild(row);
    });
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.default_endpoint_id) epSel.value = settings.default_endpoint_id;
    refreshModels(settings.default_model || '');
    _fallbacks = Array.isArray(settings.default_model_fallbacks)
      ? settings.default_model_fallbacks.map(function(f) {
          return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' };
        })
      : [];
    renderFallbacks();
  } catch (e) { console.warn('Failed to load default chat settings', e); }

  async function saveDefault() {
    try {
      var clean = _fallbacks.filter(function(f) { return f.endpoint_id && f.model; });
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_endpoint_id: epSel.value,
          default_model: modelSel.value,
          default_model_fallbacks: clean
        })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', function() { refreshModels(''); saveDefault(); });
  modelSel.addEventListener('change', saveDefault);
  if (addFbBtn) addFbBtn.addEventListener('click', function() {
    var first = enabledEndpoints()[0];
    _fallbacks.push({ endpoint_id: first ? first.id : '', model: '' });
    renderFallbacks();
    saveDefault();
  });

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    refreshEndpointOptions(epSel.value, modelSel.value);
  });
}

/* ── Utility Model ── */
async function initUtilityModel() {
  var epSel = el('set-utilityEpSelect');
  var modelSel = el('set-utilityModelSelect');
  var msg = el('set-utilityChatMsg');
  var _endpoints = [];
  var fallbackWidget = null;
  if (epSel && epSel.options[0]) epSel.options[0].textContent = 'Same as chat';
  if (modelSel && modelSel.options[0]) modelSel.options[0].textContent = 'Same as chat';

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for utility model', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.utility_endpoint_id) epSel.value = settings.utility_endpoint_id;
    refreshModels(settings.utility_model || '');
    fallbackWidget = _bindFallbackWidget({
      containerId: 'set-utilityFallbacks',
      addBtnId: 'set-utilityAddFallback',
      endpoints: function() { return _endpoints; },
      settingKey: 'utility_model_fallbacks',
      initial: Array.isArray(settings.utility_model_fallbacks)
        ? settings.utility_model_fallbacks.map(function(f) { return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' }; })
        : [],
    });
  } catch (e) { console.warn('Failed to load utility model settings', e); }

  // Persist whatever's currently selected. Empty endpoint or model → backend
  // transparently falls back to the chat model (mirrors the teacher panel:
  // no toggle, "—" means "unset, use chat").
  async function saveUtility() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utility_endpoint_id: epSel.value || '',
          utility_model: modelSel.value || ''
        })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 1500);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', function() { refreshModels(''); saveUtility(); });
  modelSel.addEventListener('change', saveUtility);

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
    if (fallbackWidget && fallbackWidget.refresh) fallbackWidget.refresh();
  });
}

/* ── Context Management ── */
// Auto-compact threshold (% of context window) + headroom-style tool
// output compression toggle. Both are app-level settings; the backend
// clamps the threshold to [30, 95] and treats >1 values as percent.
async function initContextManagement() {
  var thresholdInput = el('set-compactThreshold');
  var compressionToggle = el('set-contextCompression');
  var msg = el('set-contextMgmtMsg');
  if (!thresholdInput || !compressionToggle) return;

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    var t = parseFloat(settings.compact_threshold);
    if (!isFinite(t)) t = 0.85;
    if (t <= 1) t = t * 100;
    thresholdInput.value = Math.round(t);
    compressionToggle.checked = settings.context_compression !== false;
  } catch (e) { console.warn('Failed to load context management settings', e); }

  async function save() {
    try {
      var pct = parseInt(thresholdInput.value, 10);
      if (!isFinite(pct)) pct = 85;
      pct = Math.min(95, Math.max(30, pct));
      thresholdInput.value = pct;
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compact_threshold: pct / 100,
          context_compression: compressionToggle.checked
        })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 1500);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  thresholdInput.addEventListener('change', save);
  compressionToggle.addEventListener('change', save);
}

/* ── Teacher Model ── */
// SOTA model called automatically when a self-hosted student model
// fails an agent-mode task. Stored as a single `teacher_model` string
// in the form `model@endpoint_name` so the backend's _resolve_model
// can dispatch directly. Master toggle is the separate
// `teacher_enabled` flag so the user can pause the feature without
// losing their endpoint+model selection.
async function initTeacherModel() {
  var enabledToggle = el('set-teacherEnabledToggle');
  var epSel = el('set-teacherEpSelect');
  var modelSel = el('set-teacherModelSelect');
  var msg = el('set-teacherChatMsg');
  if (!epSel || !modelSel) return;
  var _endpoints = [];

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for teacher model', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  // Disable / enable the endpoint+model dropdowns based on the
  // master switch. Greys them out so users see at a glance that the
  // selection is dormant.
  function syncEnabled() {
    var off = enabledToggle ? !enabledToggle.checked : true;
    // Dim the card when off as a "dormant" cue, but keep the endpoint+model
    // dropdowns INTERACTIVE — the toggle gates whether escalation runs, not
    // whether you can configure it. (Previously the config was inert when off,
    // so users couldn't pick an endpoint until they'd already enabled it.)
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.7' : '';
    var wrap = card ? card.querySelector('.settings-col') : null;
    if (wrap) wrap.style.pointerEvents = '';
    epSel.disabled = false;
    modelSel.disabled = false;
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (enabledToggle) enabledToggle.checked = !!settings.teacher_enabled;
    // teacher_model is stored as "model@endpoint_name". Split on the
    // LAST `@` so model ids that contain @ aren't mangled.
    var spec = settings.teacher_model || '';
    var savedModel = spec;
    var savedEpName = '';
    var at = spec.lastIndexOf('@');
    if (at >= 0) {
      savedModel = spec.slice(0, at);
      savedEpName = spec.slice(at + 1);
    }
    if (savedEpName) {
      var match = _endpoints.find(function(ep) {
        return ep.name && ep.name.toLowerCase().indexOf(savedEpName.toLowerCase()) >= 0;
      });
      if (match) epSel.value = match.id;
    }
    refreshModels(savedModel);
    syncEnabled();
  } catch (e) { console.warn('Failed to load teacher model settings', e); }

  async function saveTeacher() {
    try {
      var spec = '';
      if (epSel.value && modelSel.value) {
        var ep = _endpoints.find(function(e) { return e.id === epSel.value; });
        spec = ep ? (modelSel.value + '@' + ep.name) : modelSel.value;
      }
      var enabled = enabledToggle ? !!enabledToggle.checked : false;
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_enabled: enabled, teacher_model: spec })
      });
      msg.textContent = enabled ? (spec ? 'Saved' : 'Pick an endpoint + model') : 'Disabled';
      msg.style.color = enabled && !spec ? 'var(--red)' : 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  if (enabledToggle) {
    enabledToggle.addEventListener('change', function() {
      syncEnabled();
      saveTeacher();
    });
  }
  epSel.addEventListener('change', function() { refreshModels(''); saveTeacher(); });
  modelSel.addEventListener('change', saveTeacher);

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Image Generation ── */
async function initImageSettings() {
  const modelSel = el('set-imgModelSelect');
  const qualSel = el('set-imgQualitySelect');
  const msg = el('set-imgSettingsMsg');
  const enabledToggle = el('set-imgEnabledToggle');
  const configWrap = modelSel ? modelSel.closest('div[style*="flex-direction"]') : null;
  try {
    const modelsRes = await fetch('/api/models', { credentials: 'same-origin' });
    const modelsData = await modelsRes.json();
    // Inpaint-compat allowlist — image gen here is scoped to inpainting only,
    // so DALL-E / GPT-Image-1 (no inpaint API) are excluded. Currently:
    //   - any model with 'inpaint' in the id
    //   - Stable Diffusion 3.5 Medium (inpaint via diffusers pipeline)
    const _isInpaintModel = (mid) => {
      const lower = String(mid || '').toLowerCase();
      return lower.includes('inpaint')
        || lower.includes('3.5-medium')
        || lower.includes('3-5-medium')
        || lower.includes('sd-3.5-med');
    };
    const imageModels = [];
    (modelsData.items || []).forEach(item => {
      (item.models || []).forEach(mid => {
        if (_isInpaintModel(mid)) imageModels.push(mid);
      });
    });
    sortModelIds(imageModels).forEach(mid => { const opt = document.createElement('option'); opt.value = mid; opt.textContent = mid; modelSel.appendChild(opt); });
    // Hardcoded fallbacks shown as "(not detected)" so users know what to
    // download/serve to enable inpaint here.
    ['stable-diffusion-3.5-medium', 'stable-diffusion-inpainting'].forEach(mid => {
      if (!imageModels.includes(mid)) { const opt = document.createElement('option'); opt.value = mid; opt.textContent = mid + ' (not detected)'; modelSel.appendChild(opt); }
    });
  } catch (e) { console.warn('Failed to load models for image settings', e); }
  try {
    const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await settingsRes.json();
    if (settings.image_model) modelSel.value = settings.image_model;
    if (settings.image_quality) qualSel.value = settings.image_quality;
    if (enabledToggle) enabledToggle.checked = settings.image_gen_enabled !== false;
  } catch (e) { console.warn('Failed to load settings', e); }

  function syncImgDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncImgDisabled();

  async function saveSettings() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_gen_enabled: enabledToggle ? enabledToggle.checked : true, image_model: modelSel.value, image_quality: qualSel.value }) });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)'; setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }
  modelSel.addEventListener('change', saveSettings);
  qualSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncImgDisabled(); saveSettings(); });
}

/* ── Vision ── */
async function initVisionSettings() {
  const vlSel = el('set-vlModelSelect');
  const msg = el('set-visionSettingsMsg');
  const enabledToggle = el('set-visionEnabledToggle');
  const configWrap = vlSel ? vlSel.closest('div[style*="flex-direction"]') : null;
  var _visionEndpoints = [];
  var visionFallbackWidget = null;
  var _vlExclude = ['audio', 'realtime', 'tts', 'dall-e', 'embedding', 'search', 'whisper'];
  function _isVisionModel(mid) {
    var lower = String(mid || '').toLowerCase();
    return !_vlExclude.some(function(kw) { return lower.includes(kw); });
  }
  try {
    const modelsRes = await fetch('/api/models', { credentials: 'same-origin' });
    const modelsData = await modelsRes.json();
    const visionModels = [];
    (modelsData.items || []).forEach(item => {
      if (item.offline) return;
      (item.models || []).forEach(mid => {
        if (_isVisionModel(mid)) {
          visionModels.push(mid);
        }
      });
    });
    sortModelIds(visionModels).forEach(mid => {
      var opt = document.createElement('option'); opt.value = mid; opt.textContent = mid; vlSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load models for vision settings', e); }
  // Also pull the raw endpoint list so the fallback widget can resolve
  // endpoint-id → models the same way the other cards do.
  try {
    _visionEndpoints = await _fetchModelEndpoints();
  } catch (e) { console.warn('Failed to load endpoints for vision fallback', e); }
  try {
    const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await settingsRes.json();
    if (settings.vision_model) vlSel.value = settings.vision_model;
    if (enabledToggle) enabledToggle.checked = settings.vision_enabled !== false;
    visionFallbackWidget = _bindFallbackWidget({
      containerId: 'set-visionFallbacks',
      addBtnId: 'set-visionAddFallback',
      endpoints: function() { return _visionEndpoints; },
      // Vision fallback list filters to vision-capable models (same heuristic
      // as the primary select above — exclude audio/tts/embedding/etc.).
      modelsFilter: function(mid) { return _isVisionModel(mid); },
      settingKey: 'vision_model_fallbacks',
      initial: Array.isArray(settings.vision_model_fallbacks)
        ? settings.vision_model_fallbacks.map(function(f) { return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' }; })
        : [],
    });
  } catch (e) { console.warn('Failed to load vision settings', e); }

  function syncVisionDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncVisionDisabled();

  async function saveSettings() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vision_enabled: enabledToggle ? enabledToggle.checked : true, vision_model: vlSel.value }) });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)'; setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }
  vlSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncVisionDisabled(); saveSettings(); });

  _registerAiEndpointRefresh(function(endpoints) {
    _visionEndpoints = endpoints;
    if (visionFallbackWidget && visionFallbackWidget.refresh) visionFallbackWidget.refresh();
  });
}

/* ── Face Recognition ── */

/* ── Text to Speech ── */
async function initTtsSettings() {
  var provSel = el('set-ttsProviderSelect');
  var modelSelect = el('set-ttsModelSelect');
  var modelInput = el('set-ttsModelInput');
  var voiceSelect = el('set-ttsVoiceSelect');
  var voiceInput = el('set-ttsVoiceInput');
  var modelRow = el('set-ttsModelRow');
  var voiceRow = el('set-ttsVoiceRow');
  var speedSelect = el('set-ttsSpeedSelect');
  var speedRow = el('set-ttsSpeedRow');
  var ttsMsg = el('set-ttsSettingsMsg');
  var ttsEnabledToggle = el('set-ttsEnabledToggle');
  var ttsConfigWrap = provSel ? provSel.closest('div[style*="flex-direction"]') : null;

  function isEndpoint() { return provSel.value.startsWith('endpoint:'); }
  function getModel() { return isEndpoint() ? modelSelect.value : modelInput.value; }
  function getVoice() { return isEndpoint() ? voiceSelect.value : voiceInput.value; }

  function updateVisibility() {
    var prov = provSel.value;
    modelRow.style.display = prov.startsWith('endpoint:') ? 'flex' : 'none';
    voiceRow.style.display = prov === 'disabled' ? 'none' : 'flex';
    speedRow.style.display = prov === 'disabled' ? 'none' : 'flex';
    if (isEndpoint()) {
      modelSelect.style.display = ''; modelInput.style.display = 'none';
      voiceSelect.style.display = ''; voiceInput.style.display = 'none';
    } else {
      modelSelect.style.display = 'none'; modelInput.style.display = '';
      voiceSelect.style.display = 'none'; voiceInput.style.display = prov === 'disabled' ? 'none' : '';
    }
  }

  var ttsKeywords = ['tts', 'audio'];
  try {
    var epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    var endpoints = await epRes.json();
    endpoints.forEach(function(ep) {
      if (!ep.is_enabled) return;
      var hasTTS = (ep.models || []).some(m => ttsKeywords.some(kw => m.toLowerCase().includes(kw)));
      if (!hasTTS) return;
      var opt = document.createElement('option'); opt.value = 'endpoint:' + ep.id; opt.textContent = ep.name + ' (API)'; provSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load endpoints for TTS', e); }

  try {
    var settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await settingsRes.json();
    if (settings.tts_provider) provSel.value = settings.tts_provider;
    if (settings.tts_model) { modelSelect.value = settings.tts_model; modelInput.value = settings.tts_model; }
    if (settings.tts_voice) { voiceSelect.value = settings.tts_voice; voiceInput.value = settings.tts_voice; }
    if (settings.tts_speed) { speedSelect.value = settings.tts_speed; }
    if (ttsEnabledToggle) ttsEnabledToggle.checked = settings.tts_enabled !== false;
  } catch (e) { console.warn('Failed to load TTS settings', e); }

  function syncTtsDisabled() {
    var off = ttsEnabledToggle && !ttsEnabledToggle.checked;
    var card = ttsEnabledToggle ? ttsEnabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (ttsConfigWrap) ttsConfigWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncTtsDisabled();
  updateVisibility();

  async function saveTTS() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts_enabled: ttsEnabledToggle ? ttsEnabledToggle.checked : true, tts_provider: provSel.value, tts_model: getModel() || 'tts-1', tts_voice: getVoice() || 'alloy', tts_speed: speedSelect.value || '1' }) });
      ttsMsg.textContent = 'Saved'; ttsMsg.style.color = 'var(--fg)'; setTimeout(() => { ttsMsg.textContent = ''; }, 2000);
      if (window.aiTTSManager) window.aiTTSManager.checkAvailability();
    } catch (e) { ttsMsg.textContent = 'Failed to save'; ttsMsg.style.color = 'var(--red)'; }
  }

  async function saveAndClearCache() {
    await saveTTS();
    fetch('/api/tts/clear-cache', { method: 'POST', credentials: 'same-origin' }).catch(function(){});
  }

  provSel.addEventListener('change', function() {
    var prov = provSel.value;
    if (prov === 'local') voiceInput.value = 'af_heart';
    else if (isEndpoint()) { voiceSelect.value = 'alloy'; modelSelect.value = 'tts-1'; }
    else if (prov === 'browser') { voiceInput.value = ''; voiceInput.placeholder = 'OS default voice'; }
    updateVisibility();
    saveTTS();
  });
  modelSelect.addEventListener('change', saveAndClearCache);
  modelInput.addEventListener('change', saveTTS);
  voiceSelect.addEventListener('change', saveAndClearCache);
  voiceInput.addEventListener('change', saveTTS);
  speedSelect.addEventListener('change', saveAndClearCache);
  if (ttsEnabledToggle) ttsEnabledToggle.addEventListener('change', function() { syncTtsDisabled(); saveTTS(); });

  // Preview / test button
  var previewBtn = el('set-ttsPreviewBtn');
  if (previewBtn) {
    var previewAudio = null;
    var previewPlaying = false;
    function resetPreview() { previewPlaying = false; previewBtn.textContent = 'Preview'; previewBtn.style.borderColor = ''; }

    previewBtn.addEventListener('click', async function() {
      if (previewPlaying) {
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        window.speechSynthesis.cancel();
        resetPreview(); return;
      }
      var prov = provSel.value;
      if (prov === 'disabled') {
        ttsMsg.textContent = 'Select a provider first'; ttsMsg.style.color = 'var(--red, #e55)';
        setTimeout(function() { ttsMsg.textContent = ''; }, 2000); return;
      }
      var testText = 'Hello, this is a test of text to speech.';
      previewPlaying = true; previewBtn.textContent = 'Loading...';
      try {
        if (prov === 'browser') {
          if (!('speechSynthesis' in window)) throw new Error('Browser TTS not supported');
          var utt = new SpeechSynthesisUtterance(testText);
          var voiceVal = getVoice();
          if (voiceVal) {
            var voices = window.speechSynthesis.getVoices();
            var target = voiceVal.toLowerCase();
            var match = voices.find(function(v) { return v.name.toLowerCase() === target; }) ||
                        voices.find(function(v) { return v.name.toLowerCase().includes(target); });
            if (match) utt.voice = match;
          }
          utt.rate = parseFloat(speedSelect.value) || 1;
          previewBtn.textContent = 'Stop'; previewBtn.style.borderColor = 'var(--red, #e55)';
          await new Promise(function(resolve, reject) {
            utt.onend = resolve;
            utt.onerror = function(e) { reject(new Error('Browser TTS: ' + e.error)); };
            window.speechSynthesis.speak(utt);
          });
        } else {
          var res = await fetch('/api/tts/synthesize', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: testText, format: 'audio' })
          });
          if (!res.ok) { var err = await res.json().catch(function() { return {}; }); throw new Error(err.detail?.message || 'Synthesis failed'); }
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          previewAudio = new Audio(url);
          previewBtn.textContent = 'Stop'; previewBtn.style.borderColor = 'var(--red, #e55)';
          await new Promise(function(resolve, reject) {
            previewAudio.onended = function() { URL.revokeObjectURL(url); previewAudio = null; resolve(); };
            previewAudio.onerror = function() { URL.revokeObjectURL(url); previewAudio = null; reject(new Error('Playback failed')); };
            previewAudio.play().catch(reject);
          });
        }
      } catch (e) {
        ttsMsg.textContent = 'Preview failed: ' + e.message; ttsMsg.style.color = 'var(--red, #e55)';
        setTimeout(function() { ttsMsg.textContent = ''; }, 3000);
      } finally {
        resetPreview();
      }
    });
  }
}

/* ── Speech to Text ── */
async function initSttSettings() {
  var provSel = el('set-sttProviderSelect');
  var modelSelect = el('set-sttModelSelect');
  var modelInput = el('set-sttModelInput');
  var modelRow = el('set-sttModelRow');
  var langRow = el('set-sttLangRow');
  var langInput = el('set-sttLangInput');
  var sttMsg = el('set-sttSettingsMsg');
  var sttEnabledToggle = el('set-sttEnabledToggle');
  var sttConfigWrap = el('set-sttConfigWrap');
  // STT was removed from AI Defaults — bail if the UI isn't present.
  if (!provSel) return;

  function isEndpoint() { return provSel.value.startsWith('endpoint:'); }
  function getModel() { return isEndpoint() ? modelInput.value : modelSelect.value; }

  function updateVisibility() {
    var prov = provSel.value;
    var showModel = prov === 'local' || prov.startsWith('endpoint:');
    var showLang = prov !== 'disabled';
    modelRow.style.display = showModel ? 'flex' : 'none';
    langRow.style.display = showLang ? 'flex' : 'none';
    if (isEndpoint()) {
      modelSelect.style.display = 'none'; modelInput.style.display = '';
    } else {
      modelSelect.style.display = ''; modelInput.style.display = 'none';
    }
  }

  function syncSttDisabled() {
    var off = sttEnabledToggle && !sttEnabledToggle.checked;
    var card = sttEnabledToggle ? sttEnabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (sttConfigWrap) sttConfigWrap.style.pointerEvents = off ? 'none' : '';
  }

  // Effective provider: if toggle is off, treat as disabled regardless of provider select
  function effectiveProvider() {
    if (sttEnabledToggle && !sttEnabledToggle.checked) return 'disabled';
    return provSel.value;
  }

  // Add API endpoints that might support STT
  try {
    var epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    var endpoints = await epRes.json();
    endpoints.forEach(function(ep) {
      if (!ep.is_enabled) return;
      var opt = document.createElement('option'); opt.value = 'endpoint:' + ep.id; opt.textContent = ep.name + ' (API)'; provSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load endpoints for STT', e); }

  // Load saved settings
  try {
    var settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await settingsRes.json();
    if (settings.stt_provider) provSel.value = settings.stt_provider;
    if (settings.stt_model) { modelSelect.value = settings.stt_model; modelInput.value = settings.stt_model; }
    if (settings.stt_language) langInput.value = settings.stt_language;
    if (sttEnabledToggle) sttEnabledToggle.checked = settings.stt_enabled !== false;
  } catch (e) { console.warn('Failed to load STT settings', e); }

  syncSttDisabled();
  updateVisibility();

  async function saveSTT() {
    try {
      var enabled = sttEnabledToggle ? sttEnabledToggle.checked : false;
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stt_enabled: enabled, stt_provider: provSel.value, stt_model: getModel() || 'base', stt_language: langInput.value.trim() }) });
      sttMsg.textContent = 'Saved'; sttMsg.style.color = 'var(--fg)'; setTimeout(() => { sttMsg.textContent = ''; }, 2000);
      // Notify voiceRecorder of effective provider and update send button icon
      if (window.voiceRecorderModule) window.voiceRecorderModule._sttProvider = effectiveProvider();
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    } catch (e) { sttMsg.textContent = 'Failed to save'; sttMsg.style.color = 'var(--red)'; }
  }

  provSel.addEventListener('change', function() { updateVisibility(); saveSTT(); });
  modelSelect.addEventListener('change', saveSTT);
  modelInput.addEventListener('change', saveSTT);
  langInput.addEventListener('change', saveSTT);
  if (sttEnabledToggle) sttEnabledToggle.addEventListener('change', function() { syncSttDisabled(); saveSTT(); });
}

/* ── Deep Research Model (AI tab) ── */
async function initResearchSettings() {
  var epSel = el('set-researchEndpoint');
  var modelSel = el('set-researchModel');
  var tokensInput = el('set-researchMaxTokens');
  var extractTimeoutInput = el('set-researchExtractTimeout');
  var extractConcurrencyInput = el('set-researchExtractConcurrency');
  var runTimeoutInput = el('set-researchRunTimeout');
  var msg = el('set-researchMsg');
  var endpoints = [];

  try {
    endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for research', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_endpoint_id) epSel.value = settings.research_endpoint_id;
    refreshModels(settings.research_model || '');
    if (settings.research_max_tokens) tokensInput.value = settings.research_max_tokens;
    if (settings.research_extraction_timeout_seconds) extractTimeoutInput.value = settings.research_extraction_timeout_seconds;
    if (settings.research_extraction_concurrency) extractConcurrencyInput.value = settings.research_extraction_concurrency;
    if (settings.research_run_timeout_seconds !== undefined && settings.research_run_timeout_seconds !== null) {
      runTimeoutInput.value = settings.research_run_timeout_seconds;
    }
  } catch (e) { console.warn('Failed to load research settings', e); }

  function showStatus() {
    var parts = [];
    if (epSel.value) {
      var epName = epSel.options[epSel.selectedIndex].textContent;
      var mName = modelSel.value ? modelSel.value.split('/').pop() : 'auto';
      parts.push(epName + ' / ' + mName);
    }
    if (tokensInput.value) {
      parts.push('Max tokens: ' + tokensInput.value);
    }
    if (extractTimeoutInput.value) {
      parts.push('Extract: ' + extractTimeoutInput.value + 's');
    }
    if (extractConcurrencyInput.value) {
      parts.push('Parallel: ' + extractConcurrencyInput.value);
    }
    if (runTimeoutInput.value !== '') {
      var rtv = parseInt(runTimeoutInput.value, 10);
      if (!isNaN(rtv)) {
        parts.push(rtv === 0 ? 'Max time: no limit' : 'Max time: ' + rtv + 's');
      }
    }
    if (parts.length) {
      msg.textContent = parts.join(' · ');
      msg.style.color = 'var(--fg)';
    } else {
      msg.textContent = 'Using chat defaults';
      msg.style.color = 'var(--fg)';
    }
  }
  showStatus();

  async function saveResearch() {
    var payload = {
      research_endpoint_id: epSel.value,
      research_model: modelSel.value,
    };
    var tv = parseInt(tokensInput.value, 10);
    if (tv && tv >= 1024) payload.research_max_tokens = tv;
    var et = parseInt(extractTimeoutInput.value, 10);
    if (et && et >= 15 && et <= 3600) payload.research_extraction_timeout_seconds = et;
    var ec = parseInt(extractConcurrencyInput.value, 10);
    if (ec && ec >= 1 && ec <= 12) payload.research_extraction_concurrency = ec;
    if (runTimeoutInput.value !== '') {
      var rt = parseInt(runTimeoutInput.value, 10);
      // 0 = no limit (disables the hard timeout); otherwise 60s..86400s (24h)
      if (!isNaN(rt) && (rt === 0 || (rt >= 60 && rt <= 86400))) {
        payload.research_run_timeout_seconds = rt;
      }
    }
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(showStatus, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', async function() {
    refreshModels('');
    saveResearch();
  });
  modelSel.addEventListener('change', saveResearch);
  tokensInput.addEventListener('change', saveResearch);
  extractTimeoutInput.addEventListener('change', saveResearch);
  extractConcurrencyInput.addEventListener('change', saveResearch);
  runTimeoutInput.addEventListener('change', saveResearch);

  _registerAiEndpointRefresh(function(nextEndpoints) {
    endpoints = nextEndpoints;
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Deep Research Search (Search tab) ── */
async function initResearchSearchSettings() {
  var searchSel = el('set-researchSearch');
  var msg = el('set-researchSearchMsg');

  function updateSearchOptions(settings) {
    var options = searchSel.querySelectorAll('option');
    options.forEach(function(opt) {
      var prov = opt.value;
      if (!prov) return;
      var kf = _searchKeyFields[prov];
      if (!kf) return;
      var hasKey = ((settings[kf] || '').trim() || (settings.search_api_key || '').trim());
      if (!hasKey) {
        opt.textContent = (_searchLabels[prov] || prov) + ' (no key)';
        opt.style.color = 'var(--red)';
      } else {
        opt.textContent = _searchLabels[prov] || prov;
        opt.style.color = '';
      }
    });
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_search_provider) searchSel.value = settings.research_search_provider;
    updateSearchOptions(settings);
  } catch (e) { console.warn('Failed to load research search settings', e); }

  async function saveResearchSearch() {
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ research_search_provider: searchSel.value })
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  searchSel.addEventListener('change', saveResearchSearch);
}

/* ── Agent Settings (AI tab) ── */
async function initAgentSettings() {
  var toolsInput = el('set-agentMaxTools');
  var roundsInput = el('set-agentMaxRounds');
  var msg = el('set-agentMsg');
  if (!toolsInput) return;

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.agent_max_tool_calls) toolsInput.value = settings.agent_max_tool_calls;
    if (roundsInput && settings.agent_max_rounds) roundsInput.value = settings.agent_max_rounds;
  } catch (e) {}

  // Clamp + coerce a raw input to an int in [lo, hi]; falls back to `dflt`
  // when blank/non-numeric. Mirrors the server-side validation.
  function clampInt(raw, lo, hi, dflt) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(n, hi));
  }

  async function save() {
    var tools = clampInt(toolsInput.value, 0, 1000, 0);
    var rounds = roundsInput ? clampInt(roundsInput.value, 1, 200, 20) : null;
    toolsInput.value = tools;                       // reflect the clamped value
    if (roundsInput) roundsInput.value = rounds;
    var payload = { agent_max_tool_calls: tools };
    if (rounds != null) payload.agent_max_rounds = rounds;
    try {
      await fetch('/api/auth/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      msg.textContent = (tools > 0 ? 'Limit: ' + tools + ' tool calls' : 'Unlimited tool calls') +
        (rounds != null ? ' · ' + rounds + ' steps/message' : '');
      msg.style.color = 'var(--fg)';
    } catch (e) { msg.textContent = 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  toolsInput.addEventListener('change', save);
  if (roundsInput) roundsInput.addEventListener('change', save);
  var cur = parseInt(toolsInput.value, 10) || 0;
  var curR = roundsInput ? (parseInt(roundsInput.value, 10) || 20) : null;
  msg.textContent = (cur > 0 ? 'Limit: ' + cur + ' tool calls' : 'Unlimited tool calls') +
    (curR != null ? ' · ' + curR + ' steps/message' : '');
}

/* ═══════════════════════════════════════════
   APPEARANCE TAB
   ═══════════════════════════════════════════ */
function initAppearance() {
  syncAppearanceCheckboxes();
  syncPrivacyCheckboxes();

  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    chk.addEventListener('change', async function() {
      var key = chk.dataset.uiKey;

      if (window.UI_VIS_ADMIN_ONLY && window.UI_VIS_ADMIN_ONLY.has(key) && !chk.checked && !window._isAdmin) {
        chk.checked = true;
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Only admins can hide Settings.');
        }
        return;
      }

      // Hiding the Settings cog removes the only visible way to re-open this
      // panel. Warn the user and remind them about the `/settings` slash
      // command so they don't lock themselves out.
      if (key === 'sidebar-settings-btn' && !chk.checked) {
        var ok = true;
        try {
          ok = await (uiModule && uiModule.styledConfirm
            ? uiModule.styledConfirm(
                'Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.',
                { confirmText: 'Hide', cancelText: 'Cancel' }
              )
            : Promise.resolve(window.confirm('Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.')));
        } catch (_) { ok = false; }
        if (!ok) {
          chk.checked = true;
          return;
        }
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Settings cog hidden — type /settings to bring it back.', 5000);
        }
      }

      var s = window.loadUIVis();
      s[key] = chk.checked;
      window.saveUIVis(s);
      window.applyUIVis(s);
    });
  });

  modalEl.querySelectorAll('[data-privacy-key]').forEach(function(chk) {
    chk.addEventListener('change', function() {
      if (chk.dataset.privacyKey !== 'sensitive-blur') return;
      localStorage.setItem('talos-sensitive-blur', chk.checked ? 'on' : 'off');
      window.dispatchEvent(new CustomEvent('talos-sensitive-blur-change', {
        detail: { enabled: chk.checked }
      }));
    });
  });

  var resetBtn = el('set-uiVisResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      localStorage.removeItem('talos-ui-visibility');
      syncAppearanceCheckboxes();
      syncPrivacyCheckboxes();
      window.applyUIVis({});
    });
  }
}

function syncAppearanceCheckboxes() {
  var s = window.loadUIVis ? window.loadUIVis() : {};
  var defaultOff = window.UI_VIS_DEFAULT_OFF || new Set();
  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    var key = chk.dataset.uiKey;
    chk.checked = key in s ? s[key] !== false : !defaultOff.has(key);
  });
}

function syncPrivacyCheckboxes() {
  modalEl.querySelectorAll('[data-privacy-key="sensitive-blur"]').forEach(function(chk) {
    chk.checked = localStorage.getItem('talos-sensitive-blur') === 'on';
  });
}

/* ═══════════════════════════════════════════
   SHORTCUTS TAB
   ═══════════════════════════════════════════ */

const SHORTCUT_DEFAULTS = {
  search:         'ctrl+k',
  toggle_sidebar: 'ctrl+b',
  new_session:    'ctrl+alt+n',
  fav_session:    'ctrl+alt+f',
  delete_session: 'ctrl+alt+d',
  cancel:         'escape',
  tts:            'alt+shift+t',
  incognito:      'ctrl+alt+i',
  settings:       'ctrl+,',
  focus_input:    'ctrl+/',
  // Open-tool shortcuts. Calendar is bound by default; the rest are
  // unbound (empty) so the user can assign their own in the panel.
  open_calendar:  'ctrl+alt+c',
  open_compare:   '',
  open_cookbook:  '',
  open_research:  '',
  open_gallery:   '',
  open_library:   '',
  open_memory:    '',
  open_notes:     '',
  open_tasks:     '',
  open_theme:     '',
};

const SHORTCUT_ICONS = {
  search:         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  toggle_sidebar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  new_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  fav_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  delete_session: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  cancel:         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  tts:            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  incognito:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>',
  settings:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  focus_input:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  open_calendar:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  open_compare:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="8" height="18" rx="1"/><rect x="14" y="3" width="8" height="18" rx="1"/></svg>',
  open_cookbook:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  open_research:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  open_gallery:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  open_library:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  open_memory:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>',
  open_notes:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5"/><path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z"/></svg>',
  open_tasks:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></svg>',
  open_theme:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20 5 5 0 0 0 5-5 3 3 0 0 0-3-3h-2a3 3 0 0 1-3-3 5 5 0 0 1 5-5"/></svg>',
};

const SHORTCUT_LABELS = {
  search:         'Search conversations',
  toggle_sidebar: 'Toggle sidebar',
  new_session:    'New session',
  fav_session:    'Favorite session',
  delete_session: 'Delete session',
  cancel:         'Cancel / close',
  tts:            'Play/stop TTS',
  incognito:      'Toggle incognito',
  settings:       'Toggle Window',
  focus_input:    'Focus chat input',
  open_calendar:  'Open Calendar',
  open_compare:   'Open Compare',
  open_cookbook:  'Open Cookbook',
  open_research:  'Open Deep Research',
  open_gallery:   'Open Gallery',
  open_library:   'Open Library',
  open_memory:    'Open Memory',
  open_notes:     'Open Notes',
  open_tasks:     'Open Tasks',
  open_theme:     'Open Theme',
};

const SHORTCUT_CATEGORIES = [
  { name: 'Navigation', keys: ['search', 'toggle_sidebar', 'focus_input', 'settings'] },
  { name: 'Sessions', keys: ['new_session', 'fav_session', 'delete_session'] },
  { name: 'Tools', keys: ['incognito', 'tts', 'cancel'] },
  { name: 'Open Tools', keys: ['open_calendar', 'open_cookbook', 'open_research', 'open_gallery', 'open_library', 'open_memory', 'open_notes', 'open_tasks'] },
];

function _formatKeyCaps(combo) {
  return combo.split('+').map(p => {
    let label;
    if (p === 'ctrl') label = 'Ctrl';
    else if (p === 'alt') label = 'Alt';
    else if (p === 'shift') label = 'Shift';
    else if (p === 'meta') label = 'Cmd';
    else if (p === 'escape') label = 'Esc';
    else if (p === ',') label = ',';
    else if (p === '/') label = '/';
    else if (p === 'space') label = 'Space';
    else label = p.charAt(0).toUpperCase() + p.slice(1);
    return `<kbd>${label}</kbd>`;
  }).join('');
}

function _comboFromEvent(e) {
  // Drop a stray AltGr keystroke (e.g. AltGr+E to type €) so it isn't recorded
  // as a bogus ctrl+alt+<char> binding — onKey ignores empty combos. See
  // platform.js for the macOS carve-out and Windows trade-off.
  if (isAltGrEvent(e)) return '';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.toLowerCase();
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) {
    parts.push(key === ' ' ? 'space' : key);
  }
  return parts.join('+');
}

async function initShortcuts() {
  const listEl = el('shortcuts-list');
  const resetBtn = el('shortcuts-reset-btn');
  if (!listEl) return;

  // Load saved keybinds
  let keybinds = { ...SHORTCUT_DEFAULTS };
  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await res.json();
    if (settings.keybinds) keybinds = { ...keybinds, ...settings.keybinds };
  } catch (e) {}

  function _findConflicts() {
    const comboMap = {};
    for (const [action, combo] of Object.entries(keybinds)) {
      if (!comboMap[combo]) comboMap[combo] = [];
      comboMap[combo].push(action);
    }
    const conflicts = new Set();
    for (const actions of Object.values(comboMap)) {
      if (actions.length > 1) actions.forEach(a => conflicts.add(a));
    }
    return conflicts;
  }

  function render() {
    listEl.innerHTML = '';
    const conflicts = _findConflicts();

    for (const cat of SHORTCUT_CATEGORIES) {
      const catHeader = document.createElement('div');
      catHeader.className = 'shortcut-category';
      catHeader.textContent = cat.name;
      listEl.appendChild(catHeader);

      for (const action of cat.keys) {
        if (!(action in keybinds)) continue;
        const combo = keybinds[action];
        // Unbound shortcuts (empty combo) still render so the user can
        // assign one \u2014 they show a "Set" affordance instead of keycaps.
        const label = SHORTCUT_LABELS[action] || action;
        const icon = SHORTCUT_ICONS[action] || '';
        const isCustom = combo !== (SHORTCUT_DEFAULTS[action] || '');
        const hasConflict = combo && conflicts.has(action);
        const row = document.createElement('div');
        row.className = 'shortcut-row' + (hasConflict ? ' shortcut-conflict' : '');
        row.dataset.action = action;
        const keyContent = combo ? _formatKeyCaps(combo) : '<span class="shortcut-unset">Set</span>';
        row.innerHTML = `
          <span class="shortcut-label"><span class="shortcut-icon">${icon}</span>${esc(label)}${hasConflict ? '<span class="shortcut-warn" title="Duplicate shortcut">!</span>' : ''}</span>
          <div class="shortcut-controls">
            <span class="shortcut-hint" hidden></span>
            <button class="shortcut-key${combo ? '' : ' shortcut-key-unset'}" data-action="${action}" title="Click to rebind">${keyContent}</button>
            <button class="shortcut-action-btn ${isCustom ? 'is-reset' : ''}" data-action="${action}" title="${isCustom ? 'Reset to default' : 'Confirm'}" style="${isCustom ? '' : 'visibility:hidden'}">
              ${isCustom ? '\u21A9' : '\u2713'}
            </button>
          </div>
        `;
        listEl.appendChild(row);
      }
    }

    listEl.querySelectorAll('.shortcut-key').forEach(btn => {
      btn.addEventListener('click', () => startRebind(btn));
    });

    listEl.querySelectorAll('.shortcut-action-btn.is-reset').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        keybinds[action] = SHORTCUT_DEFAULTS[action];
        saveKeybinds();
        render();
      });
    });
  }

  function startRebind(btn) {
    const action = btn.dataset.action;
    const row = btn.closest('.shortcut-row');
    const actionBtn = row.querySelector('.shortcut-action-btn');
    const hintEl = row.querySelector('.shortcut-hint');

    // Remove any other active rebind
    listEl.querySelectorAll('.shortcut-key.listening').forEach(b => {
      b.classList.remove('listening');
      b.innerHTML = _formatKeyCaps(keybinds[b.dataset.action]);
      const otherRow = b.closest('.shortcut-row');
      const otherAction = otherRow.querySelector('.shortcut-action-btn');
      if (otherAction && !otherAction.classList.contains('is-reset')) otherAction.style.visibility = 'hidden';
    });

    btn.classList.add('listening');
    btn.textContent = 'Press keys...';
    // Show confirm button
    actionBtn.textContent = '\u2713';
    actionBtn.classList.remove('is-reset');
    actionBtn.style.visibility = 'visible';
    actionBtn.title = 'Confirm';
    // Hint: tell the user how to commit / cancel the rebind.
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = 'press a key';
    }

    let pendingCombo = null;

    // Wire confirm button
    const confirmHandler = () => {
      if (pendingCombo) {
        keybinds[action] = pendingCombo;
        saveKeybinds();
      }
      cleanup();
      render();
    };
    actionBtn.addEventListener('click', confirmHandler, { once: true });

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cleanup();
        btn.innerHTML = _formatKeyCaps(keybinds[action]);
        const isCustom = keybinds[action] !== SHORTCUT_DEFAULTS[action];
        if (isCustom) {
          actionBtn.textContent = '\u21A9';
          actionBtn.classList.add('is-reset');
          actionBtn.title = 'Reset to default';
        } else {
          actionBtn.style.visibility = 'hidden';
        }
        return;
      }

      // Enter commits the previewed combo (same as clicking \u2713). Only acts
      // as commit once a combo has been captured \u2014 otherwise it would just
      // try to bind Enter itself.
      if (e.key === 'Enter' && pendingCombo) {
        confirmHandler();
        return;
      }

      const combo = _comboFromEvent(e);
      if (!combo || combo === 'ctrl' || combo === 'alt' || combo === 'shift' || combo === 'ctrl+alt' || combo === 'ctrl+shift' || combo === 'alt+shift' || combo === 'ctrl+alt+shift') return;

      // Preview the combo, wait for confirm
      pendingCombo = combo;
      btn.innerHTML = _formatKeyCaps(combo);
      // Now that a combo is captured, prompt to commit with Enter.
      if (hintEl) hintEl.textContent = '\u21B5 Enter to save';
    }

    function cleanup() {
      btn.classList.remove('listening');
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      document.removeEventListener('keydown', onKey, true);
      actionBtn.removeEventListener('click', confirmHandler);
    }

    document.addEventListener('keydown', onKey, true);
  }

  async function saveKeybinds() {
    try {
      await fetch('/api/auth/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keybinds }),
      });
      // Update global keybinds so they take effect immediately
      window._talosKeybinds = keybinds;
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcut saved');
    } catch (e) {
      console.error('Failed to save keybinds:', e);
    }
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      keybinds = { ...SHORTCUT_DEFAULTS };
      render();
      await saveKeybinds();
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcuts reset to defaults');
    });
  }

  render();
}

/* ═══════════════════════════════════════════
   INIT & REFRESH
   ═══════════════════════════════════════════ */
function initAccount() {
  // Populate user info
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      const nameEl = el('settings-account-username');
      const roleEl = el('settings-account-role');
      const avatarEl = el('settings-account-avatar');
      if (nameEl) nameEl.textContent = d.username || 'Unknown';
      if (roleEl) roleEl.textContent = d.is_admin ? 'Admin' : 'User';
      if (avatarEl) {
        const initial = (d.username || '?')[0].toUpperCase();
        avatarEl.textContent = initial;
      }
    }).catch(() => {});

  // Change password
  const saveBtn = el('settings-pw-save');
  const msgEl = el('settings-pw-msg');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const cur = el('settings-pw-current').value;
      const nw = el('settings-pw-new').value;
      const conf = el('settings-pw-confirm').value;
      msgEl.style.color = '';
      if (!cur || !nw) { msgEl.textContent = 'Fill in all fields'; msgEl.style.color = 'var(--red)'; return; }
      if (nw.length < 8) { msgEl.textContent = 'Min 8 characters'; msgEl.style.color = 'var(--red)'; return; }
      if (nw !== conf) { msgEl.textContent = 'Passwords don\'t match'; msgEl.style.color = 'var(--red)'; return; }
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: cur, new_password: nw })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed'); }
        msgEl.style.color = 'var(--green)';
        msgEl.textContent = 'Password updated';
        el('settings-pw-current').value = '';
        el('settings-pw-new').value = '';
        el('settings-pw-confirm').value = '';
      } catch (e) {
        msgEl.style.color = 'var(--red)';
        msgEl.textContent = e.message;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ── Two-Factor Authentication ──
  const tfaContent = el('settings-2fa-content');
  if (tfaContent) {
    async function render2FA() {
      try {
        const res = await fetch('/api/auth/2fa/status', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.enabled) {
          // 2FA is ON — show disable option
          tfaContent.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="color:var(--color-save-green, #4caf50);font-size:12px;font-weight:600;">&#x2713; Enabled</span>
              <span style="font-size:11px;opacity:0.5;">Authenticator app required on login</span>
            </div>
            <input id="tfa-disable-pw" type="password" placeholder="Enter password to disable" autocomplete="current-password" style="padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit;font-size:12px;width:100%;box-sizing:border-box;margin-bottom:6px;">
            <div class="settings-row" style="justify-content:flex-end;">
              <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
              <button class="admin-btn-add" id="tfa-disable-btn" style="opacity:0.7;">Disable 2FA</button>
            </div>`;
          el('tfa-disable-btn').addEventListener('click', async () => {
            const pw = el('tfa-disable-pw').value;
            const msg = el('tfa-msg');
            if (!pw) { msg.textContent = 'Enter your password'; msg.style.color = 'var(--red)'; return; }
            try {
              const r = await fetch('/api/auth/2fa/disable', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw })
              });
              if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Failed'); }
              render2FA();
            } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
          });
        } else {
          // 2FA is OFF — show setup button
          tfaContent.innerHTML = `
            <div style="font-size:12px;opacity:0.6;margin-bottom:8px;">Add an extra layer of security with an authenticator app (Aegis, Google Authenticator, etc.)</div>
            <div class="settings-row" style="justify-content:flex-end;">
              <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
              <button class="admin-btn-add" id="tfa-setup-btn">Set Up 2FA</button>
            </div>`;
          el('tfa-setup-btn').addEventListener('click', async () => {
            const msg = el('tfa-msg');
            try {
              const r = await fetch('/api/auth/2fa/setup', { method: 'POST', credentials: 'same-origin' });
              if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Failed'); }
              const setup = await r.json();
              const qrCode = safeRasterDataUrl(setup.qr_code);
              // Show QR code + manual secret + verify input
              tfaContent.innerHTML = `
                <div style="text-align:center;margin-bottom:12px;">
                  ${qrCode ? `<img src="${esc(qrCode)}" alt="QR Code" style="border-radius:8px;max-width:200px;">` : ''}
                </div>
                <div style="font-size:11px;opacity:0.5;text-align:center;margin-bottom:8px;">
                  Scan with your authenticator app, or enter manually:
                </div>
                <div style="font-family:monospace;font-size:12px;text-align:center;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:12px;word-break:break-all;user-select:all;cursor:text;">${esc(setup.secret)}</div>
                <input id="tfa-verify-code" type="text" placeholder="Enter 6-digit code to verify" autocomplete="one-time-code" inputmode="numeric" maxlength="8" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit;font-size:13px;box-sizing:border-box;text-align:center;letter-spacing:3px;margin-bottom:6px;">
                <div class="settings-row" style="justify-content:flex-end;">
                  <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
                  <button class="admin-btn-add" id="tfa-cancel-btn" style="opacity:0.5;">Cancel</button>
                  <button class="admin-btn-add" id="tfa-verify-btn">Verify & Enable</button>
                </div>`;
              el('tfa-verify-code').focus();
              el('tfa-cancel-btn').addEventListener('click', () => render2FA());
              el('tfa-verify-btn').addEventListener('click', async () => {
                const code = el('tfa-verify-code').value.trim();
                const vmsg = el('tfa-msg');
                if (!code) { vmsg.textContent = 'Enter the code'; vmsg.style.color = 'var(--red)'; return; }
                try {
                  const vr = await fetch('/api/auth/2fa/confirm', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                  });
                  if (!vr.ok) { const d = await vr.json(); throw new Error(d.detail || 'Invalid code'); }
                  const result = await vr.json();
                  // Show backup codes
                  const codes = result.backup_codes || [];
                  tfaContent.innerHTML = `
                    <div style="color:var(--color-save-green, #4caf50);font-size:13px;font-weight:600;margin-bottom:8px;">&#x2713; 2FA Enabled!</div>
                    <div style="font-size:12px;opacity:0.7;margin-bottom:8px;">Save these backup codes somewhere safe. Each can be used once if you lose your authenticator:</div>
                    <div style="font-family:monospace;font-size:12px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;columns:2;column-gap:16px;margin-bottom:8px;">${codes.map(c => '<div style="margin-bottom:2px;">' + c + '</div>').join('')}</div>
                    <button class="admin-btn-add" id="tfa-done-btn">Done</button>`;
                  el('tfa-done-btn').addEventListener('click', () => render2FA());
                } catch (e) { vmsg.textContent = e.message; vmsg.style.color = 'var(--red)'; }
              });
            } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
          });
        }
      } catch (_) {
        tfaContent.innerHTML = '<div style="font-size:11px;opacity:0.4;">Could not load 2FA status</div>';
      }
    }
    render2FA();
  }

  // Logout
  const logoutBtn = el('settings-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('mouseenter', () => { logoutBtn.style.opacity = '1'; logoutBtn.style.borderColor = 'var(--red)'; logoutBtn.style.color = 'var(--red)'; });
    logoutBtn.addEventListener('mouseleave', () => { logoutBtn.style.opacity = ''; logoutBtn.style.borderColor = ''; logoutBtn.style.color = ''; });
    logoutBtn.addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      // SECURITY: wipe all client-side state on logout so the next user that
      // signs in on this browser doesn't inherit the previous account's
      // session id, last-used model, draft chat input, or any cached lists.
      // Keep "talos-last-user" so the login form remembers the username
      // (if "Remember me" was on). Without this the chat composer pre-loaded
      // the previous user's last model into a fresh session, which read as
      // cross-account leakage.
      try {
        const _keepKeys = new Set(['talos-last-user']);
        const _toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && !_keepKeys.has(k)) _toRemove.push(k);
        }
        _toRemove.forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();
      } catch (_) {}
      window.location.href = '/login';
    });
  }
}

function initAll() {
  modalEl = el('settings-modal');
  initTabs();
  initDrag();
  initClose();
  initOpacityToggle();
  initialized = true;
  initDefaultChat();
  initTeacherModel();
  initUtilityModel();
  initContextManagement();
  initImageSettings();
  initVisionSettings();
  initTtsSettings();
  initSttSettings();
  initResearchSettings();
  initResearchSearchSettings();
  initAgentSettings();
  initAppearance();
  initShortcuts();
  initAccount();
  initIntegrations();
  initUnifiedIntegrations();
}

function notifyIntegrationsChanged() {
  try {
    window.dispatchEvent(new CustomEvent('talos-integrations-changed'));
  } catch (_) {}
}

async function initIntegrations() {
  const listEl = el('integrations-list');
  const formCard = el('integration-form-card');
  const addBtn = el('intg-add-btn');
  if (!listEl || !formCard) return;

  const presetSel = el('intg-preset');
  const nameIn = el('intg-name');
  const urlIn = el('intg-url');
  const authTypeSel = el('intg-auth-type');
  const authHeaderRow = el('intg-auth-header-row');
  const authHeaderIn = el('intg-auth-header');
  const keyIn = el('intg-key');
  const descIn = el('intg-description');
  const saveBtn = el('intg-save-btn');
  const cancelBtn = el('intg-cancel-btn');
  const testBtn = el('intg-test-btn');
  const statusEl = el('intg-status');
  const formTitle = el('integration-form-title');

  let editingId = null;
  let presets = {};

  // Toggle auth header row visibility
  function syncAuthRow() {
    const v = authTypeSel.value;
    authHeaderRow.style.display = (v === 'header' || v === 'query') ? 'flex' : 'none';
    if (v === 'query') authHeaderIn.placeholder = 'api_key';
    else authHeaderIn.placeholder = 'X-Auth-Token';
  }
  authTypeSel.addEventListener('change', syncAuthRow);

  // Load presets
  try {
    const res = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      presets = data.presets || {};
      for (const [key, preset] of Object.entries(presets)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.name || key;
        presetSel.appendChild(opt);
      }
    }
  } catch (e) {}

  // Preset auto-fill
  presetSel.addEventListener('change', () => {
    const p = presets[presetSel.value];
    if (!p) return;
    nameIn.value = p.name || '';
    authTypeSel.value = p.auth_type || 'none';
    authHeaderIn.value = p.auth_header || '';
    descIn.value = p.description || '';
    syncAuthRow();
  });

  // Render list
  async function renderList() {
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      if (!res.ok) { listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px;">Admin access required</div>'; return; }
      const data = await res.json();
      const items = data.integrations || [];
      if (!items.length) {
        listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px;text-align:center;">No integrations configured</div>';
        return;
      }
      listEl.innerHTML = items.map(i => `
        <div class="admin-card" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;">${_esc(i.name || i.id)}</div>
            <div style="font-size:11px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(i.base_url || '')}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="admin-btn-sm intg-edit-btn" data-id="${i.id}" style="font-size:11px;">Edit</button>
            <button class="admin-btn-sm intg-del-btn" data-id="${i.id}" style="font-size:11px;opacity:0.6;">Del</button>
          </div>
        </div>
      `).join('');
      listEl.querySelectorAll('.intg-edit-btn').forEach(b => b.addEventListener('click', () => startEdit(b.dataset.id)));
      listEl.querySelectorAll('.intg-del-btn').forEach(b => b.addEventListener('click', () => doDelete(b.dataset.id)));
    } catch (e) { listEl.innerHTML = '<div style="padding:12px;color:var(--red);font-size:12px;">Failed to load</div>'; }
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Start editing
  async function startEdit(id) {
    editingId = id;
    formTitle.textContent = 'Edit Integration';
    // Fetch full data (with unmasked key from a dedicated edit fetch — we'll just load what we have)
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      const data = await res.json();
      const item = (data.integrations || []).find(i => i.id === id);
      if (!item) return;
      presetSel.value = item.preset || '';
      nameIn.value = item.name || '';
      urlIn.value = item.base_url || '';
      authTypeSel.value = item.auth_type || 'none';
      authHeaderIn.value = item.auth_header || '';
      keyIn.value = ''; // masked — user re-enters if changing
      keyIn.placeholder = item.api_key ? 'Leave blank to keep current' : 'API key or token';
      descIn.value = item.description || '';
      syncAuthRow();
      formCard.style.display = '';
    } catch (e) {}
  }

  // Show add form
  addBtn.addEventListener('click', () => {
    editingId = null;
    formTitle.textContent = 'Add Integration';
    presetSel.value = '';
    nameIn.value = '';
    urlIn.value = '';
    authTypeSel.value = 'header';
    authHeaderIn.value = '';
    keyIn.value = '';
    keyIn.placeholder = 'API key or token';
    descIn.value = '';
    statusEl.textContent = '';
    syncAuthRow();
    formCard.style.display = '';
  });

  cancelBtn.addEventListener('click', () => {
    formCard.style.display = 'none';
    statusEl.textContent = '';
  });

  // Save
  saveBtn.addEventListener('click', async () => {
    const payload = {
      name: nameIn.value.trim(),
      base_url: urlIn.value.trim().replace(/\/+$/, ''),
      auth_type: authTypeSel.value,
      auth_header: authHeaderIn.value.trim(),
      description: descIn.value.trim(),
    };
    if (presetSel.value) payload.preset = presetSel.value;
    if (keyIn.value.trim()) payload.api_key = keyIn.value.trim();
    if (!payload.name) { statusEl.textContent = 'Name required'; statusEl.style.color = 'var(--red)'; return; }
    if (!payload.base_url) { statusEl.textContent = 'URL required'; statusEl.style.color = 'var(--red)'; return; }

    try {
      const url = editingId ? `/api/auth/integrations/${editingId}` : '/api/auth/integrations';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' });
      if (res.ok) {
        statusEl.textContent = 'Saved';
        statusEl.style.color = 'var(--green, #98c379)';
        formCard.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      } else {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = err.detail || 'Save failed';
        statusEl.style.color = 'var(--red)';
      }
    } catch (e) {
      statusEl.textContent = 'Error saving';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Test
  testBtn.addEventListener('click', async () => {
    if (!editingId) { statusEl.textContent = 'Save first, then test'; statusEl.style.color = 'var(--fg)'; return; }
    statusEl.textContent = 'Testing...';
    statusEl.style.color = 'var(--fg)';
    try {
      const res = await fetch(`/api/auth/integrations/${editingId}/test`, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      statusEl.textContent = data.message || (data.ok ? 'OK' : 'Failed');
      statusEl.style.color = data.ok ? 'var(--green, #98c379)' : 'var(--red)';
    } catch (e) {
      statusEl.textContent = 'Connection failed';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Delete
  async function doDelete(id) {
    if (!await window.styledConfirm('Delete this integration?', { confirmText: 'Delete', danger: true })) return;
    try {
      await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (editingId === id) { formCard.style.display = 'none'; editingId = null; }
      await renderList();
      notifyIntegrationsChanged();
    } catch (e) {}
  }

  syncAuthRow();
  renderList();
}

/* ══ Unified Integrations ══ */

const INTG_TYPES = {
  api:     { label: 'API',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  contacts: { label: 'Contacts', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  sql:     { label: 'SQL',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>' },
  mcp:     { label: 'MCP',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
  codex:   { label: 'Codex',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 10.696.453a6.023 6.023 0 0 0-5.75 4.172 6.061 6.061 0 0 0-3.946 2.945 6.024 6.024 0 0 0 .742 7.099 5.98 5.98 0 0 0 .516 4.911 6.046 6.046 0 0 0 6.51 2.9A5.996 5.996 0 0 0 13.26 23.547a6.023 6.023 0 0 0 5.75-4.172 6.061 6.061 0 0 0 3.946-2.945 6.024 6.024 0 0 0-.674-6.609zM13.26 21.047a4.508 4.508 0 0 1-2.886-1.041l.143-.082 4.793-2.769a.777.777 0 0 0 .391-.676V10.34l2.026 1.17a.072.072 0 0 1 .039.061v5.596a4.532 4.532 0 0 1-4.506 4.48zM3.968 17.64a4.473 4.473 0 0 1-.537-3.018l.143.086 4.793 2.769a.79.79 0 0 0 .782 0l5.852-3.379v2.34a.072.072 0 0 1-.029.062l-4.845 2.796a4.532 4.532 0 0 1-6.159-1.656zM2.804 7.922a4.49 4.49 0 0 1 2.348-1.973V11.6a.778.778 0 0 0 .391.676l5.852 3.378-2.026 1.17a.072.072 0 0 1-.068 0L4.456 14.03a4.532 4.532 0 0 1-1.652-6.108zm16.423 3.823L13.375 8.367l2.026-1.17a.072.072 0 0 1 .068 0l4.845 2.796a4.525 4.525 0 0 1-.7 8.08V12.42a.778.778 0 0 0-.387-.676zm2.015-3.025l-.143-.086-4.793-2.769a.79.79 0 0 0-.782 0L9.672 9.243V6.903a.072.072 0 0 1 .029-.062l4.845-2.796a4.525 4.525 0 0 1 6.696 4.675zM8.598 12.66L6.57 11.49a.072.072 0 0 1-.039-.061V5.833a4.525 4.525 0 0 1 7.413-3.48l-.143.082-4.793 2.769a.777.777 0 0 0-.391.676l-.019 6.78zm1.1-2.379l2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505z"/></svg>' },
  claude:  { label: 'Claude',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>' },
};

// Config shared by the Codex Agent and Claude Agent forms. Both use the same
// scope-gated /api/codex/* backend; this just parameterizes the UI label,
// default token name, and the per-agent install commands.
const AGENT_CONFIGS = {
  codex: {
    label: 'Codex Agent',
    word: 'Codex',
    namePrefix: 'codex agent',
    defaultName: 'Codex Agent',
    pluginPath: '/api/codex/plugin.zip',
    setupDescription: 'Downloads the plugin bundle and registers it with Codex. Sets <code>TALOS_URL</code> + <code>TALOS_API_TOKEN</code>, fetches the plugin from <a href="/api/codex/plugin.zip" style="color:var(--accent,var(--red));">this Talos instance</a>, and runs <code>codex plugin add talos@personal</code>.',
    buildSetup: (origin, token) => `export TALOS_URL=${origin}
export TALOS_API_TOKEN='${token}'
mkdir -p ~/plugins
curl -fsSL -H "Authorization: Bearer $TALOS_API_TOKEN" "$TALOS_URL/api/codex/plugin.zip" -o /tmp/talos-codex-plugin.zip
python3 -m zipfile -e /tmp/talos-codex-plugin.zip ~/plugins
python3 - <<'PY'
import json
from pathlib import Path

p = Path.home() / ".agents" / "plugins" / "marketplace.json"
p.parent.mkdir(parents=True, exist_ok=True)
if p.exists():
    data = json.loads(p.read_text())
else:
    data = {"name": "personal", "interface": {"displayName": "Personal"}, "plugins": []}

data.setdefault("name", "personal")
data.setdefault("interface", {}).setdefault("displayName", "Personal")
plugins = data.setdefault("plugins", [])
entry = {
    "name": "talos",
    "source": {"source": "local", "path": "./plugins/talos"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity",
}
data["plugins"] = [item for item in plugins if item.get("name") != "talos"] + [entry]
p.write_text(json.dumps(data, indent=2) + "\\n")
PY
codex plugin add talos@personal
python3 ~/plugins/talos/scripts/talos_api.py capabilities`,
  },
  claude: {
    label: 'Claude Agent',
    word: 'Claude',
    namePrefix: 'claude agent',
    defaultName: 'Claude Agent',
    pluginPath: '/api/claude/plugin.zip',
    setupDescription: 'Downloads the skill bundle into <code>~/.claude/skills/talos/</code>. Sets <code>TALOS_URL</code> + <code>TALOS_API_TOKEN</code>, fetches the skill from <a href="/api/claude/plugin.zip" style="color:var(--accent,var(--red));">this Talos instance</a>. Claude Code auto-loads the skill on next start.',
    buildSetup: (origin, token) => `export TALOS_URL=${origin}
export TALOS_API_TOKEN='${token}'
mkdir -p ~/.claude
curl -fsSL -H "Authorization: Bearer $TALOS_API_TOKEN" "$TALOS_URL/api/claude/plugin.zip" -o /tmp/talos-claude-skill.zip
python3 -m zipfile -e /tmp/talos-claude-skill.zip ~/.claude/
python3 ~/.claude/skills/talos/scripts/talos_api.py capabilities`,
  },
};

let _unifiedInited = false;

async function initUnifiedIntegrations() {
  if (_unifiedInited) return;
  _unifiedInited = true;

  const listEl = el('unified-integrations-list');
  const formEl = el('unified-intg-form');
  const addBtn = el('unified-intg-add-btn');
  if (!listEl) return;
  let integrationNotice = '';

  async function fetchAll() {
    const [apiRes, mcpRes, tokenRes, sqlRes] = await Promise.all([
      fetch('/api/auth/integrations', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { integrations: [] }).catch(() => ({ integrations: [] })),
      fetch('/api/mcp/servers', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/tokens', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/sql/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    const items = [];
    // API integrations
    for (const intg of (apiRes.integrations || [])) {
      items.push({ type: 'api', id: intg.id, name: intg.name || 'Unnamed', detail: intg.base_url || '', enabled: intg.enabled !== false, data: intg });
    }
    // MCP servers
    const mcpList = Array.isArray(mcpRes) ? mcpRes : (mcpRes.servers || []);
    for (const srv of mcpList) {
      const statusText = srv.needs_oauth ? 'needs auth' : srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : srv.status === 'error' ? 'error' : 'disconnected';
      items.push({ type: 'mcp', id: srv.id || srv.name, name: srv.name || 'MCP Server', detail: statusText, enabled: srv.is_enabled !== false, data: srv });
    }
    if (sqlRes && (sqlRes.enabled || sqlRes.host || sqlRes.database)) {
      const detail = [sqlRes.db_type || 'sql', sqlRes.host, sqlRes.database].filter(Boolean).join(' - ');
      items.push({ type: 'sql', id: '__sql__', name: 'SQL Database', detail, enabled: !!sqlRes.enabled, data: sqlRes });
    }
    for (const tok of (Array.isArray(tokenRes) ? tokenRes : [])) {
      const scopes = tok.scopes || [];
      const lowerName = (tok.name || '').toLowerCase();
      let agentType = null;
      if (lowerName.startsWith('claude agent')) agentType = 'claude';
      else if (lowerName.startsWith('codex agent')) agentType = 'codex';
      else if (scopes.some(s => String(s || '').startsWith('todos:') || String(s || '').startsWith('email:') || String(s || '').startsWith('documents:'))) {
        // Legacy / un-prefixed scoped tokens fall back to Codex for backwards compat.
        agentType = 'codex';
      }
      if (!agentType) continue;
      const detail = `${tok.token_prefix || 'token'}... - ${scopes.join(', ') || 'chat'}`;
      items.push({ type: agentType, id: tok.id, name: tok.name || (agentType === 'claude' ? 'Claude Agent' : 'Codex Agent'), detail, enabled: true, data: tok });
    }
    // Vaultwarden removed as an integration option.
    return items;
  }

  function renderCard(item) {
    const t = INTG_TYPES[item.type] || INTG_TYPES.api;
    // Static enabled/disabled indicator — same dot every integration
    // type gets. (The clickable glow-on-test variant for email was
    // removed earlier; this matches the API/CalDAV/MCP pattern.)
    const statusDot = item.enabled
      ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--color-success,#50fa7b);flex-shrink:0;--notif-glow:var(--color-success,#50fa7b);animation:cookbook-notif-pulse 2s ease-in-out infinite;" title="Active"></span>'
      : '<span style="width:8px;height:8px;border-radius:50%;background:var(--fg);opacity:0.3;flex-shrink:0" title="Disabled"></span>';
    return `<div class="intg-card" data-intg-id="${item.id}" data-intg-type="${item.type}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb, var(--fg) 3%, transparent);margin-bottom:6px;cursor:pointer;transition:all 0.15s;" title="Click to edit">
      <span style="opacity:0.6;flex-shrink:0">${t.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px">${item.name} <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 5px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 50%, transparent);border-radius:3px;color:var(--accent, var(--red));background:color-mix(in srgb, var(--accent, var(--red)) 12%, transparent);">${t.label}</span></div>
        <div style="font-size:11px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.detail || ''}</div>
      </div>
      ${statusDot}
      <button class="admin-btn-sm intg-del-btn" data-intg-id="${item.id}" data-intg-type="${item.type}" title="Remove" style="background:none;border:none;padding:4px;cursor:pointer;color:var(--red);opacity:0.55;display:inline-flex;align-items:center;justify-content:center;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>`;
  }

  async function renderList() {
    const items = await fetchAll();
    const noticeHtml = integrationNotice ? `
      <div class="intg-followup-note" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:8px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 35%, transparent);border-left:3px solid var(--accent, var(--red));border-radius:5px;background:color-mix(in srgb, var(--accent, var(--red)) 8%, transparent);font-size:11px;">
        <span style="flex:1;line-height:1.35">${integrationNotice}</span>
      </div>` : '';
    if (items.length === 0) {
      listEl.innerHTML = noticeHtml + '<div style="padding:12px;opacity:0.5;font-size:12px;text-align:center">No integrations configured</div>';
    } else {
      listEl.innerHTML = noticeHtml + items.map(renderCard).join('');
    }
    // Wire edit clicks
    listEl.querySelectorAll('.intg-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.intg-del-btn')) return;
        const type = card.dataset.intgType;
        const id = card.dataset.intgId;
        const items2 = listEl.querySelectorAll('.intg-card');
        items2.forEach(c => c.style.borderColor = '');
        card.style.borderColor = 'var(--accent)';
        showForm(type, id);
      });
    });
    // Wire delete
    listEl.querySelectorAll('.intg-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await window.styledConfirm('Remove this integration?', { confirmText: 'Remove', danger: true })) return;
        const type = btn.dataset.intgType;
        const id = btn.dataset.intgId;
        try {
          if (type === 'api') await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'sql') await fetch('/api/sql/config', { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'mcp') await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'codex' || type === 'claude') await fetch(`/api/tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' });
        } catch (_) {}
        formEl.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      });
    });
  }

  function showForm(type, editId) {
    formEl.style.display = '';
    if (type === 'api') showApiForm(editId);
    else if (type === 'sql') showSqlForm();
    else if (type === 'mcp') showMcpForm(editId);
    else if (type === 'codex') showAgentForm('codex', editId);
    else if (type === 'claude') showAgentForm('claude', editId);
  }

  // ── API form ──
  async function showApiForm(editId) {
    let presets = {};
    try {
      const r = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
      if (r.ok) { const d = await r.json(); presets = d.presets || {}; }
    } catch (_) {}
    const presetEntries = Object.entries(presets);
    // Same `?` hint helper as the email form. Native title tooltip,
    // tabbable for keyboard users. Inline-styled so it doesn't need
    // a CSS dependency.
    const _apiHint = (tip) =>
      `<span class="uf-hint" title="${esc(tip.replace(/<[^>]+>/g, ''))}" aria-label="${esc(tip.replace(/<[^>]+>/g, ''))}" tabindex="0" `
      + `style="display:inline-block;width:13px;height:13px;border-radius:50%;`
      + `border:1px solid currentColor;font-size:9px;line-height:11px;text-align:center;`
      + `opacity:0.45;margin-left:5px;cursor:help;vertical-align:1px;font-weight:600;">?</span>`;
    // Real <select> instead of <datalist>: datalists are silently
    // suppressed in Firefox when autocomplete="off" is on the input,
    // and they're patchy on mobile browsers. A native select renders
    // the same everywhere and makes the available options visible
    // without needing the user to type.
    const sortedPresets = presetEntries.sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    const selectOpts = sortedPresets
      .map(([k, p]) => `<option value="${k}">${esc(p.name || k)}</option>`)
      .join('');
    // Letter-in-brand-color logo for each API preset; outline plug icon for
    // "Custom (no preset)". Matches the email-provider dropdown pattern.
    const _apiLetter = (letter, bg) => `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="11" fill="${bg}"/><text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${letter}</text></svg>`;
    const _apiCustomIco = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const API_PRESET_LOGO = {
      miniflux:        _apiLetter('M', '#214c87'),
      gitea:           _apiLetter('G', '#609926'),
      linkding:        _apiLetter('L', '#1f2937'),
      home_assistant:  _apiLetter('H', '#41bdf5'),
      ntfy:            _apiLetter('n', '#317f43'),
      vaultwarden:     _apiLetter('V', '#175ddc'),
      freshrss:        _apiLetter('R', '#ef6c00'),
    };
    const _apiIconFor = (k) => {
      if (!k) return _apiCustomIco;
      if (API_PRESET_LOGO[k]) return API_PRESET_LOGO[k];
      const first = (presets[k]?.name || k).trim().charAt(0).toUpperCase() || '?';
      return _apiLetter(first, '#6b7280');
    };
    const _apiRows = [['', 'Custom (no preset)'], ...sortedPresets.map(([k, p]) => [k, p.name || k])]
      .map(([k, label]) => `<button type="button" class="ufapi-option" data-value="${esc(k)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;">${_apiIconFor(k)}<span>${esc(label)}</span></button>`).join('');
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>API Integration</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Preset</label>
            <div style="position:relative;flex:1;min-width:0;">
              <select id="uf-api-preset" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;"><option value="">Custom (no preset)</option>${selectOpts}</select>
              <button type="button" id="uf-api-preset-trigger" class="settings-select" style="display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;width:100%;padding-right:24px;position:relative;">
                <span class="ufapi-icon" style="display:inline-flex;align-items:center;">${_apiCustomIco}</span>
                <span class="ufapi-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Custom (no preset)</span>
                <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:10px;pointer-events:none;">▾</span>
              </button>
              <div id="uf-api-preset-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);">${_apiRows}</div>
            </div>
          </div>
          <div class="settings-row"><label class="settings-label">Name</label><input id="uf-api-name" class="settings-input" placeholder="My Service"></div>
          <div class="settings-row"><label class="settings-label">Base URL</label><input id="uf-api-url" class="settings-input" placeholder="http://localhost:8080"></div>
          <div id="uf-api-ntfy-hint" style="display:none;font-size:11px;line-height:1.35;opacity:0.68;margin:-2px 0 2px 106px;"></div>
          <div class="settings-row"><label class="settings-label">Auth${_apiHint('How this service expects the credential to be sent. <b>Bearer</b> = sends "Authorization: Bearer YOUR_KEY" (most modern APIs, ntfy, OpenAI-style). <b>Header</b> = sends YOUR_KEY verbatim under a header name you choose (Miniflux uses X-Auth-Token). <b>Basic</b> = HTTP basic auth (user:pass). <b>None</b> = the API is open / no auth.')}</label><select id="uf-api-auth" class="settings-input"><option value="bearer">Bearer (most common)</option><option value="header">Header</option><option value="basic">Basic</option><option value="none">None</option></select></div>
          <div class="settings-row" id="uf-api-header-row"><label class="settings-label">Header${_apiHint('The HTTP header name the key goes under (Miniflux: X-Auth-Token; most others: Authorization). Only used when Auth = Header.')}</label><input id="uf-api-header" class="settings-input" placeholder="X-Auth-Token"></div>
          <div class="settings-row"><label class="settings-label">API Key${_apiHint('The secret token the service issued you (generated in its admin panel / settings). Used to prove your identity on each request. Required for any Auth mode except None.')}</label><input id="uf-api-key" class="settings-input" type="password" placeholder="Token/key"></div>
          <div class="settings-row" style="margin-top:4px"><button class="admin-btn-sm" id="uf-api-save">Save</button><button class="admin-btn-sm" id="uf-api-test" style="opacity:0.7">Test</button><button class="admin-btn-sm" id="uf-api-cancel" style="opacity:0.7">Cancel</button><span id="uf-api-msg" style="font-size:11px"></span></div>
        </div>
      </div>`;
    // Custom preset dropdown wire-up (hidden select stays as data source).
    (() => {
      const trig = el('uf-api-preset-trigger');
      const menu = el('uf-api-preset-menu');
      const sel = el('uf-api-preset');
      if (!trig || !menu || !sel) return;
      const lbl = trig.querySelector('.ufapi-label');
      const ico = trig.querySelector('.ufapi-icon');
      const _setFromKey = (k) => {
        const row = menu.querySelector(`.ufapi-option[data-value="${k}"]`);
        const text = row?.querySelector('span')?.textContent || 'Custom (no preset)';
        if (lbl) lbl.textContent = text;
        if (ico) ico.innerHTML = _apiIconFor(k);
      };
      const _close = () => { menu.style.display = 'none'; };
      const _open = () => {
        menu.style.display = 'block';
        const tRect = trig.getBoundingClientRect();
        const mRect = menu.getBoundingClientRect();
        const below = window.innerHeight - tRect.bottom;
        const above = tRect.top;
        if (mRect.height > below && above > below) { menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)'; }
        else { menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto'; }
        const onDoc = (ev) => { if (!menu.contains(ev.target) && ev.target !== trig) { _close(); document.removeEventListener('click', onDoc, true); } };
        setTimeout(() => document.addEventListener('click', onDoc, true), 0);
      };
      trig.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display === 'block' ? _close() : _open(); });
      menu.querySelectorAll('.ufapi-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.value || '';
          sel.value = k;
          _setFromKey(k);
          _close();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      _setFromKey(sel.value || '');
    })();

    const preset = el('uf-api-preset'), name = el('uf-api-name'), url = el('uf-api-url'), auth = el('uf-api-auth'), header = el('uf-api-header'), key = el('uf-api-key'), ntfyHint = el('uf-api-ntfy-hint');
    let _editId = editId && editId !== 'new' ? editId : null;
    // Load existing
    if (_editId) {
      try {
        const r = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
        const d = await r.json();
        const item = (d.integrations || []).find(i => i.id === _editId);
        if (item) { name.value = item.name || ''; url.value = item.base_url || ''; auth.value = item.auth_type || 'none'; header.value = item.auth_header || ''; }
      } catch (_) {}
    }
    // Native <select>: the option `value` is the preset key directly, so
    // no typed-name → key lookup is needed (datalist-era leftover).
    const _applyPreset = () => {
      const p = presets[preset.value];
      const isNtfy = preset.value === 'ntfy' || (p && (p.name || '').toLowerCase() === 'ntfy');
      if (ntfyHint) {
        ntfyHint.style.display = isNtfy ? 'block' : 'none';
        if (isNtfy) {
          ntfyHint.innerHTML = 'Enter the ntfy server URL Talos can reach. Examples: <code>http://127.0.0.1:8091</code>, <code>http://100.x.y.z:8091</code>, or <code>https://ntfy.example.com</code>.';
        }
      }
      if (url) {
        url.placeholder = isNtfy ? 'http://127.0.0.1:8091' : 'http://localhost:8080';
      }
      if (!p) return;
      name.value = p.name || '';
      auth.value = p.auth_type || 'none';
      header.value = p.auth_header || '';
    };
    preset.addEventListener('change', _applyPreset);
    _applyPreset();
    el('uf-api-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-api-save').addEventListener('click', async () => {
      const presetKey = preset.value || undefined;
      const body = { name: name.value, base_url: url.value, auth_type: auth.value, auth_header: header.value, preset: presetKey };
      if (key.value) body.api_key = key.value;
      try {
        const u = _editId ? `/api/auth/integrations/${_editId}` : '/api/auth/integrations';
        const m = _editId ? 'PUT' : 'POST';
        const r = await fetch(u, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error();
        const saved = await r.json().catch(() => null);
        // If this was a create, capture the new ID so Test works
        // immediately without needing a form reopen. The POST response
        // shape is {ok, integration: {id, ...}} — saved.id at the top
        // level would silently miss, leaving Test perpetually stuck on
        // "Save first" until the form was reopened.
        if (!_editId && saved) _editId = saved.integration?.id || saved.id;
        el('uf-api-msg').textContent = 'Saved'; el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) { el('uf-api-msg').textContent = 'Failed'; el('uf-api-msg').style.color = 'var(--red)'; }
    });
    el('uf-api-test').addEventListener('click', async () => {
      if (!_editId) { el('uf-api-msg').textContent = 'Save first'; return; }
      try {
        const r = await fetch(`/api/auth/integrations/${_editId}/test`, { method: 'POST', credentials: 'same-origin' });
        const d = await r.json();
        // Backend returns {ok: bool, message: str}
        if (d.ok) {
          el('uf-api-msg').textContent = d.message || 'Connected';
          el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        } else {
          el('uf-api-msg').textContent = (d.message || d.error || d.detail || `HTTP ${r.status}`).slice(0, 360);
          el('uf-api-msg').style.color = 'var(--red)';
        }
      } catch (e) { el('uf-api-msg').textContent = 'Error: ' + e.message; el('uf-api-msg').style.color = 'var(--red)'; }
    });
  }


  // ── MCP form — full management view ──
  async function showSqlForm() {
    let cfg = {};
    try {
      const r = await fetch('/api/sql/config', { credentials: 'same-origin' });
      if (r.ok) cfg = await r.json();
    } catch (_) {}
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">SQL Database</h2>
        <div style="font-size:11px;opacity:0.65;line-height:1.45;margin:-2px 0 8px;">Configure the read-only SQL database used by the <code>query_sql</code> tool. The password is stored server-side and never shown to the model.</div>
        <div class="settings-col">
          <label class="settings-row" style="align-items:center"><span class="settings-label">Enabled</span><label class="admin-switch"><input id="uf-sql-enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}><span class="admin-slider"></span></label></label>
          <div class="settings-row"><label class="settings-label">Type</label><select id="uf-sql-type" class="settings-input"><option value="mssql">MSSQL</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL/MariaDB</option><option value="sqlite">SQLite</option></select></div>
          <div class="settings-row"><label class="settings-label">Host</label><input id="uf-sql-host" class="settings-input" value="${esc(cfg.host || '')}" placeholder="db.example.local"></div>
          <div class="settings-row"><label class="settings-label">Port</label><input id="uf-sql-port" class="settings-input" value="${esc(cfg.port || '')}" placeholder="1433"></div>
          <div class="settings-row"><label class="settings-label">Database</label><input id="uf-sql-db" class="settings-input" value="${esc(cfg.database || '')}" placeholder="Database name or SQLite path"></div>
          <div class="settings-row"><label class="settings-label">Read-only user</label><input id="uf-sql-user" class="settings-input" value="${esc(cfg.username || '')}" autocomplete="off"></div>
          <div class="settings-row"><label class="settings-label">Password</label><input id="uf-sql-pass" class="settings-input" type="password" autocomplete="new-password" placeholder="${cfg.password_set ? 'Saved - leave blank to keep' : ''}"></div>
          <div class="settings-row"><label class="settings-label">ODBC driver</label><input id="uf-sql-driver" class="settings-input" value="${esc(cfg.odbc_driver || '')}" placeholder="ODBC Driver 18 for SQL Server"></div>
          <div class="settings-row" style="margin-top:4px"><button class="admin-btn-sm" id="uf-sql-save">Save</button><button class="admin-btn-sm" id="uf-sql-test">Test</button><button class="admin-btn-sm" id="uf-sql-cancel" style="opacity:0.7">Cancel</button><span id="uf-sql-msg" style="font-size:11px"></span></div>
        </div>
      </div>`;
    const typeEl = el('uf-sql-type');
    if (typeEl) typeEl.value = cfg.db_type || 'mssql';
    const defaultPort = () => {
      const type = el('uf-sql-type')?.value || 'mssql';
      const port = el('uf-sql-port');
      if (!port || port.value) return;
      port.placeholder = type === 'postgresql' ? '5432' : type === 'mysql' ? '3306' : type === 'mssql' ? '1433' : '';
    };
    defaultPort();
    typeEl?.addEventListener('change', defaultPort);
    el('uf-sql-cancel')?.addEventListener('click', () => { formEl.style.display = 'none'; });
    const payload = () => ({
      enabled: !!el('uf-sql-enabled')?.checked,
      db_type: el('uf-sql-type')?.value || 'mssql',
      host: el('uf-sql-host')?.value || '',
      port: el('uf-sql-port')?.value || '',
      database: el('uf-sql-db')?.value || '',
      username: el('uf-sql-user')?.value || '',
      password: el('uf-sql-pass')?.value || '',
      odbc_driver: el('uf-sql-driver')?.value || '',
    });
    const save = async () => {
      const msg = el('uf-sql-msg');
      if (msg) msg.textContent = 'Saving...';
      const r = await fetch('/api/sql/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || 'Save failed');
      if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
      notifyIntegrationsChanged();
      await renderList();
    };
    el('uf-sql-save')?.addEventListener('click', async () => {
      try { await save(); } catch (err) { const msg = el('uf-sql-msg'); if (msg) { msg.textContent = err?.message || 'Failed'; msg.style.color = 'var(--red)'; } }
    });
    el('uf-sql-test')?.addEventListener('click', async () => {
      const msg = el('uf-sql-msg');
      try {
        await save();
        if (msg) { msg.textContent = 'Testing...'; msg.style.color = ''; }
        const r = await fetch('/api/sql/test', { method: 'POST', credentials: 'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (!d.ok) throw new Error(d.error || 'Connection failed');
        if (msg) { msg.textContent = 'Connection OK'; msg.style.color = 'var(--green, #50fa7b)'; }
      } catch (err) {
        if (msg) { msg.textContent = err?.message || 'Failed'; msg.style.color = 'var(--red)'; }
      }
    });
  }

  async function showMcpForm(editId) {
    // Toggle an in-flight loading state on a button (disabled + dimmed + label).
    function _setBtnLoading(btn, loading, label) {
      if (!btn) return;
      btn.disabled = loading;
      btn.style.opacity = loading ? '0.6' : '';
      btn.style.cursor = loading ? 'progress' : '';
      if (label != null) btn.textContent = label;
    }
    function _showMcpPasteback(id) {
      const msg = el('uf-mcp-msg'); if (!msg) return;
      if (el('uf-mcp-pasteback')) return;  // already shown
      msg.innerHTML =
        'Authorize in the opened tab. If the redirect fails (remote access), paste the resulting URL here: ' +
        '<input id="uf-mcp-pasteback" class="settings-input" placeholder="http://localhost:7000/api/mcp/oauth/callback?code=..." style="margin-top:4px">' +
        '<button class="admin-btn-sm" id="uf-mcp-paste-go" style="margin-top:4px">Submit</button>';
      const pasteGo = el('uf-mcp-paste-go');
      if (pasteGo) pasteGo.addEventListener('click', async () => {
        const cb = el('uf-mcp-pasteback').value.trim();
        if (!cb) return;
        const pf = new FormData(); pf.append('callback_url', cb);
        _setBtnLoading(pasteGo, true, 'Submitting…');
        try {
          await fetch(`/api/mcp/oauth/exchange/${id}`, { method: 'POST', credentials: 'same-origin', body: pf });
        } finally {
          _setBtnLoading(pasteGo, false, 'Submit');
        }
      });
    }

    // Drives the OAuth flow: waits for the auth_url (discovery+DCR may lag),
    // opens it once, then resolves on connected/error.
    async function _handleMcpAuth(id, initialAuthUrl, tries = 90) {
      let opened = false;
      const openAuth = (u) => { if (!opened && u) { opened = true; window.open(u, '_blank', 'noopener'); _showMcpPasteback(id); } };
      openAuth(initialAuthUrl);
      const msg = el('uf-mcp-msg');
      let fails = 0;
      for (let i = 0; i < tries; i++) {
        await new Promise(res => setTimeout(res, 2000));
        try {
          const r = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const list = await r.json();
          fails = 0;
          const s = Array.isArray(list) ? list.find(x => x.id === id) : null;
          if (!s) continue;
          if (s.auth_url) openAuth(s.auth_url);
          if (s.status === 'connected') {
            if (msg) msg.textContent = `Connected (${s.tool_count || 0} tools)`;
            await renderList(); return;
          }
          if (s.status === 'error') {
            if (msg) msg.textContent = `Failed: ${s.error || 'unknown'}`; return;
          }
        } catch (e) {
          // Tolerate a single blip, but surface persistent failures instead of
          // silently polling until timeout.
          if (++fails >= 5 && msg) msg.textContent = `Status check failing (${e.message || 'network error'}) — still retrying…`;
        }
      }
      if (msg) msg.textContent = 'Authorization timed out. Reconnect from the server list to retry.';
    }
    if (editId && editId !== 'new') {
      // Show management view for existing server
      formEl.innerHTML = '<div class="admin-card" style="margin-top:8px"><span style="opacity:0.5;font-size:11px">Loading...</span></div>';
      try {
        const res = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
        const servers = await res.json();
        const srv = servers.find(s => (s.id || s.name) === editId);
        if (!srv) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Server not found</div>'; return; }
        const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
        const statusColor = srv.needs_oauth ? '#e5a33a' : srv.status === 'connected' ? 'var(--green,#50fa7b)' : srv.status === 'error' ? 'var(--red)' : 'var(--fg)';
        const toolInfo = srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : '';
        const statusText = srv.needs_oauth ? 'Needs authorization' : srv.status === 'connected' ? `Connected (${toolInfo})` : srv.status === 'error' ? `Error: ${esc(srv.error || 'unknown')}` : 'Disconnected';
        formEl.innerHTML = `
          <div class="admin-card" style="margin-top:8px">
            <h2 style="font-size:13px">${esc(srv.name)}</h2>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor}"></span>
              <span style="font-size:11px;opacity:0.7">${statusText}</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              ${srv.needs_oauth ? `<a href="/api/mcp/oauth/authorize/${srv.id}" target="_blank" class="admin-btn-sm" style="background:var(--red);color:#fff;text-decoration:none">Authorize</a>` : ''}
              <button class="admin-btn-sm" id="uf-mcp-reconnect">Reconnect</button>
              <button class="admin-btn-sm" id="uf-mcp-toggle">${srv.is_enabled ? 'Disable' : 'Enable'}</button>
              <button class="admin-btn-sm" id="uf-mcp-cancel" style="opacity:0.7">Close</button>
              <span id="uf-mcp-msg" style="font-size:11px"></span>
            </div>
            <div id="uf-mcp-tools-panel"></div>
          </div>`;
        // Reconnect
        el('uf-mcp-reconnect').addEventListener('click', async () => {
          const msg = el('uf-mcp-msg'); msg.textContent = 'Reconnecting...';
          try {
            const r = await fetch(`/api/mcp/servers/${srv.id}/reconnect`, { method: 'POST', credentials: 'same-origin' });
            const d = await r.json();
            msg.textContent = d.connected ? `Connected (${d.tool_count} tools)` : `Failed: ${d.error || 'unknown'}`;
            await renderList();
            showMcpForm(editId); // refresh this view
          } catch (e) { msg.textContent = 'Failed'; }
        });
        // Toggle enable/disable
        el('uf-mcp-toggle').addEventListener('click', async () => {
          const fd = new FormData(); fd.append('is_enabled', String(!srv.is_enabled));
          await fetch(`/api/mcp/servers/${srv.id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
          await renderList();
          showMcpForm(editId);
        });
        el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
        // Load tools list
        if (srv.status === 'connected' && srv.tool_count > 0) {
          const panel = el('uf-mcp-tools-panel');
          try {
            const tr = await fetch(`/api/mcp/servers/${srv.id}/tools`, { credentials: 'same-origin' });
            const tools = await tr.json();
            if (tools.length) {
              const disabled = new Set(tools.filter(t => t.is_disabled).map(t => t.name));
              panel.innerHTML = `<div class="mcp-tools-header"><span>Tools</span><span style="display:flex;gap:8px;align-items:center"><span class="mcp-tools-count">${tools.length - disabled.size}/${tools.length} enabled</span><a href="#" id="uf-mcp-all">All</a> <a href="#" id="uf-mcp-none">None</a></span></div><div class="mcp-tools-list">${tools.map(t => `<label title="${esc(t.description)}"><input type="checkbox" data-mcp-tool-name="${esc(t.name)}" ${!t.is_disabled ? 'checked' : ''}><span><strong>${esc(t.name)}</strong> <span style="opacity:0.5">— ${esc((t.description||'').slice(0,80))}</span></span></label>`).join('')}</div>`;
              const saveFn = async () => {
                const dis = [];
                panel.querySelectorAll('input[type=checkbox]').forEach(cb => { if (!cb.checked) dis.push(cb.dataset.mcpToolName); });
                await fetch(`/api/mcp/servers/${srv.id}/tools`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ disabled: dis }) });
                const cnt = panel.querySelector('.mcp-tools-count');
                if (cnt) cnt.textContent = `${tools.length - dis.length}/${tools.length} enabled`;
              };
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', saveFn));
              el('uf-mcp-all')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); saveFn(); });
              el('uf-mcp-none')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); saveFn(); });
            }
          } catch (_) { panel.innerHTML = '<span style="opacity:0.5;font-size:11px">Failed to load tools</span>'; }
        }
      } catch (_) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Failed to load server</div>'; }
    } else {
      // Add new MCP server form
      formEl.innerHTML = `
        <div class="admin-card" style="margin-top:8px">
          <h2 style="font-size:13px">Add MCP Server</h2>
          <div class="settings-col">
            <div class="settings-row"><label class="settings-label">Name</label><input id="uf-mcp-name" class="settings-input" placeholder="Server name"></div>
            <div class="settings-row"><label class="settings-label">Transport</label><select id="uf-mcp-transport" class="settings-input"><option value="stdio">stdio</option><option value="sse">SSE</option><option value="http">Streamable HTTP</option></select></div>
            <div id="uf-mcp-stdio-fields" style="display:flex;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">Command</label><input id="uf-mcp-cmd" class="settings-input" placeholder="npx"></div>
              <div class="settings-row"><label class="settings-label">Args</label><input id="uf-mcp-args" class="settings-input" placeholder='["-y", "@modelcontextprotocol/server-filesystem"]'></div>
              <div class="settings-row"><label class="settings-label">Env</label><input id="uf-mcp-env" class="settings-input" placeholder='{"KEY": "value"}'></div>
            </div>
            <div id="uf-mcp-sse-fields" style="display:none;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">URL</label><input id="uf-mcp-url" class="settings-input" placeholder="http://localhost:3001/sse"></div>
            </div>
            <div class="settings-row" style="margin-top:4px"><button class="admin-btn-sm" id="uf-mcp-save">Save</button><button class="admin-btn-sm" id="uf-mcp-cancel" style="opacity:0.7">Cancel</button><span id="uf-mcp-msg" style="font-size:11px"></span></div>
          </div>
        </div>`;
      el('uf-mcp-transport').addEventListener('change', () => {
        const v = el('uf-mcp-transport').value;
        const isUrl = (v === 'sse' || v === 'http');
        el('uf-mcp-stdio-fields').style.display = isUrl ? 'none' : 'flex';
        el('uf-mcp-sse-fields').style.display = isUrl ? 'flex' : 'none';
        const urlInput = el('uf-mcp-url');
        if (urlInput) urlInput.placeholder = (v === 'http') ? 'https://mcp.example.com/mcp' : 'http://localhost:3001/sse';
      });
      el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
      el('uf-mcp-save').addEventListener('click', async () => {
        const transport = el('uf-mcp-transport').value;
        // routes/mcp_routes.py uses FastAPI Form(...) — send multipart, not JSON.
        const fd = new FormData();
        fd.append('name', el('uf-mcp-name').value);
        fd.append('transport', transport);
        if (transport === 'stdio') {
          fd.append('command', el('uf-mcp-cmd').value);
          let args = '[]'; try { args = JSON.stringify(JSON.parse(el('uf-mcp-args').value || '[]')); } catch (_) {}
          let env  = '{}'; try { env  = JSON.stringify(JSON.parse(el('uf-mcp-env').value  || '{}')); } catch (_) {}
          fd.append('args', args);
          fd.append('env', env);
        } else {
          fd.append('url', el('uf-mcp-url').value);
        }
        const saveBtn = el('uf-mcp-save'), cancelBtn = el('uf-mcp-cancel');
        const _origLabel = saveBtn.textContent;
        _setBtnLoading(saveBtn, true, 'Saving…'); if (cancelBtn) cancelBtn.disabled = true;
        try {
          const r = await fetch('/api/mcp/servers', { method: 'POST', credentials: 'same-origin', body: fd });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.needs_auth) {
            el('uf-mcp-msg').textContent = 'Preparing authorization…';
            _handleMcpAuth(data.id, data.auth_url);
          } else if (r.ok && (data.connected || data.status === 'connected')) {
            el('uf-mcp-msg').textContent = `Connected (${data.tool_count || 0} tools)`;
            formEl.style.display = 'none'; await renderList();
          } else if (r.ok) {
            el('uf-mcp-msg').textContent = 'Saved'; formEl.style.display = 'none'; await renderList();
          } else {
            el('uf-mcp-msg').textContent = `Failed (${r.status})`;
          }
        } catch (_) { el('uf-mcp-msg').textContent = 'Failed'; }
        finally { _setBtnLoading(saveBtn, false, _origLabel); if (cancelBtn) cancelBtn.disabled = false; }
      });
    }
  }

  async function showAgentForm(kind, editId) {
    const cfg = AGENT_CONFIGS[kind] || AGENT_CONFIGS.codex;
    let tokens = [];
    try {
      const tokRes = await fetch('/api/tokens', { credentials: 'same-origin' });
      if (tokRes.ok) tokens = await tokRes.json();
    } catch (_) {}

    const toolScopes = [
      { key: 'todos:read', label: 'Todos', detail: 'Read notes and checklists' },
      { key: 'todos:write', label: 'Todos write', detail: 'Create, update, delete, and toggle todo items' },
      { key: 'documents:read', label: 'Documents', detail: 'Read documents when a document API is enabled' },
      { key: 'documents:write', label: 'Documents write', detail: 'Create and update draft documents' },
      { key: 'email:read', label: 'Email', detail: 'Read email when an email API is enabled' },
      { key: 'email:draft', label: 'Email drafts', detail: 'Create email reply drafts without sending' },
      { key: 'email:send', label: 'Email send', detail: 'Send email directly' },
      { key: 'calendar:read', label: 'Calendar', detail: 'Read calendar events when enabled' },
      { key: 'calendar:write', label: 'Calendar write', detail: 'Create and update calendar events' },
      { key: 'memory:read', label: 'Memory', detail: 'Read memory when enabled' },
      { key: 'memory:write', label: 'Memory write', detail: 'Write memory when enabled' },
      { key: 'cookbook:read', label: 'Cookbook', detail: 'List cookbook tasks + tail their tmux output (debug a model serve from outside the UI)' },
      { key: 'cookbook:launch', label: 'Cookbook launch', detail: 'Launch and stop cookbook serve tasks. Powerful: runs SSH commands on your configured servers, bounded by the same allowlist the UI uses (vllm/python3/sglang/llama-server/...)' },
    ];
    // Strict name-prefix match keeps Codex and Claude tokens in their own forms.
    const agentTokens = (Array.isArray(tokens) ? tokens : []).filter(tok =>
      (tok.name || '').toLowerCase().startsWith(cfg.namePrefix)
    );
    const current = agentTokens.find(t => String(t.id) === String(editId));
    const _scopeIcons = {
      todos: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      documents: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      email: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2 6 12 13 22 6"/></svg>',
      calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 2 9.5v3A2.5 2.5 0 0 0 4.5 15a2.5 2.5 0 0 0 2.5 2.5A2.5 2.5 0 0 0 9.5 20H10V2z"/><path d="M14.5 2a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 22 9.5v3A2.5 2.5 0 0 1 19.5 15a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 14.5 20H14V2z"/></svg>',
      cookbook: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    };
    const _scopeNiceLabel = (label) => label.replace(/\s+(write|drafts?|send)$/i, '');
    const _scopeAction = (key) => (key.split(':')[1] || '').toLowerCase();
    const _pillStyle = (action) => {
      if (action === 'read') return 'background:rgba(150,150,150,0.18);color:var(--fg-muted,#888);';
      return 'background:color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);color:var(--accent, var(--red));';
    };
    const scopeToggles = (t) => {
      const scopes = new Set(t.scopes || []);
      return toolScopes.map(scope => {
        const tool = scope.key.split(':')[0];
        const action = _scopeAction(scope.key);
        const icon = _scopeIcons[tool] || '';
        const niceLabel = _scopeNiceLabel(scope.label);
        return `
        <label class="settings-row" style="align-items:center;gap:8px;display:flex;min-height:30px;padding:2px 0;">
          <span style="opacity:0.7;display:inline-flex;align-items:center;justify-content:center;width:16px;flex-shrink:0;">${icon}</span>
          <span class="settings-label" style="width:75px;flex-shrink:0;padding:0;">${esc(niceLabel)}</span>
          <span style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:1px 7px;border-radius:999px;flex-shrink:0;min-width:44px;text-align:center;margin-left:-3px;box-sizing:border-box;${_pillStyle(action)}">${esc(action)}</span>
          <span style="font-size:11px;line-height:1.35;opacity:0.62;flex:1;min-width:0;">${esc(scope.detail)}</span>
          <label class="admin-switch" style="margin-left:auto;flex-shrink:0;"><input type="checkbox" class="uf-codex-scope" data-token-id="${esc(t.id)}" data-scope="${esc(scope.key)}" ${scopes.has(scope.key) ? 'checked' : ''}><span class="admin-slider"></span></label>
        </label>`;
      }).join('');
    };
    const tokenRows = agentTokens.length ? agentTokens.map(t => `
      <div class="uf-codex-token" data-token-id="${esc(t.id)}" style="border:1px solid var(--border);border-radius:6px;padding:9px 10px;margin-top:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="flex:1;min-width:0;">
            <input type="text" class="uf-codex-rename settings-input" data-token-id="${esc(t.id)}" value="${esc(t.name || cfg.defaultName)}" placeholder="${esc(cfg.defaultName)} (e.g. ${esc(cfg.word)} on laptop)" style="font-size:12px;font-weight:600;padding:3px 6px;width:100%;background:transparent;border:1px solid transparent;border-radius:4px;" title="Click to rename this agent">
            <div style="font-size:10px;opacity:0.52;margin-top:2px;">${esc(t.token_prefix || 'token')}...${t.last_used_at ? ` · Last used ${new Date(t.last_used_at).toLocaleDateString()}` : ' · Never used'}</div>
          </div>
          <button class="admin-btn-sm uf-codex-copy-prefix" data-token-prefix="${esc(t.token_prefix || '')}" title="Copy token prefix (full token only shown once, at creation)" style="opacity:0.7">Copy</button>
          <button class="admin-btn-delete uf-codex-revoke" data-token-id="${esc(t.id)}">Revoke</button>
        </div>
        <div style="font-size:11px;font-weight:600;opacity:0.62;margin-bottom:4px;">Tool access</div>
        ${scopeToggles(t)}
        <div class="uf-codex-scope-msg" data-token-id="${esc(t.id)}" style="font-size:11px;min-height:14px;"></div>
      </div>`).join('') : `<div style="opacity:0.45;font-size:11px;padding:8px 0;">No ${esc(cfg.word)} tokens yet.</div>`;
    const origin = window.location.origin || '';
    const setupForToken = (token) => cfg.buildSetup(origin, token);

    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">${esc(cfg.label)}</h2>
        <div style="font-size:11px;opacity:0.65;line-height:1.45;margin:-2px 0 8px;">Generates a scoped token + setup commands so ${esc(cfg.word)} on your own machine can read/write your Talos data (todos, email, calendar, etc.). The agent runs in your terminal — it isn't streamed inside Talos.</div>
        <div class="settings-col">
          <div id="uf-codex-pending" style="display:${current ? 'none' : 'block'};font-size:11px;opacity:0.6;padding:6px 0;">Creating agent...</div>
          <div id="uf-codex-reveal" style="display:none;padding:10px 12px;border:1px solid var(--border);border-left:3px solid var(--accent, var(--red));border-radius:6px;background:rgba(0,0,0,0.04);width:100%;box-sizing:border-box;">
            <div style="font-weight:600;font-size:12px;margin-bottom:6px;">${esc(cfg.word)} setup</div>

            <div style="font-size:11px;opacity:0.62;margin-bottom:4px;">Copy this token now &mdash; it will not be shown again.</div>
            <code id="uf-codex-token" style="display:block;word-break:break-all;font-size:11px;padding:6px 8px;background:rgba(0,0,0,0.08);border-radius:4px;"></code>
            <div style="margin-top:6px;">
              <button class="admin-btn-sm" id="uf-codex-copy-token">Copy token</button>
            </div>

            <div style="margin-top:14px;font-weight:600;font-size:11px;margin-bottom:4px;">Quickstart &mdash; or copy setup directly in your terminal</div>
            <div style="font-size:11px;opacity:0.62;margin-bottom:6px;">${cfg.setupDescription}</div>
            <pre style="margin:0;white-space:pre;overflow-x:auto;max-height:220px;overflow-y:auto;font-size:10px;line-height:1.45;padding:8px 10px;background:rgba(0,0,0,0.08);border-radius:4px;width:100%;box-sizing:border-box;"><code id="uf-codex-setup-code"></code></pre>
            <div style="margin-top:6px;">
              <button class="admin-btn-sm" id="uf-codex-copy-setup">Copy setup</button>
            </div>

            <div style="margin-top:14px;font-weight:600;font-size:11px;margin-bottom:4px;">Configure access</div>
            <div style="font-size:11px;opacity:0.62;margin-bottom:6px;">Toggle which Talos tools this agent can use. New agents start with chat only.</div>
            <div id="uf-codex-inline-scopes"></div>
          </div>
          <div style="font-size:11px;font-weight:600;opacity:0.62;margin-top:10px;">${agentTokens.length ? 'Existing agents' : 'Agents'}</div>
          <div id="uf-codex-token-list">${tokenRows}</div>
          <div class="settings-row" style="margin-top:10px;align-items:center;">
            <button class="admin-btn-add" id="uf-codex-save" style="background:var(--red);border-color:var(--red);color:#fff;display:inline-flex;align-items:center;gap:5px;font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Save
            </button>
            <span id="uf-codex-msg" style="font-size:11px;flex:1;margin-left:8px"></span>
            <button class="admin-btn-add" id="uf-codex-cancel" style="opacity:0.7;display:inline-flex;align-items:center;gap:5px;position:relative;top:1px;margin-left:auto;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
          </div>
        </div>
      </div>`;

    el('uf-codex-cancel')?.addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-codex-save')?.addEventListener('click', () => {
      const msg = el('uf-codex-msg');
      if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
      setTimeout(() => { formEl.style.display = 'none'; }, 350);
    });

    const _autoCreateCodex = async () => {
      const msg = el('uf-codex-msg');
      const pending = el('uf-codex-pending');
      const existingNames = new Set(agentTokens.map(t => (t.name || '').trim()));
      let name = cfg.defaultName;
      let n = 2;
      while (existingNames.has(name)) { name = `${cfg.defaultName} ${n++}`; }
      const fd = new FormData();
      fd.append('name', name);
      fd.append('scopes', 'chat');
      try {
        const r = await fetch('/api/tokens', { method: 'POST', credentials: 'same-origin', body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Failed');
        if (pending) pending.style.display = 'none';
        el('uf-codex-token').textContent = d.token || '';
        el('uf-codex-reveal').style.display = '';
        const setupBtn = el('uf-codex-copy-setup');
        if (setupBtn) setupBtn.dataset.token = d.token || '';
        const setupCode = el('uf-codex-setup-code');
        if (setupCode) setupCode.textContent = setupForToken(d.token || '');
        // Populate inline scope toggles for the just-created token (Configure access already open)
        const newToken = { id: d.id, name, scopes: d.scopes || ['chat'] };
        const inlineEl = el('uf-codex-inline-scopes');
        if (inlineEl) {
          inlineEl.innerHTML = `
            <div class="uf-codex-token" data-token-id="${esc(newToken.id)}">
              ${scopeToggles(newToken)}
              <div class="uf-codex-scope-msg" data-token-id="${esc(newToken.id)}" style="font-size:11px;min-height:14px;"></div>
            </div>`;
          _wireScopeChange(inlineEl);
        }
        if (msg) {
          msg.textContent = `Created "${name}".`;
          msg.style.color = 'var(--green, #50fa7b)';
        }
        await renderList();
      } catch (err) {
        if (pending) pending.style.display = 'none';
        if (msg) {
          msg.textContent = err?.message || 'Failed';
          msg.style.color = 'var(--red)';
        }
      }
    };
    if (!current) _autoCreateCodex();
    const _copyCodexToken = async (text) => {
      const value = String(text || '');
      if (!value) return false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch (_) {}
      }
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    };
    const _selectTextFallback = (text, containerId) => {
      const code = document.createElement('pre');
      code.textContent = text;
      code.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:10px;margin:6px 0 0;';
      el(containerId)?.appendChild(code);
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    el('uf-codex-copy-setup')?.addEventListener('click', async () => {
      const token = el('uf-codex-copy-setup')?.dataset.token || '';
      const btn = el('uf-codex-copy-setup');
      if (!token) {
        if (btn) {
          btn.textContent = 'Add agent first';
          setTimeout(() => { const latest = el('uf-codex-copy-setup'); if (latest) latest.textContent = 'Copy setup'; }, 1600);
        }
        return;
      }
      const setup = setupForToken(token);
      const ok = await _copyCodexToken(setup);
      if (!btn) return;
      btn.textContent = ok ? 'Copied setup' : 'Select setup';
      if (!ok) _selectTextFallback(setup, 'uf-codex-reveal');
      setTimeout(() => { const latest = el('uf-codex-copy-setup'); if (latest) latest.textContent = 'Copy setup'; }, 1600);
    });
    el('uf-codex-copy-token')?.addEventListener('click', async () => {
      const token = el('uf-codex-token')?.textContent || '';
      const ok = await _copyCodexToken(token);
      const btn = el('uf-codex-copy-token');
      if (!btn) return;
      btn.textContent = ok ? 'Copied token' : 'Select token';
      if (!ok) _selectTextFallback(token, 'uf-codex-reveal');
      setTimeout(() => { const latest = el('uf-codex-copy-token'); if (latest) latest.textContent = 'Copy token'; }, 1600);
    });
    formEl.querySelectorAll('.uf-codex-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await window.styledConfirm(`Revoke this ${cfg.word} token? Terminal agents using it will lose access.`, { confirmText: 'Revoke', danger: true })) return;
        await fetch(`/api/tokens/${btn.dataset.tokenId}`, { method: 'DELETE', credentials: 'same-origin' });
        formEl.style.display = 'none';
        await renderList();
      });
    });
    // Rename: PATCH the token's name when the user blurs the input (or hits Enter).
    formEl.querySelectorAll('.uf-codex-rename').forEach(input => {
      const original = input.value;
      const commit = async () => {
        const name = (input.value || '').trim();
        if (!name || name === original) return;
        try {
          const r = await fetch(`/api/tokens/${input.dataset.tokenId}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!r.ok) throw new Error('Save failed');
          input.style.borderColor = 'var(--green, #50fa7b)';
          setTimeout(() => { input.style.borderColor = 'transparent'; }, 800);
          await renderList();
        } catch (_) {
          input.value = original;
          input.style.borderColor = 'var(--red)';
          setTimeout(() => { input.style.borderColor = 'transparent'; }, 1200);
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });
    // Copy token prefix (full token irrecoverable after the one-time creation reveal).
    formEl.querySelectorAll('.uf-codex-copy-prefix').forEach(btn => {
      btn.addEventListener('click', async () => {
        const prefix = btn.dataset.tokenPrefix || '';
        if (!prefix) return;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(prefix);
          } else {
            const ta = document.createElement('textarea');
            ta.value = prefix;
            ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            ta.remove();
          }
          const label = btn.textContent;
          btn.textContent = 'Copied prefix';
          setTimeout(() => { btn.textContent = label; }, 1400);
        } catch (_) {}
      });
    });
    function _wireScopeChange(scope) {
      scope.querySelectorAll('.uf-codex-scope').forEach(cb => {
        if (cb.dataset.wired === '1') return;
        cb.dataset.wired = '1';
        cb.addEventListener('change', async () => {
          const tokenId = cb.dataset.tokenId;
          const panel = formEl.querySelector(`.uf-codex-token[data-token-id="${CSS.escape(tokenId)}"]`);
          const msg = formEl.querySelector(`.uf-codex-scope-msg[data-token-id="${CSS.escape(tokenId)}"]`);
          const scopes = Array.from(panel.querySelectorAll('.uf-codex-scope:checked')).map(input => input.dataset.scope);
          try {
            const r = await fetch(`/api/tokens/${tokenId}`, {
              method: 'PATCH',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scopes }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || 'Failed');
            if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
            await renderList();
          } catch (err) {
            cb.checked = !cb.checked;
            if (msg) { msg.textContent = err?.message || 'Failed'; msg.style.color = 'var(--red)'; }
          }
        });
      });
    }
    _wireScopeChange(formEl);
  }

  // ── Add button with type picker ──
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      formEl.style.display = '';
      const _typeOptions = [
        ['api', 'API Service'],
        ['claude', 'Claude Agent'],
        ['codex', 'Codex Agent'],
        ['sql', 'SQL Database'],
        ['mcp', 'MCP Tool Server'],
      ];
      const _iconFor = (k) => (INTG_TYPES[k]?.icon || '').replace(/width="14"/, 'width="16"').replace(/height="14"/, 'height="16"');
      const _rowsHtml = _typeOptions.map(([k, label]) => `<button type="button" class="uf-type-option" data-value="${k}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;"><span style="display:inline-flex;color:var(--accent, var(--red));flex-shrink:0;">${_iconFor(k)}</span><span>${esc(label)}</span></button>`).join('');
      formEl.innerHTML = `
        <div class="admin-card" style="margin-top:8px">
          <h2 style="font-size:13px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Add Integration</h2>
          <div class="settings-col">
            <div class="settings-row"><label class="settings-label">Type</label>
              <div style="position:relative;flex:1;min-width:0;">
                <button type="button" id="uf-type-trigger" class="settings-select" style="display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;width:100%;padding-right:24px;position:relative;">
                  <span class="uf-type-icon" style="display:inline-flex;color:var(--accent, var(--red));"></span>
                  <span class="uf-type-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.65;">Select...</span>
                  <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:10px;pointer-events:none;">▾</span>
                </button>
                <div id="uf-type-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);">${_rowsHtml}</div>
              </div>
            </div>
          </div>
        </div>`;
      const trigger = el('uf-type-trigger');
      const menu = el('uf-type-menu');
      const labelEl = trigger.querySelector('.uf-type-label');
      const iconEl = trigger.querySelector('.uf-type-icon');
      const _closeMenu = () => { menu.style.display = 'none'; };
      const _openMenu = () => {
        menu.style.display = 'block';
        // Drop-up when there's not enough room below the trigger (mobile
        // landscape / docked keyboard / long lists near the bottom of screen).
        const tRect = trigger.getBoundingClientRect();
        const mRect = menu.getBoundingClientRect();
        const below = window.innerHeight - tRect.bottom;
        const above = tRect.top;
        if (mRect.height > below && above > below) {
          menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)';
        } else {
          menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto';
        }
        const onDoc = (ev) => { if (!menu.contains(ev.target) && ev.target !== trigger) { _closeMenu(); document.removeEventListener('click', onDoc, true); } };
        setTimeout(() => document.addEventListener('click', onDoc, true), 0);
      };
      trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display === 'block' ? _closeMenu() : _openMenu(); });
      menu.querySelectorAll('.uf-type-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.value;
          const lbl = btn.querySelector('span:last-child')?.textContent || '';
          if (labelEl) { labelEl.textContent = lbl; labelEl.style.opacity = '1'; }
          if (iconEl) iconEl.innerHTML = _iconFor(k);
          _closeMenu();
          showForm(k, 'new');
        });
      });
    });
  }

  await renderList();
}

/* ── Admin visibility sync ── */
function syncAdminVisibility() {
  if (!modalEl) return;
  const isAdmin = !!window._isAdmin;
  modalEl.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}

/* ═══════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════ */
export function open(tab) {
  if (!initialized) initAll();
  if (tab && ADMIN_TABS.has(tab) && !window._isAdmin) tab = 'appearance';
  syncAppearanceCheckboxes();
  resetWindowPlacement();
  modalEl.classList.remove('hidden');
  syncAdminVisibility();
  const content = modalEl.querySelector('.settings-modal-content');
  if (tab) {
    modalEl.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
    modalEl.querySelectorAll('[data-settings-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.settingsPanel !== tab));
  }
  // Auto-init admin data if showing an admin tab
  const activeTab = tab || (modalEl.querySelector('[data-settings-tab].active') || {}).dataset?.settingsTab || 'services';
  document.body.classList.toggle('settings-appearance-open', activeTab === 'appearance');
  syncAppearanceOpacity(activeTab === 'appearance');
  if (activeTab === 'ai') refreshAiModelEndpoints();
  if (ADMIN_TABS.has(activeTab) && window.adminModule && !window.adminModule._initialized) {
    window.adminModule._initData();
  }
}

export function close() {
  if (!modalEl) return;
  // Always clear the appearance-tab body class so the rest of the app
  // doesn't keep its dimmed state if the modal got closed mid-tab.
  document.body.classList.remove('settings-appearance-open');
  syncAppearanceOpacity(false); // clear any opacity-slider fade
  const content = modalEl.querySelector('.modal-content, .settings-modal-content');
  if (content && !content.classList.contains('modal-closing')) {
    content.classList.add('modal-closing');
    content.addEventListener('animationend', () => {
      modalEl.classList.add('hidden');
      content.classList.remove('modal-closing');
    }, { once: true });
    setTimeout(() => { if (!modalEl.classList.contains('hidden')) { modalEl.classList.add('hidden'); content.classList.remove('modal-closing'); } }, 250);
  } else {
    modalEl.classList.add('hidden');
  }
}

const settingsModule = { open, close, initIntegrations, initUnifiedIntegrations, syncAdminVisibility, refreshAiModelEndpoints };


export default settingsModule;
