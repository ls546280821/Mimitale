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

/** 文件名里不能出现的字符（Windows 最严），换成下划线 */
export function safeFileName(name) {
  const base = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  return base.slice(0, 60) || 'export';
}
