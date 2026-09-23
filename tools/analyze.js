'use strict';

// ============================================================================
//  tools/analyze.js —— 渲染层的静态体检（给重构用）
//
//  跑法：
//      node tools/analyze.js                 体检 renderer/js/main.js
//      node tools/analyze.js 路径/文件.js      体检别的文件
//
//  它算什么：
//    · 真实行数（换行符口径 —— 和编辑器看到的行号一致）
//    · 顶层函数清单 + 每个函数的起止行
//    · fan-in：哪些函数被最多的**不同分区**调用（这些就是必须先抽的公共层）
//    · 跨分区调用对：谁和谁互相需要（拆文件时这些会变成循环 import）
//    · 结构相似度：找出「同一套逻辑抄了两遍」的函数对（≥60% 才报）
//
//  为什么要留着它：这份文档里的体检数据来自一次性脚本，脚本丢了之后
//  文件一长、行号一飘，数据就没法更新了。这个工具就是为了让它可复现。
//
//  ⚠️ 两个坑（写的时候都踩过）：
//    1. 别忘了词法遮罩 —— 不遮的话注释和字符串里的标识符会被当成调用，
//       fan-in 和相似度全是噪声
//    2. 函数结束位置**必须按大括号配对算**，不能靠「下一个函数的行号」推断 ——
//       遇到大段常量/对象字面量就会把范围拉飞（第一版就是这么错的）
// ============================================================================

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || 'renderer/js/main.js';
const abs = path.isAbsolute(target) ? target : path.join(__dirname, '..', target);

if (!fs.existsSync(abs)) {
  console.error(`找不到文件：${target}`);
  console.error('用法：node tools/analyze.js [要体检的文件，默认 renderer/js/main.js]');
  process.exit(1);
}

const src = fs.readFileSync(abs, 'utf8');

// ---------- 词法遮罩：注释和字符串抹成空白（保留换行，好算行号）----------
function mask(text) {
  const out = text.split('');
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];

    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    // 字符串里：抹掉内容，但保留换行和转义后的字符位置
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out[i] = ' '; if (text[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
    if (c === quote) { state = 'code'; i++; continue; }
    if (c !== '\n') out[i] = ' ';
    i++;
  }
  return out.join('');
}

const masked = mask(src);
const lines = src.split('\n');
const lineAt = (pos) => masked.slice(0, pos).split('\n').length;

// ---------- 函数定义 + 大括号配对求结束 ----------
const funcs = [];
const defRe = /(^|\n)[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
let m;
while ((m = defRe.exec(masked))) {
  const name = m[2];
  const startLine = lineAt(m.index);
  const open = masked.indexOf('{', m.index + m[0].length);
  if (open < 0) continue;
  let depth = 0;
  let close = -1;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === '{') depth++;
    else if (masked[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
  }
  if (close < 0) continue;
  funcs.push({ name, startLine, endLine: lineAt(close) });
}

// ---------- 分区：两种横幅格式都要认 ----------
//   ① 成对：  // ----------  /  // 标题  /  // ----------
//   ② 自闭合：// ---------- 标题 ----------
// 标题不一定是单行（有的写两三行说明），所以距离是 2 或 3 都算。
const dashLines = [];
lines.forEach((ln, i) => {
  if (!/^\/\/ -{10,}/.test(ln)) return;
  dashLines.push({ idx: i, pure: /^\/\/ -+\s*$/.test(ln) });
});

const banners = [];
for (let k = 0; k < dashLines.length; k++) {
  const cur = dashLines[k];
  if (!cur.pure) {
    // 自闭合格式：标题就在这一行里
    const title = cur.idx >= 0 ? lines[cur.idx].replace(/^\/\/\s*-+\s*/, '').replace(/\s*-+\s*$/, '').trim() : '';
    if (title) banners.push({ line: cur.idx + 1, title });
    continue;
  }
  // 成对格式：找下一个纯横线，距离 2~3 就取中间那几行当标题
  for (let j = k + 1; j < dashLines.length; j++) {
    if (!dashLines[j].pure) continue;
    const gap = dashLines[j].idx - cur.idx;
    if (gap >= 2 && gap <= 3) {
      const title = lines
        .slice(cur.idx + 1, dashLines[j].idx)
        .map((s) => s.replace(/^\/\/\s*/, '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (title) banners.push({ line: cur.idx + 2, title });
    }
    break;
  }
}
const sectionOf = (line) => {
  let cur = '(文件头)';
  for (const b of banners) if (b.line <= line) cur = b.title;
  return cur;
};
for (const f of funcs) f.section = sectionOf(f.startLine);

// ---------- 输出 ----------
const bar = (s) => console.log(`\n=== ${s} ===`);
console.log(`文件: ${path.relative(path.join(__dirname, '..'), abs)}`);
console.log(`行数: ${lines.length}（换行符口径）`);
console.log(`顶层/嵌套 function: ${funcs.length}`);
console.log(`分区: ${banners.length} 个`);

bar('分区清单');
banners.forEach((b) => console.log(`  ${String(b.line).padStart(5)}  ${b.title}`));

bar('fan-in 排名（被多少个不同分区调用）—— 这些是必须先抽的公共层');
const fanIn = new Map();
const byName = new Map(funcs.map((f) => [f.name, f]));
for (const f of funcs) {
  const text = lines.slice(f.startLine - 1, f.endLine).join('\n');
  for (const g of funcs) {
    if (g.name === f.name || g.section === f.section) continue;
    if (!new RegExp(`\\b${g.name.replace(/\$/g, '\\$')}\\b`).test(text)) continue;
    if (!fanIn.has(g.name)) fanIn.set(g.name, new Set());
    fanIn.get(g.name).add(f.section);
  }
}
[...fanIn.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 20).forEach(([name, set]) => {
  console.log(`  ${String(set.size).padStart(2)}  ${name.padEnd(26)} 行 ${byName.get(name).startLine}`);
});

bar('跨分区调用对 —— 拆文件时这些会变成循环 import');
const pairCount = new Map();
for (const f of funcs) {
  const text = lines.slice(f.startLine - 1, f.endLine).join('\n');
  for (const g of funcs) {
    if (g.name === f.name || g.section === f.section) continue;
    if (!new RegExp(`\\b${g.name.replace(/\$/g, '\\$')}\\b`).test(text)) continue;
    const key = [f.section, g.section].sort().join('  ↔  ');
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }
}
[...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${String(v).padStart(2)}  ${k}`));
console.log(`  （共 ${pairCount.size} 对）`);

bar('结构相似的函数对（≥60%）—— 同一套逻辑抄了两遍的地方');
const ID = (body) => body.replace(/\b[A-Za-z_$][\w$]*\b/g, 'ID').replace(/\s+/g, ' ').trim();
const sigs = funcs
  .map((f) => ({ ...f, sig: ID(mask(lines.slice(f.startLine - 1, f.endLine).join('\n'))) }))
  .filter((f) => f.sig.length > 100);
const jac = (a, b) => {
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};
const pairs = [];
for (let i = 0; i < sigs.length; i++) {
  for (let j = i + 1; j < sigs.length; j++) {
    if (sigs[i].sig === sigs[j].sig) { pairs.push({ a: sigs[i], b: sigs[j], sim: 100 }); continue; }
    const s = jac(sigs[i].sig, sigs[j].sig);
    if (s >= 0.6) pairs.push({ a: sigs[i], b: sigs[j], sim: Math.round(s * 100) });
  }
}
pairs.sort((x, y) => y.sim - x.sim).slice(0, 15).forEach((p) =>
  console.log(`  ${String(p.sim).padStart(3)}%${p.sim === 100 ? ' ★结构完全相同' : '              '} ${p.a.name} (行 ${p.a.startLine})  ~  ${p.b.name} (行 ${p.b.startLine})`));
console.log(`  共 ${pairs.length} 对`);
