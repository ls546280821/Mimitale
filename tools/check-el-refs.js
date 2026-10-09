'use strict';
// ============================================================================
//  tools/check-el-refs.js —— 「视图用了 el.<分组>.<字段>，但 dom.js 里没有」的检查
//
//  dom.js 里的 `el` 是分组的（el.pet / el.wb.e / el.s …）。视图取节点写
//  `el.pet.skin`，字段名一旦对不上就是 `undefined`，下一句
//  `.addEventListener` / `.value` 直接抛错 —— 和拼错 DOM id 是同一类故障。
//
//  跑法： node tools/check-el-refs.js
//  输出「(无)」就是好的。
//
//  ⚠️ 只查「第一个名字正好是 dom.js 里的分组名」这种形态。
//     `el` 也常被当作普通节点或函数参数名（ui/auto-grow.js 的参数就叫 el），
//     去校验 el.<任意节点>.<属性> 会把 addEventListener / classList 全报成问题。
// ============================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

// ---- 1. 从 dom.js 里解析 el 对象的形状（分组 → 字段集合） ----
const domSrc = fs.readFileSync(path.join(root, 'renderer/js/core/dom.js'), 'utf8');
const groups = new Map();   // 分组 -> Set(字段)
const topLevel = new Set(); // 顶层字段

function parseObjectBody(body) {
  const fields = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (m) fields.add(m[1]);
  }
  return fields;
}

// 定位 export const el = { ... } 的最外层大括号
{
  const start = domSrc.indexOf('const el = {');
  if (start < 0) throw new Error('找不到 el 定义');
  let i = domSrc.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < domSrc.length; i++) {
    if (domSrc[i] === '{') depth++;
    else if (domSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const outer = domSrc.slice(domSrc.indexOf('{', start) + 1, end);

  // 逐行扫：顶层 `key:` 或在顶层 `key: {` 的分组
  const lines = outer.split('\n');
  let cur = null;
  let d = 0;
  let buf = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (d === 0) {
      const gm = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/);
      if (gm) { cur = gm[1]; groups.set(cur, new Set()); d = 1; buf = []; continue; }
      const fm = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (fm) topLevel.add(fm[1]);
      continue;
    }
    // 分组内部
    for (const ch of line) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    if (d === 0) {
      groups.get(cur).add(...parseObjectBody(buf.join('\n')));
      // 分组自己的字段：`pet: {` 之后的行都是字段；但上面 parseObjectBody 只认行首 key，
      // 这里补一次（buf 里是分组内容）
      for (const f of parseObjectBody(buf.join('\n'))) groups.get(cur).add(f);
      cur = null;
      buf = [];
      continue;
    }
    buf.push(line);
  }
}

// ---- 2. 视图里用到的 el.<组>.<字段> ----
function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const problems = [];
const usedTop = new Map();
for (const f of jsFiles(path.join(root, 'renderer/js'))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  if (rel.endsWith(path.join('core', 'dom.js'))) continue;

  for (const m of src.matchAll(/\bel\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const [, a, b] = m;
    // ⚠️ 只查「第一个名字正好是 dom.js 里的分组名」这种形态。
    //    别去校验 el.<任意节点>.<属性> —— 那些 el 是普通节点/局部参数
    //    （auto-grow.js 的参数就叫 el），会把 addEventListener、classList 全报成问题。
    if (!groups.has(a)) continue;
    if (!b) continue;
    if (!groups.get(a).has(b)) problems.push(`${rel} 用了 el.${a}.${b}，dom.js 的 el.${a} 里没有 ${b}`);
    if (!usedTop.has(a)) usedTop.set(a, new Set());
    usedTop.get(a).add(b);
  }
}

const uniq = [...new Set(problems)].sort();
console.log('=== 视图用的 el.* 在 dom.js 里找不到 ===');
console.log(`（dom.js 顶层 ${topLevel.size} 个字段、${groups.size} 个分组）`);
console.log(uniq.length ? uniq.join('\n') : '(无)');
