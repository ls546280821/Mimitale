'use strict';

// ============================================================================
//  ui/toast.js —— 顶部那条一闪而过的提示
//  全项目用得最多的一个界面件（16 个分区都在调它）。
// ============================================================================

import { el } from '../core/dom.js';
import { CONFIG } from '../core/config.js';

let toastTimer = null;

export function showToast(message, kind) {
  el.toast.textContent = message;
  el.toast.className = `toast${kind ? ` ${kind}` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), CONFIG.TOAST_DURATION_MS);
}
