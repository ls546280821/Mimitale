'use strict';

// ============================================================================
//  views/panelUi.js —— 状态卡入口条
//
//  ★ 这里以前是一块「当前状态」面板：一张折叠展开的字段列表。
//    去掉它的原因（用户原话）：一个面板只能显示一个角色的状态，
//    是旧版单角色的遗留 —— 现在字段按 owner 分给了各人的状态卡
//    （见 views/stateCard.js），面板就成了重复。
//
//  现在这一条只干一件事：**列出本局有状态的每个人**（我 + 场景 + 各角色），
//  点头像打开那张状态卡。字段的看和改全在卡里。
//
//  不在这里的：
//    · 解析、归一化、范围夹取、注入提示词 —— 都在 data/panel.js
//    · appendPanelFields / seedPanelFromCharacters / seedIdentity —— 写入口在 data 层
//    · 状态卡本身（画字段、编辑、拖动）—— views/stateCard.js
// ============================================================================

import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { h, clear } from '../ui/build.js';
import { panelEntities } from '../data/cast.js';
import { onRefresh } from './refresh.js';
import { openStateCard } from './stateCard.js';

/**
 * 铺「本局有谁」的头像条：我 + 本局出现过的角色卡。点头像开那张状态卡。
 *
 * 只列真的持有字段的人（AI 现编的 NPC 没卡、不在这里）。
 * 玩家（我）永远在第一个 —— 即使还没种过字段，也要能点开给自己加状态。
 *
 * 没有「世界」入口了（2026-09-29）：认不出归属的字段要么属于主角、要么被丢掉，
 * 见 data/panel.js 的 absorbTopLevelIntoPlayer。
 */
function renderPanelCast(convo) {
  const host = el.panelCast;
  if (!host) return;
  clear(host);
  if (!convo) return;

  for (const ent of panelEntities(convo)) {
    const btn = h('button', {
      type: 'button',
      class: 'panel-avatar',
      title: `查看「${ent.name}」的状态`,
      ariaLabel: `查看「${ent.name}」的状态`,
      onClick: () => openStateCard(ent.owner)
    });
    btn.dataset.owner = ent.owner;
    btn.dataset.kind = ent.kind;
    if (ent.avatar) btn.appendChild(h('img', { src: ent.avatar, alt: '' }));
    else btn.textContent = ent.owner === 'player' ? '我' : ent.name.slice(0, 1);
    host.appendChild(btn);
  }
}

/**
 * 入口条只在「有会话」时出现 —— 里面永远至少有「我」一个头像，
 * 随时能点开给自己加状态。
 */
export function renderPanel() {
  const convo = activeConvo();

  el.panelBox.classList.toggle('hidden', !convo);
  // 「收起」是旧面板的东西，入口条只有一行头像，不需要
  el.panelBox.classList.remove('collapsed');
  renderPanelCast(convo);
}

/**
 * 事件绑定 + 向刷新总线登记自己的重绘。
 *
 * 由 main.js 的 registerRefreshListeners() 在原位调用 —— 登记必须早于第一次广播。
 * 以前这里还要绑「展开/收起」和「重置」两个按钮，随面板一起去掉了：
 *   · 展开/收起 —— 入口条只有一行头像，没有可收的内容；
 *   · 重置（清空面板）—— 清空整局状态是个危险动作，而且和「逐张卡删字段」
 *     是重复的路。要清就进卡里删，或者开新局。
 */
export function initPanelUi() {
  onRefresh(renderPanel);
}
