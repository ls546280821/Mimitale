'use strict';
// ============================================================================
//  tools/check-dom-ids.js —— 「JS 抓了这个 id，但 HTML 里没有」的检查
//
//  为什么需要它：core/dom.js 在**模块加载时**就用 `$('id')` 把节点抓齐。
//  任何一个 id 拼错、或改 HTML 时漏改，那一项就是 `null`，后面
//  `el.xxx.addEventListener(...)` 直接抛错 —— 症状是整个界面起不来
//  （或掉进「启动失败」兜底页），而报错位置离真正的错处很远。
//
//  跑法： node tools/check-dom-ids.js
//  两段都输出「(无)」就是好的。
// ============================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function idsIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/\bid\s*=\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bid\s*=\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

function referencedIds(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      for (const [k, v] of referencedIds(p)) {
        if (!out.has(k)) out.set(k, new Set());
        v.forEach((x) => out.get(k).add(x));
      }
    } else if (f.name.endsWith('.js')) {
      const src = fs.readFileSync(p, 'utf8');
      const rel = path.relative(root, p);
      for (const m of src.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)) {
        if (!out.has(m[1])) out.set(m[1], new Set());
        out.get(m[1]).add(rel);
      }
    }
  }
  return out;
}

function report(label, htmlFile, jsDir) {
  const have = idsIn(path.join(root, htmlFile));
  const used = referencedIds(path.join(root, jsDir));
  // 只关心 dom.js 里那批（模块加载期就要抓到），其余动态创建的单独列
  const missing = [...used.keys()].filter((id) => !have.has(id)).sort();
  console.log(`=== ${label}：引用了但 HTML 里没有的 id ===`);
  console.log(`（HTML 共 ${have.size} 个 id，JS 引用 ${used.size} 个）`);
  console.log(missing.length
    ? missing.map((id) => `  ${id}  ← ${[...used.get(id)].join('、')}`).join('\n')
    : '  (无)');
  console.log('');
}

report('主界面', 'renderer/index.html', 'renderer/js');
report('宠物窗口', 'renderer/pet/pet.html', 'renderer/pet');
