'use strict';

// ============================================================================
//  data/conversations.js —— 会话的「出生」：新建一个、或从某条消息分出一条
//
//  只做纯逻辑（拼出一个会话对象、塞进 state、落盘），不碰 DOM、不重绘 ——
//  那个会话长什么样、放哪一行，是 views/ 的事。
//
//  「分支」刻意做成「另开一个会话、把前 N 条原样复制过去」而不是真正的消息树：
//  当前会话一个字节都不动，走岔了随时切回来，两边还能并排对比（侧栏里就是两条）。
//  简单得多，也不会因为一次误操作丢掉整条线。
// ============================================================================

import { state } from '../core/state.js';
import { uid, now } from '../core/util.js';
import { convoWorldbookIds } from './library.js';
import { convoPanel, convoPanelDefs, convoPanelFields } from './panel.js';
import { DEFAULT_NARRATION_MODE, DEFAULT_PACE_MODE } from './narration.js';
import { persistConversations } from './persist.js';

/**
 * 新建一个会话并（默认）切过去。
 *
 * 不再继承上一个会话的角色：现在「＋ 新对话」会先带你去角色列表页挑一个，
 * 角色由 applyCharacterChoice 在选完之后绑上。
 * 这里建出来的是「还没选角色」的会话（删光会话后的兜底也走这里）。
 */
export function createConvo(activate) {
  const convo = {
    id: uid(),
    title: '新对话',
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    characterId: null,
    // 会话自己绑的世界书（「进入世界」走这里）。
    // 另有「角色自带的世界书」——那条路走 character.worldbookIds，
    // 两者由 effectiveWorldbookIds 决定用谁：会话绑了就只用会话的。
    worldbookIds: [],
    // 状态面板：fields 是出现过的字段顺序，panel 是当前值。
    // panelDefs 是字段的类型/范围/变化规则（可选，老会话没有这个键也照常工作）。
    // 世界模型开局通常是空的，第一条带面板的回复会自动填上。
    panel: {},
    panelFields: [],
    panelDefs: {},
    // 剧情选项：options 是这一轮模型给的可点选项（点完就清），
    // optionsSpec 是「每轮给几个 + 额外要求」，null = 这个会话不开剧情选项。
    options: [],
    optionsSpec: null,
    // 视角设置：叙述模式（标准/内心描写/上帝视角）、推进节奏、GM 模式
    narrationMode: DEFAULT_NARRATION_MODE,
    // 默认「一步一步」：不这样的话模型会一口气把整场戏演完，玩家只剩看的份
    paceMode: DEFAULT_PACE_MODE,
    gmMode: false,
    // 分段记忆摘要：每段 { id, title, text, start, end, at }
    summaries: []
  };
  state.conversations.unshift(convo);
  if (activate !== false) state.activeId = convo.id;
  persistConversations(0);
  return convo;
}

/**
 * 从某条消息分出一条新线的「骨架」：前 cut 条消息及其戏本身的东西照搬过去。
 * 只拼对象、不落盘、不切会话 —— 那两个动作由调用方按界面需要决定。
 */
export function branchSkeleton(convo, cut) {
  return {
    id: uid(),
    title: `${convo.title || '新对话'}（分支）`,
    createdAt: now(),
    updatedAt: now(),
    // 戏本身的东西照搬：绑的角色、世界书、玩家、状态面板、视角设置
    characterId: convo.characterId || null,
    worldbookIds: [...convoWorldbookIds(convo)],
    gmMode: convo.gmMode === true,
    player: convo.player ? { ...convo.player } : null,
    panelFields: [...convoPanelFields(convo)],
    panel: { ...convoPanel(convo) },
    // 字段的范围/hint 也要跟着分叉走，否则新线的数值从此不再受约束
    panelDefs: JSON.parse(JSON.stringify(convoPanelDefs(convo))),
    // 剧情选项配置跟着走；这一轮的选项本身不搬（新线还没生成过）
    optionsSpec: convo.optionsSpec ? { ...convo.optionsSpec } : null,
    options: [],
    messages: JSON.parse(JSON.stringify(convo.messages.slice(0, cut))),
    // 摘要不搬：它压缩的是「最早那批消息」，而新会话里这批消息是原样留着的，
    // 搬过去等于同一段内容被记两遍。新线从零开始攒记忆。
    summaries: [],
    checkpoints: []
  };
}
