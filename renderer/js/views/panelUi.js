'use strict';

// ============================================================================
//  views/panelUi.js —— 状态卡入口条
//
//  这里以前是一块「当前状态」面板（折叠字段列表），现已去掉 —— 字段按 owner
//  分给了各人的状态卡（views/stateCard.js），面板成了重复。
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
import { entityTone } from '../ui/avatarTone.js';
import { panelEntities } from '../data/cast.js';
import { onRefresh } from './refresh.js';
import { openStateCard } from './stateCard.js';

/**
 * 铺「本局有谁」的头像条：我 + 本局出现过的角色卡。点头像开那张状态卡。
 * 只列真的持有字段的人（AI 现编的 NPC 没卡、不在这里）。玩家永远排第一。
 */
function renderPanelCast(convo) {
  const host = el.panelCast;
  if (!host) return;
  clear(host);

  const entities = convo ? panelEntities(convo) : [];
  // 标题上的「在场角色 N」跟着这一条走 —— 数出来的就是下面头像的个数，
  // 两处各算一次迟早会不一致（比如头像被过滤掉一个）。
  if (el.panelCastCount) el.panelCastCount.textContent = String(entities.length);

  for (const ent of entities) {
    const btn = h('button', {
      type: 'button',
      class: `panel-avatar ${entityTone(ent.owner, ent.name)}`,
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
 *
 * 没有会话时**整条收掉**，别留一条空条占着消息区上面那行。
 * （2026-09-30 之前还要顺手开关右栏 `#panel-rail`；右栏已去掉，
 * 卡片改回悬浮，那一段判断跟着删了。）
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
