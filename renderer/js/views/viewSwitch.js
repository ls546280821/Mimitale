'use strict';

// ============================================================================
//  views/viewSwitch.js —— 主区域显示哪一屏
//
//  以前整个 main 只有聊天一屏，所有功能都靠弹窗盖在上面；
//  角色库 / 世界书 / 预设变成页面之后就需要这一层了。
//
//  它同时管两件相关的事：
//    · showView(name)        切屏（侧边栏高亮 + 隐藏另外几屏 + 必要时补画一次）
//    · refreshLibraryPage()  数据变了之后，若正停在那几个列表页就重画它
//  两件事都要读「现在在哪一屏」，所以放在一起 —— 那个状态不export，
//  外面只通过这两个函数跟它打交道。
//
//  它单向 import 那几个列表页（那些都不认识本模块），所以不构成循环。
// ============================================================================

import { el } from '../core/dom.js';
import { renderCharacterPage } from './characterList.js';
import { renderWorldbookPage } from './worldbookList.js';
import { renderPresetPage } from './presetList.js';

/** 当前主区域显示的是哪个视图 */
let currentView = 'chat';

const VIEWS = ['chat', 'chars', 'worldbooks', 'presets', 'help'];

/** 「哪一屏对应哪个容器、哪个侧栏按钮」—— 加视图只要往这张表里加一行 */
const VIEW_PARTS = [
  { name: 'chat', view: 'viewChat', btn: null },
  { name: 'chars', view: 'viewChars', btn: 'btnChars' },
  { name: 'worldbooks', view: 'viewWorldbooks', btn: 'btnWorldbooks' },
  { name: 'presets', view: 'viewPresets', btn: 'btnPresets' },
  // 帮助页是纯静态文本，没有 render 函数，只在这里登记显隐和高亮
  { name: 'help', view: 'viewHelp', btn: 'btnHelp' }
];

export function showView(name) {
  if (!VIEWS.includes(name)) return;
  currentView = name;

  for (const part of VIEW_PARTS) {
    const view = el[part.view];
    if (view) view.classList.toggle('hidden', name !== part.name);
    // 侧边栏那一项高亮，让人知道自己在哪个页面
    const btn = part.btn ? el[part.btn] : null;
    if (btn) btn.classList.toggle('active', name === part.name);
  }

  if (name === 'chars') renderCharacterPage();
  else if (name === 'worldbooks') renderWorldbookPage();
  else if (name === 'presets') renderPresetPage();
  // help 是静态页，切过去不用做任何事；只有回到聊天才把光标放回输入框
  else if (name === 'chat') el.input.focus();
}

/** 停在图书区那几个列表页时也要跟着刷新（改名、删除、导入都会走到这里） */
export function refreshLibraryPage() {
  if (currentView === 'chars') renderCharacterPage();
  else if (currentView === 'worldbooks') renderWorldbookPage();
  else if (currentView === 'presets') renderPresetPage();
}

/** 侧边栏那几个入口（切屏属于本模块自己的事，自己绑） */
export function initViewSwitch() {
  // 角色库 → 切到角色列表页
  el.btnChars.addEventListener('click', () => showView('chars'));
  // 世界书 → 切到世界书列表页
  el.btnWorldbooks.addEventListener('click', () => showView('worldbooks'));
  // 预设 → 切到预设列表页
  if (el.btnPresets) el.btnPresets.addEventListener('click', () => showView('presets'));
  // 帮助 → 切到帮助页（静态内容）
  if (el.btnHelp) el.btnHelp.addEventListener('click', () => showView('help'));
}
