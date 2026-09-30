'use strict';

// ============================================================================
//  ui/menu.js —— 顶栏「⋯」下拉菜单
//  只负责「菜单什么时候显示」：点按钮开合、点了某一项关、点别处关、Esc 关。
//  菜单里各项（#btn-memory / #btn-copy-all / #btn-export-convo / #btn-clear）
//  的**功能**仍在原来各自的模块里绑，这里一下都不碰 ——
//  免得同一个动作有两个地方能改，改漏一处就出现「按钮在、点了没反应」。
// ============================================================================

import { el } from '../core/dom.js';

let isOpen = false;

function setOpen(next) {
  if (!el.btnMore || !el.moreMenu) return;
  isOpen = next;
  el.moreMenu.classList.toggle('hidden', !next);
  el.btnMore.setAttribute('aria-expanded', next ? 'true' : 'false');
}

export function openMoreMenu() {
  setOpen(true);
}

export function closeMoreMenu() {
  setOpen(false);
}

export function initMoreMenu() {
  if (!el.btnMore || !el.moreMenu) return;

  el.btnMore.addEventListener('click', (event) => {
    // 别让这一下继续冒到 document：否则刚打开就被下面「点别处关」的逻辑关掉
    event.stopPropagation();
    setOpen(!isOpen);
  });

  // 点了菜单里的某一项就收起。动作本身（开弹窗 / 复制 / 清空）由各模块照旧处理。
  el.moreMenu.addEventListener('click', (event) => {
    if (event.target.closest('.menu-item')) setOpen(false);
  });

  // 点别处、按 Esc 都收起
  document.addEventListener('click', (event) => {
    if (!isOpen) return;
    if (el.btnMore.contains(event.target) || el.moreMenu.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    // 只负责关菜单；别的 Esc 处理（关弹窗）在 main.js，互不干扰
    if (event.key === 'Escape' && isOpen) setOpen(false);
  });
}
