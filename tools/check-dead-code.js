'use strict';
// ============================================================================
//  tools/check-dead-code.js —— 「只声明、没人用」的检查
//
//  为什么需要它：这个仓库经历过几次**改到一半中断**的重构，留下的典型痕迹是：
//    · 加了 `import { x }` 却没删掉同名的本地定义（那会直接让模块解析失败）
//    · 抽走实现之后，旧的局部函数还在
//    · 导出了函数给别人用，但别人早就不用了
//  这些东西不会报错，只会一直烂在那儿（或者在某次改动后突然变成语法错误）。
//
//  检查：
//    ① 渲染层 + 主进程里 `import`/`require` 进来但**整个文件再没出现过**的名字
//    ② 渲染层 `export` 了、但除自己以外没有任何文件 import 的名字
//
//  跑法： node tools/check-dead-code.js
//
//  ⚠️ 这是**启发式**检查（纯文本），不是编译器：
//     · 只认具名导入；`import * as ns` 之后的 `ns.x` 不查
//     · 字符串里出现同名就算「用过」（宁可漏报，不能误报）
//     · 主进程模块常被当成「给别人用的库」导出，所以 ② 只查渲染层
//    因此输出是**待人工确认的线索**，不是必须清零的门禁。
// ============================================================================
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function countUses(code, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return (code.match(re) || []).length;
}

// ---- 谁在用这些导出：渲染层 + tools + HTML 内联脚本 -----------------------
//
// ⚠️ 少了 tools/ 和 HTML 这一层，会把一大批「其实被冒烟测试动态 import 着」的
//    导出误报成死代码（tools/smoke-renderer.js 就大量 `await import(...)` 真模块）。
//    误报比漏报更糟：它会诱导人去删掉正在被测试使用的 API。
function htmlInlineSources() {
  const out = [];
  for (const rel of ['renderer/index.html', 'renderer/pet/pet.html']) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      out.push({ file: rel, code: stripComments(m[1]) });
    }
  }
  return out;
}

// ---- 渲染层：ES module（import / export） ---------------------------------
const rendererFiles = walk(path.join(root, 'renderer'));
const deadImports = [];
const exportedBy = new Map(); // name -> [file]

for (const f of rendererFiles) {
  const raw = fs.readFileSync(f, 'utf8');
  const code = stripComments(raw);
  const rel = path.relative(root, f);

  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      // 声明本身算一次出现，所以「只出现 1 次」= 除了导入行没人用
      if (countUses(code, name) <= 1) deadImports.push(`${rel} 导入了 ${name}，但文件里没再出现`);
    }
  }

  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)) {
    if (!exportedBy.has(m[1])) exportedBy.set(m[1], []);
    exportedBy.get(m[1]).push(rel);
  }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      if (!exportedBy.has(name)) exportedBy.set(name, []);
      exportedBy.get(name).push(rel);
    }
  }
}

// 谁用过这些名字：渲染层的静态 import，加上 tools/ 与 HTML 里出现的名字
// （tools 走动态 import，抓不到绑定名，所以按「名字出现过」宽松判定）
const importedNames = new Set();
for (const f of rendererFiles) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) importedNames.add(name);
    }
  }
}
for (const f of walk(path.join(root, 'tools'), []).concat([path.join(root, 'main.js')])) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) importedNames.add(m[1]);
}
for (const { code } of htmlInlineSources()) {
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) importedNames.add(m[1]);
}

// 导出分两种，别混在一起报：
//   · 真死：外面没人 import，**定义它的文件自己也不用** → 可以删
//   · 多写了 export：外面没人 import，但文件内部在用 → 只是多余的 export 关键字，
//     删了可能反而弄坏（tools/ 里的脚本会 import 这些名字），只提示不动手
const deadExports = [];
const overExported = [];
for (const [name, files] of exportedBy) {
  if (importedNames.has(name)) continue;
  // 入口模块（main.js）本来就没人 import
  if (files.every((f) => /(^|[\\/])main\.js$/.test(f))) continue;

  const selfUses = Math.max(
    ...files.map((rel) => countUses(stripComments(fs.readFileSync(path.join(root, rel), 'utf8')), name))
  );
  const line = `${name}（定义在 ${files.join('、')}）`;
  if (selfUses <= 1) deadExports.push(`${line} 外面没人 import，文件里也没用`);
  else overExported.push(`${line} 只在本文件内部用（export 多余）`);
}

// ---- 主进程：CommonJS 的 require 解构 --------------------------------------
const mainFiles = [
  path.join(root, 'main.js'),
  path.join(root, 'preload.js'),
  path.join(root, 'preload-pet.js'),
  ...walk(path.join(root, 'main'))
];
const deadRequires = [];
for (const f of mainFiles) {
  const raw = fs.readFileSync(f, 'utf8');
  const code = stripComments(raw);
  const rel = path.relative(root, f);
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim();
      if (!name) continue;
      if (countUses(code, name) <= 1) deadRequires.push(`${rel} 解构了 ${name}，但文件里没再出现`);
    }
  }
}

console.log('=== 导入了但没用（疑似改到一半的残留） ===');
console.log(deadImports.length ? deadImports.join('\n') : '(无)');
console.log('');
console.log('=== 主进程 require 了但没用 ===');
console.log(deadRequires.length ? deadRequires.join('\n') : '(无)');
console.log('');
console.log('=== 真死导出：外面没人 import，文件自己也不用 ===');
console.log(deadExports.length ? deadExports.join('\n') : '(无)');
console.log('');
console.log('=== 只用在本文件内却写了 export（多余的关键字，别乱删） ===');
console.log(overExported.length ? overExported.join('\n') : '(无)');

process.exit(deadImports.length || deadRequires.length ? 1 : 0);
