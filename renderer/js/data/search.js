'use strict';

// ============================================================================
//  data/search.js —— 联网搜索（把搜索结果拼成注入段 + 存一份来源给界面用）
//
//  和 data/rag.js 一个路子：发送前异步取一段文本，交给 buildApiMessages 注入。
//  原则也一样 —— **搜不到就算了**，绝不让搜索失败拦住正常聊天。
//
//  两个开关都开才搜：
//    · 设置里的「联网搜索」是总闸（默认关：搜一次单独计费，得让人知道在花钱）
//    · 会话上的 convo.webSearch 是这一局自己的开关（输入框旁边那颗按钮）
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';

// 查询词上限。搜索按字数计费，而且整段自然语句反而搜不准
const MAX_QUERY_CHARS = 120;
// 太短的输入（「嗯」「继续」）单独拿去搜等于乱搜，得往前再捞几条凑上下文
const MIN_QUERY_CHARS = 6;
// 往前最多看几条用户消息来凑查询
const QUERY_LOOKBACK = 3;
// 每条结果注入进上下文的摘要上限。整页正文太占位置，摘要够模型判断相关就行了
const MAX_ITEM_CHARS = 500;

/** 这一局要不要联网：总闸 + 会话开关都得开 */
export function webSearchOn(convo) {
  if ((state.settings || {}).searchEnabled !== true) return false;
  return !!(convo && convo.webSearch === true);
}

/** 用最近几条用户消息拼查询词（最新那条为主） */
export function buildSearchQuery(convo) {
  const said = (convo && Array.isArray(convo.messages) ? convo.messages : [])
    .filter((m) => m && m.role === 'user' && String(m.content || '').trim())
    .slice(-QUERY_LOOKBACK);
  if (!said.length) return '';

  const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const last = tidy(said[said.length - 1].content);
  if (last.length >= MIN_QUERY_CHARS) return last.slice(0, MAX_QUERY_CHARS);

  // 太短：把前面几轮一起带上。只用「嗯」这种词搜出来的东西完全无关，
  // 反而把上下文弄脏 —— 宁可搜得宽一点。
  const merged = said.map((m) => tidy(m.content)).filter(Boolean).join(' ');
  return merged.slice(0, MAX_QUERY_CHARS);
}

/**
 * 把搜到的结果拼成注入段。
 *
 * 序号 [1][2] 是给它**引用**用的 —— 界面上那条回复下面的来源列表按同一个序号排，
 * 正文里写了 [2] 就能对上第 2 条来源。
 */
function formatSearchSection(items, query) {
  if (!items.length) return '';

  const lines = items.map((item, i) => {
    const meta = [item.site, item.date].filter(Boolean).join(' · ');
    const text = String(item.text || '').trim();
    const summary = text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text;
    return [
      `[${i + 1}] ${item.title || item.url}${meta ? `（${meta}）` : ''}`,
      `链接：${item.url}`,
      summary ? `摘要：${summary}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  });

  return (
    '【联网搜索结果】\n' +
    `下面这些是刚刚为你搜到的网页内容（查询词：${query}）。` +
    '这些是你原本不知道的实时信息，回答时请优先依据它们；如果它们和你的记忆冲突，以这里为准。\n' +
    '引用某一条时在句末标出它的序号，例如 [1]。只标真正用到的，不要罗列全部来源，也不要说「根据搜索结果」。\n\n' +
    lines.join('\n\n')
  );
}

/**
 * 跑一次搜索。
 *
 * 返回 { section, sources, query }：
 *   · section —— 拼好的注入段（没搜 / 搜不到 / 失败都是空串）
 *   · sources —— 给界面列来源用的 [{ title, url, site }]
 * 任何一步出问题都只是「这次没有搜索结果」，不抛异常。
 */
export async function searchSection(convo) {
  const empty = { section: '', sources: [], query: '' };
  if (!webSearchOn(convo)) return empty;

  const query = buildSearchQuery(convo);
  if (!query) return empty;

  try {
    const result = await api.webSearch({ query });
    if (!result || result.ok !== true) {
      console.error('联网搜索失败', result && result.error);
      return { ...empty, query };
    }

    const items = Array.isArray(result.items) ? result.items.filter((it) => it && it.url) : [];
    if (!items.length) return { ...empty, query };

    return {
      query,
      section: formatSearchSection(items, query),
      sources: items.map((it) => ({ title: it.title || it.url, url: it.url, site: it.site || '' }))
    };
  } catch (err) {
    console.error('联网搜索失败', err);
    return { ...empty, query };
  }
}
