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

/**
 * 去掉注释后的源码 —— 断言「代码里没有 X」时必须用它。
 *
 * ⚠️ 直接对着带注释的源码断言会踩两个坑，我都踩过：
 *   1. 我说「这里**不看** enabledGestures」这句注释，本身含有 `enabledGestures`，
 *      于是「poked 不看 enabledGestures」这条断言必然失败；
 *   2. 我写「别做『至少留一个』的兜底」这句注释，含有「至少…一个」，
 *      于是「没有至少留一个的兜底」这条也必然失败。
 *   也就是说：**注释在解释「我们没做某件事」，而断言在找「有没有出现这个词」**，
 *   两者天然打架。凡是要断言「不该出现」的，一律先剥注释。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（避开 http:// 之类）
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
 *
 * ⚠️ **不能用 `process.execPath`**：这个测试经常是在 electron.exe 里跑的
 *    （`env -u ELECTRON_RUN_AS_NODE electron.exe tools/test-pet-window.js`），
 *    那时 execPath 是 electron.exe —— 它不认 `--check`，会把每个文件都判成解析失败
 *    （2026-10-09 之前一直有 4 条这样的**假失败**）。
 *    Electron 会把 `ELECTRON_RUN_AS_NODE` 的路径塞在 package.json 里，
 *    但更稳的做法是直接找一个真的 node。
 */
function findNodeForCheck() {
  // 1) 显式环境变量优先（CI / 沙箱 / 特殊环境可以指）
  if (process.env.MIMITALE_NODE) return process.env.MIMITALE_NODE;

  // 2) 自己的 execPath 就是 node（直接用 node 跑这个脚本时）
  if (!/electron/i.test(path.basename(process.execPath))) return process.execPath;

  // 3) electron 自带一个 node，但它埋在 dist 深处；不行就退到 PATH
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'node.exe'),
    process.env.NODE_EXE,
    'node'
  ].filter(Boolean);

  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
    // ⚠️ 注意 `probe.error`：**子进程根本没起来**时 status 是 null。
    //    沙箱（或权限策略）会直接 EBUSY，这时换再多候选也是白搭 ——
    //    立刻返回 null，别把「起不来」当成「这个候选不好用」一个个试下去，
    //    更别顺手把它当成「文件有语法错」。
    if (probe.error) return null;
    if (probe.status === 0) return c;
  }
  return null;
}

const NODE_FOR_CHECK = findNodeForCheck();

/**
 * 让 node 解析（不执行）一个文件。
 *
 * 三种结果必须分清楚，混起来就是灾难：
 *   ok:true                   → 解析过了
 *   ok:false                  → **真的**有语法错（这是本函数存在的意义）
 *   ok:true, skipped:true     → 查不了（子进程起不来 / 没有 node）
 *
 * ⚠️ skipped 的情况在结尾**单独吼一声**：它意味着这轮「语法检查」实际没生效，
 *    别让一整屏 ✓ 把它盖过去。2026-10-09 我就在沙箱里被这个坑了一次 ——
 *    沙箱禁 spawn，`probe` 全是 EBUSY，于是**注入语法错也照样 87/87 全绿**。
 */
function syntaxCheck(file) {
  if (!NODE_FOR_CHECK) return { ok: true, skipped: true, detail: '没找到可用的 node' };

  const result = spawnSync(NODE_FOR_CHECK, ['--check', file], { encoding: 'utf8' });

  if (result.error) {
    // 探测阶段起得来、这里起不来 —— 极少见，但同样不是语法问题，不许赖文件
    return { ok: true, skipped: true, detail: `子进程起不来（${result.error.code}）` };
  }
  if (result.status === 0) return { ok: true, skipped: false, detail: '' };

  const detail = String(result.stderr || '')
    .split('\n')
    .find((line) => /Error|error/.test(line)) || '解析失败';
  return { ok: false, skipped: false, detail: detail.trim() };
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

let syntaxSkipped = 0;
for (const file of petModules) {
  const result = syntaxCheck(path.join(PET_DIR, file));
  ok(result.ok, `${file} 能被解析${result.ok ? '' : `：${result.detail}`}`);
  if (result.skipped) syntaxSkipped += 1;
}

// 一条都查不了 = 这一节其实**没生效**。它不是「失败」（环境的问题不是代码的问题），
// 但绝不能安安静静地混在满屏 ✓ 里 —— 必须显眼到一眼看见。
if (syntaxSkipped === petModules.length && petModules.length > 0) {
  console.log(
    `\n  ⚠️⚠️  ${petModules.length} 个模块**一个都没真正检查**（${syntaxCheck(petModules[0]).detail || '子进程起不来'}）` +
      `\n  ⚠️⚠️  上面这一节的 ✓ 是没有意义的 —— 换一个能 spawn 子进程的终端重跑，` +
      `或用 MIMITALE_NODE=<node 绝对路径> 指定。\n`
  );
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
section('气泡：有尾巴、长句不撑破、逐句淡入');

{
  const cssSrc = read('renderer/pet/pet.css');

  // 尾巴（::before/::after 两个三角）—— 没有它气泡就是浮在头上的一张卡片，
  // 跟宠物是「两张贴纸」，不像它在说话
  ok(/\.bubble::before/.test(cssSrc) && /\.bubble::after/.test(cssSrc), '气泡有指向宠物的小尾巴');
  // 尾巴画在框外，父容器一裁就没了
  ok(/\.bubble\s*\{[^}]*overflow:\s*visible/.test(cssSrc), '气泡不裁剪（否则尾巴被切掉）');

  // ---- 「可爱」这一版的具体做法（2026-10-10）----
  // 都是**观感**上的取舍，容易被后来的人当成"随便调的"改回去，所以钉住：
  // 圆角给足（小圆角 = 系统对话框，大圆角才软）
  {
    const m = cssSrc.match(/\.bubble\s*\{[^}]*border-radius:\s*(\d+)px/);
    ok(m && Number(m[1]) >= 16, '气泡圆角 >= 16px（软，不是对话框那种小圆角）');
  }
  // 描边带主题蓝，不是灰的
  ok(/--bubble-edge/.test(cssSrc), '气泡描边用带主题色的 --bubble-edge（不是纯灰）');
  // 渐变填充，不是平涂
  ok(
    /\.bubble\s*\{[^}]*background:\s*linear-gradient/.test(cssSrc),
    '气泡用上浅下深的渐变（纯平涂像系统提示框）'
  );
  // 冒出来有回弹（过冲的 cubic-bezier），不是直上直下
  ok(
    /\.bubble\s*\{[^}]*animation:\s*bubble-in[^;]*cubic-bezier\(\s*0\.34\s*,\s*1\.5/,
    '气泡进场带回弹（cubic-bezier 过冲）'
  );
  // 分隔线从 dashed 改成淡渐变线 —— dashed 是系统 UI 语言，跟"可爱"相反
  ok(
    !/\.bubble-line\s*\+\s*\.bubble-line\s*\{[^}]*border-top:\s*1px\s+dashed/.test(cssSrc),
    '句间分隔不再是 dashed 虚线'
  );
  // 动作字用主题色，别用灰（灰在宠物身上常糊成一片）
  ok(
    /\.bubble-line em\s*\{[^}]*color:\s*var\(--accent\)/.test(cssSrc),
    '动作（em）用主题色，不是灰'
  );
  // 字体优先圆体、且必须有兜底（圆体不是 Windows 自带，没装不能变成方块/报错）
  ok(
    /--bubble-font-family/.test(cssSrc) && /YaHei|微软雅黑/.test(cssSrc),
    '气泡字体优先圆体、但兜底里有雅黑（没装圆体也不能坏）'
  );

  // 长句不能把气泡撑满整个窗口、把宠物脸盖住
  ok(
    /\.bubble-lines\s*\{[^}]*max-height/.test(cssSrc),
    '气泡正文有 max-height（长句在气泡里滚，不撑破）'
  );
  ok(
    /\.bubble-lines\s*\{[^}]*overflow-y:\s*auto/.test(cssSrc),
    '气泡正文能滚（有 max-height 就必须配 overflow-y）'
  );

  ok(/@keyframes line-in/.test(cssSrc), '逐句冒出来有淡入动画');
  ok(
    /\.bubble-line\s*\{[^}]*animation:\s*line-in/.test(cssSrc),
    '.bubble-line 用上了 line-in'
  );

  // 冒到超出可视区时要跟着滚，否则用户以为它只说了一两句
  ok(/bubbleLines\.scrollTop\s*=\s*bubbleLines\.scrollHeight/.test(petJs), '逐句冒出来时跟着滚到底');

  // 气泡的尺寸**不跟宠物缩放**（用户 2026-10-10 提的：缩放一调小，字就小到看不见了）。
  // 这四条是防止有人"为了比例协调"又把 --scale 乘回去 —— 乘上去在缩小档会真的把话读没。
  ok(
    /\.bubble-line\s*\{[^}]*font-size:\s*var\(--bubble-font\)/.test(cssSrc),
    '气泡字号走 --bubble-font（固定基准，不乘 --scale）'
  );
  ok(
    !/\.bubble-line\s*\{[^}]*font-size:[^;}]*var\(--scale\)/.test(cssSrc),
    '气泡字号没有乘 --scale（缩到 70% 时字还得能看清）'
  );
  ok(
    /\.bubble-lines\s*\{[^}]*max-height:\s*\d+vh/.test(cssSrc),
    '气泡高度上限用 vh（跟着窗口走，不是写死像素）'
  );
  // 高度上限别压得太狠：0.7× 时 30vh 只有 80px≈3.8 行，"说三句"折一下就被切掉
  // （2026-10-10 实测）。这里钉住下限，防止有人"为了不挡脸"把它调更小。
  {
    const m = cssSrc.match(/\.bubble-lines\s*\{[^}]*max-height:\s*(\d+)vh/);
    ok(m && Number(m[1]) >= 35, '气泡高度上限 >= 35vh（太小会把最后一句切掉）');
  }
  ok(
    !/\.bubble\s*\{[^}]*padding:[^;}]*var\(--scale\)/.test(cssSrc),
    '气泡内边距不乘 --scale'
  );
  // 滚动吸附：`scrollTop = scrollHeight` 会让最上面那句切半行；但无脑吸附到
  // 最后一行顶边，又会让**新说的那句**底部出界。两者都要防。
  ok(/function scrollToLastLine\s*\(/.test(petJs), '有 scrollToLastLine() 处理行边界');
  ok(
    /scrollToLastLine\(\)/.test(petJs),
    'showLines 走 scrollToLastLine（不是裸的 scrollTop = scrollHeight）'
  );
  ok(
    /lastTop\s*<=\s*max/.test(petJs),
    '吸附前校验「最后一行对上顶边不会超出」（否则保持滚到底）'
  );
  // 流式那条**故意**滚到底 —— 正在写的字在末尾，切末尾比切开头严重
  ok(
    /onChunk[\s\S]*?bubbleLines\.scrollTop\s*=\s*bubbleLines\.scrollHeight/.test(petJs),
    '流式增量仍然滚到底（正在写的字不能被切）'
  );

  // 气泡**底边锚定**在宠物头顶：rig 画布是方的（fitCanvas 按宽度收高），
  // 画布上方那片空白不属于宠物；气泡要是钉在窗口顶部，就会和它之间留一条
  // 「不知道哪来的」间隔，而且说的话一长一短间隔还跟着变。
  ok(
    /\.bubble\s*\{[^}]*bottom:\s*var\(--bubble-bottom/.test(cssSrc),
    '气泡是底边锚定（bottom: var(--bubble-bottom)）'
  );
  ok(
    !/\.bubble\s*\{[^}]*top:\s*4px/.test(cssSrc),
    '气泡不再钉死在窗口顶部'
  );
  ok(
    /--bubble-bottom/.test(cssSrc) && /\.bubble\s*\{[^}]*bottom:\s*var\(--bubble-bottom,\s*\d+%/.test(cssSrc),
    '--bubble-bottom 有 % 兜底（掩码读不出时也别跑到窗外）'
  );
  ok(/function syncBubbleAnchor\s*\(/.test(petJs), '有 syncBubbleAnchor() 摆气泡');
  // ⚠️ 气泡**框**的下沿 ≠ 视觉下沿：尾巴挂在框外往下伸，
  //    摆位置时要把这截补上，否则尾巴压在宠物头发上（2026-10-10 踩过）。
  ok(
    /function overhangBelowBubble\s*\(/.test(petJs),
    '有 overhangBelowBubble() 量尾巴探出的高度'
  );
  ok(
    /spriteTopInWrap\s*-\s*gap\s*-\s*tailDrop/.test(petJs),
    '摆气泡时把尾巴的外挂高度算进气口（不然尾巴压头发）'
  );
  // 尾巴高度是从 CSS 量出来的，不是写死的常量 —— 改 CSS 尺寸这边自动跟上
  ok(
    /getComputedStyle\(bubble,\s*'::before'\)/.test(petJs),
    '尾巴外挂高度实测（不是写死常量）'
  );
  // 头顶从掩码扫出来，不是写死一个数字 —— 换形象 / 缩放 / 点头都要跟上
  ok(
    /spriteTopInWrap/.test(petJs) && /alpha\[base \+ x\]\s*>\s*128/.test(petJs),
    '头顶由掩码实测（实心像素行），不是写死的常数'
  );
  ok(
    /spriteTopInWrap\s*==\s*null/.test(petJs) || /spriteTopInWrap\s*===?\s*null/.test(petJs),
    '读不到头顶时退回 CSS 默认位置（不硬摆）'
  );
  // ⚠️ 预留量必须按气泡自身高度算：0.7× 时窗口 266px 高、气泡 ~98px，
  //    写死一个小数字会让气泡顶边跑到窗户外面（实测到过 -19px）。
  ok(
    /bubble\.offsetHeight/.test(petJs),
    '防出界按气泡自身高度预留（不是写死的常数）'
  );
  ok(
    /ResizeObserver/.test(petJs),
    '气泡变高后重新对一次头顶（ResizeObserver）'
  );
}

// ---------------------------------------------------------------------------
section('「形象」下拉这条链路四层都接上了');

// 加形象这条链是「主进程扫盘 → IPC → preload → 设置页 → patchPet」，
// 任何一层漏了都是**静默失效**（下拉空白 / 切了没反应），所以四层各断言一次。
{
  const petStoreSrc = read('main/pet-store.js');

  ok(/function listRigSkins\s*\(/.test(petStoreSrc), 'pet-store.js 有 listRigSkins()');
  ok(/^\s*listRigSkins,?\s*$/m.test(petStoreSrc), 'pet-store.js 把它导出了');

  // 只认「真有 model.json」的目录 —— 否则一个空目录也会出现在下拉里，
  // 选中就变成占位框（2026-10-09 cat 被清空那次就是这样）
  ok(
    /statSync\s*\(\s*path\.join\(dir,\s*'model\.json'\)\s*\)/.test(petStoreSrc),
    'listRigSkins 用 model.json 存在与否筛目录（空目录不进下拉）'
  );

  ok(/ipcMain\.handle\(\s*'pet:skins'/.test(petIpcSrc), "pet-ipc.js 注册了 'pet:skins'");
  ok(
    /petSkins:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pet:skins'\)/.test(preloadMainSrc),
    'preload.js 暴露了 petSkins'
  );
}
{
  const domSrc = read('renderer/js/core/dom.js');
  ok(/skin:\s*\$\('s-pet-skin'\)/.test(domSrc), 'core/dom.js 把 #s-pet-skin 收进了 el.pet');

  const htmlSrc = read('renderer/index.html');
  ok(htmlSrc.includes('id="s-pet-skin"'), 'index.html 里有 #s-pet-skin 下拉');

  // value 必须带 source 前缀 —— assets 和 user 下可能重名，只存 skin 名会切错卡
  ok(
    /value=[`'"][^`'"]*\\u0000/.test(petSettingsSrc) || /source\}\s*\\u0000\s*\$\{/.test(petSettingsSrc),
    '下拉 value 用 source\\0skin 两段拼（避免重名切错卡）'
  );

  // 切形象必须整块换 look，而不是只改 skin —— patchPet 是浅合并
  ok(
    /look:\s*\{\s*kind:\s*'rig'/.test(petSettingsSrc),
    '切换时整块传 look（patchPet 是浅合并，只传 skin 会把 source 丢掉）'
  );
}

// ---------------------------------------------------------------------------
section('缩放入口：设置页滑块 + 右键菜单「大小」');

// 缩放有三处要接上：右键菜单（主进程）、设置页滑块（渲染层）、落盘（pet-store）。
// 任何一层漏了都是「点了没反应」，所以分开断言。
{
  ok(/function scaleSubmenu\s*\(/.test(petIpcSrc), 'pet-ipc.js 有 scaleSubmenu()');
  ok(/label:\s*'大小'/.test(petIpcSrc), '右键菜单里有「大小」这一项');
  // 必须真的走 patchPet 落盘，不能只改内存里的窗口尺寸
  ok(/patchPet\([^)]*\{\s*scale:/.test(petIpcSrc), '改缩放会 patchPet({ scale })（不然重启就丢）');
  ok(/applyScale\(/.test(petIpcSrc), '改完立刻 applyScale，窗口当场跟着变');
}
{
  const domSrc = read('renderer/js/core/dom.js');
  ok(/scale:\s*\$\('s-pet-scale'\)/.test(domSrc), 'core/dom.js 把 #s-pet-scale 收进了 el.pet');

  const htmlSrc = read('renderer/index.html');
  ok(htmlSrc.includes('id="s-pet-scale"'), 'index.html 里有 #s-pet-scale 滑块');
  ok(/id="s-pet-scale"[^>]*type="range"/.test(htmlSrc), '#s-pet-scale 是 range 输入');

  // 拖动中只本地预览、停手才落盘 —— 不防抖的话一次拖动会发几十条 IPC
  ok(/scaleTimer/.test(petSettingsSrc), '滑块改动有防抖（拖动中不逐条发 IPC）');
  ok(/addEventListener\('input'/.test(petSettingsSrc), '滑块绑的是 input（拖动中就有反馈）');
}

// ---------------------------------------------------------------------------
section('默认形象是大肥鱼，且老的 cat 配置会被迁移');

// 2026-10-10 蓝白猫形象包从 assets/pet/ 移出 —— 这两条要一起成立，
// 否则升级上来的老用户（配置里存着 'cat'）会看到一个占位框。
{
  const petStoreSrc = read('main/pet-store.js');
  ok(/const DEFAULT_SKIN\s*=\s*'whale'/.test(petStoreSrc), '默认形象常量是 whale');
  ok(/skin:\s*DEFAULT_SKIN/.test(petStoreSrc), 'defaultPet 的 look.skin 用 DEFAULT_SKIN（不是写死的名字）');
  ok(/rawSkin === 'cat'/.test(petStoreSrc), 'normalizeLook 会把老的 cat 迁移掉');
  ok(
    !fs.existsSync(path.join(ROOT, 'assets', 'pet', 'cat')),
    'assets/pet/cat 已经不在了（蓝白猫形象包已移出）'
  );
  ok(
    fs.existsSync(path.join(ROOT, 'assets', 'pet', 'whale', 'model.json')),
    'assets/pet/whale 还在（默认形象得有真资产）'
  );
}

// ---------------------------------------------------------------------------
section('形象包里「靠运行时 alpha 才不显示」的部件不许出现');

// 2026-10-09 星宝报「deepseek 的形象不对 重叠了」—— 根因是 Coopanion 用 per-part
// alpha 做「站/坐二选一」，而 Mimitale 没有坐姿状态，于是坐姿件常驻、和站姿件重叠。
// 转换脚本必须把这类部件**删掉**（不是留着让 renderer 去关）。
// 这里直接查成品 model.json：这些 id 出现一个就是回归。
{
  const converterSrc = read('tools/pet/pipeline/convert_whale.py');

  // 转换脚本要真的列了这几个（删了才算处理过）
  for (const id of ['skirt_sit', 'waist_bow_sit_front', 'eye_creases']) {
    ok(converterSrc.includes(`"${id}"`), `convert_whale.py 把 ${id} 列进了删除表`);
  }

  // 幂等的前提：必须从 source/ 原始件读，不能从成品读
  ok(
    /SRC_MODEL|model-original\.json/.test(converterSrc) && /SRC\s*=\s*os\.path\.join\(DST,\s*"source"\)/.test(converterSrc),
    'convert_whale.py 从 source/model-original.json 读输入（否则重跑会叠在成品上）'
  );

  // 真读 whale 的 model.json，确认这三个 id 确实不在里边
  const whaleModelPath = path.join(ROOT, 'assets', 'pet', 'whale', 'model.json');
  if (fs.existsSync(whaleModelPath)) {
    let whale = null;
    try {
      whale = JSON.parse(fs.readFileSync(whaleModelPath, 'utf8'));
    } catch (err) {
      ok(false, `whale/model.json 能解析（${err.message}）`);
    }
    if (whale && Array.isArray(whale.parts)) {
      const ids = whale.parts.map((p) => p.id);
      for (const gone of ['skirt_sit', 'waist_bow_sit_front', 'eye_creases']) {
        ok(!ids.includes(gone), `whale 成品里没有 ${gone}（有 = 会和正主重叠）`);
      }
      // 正主还得在（别删过头把站姿裙也删了）
      for (const keep of ['skirt', 'waist_bow_front', 'brows', 'face']) {
        ok(ids.includes(keep), `whale 成品里保留了 ${keep}`);
      }

      // ---- tex/ 里不许留「model 已不引用」的孤儿贴图 ----
      //
      // 删了部件但忘了删贴图 → 目录里躺着永远加载不到的文件（skirt_sit 一张 104 KB），
      // 而且下次有人照着目录数部件会被误导。转换脚本现在会清，这里兜一道。
      //
      // ⚠️ 注意两张表：parts[].tex 在 **tex/**，feat[].tex 在 **feat/**（不是同一个目录）。
      const texDir = path.join(ROOT, 'assets', 'pet', 'whale', 'tex');
      const featDir = path.join(ROOT, 'assets', 'pet', 'whale', 'feat');
      if (fs.existsSync(texDir) && fs.existsSync(featDir)) {
        const partTex = new Set(whale.parts.map((p) => p.tex));
        const featTex = new Set(Object.values(whale.feat || {}).map((f) => f.tex));

        const orphans = fs.readdirSync(texDir)
          .filter((f) => f.endsWith('.png'))
          .map((f) => f.slice(0, -4))
          .filter((stem) => !partTex.has(stem));
        ok(orphans.length === 0, `whale/tex 没有孤儿贴图${orphans.length ? `（多余：${orphans.join(', ')}）` : ''}`);

        // 反过来也要对：引用的每张贴图都得在**它该在的那个目录**里
        const missingParts = [...partTex].filter((t) => !fs.existsSync(path.join(texDir, `${t}.png`)));
        ok(missingParts.length === 0, `parts 引用的贴图都在 tex/${missingParts.length ? `（缺：${missingParts.join(', ')}）` : ''}`);
        const missingFeat = [...featTex].filter((t) => !fs.existsSync(path.join(featDir, `${t}.png`)));
        ok(missingFeat.length === 0, `feat 引用的贴图都在 feat/${missingFeat.length ? `（缺：${missingFeat.join(', ')}）` : ''}`);
      }

      // ---- 五官必须落在脸的竖直范围内 ----
      //
      // 2026-10-09 星宝报「眼睛位置不对」：feat 的 box y 取成了 V(底边)，
      // 于是整组五官**向上偏移了整整一个自身高度**，眼睛飘到发际线上。
      // 正确的口径是 V(顶边)（见 convert_whale.py 的 feat_entry + step3_pack.py:83）。
      // 这里用几何关系兜底：五官的竖直范围必须**被脸包住**，且眼在上、嘴在下。
      const face = whale.parts.find((p) => p.id === 'face');
      if (face && face.box && whale.feat) {
        const fLo = face.box[1];
        const fHi = face.box[1] + face.box[3];
        for (const key of Object.keys(whale.feat)) {
          const b = whale.feat[key].box;
          const lo = b[1];
          const hi = b[1] + b[3];
          ok(
            lo >= fLo - 1 && hi <= fHi + 1,
            `feat「${key}」落在脸的竖直范围内（${lo.toFixed(1)}~${hi.toFixed(1)} ⊂ ${fLo.toFixed(1)}~${fHi.toFixed(1)}）`
          );
        }
        // 眼睛必须比嘴高 —— 注意 V() 是**向下增长**的（母图 y 越大 → V 越大 → 越靠下），
        // 所以「更高」= **更小的 V**。写反了就是 y 轴取错边的典型症状。
        if (whale.feat.eye_open && whale.feat.mouth) {
          const eyeLo = whale.feat.eye_open.box[1];
          const mouthLo = whale.feat.mouth.box[1];
          ok(eyeLo < mouthLo, `眼睛在嘴上方（眼 V=${eyeLo.toFixed(1)} < 嘴 V=${mouthLo.toFixed(1)}，V 越小越靠上）`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('空闲手势：只有点头/摇头/招手，没有遗留的「鞠躬」');

// 2026-10-10 用户：「好像有一个遗留的磕头动作，如果有的话就把它去掉吧」—— 确实有。
// `bow`（鞠躬/磕头）是 idle 下四个随机手势之一，一低头整只都塌下去，
// 在小窗口里看着像卡住，也不是这只宠物的性格。
//
// 这个手势散在**三处**，删干净必须三处都动（漏一处就是"代码里没了、还能做出来"）：
//   1. cat.js 挑手势的数组    2. cat.js 的 GESTURE_DUR    3. cat-figure.js 的渲染
{
  const catJs = read('renderer/pet/cat.js');
  const figJs = read('renderer/pet/cat-figure.js');

  ok(!/['"]bow['"]/.test(catJs), 'cat.js 里没有 bow 这个手势了');
  ok(!/['"]bow['"]/.test(figJs), 'cat-figure.js 里没有 bow 这个手势了');
  // 时长表也要跟着删：漏删不报错（有 `|| 1` 兜底），只会让手势默默变成 1 秒
  ok(
    !/GESTURE_DUR\s*=\s*\{[^}]*\bbow\b/.test(catJs),
    'GESTURE_DUR 里也删掉了 bow（漏删会被 `|| 1` 悄悄兜住，不报错）'
  );
  // 挑手势的地方不该再写死数组 —— 手势列表只在一处维护，否则两边会不同步。
  // 2026-10-10 起挑的是 enabledGestures（= IDLE_GESTURES ∩ 用户在设置里勾的），
  // 但「不许就地写死数组」这条口径不变：挑的那行仍然只引用一个变量。
  ok(
    /(IDLE_GESTURES|enabledGestures)\[Math\.floor\(Math\.random\(\)\s*\*\s*(IDLE_GESTURES|enabledGestures)\.length\)\]/.test(catJs),
    '挑手势读的是变量（IDLE_GESTURES / enabledGestures），不是就地写死的数组'
  );
  ok(/const IDLE_GESTURES\s*=\s*\[/.test(catJs), 'cat.js 有 IDLE_GESTURES 常量（全集）');
  // 剩下三个都得在，别删过头
  {
    const m = catJs.match(/const IDLE_GESTURES\s*=\s*\[([^\]]*)\]/);
    const list = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
    ok(list.length === 3, `IDLE_GESTURES 有 3 个手势（实际 ${list.length}）`);
    for (const k of ['nod', 'shake', 'wave']) {
      ok(list.includes(k), `IDLE_GESTURES 保留了 ${k}`);
    }
  }
  // 每个手势都得有时长，否则播放速度会掉进 `|| 1` 兜底
  {
    const dur = catJs.match(/const GESTURE_DUR\s*=\s*\{([^}]*)\}/);
    const keys = dur ? [...dur[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]) : [];
    ok(keys.length === 3, `GESTURE_DUR 正好 3 项（实际 ${keys.join('/')}）`);
  }
  // `bowing` 那个表情是鞠躬手势的残留（全仓没人把 face 设成它），一并清掉
  ok(!/bowing/.test(figJs), '没有 bowing 这个没人用的遗留表情');
  // waist 这个 deformer **必须留着**（部件靠它挂在骨架上），只是不再给它状态
  ok(
    /waist:\s*\{\s*kind:\s*'rot'/.test(figJs),
    'waist deformer 保留（删了部件会散架）'
  );
  ok(
    !/st\.waist\s*=/.test(figJs),
    '不再给 waist 写状态（没有状态 = 恒等变换，rig.js 的 applyChain 会跳过）'
  );
}

// ---------------------------------------------------------------------------
section('「空闲小动作」开关：设置页 → 主进程 → 宠物窗口这条链路接上了');

// 2026-10-10 用户：「桌宠的动作也做到设置里」。做的是「空闲小动作」三个勾
// （点头/摇头/招手）—— 关掉的那个就再也不出现。
//
// 这条链路的特别之处：**手势是宠物窗口自己挑的**，配置却在主进程和设置页。
// 所以数据要跨两个边界走一遍：
//   设置页勾 → pet:update → pet-store 落盘 → pet:state 推给宠物窗口 → cat.js 挑手势时读
// 任何一层断了都表现为「勾了没反应」，而且不报错。逐层断言。
{
  // ---- 第一层：pet-store 有字段、且缺字段 / 空数组两种情形分开处理 ----
  const storeSrc = read('main/pet-store.js');
  ok(/const KNOWN_GESTURES\s*=\s*\[/.test(storeSrc), 'pet-store 有 KNOWN_GESTURES 常量（全集）');
  ok(/gestureEnabled:\s*\[\.\.\.KNOWN_GESTURES\]/.test(storeSrc), 'defaultPet 里 gestureEnabled 默认全集');
  ok(/gestureEnabled:\s*normalizeGestureList\(/.test(storeSrc), 'normalizePet 会收 gestureEnabled');
  ok(/function normalizeGestureList\s*\(/.test(storeSrc), '有 normalizeGestureList 归一化函数');
  // ⚠️ 这条是整节里最要紧的：**空数组必须原样保留**。
  //    写成 `value || [...fallback]` 或 `value.length ? value : fallback` 都会让
  //    「三个勾全取消」在存盘/读盘时被兜回全集 —— 用户会发现设置没生效。
  {
    const fnSrc = storeSrc.match(/function normalizeGestureList[\s\S]*?\n\}/);
    ok(!!fnSrc, '能抠出 normalizeGestureList 的实现');
    if (fnSrc) {
      const KNOWN_GESTURES = ['nod', 'shake', 'wave'];
      const fn = new Function('KNOWN_GESTURES', fnSrc[0] + '; return normalizeGestureList;')(KNOWN_GESTURES);
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      ok(eq(fn(undefined, KNOWN_GESTURES), KNOWN_GESTURES), '缺字段 → 用默认全集（升级上来的不掉功能）');
      ok(eq(fn([], KNOWN_GESTURES), []), '空数组 → 保留成空数组（三个全取消 = 我要它安静待着）');
      ok(eq(fn(['nod', 'wave'], KNOWN_GESTURES), ['nod', 'wave']), '正常勾选原样保留');
      ok(eq(fn(['nod', 'bow'], KNOWN_GESTURES), ['nod']), '丢掉不认识的 id（含已删的 bow）');
      ok(eq(fn(['nod', 'nod'], KNOWN_GESTURES), ['nod']), '去重');
      ok(eq(fn('nod', KNOWN_GESTURES), KNOWN_GESTURES), '不是数组 → 用默认全集');
      // 别把调用方传进来的默认值数组改掉（返回的是新数组）
      const def = ['nod'];
      fn(['wave'], def);
      ok(eq(def, ['nod']), '不修改调用方传入的默认数组（返回新数组）');
    }
  }

  // ---- 第二层：宠物页面把它转给 cat.js；cat.js 按它挑手势 ----
  const petJs = read('renderer/pet/pet.js');
  ok(/catRig\.setGestures\(pet\.gestureEnabled\)/.test(petJs), 'pet.js 把 pet.gestureEnabled 转给 catRig');
  // ⚠️ 这行必须在「rig 缺失就 return」之前 —— 放后面的话，形象没加载出来时
  //    这个设置就永远传不到渲染层（用户改了什么都没反应，而且没人会想到是这个原因）
  {
    const gestureLine = petJs.indexOf('catRig.setGestures');
    const rigReturn = petJs.indexOf('if (!rigData || !rigData.model)');
    ok(
      gestureLine > 0 && rigReturn > 0 && gestureLine < rigReturn,
      'setGestures 在「rig 缺失就 return」之前（否则形象缺失时设置传不下去）'
    );
  }

  const catJs = read('renderer/pet/cat.js');
  ok(/function setGestures\s*\(/.test(catJs), 'cat.js 有 setGestures()');
  ok(/setGestures\s*,/.test(catJs), 'setGestures 挂进了 catRig 的导出');
  ok(/let enabledGestures\s*=\s*\[\.\.\.IDLE_GESTURES\]/.test(catJs), 'enabledGestures 默认全集（字段缺失时不缩水）');
  // ⚠️ 断言要落在**真的把它当条件用**上，不能只找 `enabledGestures.length` 这个词 ——
  //    我注释里写过「空数组是合法的」这类话，光搜词的话把 `if (enabledGestures.length)`
  //    改成 `if (true)` 都照样通过（实测过）。所以剥掉注释、要求它出现在 if 条件里。
  {
    const code = stripComments(catJs);
    ok(
      /if\s*\(\s*enabledGestures\.length\s*\)/.test(code),
      '挑手势前先判集合非空（空集合 = 不挑，别给它兜一个回去）'
    );
    ok(
      /enabledGestures\[Math\.floor\(Math\.random\(\)/.test(code),
      '挑手势从 enabledGestures 里挑（不是直接从 IDLE_GESTURES）'
    );
    ok(
      /enabledGestures\s*=\s*IDLE_GESTURES\.filter\(/.test(code),
      'setGestures 用 IDLE_GESTURES ∩ 传入列表（不认识的名字进不来）'
    );
  }
  // 点它的反应 / 说话时的点头**不受这个开关管** —— 那是交互反馈，不是空闲小动作
  // （先剥注释：实现里那句「这里不看 enabledGestures」的说明本身含有这个词）
  {
    const code = stripComments(catJs);
    const poked = code.match(/function poked\s*\(\)\s*\{[\s\S]*?\n\}/);
    ok(!!poked, '能抠出 poked() 的实现');
    ok(
      poked && !/enabledGestures/.test(poked[0]),
      'poked() 不看 enabledGestures（关掉动作 ≠ 点它也没反应）'
    );
  }

  // ---- 第三层：设置页那三个勾存在、且改了就落盘 ----
  const htmlSrc = read('renderer/index.html');
  for (const id of ['s-pet-gesture-nod', 's-pet-gesture-shake', 's-pet-gesture-wave']) {
    ok(htmlSrc.includes(`id="${id}"`), `index.html 有 #${id}`);
  }
  ok(/id="s-pet-gestures-field"/.test(htmlSrc), 'index.html 有 #s-pet-gestures-field 这一组');
  const domSrc = read('renderer/js/core/dom.js');
  for (const key of ['gestureNod', 'gestureShake', 'gestureWave']) {
    ok(new RegExp(`${key}:\\s*\\$\\(`).test(domSrc), `core/dom.js 把 ${key} 收进了 el.pet`);
  }
  ok(/gestureEnabled:\s*enabled/.test(petSettingsSrc), 'petSettings.js 改动会 patchPet({ gestureEnabled })');
  ok(/renderGestures\(\)/.test(petSettingsSrc), 'renderPetSettings 里调了 renderGestures（否则重画时勾会丢）');
  // ⚠️ 三个勾全不勾是合法状态，别在 UI 层做「至少留一个」的兜底
  // （剥注释再查：我写的那句「别做『至少留一个』的兜底」本身就含这个词）
  ok(
    !/至少[^。\n]{0,6}一个[^。\n]{0,6}(勾|选)/.test(stripComments(petSettingsSrc)),
    '设置页没有「至少留一个」的兜底（那会让用户取消最后一个勾时看着没反应）'
  );
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
process.exit(failures.length ? 1 : 0);
