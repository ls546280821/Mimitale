'use strict';
// ============================================================================
//  tools/check-imports.js —— 「导入了但对面没导出」的检查
//
//  为什么需要它：渲染层是原生 ES module，`import { x } from './y.js'` 里只要有一个
//  名字对不上，**整个模块图就链接失败**（页面直接白掉）。而这件事很容易被改出来 ——
//  比如成批清理「只在本文件用的 export」时，把某个其实被别处引用的名字一起去掉。
//
//  跑法： node tools/check-imports.js
//  输出「(无)」就是好的。
//
//  ⚠️ 只做静态名字比对，不认识 `import * as ns` 之后的 `ns.x` —— 现在仓库里没有
//     这种写法（有的话这里会漏报）。真出问题时，浏览器控制台的链接错误最直白。
// ============================================================================
const fs = require('fs');
const path = require('path');

const root = 'E:/工作/Mimitale/renderer/js';
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(root);

const exportsOf = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  // export { a, b }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  exportsOf.set(path.resolve(f), names);
}

const problems = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    const cands = [target, target + '.js', path.join(target, 'index.js')];
    const hit = cands.find((c) => exportsOf.has(c));
    if (!hit) { problems.push(`找不到模块：${path.relative(root, f)} → ${spec}`); continue; }
    const have = exportsOf.get(hit);
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (name && !have.has(name)) {
        problems.push(
          `${path.relative(root, f)} 导入了 ${name}，但 ${path.relative(root, hit)} 没有导出它`
        );
      }
    }
  }
}

console.log('=== 导入/导出对不上的地方 ===');
console.log(problems.length ? problems.join('\n') : '(无)');
