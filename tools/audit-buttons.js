'use strict';

// ============================================================================
//  tools/audit-buttons.js —— 「HTML 里有个按钮，但没人绑事件」的检查
//
//  为什么需要它：一个按钮只要**渲染出来且没被禁用**，用户就会去点。点了没反应
//  是纯人肉发现的 bug —— DOM 断言看得出「元素在」，看不出「点了会不会有反应」。
//  2026-09-30 就是这么逮到 #btn-memory-clear（清空全部摘要）：函数还在、
//  按钮还在、`.disabled` 也照常切换，唯独 addEventListener 那一行从来没写过。
//
//  跑法： node tools/audit-buttons.js
//  看两条清单：
//    · NO_CLICK  —— dom.js 登记的 <button>，全仓库找不到它的 addEventListener
//    · UNUSED    —— dom.js 登记了、但整个 renderer 一次都没用过（多半是删了
//                   HTML 忘了删登记，键会静默变成 null）
//
//  ⚠️ 只是提示不是断言：按钮也可能在别处用事件委托（`container.addEventListener`
//  再按 `event.target.closest()` 分派），那种会被误报，看到先 grep 一遍再动手。
// ============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const domSrc = fs.readFileSync(path.join(root, 'renderer/js/core/dom.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');

// dom.js 是**嵌套**结构（el.s.temp / el.c.desc / el.wb.e.keys），键名会重名
// （c.name 和 wb.name 是两个元素），所以只能按「键 → id」逐条查。
const pairs = [...domSrc.matchAll(/(\w+)\s*:\s*\$\('([a-z0-9-]+)'\)/g)].map((m) => [m[1], m[2]]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') && !full.endsWith('core/dom.js')) out.push(full);
  }
  return out;
}
const src = walk(path.join(root, 'renderer/js'))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

const noClick = [];
const unused = [];

for (const [key, id] of pairs) {
  // el.key 或 el.<任意层>.key —— 前缀层数不定，别写死一层
  const accessor = 'el(?:\\.\\w+)*\\.' + key + '\\b';
  if (!new RegExp(accessor).test(src)) {
    unused.push('  ' + key.padEnd(22) + '#' + id);
    continue;
  }
  const bound = new RegExp(accessor + '[^\\n]*addEventListener').test(src);
  const tag = (html.match(new RegExp('<(\\w+)[^>]*id="' + id + '"')) || [])[1];
  if (tag === 'button' && !bound) noClick.push('  ' + key.padEnd(22) + '#' + id);
}

console.log('=== NO_CLICK：登记了按钮，但没人绑事件 ===');
console.log(noClick.length ? noClick.join('\n') : '  (无)');

console.log('\n=== UNUSED：登记了，但 renderer 从没用过（键是 null 也不会报错） ===');
console.log(unused.length ? unused.join('\n') : '  (无)');
