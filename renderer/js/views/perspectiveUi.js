'use strict';

// ============================================================================
//  views/perspectiveUi.js —— 视角设置弹窗
//
//  三样东西：叙述模式（标准 / 内心描写 / 上帝视角）、推进节奏（一步一步 …）、
//  GM 模式。它们改变的是「模型看这个世界的视角」，最终都只是往系统提示词里
//  拼一段文本（规则文本在 data/narration.js）。
//
//  交互是「改动即时生效 + 即时落盘」—— 没有保存按钮，所以每次 change 都要
//  顺手刷新头部（头部那行 Meta 会显示偏离默认的视角标签）。
//  这里 import header.js 是单向的：header 只依赖数据层，不认识任何视图。
// ============================================================================

import { el } from '../core/dom.js';
import { now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { persistConversations } from '../data/persist.js';
import {
  DEFAULT_NARRATION_MODE,
  DEFAULT_PACE_MODE,
  NARRATION_MODES,
  PACE_MODES,
  convoNarrationMode,
  convoPaceMode,
  isGmMode
} from '../data/narration.js';
import { renderHeader } from './header.js';

function openPerspectiveModal() {
  const convo = activeConvo();
  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  el.pNarration.value = convoNarrationMode(convo);
  el.pPace.value = convoPaceMode(convo);
  el.pGm.checked = isGmMode(convo);

  el.perspectiveModal.classList.remove('hidden');
}

function closePerspectiveModal() {
  el.perspectiveModal.classList.add('hidden');
  el.input.focus();
}

/** 把面板里的设置写回会话；即时生效、即时保存 */
function applyPerspectiveFromForm() {
  const convo = activeConvo();
  if (!convo) return;

  const mode = el.pNarration.value;
  convo.narrationMode = Object.prototype.hasOwnProperty.call(NARRATION_MODES, mode) ? mode : DEFAULT_NARRATION_MODE;

  const pace = el.pPace.value;
  convo.paceMode = Object.prototype.hasOwnProperty.call(PACE_MODES, pace) ? pace : DEFAULT_PACE_MODE;

  convo.gmMode = el.pGm.checked;
  convo.updatedAt = now();

  renderHeader();
  persistConversations(0);
}

/** 事件绑定（在 init() 里调用） */
export function initPerspectiveUi() {
  el.btnPerspective.addEventListener('click', openPerspectiveModal);
  el.btnClosePerspective.addEventListener('click', closePerspectiveModal);
  el.btnClosePerspective2.addEventListener('click', closePerspectiveModal);
  el.perspectiveModal.addEventListener('click', (event) => {
    if (event.target === el.perspectiveModal) closePerspectiveModal();
  });
  el.pNarration.addEventListener('change', applyPerspectiveFromForm);
  el.pPace.addEventListener('change', applyPerspectiveFromForm);
  el.pGm.addEventListener('change', applyPerspectiveFromForm);
}
