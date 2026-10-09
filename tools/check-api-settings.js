'use strict';
// ============================================================================
//  tools/check-api-settings.js —— 两处「静默失效」的静态检查
//
//  这个仓库里有过两种不留痕迹的坏法，都不会报错、只会「点了没反应」：
//
//    ① 页面调 `api.xxx()`，而 preload 没暴露 xxx
//       → 执行到那一行才 TypeError，功能看起来就是坏的。
//    ② 页面读写某个设置键，而它**不在 main/providers.js 的 DEFAULT_SETTINGS 里**
//       → 保存时被白名单静默丢掉（注释里记着：autoContinue / commonAttributes
//         当初就是这么漏的，怎么改都不生效，只在主进程打一行没人看的 warn）。
//
//  跑法： node tools/check-api-settings.js
//  两段都输出「(无)」就是好的。
//
//  ⚠️ 启发式正则，不是编译器：宁可漏报也不要误报。
//     （已知误报源：`import '...settings.js'` 这类路径会被当成 `settings.js` 键名。）
// ============================================================================
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------- 1. preload 暴露的 api 键 ----------
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const exposed = new Set();
{
  // exposeInMainWorld('mimitale', { ... }) 的第一层键
  const start = preload.indexOf('exposeInMainWorld');
  const body = preload.slice(start);
  let depth = 0, began = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') { depth++; began = true; continue; }
    if (c === '}') { depth--; if (began && depth === 0) break; continue; }
  }
  // 用逐行法更稳：取对象里所有 `name:` 在 depth==1 的位置
  const lines = body.split('\n');
  let d = 0;
  for (const line of lines) {
    const keyMatch = d === 1 && line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (keyMatch) exposed.add(keyMatch[1]);
    for (const ch of line) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    if (d === 0 && exposed.size) break;
  }
}

// ---------- 2. renderer 里用到的 api.<name> ----------
const rendererFiles = walk(path.join(root, 'renderer'));
const usedApi = new Map();
for (const f of rendererFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)) {
    if (!usedApi.has(m[1])) usedApi.set(m[1], new Set());
    usedApi.get(m[1]).add(path.relative(root, f));
  }
}
// core/api.js 是怎么转发 preload 的
const apiSrc = fs.readFileSync(path.join(root, 'renderer/js/core/api.js'), 'utf8');

console.log('=== ① renderer 调了但 preload 没暴露的 api.* ===');
const missingApi = [...usedApi.keys()].filter((k) => !exposed.has(k) && !apiSrc.includes(k));
console.log(missingApi.length ? missingApi.map((k) => `${k}（用在 ${[...usedApi.get(k)].join('、')}）`).join('\n') : '(无)');

// ---------- 3. DEFAULT_SETTINGS 白名单 ----------
const providers = fs.readFileSync(path.join(root, 'main/providers.js'), 'utf8');
const defaults = new Set();
{
  const i = providers.indexOf('DEFAULT_SETTINGS');
  const body = providers.slice(i, i + 6000);
  const lines = body.split('\n');
  let d = 0;
  for (const line of lines) {
    const km = d === 1 && line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (km) defaults.add(km[1]);
    for (const ch of line) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    if (d === 0 && defaults.size) break;
  }
}

// ---------- 4. renderer 读到的 settings.<key> ----------
const usedKeys = new Map();
for (const f of rendererFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b(?:state\.)?settings(?:\.|\[['"])([A-Za-z_$][\w$]*)/g)) {
    if (!usedKeys.has(m[1])) usedKeys.set(m[1], new Set());
    usedKeys.get(m[1]).add(path.relative(root, f));
  }
  for (const m of src.matchAll(/\bsettings\?\.([A-Za-z_$][\w$]*)/g)) {
    if (!usedKeys.has(m[1])) usedKeys.set(m[1], new Set());
    usedKeys.get(m[1]).add(path.relative(root, f));
  }
}

console.log('');
console.log('=== ② renderer 读了、但不在 DEFAULT_SETTINGS 里的设置键 ===');
console.log(`（白名单共 ${defaults.size} 个键；主进程保存时不在白名单里的键会被丢掉）`);
const missingKeys = [...usedKeys.keys()].filter((k) => !defaults.has(k)).sort();
console.log(missingKeys.length ? missingKeys.map((k) => `${k}（用在 ${[...usedKeys.get(k)].slice(0, 3).join('、')}）`).join('\n') : '(无)');
