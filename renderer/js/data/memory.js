'use strict';

// ============================================================================
//  data/memory.js —— 分段记忆摘要
//
//  问题：只把最近 maxTurns 轮发给模型，超出去的历史模型完全看不见。
//  调大轮数就烧 token，调小就忘事 —— 这是个死结。
//
//  做法：把较早的对话按段压缩成摘要，摘要常驻上下文、原文丢弃。
//  这样几十轮前的剧情还在，但 token 占用小得多。
//  摘要由程序管理（和状态面板同一个思路：记忆不能交给模型自己维持）。
//
//  这里只放「怎么算区间、怎么写提示词、怎么调模型」——
//  「什么时候该压、压完怎么通知界面」属于调度，那些要碰 DOM，留在 main.js。
// ============================================================================

import { api } from '../core/api.js';
import { uid, asArray } from '../core/util.js';
import { stripPanelLines } from './panel.js';
import { ensureConvoEndpoint } from './providers.js';
import { characterForConvo } from './library.js';

// 未覆盖的消息达到这个数就压一段。一轮 = 一问一答 = 2 条，
// 也就是大约每 12 轮压一段。
const SUMMARY_TRIGGER_MESSAGES = 24;
// 少于这个数不值得单独压一段
const SUMMARY_MIN_MESSAGES = 12;
// 单段摘要的长度上限
const MAX_SUMMARY_CHARS = 4000;
// 一次送给模型压缩的原文长度上限，超了就从最早的开始截
const MAX_SUMMARY_INPUT_CHARS = 24000;
// 连续失败这么多次就暂停自动摘要，避免每轮都白烧一次请求
const MAX_SUMMARY_FAILURES = 3;
// 失败后至少隔这么久再试（毫秒）
const SUMMARY_RETRY_COOLDOWN_MS = 60000;

/** 真正会进入上下文的消息（和 buildApiMessages 的口径保持一致） */
export function convoContextMessages(convo) {
  if (!convo || !Array.isArray(convo.messages)) return [];
  return convo.messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
}

export function convoSummaries(convo) {
  return asArray(convo && convo.summaries);
}

/** 摘要覆盖到了第几条（未压缩的历史从这里开始） */
export function summarizedCount(convo) {
  const list = convoSummaries(convo);
  if (!list.length) return 0;
  let max = 0;
  for (const seg of list) {
    const end = Number(seg.end) || 0;
    if (end > max) max = end;
  }
  return max;
}

/**
 * 删掉 convo.messages[messageIndex] 之前调：把摘要的 start/end 跟着挪。
 *
 * 为什么必须挪：start/end 是 convoContextMessages 里的**下标**。删掉覆盖范围内
 * （或之前）的一条，后面的消息整体前移一格 —— 不挪的话，紧挨着覆盖点的那条
 * **从没被压缩过**的消息会滑进「已覆盖」区间，从此既不在摘要里、也不进上下文。
 *
 * 被删的那条本身不进上下文（错误提示 / 空占位）就什么都不用动。
 * 挪完缩成空的段直接丢掉（它覆盖的原文全删光了）。
 */
export function shiftSummariesForRemoval(convo, messageIndex) {
  const list = convoSummaries(convo);
  if (!list.length || !convo || !Array.isArray(convo.messages)) return;

  const removed = convo.messages[messageIndex];
  const context = convoContextMessages(convo);
  const ci = context.indexOf(removed);
  if (ci < 0) return;

  for (const seg of list) {
    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || 0;
    if (ci < start) seg.start = start - 1;
    if (ci < end) seg.end = end - 1;
  }
  convo.summaries = list.filter((s) => s.end > s.start);
}

/**
 * 压缩请求回来、准备记覆盖范围之前调：[start, start+count) 还是不是当初送去压的那几条？
 *
 * 摘要要等模型几秒到几十秒，期间用户可以删消息（removeMessage 只拦流式中，不拦后台摘要）。
 * 删了的话 start 已经过期，照记就会把错位的那段标成「已覆盖」—— 和 shiftSummariesForRemoval
 * 防的是同一种吞消息。对不上就放弃这一段，下一轮按新的位置重压。
 */
export function summaryRangeIntact(convo, start, sent, count) {
  if (summarizedCount(convo) !== start) return false;
  const context = convoContextMessages(convo);
  for (let i = 0; i < count; i += 1) {
    if (context[start + i] !== sent[i]) return false;
  }
  return true;
}

export function nextSegmentTitle(convo) {
  return `第 ${convoSummaries(convo).length + 1} 段`;
}

/** 摘要拼成注入块；没有摘要就返回空串 */
export function formatSummaryForPrompt(convo) {
  const list = convoSummaries(convo);
  if (!list.length) return '';

  const parts = [];
  for (const seg of list) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    parts.push(`【${seg.title || '对话摘要'}】\n${text}`);
  }
  if (!parts.length) return '';

  return (
    '[前面的剧情]\n' +
    '以下是本次对话较早部分的摘要，作为已经发生过的剧情参考，' +
    '保持人物、地点和事件前后一致；不要向对方复述这份摘要。\n\n' +
    parts.join('\n\n')
  );
}

/**
 * 摘要生成用的提示词。
 * 明确要求「只记事实、不要文学化」，因为摘要会一直占用上下文，
 * 写成抒情散文既费 token 又容易让模型把摘要当成剧情来续写。
 */
function buildSummaryPrompt(previousSummary, transcriptText) {
  const parts = [
    '你在帮一个长篇角色扮演对话做剧情摘要。',
    '下面是一段已经发生过的对话原文，请把它压缩成简洁的剧情摘要。',
    '',
    '要求：',
    '1. 只记录事实：发生了什么、到了哪里、见了谁、关系或状态有什么变化、答应过什么、埋了什么伏笔。',
    '2. 不要文学化描写，不要复述对话原文，不要加入评论。',
    '3. 按时间顺序写，用短句或分条，控制在 300 字以内。',
    '4. 直接输出摘要正文，不要任何前言、标题或「摘要：」之类的字样。'
  ];

  if (previousSummary) {
    parts.push(
      '',
      '此前已有的更早剧情摘要（只作为背景，不要重复它的内容）：',
      previousSummary
    );
  }

  parts.push('', '需要压缩的对话原文：', transcriptText);
  return parts.join('\n');
}

/** 一条消息在压缩原文里的样子 */
function transcriptLine(m, charName) {
  const who = m.role === 'user' ? '对方' : charName || '角色';
  // 摘要不需要状态栏，剥掉省 token
  const text = String(m.content || '').trim();
  return `${who}：${m.role === 'assistant' ? stripPanelLines(text) : text}`;
}

/**
 * 给「往后压一段」用的原文：**从最早那条往后**装，装满为止。
 * 返回 { text, count } —— count 是真正写进原文的条数，摘要的 end 必须按它记。
 *
 * ⚠️ 别改回「从最后往前装」的那种（旧的 buildTranscript 就是这么写的，已删）：
 *    它超长时砍的是**最早**的几条，而调用方照样按整段 slice.length 记覆盖范围 ——
 *    被砍掉的那几条既不在摘要里、又被当成「已压缩」挡在上下文外面，永久消失。
 *    长回复的角色扮演（每条两千多字）十几条就会撞上。
 *    **所有调用点都走这个函数**（summarize.js 的压一段 / memoryUi.js 的重新生成），
 *    从头装、按实际条数记，装不下的那几条留到下一段再压。
 */
export function buildTranscriptFromStart(messages, charName) {
  const lines = [];
  let total = 0;

  for (const m of messages) {
    const line = transcriptLine(m, charName);
    if (total + line.length > MAX_SUMMARY_INPUT_CHARS && lines.length) break;
    total += line.length;
    lines.push(line);
  }

  return { text: lines.join('\n\n'), count: lines.length };
}

/**
 * 需要压缩的消息区间。
 * 用「当前消息总数 - 已覆盖数」来算，而不是用固定下标 ——
 * 用户删掉中间某条消息后，消息数组会整体前移，固定下标会错位。
 */
export function pendingSummaryRange(convo) {
  const messages = convoContextMessages(convo);
  const covered = summarizedCount(convo);
  const start = Math.min(covered, messages.length);
  const pending = messages.slice(start);
  return { messages, start, pending, covered };
}

/**
 * 摘要的「运行态」。
 *
 * 放在 data 层而不是某个视图里，是因为两头都要用它：后台调度（main.js 的
 * maybeSummarize）判断该不该压，记忆面板（views/memoryUi.js）判断有没有
 * 正在跑、好禁用按钮。谁都不必 import 谁。
 */
// 正在压缩的会话 id，防止同一会话并发触发
export const summarizingConvos = new Set();
// 会话 id -> 连续失败次数
export const summaryFailures = new Map();

/** 摘要里怎么称呼「对面那位」—— 没绑角色就当作通用助手 */
export function charNameForSummary(convo) {
  const character = characterForConvo(convo);
  return character ? character.name : '你';
}

/** 调一次模型生成摘要；失败或返回异常时返回 null */
export async function generateSummary(convo, transcript, previousSummary) {
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) return null;

  const summaryMessages = [
    { role: 'system', content: buildSummaryPrompt(previousSummary, transcript) }
  ];

  const response = await api.sendChat({
    requestId: `summary-${uid()}`,
    providerId: endpoint.provider.id,
    model: endpoint.model,
    messages: summaryMessages
  });

  if (!response || response.ok !== true) {
    throw new Error((response && response.error) || '摘要请求失败');
  }

  let text = String(response.content || '').trim();
  if (!text) throw new Error('摘要返回为空');

  // 有些模型会固执地加个前缀，剥掉
  text = text.replace(/^(剧情)?摘要[：:]\s*/, '').trim();

  if (text.length > MAX_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
  }

  return text;
}

export {
  SUMMARY_TRIGGER_MESSAGES,
  SUMMARY_MIN_MESSAGES,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_INPUT_CHARS,
  MAX_SUMMARY_FAILURES,
  SUMMARY_RETRY_COOLDOWN_MS
};
