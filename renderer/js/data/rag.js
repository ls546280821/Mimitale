'use strict';

// ============================================================================
//  data/rag.js —— 语义检索（RAG）
//
//  关键词匹配的死角：你写了「十二泰坦」的设定，但对话里说的是「那些神」——
//  那条设定就永远出不来。语义检索按「意思」把相关的旧内容和设定捞回来。
//  配置是独立的一组（服务商 + 模型，走 /embeddings），和聊天、生图都不相干。
//
//  原则和世界书一样：**捞不到就算了**，绝不能让检索失败拦住正常聊天。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { characterForConvo } from './library.js';
import { applyMacros } from './messages.js';
import { convoUserName, effectiveWorldbookIds } from './cast.js';

// 一次最多带几条进来。多了会挤掉真正最近的内容，而且 token 哗哗涨
const RAG_TOP_K = 4;
// 相似度门槛。语义检索最怕「硬凑」——不管相不相关都塞几条进来，
// 上下文被污染了还不如不检索
const RAG_MIN_SCORE = 0.32;
// 拿最近几条拼查询。只用最后一条太窄（比如「嗯」这种），太多又会把主题冲淡
const RAG_QUERY_TURNS = 3;

/** 把捞回来的东西拼成注入块 */
export function formatRagSection(items, character, me) {
  if (!items || !items.length) return '';

  const lines = items.map((item) => {
    if (item.kind === 'worldbook') {
      return `【设定 · ${item.title || '未命名'}】\n${applyMacros(item.text, character, me)}`;
    }
    const who = item.role === 'user' ? me : (character && character.name) || '对方';
    return `【早先 · ${who}】\n${applyMacros(item.text, character, me)}`;
  });

  return (
    '[可能相关的往事]\n' +
    '下面这些是更早的内容或设定，和现在聊的有关，可以用来保持前后一致。' +
    '自然地用，不要直接复述：\n\n' +
    lines.join('\n\n')
  );
}

/** 跑一次检索，拿到可以注入的那一段（失败就返回空字符串，绝不拦着聊天） */
export async function recallSection(convo) {
  const settings = state.settings || {};
  if (settings.ragEnabled !== true || !settings.embeddingProviderId) return '';

  const history = (convo.messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  if (history.length < 2) return '';

  const recent = history.slice(-RAG_QUERY_TURNS);
  const query = recent.map((m) => String(m.content)).join('\n');

  try {
    const result = await api.ragRecall({
      providerId: settings.embeddingProviderId,
      model: settings.embeddingModel,
      convoId: convo.id,
      // 和关键词注入用同一套规则，否则两处会给出不一致的世界书范围
      worldbookIds: effectiveWorldbookIds(convo),
      // 最近这些本来就会进上下文，别捞回来占位置
      recentCount: RAG_QUERY_TURNS * 2,
      query,
      topK: RAG_TOP_K,
      minScore: RAG_MIN_SCORE
    });

    if (!result || result.ok !== true) {
      console.error('语义检索失败', result && result.error);
      return '';
    }
    return formatRagSection(result.items, characterForConvo(convo), convoUserName(convo));
  } catch (err) {
    console.error('语义检索失败', err);
    return '';
  }
}
