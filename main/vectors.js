'use strict';

// ============================================================================
//  main/vectors.js —— 语义检索用的向量小工具
//
//  三件事：向量怎么存（Float32 ↔ base64）、怎么比（余弦相似度）、怎么挑（topK + 阈值）。
//
//  纯计算，不碰网络也不碰文件 —— 这样 tools/smoke-test.js 能 require 同一份代码来测，
//  而不是在测试里另写一套相似度算法（那种测法测不出真实现算错了）。
// ============================================================================

const crypto = require('node:crypto');

/** 内容指纹：内容变了指纹就变，缓存自然失效，不用手动清 */
function hashText(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * 向量存成 base64 的 Float32。
 * 1536 维按 JSON 数字存大概 20KB，按 Float32 是 6KB —— 存几百条差距很明显，
 * 而 conversations.json / vectors.json 都是每次改动整份重写的。
 */
function encodeVector(values) {
  const array = values instanceof Float32Array ? values : Float32Array.from(values || []);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
}

function decodeVector(text) {
  const buffer = Buffer.from(String(text || ''), 'base64');
  // 长度必须是 4 的倍数，否则根本不是我们存的东西
  if (!buffer.length || buffer.length % 4 !== 0) return null;
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/**
 * 余弦相似度。
 * 用余弦而不是欧氏距离，是因为这样**不用管向量归没归一化** ——
 * 有的服务商返回的是归一化过的，有的不是，各家不一样。
 */
function cosineSimilarity(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 按相似度挑前 K 个。
 *
 *   candidates  [{ key, vector, ... }]
 *   exclude     要跳过的 key（比如最近几条消息 —— 它们本来就会进上下文，捞回来是浪费）
 *   minScore    低于这个分一律不要
 *
 * 阈值这道闸很重要：语义检索最怕「硬凑」——不管相不相关都塞几条进来，
 * 结果上下文被一堆沾不上边的东西污染，比不检索还差。
 */
function rankBySimilarity(queryVector, candidates, options) {
  const opts = options || {};
  const topK = Math.max(1, Math.floor(Number(opts.topK) || 4));
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.3;
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);

  const scored = [];
  for (const item of candidates || []) {
    if (!item || exclude.has(item.key)) continue;
    const score = cosineSimilarity(queryVector, item.vector);
    if (!Number.isFinite(score) || score < minScore) continue;
    scored.push({ ...item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * 收集语义检索的候选文本。
 *
 * 纯函数（不读文件），输入是已经读出来的会话和世界书 —— 这样测试能直接喂数据进来，
 * 而不用去建一堆临时文件。真正的文件读取留在 main.js 里。
 *
 *   messages      这个会话的全部消息
 *   recentCount   末尾几条要跳过（它们本来就会进上下文，捞回来是白占位置）
 *   books         世界书列表
 *   worldbookIds  这个会话绑定了哪几本
 */
function collectCandidates(options) {
  const opts = options || {};
  const out = [];

  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const skip = Math.max(0, Math.floor(Number(opts.recentCount) || 0));

  // 先把「可用的消息」挑出来，再按 skip 切尾巴。
  // 不能直接对原始数组 slice —— 数组里还有 error 消息和空白消息（生成失败就会留一条），
  // 直接切的话跳过的那几条会偏，结果「最近的内容」被当成往事捞回来。
  const usable = messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  for (const m of usable.slice(0, Math.max(0, usable.length - skip))) {
    const text = String(m.content).trim();
    out.push({ kind: 'message', key: `m:${hashText(text)}`, text, role: m.role });
  }

  const wanted = Array.isArray(opts.worldbookIds) ? opts.worldbookIds : [];
  const books = Array.isArray(opts.books) ? opts.books : [];
  for (const book of books) {
    if (!book || !wanted.includes(book.id)) continue;
    for (const entry of book.entries || []) {
      const text = String(entry && entry.content ? entry.content : '').trim();
      if (!text) continue;
      out.push({
        kind: 'worldbook',
        key: `w:${book.id}:${entry.id}`,
        text,
        title: String(entry.title || '')
      });
    }
  }

  return out;
}

module.exports = {
  hashText,
  encodeVector,
  decodeVector,
  cosineSimilarity,
  rankBySimilarity,
  collectCandidates
};
