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

// 孤立的拉丁字母片段（模型把格式示例里的「A / B / C」当成标签抄出来了）。
// 单独一个字母当选项毫无意义（界面上也不显示编号），直接丢掉；
// 只丢**单个**字母，「OK」「B超」这种多字组合不受影响。
const STANDALONE_LABEL_RE = /^[A-Za-z]$/;
// 「A. 」「A、」「A: 」这类**字母前缀** —— 标签贴在选项内容前面时剥掉它
const LETTER_PREFIX_RE = /^[A-Za-z]\s*[.、,，)）:：．]\s*/;

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
    // 孤立字母标签先丢（模型把「A / B / C」示例当成要编号时就是这样输出的）
    if (STANDALONE_LABEL_RE.test(item)) continue;
    // 容忍「1. 」「A. 」「① 」「- 」这类前缀和包在引号里
    item = item.replace(/^[-*•·]\s*/, '');
    item = item.replace(/^[①-⑳]\s*/, '');
    item = item.replace(/^\d+\s*[.、)）:：]\s*/, '').replace(LETTER_PREFIX_RE, '');
    item = item.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim();
    if (!item) continue;
    if (item.length > MAX_OPTION_CHARS) item = `${item.slice(0, MAX_OPTION_CHARS)}…`;
    if (!out.includes(item)) out.push(item);
    if (out.length >= MAX_OPTIONS) break;
  }

  return out;
}

/**
 * 「换一批」的指令：上一批剧情选项玩家不满意，让模型按同一套设定再给一批。
 *
 * 关键是要它**别再给和上一批一样的**，否则点了等于没点。所以明确把上一批
 * 列出来，要求避开。选项格式和 optionsInstruction 保持一致（一行、用「 / 」隔开）。
 *
 * 格式示例里给的是**真实内容**而不是「A / B / C」—— 占位字母会被模型照抄，
 * 给每个选项都安上字母标签（输出成「A / 选项一 / B / 选项二 …」），拆出来就是
 * 一堆没头没尾的单字母按钮（实测踩过）。
 */
export function rerollOptionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  const count = spec ? spec.count : 3;

  const previous = (Array.isArray(convo.options) ? convo.options : []).filter(Boolean);
  const avoid = previous.length
    ? `上一批选项是：${previous.map((t) => `「${t}」`).join('、')}。换一批时请避开这些（或至少别原样照搬），给几个明显不一样的做法。\n`
    : '';

  const lines = [
    '【换一批剧情选项】',
    `把上面刚给出的那批剧情选项换掉，重新另起一行，用「【剧情选项】：选项内容 / 选项内容 / 选项内容」的格式给 ${count} 个选项，` +
      '每个选项之间用「 / 」隔开（就这一行，不要编号、不要加 A/B/C 字母标签、不要再分多行）。',
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    '例如：【剧情选项】：走过去抱住她 / 退后一步问她怎么了 / 假装没看见，继续做自己的事。',
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
  if (avoid) lines.push(avoid.trim());
  if (spec && spec.hint) lines.push(`额外要求：${spec.hint}`);
  return lines.join('\n');
}

/** 注入给模型的选项指令（有配置时才注入） */
export function optionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  if (!spec) return '';

  const lines = [
    '【剧情选项】',
    `在正文和状态栏之后，另起一行，用「【${OPTIONS_LABEL}】：选项内容 / 选项内容 / 选项内容」的格式给出 ${spec.count} 个选项，` +
      '每个选项之间用「 / 」隔开（就这一行，不要编号、不要加 A/B/C 字母标签、不要再分多行）。',
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    `例如：【${OPTIONS_LABEL}】：走过去抱住她 / 退后一步问她怎么了 / 假装没看见，继续做自己的事。`,
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
  if (spec.hint) lines.push(`额外要求：${spec.hint}`);

  // 上一轮已经给过的选项，这轮别照抄 —— 局面没怎么变的时候模型会「原地打转」，
  // 一遍遍给出同一批选项（实测：不写这句，玩家连看几轮都是同样的三个）。
  // 「换一批」之所以能换出新东西，就是因为它显式要求避开上一批，这里补上同一句。
  const previous = (Array.isArray(convo.options) ? convo.options : []).filter(Boolean);
  if (previous.length) {
    lines.push(
      `上一轮已经给过：${previous.map((t) => `「${t}」`).join('、')}。` +
        '这次给明显不同的新选项，不要重复上一轮的（局面有推进就更该换）。'
    );
  }

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
