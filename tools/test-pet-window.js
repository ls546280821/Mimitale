'use strict';

// ============================================================================
//  tools/test-pet-window.js —— 桌宠「接线」的专项测试（纯 Node，不需要 Electron 运行时）
//
//  为什么单独一个文件：2026-10-09 桌宠连续炸在两个**接线**问题上，而当时项目里
//  另外三个测试全绿 —— 因为谁都没覆盖到这两处：
//
//    1. renderer/pet/cat-figure.js 里 `box` 被声明了两次 → **语法错误** →
//       整个模块解析失败 → pet.js 一行都不执行（猫、气泡、鼠标穿透、右键菜单
//       全没了，窗口就是一块透明的空壳）。
//       这是**加载期**的错误：test-pet-store.js 只测纯逻辑；冒烟测试只跑主界面
//       （假后端根本不建宠物窗口），两边都碰不到宠物页面的模块图。
//
//    2. main/pet-window.js 的 buildPetStatePayload 忘了写进 module.exports，
//       而 main/pet-ipc.js 直接解构它 → `pet:state:get` 每次抛 TypeError →
//       宠物页面 pullState() 永远拿不到状态。
//
//  这两类问题的共同点：**出错的地方是「两个文件对不对得上」，静态看着都好、
//  跑起来才知道**。所以这个文件用「静态核对 + 真让 Node 解析一遍」把她们钉住，
//  一秒内跑完。
//
//  跑法：
//    node tools/test-pet-window.js
//
//  ⚠️ 它只读源码、只用 `node --check` **解析**（不执行）宠物页面那几个模块，
//     所以既不碰 electron、也不碰你的真实数据（项目里出过拿真实 userData
//     做实测、把 conversations.json 覆盖掉的事故，别再犯）。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PET_DIR = path.join(ROOT, 'renderer', 'pet');

// ---- 断言器：和项目里其他专项测试同一口径（认失败数） ----
let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
//  小工具：从源码里静态抠东西（不执行任何模块）
// ---------------------------------------------------------------------------

/** 抠出 `require('<modulePath>')` 左边那个解构块的变量名 */
function destructuredFrom(src, modulePath) {
  const at = src.indexOf(`require('${modulePath}')`);
  if (at < 0) return null;
  const open = src.lastIndexOf('{', at);
  const close = src.lastIndexOf('}', at);
  if (open < 0 || close < 0 || close > at) return null;
  return src
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/**
 * 抠出 `module.exports = { ... }` 里的键。
 * 只认「一层花括号、逗号分隔的标识符」这一种写法 —— 配合下面
 * 「至少抠出一个名字」的断言，写法一变就当场暴露，而不是静默失效。
 */
function exportedNames(src) {
  const at = src.indexOf('module.exports');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return null;
  return src
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/**
 * 让 Node 去**解析**一个模块（`--check`，只解析不执行）。
 *
 * 为什么用子进程而不是 import()：
 *   · import() 会真的执行模块，pet.js 一进来就摸 document，在 Node 里必崩 ——
 *     那就分不清「语法坏了」和「这个环境跑不起来」，而只有前者是我们要抓的；
 *   · import() 对这几个文件还会吐 MODULE_TYPELESS_PACKAGE_JSON 警告刷屏；
 *   · --check 不执行任何一行，所以 pet.js 这种要 DOM 的也能照样查。
 */
function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) return { ok: true, detail: '' };
  const detail = String(result.stderr || '')
    .split('\n')
    .find((line) => /Error|error/.test(line)) || '解析失败';
  return { ok: false, detail: detail.trim() };
}

const petIpcSrc = read('main/pet-ipc.js');
const petWindowSrc = read('main/pet-window.js');
const preloadPetSrc = read('preload-pet.js');
const preloadMainSrc = read('preload.js');
const petContextSrc = read('renderer/js/data/petContext.js');
const petSettingsSrc = read('renderer/js/views/petSettings.js');
const petJs = read('renderer/pet/pet.js');

// ---------------------------------------------------------------------------
section('main/pet-ipc.js ⇄ main/pet-window.js 的导出对得上');

const wanted = destructuredFrom(petIpcSrc, './pet-window.js');
ok(Array.isArray(wanted) && wanted.length > 0, '能在 pet-ipc.js 里找到 pet-window.js 的解构块');

const exported = exportedNames(petWindowSrc);
ok(Array.isArray(exported) && exported.length > 0, '能解析出 pet-window.js 的 module.exports');

if (Array.isArray(wanted) && Array.isArray(exported)) {
  const missing = wanted.filter((name) => !exported.includes(name));
  ok(
    missing.length === 0,
    `pet-ipc.js 解构的每个名字都被导出了${missing.length ? `（缺：${missing.join(', ')}）` : ''}`
  );
  // 2026-10-09 那个 TypeError 的直接回归断言
  ok(
    wanted.includes('buildPetStatePayload') && exported.includes('buildPetStatePayload'),
    'buildPetStatePayload 两边都有（pet:state:get 直接调它）'
  );
}

// ---------------------------------------------------------------------------
section('preload-pet.js ⇄ main/pet-ipc.js 的通道对得上');

const channelsFromPreload = [
  ...new Set(
    [...preloadPetSrc.matchAll(/ipcRenderer\.(?:send|invoke)\(\s*'([^']+)'/g)].map((m) => m[1])
  )
];
ok(channelsFromPreload.length > 0, '能从 preload-pet.js 里读出宠物页面用的通道');

for (const channel of channelsFromPreload) {
  const handled =
    petIpcSrc.includes(`ipcMain.handle('${channel}'`) || petIpcSrc.includes(`ipcMain.on('${channel}'`);
  ok(handled, `通道 ${channel} 在主进程注册过 handler`);
}

// 反向：注册了却没人调的宠物通道 = 白注册（名字打错就会这样）
const registered = [
  ...new Set(
    [...petIpcSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((c) => c.startsWith('pet:'))
  )
];
ok(registered.length > 0, '能从 pet-ipc.js 里读出注册过的宠物通道');
for (const channel of registered) {
  // 一半通道给宠物窗口（preload-pet.js），一半给主界面（preload.js）
  const outlet = channelsFromPreload.includes(channel) || preloadMainSrc.includes(`'${channel}'`);
  ok(outlet, `通道 ${channel} 有出口（宠物窗口或主界面）`);
}

// ---------------------------------------------------------------------------
section('宠物页面的模块能被解析（语法错误会让整页失效）');

const petModules = fs
  .readdirSync(PET_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();
ok(petModules.length > 0, 'renderer/pet 下有可检查的模块');
for (const file of petModules) {
  const result = syntaxCheck(path.join(PET_DIR, file));
  ok(result.ok, `${file} 能被解析${result.ok ? '' : `：${result.detail}`}`);
}

// ---------------------------------------------------------------------------
section('宠物窗口那五个「改了就坏」的窗口参数');

const createSrc = petWindowSrc.slice(
  petWindowSrc.indexOf('function createPetWindow'),
  petWindowSrc.indexOf('function destroyPetWindow')
);
ok(createSrc.length > 0, '能定位到 createPetWindow');

ok(/transparent:\s*true/.test(createSrc), 'transparent:true（关掉会变成白底方板）');
ok(/frame:\s*false/.test(createSrc), 'frame:false（关掉会多一条标题栏）');
ok(/skipTaskbar:\s*true/.test(createSrc), 'skipTaskbar:true（关掉任务栏会多一条）');
ok(/hasShadow:\s*false/.test(createSrc), 'hasShadow:false（关掉会投出一圈方形阴影）');
ok(
  /setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(createSrc),
  "置顶级别是 'screen-saver'（普通 alwaysOnTop 会被别的窗口盖住）"
);
ok(
  /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(createSrc),
  '默认穿透 + 转发移动事件（不做就在桌面上留一块点击死区）'
);
ok(/contextIsolation:\s*true/.test(createSrc), 'contextIsolation:true');
ok(/nodeIntegration:\s*false/.test(createSrc), 'nodeIntegration:false');
// 设计记录 / CHANGELOG 写的是「contextIsolation:true + sandbox:true 全开」，
// 主窗口 main/window.js 又是默认 true —— 宠物窗口不该比主窗口更宽松
ok(/sandbox:\s*true/.test(createSrc), 'sandbox:true（和设计记录一致，别比主窗口更宽松）');
ok(!/sandbox:\s*false/.test(createSrc), 'sandbox 没有被关掉');

// ---------------------------------------------------------------------------
section('「隐藏 = 不说话」这条口径');

// 判断层（渲染层）的闸门
ok(/if\s*\(!pet\.visible\)/.test(petContextSrc), 'maybePetAutoSpeak 里有 pet.visible 这道闸门');
// 闸门必须排在**轮数计数之前**：否则隐藏期间会照攒轮数，
// 重新显示的那一刻立刻蹦一句，看起来还是「隐藏没用」
{
  const gateAt = petContextSrc.indexOf('if (!pet.visible)');
  const countAt = petContextSrc.indexOf('turnCounters.set(convo.id, done)');
  ok(gateAt > 0 && countAt > gateAt, 'visible 闸门排在轮数计数之前（隐藏期间不攒轮数）');
}
// 主进程再挡一道：主界面那份缓存可能晚一拍，而这里读的是刚落盘的 config
ok(
  /reason === 'auto' && !pet\.visible/.test(petIpcSrc),
  'speakOnce 对 auto 再挡一道（隐藏时不说话，也不把猫顶出来）'
);
// 缓存必须跟着 pet:changed 刷 —— 右键菜单改配置时设置弹窗通常是关着的
{
  const at = petSettingsSrc.indexOf('api.onPetChanged');
  const block = at < 0 ? '' : petSettingsSrc.slice(at, at + 800);
  ok(
    /refreshPetCache\(\)/.test(block),
    'pet:changed 处理器会刷新缓存（弹窗关着也刷，否则闸门读的是旧值）'
  );
}

// ---------------------------------------------------------------------------
section('生成失败 / 流式兜底不会留下假气泡');

ok(/if \(!saidThisCycle\) hideBubble\(\)/.test(petJs), '生成失败时收掉「嗯…我想想…」占位');
ok(/else hideBubble\(\)/.test(petJs), '空回复也收掉气泡（不留空气泡）');
{
  const at = petJs.indexOf('window.petBridge.onChunk');
  const block = at < 0 ? '' : petJs.slice(at, at + 800);
  // 少了 appendChild，兜底分支里的 firstElementChild 就是 null，增量一个字都不显示
  ok(/bubbleLines\.appendChild\(p\)/.test(block), 'onChunk 兜底分支真的补了占位节点');
}

// ---------------------------------------------------------------------------
section('宠物页面用到的 DOM 节点在 pet.html 里存在');

const petHtml = read('renderer/pet/pet.html');
for (const id of ['sprite-wrap', 'sprite-empty', 'bubble', 'bubble-lines']) {
  const used = new RegExp(`getElementById\\('${id}'\\)`).test(petJs);
  const declared = petHtml.includes(`id="${id}"`);
  ok(used === declared, `#${id} 用得到也声明了（用=${used} 声明=${declared}）`);
}

// 红线：宠物说的话绝不进会话历史（写进去角色下一轮就会「听见」它说话）
ok(
  !/convo\.messages\s*\.\s*push/.test(petContextSrc),
  'petContext.js 不往 convo.messages 里塞东西（宠物的话绝不进会话历史）'
);

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
process.exit(failures.length ? 1 : 0);
