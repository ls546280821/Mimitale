'use strict';

// ============================================================================
//  views/presetList.js —— 预设列表页
//
//  预设是「叠在对话上的一层指令」：写一段行为框架，再在会话的「视角」里选上它。
//  这一页只做管理（新建 / 编辑 / 删除），「哪个会话用哪个」在视角弹窗里选。
//
//  「点编辑 = 打开预设编辑器」由入口层通过 initPresetList 注入 —— 编辑器的
//  开关状态（正在编辑哪个预设）住在那边的模块里，本模块不认识它。
//  删除同理（要收掉编辑器里没保存的草稿）。
//
//  重绘入口是 renderPresetPage()，由 views/viewSwitch.js 在「当前停在预设页」
//  时调用（那个分发要读 currentView，属于那一层）。
// ============================================================================

import { el } from '../core/dom.js';
import { button, card, renderListPage } from '../ui/build.js';
import { entityTone } from '../ui/avatarTone.js';
import { dialoguePresets } from '../data/library.js';

/** 入口层注入的跨模块动作 */
let openEditor = () => {};
let removePreset = () => {};
let exportOne = () => {};

export function initPresetList(injected) {
  openEditor = (injected && injected.openEditor) || (() => {});
  removePreset = (injected && injected.remove) || (() => {});
  exportOne = (injected && injected.exportOne) || (() => {});
}

export function renderPresetPage() {
  const list = dialoguePresets();
  renderListPage({
    grid: el.presetPageGrid,
    empty: el.presetPageEmpty,
    sub: el.presetPageSub,
    subText: list.length
      ? `共 ${list.length} 个预设 · 在会话的「视角」里选用`
      : '写一段「回复要遵循什么规则」，挂到某一场对话上',
    items: list,
    card: presetCard
  });
}

/** 一张预设卡：名字 + 说明（或正文摘要）+ 编辑/删除 */
function presetCard(preset) {
  // 副标题优先用「说明」；没写就用正文的第一行 —— 光看名字认不出这个是干什么的
  const firstLine = String(preset.content || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  const subBits = [];
  if (preset.note) subBits.push(preset.note);
  else if (firstLine) subBits.push(firstLine);
  if (preset.enabled === false) subBits.push('已停用');
  for (const tag of (Array.isArray(preset.tags) ? preset.tags : []).slice(0, 3)) {
    if (String(tag).trim()) subBits.push(String(tag).trim());
  }

  return card({
    title: preset.name,
    sub: subBits.join(' · ') || '（空预设）',
    subTitle: String(preset.content || ''),
    avatarText: '预',
    avatarClass: `worldbook-avatar ${entityTone(preset.id, preset.name)}`,
    extra: button({
      class: 'char-card-del',
      text: '×',
      title: '删除这个预设',
      ariaLabel: `删除预设：${preset.name}`,
      onClick: (event) => {
        event.stopPropagation();
        removePreset(preset.id);
      }
    }),
    actions: [
      button({ class: 'btn btn-ghost btn-sm', text: '导出', onClick: () => exportOne(preset.id) }),
      button({ class: 'btn btn-ghost btn-sm', text: '编辑', onClick: () => openEditor(preset.id) })
    ]
  });
}
