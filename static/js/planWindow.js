// static/js/planWindow.js
import uiModule from './ui.js';
import markdownModule from './markdown.js';
import { makeWindowDraggable } from './windowDrag.js';

let _modal = null;
let _onApprove = null;

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'plan-window';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content plan-window-content">
      <div class="modal-header">
        <h4><span id="plan-window-title">Proposed plan</span></h4>
        <button class="close-btn" id="plan-window-close">✖</button>
      </div>
      <div class="modal-body plan-window-body" id="plan-window-body"></div>
      <div class="modal-footer plan-window-footer">
        <button type="button" class="plan-approve-btn" id="plan-window-approve">Approve &amp; Run</button>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#plan-window-close')?.addEventListener('click', closePlanWindow);
  _modal.querySelector('#plan-window-approve')?.addEventListener('click', () => {
    const cb = _onApprove;
    closePlanWindow();
    if (typeof cb === 'function') cb();
  });
  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

export function openPlanWindow(planMarkdown, onApprove) {
  const modal = _getModal();
  _onApprove = onApprove || null;
  const body = modal.querySelector('#plan-window-body');
  if (body) {
    body.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(planMarkdown || ''));
    if (window.hljs) body.querySelectorAll('pre code').forEach((b) => window.hljs.highlightElement(b));
  }
  const approveBtn = modal.querySelector('#plan-window-approve');
  if (approveBtn) approveBtn.style.display = onApprove ? '' : 'none';
  const title = modal.querySelector('#plan-window-title');
  if (title) title.textContent = onApprove ? 'Proposed plan' : 'Approved plan';
  modal.style.display = 'flex';
  try { uiModule.scrollHistory(); } catch (_) {}
}

export function closePlanWindow() {
  if (_modal) _modal.style.display = 'none';
}

export function isPlanWindowOpen() {
  return !!(_modal && _modal.style.display !== 'none');
}

export default { openPlanWindow, closePlanWindow, isPlanWindowOpen };
