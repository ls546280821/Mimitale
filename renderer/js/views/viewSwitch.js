'use strict';

// ============================================================================
//  views/viewSwitch.js —— 主区域显示哪一屏
//
//  以前整个 main 只有聊天一屏，所有功能都靠弹窗盖在上面；
//  角色库 / 世界书变成页面之后就需要这一层了。
//
//  它同时管两件相关的事：
//    · showView(name)        切屏（侧边栏高亮 + 隐藏另外两屏 + 必要时补画一次）
//    · refreshLibraryPage()  数据变了之后，若正停在那两个列表页就重画它
//  两件事都要读「现在在哪一屏」，所以放在一起 —— 那个状态不export，
//  外面只通过这两个函数跟它打交道。
//
//  它单向 import 两个列表页（那两个都不认识本模块），所以不构成循环。
// ============================================================================

import { el } from '../core/dom.js';
import { renderCharacterPage } from './characterList.js';
import { renderWorldbookPage } from './worldbookList.js';

/** 当前主区域显示的是哪个视图：'chat' 聊天 / 'chars' 角色列表 / 'worldbooks' 世界书列表 */
let currentView = 'chat';

const VIEWS = ['chat', 'chars', 'worldbooks'];

export function showView(name) {
  if (!VIEWS.includes(name)) return;
  currentView = name;

  el.viewChat.classList.toggle('hidden', name !== 'chat');
  el.viewChars.classList.toggle('hidden', name !== 'chars');
  el.viewWorldbooks.classList.toggle('hidden', name !== 'worldbooks');
  // 侧边栏那一项高亮，让人知道自己在哪个页面
  el.btnChars.classList.toggle('active', name === 'chars');
  el.btnWorldbooks.classList.toggle('active', name === 'worldbooks');

  if (name === 'chars') renderCharacterPage();
  else if (name === 'worldbooks') renderWorldbookPage();
  else el.input.focus();
}

/** 停在图书区那两个列表页时也要跟着刷新（改名、删除、导入都会走到这里） */
export function refreshLibraryPage() {
  if (currentView === 'chars') renderCharacterPage();
  else if (currentView === 'worldbooks') renderWorldbookPage();
}

/** 侧边栏那两个入口（切屏属于本模块自己的事，自己绑） */
export function initViewSwitch() {
  // 角色库 → 切到角色列表页
  el.btnChars.addEventListener('click', () => showView('chars'));
  // 世界书 → 切到世界书列表页
  el.btnWorldbooks.addEventListener('click', () => showView('worldbooks'));
}
