'use strict';

// ============================================================================
//  ui/theme.js —— 主题配色 + 白天 / 夜间
//  两个都只体现在 <html> 的属性上（data-theme / data-accent），
//  具体配色全在 style.css 的变量里。换主题不碰任何一条具体规则。
//
//  控件在「外观」弹窗里（点击由 views/appearance.js 接）。
//  2026-10-08 之前是品牌区两颗「点一下换下一个」的图标 —— 那时候用户看不出
//  一共有几套、现在在哪套，只能一路点下去。换成弹窗里的三选一 / 两选一之后，
//  这里也从 toggle 改成 set（点哪个是哪个），不再是循环。
//
//  ⚠️ ACCENT 这份名单和 main/providers.js 的 ACCENTS、preload.js 的
//     INITIAL_ACCENTS 是同一份东西的三处副本 —— 加配色时三个地方一起加。
// ============================================================================

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { showToast } from './toast.js';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);

  // 外观弹窗里那两颗「白天 / 夜间」的选中态跟着走
  const group = el.appearanceModes;
  if (!group) return;
  for (const btn of group.querySelectorAll('[data-mode]')) {
    btn.setAttribute('aria-checked', btn.dataset.mode === next ? 'true' : 'false');
  }
}

/** 切白天 / 夜间（外观弹窗点分段按钮）。选的就是当前那个的话什么都不做。 */
export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  if (next === currentTheme()) return;

  applyTheme(next);
  if (state.settings) state.settings.theme = next;

  // 主题是设置的一部分，跟着 config.json 一起存，下次启动还是这个模式
  api.saveSettings({ theme: next }).catch((err) => {
    console.error('保存主题失败', err);
    showToast('主题没能保存，重启后会回到原来的模式', 'error');
  });
}

// ---------------------------------------------------------------------------
//  配色方案（accent）：pink（草莓奶昔）/ blue（苏打气泡）/ matcha（抹茶奶绿），
//  和明暗模式正交 —— light / dark × 每种配色都成立。
// ---------------------------------------------------------------------------

// 名字给外观弹窗里的色点标签和提示用
const ACCENT_NAME = {
  pink: '草莓奶昔',
  blue: '苏打气泡',
  matcha: '抹茶奶绿'
};

function isAccent(value) {
  return Object.prototype.hasOwnProperty.call(ACCENT_NAME, value);
}

function currentAccent() {
  const value = document.documentElement.getAttribute('data-accent');
  return isAccent(value) ? value : 'pink';
}

export function applyAccent(accent) {
  const next = isAccent(accent) ? accent : 'pink';
  document.documentElement.setAttribute('data-accent', next);

  const group = el.appearanceAccents;
  if (!group) return;
  for (const btn of group.querySelectorAll('[data-accent]')) {
    btn.setAttribute('aria-checked', btn.dataset.accent === next ? 'true' : 'false');
  }
}

/** 切配色（外观弹窗点色点）。选的就是当前那个的话什么都不做。 */
export function setAccent(accent) {
  const next = isAccent(accent) ? accent : 'pink';
  if (next === currentAccent()) return;

  applyAccent(next);
  if (state.settings) state.settings.accent = next;

  // 配色方案跟着 config.json 一起存，下次启动还是这个颜色
  api.saveSettings({ accent: next }).catch((err) => {
    console.error('保存配色失败', err);
    showToast('配色没能保存，重启后会回到原来的颜色', 'error');
  });
}
