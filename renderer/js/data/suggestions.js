'use strict';

// ============================================================================
//  data/suggestions.js —— 「帮我想想」和「剧情选项」的纯逻辑
//
//  两块东西长得像，用途不同：
//    · 帮我想想：**额外发一次请求**，一次性给几个建议，不算常驻功能；
//    · 剧情选项：**面板的一部分** —— 跟状态栏一起在正文里输出，不用多发请求，
//      每轮都更新，选项常驻在面板里。
//
//  这里只放「拼指令 / 解析文本 / 同步到会话」这类纯函数，一行 DOM 都不碰；
//  按钮怎么排、点了怎么发出去在 views/suggestionsUi.js。
//
//  选项为什么不做成普通面板字段（【剧情选项】：A / B / C）：
//  面板字段的值是「一个字符串」，而选项是**可变长的列表**，还要逐个变成按钮。
//  塞进字段里就得再切一次、还得处理玩家手改这种字段的边界情况，不如单独一条
//  指令 + 单独的解析，语义清楚也不互相干扰。
// ============================================================================

import { OPTIONS_LABEL, OPTIONS_LINE_RE } from './panel.js';

// --- 帮我想想 ---

// 一次给几个选项
const SUGGEST_COUNT = 4;
// 单个选项的字数上限，免得点下去变成一大段
const MAX_SUGGEST_CHARS = 120;

export function suggestInstruction() {
  return (
    '请基于上面这段对话，替「玩家」想几个接下来可以怎么做 / 怎么说的选项。\n' +
    '\n' +
    '要求：\n' +
    `1. 给 ${SUGGEST_COUNT} 个，每一个都要贴着当前局面，不要泛泛而谈。\n` +
    '2. 每个选项要明显不同 —— 可以是不同的态度、不同的做法、或者不同的对象，\n' +
    '   不要四个都是同一件事的不同说法。\n' +
    '3. 用玩家第一人称，写他实际会说的话或会做的动作，\n' +
    `   每条控制在一句话内（不超过 ${MAX_SUGGEST_CHARS} 字），不要写成小作文。\n` +
    '4. 直接输出选项本身，不要序号、不要引号、不要解释、不要标题。\n' +
    '5. 每行一个。'
  );
}

/** 从模型回复里解析出选项：一行一个，容忍它带了序号或引号 */
export function parseSuggestions(text) {
  const lines = String(text || '').split('\n');
  const out = [];

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    // 容忍「1. 」「1、」「- 」「• 」这类前缀
    line = line.replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[.、)）:：]\s*/, '');
    // 容忍整行被引号包起来
    line = line.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim();

    if (!line) continue;
    if (line.length > MAX_SUGGEST_CHARS) line = `${line.slice(0, MAX_SUGGEST_CHARS)}…`;

    if (!out.includes(line)) out.push(line);
    if (out.length >= SUGGEST_COUNT) break;
  }

  return out;
}

// --- 剧情选项 ---

// 选项行的标记（OPTIONS_LABEL / OPTIONS_LINE_RE）在 data/panel.js 里 ——
// 「剥掉选项行」和「剥掉状态栏行」是同一件事，两边的解析放在一起。
// 一条选项最多多少字 —— 点下去要当消息发出去，不能变成小作文
const MAX_OPTION_CHARS = 120;
// 一屏最多几个（模型给多了会挤爆面板）
const MAX_OPTIONS = 6;

/** 当前会话要不要每轮出剧情选项（存在会话上，跟面板走） */
export function convoOptionsSpec(convo) {
  const spec = convo && convo.optionsSpec;
  if (!spec || typeof spec !== 'object') return null;
  const count = Math.max(1, Math.min(MAX_OPTIONS, Math.round(Number(spec.count) || 3)));
  return { count, hint: String(spec.hint || '').trim().slice(0, 200) };
}

/**
 * 从模型回复里抽选项。
 * 只认**最后一段**「【剧情选项】：」—— 模型有时会先说一遍再重写，
 * 取最后的才是最终答案。返回空数组表示这轮没给（那就保持上一轮的）。
 */
export function extractOptionsFromText(text) {
  const lines = String(text || '').split('\n');
  let tail = null;

  for (const raw of lines) {
    const m = raw.trim().match(OPTIONS_LINE_RE);
    if (m) tail = m[1];
  }
  if (tail === null) return [];

  const out = [];
  // 只认「/」「｜」这类**明确的分隔符**。
  // 不能拿顿号/逗号来切 —— 选项本身就是中文句子，里面天然带「，」，
  // 一切就把「我想先喝一杯，压压惊」拆成两条没头没尾的碎片（实测踩过）。
  for (const piece of tail.split(/[\/｜|]/)) {
    let item = piece.trim();
    if (!item) continue;
    // 容忍「1. 」「① 」「- 」这类前缀和包在引号里
    item = item.replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[.、)）:：]\s*/, '').replace(/^[①-⑳]\s*/, '');
    item = item.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim();
    if (!item) continue;
    if (item.length > MAX_OPTION_CHARS) item = `${item.slice(0, MAX_OPTION_CHARS)}…`;
    if (!out.includes(item)) out.push(item);
    if (out.length >= MAX_OPTIONS) break;
  }

  return out;
}

/** 注入给模型的选项指令（有配置时才注入） */
export function optionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  if (!spec) return '';

  const lines = [
    '【剧情选项】',
    `在正文和状态栏之后，另起一行，用「${OPTIONS_LABEL}：A / B / C」的格式给出 ${spec.count} 个选项，` +
      '每个选项之间用「 / 」隔开（就这一行，不要编号、不要再分多行）。',
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
  if (spec.hint) lines.push(`额外要求：${spec.hint}`);
  return lines.join('\n');
}

/**
 * 把最近一条带选项的回复里的选项同步到会话上。
 *
 * 规则：
 *   · 找到**最近**一条提到选项的助手消息就用它 —— 和状态栏一样「最新一轮说了算」；
 *   · 一条都没有就清空（这轮没给，就别把上一轮的旧选项留在面板上误导玩家）；
 *   · 没开剧情选项的会话直接清空并返回。
 * 返回是否发生了变化。
 */
export function syncConvoOptions(convo) {
  if (!convo || !Array.isArray(convo.messages)) return false;

  const before = JSON.stringify(convo.options || []);
  let found = null;

  if (convoOptionsSpec(convo)) {
    for (let i = convo.messages.length - 1; i >= 0; i -= 1) {
      const msg = convo.messages[i];
      if (!msg || msg.role !== 'assistant') continue;
      const content = String(msg.content || '');
      if (!content.includes(OPTIONS_LABEL)) continue;
      const items = extractOptionsFromText(content);
      if (items.length) {
        found = items;
        break;
      }
    }
  }

  convo.options = found || [];
  return before !== JSON.stringify(convo.options);
}
