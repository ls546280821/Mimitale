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
//  配色方案（accent）：pink（草莓奶昔）/ blue（苏打气泡）/ matcha（抹茶奶绿），
//  和明暗模式正交。体现在 <html> 的 data-accent 上，具体配色在 style.css 的变量里。
//  点一下主色按钮 = 按 ORDER 往后轮一个，转一圈回到 pink。
// ---------------------------------------------------------------------------

const ACCENT_ORDER = ['pink', 'blue', 'matcha'];

// 名字只用来拼按钮提示（「切换为苏打气泡」），别的地方不读它
const ACCENT_NAME = {
  pink: '草莓奶昔',
  blue: '苏打气泡',
  matcha: '抹茶奶绿'
};

function isAccent(value) {
  return Object.prototype.hasOwnProperty.call(ACCENT_NAME, value);
}

export function currentAccent() {
  const value = document.documentElement.getAttribute('data-accent');
  return isAccent(value) ? value : 'pink';
}

export function applyAccent(accent) {
  const next = isAccent(accent) ? accent : 'pink';
  document.documentElement.setAttribute('data-accent', next);

  if (el.btnAccent) {
    // 按钮是「循环」不是「开关」，所以提示写的是**下一个**是什么；
    // aria-pressed 表示「不是默认配色」，方便读屏知道当前偏离了默认。
    const nextName = ACCENT_NAME[ACCENT_ORDER[(ACCENT_ORDER.indexOf(next) + 1) % ACCENT_ORDER.length]];
    const label = `切换为${nextName}`;
    el.btnAccent.title = label;
    el.btnAccent.setAttribute('aria-label', label);
    el.btnAccent.setAttribute('aria-pressed', next === 'pink' ? 'false' : 'true');
  }
}

export function toggleAccent() {
  const cur = currentAccent();
  const next = ACCENT_ORDER[(ACCENT_ORDER.indexOf(cur) + 1) % ACCENT_ORDER.length];
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
