'use strict';

// ============================================================================
//  data/expressions.js —— 角色的「表情图」：按回复正文挑一张
//
//  一张卡可以带几张表情图（character.expressions，形状见 main/characters.js）：
//    { name: '害羞', key: 'shy', keywords: ['脸红'], default: true, image: 'data:image/…' }
//
//  挑哪张，按优先级：
//    ① 正文里的显式标签 <emo>shy</emo>（或 <emo>害羞</emo>）—— 模型点名要哪张
//    ② 正文里的关键词：出现表情名或任一触发词
//    ③ 都没命中 → 这张卡标了 default 的那张「默认脸」
//    ④ 再没有 → 角色形象图
//
//  ①②是**扫最近几条助手消息**，从最新一条往回找，第一条命中的就走它 ——
//  这样「这轮没写表情」时上一轮的表情会自然留着，不会每轮闪回默认图。
//  多人在场时，还要求角色名出现在触发词 / 标签**前面一小段**里，
//  否则「A 脸红了」会同时点亮所有人的脸红图。
//
//  纯读：只认传入的 convo / character，不写任何东西。
// ============================================================================

import { characterPortrait } from './library.js';
import { asArray } from '../core/util.js';

// 和 main/characters.js 的 MAX_EXPRESSIONS 同步（那边是落盘的守卫，这边给界面用）
export const MAX_EXPRESSIONS = 30;

// 往回看几条助手消息。太深的话会把很久以前的表情翻出来。
const MAX_SCAN_MESSAGES = 6;
// 触发词前多少字以内出现角色名，算「这句说的是他」
const NAME_WINDOW = 30;

/**
 * 显式指定表情的标签：<emo>shy</emo>。
 * 括号里可以是「情绪键」（shy）也可以是「表情名」（害羞）。
 * 定成模块级的正则常量，是因为**渲染层剥它的时候要用同一个**（data/panel.js），
 * 两处各写一份迟早会对不上。
 */
export const EMO_TAG_RE = /<\s*emo\s*>\s*([^<>\n]{1,32}?)\s*<\s*\/\s*emo\s*>/gi;

/** 正文里的 <emo> 标签全部抹掉 —— 送模型的历史和界面气泡都不该带着它 */
export function stripEmoTags(text) {
  return String(text == null ? '' : text).replace(EMO_TAG_RE, '');
}

/** 一张卡上的表情表（老卡没有这个字段 → 空表） */
export function characterExpressions(character) {
  return asArray(character && character.expressions);
}

/** 一张卡上标了「默认脸」的那条（没标 → null） */
export function defaultExpression(character) {
  for (const item of characterExpressions(character)) {
    if (item && item.default === true && item.image) return item;
  }
  return null;
}

/** 一条表情的全部触发词：表情名本身 + 额外写的词 */
export function expressionTriggers(expression) {
  const name = String((expression && expression.name) || '').trim();
  const extra = asArray(expression && expression.keywords);
  const out = [];
  for (const raw of [name, ...extra]) {
    const word = String(raw || '').trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * 这条回复里说的「他」是什么表情。
 *
 * @param {object} convo
 * @param {object} character 角色卡（角色库的卡或世界书副本）
 * @param {string} characterName 显示用的名字
 * @param {boolean} allowLoose true = 不要求角色名挨着触发词
 *        （场上只有他一个人时用：正文里常直接写「她脸红了」，不带名字）
 * @returns {object|null} 命中的表情条目
 */
export function matchExpression(convo, character, characterName, allowLoose) {
  const entries = characterExpressions(character);
  if (!convo || !entries.length) return null;

  const messages = asArray(convo.messages);
  const name = String(characterName || '').trim();
  const loose = allowLoose === true;

  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < MAX_SCAN_MESSAGES; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const text = String(message.content || '');
    if (!text.trim()) continue;
    scanned += 1;

    // ① 模型点名了要哪张，比猜关键词准，优先
    const tagged = fromTag(text, entries, name, loose);
    if (tagged) return tagged;

    // ② 没点名就扫关键词
    const hit = bestInText(text, entries, name, loose);
    if (hit) return hit;
  }
  return null;
}

/**
 * 状态卡上该显示哪张图。
 * 命中表情 → 表情图；没命中 → 标了默认脸的那张；都没有 → 角色形象
 * （没有形象时 library 会拿头像顶上）。
 *
 * @returns {{ src: string, label: string }} label 是表情名，落到形象图时为空串
 */
export function stateCardPhoto(convo, character, characterName, allowLoose) {
  const hit = matchExpression(convo, character, characterName, allowLoose);
  if (hit && hit.image) return { src: hit.image, label: hit.name };

  const fallback = defaultExpression(character);
  if (fallback) return { src: fallback.image, label: fallback.name };

  return { src: characterPortrait(character), label: '' };
}

/**
 * 正文里的 <emo> 标签：按情绪键（或表情名）取一条。
 * 写了多个标签时以**最后一个**为准 —— 和「最后提到的情绪算数」同一套判断。
 */
function fromTag(text, entries, characterName, allowLoose) {
  let hit = null;

  for (const m of text.matchAll(EMO_TAG_RE)) {
    const raw = String(m[1] || '').trim().toLowerCase();
    if (!raw) continue;

    const found = entries.find(
      (e) =>
        e &&
        e.image &&
        ((e.key && e.key === raw) || String(e.name || '').trim().toLowerCase() === raw)
    );
    if (!found) continue;

    // 场上不止一个人时，标签也得挨着角色名 —— 否则一个人的标签会点亮所有人
    if (!allowLoose) {
      const near =
        !!characterName &&
        text.slice(Math.max(0, m.index - NAME_WINDOW), m.index).includes(characterName);
      if (!near) continue;
    }

    hit = found;
  }

  return hit;
}

/** 一段正文里最该显示的那条表情（按关键词） */
function bestInText(text, entries, characterName, allowLoose) {
  let best = null;

  for (const expression of entries) {
    // 没图的条目显示不出东西，不参与匹配
    if (!expression || !expression.image) continue;

    for (const trigger of expressionTriggers(expression)) {
      const index = text.lastIndexOf(trigger);
      if (index < 0) continue;

      const near =
        !!characterName &&
        text.slice(Math.max(0, index - NAME_WINDOW), index).includes(characterName);
      // 场上不止一个人时，没点名的触发词不算数
      if (!near && !allowLoose) continue;

      const candidate = { expression, index, length: trigger.length, near };
      if (!best || beats(candidate, best)) best = candidate;
    }
  }

  return best ? best.expression : null;
}

/** 点名过的优先；其次出现位置更靠后的；再次触发词更长的 */
function beats(a, b) {
  if (a.near !== b.near) return a.near;
  if (a.index !== b.index) return a.index > b.index;
  return a.length > b.length;
}
