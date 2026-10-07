'use strict';

// ============================================================================
//  main/search.js —— 联网搜索（博查 Web Search API）
//
//  走 main/http.js 那个通用 JSON 请求，不引第三方库，和聊天 / 生图一样。
//
//  端点：POST https://api.bochaai.com/v1/web-search
//  请求头：Authorization: Bearer <key>
//  请求体：{ query, count, summary, freshness }
//  响应：{ data: { webPages: { value: [{ name, url, snippet, summary, siteName, datePublished }] } } }
//        （博查这套字段和 Bing Search API 对齐，也有部署不带外层 data，两种都认。）
//
//  这一层只负责「把网页搜出来、整理成统一形状」，拼进提示词、怎么展示都由渲染层决定。
// ============================================================================

const { requestJson } = require('./http.js');

const SEARCH_ENDPOINT = 'https://api.bochaai.com/v1/web-search';

// 查询词的上限。搜索接口按字数计费，而且太长的自然语句反而搜不准 ——
// 调用方（data/search.js）已经把最后一条用户消息削过一遍，这里是第二道闸。
const MAX_QUERY_CHARS = 200;

// 一次最多带几条结果进上下文。条数越多上下文越挤，6 条是个够用又不吵的量。
const MAX_COUNT = 10;
const DEFAULT_COUNT = 6;

// 时间范围。空串 = 不限（归一化时会把不认识的值落回 noLimit）。
const FRESHNESS_VALUES = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'];

/** 把一条搜索结果整理成内部形状（字段缺失就是空串，不返回 undefined） */
function normalizeItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const url = String(item.url || '').trim();
  if (!url) return null;

  // snippet 是搜索引擎给的摘要片段，summary 是博查额外生成的更长摘要。
  // 优先用 summary（信息更全），没有才退回 snippet。
  const text = String(item.summary || item.snippet || '').trim();

  return {
    title: String(item.name || item.title || '').trim() || url,
    url,
    site: String(item.siteName || item.displayUrl || '').trim(),
    date: String(item.datePublished || item.dateLastCrawled || '').trim(),
    text: text.length > 800 ? `${text.slice(0, 800)}…` : text
  };
}

/** 从响应里把结果列表挖出来 —— 两种常见包法都认 */
function extractItems(json) {
  const root = json && typeof json === 'object' ? json : {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  const pages = data.webPages && typeof data.webPages === 'object' ? data.webPages : data;
  const list = Array.isArray(pages.value) ? pages.value : Array.isArray(pages) ? pages : [];
  return list.map(normalizeItem).filter(Boolean);
}

/**
 * 搜一次网页。
 *
 * 返回 { query, count, items }。item = { title, url, site, date, text }。
 * 失败一律抛 Error（调用方包成 { ok:false, error } 交给界面）。
 */
async function webSearch({ apiKey, query, count, freshness, timeoutMs = 20000 }) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('还没有填写博查的 API Key。');

  const q = String(query || '').trim().slice(0, MAX_QUERY_CHARS);
  if (!q) throw new Error('没有可用来搜索的内容。');

  let n = Number(count);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_COUNT;
  n = Math.max(1, Math.min(MAX_COUNT, Math.floor(n)));

  const fresh = FRESHNESS_VALUES.includes(String(freshness || '')) ? String(freshness) : 'noLimit';

  const json = await requestJson({
    url: SEARCH_ENDPOINT,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      // 有的网关对没有 UA 的请求直接拒（403/406），和 http.js 里聊天那套保持一致
      'User-Agent': 'Mimitale/1.0 (+https://github.com/ls546280821/Mimitale)'
    },
    body: {
      query: q,
      count: n,
      // 不开博查自己的「AI 摘要」：那要额外计费，而且我们的模型自己会总结。
      // 每条结果里的 snippet/summary 字段本来就有，够用了。
      summary: false,
      freshness: fresh
    },
    timeoutMs
  });

  // 博查在 HTTP 200 里也可能带业务错误码，别当成「搜到了 0 条」
  const code = Number(json && json.code);
  if (Number.isFinite(code) && code !== 200) {
    const msg = String((json && json.msg) || (json && json.message) || '').trim();
    throw new Error(`搜索服务返回错误（code ${code}）${msg ? `：${msg}` : ''}`);
  }

  const items = extractItems(json);
  return { query: q, count: items.length, items };
}

module.exports = {
  SEARCH_ENDPOINT,
  FRESHNESS_VALUES,
  DEFAULT_COUNT,
  MAX_COUNT,
  normalizeItem,
  extractItems,
  webSearch
};
