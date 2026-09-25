'use strict';

// ============================================================================
//  views/header.js —— 对话头部（标题 / 元信息 / 提示 / 用量）
//
//  头部那行 Meta 是「当前这一局到底怎么跑的」的唯一汇总处，只读不写：
//    · 绑的角色 + 实际会用的服务商 / 模型
//    · 这一局真正生效的世界书，并标出来源（会话绑的 / 角色自带的 / 被谁顶了）
//    · 视角（GM、叙述模式、推进节奏），但只在偏离默认时才占位
//    · 记忆压了几段 / 正在压
//  所以它谁都不依赖，只依赖数据层 —— 也因此是「视角设置」「记忆」这些
//  改了设置后想刷新头部的地方可以放心 import 的模块（单向，头部不认识任何视图）。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { currentEndpoint } from '../data/providers.js';
import { characterForConvo, convoWorldbookIds, worldbookById } from '../data/library.js';
import {
  DEFAULT_NARRATION_MODE,
  DEFAULT_PACE_MODE,
  NARRATION_MODES,
  PACE_MODES,
  convoNarrationMode,
  convoPaceMode,
  isGmMode
} from '../data/narration.js';
import { convoSummaries } from '../data/memory.js';
import { onRefresh } from './refresh.js';

export function renderHeader() {
  const convo = activeConvo();
  const settings = state.settings || {};
  el.convoTitle.textContent = (convo && convo.title) || '新对话';

  const endpoint = currentEndpoint();
  const character = characterForConvo(convo);
  const prefix = character ? `${character.name} · ` : '';

  if (!endpoint) {
    el.convoMeta.textContent = '还没有配置模型服务 —— 点左下角「设置」';
  } else if (!endpoint.provider.apiKey) {
    el.convoMeta.textContent = `${prefix}还没有填「${endpoint.provider.name}」的 API Key —— 点左下角「设置」`;
  } else {
    el.convoMeta.textContent = `${prefix}${endpoint.provider.name} · ${endpoint.model || '未选模型'}`;
  }

  // 世界书：把「当前实际生效的是哪些」写清楚，并标出来源。
  // 以前这里只显示会话绑的书，角色自带的那本完全不可见 ——
  // 用户根本没法判断它到底有没有生效，只能靠猜。
  const convoBookIds = convoWorldbookIds(convo);
  const convoBooks = convoBookIds.map((id) => worldbookById(id)).filter(Boolean);
  const charBookIds = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const charBooks = charBookIds.map((id) => worldbookById(id)).filter(Boolean);

  if (convoBooks.length) {
    el.convoMeta.textContent += ` · 世界：${convoBooks.map((b) => b.name).join('、')}`;
    // 会话绑了世界时，角色的书按设计让位 —— 但要说出来，不能悄悄不生效
    if (charBooks.length) {
      el.convoMeta.textContent +=
        character.worldbookEnabled === false
          ? '（角色自带的书已关掉）'
          : '（角色自带的书这次不生效：世界优先）';
    }
  } else if (charBooks.length) {
    el.convoMeta.textContent +=
      character.worldbookEnabled === false
        ? ` · 自带世界书：${charBooks.map((b) => b.name).join('、')}（已关掉）`
        : ` · 世界：${charBooks.map((b) => b.name).join('、')}（角色自带）`;
  }

  // 视角：只在偏离默认（标准 + 一步一步 + 非 GM）时提示，平时不占位置
  const viewTags = [];
  if (isGmMode(convo)) viewTags.push('GM 模式');
  const narrationMode = convoNarrationMode(convo);
  if (narrationMode !== DEFAULT_NARRATION_MODE) viewTags.push(NARRATION_MODES[narrationMode].label);
  const paceMode = convoPaceMode(convo);
  if (paceMode !== DEFAULT_PACE_MODE) viewTags.push(PACE_MODES[paceMode].label);
  if (viewTags.length) el.convoMeta.textContent += ` · ${viewTags.join(' + ')}`;

  // 记忆：正在压缩时给个提示，压缩完显示覆盖了多少条
  const segCount = convoSummaries(convo).length;
  if (convo && convo.summaryBusy) el.convoMeta.textContent += ' · 正在整理记忆…';
  else if (segCount) el.convoMeta.textContent += ` · 记忆 ${segCount} 段`;

  el.hintText.textContent = settings.sendOnEnter === false
    ? 'Ctrl + Enter 发送 · Enter 换行'
    : 'Enter 发送 · Shift + Enter 换行';

  if (state.usage && settings.showUsage !== false) {
    const u = state.usage;
    let text = `本次用量：输入 ${u.prompt_tokens ?? '-'} / 输出 ${u.completion_tokens ?? '-'} tokens`;
    // 思考量单独拎出来说 —— 它是「输出被截断」时最该看的一个数：
    // 思考接近输出总量，就说明额度是被思考吃掉的；离得远则跟上限无关。
    const rt = Number(u.reasoning_tokens);
    if (Number.isFinite(rt) && rt > 0) text += `（其中思考 ${rt}）`;
    el.usageText.textContent = text;
  } else {
    el.usageText.textContent = '';
  }
}

/** 登记到刷新总线（在 init() 里按绘制顺序调用） */
export function initHeader() {
  onRefresh(renderHeader);
}
