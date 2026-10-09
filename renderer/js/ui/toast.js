'use strict';

// ============================================================================
//  ui/toast.js —— 顶部那条一闪而过的提示
//  全项目用得最多的一个界面件（16 个分区都在调它）。
// ============================================================================

import { el } from '../core/dom.js';
import { CONFIG } from '../core/config.js';

let toastTimer = null;

/**
 * @param {string} message 要显示的话
 * @param {string} [kind] 'ok' / 'error' 之类的配色
 * @param {{ durationMs?: number }} [options] 只给确实需要「多看一会儿」的提示用
 *   （比如启动时告知用户设置被迁移过）。不传就按 CONFIG.TOAST_DURATION_MS。
 */
export function showToast(message, kind, options) {
  el.toast.textContent = message;
  el.toast.className = `toast${kind ? ` ${kind}` : ''}`;
  clearTimeout(toastTimer);
  const duration = Number(options && options.durationMs);
  toastTimer = setTimeout(
    () => el.toast.classList.add('hidden'),
    Number.isFinite(duration) && duration > 0 ? duration : CONFIG.TOAST_DURATION_MS
  );
}
