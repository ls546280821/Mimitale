'use strict';

// ============================================================================
//  core/util.js —— 与业务无关的小工具
// ============================================================================

import { state } from './state.js';

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function now() {
  return Date.now();
}

export function activeConvo() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

/** 读出的数据不一定是数组（老数据 / 手改过 JSON），统一兜成空数组 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 替换 Windows 文件名禁用字符，去掉首尾空白并截长；空名用 fallback，内部空白由调用方处理。 */
export function safeFileName(name, fallback = 'export') {
  const base = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  return base.slice(0, 60) || fallback;
}
