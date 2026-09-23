'use strict';

// ============================================================================
//  ui/theme.js —— 白天 / 夜间模式
//  主题只体现在 <html> 的 data-theme 上，具体配色全在 style.css 的变量里。
// ============================================================================

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { showToast } from './toast.js';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);

  if (el.btnTheme) {
    const isDark = next === 'dark';
    const label = isDark ? '切换为白天模式' : '切换为夜间模式';
    el.btnTheme.title = label;
    el.btnTheme.setAttribute('aria-label', label);
    el.btnTheme.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------------------
//  配色方案（accent）：pink（可爱粉）/ blue（商务蓝），和明暗模式正交。
//  体现在 <html> 的 data-accent 上，具体配色在 style.css 的变量里。
// ---------------------------------------------------------------------------

export function currentAccent() {
  return document.documentElement.getAttribute('data-accent') === 'blue' ? 'blue' : 'pink';
}

export function applyAccent(accent) {
  const next = accent === 'blue' ? 'blue' : 'pink';
  document.documentElement.setAttribute('data-accent', next);

  if (el.btnAccent) {
    const isBlue = next === 'blue';
    const label = isBlue ? '切换为粉色（可爱）' : '切换为蓝色（商务）';
    el.btnAccent.title = label;
    el.btnAccent.setAttribute('aria-label', label);
    el.btnAccent.setAttribute('aria-pressed', isBlue ? 'true' : 'false');
  }
}

export function toggleAccent() {
  const next = currentAccent() === 'blue' ? 'pink' : 'blue';
  applyAccent(next);

  if (state.settings) state.settings.accent = next;

  // 配色方案跟着 config.json 一起存，下次启动还是这个颜色
  api.saveSettings({ accent: next }).catch((err) => {
    console.error('保存配色失败', err);
    showToast('配色没能保存，重启后会回到原来的颜色', 'error');
  });
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);

  if (state.settings) state.settings.theme = next;

  // 主题是设置的一部分，跟着 config.json 一起存，下次启动还是这个模式
  api.saveSettings({ theme: next }).catch((err) => {
    console.error('保存主题失败', err);
    showToast('主题没能保存，重启后会回到原来的模式', 'error');
  });
}
