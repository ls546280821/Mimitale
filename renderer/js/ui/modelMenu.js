'use strict';

// ============================================================================
//  ui/modelMenu.js —— 顶栏「切换模型」弹层
//
//  和 ui/menu.js（「⋯」菜单）是同一类东西，分工也一样，别越界：
//    · 它只管「什么时候开、什么时候关、键盘怎么走」
//    · **列表内容**不归它管 —— 由 views/chatList.js 的 renderModelSwitch 铺
//    · **选了之后干什么**也不归它管 —— main.js 把 applyModelChoice 传进来
//  两块都放在外面，是为了不出现「chatList 和 modelMenu 互相 import」那个环
//  （views/refresh.js 存在的理由就是消这种环，别自己再造一个）。
//
//  为什么不用原生 <select>：它的下拉**列表**是系统画的（直角、系统蓝高亮、
//  系统字体），CSS 完全碰不到，跟这套大圆角 + 柔和阴影根本不搭。
// ============================================================================

import { el } from '../core/dom.js';

let isOpen = false;
let onPick = () => {};

/** 弹层里能选的行。「还没有模型」那类占位是 div，天然被排除在外 */
function items() {
  return el.modelMenu ? Array.from(el.modelMenu.querySelectorAll('.model-menu-item')) : [];
}

/** 把当前选中的那行滚进可视区。
 *  手算 scrollTop 而不是用 scrollIntoView —— 后者会连外层可滚动祖先一起滚。 */
function revealActive() {
  const menu = el.modelMenu;
  const active = menu && menu.querySelector('.model-menu-item.is-active');
  if (!active || menu.scrollHeight <= menu.clientHeight) return;
  // 弹层自己是 absolute，所以它就是子元素的 offsetParent，offsetTop 是内容坐标
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < menu.scrollTop) menu.scrollTop = top - 6;
  else if (bottom > menu.scrollTop + menu.clientHeight) {
    menu.scrollTop = bottom - menu.clientHeight + 6;
  }
}

function setOpen(next) {
  if (!el.modelSwitch || !el.modelMenu) return;
  isOpen = next;
  el.modelMenu.classList.toggle('hidden', !next);
  el.modelSwitch.setAttribute('aria-expanded', next ? 'true' : 'false');
  // 一打开就先看见「我现在用的是哪个」，不用自己在十几行里找
  if (next) revealActive();
}

export function openModelMenu() {
  setOpen(true);
}

export function closeModelMenu() {
  setOpen(false);
}

export function isModelMenuOpen() {
  return isOpen;
}

/** 在一组行之间挪焦点。到头就停住 —— 绕回另一头反而容易点错 */
function moveFocus(from, step) {
  const list = items();
  const index = list.indexOf(from);
  if (index < 0) return;
  const target = list[index + step];
  if (target) target.focus();
}

/**
 * @param {{ onPick?: (value: string) => void }} [options] onPick 收到选中项的
 *   `服务商id::模型名`，干什么由调用方决定（main.js 给的是 applyModelChoice）
 */
export function initModelMenu(options = {}) {
  if (!el.modelSwitch || !el.modelMenu) return;
  if (typeof options.onPick === 'function') onPick = options.onPick;

  el.modelSwitch.addEventListener('click', (event) => {
    // 别让这一下继续冒到 document：否则刚打开就被下面「点别处关」的逻辑关掉
    event.stopPropagation();
    if (el.modelSwitch.disabled) return;
    setOpen(!isOpen);
  });

  // 在按钮上按上下键 = 展开并落到当前项上（原生 select 的肌肉记忆）
  el.modelSwitch.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    const target = el.modelMenu.querySelector('.model-menu-item.is-active') || items()[0];
    if (target) target.focus();
  });

  // 行本身是 <button>，回车 / 空格不用管；这里只补上下键和 Home / End
  el.modelMenu.addEventListener('keydown', (event) => {
    const list = items();
    if (!list.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(document.activeElement, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? list[0] : list[list.length - 1];
      if (target) target.focus();
    }
  });

  el.modelMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.model-menu-item');
    if (!item) return;
    setOpen(false);
    // 焦点还回按钮上，键盘用户不至于掉到页面开头
    el.modelSwitch.focus();
    onPick(item.dataset.value || '');
  });

  // 点别处、按 Esc 都收起
  document.addEventListener('click', (event) => {
    if (!isOpen) return;
    if (el.modelSwitch.contains(event.target) || el.modelMenu.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen) return;
    setOpen(false);
    el.modelSwitch.focus();
  });
}
