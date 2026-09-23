'use strict';

// ============================================================================
//  ui/confirm.js —— 应用内的确认弹窗（替代 window.confirm）
//  用系统原生 confirm 会有副作用：关掉它的那一下点击会被吞掉，
//  之后点输入框要点两次才能聚焦，看起来就像「输入框点不动」。
// ============================================================================

import { el } from '../core/dom.js';

export function confirmDialog(options) {
  const opts = options || {};

  el.confirmTitle.textContent = opts.title || '确认';
  el.confirmMessage.textContent = opts.message || '';
  el.confirmOk.textContent = opts.confirmText || '确定';
  el.confirmOk.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`;

  el.confirmModal.classList.remove('hidden');
  el.confirmCancel.focus();

  return new Promise((resolve) => {
    function cleanup(result) {
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      el.confirmModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      el.confirmModal.classList.add('hidden');
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(event) {
      if (event.target === el.confirmModal) cleanup(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cleanup(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        cleanup(true);
      }
    }

    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
    el.confirmModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
