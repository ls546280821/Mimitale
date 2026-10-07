'use strict';

// ============================================================================
//  ui/plainView.js —— 纯对话视图（顶栏「⋯」里的那个开关）
//
//  只做一件事：给 <body> 挂 / 摘一个 plain-view 类。具体藏什么全写在 style.css
//  里（状态卡入口条、剧情选项、消息上的操作按钮收进悬停的「⋯」）——
//  所以这里不必认识任何视图模块，也就绕不出 import 环。
//
//  状态记在设置里（plainChatView，见 main/providers.js）：开合时由入口层注入的
//  onChange 去存，本模块不碰 api。
// ============================================================================

import { el } from '../core/dom.js';

/** 按设置里的值把界面切过去。启动时和开关后都走这一处，保证两边口径一致。 */
export function applyPlainView(on) {
  const active = on === true;
  document.body.classList.toggle('plain-view', active);
  if (el.btnPlainView) el.btnPlainView.setAttribute('aria-checked', active ? 'true' : 'false');
}

/**
 * 绑「⋯」里那一项。
 * onChange(next) 由入口层注入 —— 存设置是跨进程的活，这里不掺和。
 */
export function initPlainView(opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  if (!el.btnPlainView) return;

  el.btnPlainView.addEventListener('click', () => {
    const next = !document.body.classList.contains('plain-view');
    // 先切界面再落盘：纯显示开关，立刻生效才跟手。
    // 万一没存上，下次启动会退回旧值 —— 比按下去半天没反应强。
    applyPlainView(next);
    onChange(next);
  });
}
