'use strict';

// ============================================================================
//  main/worldbook-match.js —— 世界书的匹配引擎
//
//  「这些话里有没有命中某条设定」这件事全在这里。搬出来独立成模块的原因，
//  和 main/characters.js / main/png.js 一样：tools/smoke-test.js 要 require 同一份代码，
//  这样递归扫描、副关键词、概率这些逻辑测的是真实现，而不是测试里另写一遍。
//
//  这里只做**纯匹配**，不认识文件、不认识 IPC —— 条目从哪来由调用方决定。
// ============================================================================

/**
 * 关键词是否命中。
 * 中日韩文字没有空格分词，只能做子串匹配（酒馆自己也建议这时关掉全词匹配）；
 * 纯拉丁字母的关键词才用词边界，避免 king 命中 liking。
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译过的关键词正则缓存。
 * 匹配是每轮对每个条目每个关键词都跑的，不缓存的话每句话都要重新编译几百次正则。
 * 用户改关键词时字符串会变，键自然失配，所以不用担心缓存过期。
 */
const keywordRegexCache = new Map();
const MAX_KEYWORD_REGEX_CACHE = 4000;

/** 解析 /re/flags 写法；不是正则就返回 null */
function parseRegexKeyword(keyword) {
  if (keyword.length <= 2 || !keyword.startsWith('/')) return null;

  const cached = keywordRegexCache.get(keyword);
  if (cached !== undefined) return cached;

  let compiled = null;
  const lastSlash = keyword.lastIndexOf('/');
  if (lastSlash > 0) {
    const body = keyword.slice(1, lastSlash);
    const flags = keyword.slice(lastSlash + 1);
    if (/^[gimsuy]*$/.test(flags)) {
      try {
        compiled = new RegExp(body, flags);
      } catch (err) {
        // 正则写错了就当普通文本处理，别让一条坏正则废掉整本书
        compiled = null;
      }
    }
  }

  // 上限只是防止畸形文件把缓存撑爆；简单粗暴地整体清空即可
  if (keywordRegexCache.size >= MAX_KEYWORD_REGEX_CACHE) keywordRegexCache.clear();
  keywordRegexCache.set(keyword, compiled);
  return compiled;
}

/** 全词匹配的正则同样值得缓存（中文默认不走这条，主要是英文世界书） */
const wordBoundaryCache = new Map();

function wordBoundaryRegex(keyword) {
  const cached = wordBoundaryCache.get(keyword);
  if (cached !== undefined) return cached;

  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'u');
  if (wordBoundaryCache.size >= MAX_KEYWORD_REGEX_CACHE) wordBoundaryCache.clear();
  wordBoundaryCache.set(keyword, re);
  return re;
}

function keywordHit(haystack, rawKeyword, entry) {
  const keyword = String(rawKeyword || '').trim();
  if (!keyword) return false;

  // 关键词写成 /re/flags 就当正则处理，和酒馆一致
  const asRegex = parseRegexKeyword(keyword);
  if (asRegex) return asRegex.test(haystack);

  const text = entry && entry.caseSensitive ? haystack : haystack.toLowerCase();
  const needle = entry && entry.caseSensitive ? keyword : keyword.toLowerCase();

  if (CJK_RE.test(needle)) return text.includes(needle);
  if (entry && entry.matchWholeWords) return wordBoundaryRegex(needle).test(text);
  return text.includes(needle);
}

/** 把某条目的所有关键词拼成一个正则，用来判断「至少命中一个」还是「全部命中」 */
function anyKeywordHit(haystack, keywords, entry) {
  return keywords.some((k) => keywordHit(haystack, k, entry));
}

function allKeywordsHit(haystack, keywords, entry) {
  return keywords.length > 0 && keywords.every((k) => keywordHit(haystack, k, entry));
}

/** 单条 entry 是否应该被注入 */
function entryMatches(entry, haystack) {
  if (!entry || entry.enabled === false) return false;
  if (!String(entry.content || '').trim()) return false;

  // constant（蓝圈）不需要关键词，永远注入
  if (entry.constant) return true;
  if (!entry.keys.length) return false;

  // 触发概率：100 必中，50 一半概率，0 等于停用
  if (entry.probability < 100 && Math.random() * 100 >= entry.probability) return false;

  if (!anyKeywordHit(haystack, entry.keys, entry)) return false;

  // 附加过滤词（secondary keys）
  if (entry.secondaryKeys.length) {
    const any = anyKeywordHit(haystack, entry.secondaryKeys, entry);
    const all = allKeywordsHit(haystack, entry.secondaryKeys, entry);
    switch (entry.selectiveLogic) {
      case 'AND_ALL':
        if (!all) return false;
        break;
      case 'NOT_ANY':
        if (any) return false;
        break;
      case 'NOT_ALL':
        if (all) return false;
        break;
      case 'AND_ANY':
      default:
        if (!any) return false;
        break;
    }
  }

  return true;
}

/**
 * 扫描文本，返回命中的条目。
 *
 * **递归扫描**（酒馆叫 Recursive Scanning）：
 *   命中一条**勾了「递归」**的条目之后，把它的正文也并进扫描文本再扫一遍 ——
 *   于是它正文里提到的词能触发别的条目，一路连锁下去。比如提到「翁法罗斯」
 *   命中总览，总览里写着「十二泰坦」「火种」，递归就把这两条也带出来了。
 *
 * 代价是 token：每多一层就多塞几条设定进来。所以有两道闸：
 *   · 只有**显式勾了递归**的条目才会往下带（默认不勾）
 *   · 最多连锁 recursiveDepth 层
 *
 * 返回 { hits, rounds, recursiveCount } —— 后两个给「预览命中」显示用，
 * 让用户看得见「这一轮有几条是连锁带进来的」。
 */
function matchWorldbookEntries(entries, scanText, options) {
  const opts = options || {};
  const chainLimit = Math.max(0, Math.min(5, Math.floor(Number(opts.recursiveDepth) || 0)));

  const matched = []; // { entry, round }
  const seen = new Set();
  let text = String(scanText == null ? '' : scanText);

  for (let round = 0; round <= chainLimit; round += 1) {
    const fresh = [];
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      if (entryMatches(entry, text)) fresh.push(entry);
    }
    if (!fresh.length) break;

    for (const entry of fresh) {
      seen.add(entry.id);
      matched.push({ entry, round });
    }

    // 下一轮的扫描文本 = 原来的 + 这一轮里勾了递归的条目正文
    const carried = fresh
      .filter((e) => e.recursive === true)
      .map((e) => String(e.content || '').trim())
      .filter(Boolean);
    if (!carried.length) break;

    text = `${text}\n${carried.join('\n')}`;
  }

  const hits = matched.map((m) => m.entry);
  hits.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.title).localeCompare(String(b.title));
  });

  return {
    hits,
    rounds: matched.length ? Math.max(...matched.map((m) => m.round)) + 1 : 0,
    recursiveCount: matched.filter((m) => m.round > 0).length
  };
}

/** 命中条目拼成注入块 */
function formatWorldbookSection(hits) {
  if (!hits.length) return '';
  const lines = hits.map((e) => `【${e.title}】\n${String(e.content).trim()}`);
  return `[世界设定]\n以下资料与当前对话相关，请自然地运用，不要直接复述：\n\n${lines.join('\n\n')}`;
}

module.exports = { entryMatches, matchWorldbookEntries, formatWorldbookSection, keywordHit };
