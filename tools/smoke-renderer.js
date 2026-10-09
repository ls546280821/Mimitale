// ============================================================================
//  smoke-renderer.js —— 冒烟测试里「跑在页面里」的那一半
//
//  这份代码会被 tools/smoke-test.js 用 executeJavaScript 注入到真实的
//  renderer/index.html 里执行（外面包了一层 async IIFE）。
//
//  规矩（很重要，别破坏）：
//    · 只允许「点真实按钮 + 读真实 DOM + 调 window.mimitale 这个 preload 桥」
//    · 绝对不要调用 renderer.js 里的内部函数（sendMessage / newCharacter 之类）
//      因为渲染层正在往 ES module 迁移 —— 迁移之后那些函数就不再是全局的了，
//      凡是直接调它们的测试会**当场全部失效**。
//      「点按钮 + 读 DOM」这套写法能扛住整个重构。
//    · 断言「有没有落盘」一律走 window.mimitale.getXxx()，那是唯一可信的持久化视图。
//
//  跑完返回 { results, notes }。
//
//  注意：这个文件**不能单独跑**（下面用了顶层 await），它靠外面那层 async IIFE 包住，
//  所以 `node --check tools/smoke-renderer.js` 会报语法错 —— 那是正常的。
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (x) => document.getElementById(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const notes = [];
let currentScenario = '';

/** 记一条断言结果（自动带上当前场景名，报告里好分组） */
function check(name, pass, detail) {
  const full = currentScenario ? `${currentScenario} · ${name}` : name;
  results.push({ name: full, pass: !!pass, detail: pass || detail == null ? '' : String(detail) });
}

/** 轮询等待，超时抛错（比固定 sleep 稳，也比 sleep 快） */
async function waitFor(label, fn, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = fn();
    } catch (err) {
      /* 元素还没出现，继续等 */
    }
    if (ok) return ok;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`);
    await sleep(25);
  }
}

/**
 * 等「当前会话的某个面板字段」在主进程里落成期望值。改状态卡是「渲染层改内存 →
 * IPC → 主进程写文件」，固定 sleep 会偶尔跑输这条异步链，这里轮询到真落盘为止；
 * 等不到不抛错，交给调用方的断言去报。
 */
async function settlePanelValue(name, expected, timeout = 3000) {
  const t0 = Date.now();
  for (;;) {
    const cs = await window.mimitale.getConversations();
    const a = cs.conversations.find((c) => c.id === cs.activeId);
    if (a && a.panel && panelValByName(a.panel, name) === expected) return a;
    if (Date.now() - t0 > timeout) return null;
    await sleep(25);
  }
}

/**
 * 每个场景独立 try/catch：一个崩了不影响后面的。
 * 开头 / 结尾那两行 [progress] 只在 `--progress` 时由宿主打出来
 * （跑超时时用它分清「卡死」和「只是还没跑完」）。
 */
async function scenario(name, fn) {
  currentScenario = name;
  console.log(`[progress] ${results.length} 条断言 | 开始场景：${name}`);
  try {
    await fn();
  } catch (err) {
    check('场景没能跑完', false, (err && err.message) || String(err));
  }
  currentScenario = '';
  console.log(`[progress] ${results.length} 条断言 | 完成场景：${name}`);
}

function click(target) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到要点的元素：${target}`);
  node.click();
  return node;
}

/**
 * 点顶栏「⋯」菜单里的某一项。
 * 菜单项收在折叠菜单里，直接对着隐藏元素 click() 其实也能触发 ——
 * 但那样就绕开了「菜单到底打不打的开」这件事。这里老老实实先点开、再点项，
 * 顺手验一下点完会收起。
 */
async function clickMoreItem(sel) {
  const menu = byId('topbar-more');
  if (!menu) throw new Error('顶栏没有「⋯」菜单');
  if (menu.classList.contains('hidden')) {
    click('#btn-more');
    await waitFor('「⋯」菜单展开', () => !menu.classList.contains('hidden'));
  }
  click(sel);
  await waitFor('「⋯」菜单点完收起', () => menu.classList.contains('hidden'));
}

/**
 * 点角色卡上的「聊天」，并把「你是谁」那一步走完。
 *
 * 开聊前会先弹这个窗（和「进世界」共用同一个），不填就是默认的「你」；
 * 传 opts.name / opts.profile 可以顺手把身份填上。
 */
async function startChatWith(card, opts = {}) {
  click(buttonByText(card, '聊天'));
  await waitFor('「你是谁」弹窗打开', () => shown('#player-modal'));
  if (opts.name) setValue('#player-name', opts.name);
  if (opts.profile) setValue('#player-profile', opts.profile);
  click('#btn-start-play');
  await waitFor('「你是谁」弹窗关掉', () => !shown('#player-modal'));
}

/** 当前激活的那条会话（读的是落盘数据；落盘是异步的，要轮询时用这个） */
const activeConvo = async () => {
  const cs = await window.mimitale.getConversations();
  return (cs.conversations || []).find((c) => c.id === cs.activeId);
};

function setValue(target, value) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到输入框：${target}`);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  // 下拉框在真实浏览器里会同时触发 input 和 change，这里补齐 ——
  // 否则「换服务商 → 模型下拉跟着重填」这类只监听 change 的行为就测不到
  if (node.tagName === 'SELECT') node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/**
 * 勾选/取消勾选一个 checkbox。
 *
 * 不能用 setValue：checkbox 的状态在 .checked 上，.value 设了也没用；
 * 而且它只派发 input 事件，而这类开关监听的是 change。
 */
function setChecked(target, checked) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到勾选框：${target}`);
  node.checked = !!checked;
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/**
 * 给下拉补一个 option 再选中它。
 *
 * 直接用 setValue 选一个「下拉里还没有的值」是不行的 ——
 * 浏览器会把 select.value 静默变成空串，测试就会以为选上了，实际没选。
 * 这里显式补 option，确保真的选中。
 */
function addAndSelect(select, value) {
  const node = typeof select === 'string' ? $(select) : select;
  if (!node) throw new Error(`找不到下拉：${select}`);
  if (!Array.from(node.options).some((o) => o.value === value)) {
    node.appendChild(new Option(value, value));
  }
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/** 按按钮上的文字找按钮（卡片上的「编辑」「聊天」「游玩」都是这么找的） */
function buttonByText(root, text) {
  if (!root) return null;
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === text) || null;
}

/** 元素存在而且没有 .hidden */
function shown(sel) {
  const node = $(sel);
  return !!node && !node.classList.contains('hidden');
}

async function savedCharacters() {
  const res = await window.mimitale.getCharacters();
  return (res && res.characters) || [];
}
async function savedWorldbooks() {
  const res = await window.mimitale.getWorldbooks();
  return (res && res.worldbooks) || [];
}

// 面板字段的键现在是「字段名\u0000owner」复合键（见 data/panel.js），
// 但测试断言要按「字段名」读值/定义。这两个辅助按字段名在对象里找。
function panelValByName(panel, name) {
  if (!panel || typeof panel !== 'object') return undefined;
  for (const key of Object.keys(panel)) {
    if (key === name || key.startsWith(`${name}\u0000`)) return panel[key];
  }
  return undefined;
}
function panelDefByName(defs, name) {
  if (!defs || typeof defs !== 'object') return null;
  for (const key of Object.keys(defs)) {
    if (key === name || key.startsWith(`${name}\u0000`)) return defs[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
//  场景 1：启动
// ---------------------------------------------------------------------------
await scenario('启动', async () => {
  await waitFor('主界面渲染出会话列表', () => $$('#convo-list .convo-item').length > 0);
  check('主界面已渲染', !!$('#messages') && !!$('#input') && !!$('#btn-send'));
  check('没有掉进「启动失败」兜底页', !document.body.textContent.includes('启动失败'));
  check('没有会话时自动建了一个会话', $$('#convo-list .convo-item').length === 1);
});

// ---------------------------------------------------------------------------
//  场景 2：明暗切换（顺带验证 settings 落盘）
//  控件在「外观」弹窗里：2026-10-08 之前是左上角一颗「点一下切一下」的图标，
//  并进弹窗之后换成「白天 / 夜间」两颗 —— 点哪个是哪个，不再是盲切。
// ---------------------------------------------------------------------------
await scenario('明暗切换', async () => {
  click('#btn-appearance');
  await waitFor('外观弹窗打开', () => shown('#appearance-modal'));

  const modeBtn = (m) => $(`#appearance-modes [data-mode="${m}"]`);
  const before = document.documentElement.getAttribute('data-theme');
  const target = before === 'dark' ? 'light' : 'dark';

  click(`#appearance-modes [data-mode="${target}"]`);
  await waitFor('data-theme 变化', () => document.documentElement.getAttribute('data-theme') === target);
  check('data-theme 切过去了', document.documentElement.getAttribute('data-theme') === target, `${before} → ${target}`);
  check('选中的那颗标成 aria-checked', modeBtn(target).getAttribute('aria-checked') === 'true');
  check('另一颗没标', modeBtn(before).getAttribute('aria-checked') === 'false');

  await sleep(150);
  const settings = (await window.mimitale.getSettings()).settings;
  check('主题已落盘', settings.theme === target, `落盘的是 ${settings.theme}`);

  // 切回去，别影响后面的场景
  click(`#appearance-modes [data-mode="${before}"]`);
  await waitFor('主题切回', () => document.documentElement.getAttribute('data-theme') === before);
  check('切回后 aria-checked 也跟着换', modeBtn(before).getAttribute('aria-checked') === 'true');

  click('#btn-close-appearance');
  await waitFor('外观弹窗关闭', () => !shown('#appearance-modal'));
});

// ---------------------------------------------------------------------------
//  场景 2b：主题配色（顺带验证 data-accent 与 CSS 变量 + 落盘）
//  同样在「外观」弹窗里：原来是左上角一颗「循环」按钮（点一下换下一套，
//  想知道一共有几套只能一路点下去），现在是三个色点，点哪个是哪个。
//  起点不写死 —— 前面哪个场景动过配色都不该让这里假红。
// ---------------------------------------------------------------------------
await scenario('主题配色', async () => {
  click('#btn-appearance');
  await waitFor('外观弹窗打开', () => shown('#appearance-modal'));

  const ALL = ['pink', 'blue', 'matcha'];
  const swatch = (a) => $(`#appearance-accents [data-accent="${a}"]`);
  check('三个色点都在', ALL.every((a) => !!swatch(a)));

  const readAttr = () => document.documentElement.getAttribute('data-accent');
  const readAccent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  const start = readAttr();
  const startAccent = readAccent();

  const next = ALL.find((a) => a !== start);
  click(`#appearance-accents [data-accent="${next}"]`);
  await waitFor('data-accent 变化', () => readAttr() === next);

  const nextAccent = readAccent();
  check('data-accent 切过去了', readAttr() === next, `${start} → ${next}`);
  check('--accent 变量跟着变', nextAccent !== startAccent, `${startAccent} → ${nextAccent}`);
  check('选中的色点标了 aria-checked', swatch(next).getAttribute('aria-checked') === 'true');
  check(
    '没选中的色点没标',
    ALL.filter((a) => a !== next).every((a) => swatch(a).getAttribute('aria-checked') === 'false')
  );

  await sleep(150);
  const settings = (await window.mimitale.getSettings()).settings;
  check('配色已落盘', settings.accent === next, `落盘的是 ${settings.accent}`);

  // 再点第三个，确认三个色点各对应一套（不是只认「切换」两态）
  const third = ALL.find((a) => a !== start && a !== next);
  click(`#appearance-accents [data-accent="${third}"]`);
  await waitFor('切到第三套配色', () => readAttr() === third);
  const thirdAccent = readAccent();
  check('第三套和前两套都不同', third !== next && third !== start, `${start} → ${next} → ${third}`);
  check('第三套的 --accent 也换了', thirdAccent !== startAccent && thirdAccent !== nextAccent);

  // 点回起点，别影响后面的场景
  click(`#appearance-accents [data-accent="${start}"]`);
  await waitFor('配色转回起点', () => readAttr() === start);
  check('转回起点后 --accent 也回到原值', readAccent() === startAccent);

  click('#btn-close-appearance');
  await waitFor('外观弹窗关闭', () => !shown('#appearance-modal'));
});

// ---------------------------------------------------------------------------
//  场景 2c：顶栏「⋯」菜单（记忆 / 复制全文 / 导出 / 纯对话视图 / 请求记录 / 清空对话）
//  收起来是为了给标题让地方。这里只验「装了哪几项、能开、能关、点项会收起」——
//  各项功能本身在别的场景里另有覆盖，不在这里重复。
// ---------------------------------------------------------------------------
await scenario('顶栏「⋯」菜单', async () => {
  const menu = byId('topbar-more');
  check('默认是收起的', menu.classList.contains('hidden'));

  click('#btn-more');
  await waitFor('菜单展开', () => !menu.classList.contains('hidden'));
  check('点一下展开', !menu.classList.contains('hidden'));
  check('按钮标成 aria-expanded=true', byId('btn-more').getAttribute('aria-expanded') === 'true');
  // 按 DOM 顺序把 id 全列出来比一次：以前这里只数「四项」，后来菜单里加了
  // 「纯对话视图」和「请求记录」，没人改它 —— 数字对不上时那句话说不清是多了谁、
  // 少了谁。列名字的写法既守「有没有变」，也顺带把顺序钉住。
  const menuIds = $$('#topbar-more .menu-item')
    .map((b) => b.id)
    .join(', ');
  check(
    '菜单里的项目齐全、顺序没变',
    menuIds === 'btn-memory, btn-copy-all, btn-export-convo, btn-request-log, btn-clear',
    menuIds
  );

  // 点别处收起
  click('#messages');
  await waitFor('点别处收起', () => menu.classList.contains('hidden'));
  check('点到别处会收起', menu.classList.contains('hidden'));

  // Esc 收起
  click('#btn-more');
  await waitFor('菜单重新展开', () => !menu.classList.contains('hidden'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 收起', () => menu.classList.contains('hidden'));
  check('按 Esc 也会收起', menu.classList.contains('hidden'));

  // 点某一项：动作照走 + 菜单收起（复制全文最轻，不会开弹窗打扰后面的场景）
  click('#btn-more');
  await waitFor('菜单再展开', () => !menu.classList.contains('hidden'));
  click('#btn-copy-all');
  await waitFor('点完收起', () => menu.classList.contains('hidden'));
  check('点了菜单项会收起', menu.classList.contains('hidden'));
});

// ---------------------------------------------------------------------------
//  场景 2d：顶栏「切换模型」
//
//  以前这里是原生 <select>。它的**下拉列表由系统画**（直角、系统蓝高亮、系统字体），
//  CSS 完全碰不到 —— 跟这套「大圆角 + 柔和阴影」根本不搭，所以换成自绘弹层
//  （views/chatList.js 铺内容 + ui/modelMenu.js 管开合）。
//
//  这里钉三件事：① 它不再是原生 select；② 分组 / 当前项标得出来；
//  ③ 观感（不描边、大圆角、柔和阴影）—— 这几条 DOM 全对也可能错，
//  所以必须是**计算样式断言**（同一招用在状态卡那次体检里，翻过车）。
// ---------------------------------------------------------------------------
await scenario('顶栏：切换模型', async () => {
  const cs = (node, prop) => getComputedStyle(node)[prop];
  const trigger = byId('model-switch');
  const menu = byId('model-menu');

  check('顶栏那颗是按钮，不再是原生下拉', trigger.tagName === 'BUTTON', trigger.tagName);
  check(
    '按钮上写着当前模型',
    byId('model-switch-label').textContent === 'test-model',
    byId('model-switch-label').textContent
  );
  check('弹层默认是收起的', menu.classList.contains('hidden'));

  // --- 扁平化体检：靠阴影浮起来，不描边 ---
  check('切换模型按钮不描边（靠阴影分层）', cs(trigger, 'borderTopWidth') === '0px', cs(trigger, 'borderTopWidth'));
  check('按钮有柔和阴影', cs(trigger, 'boxShadow') !== 'none', cs(trigger, 'boxShadow'));

  // --- 展开 ---
  click(trigger);
  await waitFor('模型弹层展开', () => !menu.classList.contains('hidden'));
  check('点一下展开', !menu.classList.contains('hidden'));
  check('按钮标成 aria-expanded=true', trigger.getAttribute('aria-expanded') === 'true');

  // --- 按服务商分组 ---
  const groups = $$('#model-menu .model-menu-group');
  check('列表按服务商分了组', groups.length === 3, `${groups.length} 组`);
  check(
    '分组标题就是服务商名',
    groups.map((g) => g.textContent).join('|') === '冒烟测试服务商|冒烟测试生图|冒烟测试向量',
    groups.map((g) => g.textContent).join('|')
  );
  // 分组小标题不画分隔线（扁平化第 2 条）—— 一屏十几行会变成一张表格
  check(
    '分组小标题不画分隔线',
    groups.length > 0 && cs(groups[0], 'borderBottomWidth') === '0px',
    cs(groups[0], 'borderBottomWidth')
  );

  const items = $$('#model-menu .model-menu-item');
  check('三家的模型都列上了', items.length === 3, `${items.length} 项`);
  check(
    '每一项都带完整模型名（长了也能看全）',
    items.length > 0 && items.every((b) => !!b.title && b.textContent.includes(b.title)),
    JSON.stringify(items.map((b) => b.title))
  );

  // --- 当前那一项 ---
  const active = $$('#model-menu .model-menu-item.is-active');
  check('当前用的那项标了出来，而且只有一个', active.length === 1, `${active.length} 项`);
  check('当前项 aria-checked=true', active.length === 1 && active[0].getAttribute('aria-checked') === 'true');
  check(
    '当前项就是这个会话在用的模型',
    active.length === 1 && active[0].dataset.value === 'p-test::test-model',
    active.length ? active[0].dataset.value : ''
  );

  // 勾那块位置**每行都占着**（没选中的只是透明）—— 少了它，选中那行的文字会比别人短一截
  const ticks = $$('#model-menu .model-menu-item .model-menu-check');
  check(
    '每行都留了勾的位置（选中行文字不会短一截）',
    ticks.length === items.length && ticks.every((s) => s.getBoundingClientRect().width > 0),
    ticks.map((s) => Math.round(s.getBoundingClientRect().width)).join(',')
  );

  // 弹层自己的观感：大圆角 + 阴影，不是系统菜单那种直角
  check(
    '弹层是大圆角 + 阴影（不是系统菜单的样子）',
    parseFloat(cs(menu, 'borderTopLeftRadius')) >= 10 && cs(menu, 'boxShadow') !== 'none',
    `${cs(menu, 'borderTopLeftRadius')} / ${cs(menu, 'boxShadow')}`
  );

  // 弹层不能被浮动的状态卡压住：
  // .state-cards 是**整列大小**（inset:0），层级只要比顶栏高，就能把顶栏连同
  // 上面的弹层一起盖掉 —— 模型弹层比「⋯」宽得多，一压就少半截。
  check(
    '顶栏层级高过浮动状态卡（弹层不会被卡盖住）',
    Number(cs($('.topbar'), 'zIndex')) > Number(cs(byId('state-cards'), 'zIndex')),
    `顶栏 ${cs($('.topbar'), 'zIndex')} / 浮动卡 ${cs(byId('state-cards'), 'zIndex')}`
  );

  // --- 点别处 / Esc 收起 ---
  click('#messages');
  await waitFor('点别处收起模型弹层', () => menu.classList.contains('hidden'));
  check('点到别处会收起', menu.classList.contains('hidden'));

  click(trigger);
  await waitFor('模型弹层重新展开', () => !menu.classList.contains('hidden'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 收起模型弹层', () => menu.classList.contains('hidden'));
  check('按 Esc 也会收起', menu.classList.contains('hidden'));

  // --- 在按钮上按上下键就能打开（原生 select 的肌肉记忆）---
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await waitFor('上下键也能打开', () => !menu.classList.contains('hidden'));
  check('在按钮上按 ↓ 也能打开', !menu.classList.contains('hidden'));

  // --- 挑一个别的模型：按钮上的字 + 勾都要跟着走 ---
  click($$('#model-menu .model-menu-item').find((b) => b.dataset.value === 'p-emb::emb-model-x'));
  await waitFor('按钮上的字换了', () => byId('model-switch-label').textContent === 'emb-model-x');
  check('选完按钮上写的是新模型', byId('model-switch-label').textContent === 'emb-model-x');
  check('选完弹层自己收起（不用再点一下）', byId('model-menu').classList.contains('hidden'));
  // 弹层整块重铺过了，刚才抓的节点全部作废 —— 重新查
  const moved = $$('#model-menu .model-menu-item.is-active');
  check(
    '勾跟着搬到新选的那项',
    moved.length === 1 && moved[0].dataset.value === 'p-emb::emb-model-x',
    moved.length ? moved[0].dataset.value : '没找到'
  );

  // 选中就落盘（异步一次 IPC，轮询到写进去为止，别用固定 sleep 赌）
  let stored = null;
  for (let i = 0; i < 40; i++) {
    const cfg = await window.mimitale.getSettings();
    if (cfg.settings.activeModel === 'emb-model-x') { stored = cfg.settings; break; }
    await sleep(25);
  }
  check(
    '选完落盘成了新会话的默认模型',
    !!stored && stored.activeProviderId === 'p-emb' && stored.activeModel === 'emb-model-x',
    stored ? `${stored.activeProviderId}/${stored.activeModel}` : '没落盘'
  );

  // --- 收拾现场：切回原来的服务商 / 模型，别影响后面的场景 ---
  click(byId('model-switch'));
  await waitFor('模型弹层再开一次', () => !byId('model-menu').classList.contains('hidden'));
  click($$('#model-menu .model-menu-item').find((b) => b.dataset.value === 'p-test::test-model'));
  await waitFor('切回测试服务商', () => byId('model-switch-label').textContent === 'test-model');
  check('能切回原来那家', byId('model-switch-label').textContent === 'test-model');
});

// ---------------------------------------------------------------------------
//  场景 3：设置弹窗
// ---------------------------------------------------------------------------
await scenario('设置弹窗', async () => {
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  check('设置弹窗里有表单卡片', !!$('#settings-modal .modal-card'));

  // 「对话轮数」2026-10-07 从 core/config.js 写死的 CONFIG.MAX_TURNS 挪到设置里。
  // 白名单断言只能证明「这个键在 DEFAULT_SETTINGS 里」，证不了「表单读得到、写得出」——
  // readSettingsForm 里漏一行就正好卡在中间，所以这里真存一次。
  check('行为一节里有「对话轮数」', !!byId('s-max-turns'));
  const turnsBefore = byId('s-max-turns').value;
  check('「对话轮数」回填了默认的 20', turnsBefore === '20', turnsBefore);

  setValue('#s-max-turns', '42');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#settings-modal'));
  await sleep(150);
  const turnsSaved = ((await window.mimitale.getSettings()).settings || {}).maxTurns;
  check('改「对话轮数」能落盘', turnsSaved === 42, String(turnsSaved));

  // 改回去 —— 后面好几个场景都依赖默认的 20 轮
  click('#btn-settings');
  await waitFor('设置弹窗再开', () => shown('#settings-modal'));
  setValue('#s-max-turns', turnsBefore || '20');
  click('#btn-save-settings');
  await waitFor('设置已还原', () => !shown('#settings-modal'));
  await sleep(150);
  const turnsBack = ((await window.mimitale.getSettings()).settings || {}).maxTurns;
  check('「对话轮数」还原成 20（后面的场景还等着它）', turnsBack === 20, String(turnsBack));
});

// ---------------------------------------------------------------------------
//  场景 4：角色库 —— 新建必须「保存后才生成」
// ---------------------------------------------------------------------------
await scenario('角色库：新建角色', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  check('角色库一开始是空的', shown('#char-page-empty'));

  const before = (await savedCharacters()).length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  check('标题是「新建角色」', byId('chars-title').textContent === '新建角色', byId('chars-title').textContent);
  check('保存前列表里没有多出卡片', $$('#char-page-grid .char-card').length === before);
  check('保存前「删除角色」是禁用的', byId('btn-del-char').disabled === true);

  // 关键断言：这一刻磁盘上不该有它
  const mid = (await savedCharacters()).length;
  check('保存前没有落盘', mid === before, `期望 ${before}，实际 ${mid}`);

  setValue('#c-name', '冒烟测试角色');
  setValue('#c-desc', '这是冒烟测试写进去的描述');
  setValue('#c-tags', '测试分类, 治愈');
  click('#btn-save-char');

  await waitFor('角色卡片出现', () => $$('#char-page-grid .char-card').length === before + 1);

  const saved = await savedCharacters();
  check('保存后落盘了一个角色', saved.length === before + 1, `实际 ${saved.length}`);
  const last = saved[saved.length - 1] || {};
  check('落盘的角色名正确', last.name === '冒烟测试角色', `落盘的是「${last.name}」`);
  check('落盘的描述正确', last.description === '这是冒烟测试写进去的描述', `落盘的是「${last.description}」`);
  // 新建的角色保存完就完事了：弹窗自己关掉，回到角色列表看新卡
  check('保存后弹窗自己关掉（不用再点一次关闭）', !shown('#chars-modal'));
  check('保存后没有多问一句「放弃新建？」', !shown('#confirm-modal'));

  const card = $$('#char-page-grid .char-card')[0];
  check('卡片上有「编辑」和「聊天」两个入口', !!buttonByText(card, '编辑') && !!buttonByText(card, '聊天'));

  // 标签是「这张卡属于什么类型」，得让人在列表页就看得见，否则分类没意义
  const subText = card.querySelector('.char-card-sub').textContent;
  check('卡片上显示了分类标签', subText.includes('测试分类') && subText.includes('治愈'), subText);
  check('卡片上仍然标着来源', subText.includes('手写'), subText);
});

// ---------------------------------------------------------------------------
//  场景 5：角色库 —— 放弃新建不能留下东西
// ---------------------------------------------------------------------------
await scenario('角色库：放弃新建', async () => {
  const before = (await savedCharacters()).length;
  const cardsBefore = $$('#char-page-grid .char-card').length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '半途而废');

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  check('确认框里带了刚输入的名字', byId('confirm-message').textContent.includes('半途而废'), byId('confirm-message').textContent);

  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#chars-modal'));
  await sleep(150);

  const after = (await savedCharacters()).length;
  check('放弃后没有新增角色', after === before, `期望 ${before}，实际 ${after}`);
  check('放弃后卡片数量不变', $$('#char-page-grid .char-card').length === cardsBefore);
});

// ---------------------------------------------------------------------------
//  场景 5.5：角色编辑器 —— 长文本框自动增高
//
//  两件事只靠眼睛看是看不出「对没对」的，得量高度：
//    · 内容少的时候框要矮（不能每个都占五行，一屏放不下几项）
//    · 内容多的时候框要长高（不然只能看到一小截）
//    · 手动拖过之后，输入不该把它拽回去
//
//  这里只量「有没有按内容变」，具体多高由 ui/auto-grow.js 决定。
//  ⚠️ 高度靠 getBoundingClientRect 读 —— 那是布局完成后的实高，
//     比读 style.height 可信（style 里可能写着值但被别的规则压回去）。
// ---------------------------------------------------------------------------
await scenario('角色编辑器：长文本框自动增高', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const desc = byId('c-desc');
  const example = byId('c-example');
  check('五个长文本框都在表单里', !!desc && !!example);

  const hOf = (node) => Math.round(node.getBoundingClientRect().height);

  // 内容少：高度应当停在「下限」附近
  setValue(desc, '一行字');
  await sleep(80);
  const hShort = hOf(desc);

  // 内容多：高度应当明显长高
  setValue(example, Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行的内容`).join('\n'));
  await sleep(200);
  const hLong = hOf(example);

  check(
    '内容少时框是矮的',
    hShort <= 120,
    `实际 ${hShort}px（期望 <=120px）`
  );
  check(
    '内容多时框会自己长高',
    hLong > hShort + 40,
    `长内容 ${hLong}px vs 短内容 ${hShort}px`
  );
  check(
    '长高有上限，不会把表单顶爆',
    hLong <= 200,
    `实际 ${hLong}px（期望 <=200px）`
  );
  check(
    '超上限的内容走框内滚动（表单总长恒定）',
    example.scrollHeight > example.clientHeight + 10,
    `scrollHeight ${example.scrollHeight} vs clientHeight ${example.clientHeight}`
  );

  // 手动拖过之后就锁定：再输入内容也不该被自动改回去。
  // 模拟「用户拖拽结束」——直接改高度再派发 mouseup（这是唯一能观察到的信号）。
  example.style.height = '150px';
  example.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await sleep(50);
  setValue(example, '又变短了');
  await sleep(80);
  check(
    '拖过之后高度被锁住，输入不会拽回去',
    Math.abs(hOf(example) - 150) <= 6,
    `实际 ${hOf(example)}px（期望 ~150px）`
  );

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#chars-modal'));
  await sleep(150);
});

// ---------------------------------------------------------------------------
//  场景 5.6：角色编辑器 —— 字数角标 + 「放大编辑」浮层
//
//  角标：框压矮之后「写了多少」得一眼能看到（输入和回填两条路都要刷）。
//  浮层：↗ 按钮弹大窗口，改动**实时写回**主框 —— Esc / ✕ / 点空白关掉
//  都不许丢内容；Esc 还只关浮层，不许把底下的编辑器一起带走。
//
//  ⚠️ Esc 派发到浮层的 textarea 上让它冒泡（真实按键的 target 就是
//  聚焦的元素）。直接派发到 document 的话，target 是 document 自己，
//  捕获/冒泡监听会按注册顺序跑 —— main.js 的全局 Esc 先注册先执行，
//  就成了「关掉整个编辑器」，测的不是同一条路径。
// ---------------------------------------------------------------------------
await scenario('角色编辑器：字数角标与放大编辑', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const desc = byId('c-desc');
  const badge = byId('c-desc-count');
  check('字段行上有字数角标', !!badge);
  check('空字段的角标是 0 字', !!badge && badge.textContent === '0 字', badge && badge.textContent);

  setValue(desc, '四两句话');
  await sleep(60);
  check('输入后角标跟着变', badge.textContent === '4 字', badge.textContent);

  // --- 打开放大浮层 ---
  const expandBtn = document.querySelector('.char-expand-btn[data-expand="c-desc"]');
  check('字段行上有放大按钮', !!expandBtn);
  click(expandBtn);
  await waitFor('放大浮层出现', () => !!document.querySelector('.char-expand'));

  const layer = document.querySelector('.char-expand');
  const big = layer.querySelector('.char-expand-text');
  check('浮层里带出了主框的内容', big.value === '四两句话', big.value);
  check('浮层标题是字段名', layer.querySelector('.char-expand-title').textContent === '角色描述');

  // --- 在浮层里输入：实时写回主框 + 角标 ---
  setValue(big, '放大层里写的长内容');
  await sleep(60);
  check('浮层输入实时写回主框', desc.value === '放大层里写的长内容', desc.value);
  check('主框角标同步更新', badge.textContent === '9 字', badge.textContent);

  // --- Esc 只关浮层，不把编辑器一起关掉 ---
  big.focus();
  big.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(80);
  check('Esc 收起了放大浮层', !document.querySelector('.char-expand'));
  check('Esc 没有连编辑器一起关掉', shown('#chars-modal'));
  check('关掉浮层后主框内容还在', desc.value === '放大层里写的长内容', desc.value);

  // --- 再开一次，这次走「完成」按钮 ---
  click(expandBtn);
  await waitFor('放大浮层再次出现', () => !!document.querySelector('.char-expand'));
  const layer2 = document.querySelector('.char-expand');
  const doneBtn = Array.from(layer2.querySelectorAll('button')).find((b) => b.textContent.trim() === '完成');
  click(doneBtn);
  await sleep(80);
  check('点「完成」收起浮层', !document.querySelector('.char-expand'));

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#chars-modal'));
  await sleep(120);
});

// ---------------------------------------------------------------------------
//  场景 6：角色库 —— 编辑已有角色是「更新」，不是「新增」
// ---------------------------------------------------------------------------
await scenario('角色库：编辑已有角色', async () => {
  const before = (await savedCharacters()).length;
  const cards = $$('#char-page-grid .char-card');
  check('有可编辑的卡片', cards.length > 0);

  click(buttonByText(cards[0], '编辑'));
  await waitFor('编辑器打开', () => shown('#chars-modal'));
  check('编辑已有角色时标题是「编辑角色」', byId('chars-title').textContent === '编辑角色', byId('chars-title').textContent);
  check('「删除角色」按钮可用', byId('btn-del-char').disabled === false);

  setValue('#c-name', '改过名字的角色');
  click('#btn-save-char');
  await waitFor('卡片改名', () => $$('#char-page-grid .char-card-name').some((n) => n.textContent === '改过名字的角色'));

  const after = await savedCharacters();
  check('没有新增角色', after.length === before, `期望 ${before}，实际 ${after.length}`);
  check('落盘的名字被更新了', after.some((c) => c.name === '改过名字的角色'));

  click('#btn-close-chars');
  await sleep(120);
  check('关闭已有角色时不弹确认框', !shown('#confirm-modal'));
});

// ---------------------------------------------------------------------------
//  场景 7：角色库 —— 角色卡右上角直接删除
// ---------------------------------------------------------------------------
await scenario('角色库：卡片上删除', async () => {
  const before = (await savedCharacters()).length;
  check('待删的角色存在', before > 0, `实际 ${before}`);

  const delBtn = $$('#char-page-grid .char-card')[0].querySelector('.char-card-del');
  check('卡片上有删除按钮（×）', !!delBtn);
  check('删除按钮平时是透明的（悬停才浮出）', !!delBtn && getComputedStyle(delBtn).opacity === '0');

  // --- 先点「取消」：角色必须还在 ---
  click(delBtn);
  await waitFor('确认框出现', () => shown('#confirm-modal'));
  check('确认文案说明了会话会受影响', byId('confirm-message').textContent.includes('会话'), byId('confirm-message').textContent);
  click('#confirm-cancel');
  await sleep(150);
  check('点取消后角色还在', (await savedCharacters()).length === before, `实际 ${(await savedCharacters()).length}`);

  // --- 再点「删除」：角色消失并落盘 ---
  click($$('#char-page-grid .char-card')[0].querySelector('.char-card-del'));
  await waitFor('确认框出现', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('卡片消失', () => $$('#char-page-grid .char-card').length === before - 1);

  const after = (await savedCharacters()).length;
  check('删除后落盘数量正确', after === before - 1, `期望 ${before - 1}，实际 ${after}`);
  check('删空后显示空状态', shown('#char-page-empty'));
});

// ---------------------------------------------------------------------------
//  场景 8：角色属性 → 状态面板（属性模板的完整链路）
// ---------------------------------------------------------------------------
await scenario('属性：从角色卡种到状态面板', async () => {
  // --- 1) 设置里编辑「常用属性」，快捷候选词要跟着变 ---
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  check('设置里有常用属性输入框', !!byId('s-commonattrs'));

  setValue('#s-commonattrs', '金币, 上衣, 下衣');
  click('#btn-save-settings');
  await waitFor('设置弹窗关闭', () => !shown('#settings-modal'));
  await sleep(150);

  const savedSettings = (await window.mimitale.getSettings()).settings;
  check(
    '常用属性已落盘',
    JSON.stringify(savedSettings.commonAttributes) === JSON.stringify(['金币', '上衣', '下衣']),
    JSON.stringify(savedSettings.commonAttributes)
  );

  // --- 2) 角色编辑器里用快捷按钮加属性 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '属性测试角色');
  setValue('#c-desc', '属性测试角色的设定文本');
  setValue('#c-personality', '沉默寡言');
  // 年龄/性别/种族已从编辑器移除（归入描述），这里不再通过 UI 填。
  // 身份三项的流转由下方「保存后补数据」保证，见 saveCharacters 那段。

  const quick = $$('#c-attr-quick .attr-quick-btn');
  check('快捷候选词按钮出现了', quick.length === 3, `实际 ${quick.length} 个`);

  click(quick[0]); // 金币
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length === 1);
  check('快捷加进来的名字对', byId('c-attr-list').querySelector('.attr-name').textContent === '金币');
  check('加过的候选词就不再显示了', $$('#c-attr-quick .attr-quick-btn').length === 2, `剩余 ${$$('#c-attr-quick .attr-quick-btn').length} 个`);

  // 手写一个（不走快捷按钮）
  setValue('#c-attr-new', '上衣');
  click('#btn-add-attr');
  await waitFor('第二个属性行', () => $$('#c-attr-list .attr-row').length === 2);

  // 保留字段名要被拦下（这些是提示词自己的段落标记，当属性会打架）
  setValue('#c-attr-new', '旁白');
  click('#btn-add-attr');
  await sleep(100);
  check('保留字段名被拒绝', $$('#c-attr-list .attr-row').length === 2, `实际 ${$$('#c-attr-list .attr-row').length}`);

  // 填初始值
  const attrRows = $$('#c-attr-list .attr-row');
  setValue(attrRows[0].querySelector('.attr-value'), '100');
  setValue(attrRows[1].querySelector('.attr-value'), '布衣');

  // --- 加一个「带范围的数值」属性（吸收互动模板那套：类型 + 范围 + 变化规则）---
  setValue('#c-attr-new', '好感度');
  click('#btn-add-attr');
  await waitFor('第三个属性行', () => $$('#c-attr-list .attr-row').length === 3);

  let meterRow = $$('#c-attr-list .attr-row')[2];
  check('新属性默认是文本类型', !!meterRow.querySelector('.attr-type') && meterRow.querySelector('.attr-type').value === 'text',
    meterRow.querySelector('.attr-type') && meterRow.querySelector('.attr-type').value);
  check('文本类型下不显示范围输入框', !meterRow.parentElement.querySelector('.attr-more .attr-num'));

  setValue(meterRow.querySelector('.attr-value'), '20');
  // 选「数值」→ 重画一次，并且自动展开「更多」，范围输入框这时候才出现
  setValue(meterRow.querySelector('.attr-type'), 'meter');
  await waitFor('范围输入框出现', () => !!$('#c-attr-list .attr-more input.attr-num'));

  meterRow = $$('#c-attr-list .attr-row')[2];
  const numInputs = meterRow.parentElement.querySelectorAll('.attr-more .attr-num');
  check('数值类型下有两个范围输入框', numInputs.length === 2, `实际 ${numInputs.length} 个`);
  setValue(numInputs[0], '0');
  setValue(numInputs[1], '100');
  setValue(meterRow.parentElement.querySelector('.attr-more .attr-hint'), '按剧情合理增减，单轮不超过 10');
  check('配置区里有分组下拉', !!meterRow.parentElement.querySelector('.attr-more select.attr-group'));

  // 「更多」能收起，收起来之后配置不丢（草稿还在）。
  // 这一段必须跑在**填分组之前** —— 填完分组这个字段就归到「关系」组、
  // 从当前这一页搬走了，下面按下标取行就会取到别人身上。
  const moreBtn = meterRow.querySelector('.attr-more-btn');
  check('有范围时「更多」默认是展开的', String(moreBtn.textContent).includes('收起'), String(moreBtn.textContent));
  click(moreBtn);
  await waitFor('收起后配置区没了', () => !$('#c-attr-list .attr-more'));
  meterRow = $$('#c-attr-list .attr-row')[2];
  click(meterRow.querySelector('.attr-more-btn'));
  await waitFor('再展开还在', () => !!$('#c-attr-list .attr-more input.attr-num'));
  check(
    '收起再展开，范围没丢',
    $$('#c-attr-list .attr-more .attr-num')[0].value === '0' && $$('#c-attr-list .attr-more .attr-num')[1].value === '100',
    JSON.stringify($$('#c-attr-list .attr-more .attr-num').map((i) => i.value))
  );

  // --- 分组：把这个字段搬进「关系」---
  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('三个字段都还没分组时，标签栏只有一个「未分组」', JSON.stringify(tabLabels()) === JSON.stringify(['未分组 3']), JSON.stringify(tabLabels()));

  // ⚠️ 必须重新取一次行：上面 click 触发过重画，列表整块重建，旧节点 querySelector 拿到 null。
  meterRow = $$('#c-attr-list .attr-row')[2];
  const groupSelect = meterRow.parentElement.querySelector('.attr-more .attr-group');
  // 「未分组」必须在选项里 —— 否则一旦所有属性都归了组，就再也拿不出来了
  check(
    '分组是下拉，且永远带一个「未分组」出口',
    groupSelect.tagName === 'SELECT' &&
      Array.from(groupSelect.options).some((o) => o.value === '' && o.textContent === '未分组'),
    groupSelect.tagName
  );
  // 卡里一个命名分组都没有时，下拉里唯一的选择就是「＋ 新建分组…」——
  // 走它 → 这一行临时变输入框 → 打完回车，建组 + 搬过去一步完成。
  const newOpt = Array.from(groupSelect.options).find((o) => o.textContent.includes('新建分组'));
  check('下拉末尾有「＋ 新建分组…」', !!newOpt, Array.from(groupSelect.options).map((o) => o.textContent).join('/'));
  setValue(groupSelect, newOpt.value);

  await waitFor('这一行变成新建分组输入框', () => !!$('#c-attr-list .attr-more input.attr-group-new'));
  const newGroupInput = $('#c-attr-list .attr-more input.attr-group-new');
  setValue(newGroupInput, '关系');
  newGroupInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  await waitFor('标签栏多出「关系」', () => tabLabels().some((t) => t.startsWith('关系')));
  check(
    '标签栏按分组铺出来了，计数也对',
    JSON.stringify(tabLabels()) === JSON.stringify(['关系 1', '未分组 2']),
    JSON.stringify(tabLabels())
  );
  check(
    '字段搬走之后，「未分组」这一页只剩两行',
    listedNames().length === 2 && !listedNames().includes('好感度'),
    JSON.stringify(listedNames())
  );

  // 切到「关系」：只铺这一组的字段
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('关系')));
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-row').length === 1);
  check(
    '切组之后只显示这一组的字段',
    listedNames().join(',') === '好感度',
    JSON.stringify(listedNames())
  );
  check('切组之后那一行的「更多」还是展开的（草稿里的展开状态没丢）', !!$('#c-attr-list .attr-more input.attr-num'));

  // --- 搬到**已经存在**的分组：在下拉里直接选，不用再走「＋ 新建分组…」---
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('未分组')));
  await waitFor('切回未分组', () => listedNames().length === 2);
  // 取行的函数要每次现查：「更多」一点开列表就整块重建，手里的节点会作废
  const shirtRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '上衣');
  click(shirtRow().querySelector('.attr-more-btn'));
  await waitFor('上衣的「更多」展开', () => !!shirtRow().parentElement.querySelector('.attr-more select.attr-group'));
  const moveSelect = shirtRow().parentElement.querySelector('.attr-more select.attr-group');
  check(
    '下拉里列出了这张卡已有的分组',
    Array.from(moveSelect.options).some((o) => o.value === '关系'),
    Array.from(moveSelect.options).map((o) => o.value).join('/')
  );
  setValue(moveSelect, '关系');
  await waitFor('上衣搬进「关系」', () => tabLabels().join() === '关系 2,未分组 1');
  check('选中一个已有的分组就能把属性搬过去', listedNames().join(',') === '金币', JSON.stringify(listedNames()));

  // 再搬回「未分组」：下拉里那个出口必须一直在 ——
  // 少了它，属性一旦归了组就再也拿不出来了（纯下拉最容易丢的就是这条路）。
  // 搬回去之后夹具回到原样，下面「游玩时状态面板」那一段的预期才不受影响。
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('关系')));
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-row').length === 2);
  const backRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '上衣');
  // 「更多」的展开状态记在草稿上（_moreOpen），上面点开过一次，这里通常是开着的
  if (!backRow().parentElement.querySelector('.attr-more select.attr-group')) {
    click(backRow().querySelector('.attr-more-btn'));
    await waitFor('上衣的「更多」展开', () => !!backRow().parentElement.querySelector('.attr-more select.attr-group'));
  }
  setValue(backRow().parentElement.querySelector('.attr-more select.attr-group'), '');
  await waitFor('上衣退回未分组', () => tabLabels().join() === '关系 1,未分组 2');
  check('下拉里选「未分组」就把它拿出来了', listedNames().join(',') === '好感度', JSON.stringify(listedNames()));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  // 年龄/性别/种族已从编辑器移除（归入描述文字），但「身份四项流转」这条链路
  // （种进状态卡、注入模型）仍保留，依赖角色卡上的 age/gender/race 数据字段。
  // 这些字段现在只能来自「导入的外部卡」——测试里直接改渲染层 state 里这张卡，
  // 等价于导入了一张自带身份信息的卡，验证后续流转不受手填入口移除的影响。
  {
    const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    const target = stateMod.state.characters.find((c) => c.name === '属性测试角色');
    if (target) {
      target.age = '18';
      target.gender = '女';
      target.race = '精灵';
    }
  }

  const saved = await savedCharacters();
  const mine = saved.find((c) => c.name === '属性测试角色');
  check('属性已落盘到角色卡', !!mine && Array.isArray(mine.attributes) && mine.attributes.length === 3, JSON.stringify(mine && mine.attributes));
  check(
    '初始值也一起落盘了',
    !!mine && mine.attributes[0].name === '金币' && mine.attributes[0].value === '100' && mine.attributes[1].value === '布衣',
    JSON.stringify(mine && mine.attributes)
  );
  // 白名单陷阱：保存时的映射以前只搬 name/value，新字段会被静默丢掉
  check(
    '数值属性的类型/范围/规则都落盘了（没被白名单丢掉）',
    !!mine && mine.attributes[2].type === 'meter' && mine.attributes[2].min === 0 && mine.attributes[2].max === 100 &&
      mine.attributes[2].hint === '按剧情合理增减，单轮不超过 10',
    JSON.stringify(mine && mine.attributes[2])
  );
  check(
    '分组也落盘了',
    !!mine && mine.attributes[2].group === '关系',
    JSON.stringify(mine && mine.attributes[2] && mine.attributes[2].group)
  );
  check(
    '界面自己的临时状态没有写进角色卡（_moreOpen）',
    !!mine && !('_moreOpen' in mine.attributes[2]),
    JSON.stringify(mine && Object.keys(mine.attributes[2] || {}))
  );
  // 年龄/性别/种族不再是编辑器可填字段（归入描述），「落盘」语义由
  // 「字段往返不丢」场景里的 saveCharacters 白名单测试覆盖。这里不再断言
  // 编辑器填的身份三项落盘 —— 身份三项的流转（种进状态卡）在下方验证。

  // --- 3) 点「聊天」绑定角色 → 属性应该种进状态面板 ---
  click('#btn-close-chars');
  await sleep(150);

  const card = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('属性测试角色'));
  check('找到了新角色的卡片', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));

  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  // 「当前状态」那块折叠面板的**字段列表面板**已经去掉（一个面板只能显示一个
  // 角色的状态，是旧版单角色的遗留）—— 入口条上只留头像。
  // 标题是「在场角色 N」（2026-09-30 从「当前状态」改名，对齐设计稿的 .cast-cap）：
  // 这一块说的就是「现在场上有谁」，跟着下面那排头像读才对得上。
  check(
    '旧的状态面板字段区已经没有了',
    !byId('panel-fields') && !byId('btn-panel-collapse') && !byId('panel-hint'),
    JSON.stringify({
      fields: !!byId('panel-fields'),
      collapse: !!byId('btn-panel-collapse'),
      hint: !!byId('panel-hint')
    })
  );
  check('入口条上的标题是「在场角色」', /在场角色/.test(byId('panel-box').textContent || ''));
  check(
    '「在场角色」是个纯标签，不是能折叠的按钮',
    (() => {
      const t = byId('panel-box').querySelector('.panel-title');
      return !!t && t.tagName === 'SPAN' && !byId('btn-panel-collapse');
    })()
  );
  // 标题上的数字必须是**数出来的**（跟下面那排头像一致），不能是写死的
  check(
    '标题上的「在场角色 N」和头像个数对得上',
    Number(byId('panel-cast-count').textContent) === $$('#panel-cast .panel-avatar').length,
    `标题=${byId('panel-cast-count').textContent} 头像=${$$('#panel-cast .panel-avatar').length}`
  );

  // --- 点入口条上的角色头像 → 打开角色状态卡 ---
  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('面板栏上有角色的头像', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const charCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
  const cardNames = () => Array.from(charCard().querySelectorAll('.sc-name')).map((n) => n.textContent);
  const cardRows = () => Array.from(charCard().querySelectorAll('.sc-row'));
  const cardRowOf = (field) => cardRows().find((r) => r.querySelector('.sc-name').textContent === field);
  const cardValue = (field) => {
    const row = cardRowOf(field);
    return row ? row.querySelector('.sc-value').textContent : null;
  };

  check('状态卡里出现了角色属性', cardNames().includes('金币') && cardNames().includes('上衣'), JSON.stringify(cardNames()));
  check('带范围的数值属性也在卡里', cardNames().includes('好感度'), JSON.stringify(cardNames()));

  // --- 扁平化体检（2026-09-30）---
  // ⚠️ 这几条**必须**是计算样式断言：DOM 结构全对、类名全在，观感照样可能是错的。
  //    「收起」那颗就翻过车 —— 它没跟 .sc-edit/.sc-close 一起写 border:0，
  //    一直带着浏览器默认的 2px outset 边框，一排卡片头上格外扎眼。
  //    规则是：**卡片、按钮靠阴影/底色分层，不靠 1px 描边和分隔线**。
  {
    const side = (node, prop) => (node ? getComputedStyle(node)[prop] : 'no-node');
    const inCard = (sel) => charCard().querySelector(sel);
    check('状态卡不描边（靠阴影分层）', side(charCard(), 'borderTopWidth') === '0px', side(charCard(), 'borderTopWidth'));
    check(
      '「收起」是纯文字按钮（没有浏览器默认边框）',
      side(inCard('.sc-toggle'), 'borderTopWidth') === '0px',
      side(inCard('.sc-toggle'), 'borderTopWidth')
    );
    check('字段行不画分隔线', side(inCard('.sc-row'), 'borderBottomWidth') === '0px', side(inCard('.sc-row'), 'borderBottomWidth'));
    check(
      '分组小标题不画下划线',
      side(inCard('.sc-group-title'), 'borderBottomWidth') === '0px',
      side(inCard('.sc-group-title'), 'borderBottomWidth')
    );
    check(
      '「在场角色」入口条不是一只描边盒子（靠底色分层）',
      // 2026-09-30 卡片换回悬浮后，入口条改成「一行深色底 + 无边框」，
      // 不再靠一条下划线跟下面的卡片区分（下面已经没有一列卡片了）
      side(byId('panel-box'), 'borderTopWidth') === '0px' &&
        side(byId('panel-box'), 'borderBottomWidth') === '0px' &&
        !side(byId('panel-box'), 'backgroundColor').includes('rgba(0, 0, 0, 0)'),
      `${side(byId('panel-box'), 'borderTopWidth')} / ${side(byId('panel-box'), 'backgroundColor')}`
    );
    check(
      '侧栏条目是渐变圆头像（不是浅色底 + 主色字）',
      (getComputedStyle($$('.convo-avatar')[0]).backgroundImage || '').includes('linear-gradient'),
      getComputedStyle($$('.convo-avatar')[0]).backgroundImage
    );
  }

  // --- 入口条上不显示「我」（2026-10-08：普通聊天不显示玩家状态）---
  // 「我」只在玩世界书时上入口条；普通聊天里只剩「我」时整条横幅都会收掉。
  // 这场绑了角色，所以横幅在、但上面只有那个角色。两张卡并排的契约挪到
  // 下面「发出一条消息」之后验 —— 玩家卡从自己消息的头像开。
  {
    const myAvatarBtn = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
    check('普通聊天的入口条没有「我」的头像', !myAvatarBtn);
  }

  // --- 顶栏：头像 + 标题旁的小胶囊（2026-09-30 按设计稿的 .top / .pill-tag 加的）---
  {
    const av = byId('topbar-avatar');
    check('顶栏左边有头像', !!av);
    check(
      '顶栏头像和侧栏 / 消息区共用同一套渐变',
      (getComputedStyle(av).backgroundImage || '').includes('linear-gradient'),
      getComputedStyle(av).backgroundImage
    );
    // 头像上的字 = 说话人首字（绑了角色的会话就是角色名首字）
    check(
      '顶栏头像上是这个角色的首字',
      (av.textContent || '').trim().length === 1 || !!av.querySelector('img'),
      av.textContent
    );

    const pill = byId('convo-pill');
    check('标题旁边有那颗小胶囊', !!pill);
    // 视角是默认（非 GM / 标准叙述）时，胶囊退给「绑定角色身上第一个数值字段」
    check(
      '胶囊里是绑定角色的关键数值（「好感度 20」这种）',
      /好感度\s*\d+/.test((pill.textContent || '').trim()),
      pill.textContent
    );
    const nameRow = byId('convo-title').parentElement;
    check(
      '胶囊和标题是同一行的兄弟节点（不是塞在 h1 里）',
      nameRow && nameRow.classList.contains('topbar-name') && pill.parentElement === nameRow,
      nameRow ? nameRow.className : 'no-parent'
    );
  }

  // 分组跟着一起搬过来（顺序 = 面板里那套：身份 → 关系 → 没分组的）
  const cardSeq = Array.from(charCard().querySelectorAll('.sc-body > *')).map((n) =>
    n.classList.contains('sc-group-title') ? `#${n.textContent}` : n.querySelector('.sc-name').textContent
  );
  check(
    '分组小标题和字段按组排好',
    cardSeq.join(',') === '#身份,姓名,年龄,性别,种族,#关系,好感度,金币,上衣',
    JSON.stringify(cardSeq)
  );
  // 数值行：值显示成「20/100」，带进度条
  {
    const favorRow = cardRowOf('好感度');
    const bar = favorRow && favorRow.querySelector('.sc-bar');
    check('数值字段有进度条', !!bar, favorRow ? favorRow.outerHTML.slice(0, 140) : '没找到');
    check('数值显示成「分子/满值」', cardValue('好感度') === '20/100', String(cardValue('好感度')));
    check(
      '进度条比例对（20/100 → 20%）',
      !!bar && bar.querySelector('.sc-bar-fill').style.width === '20%',
      bar ? bar.querySelector('.sc-bar-fill').style.width : '没找到'
    );
    const gold = cardRowOf('金币');
    check('文本字段没有进度条', !gold || !gold.querySelector('.sc-bar'));
  }

  check('卡里的值是角色卡上的初始值', cardValue('金币') === '100', String(cardValue('金币')));

  // 单角色对话（角色库点「聊天」）也得把身份四项带上。
  check('身份四项也在这张卡里', ['姓名', '年龄', '性别', '种族'].every((n) => cardNames().includes(n)), JSON.stringify(cardNames()));
  check(
    '身份取的是角色卡上的值',
    cardValue('年龄') === '18' && cardValue('性别') === '女' && cardValue('种族') === '精灵',
    JSON.stringify({ 年龄: cardValue('年龄'), 性别: cardValue('性别'), 种族: cardValue('种族') })
  );
  check('姓名取的是角色名', cardValue('姓名') === '属性测试角色', String(cardValue('姓名')));

  // --- 4) 发一条：注入给模型的消息里必须真的带上面板 ---
  // 断言在宿主侧做（要看 chat:send 的 payload），这里只负责发出去
  setValue('#input', '冒烟测试：属性注入');
  click('#btn-send');
  await waitFor('收到回复', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);

  // --- 浮动卡：开两张必须**自动并排**（2026-09-30 换回悬浮卡的核心诉求）---
  // 当初「浮动卡」被换成固定右栏，就是因为两张会叠在一起。现在靠 layoutSideBySide
  // 按整卡宽铺开 —— 这条就是那个契约的守门人，别让它退化成"错开 26px 叠着"。
  // 普通聊天的入口条没有「我」，玩家卡从自己消息的头像开（普通聊天里剩下的入口）。
  {
    const myMsgAvatar = $$('#messages .msg.user .msg-avatar').pop();
    check(
      '自己消息的头像是「我」状态卡的入口',
      !!myMsgAvatar && myMsgAvatar.classList.contains('clickable')
    );
    click(myMsgAvatar);
    await waitFor('第二张状态卡也开了', () => $$('#state-cards .state-card').length >= 2);

    const host = byId('state-cards');
    const cards = $$('#state-cards .state-card');
    check(
      '状态卡是浮层（卡片绝对定位 + 容器本身不挡鼠标）',
      cards.every((c) => getComputedStyle(c).position === 'absolute') &&
        getComputedStyle(host).position === 'absolute' &&
        getComputedStyle(host).pointerEvents === 'none',
      `${getComputedStyle(cards[0]).position} / ${getComputedStyle(host).pointerEvents}`
    );

    const box = (n) => n.getBoundingClientRect();
    const [a, b] = cards.map(box);
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    check(
      '开两张卡时自动并排，不互相压',
      !overlap,
      `A=${Math.round(a.left)},${Math.round(a.top)} B=${Math.round(b.left)},${Math.round(b.top)}`
    );

    // 头部是拖动把手 —— 光标得给 grab，别让用户猜这里能拖
    check(
      '卡片头部是拖动把手（光标 grab）',
      getComputedStyle(cards[0].querySelector('.sc-head')).cursor === 'grab',
      getComputedStyle(cards[0].querySelector('.sc-head')).cursor
    );

    // 收掉「我」那张，别挡着后面对角色卡的编辑
    click($('#state-cards .state-card[data-owner="player"] .sc-close'));
    await sleep(150);
  }

  // --- 5) 超范围的数值要被夹回来 ---
  // 在卡片的编辑态里手填一个越界值（模拟模型写了 150/100），失焦即落盘。
  click(charCard().querySelector('.sc-edit'));
  await waitFor('卡切到编辑态', () => !!charCard().querySelector('input.sc-input'));

  const favorInput = cardRowOf('好感度').querySelector('input.sc-input');
  check('卡里能改「好感度」', !!favorInput);

  if (favorInput) {
    setValue(favorInput, '150');
    favorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    // 等它真落盘，别用固定 sleep —— 那会偶发读到旧值，报成「没夹回」的假失败
    const clamped = await settlePanelValue('好感度', '100/100');

    const convos = await window.mimitale.getConversations();
    const active = clamped || convos.conversations.find((c) => c.id === convos.activeId);
    check(
      '越界值被夹回上限（150 → 100/100）',
      !!active && active.panel && panelValByName(active.panel, '好感度') === '100/100',
      JSON.stringify(active && active.panel)
    );
    check(
      '字段定义跟着会话一起存下来了（有范围才夹得住）',
      !!active && panelDefByName(active.panelDefs, '好感度') && panelDefByName(active.panelDefs, '好感度').max === 100,
      JSON.stringify(active && active.panelDefs)
    );
    check(
      '分组也跟着定义存下来了',
      !!active && panelDefByName(active.panelDefs, '好感度') && panelDefByName(active.panelDefs, '好感度').group === '关系',
      JSON.stringify(active && panelDefByName(active.panelDefs, '好感度'))
    );

    // 范围内的值不该被动
    setValue(favorInput, '60');
    favorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await settlePanelValue('好感度', '60/100');
    const convos2 = await window.mimitale.getConversations();
    const active2 = convos2.conversations.find((c) => c.id === convos2.activeId);
    check(
      '范围内的值不动（60 → 60/100）',
      !!active2 && active2.panel && panelValByName(active2.panel, '好感度') === '60/100',
      JSON.stringify(active2 && panelValByName(active2.panel, '好感度'))
    );
  }

  // --- 6) 模型整轮漏写状态表 → 程序补问一次，把状态表要回来 ---
  //
  // 「状态卡不跟着剧情走」最常见的形态**不是**程序没接住，是模型压根没写：
  // 实测约四分之一的回合会整段丢掉（尤其「我明天要出差几天」这种没有明显状态
  // 变化的输入）。这段验的是那条兜底链路 —— 正文非空、一个已知字段都没提、
  // 本局有状态字段 → 自动补问一次（补问语见 panel.js 的 PANEL_PROMPT_NUDGE），
  // 值真的回到面板上。假后端按两次不同返回模拟，见 smoke-test.js 的「漏状态表」。
  {
    setValue('#input', '漏状态表');
    click('#btn-send');
    const back = await settlePanelValue('金币', '88', 8000);
    check(
      '模型漏写状态表时，程序补问一次把值要了回来（100 → 88）',
      !!back,
      '等了 8 秒，金币还没变成 88'
    );

    // 补出来的状态表同样要按面板行剥掉 —— 气泡里只留正文
    const lastBubble = $$('#messages .msg').pop();
    check(
      '补写的状态表不会挂在气泡里',
      !!lastBubble && !/【金币】/.test(lastBubble.textContent || ''),
      lastBubble ? JSON.stringify(lastBubble.textContent.slice(-140)) : '没找到最后一条消息'
    );
  }

  // 收拾现场：把卡关掉 —— 下一个场景验「入口条常驻、点头像开卡」
  const closeCharCard = charCard().querySelector('.sc-close');
  if (closeCharCard) click(closeCharCard);
  await sleep(150);
});

// ---------------------------------------------------------------------------
//  场景 8b：续写路径也要把状态表要回来
//
//  「只思考没落笔 → 点继续」这条路绕开了主生成的补问分支（情形三）：正文被
//  「继续」补出来了，状态表却始终没写，状态卡就停在旧值上 —— 真实反馈里
//  「一整局都没更新过一次」就是这么来的。断言：点完继续，金币被补问要了回来。
// ---------------------------------------------------------------------------
await scenario('续写：也把状态表补回来', async () => {
  const lastAssistant = () => $$('#messages .msg.assistant').pop();

  setValue('#input', '续写找状态表');
  click('#btn-send');

  // 主生成只思考不落笔 → 落在那条「点继续」的兜底说明上（正文为空）
  await waitFor(
    '落在「只思考没落笔」的兜底说明上',
    () => {
      const node = lastAssistant();
      return !!node && /只输出了思考过程/.test(node.textContent || '');
    },
    8000
  );
  await waitFor('流式结束', () => byId('btn-send').disabled === false, 8000);

  const node = lastAssistant();
  check('兜底说明这条上有「继续」', !!node && !!buttonByText(node, '继续'));

  click(buttonByText(node, '继续'));
  const back = await settlePanelValue('金币', '55', 8000);
  await waitFor('流式结束', () => byId('btn-send').disabled === false, 8000);

  const convosNow = await window.mimitale.getConversations();
  const act = convosNow.conversations.find((c) => c.id === convosNow.activeId);
  const lastNow = lastAssistant();
  const contentNode = lastNow ? lastNow.querySelector('.msg-content') : null;
  const tail = contentNode ? contentNode.textContent : '（没有内容节点）';
  check(
    '续写之后也会补问状态表（88 → 55）',
    !!back,
    '面板=' + JSON.stringify(act && act.panel) + ' / 气泡尾部=' + JSON.stringify(tail.slice(-160))
  );
});

// ---------------------------------------------------------------------------
//  场景 9：状态卡入口条 —— 一直在这儿，点头像开卡
// ---------------------------------------------------------------------------
await scenario('状态卡入口条：常驻 + 点头像开卡', async () => {
  await waitFor('入口条在', () => shown('#panel-box') && !!byId('panel-cast'));

  // 旧面板的折叠开关/字段区/提示行都去掉了 —— 入口条只有一行头像，没有可收的内容
  check(
    '旧面板的折叠开关 / 字段区 / 提示行都已移除',
    !byId('btn-panel-collapse') && !byId('panel-fields') && !byId('panel-hint') && !byId('btn-panel-reset'),
    JSON.stringify({
      collapse: !!byId('btn-panel-collapse'),
      fields: !!byId('panel-fields'),
      hint: !!byId('panel-hint'),
      reset: !!byId('btn-panel-reset')
    })
  );

  const boxH = Math.round(byId('panel-box').getBoundingClientRect().height);
  check('入口条一直可见（一条细条）', boxH > 0 && boxH < 90, `${boxH}px`);

  // 头像行就是入口。普通聊天不显示「我」（2026-10-08），
  // 这条会话绑了角色，所以头像行上只有那个角色。
  const owners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
  check('普通聊天的入口条没有「我」，只有绑定的角色', owners.length === 1 && owners[0] !== 'player', JSON.stringify(owners));
  const avatarBox = $$('#panel-cast .panel-avatar')[0].getBoundingClientRect();
  check('头像可见可点', avatarBox.height > 0 && avatarBox.width > 0, `${Math.round(avatarBox.width)}×${Math.round(avatarBox.height)}`);

  // 点头像 → 开那个角色的状态卡；再点 ✕ 收掉
  const firstOwner = owners[0];
  const cardOf = () => $(`#state-cards .state-card[data-owner="${CSS.escape(firstOwner)}"]`);
  click($$('#panel-cast .panel-avatar')[0]);
  await waitFor('状态卡从入口条打开', () => !!cardOf());
  click(cardOf().querySelector('.sc-close'));
  await sleep(150);
  check('点 ✕ 把卡收掉了', !cardOf());

  // 顶栏那个「状态」按钮早就去掉了，别再回来
  check('顶栏的「状态」按钮已移除', !byId('btn-panel-toggle'));
});

// ---------------------------------------------------------------------------
//  场景 9.5：认不出归属的字段 —— 并回主角，不再单开一张「世界」卡
//
//  用户在真实对局里发现的坑：AI 输出状态栏时**不会给主角加「角色名·」前缀**，
//  于是主角的字段全解析成「无主」，跑到一张单独的卡里去了。
//  结果是「我的状态」显示的是开局初值、「世界」卡显示的是当下的真实值 ——
//  同一批字段分两份、值还对不上。
//
//  现在：扫描收尾时把无主字段**全部并回 player**（同名用 AI 那份覆盖、
//  新字段整个搬过去），入口条上不再有「世界」这个入口。
//  会话里认不出主角是谁时（既没绑卡、也没玩家角色）原样不动，不瞎认领。
//
//  ⚠️ 这一段**不发消息** —— 后面几个场景都依赖「当前会话的最后一条回复」
//     是它们自己造的那条；在这里多发一轮会把那条顶掉。所以只走数据层。
// ---------------------------------------------------------------------------
await scenario('无主状态字段：并回主角，不单开世界卡', async () => {
  await waitFor('入口条在', () => shown('#panel-box') && !!byId('panel-cast'));

  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);

  const convo = (stateMod.state.conversations || []).find((c) => c.id === stateMod.state.activeId);
  check('拿到当前会话', !!convo);
  if (!convo) return;

  const key = (name, owner) => panelMod.panelKey(name, owner);
  const ownerOf = (k) => panelMod.panelFieldOwner(convo, k);
  const nameOf = (k) => panelMod.panelFieldName(k);

  // --- 1) 认得出主角时：无主字段并回 player --------------------------------
  // 这个会话绑了角色卡（上面的场景绑的），所以主角名 = 那张卡的名字。
  const cardMod = await import(new URL('js/data/library.js', document.baseURI).href);
  const boundCard = cardMod.characterById(convo.characterId);
  check('会话绑了角色卡（主角名能从卡上认出来）', !!boundCard, String(convo.characterId));
  if (!boundCard) return;

  // 造三个无主字段（模拟 AI 没带前缀时的输出），覆盖三种认领规则：
  //   · 上衣   —— 角色卡上有这个名字 → 规则 1，归**角色**
  //   · 醉意   —— 主角那边没有、角色卡也没有 → 规则 3，归**主角**
  //   · 好感度 —— 同上（主角那边没这个名字）→ 归主角
  panelMod.appendPanelFields(convo, [
    { name: '上衣', value: '（AI 改成的新衣服）' },
    { name: '好感度', value: '63/100' },
    { name: '醉意', value: '10/100' }
  ]);
  check(
    '造出三个无主字段（模拟 AI 没带前缀时的输出）',
    convo.panelFields.filter((k) => !ownerOf(k)).length === 3,
    JSON.stringify(convo.panelFields.filter((k) => !ownerOf(k)).map((k) => [nameOf(k), ownerOf(k)]))
  );

  panelMod.absorbTopLevelIntoPlayer(convo);

  check(
    '并完之后一个无主字段都不剩',
    !convo.panelFields.some((k) => !ownerOf(k)),
    JSON.stringify(convo.panelFields.map((k) => [nameOf(k), ownerOf(k)]))
  );
  check(
    '规则1：角色卡上声明过的字段名归角色（不是归主角）',
    convo.panel[key('上衣', boundCard.id)] === '（AI 改成的新衣服）',
    JSON.stringify({
      cardOwner: boundCard.id,
      got: convo.panel[key('上衣', boundCard.id)],
      playerGot: convo.panel[key('上衣', 'player')]
    })
  );
  check(
    '规则2：单角色聊天里，AI 自己编的新字段也归那张卡（不归玩家）',
    // 这个会话绑了角色卡、没有玩家角色 → 是单角色聊天，无主字段全归那张卡。
    convo.panelFields.some((k) => ownerOf(k) === boundCard.id && nameOf(k) === '醉意') &&
      !!convo.panel[key('醉意', boundCard.id)],
    JSON.stringify(convo.panelFields.filter((k) => ownerOf(k) === boundCard.id).map(nameOf))
  );

  // --- 2) 认不出主角时：原样不动，不瞎认领 --------------------------------
  const bare = {
    id: 'bare', panel: {}, panelFields: [], panelDefs: {}, messages: [],
    player: null, characterId: null
  };
  panelMod.appendPanelFields(bare, [{ name: '天气', value: '阴' }]);
  panelMod.absorbTopLevelIntoPlayer(bare);
  check(
    '认不出主角是谁时不动无主字段（宁可留着也不瞎认领）',
    bare.panelFields.length === 1 && !panelMod.panelFieldOwner(bare, bare.panelFields[0]),
    JSON.stringify(bare.panelFields)
  );

  // --- 3) 手改优先：player 那边手改过就不被 AI 那份顶掉 --------------------
  const manualConvo = {
    id: 'mc', player: { name: '阿甲' }, characterId: null,
    panel: {}, panelFields: [], panelDefs: {}, messages: []
  };
  panelMod.appendPanelFields(manualConvo, [{ name: '金币', value: '50', owner: 'player' }]);
  panelMod.setPanelField(manualConvo, key('金币', 'player'), '88');
  panelMod.appendPanelFields(manualConvo, [{ name: '金币', value: '12' }]);
  panelMod.absorbTopLevelIntoPlayer(manualConvo);
  check(
    '手改过的值不会被无主那份顶掉',
    manualConvo.panel[key('金币', 'player')] === '88',
    JSON.stringify(manualConvo.panel)
  );
  check(
    '顶掉不成立时无主那份也要清掉（不留重复）',
    !manualConvo.panelFields.some((k) => !panelMod.panelFieldOwner(manualConvo, k)),
    JSON.stringify(manualConvo.panelFields)
  );

  // --- 4) 世界会话（有玩家角色 + 多个角色）：认不出的新字段归主角 ----------
  // 这是规则 4 的独立验证 —— 上面那个会话是单角色聊天，会走规则 2，
  // 覆盖不到「主角」这条分支。这里用一份合成数据（不碰真实会话）。
  const worldLike = {
    id: 'world-like',
    characterId: null,
    player: { name: '露西诺' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  // 造一个「角色持有上衣」的形状 → 规则 1 该把无主的上衣认给这个角色
  panelMod.appendPanelFields(worldLike, [{ name: '上衣', value: '灰色外套', owner: 'wc_x' }]);
  panelMod.appendPanelFields(worldLike, [
    { name: '上衣', value: '灰色外套（搭在了椅背上）' },
    { name: '体力', value: '34/100' }
  ]);
  panelMod.absorbTopLevelIntoPlayer(worldLike);
  check(
    '世界会话里，没带前缀的字段并回主角（规则 4）',
    worldLike.panel[key('体力', 'player')] === '34/100' &&
      !worldLike.panelFields.some((k) => !panelMod.panelFieldOwner(worldLike, k)),
    JSON.stringify(worldLike.panelFields.map((k) => [panelMod.panelFieldName(k), panelMod.panelFieldOwner(worldLike, k)]))
  );

  // --- 5) 入口条上不再有「世界/场景」这个入口 ------------------------------
  const sceneBtn = $$('#panel-cast .panel-avatar').find(
    (b) => b.dataset.owner === 'scene' || b.dataset.kind === 'scene'
  );
  check(
    '入口条上没有「世界/场景」入口了',
    !sceneBtn,
    JSON.stringify($$('#panel-cast .panel-avatar').map((b) => [b.dataset.owner, b.dataset.kind]))
  );

  // --- 收拾现场：把刚才造的字段恢复原样，别影响后面的场景 -------------------
  // 上衣：规则 1 把它并给了角色卡，恢复成卡上的初始值（「布衣」是那张卡上的值）
  convo.panel[key('上衣', boundCard.id)] = '布衣';
  // 好感度 / 醉意：这次被认领了，删掉（后面 21 场景会自己扫出来）
  for (const n of ['好感度', '醉意']) {
    for (const k of [key(n, 'player'), key(n, boundCard.id)]) {
      convo.panelFields = convo.panelFields.filter((x) => x !== k);
      delete convo.panel[k];
      delete convo.panelDefs[k];
    }
  }
  delete convo.panelManual;
});

// ---------------------------------------------------------------------------
//  场景 9.6：面板字段数到顶时，不能把认领不成的无主字段删掉
//
//  真 bug：absorbTopLevelIntoPlayer 的 claim() 只在「目标键真的建出来了」时才该
//  把源字段划掉，但 remove.add(key) 是无条件执行的。字段数到了 MAX_PANEL_FIELDS(120)
//  之后目标建不出来，源字段却照样被移除 —— 于是**所有**走规则 1/2 的无主字段
//  连同值一起消失，120 个字段能当场塌成 1 个。
//  旁边的规则 3/4 是显式 else if，走不到就什么都不做，两条路本来该一个脾气。
// ---------------------------------------------------------------------------
await scenario('状态字段：字段数到顶时不能把无主的删掉', async () => {
  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const libMod = await import(new URL('js/data/library.js', document.baseURI).href);
  const key = (name, owner) => panelMod.panelKey(name, owner);

  const card = libMod.characters()[0];
  check('库里有卡可以拿来当「绑定角色」', !!card, JSON.stringify(libMod.characters().map((c) => c.name)));
  if (!card) return;

  // 合成一份「已经到顶」的会话：119 个无主字段 + 1 个角色持有字段 = 120
  const atCap = {
    id: 'panel-at-cap',
    characterId: card.id,
    player: null,
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  panelMod.appendPanelFields(atCap, [{ name: '已归属字段', value: '1', owner: card.id }]);
  for (let i = 0; i < 119; i += 1) {
    panelMod.appendPanelFields(atCap, [{ name: `无主${i}`, value: `v${i}` }]);
  }
  check(
    '先造到 120 个字段（正好到顶）',
    atCap.panelFields.length === panelMod.MAX_PANEL_FIELDS,
    `字段数 ${atCap.panelFields.length} / 上限 ${panelMod.MAX_PANEL_FIELDS}`
  );

  const beforeCount = atCap.panelFields.length;
  const beforeValue = atCap.panel[atCap.panelFields.find((k) => panelMod.panelFieldName(k) === '无主0')];
  panelMod.absorbTopLevelIntoPlayer(atCap);

  check(
    '到顶之后字段数没有被清空',
    atCap.panelFields.length === beforeCount,
    `并完之后 ${atCap.panelFields.length} 个（原来 ${beforeCount} 个）`
  );
  check(
    '无主字段的值还在（认领不成就不动它）',
    atCap.panel[atCap.panelFields.find((k) => panelMod.panelFieldName(k) === '无主0')] === beforeValue,
    JSON.stringify({ want: beforeValue })
  );
});

// ---------------------------------------------------------------------------
//  场景 9.8：分支持久化要照搬「视角设置」
//
//  真 bug：branchSkeleton 的注释写着「戏本身的东西照搬：…视角设置」，实现却漏了
//  narrationMode / paceMode。convoNarrationMode 查不到就回落到
//  默认档 —— 从「上帝视角 + 快节奏」分出来的新线悄悄变成「标准 + 一步一步」，
//  提示词变了、顶栏档位标签没了，全程不报错。
// ---------------------------------------------------------------------------
await scenario('分支：视角设置要跟着走', async () => {
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const key = 'branch-skeleton-source';

  const source = {
    id: key,
    title: '源会话',
    characterId: null,
    worldbookIds: [],
    dialoguePresetIds: null,
    player: { name: '阿甲' },
    panel: {},
    panelFields: [],
    panelDefs: {},
    gmMode: false,
    narrationMode: 'god',
    paceMode: 'brisk',
    messages: [
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' }
    ],
    summaries: []
  };

  const branch = convMod.branchSkeleton(source, 2);
  check('叙述模式跟着分叉走（不再回落到标准）', branch.narrationMode === 'god', JSON.stringify(branch.narrationMode));
  check('推进节奏跟着分叉走（不再回落到一步一步）', branch.paceMode === 'brisk', JSON.stringify(branch.paceMode));
  check('前两条消息照常复制过去', (branch.messages || []).length === 2, String((branch.messages || []).length));
});

// ---------------------------------------------------------------------------
//  场景 9.9：数字设置框清空后不能静默变成 64 / 1 / 0
//
//  真 bug：`Number('')` 是 **0、不是 NaN**，所以 readSettingsForm 里所有
//  `isNaN(x) ? 默认值 : ...` 的分支全是死代码。把「回复上限」清空再保存，
//  存下去的是被夹到下限的 64（之后每条回复都被截断）；「对话轮数」变 1
//  （历史等于没了）；递归深度变 0。界面重开还显示那个被夹过的值。
//  现在的口径：清空 = 没改，退回原来存着的值。
// ---------------------------------------------------------------------------
await scenario('设置：清空数字框等于没改，不静默夹到下限', async () => {
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));

  const before = ((await window.mimitale.getSettings()).settings || {});
  const beforeMaxTokens = Number(before.maxTokens);
  const beforeMaxTurns = Number(before.maxTurns);

  // 先把两个框设成「一个不同于内置默认值的值」，再清空。
  // 否则「退回原来存着的值」和「退回内置默认值」这两种实现分不出来 ——
  // （回复上限的测试初值就是 512，而内置默认是 8192；对话轮数初值正好是 20=默认，
  //   所以这个场景必须自己先改一下再清空。）
  const probeTokens = beforeMaxTokens === 8192 ? 4096 : beforeMaxTokens;
  const probeTurns = beforeMaxTurns === 20 ? 33 : beforeMaxTurns;
  setValue('#s-maxtokens', String(probeTokens));
  setValue('#s-max-turns', String(probeTurns));
  click('#btn-save-settings');
  await waitFor('探针值已保存', () => !shown('#settings-modal'));
  await sleep(150);

  click('#btn-settings');
  await waitFor('设置弹窗打开（改完再清）', () => shown('#settings-modal'));
  setValue('#s-maxtokens', '');
  setValue('#s-max-turns', '');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#settings-modal'));
  await sleep(150);

  const after = ((await window.mimitale.getSettings()).settings || {});
  check(
    '清空「回复上限」不会变成夹取下限 64 / 内置默认 8192',
    Number(after.maxTokens) === probeTokens,
    JSON.stringify({ 探针值: probeTokens, 内置默认: 8192, after: after.maxTokens })
  );
  check(
    '清空「对话轮数」不会变成 1 / 内置默认 20',
    Number(after.maxTurns) === probeTurns,
    JSON.stringify({ 探针值: probeTurns, 内置默认: 20, after: after.maxTurns })
  );

  // 收尾：还原成进这个场景之前的值，后面的场景还等着它们
  click('#btn-settings');
  await waitFor('设置弹窗再开', () => shown('#settings-modal'));
  setValue('#s-maxtokens', String(beforeMaxTokens));
  setValue('#s-max-turns', String(beforeMaxTurns));
  click('#btn-save-settings');
  await waitFor('设置已还原', () => !shown('#settings-modal'));
});

// ---------------------------------------------------------------------------
//  场景 9.10：拉取模型列表失败时，「地址写错」不能被说成「这家没有这个接口」
//
//  真 bug：判据里除了状态码还有一段中文关键词匹配，而 main/http.js 给 404 写的
//  提示正是「404 找不到接口：多半是「接口地址」写错了」、给 400 写的是
//  「参数不被该服务商接受」—— 两个词都被撞上，于是地址写错会被当成
//  「这家不支持拉取模型列表」，弹一句成功语气的兜底提示。
// ---------------------------------------------------------------------------
await scenario('设置：地址写错不会被误诊成「没有模型列表接口」', async () => {
  const catMod = await import(new URL('js/views/settingsCatalog.js', document.baseURI).href);
  const looks = catMod.looksLikeUnsupportedModelList;

  // main/http.js 真实产出的那几句（照抄，别改口径）
  const msg404 = '404 找不到接口：多半是「接口地址」写错了，应类似 https://api.deepseek.com。';
  const msg400 = '400 请求被拒绝：多半是参数不被该服务商接受（比如 max_tokens 超范围、模型名不对）。';
  const msg401 = '401 未授权：API Key 不对或已失效。';
  const msg406 = '406 请求不被接受：服务端（或它前面的网关）拒绝了这次请求的格式。';
  const msg405 = '405 Method Not Allowed';

  check('400（参数/鉴权类）不算「没有模型列表接口」', looks(msg400) === false, JSON.stringify(msg400));
  check('401 不算「没有模型列表接口」', looks(msg401) === false, JSON.stringify(msg401));
  check('406 不算（是网关拒了，不是端点不存在）', looks(msg406) === false, JSON.stringify(msg406));

  // 这些才是真的「这个端点不存在」
  check('404 仍然算（兼容层没有 /models 就是它）', looks(msg404) === true, JSON.stringify(msg404));
  check('405 仍然算', looks(msg405) === true, JSON.stringify(msg405));
  check('501 仍然算', looks('501 Not Implemented') === true, '');
});

// ---------------------------------------------------------------------------
//  场景 9.12：发不出去的消息不能把用户打的字吃掉
//
//  真 bug：发送按钮和回车都是「先把输入框清空、再调 sendMessage」，而 sendMessage
//  有一堆早退路径（没配模型、没填 Key、正在生成中）。每一条都会把用户刚打的字丢掉，
//  而且不报错、只弹一句提示 —— 全新安装时第一条「你好」就是这么没的
//  （待发的图片反而是校验之后才清的，所以图还在、字没了）。
//  现在的口径：sendMessage 返回「到底发出去没有」，只有真发出去了才清空。
// ---------------------------------------------------------------------------
await scenario('输入框：发不出去时字要留着', async () => {
  const FILLED = '这段字不能被吃掉';

  // --- 路径一：没填 API Key（最常见的第一次发送） ---
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  const keyBefore = byId('p-apikey').value;
  setValue('#p-apikey', '');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#settings-modal'));
  await sleep(150);

  setValue('#input', FILLED);
  click('#btn-send');
  // 走的是「请先填写 XX 的 API Key」那条早退
  await waitFor('弹出缺 Key 的提示', () => {
    const t = byId('toast');
    return t && /API Key/.test(t.textContent || '');
  }, 5000);
  check(
    '没填 Key 时，输入框里的字还在（没被静默清掉）',
    byId('input').value === FILLED,
    JSON.stringify(byId('input').value)
  );
  // 那条提示确实弹出来了（不是「什么都没发生」）
  check(
    '并且给出了「先填 API Key」的说法',
    /API Key/.test((byId('toast') || {}).textContent || ''),
    JSON.stringify(((byId('toast') || {}).textContent) || '')
  );

  // 恢复 Key，别影响后面的场景
  await sleep(200);
  click('#btn-settings');
  await waitFor('设置弹窗再开（恢复 Key）', () => shown('#settings-modal'));
  setValue('#p-apikey', keyBefore || 'test-key');
  click('#btn-save-settings');
  await waitFor('Key 已恢复', () => !shown('#settings-modal'));
  await sleep(150);

  // --- 路径二：正在生成中按回车（输入框在流式期间并没有禁用） ---
  setValue('#input', '正在生成时打的字');
  // 手动把界面切成「流式中」：发送按钮禁用 + state.streaming
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const prevStreaming = stateMod.state.streaming;
  stateMod.state.streaming = true;
  byId('btn-send').disabled = true;

  const composerMod = await import(new URL('js/views/composer.js', document.baseURI).href);
  const didSend = await composerMod.sendMessage('正在生成时打的字');
  check('流式期间 sendMessage 明确报告「没发出去」', didSend === false, JSON.stringify(didSend));
  check(
    '流式期间也不会把输入框清掉',
    byId('input').value === '正在生成时打的字',
    JSON.stringify(byId('input').value)
  );

  stateMod.state.streaming = prevStreaming;
  byId('btn-send').disabled = false;
  setValue('#input', '');
});

// ---------------------------------------------------------------------------
//  场景 9.11：数值字段不能把非数值内容写成「烦躁/100」
// ---------------------------------------------------------------------------
await scenario('状态字段：数值字段不吞非数值内容', async () => {
  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const key = (name, owner) => panelMod.panelKey(name, owner);

  const convo = {
    id: 'meter-guard',
    characterId: null,
    player: { name: '阿甲' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };

  // 数值字段（0-100）却收到一个中文值 —— 属性值输入框本来就是自由文本，
  // 切类型也不会清掉已输入的内容，所以这条路很容易走到。
  panelMod.appendPanelFields(convo, [
    { name: '心情', type: 'meter', min: 0, max: 100, value: '烦躁', owner: 'player' }
  ]);
  const moodKey = convo.panelFields.find((k) => panelMod.panelFieldName(k) === '心情');
  check(
    '非数值内容不会被拼上「/100」',
    convo.panel[moodKey] === '烦躁',
    JSON.stringify(convo.panel[moodKey])
  );

  // 真的只写了分子时，仍要补齐分母（老行为不能丢）
  panelMod.appendPanelFields(convo, [
    { name: '体力', type: 'meter', min: 0, max: 100, value: '60', owner: 'player' }
  ]);
  const hpKey = convo.panelFields.find((k) => panelMod.panelFieldName(k) === '体力');
  check(
    '只写分子（60）时仍然补成 60/100',
    convo.panel[hpKey] === '60/100',
    JSON.stringify(convo.panel[hpKey])
  );

  // --- 幽灵字段：玩家没填名字时，注入用的前缀是「我」，
  //     模型照着抄回来必须还能反查成 player，不能变成一条新的无主字段 ---
  const nameless = {
    id: 'ghost-owner',
    characterId: null,
    player: { name: '' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  panelMod.appendPanelFields(nameless, [
    { name: '好感度', value: '80', owner: 'player' }
  ]);
  const label = panelMod.panelOwnerLabel(nameless, 'player');
  check('没填名字时前缀是「我」', label === '我', JSON.stringify(label));

  // 关键：注入用的是这个前缀，模型会照着抄回来 —— 它必须能被反查回 player，
  // 否则「我·好感度」就成了一条新的无主字段（状态卡多一行重复、真字段停在旧值）
  const backTo = panelMod.ownerIdByLabel(nameless, label);
  check(
    '「我」这个前缀能反查回 player（不会变成幽灵字段）',
    backTo === 'player',
    JSON.stringify({ label, backTo })
  );
});

// ---------------------------------------------------------------------------
//  场景 10：聊天 —— 发一条能收到回复
// ---------------------------------------------------------------------------
await scenario('聊天：发送与回复', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  // 用「消息条数」判断新回复，而不是找某个文字 ——
  // 这个会话里可能已经有别的回复带着同样的文字了（属性场景就发过一条）
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '冒烟测试：你好');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').disabled === false, 8000);

  check('用户消息已渲染', $('#messages').textContent.includes('冒烟测试：你好'));
  check('助手回复已渲染', $('#messages').textContent.includes('冒烟测试回复'));
  check('没有出现错误气泡', $$('#messages .msg.error').length === 0);
  check('发送按钮恢复可用（没有卡在流式状态）', byId('btn-send').disabled === false);
  check('停止按钮已隐藏', shown('#btn-stop') === false);

  // 重点的两档样式：**加粗** 和 ==高亮== 要变成真元素，而不是原样显示星号/等号
  const strong = $('#messages strong');
  check('**加粗** 渲染成了 <strong>', !!strong && strong.textContent === '这是加粗', strong ? strong.textContent : `原始文本里有没有 **：${$('#messages').textContent.includes('**')}`);
  const em = $('#messages .msg-em');
  check('==高亮== 渲染成了 .msg-em', !!em && em.textContent === '这是高亮', em ? em.textContent : '没找到 .msg-em');
  check('标记符号本身没有露出来', !$('#messages').textContent.includes('**') && !$('#messages').textContent.includes('=='), $('#messages').textContent.slice(0, 80));
});

// ---------------------------------------------------------------------------
//  场景 11：消息 —— 就地编辑 + 继续生成
// ---------------------------------------------------------------------------
await scenario('消息：编辑与继续', async () => {
  const assistantNodes = () => $$('#messages .msg.assistant');
  const lastNode = () => assistantNodes().pop();
  const actionsOf = (node) => Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim());

  check('有 AI 回复可以操作', assistantNodes().length >= 1, `实际 ${assistantNodes().length} 条`);

  // --- 「继续」只该出现在最后一条，中间的回复后面早就接上别的话了 ---
  check('最后一条上有「继续」', actionsOf(lastNode()).includes('继续'), JSON.stringify(actionsOf(lastNode())));
  if (assistantNodes().length > 1) {
    const first = assistantNodes()[0];
    check('中间那条没有「继续」', !actionsOf(first).includes('继续'), JSON.stringify(actionsOf(first)));
  }
  check('每条都有「编辑」', actionsOf(lastNode()).includes('编辑'), JSON.stringify(actionsOf(lastNode())));

  // --- 继续：应该是「追加」，不是「替换」---
  const before = lastNode().querySelector('.msg-content').textContent;
  click(buttonByText(lastNode(), '继续'));
  await waitFor('内容变长', () => {
    const node = lastNode();
    return node && node.querySelector('.msg-content').textContent.length > before.length;
  }, 8000);
  await waitFor('流式结束', () => byId('btn-send').disabled === false, 8000);

  const after = lastNode().querySelector('.msg-content').textContent;
  check('继续是追加而不是替换', after.startsWith(before) && after.length > before.length, `${before.length} 字 → ${after.length} 字`);
  check('原来那段一个字没少', after.slice(0, before.length) === before);

  // --- 编辑：先试「取消」---
  click(buttonByText(lastNode(), '编辑'));
  await waitFor('出现编辑框', () => !!lastNode().querySelector('.msg-edit-box'));
  // 编辑框里必须是**原文**（带 ** == 这些标记），不能是渲染后的文本 ——
  // 给渲染后的文本一保存，标记就没了
  const boxValue = lastNode().querySelector('.msg-edit-box').value;
  check('编辑框里给的是原文而不是渲染结果', boxValue.includes('**这是加粗**') && boxValue.includes('==这是高亮=='), boxValue.slice(0, 40));
  check('原文和屏幕上显示的长度不一样（正好说明给的是源文本）', boxValue.length !== after.length, `源 ${boxValue.length} 字 / 显示 ${after.length} 字`);

  // 编辑框比原来的气泡高，展开后「保存 / 取消」可能被顶到视口外面去
  // （截图时真踩到过：只滚 textarea 没用，被切掉的是它下面那行按钮）
  const listRect = byId('messages').getBoundingClientRect();
  const actionsRect = lastNode().querySelector('.msg-edit-actions').getBoundingClientRect();
  check(
    '「保存 / 取消」在视口里（没被顶出去）',
    actionsRect.bottom <= listRect.bottom + 1,
    `按钮底 ${Math.round(actionsRect.bottom)} / 容器底 ${Math.round(listRect.bottom)}`
  );

  setValue(lastNode().querySelector('.msg-edit-box'), '不该被保存的内容');
  click(buttonByText(lastNode(), '取消'));
  await sleep(200);
  check('取消后原文没变', lastNode().querySelector('.msg-content').textContent === after);

  // --- 空内容要拦住（想删就用「删除」）---
  click(buttonByText(lastNode(), '编辑'));
  await waitFor('出现编辑框', () => !!lastNode().querySelector('.msg-edit-box'));
  setValue(lastNode().querySelector('.msg-edit-box'), '   ');
  click(buttonByText(lastNode(), '保存'));
  await sleep(200);
  check('空内容不许保存', !!lastNode().querySelector('.msg-edit-box'));

  // --- 真正保存 ---
  setValue(lastNode().querySelector('.msg-edit-box'), '改过的回复内容：**加粗**');
  click(buttonByText(lastNode(), '保存'));
  await waitFor('内容被替换', () => $('#messages').textContent.includes('改过的回复内容'), 5000);
  await sleep(250);

  check('保存后正文换成新的了', lastNode().querySelector('.msg-content').textContent.includes('改过的回复内容'));
  check('保存后编辑框收起', !lastNode().querySelector('.msg-edit-box'));
  check('新内容里的标记照样渲染', !!lastNode().querySelector('strong'), '没渲染出 <strong>');

  // --- 落盘 ---
  await sleep(450);
  const convos = (await window.mimitale.getConversations()).conversations;
  const edited = convos.find((c) => (c.messages || []).some((m) => m.content === '改过的回复内容：**加粗**'));
  check('编辑结果落盘了', !!edited);
});

// ---------------------------------------------------------------------------
//  场景 12：重新生成候选（swipe）
// ---------------------------------------------------------------------------
await scenario('消息：重新生成候选', async () => {
  const lastNode = () => $$('#messages .msg.assistant').pop();
  const navOf = (node) => node.querySelector('.variant-nav');
  const countOf = (node) => {
    const nav = navOf(node);
    return nav ? nav.querySelector('.variant-count').textContent.trim() : null;
  };
  const contentOf = (node) => node.querySelector('.msg-content').textContent;

  // 还没重新生成过：不该有候选切换
  check('只有一个版本时没有候选切换', !navOf(lastNode()), countOf(lastNode()) || '（没有）');

  const before = contentOf(lastNode());

  // --- 重新生成：应该「多出一条候选」，而不是把老的扔掉 ---
  click(buttonByText(lastNode(), '重新生成'));
  await waitFor('生成完', () => byId('btn-send').disabled === false, 10000);
  await sleep(250);

  check('重新生成后出现候选切换', !!navOf(lastNode()));
  check('计数是 2/2（停在刚生成的那条）', countOf(lastNode()) === '2/2', countOf(lastNode()));

  const after = contentOf(lastNode());
  check('显示的是新生成的那条', after !== before && after.includes('冒烟测试回复'), after.slice(0, 24));

  // --- 往左翻：应该回到老的那条 ---
  click(navOf(lastNode()).querySelectorAll('button')[0]);
  await sleep(250);
  check('左翻后计数变 1/2', countOf(lastNode()) === '1/2', countOf(lastNode()));
  check('左翻后正文回到老的那条', contentOf(lastNode()) === before, contentOf(lastNode()).slice(0, 24));
  check('刚才那条没丢（正文不是空的）', contentOf(lastNode()).length > 0);

  // --- 往右翻回来 ---
  click(navOf(lastNode()).querySelectorAll('button')[1]);
  await sleep(250);
  check('右翻后计数变 2/2', countOf(lastNode()) === '2/2', countOf(lastNode()));
  check('右翻后正文又变回新的那条', contentOf(lastNode()) === after);

  // --- 翻回第一条收尾：后面的场景（导出）要看正文里有「改过的回复内容」---
  click(navOf(lastNode()).querySelectorAll('button')[0]);
  await sleep(250);
  check('收尾时停在第一条', countOf(lastNode()) === '1/2', countOf(lastNode()));

  // --- 落盘 ---
  await sleep(450);
  const convos = (await window.mimitale.getConversations()).conversations;
  const withVariants = convos
    .flatMap((c) => c.messages || [])
    .find((m) => Array.isArray(m.variants) && m.variants.length > 1);
  check('候选数组落盘了', !!withVariants, JSON.stringify(withVariants && withVariants.variants.map((v) => String(v).slice(0, 12))));
  check('落盘了两条候选', !!withVariants && withVariants.variants.length === 2, String(withVariants && withVariants.variants.length));
  check(
    'content 和当前选中的候选一致',
    !!withVariants && withVariants.content === withVariants.variants[withVariants.variantIndex],
    JSON.stringify({ idx: withVariants && withVariants.variantIndex })
  );
});

// ---------------------------------------------------------------------------
//  回归：摘要覆盖点越界时，不能把用户刚说的话从上下文里切掉
//
//  真 bug：buildApiMessages 里 `covered` 是在 convoContextMessages()（只认正文非空）
//  上数出来的下标，却拿去 slice 另一个数组 history（它多留「只带图不打字」的消息）。
//  两个数组一旦不等长，covered 就越界，slice 回来是空数组 ——
//  整轮请求只剩摘要 + 人设，**用户刚打的那句话都不会发出去**，模型照着旧摘要答，
//  表现得像完全没看见你说了什么。
//
//  最容易撞上的路径：一个已经被自动摘要过的老会话 → 「清空对话」→ 重新开聊。
//  消息清空了，convo.summaries 还原封不动留着，covered 就成了一个巨大的下标。
//
//  这里不依赖任何界面状态，直接用真模块算一遍。
// ---------------------------------------------------------------------------
await scenario('摘要：覆盖点越界也不能吞掉当前对话', async () => {
  let messagesMod = null;
  let stateMod = null;
  try {
    messagesMod = await import(new URL('js/data/messages.js', document.baseURI).href);
    stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    check('上下文拼装模块能加载', typeof messagesMod.buildApiMessages === 'function');
  } catch (err) {
    check('上下文拼装模块能加载', false, (err && err.message) || String(err));
  }

  if (!messagesMod || typeof messagesMod.buildApiMessages !== 'function') return;

  const savedSettings = stateMod.state.settings;
  stateMod.state.settings = { ...(savedSettings || {}), maxTurns: 20 };

  // 「清空对话」之后的现场：摘要还留着（覆盖到第 28 条），消息只剩一条是真的。
  // 前后那两条是**老存档里遗留**的「只带图不打字」的用户消息（「发图」入口 2026-10-08
  // 已经去掉），末尾还挂着一条空的 assistant 占位 —— 这几种都不能被原样发出去。
  const convo = {
    id: 'smoke-stale-summary',
    messages: [
      { role: 'user', content: '', images: ['data:image/png;base64,AAA'] },
      { role: 'user', content: '刚打的一句话' },
      { role: 'user', content: '', images: ['data:image/png;base64,BBB'] },
      { role: 'assistant', content: '' }
    ],
    summaries: [{ start: 0, end: 28, title: '第 1 段', text: '以前的剧情…' }]
  };

  const out = messagesMod.buildApiMessages(convo, '', '', '');
  const dialogue = out.filter((m) => m.role === 'user' || m.role === 'assistant');
  const texts = dialogue.map((m) => String(m.content || ''));

  check('越界的摘要覆盖点不会把对话切空', dialogue.length > 0, `对话消息 ${dialogue.length} 条`);
  check(
    '用户刚打的那句话还在发给模型的请求里',
    texts.some((t) => t.includes('刚打的一句话')),
    JSON.stringify(texts.map((t) => t.slice(0, 16)))
  );
  // 「只带图不打字」的老消息和末尾的空占位都必须被滤掉：它们没有文字，
  // 原样发出去就是一条 content 为空的 user / assistant 消息，严格的接口直接 400。
  // （图不再转多模态数组之后，这条是唯一的防线 —— 之前靠「转成数组」顺带躲过去的。）
  check(
    '没有 content 为空的消息被发出去',
    dialogue.length > 0 && dialogue.every((m) => String(m.content || '').trim()),
    JSON.stringify(dialogue.map((m) => ({ role: m.role, len: String(m.content || '').length })))
  );
  check(
    '摘要仍然照常注入（该省的历史没白省）',
    out.some((m) => String(m.content || '').includes('以前的剧情')),
    ''
  );

  stateMod.state.settings = savedSettings;
});

// ---------------------------------------------------------------------------
//  回归：设置里的「默认人设」只能进「跟模型聊天」的会话，不许漏进世界模式 / 角色卡
//
//  真 bug：buildApiMessages 里人设原来写成 `character ? '' : assistantPersona(convo)`。
//  绑了卡时 character 为真所以没事，但**进世界（GM）时 character 是 null** ——
//  于是那段模型人设照样被拼进系统提示词。现场就是：GM 一手拿着世界书里的大学设定，
//  一手自称「鲸鱼娘」，回复里还在纠结「我到底是哪边的人」（用户报的原文）。
//
//  这条和页面侧、宿主侧的探针是三件事：
//    · 页面侧只验表单读写得对（probeAssistantPersona 那一段的界面部分）
//    · 宿主侧探针验的是**真的发出去的那份**（默认对话里带人设、且不带扮演规则）
//    · 这里补的是**反面**：世界模式 / 角色卡里一个字的模型人设都不该有
//  直接用真模块算，不依赖界面状态，最省事也最稳。
// ---------------------------------------------------------------------------
await scenario('默认人设：只进通用对话，不漏进世界模式和角色卡', async () => {
  let messagesMod = null;
  let stateMod = null;
  try {
    messagesMod = await import(new URL('js/data/messages.js', document.baseURI).href);
    stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    check('上下文拼装模块能加载', typeof messagesMod.buildApiMessages === 'function');
  } catch (err) {
    check('上下文拼装模块能加载', false, (err && err.message) || String(err));
  }
  if (!messagesMod || typeof messagesMod.buildApiMessages !== 'function') return;

  const savedSettings = stateMod.state.settings;
  const backupChars = stateMod.state.characters;
  const MARK = '你是一只叫团子的猫';
  const PERSONA_NAME = '团子';
  const MODEL = '人设守卫模型';

  // 人设按**模型名**查表，所以给这个模型装一份，再让各条会话都用它。
  stateMod.state.settings = {
    ...(savedSettings || {}),
    maxTurns: 20,
    activeModel: MODEL,
    assistantPersonas: { [MODEL]: { name: PERSONA_NAME, persona: `${MARK}，只用喵喵叫回应。` } }
  };
  stateMod.state.characters = [
    ...(Array.isArray(backupChars) ? backupChars : []),
    {
      id: 'smoke-persona-card',
      name: '顾言',
      systemPrompt: '你是顾言，樱川大学摄影社的学长。',
      description: '',
      personality: ''
    }
  ];

  const blob = (out) => out.map((m) => String((m && m.content) || '')).join('\n');

  try {
    // --- 1) 世界模式（GM）：没有「某个人」，人设一个字都不该有 ---
    const gmConvo = {
      id: 'smoke-persona-gm',
      model: MODEL,
      gmMode: true,
      worldbookIds: [],
      player: { name: '小怡', profile: '大一女生。' },
      messages: [{ role: 'user', content: '扫完立刻通过，顺手给他改个备注' }]
    };
    // 世界书段由调用方拼好传进来：这里塞一个 {{char}} 进去，
    // 顺带验「GM 下没有具体角色，宏落成叙述者」——人设名绝不能出现在这儿。
    const gmOut = blob(messagesMod.buildApiMessages(gmConvo, '【世界设定】\n{{char}} 是这里的叙述者。', ''));
    check('世界模式：没混进「默认人设」正文', !gmOut.includes(MARK), gmOut.slice(0, 90));
    check('世界模式：也没混进人设的名字', !gmOut.includes(PERSONA_NAME), gmOut.slice(0, 90));
    check('世界模式：主持规则照常注入', gmOut.includes('【主持规则】'));
    check('世界模式：玩家角色段照常注入', gmOut.includes('【玩家角色：小怡】'));
    check(
      '世界模式：{{char}} 落成「叙述者」，不是人设名',
      gmOut.includes('叙述者 是这里的叙述者') && !gmOut.includes(`${PERSONA_NAME} 是`),
      gmOut.slice(0, 90)
    );

    // --- 2) 绑角色卡的会话：卡自己的 systemPrompt 说了算，人设不参与 ---
    const cardConvo = {
      id: 'smoke-persona-card-convo',
      model: MODEL,
      characterId: 'smoke-persona-card',
      messages: [{ role: 'user', content: '你好' }]
    };
    const cardOut = blob(messagesMod.buildApiMessages(cardConvo, '', ''));
    check('角色卡：没混进「默认人设」正文', !cardOut.includes(MARK), cardOut.slice(0, 90));
    check('角色卡：用上了卡自己的 systemPrompt', cardOut.includes('樱川大学摄影社的学长'));
    check('角色卡：扮演规则照常注入', cardOut.includes('【扮演规则】'));

    // --- 3) 通用对话（对照组）：人设必须照旧生效，别修反了 ---
    const plainConvo = {
      id: 'smoke-persona-plain',
      model: MODEL,
      messages: [{ role: 'user', content: '你好' }]
    };
    const plainOut = blob(messagesMod.buildApiMessages(plainConvo, '', ''));
    check('通用对话：人设正文照旧注入', plainOut.includes(MARK), plainOut.slice(0, 90));
    check(
      '通用对话：仍然不带扮演 / 主持规则',
      !plainOut.includes('【扮演规则】') && !plainOut.includes('【主持规则】')
    );
  } finally {
    stateMod.state.settings = savedSettings;
    stateMod.state.characters = backupChars;
  }
});

// ---------------------------------------------------------------------------
//  场景 14：给剧情配图（生图）
//
//  生图和聊天是**两套配置**，所以这里从「还没配」开始走完整条路：
//  没配 → 没有「配图」按钮 → 去设置里配一组 → 按钮出现 → 点它 → 图上到那条消息上。
// ---------------------------------------------------------------------------
await scenario('给剧情配图（生图）', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  const lastAssistant = () => $$('#messages .msg.assistant').pop();
  const actionsOf = (node) => Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim());

  // 先自己发一条，拿到一条**正常的回复**再来配图 —— 别借上一个场景的残留。
  // 以前这里是蹭「给 AI 看图」场景留下的那条回复，而那个场景已经删掉；
  // 于是末条变成了「就地编辑」场景改过的内容，宿主侧那条「提示词取自回复正文」
  // 的断言（认的是「冒烟测试回复」）当场就不成立了。
  setValue('#input', '给这段剧情配张图吧');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 10000);
  await sleep(300);

  check('没配生图时不显示「配图」', !actionsOf(lastAssistant()).includes('配图'), JSON.stringify(actionsOf(lastAssistant())));

  // --- 去设置里配一组 ---
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  await sleep(150);

  check('设置里有生图服务商下拉', !!byId('s-image-provider'));
  const providerCount = ((await window.mimitale.getSettings()).settings.providers || []).length;
  const imgOptions = Array.from(byId('s-image-provider').options).map((o) => o.value);
  check(
    '下拉里是「不启用」+ 全部服务商',
    imgOptions.length === providerCount + 1 && imgOptions.includes('p-img'),
    `${imgOptions.length} 项（服务商 ${providerCount} 个）：${JSON.stringify(imgOptions)}`
  );

  setValue('#s-image-provider', 'p-img');
  await sleep(200);
  // 模型下拉跟着服务商走 —— 这是这次改的重点，得钉住
  const imgModelOptions = Array.from(byId('s-image-model').options).map((o) => o.value);
  check(
    '生图模型是下拉，而且跟着服务商填好',
    byId('s-image-model').tagName === 'SELECT' && imgModelOptions.length === 1 && imgModelOptions[0] === 'img-model-x',
    `${byId('s-image-model').tagName} ${JSON.stringify(imgModelOptions)}`
  );

  // 注意：「生图模型下拉并入内置目录」这条不在这里测。
  // 它需要服务商的 baseUrl 命中内置目录，而这个冒烟环境里的服务商都是
  // 127.0.0.1 的假地址、命不中；临时加一个服务商又会牵动
  // settings:save 的合并与下拉重填，测起来很脆。
  // 这条逻辑由 tools 外的纯函数测试覆盖（fillModelSelect 是纯函数，用假 DOM 跑）。
  setValue('#s-image-model', 'img-model-x');
  setValue('#s-image-size', '1024x1024');
  await sleep(200);

  // 尺寸下拉：不认识的模型给通用尺寸，不能是空下拉
  const genericSizes = Array.from(byId('s-image-size').options).map((o) => o.value);
  check(
    '尺寸是下拉，未知模型给通用尺寸',
    byId('s-image-size').tagName === 'SELECT' && genericSizes.includes('1024x1024'),
    `${byId('s-image-size').tagName} ${JSON.stringify(genericSizes)}`
  );

  // 已知模型要给出它专属的尺寸（智谱 glm-image 就那 7 个固定值）
  addAndSelect('#s-image-model', 'glm-image');
  await sleep(200);
  const sizeSel = byId('s-image-size');
  const glmOptions = Array.from(sizeSel.options);
  const glmSizes = glmOptions.map((o) => o.value);
  const recommended = ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'];
  check(
    '选 glm-image 时尺寸下拉是它推荐的 7 个值（顺序一致）',
    JSON.stringify(glmSizes.slice(0, 7)) === JSON.stringify(recommended),
    `实际=${JSON.stringify(glmSizes)}`
  );
  // 之前存的 1024x1024 不在推荐列表，但按官方自定义规则合法（1024-2048、32 的倍数），
  // 所以应被保留为「自定义」而不是被丢掉或纠正
  check(
    '已存的合法自定义尺寸被保留并标注（glm-image 的 1024x1024 按自定义规则合法）',
    glmSizes.length === 8 &&
      glmSizes[7] === '1024x1024' &&
      /自定义/.test(glmOptions[7].textContent),
    JSON.stringify(glmOptions.map((o) => o.textContent))
  );
  check('glm-image 的尺寸默认选中 1280x1280', sizeSel.value, '1280x1280');

  // 换回通用模型，尺寸选项也要跟着换回去
  setValue('#s-image-model', 'img-model-x');
  await sleep(200);
  const backSizes = Array.from(sizeSel.options).map((o) => o.value);
  check(
    '换回未知模型时尺寸选项回到通用列表',
    backSizes.includes('1024x1024') && !backSizes.includes('1568x1056'),
    JSON.stringify(backSizes)
  );

  // 继续后面的流程
  setValue('#s-image-size', '1024x1024');
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#settings-modal'));
  await sleep(400);

  const saved = (await window.mimitale.getSettings()).settings;
  check(
    '生图配置落盘了（和聊天模型是分开的两个字段）',
    saved.imageProviderId === 'p-img' && saved.imageModel === 'img-model-x' && saved.activeModel === 'test-model',
    JSON.stringify({ img: saved.imageProviderId + '/' + saved.imageModel, chat: saved.activeProviderId + '/' + saved.activeModel })
  );

  // --- 配好之后按钮才出现 ---
  await sleep(300);
  check('配好之后出现「配图」', actionsOf(lastAssistant()).includes('配图'), JSON.stringify(actionsOf(lastAssistant())));

  const before = lastAssistant().querySelectorAll('.bubble-image').length;
  click(buttonByText(lastAssistant(), '配图'));
  await waitFor('图画好了', () => lastAssistant().querySelectorAll('.bubble-image').length > before, 15000);
  check('图挂到了那条消息上', lastAssistant().querySelectorAll('.bubble-image').length === before + 1, String(lastAssistant().querySelectorAll('.bubble-image').length));

  // --- 落盘 ---
  await sleep(700);
  const withImage = (await window.mimitale.getConversations()).conversations
    .flatMap((c) => c.messages || [])
    .filter((m) => m.role === 'assistant' && Array.isArray(m.images) && m.images.length);
  check('生成的图落盘了', withImage.length >= 1, String(withImage.length));
  check('图是 data:image/ 开头（不是外链）', withImage.length ? String(withImage[0].images[0]).startsWith('data:image/') : false);
});

// ---------------------------------------------------------------------------
//  场景 15：外观弹窗里「只管聊天区」的那几样（字号 / 加粗颜色 / 背景图）
//  主题配色和明暗在场景 2 / 2b，它们在同一个弹窗但管整个界面。
// ---------------------------------------------------------------------------
await scenario('外观：聊天区那几样', async () => {
  click('#btn-appearance');
  await waitFor('外观弹窗打开', () => shown('#appearance-modal'));
  check(
    '聊天区三样控件都在（字号 / 颜色 / 背景）',
    !!byId('appearance-fontsize') && !!byId('appearance-boldcolor-text') && !!byId('btn-pick-bg')
  );
  check(
    '管整个界面的两样也在这个弹窗里（配色 / 明暗）',
    !!byId('appearance-accents') && !!byId('appearance-modes')
  );

  const bubble = $('#messages .bubble');
  const strong = $('#messages .bubble strong');
  check('聊天里有个 <strong> 可以用来验颜色', !!bubble && !!strong);

  // --- 字号 ---
  const beforeSize = getComputedStyle(bubble).fontSize;
  setValue('#appearance-fontsize', '20');
  byId('appearance-fontsize').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('字号改了正文的实际大小', getComputedStyle(bubble).fontSize === '20px', `${beforeSize} → ${getComputedStyle(bubble).fontSize}`);
  check('旁边的数字也跟着变', byId('appearance-fontsize-value').textContent === '20px', byId('appearance-fontsize-value').textContent);
  check('字号落盘了', (await window.mimitale.getSettings()).settings.chatFontSize === 20);

  // 滑块的「已选比例」是自己用渐变画的（原生那条未选轨道在浅色下是黑的），
  // 所以值一变就得跟着更新 —— 12–22 的滑条拉到 20 是 80%
  const fill = byId('appearance-fontsize').style.getPropertyValue('--range-fill');
  check('滑块的已选比例跟着值走', fill === '80%', `--range-fill = ${fill}`);

  // --- 加粗颜色：手填 ---
  setValue('#appearance-boldcolor-text', '#e06c75');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('加粗字真的变色了', getComputedStyle(strong).color === 'rgb(224, 108, 117)', getComputedStyle(strong).color);
  check('颜色落盘了', (await window.mimitale.getSettings()).settings.chatBoldColor === '#e06c75');

  // 不带 # 也认
  setValue('#appearance-boldcolor-text', '00aaff');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('不带 # 也认', (await window.mimitale.getSettings()).settings.chatBoldColor === '#00aaff', (await window.mimitale.getSettings()).settings.chatBoldColor);

  // 乱填要挡下来，而且不能把原来的值冲掉
  setValue('#appearance-boldcolor-text', 'red');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check(
    '乱填的颜色被拒绝、原值不变',
    (await window.mimitale.getSettings()).settings.chatBoldColor === '#00aaff',
    (await window.mimitale.getSettings()).settings.chatBoldColor
  );

  // --- 背景图：走真实的「选图 → 压缩 → 存起来」链路 ---
  click('#btn-pick-bg');
  await waitFor('背景预览出现', () => shown('#appearance-bg-preview') && !!$('#appearance-bg-preview img'), 10000);
  check('消息区挂上了背景图', getComputedStyle($('#messages')).backgroundImage.includes('data:image'), getComputedStyle($('#messages')).backgroundImage.slice(0, 50));
  check(
    '背景图落盘了',
    String((await window.mimitale.getSettings()).settings.chatBackground).startsWith('data:image/'),
    String((await window.mimitale.getSettings()).settings.chatBackground).slice(0, 40)
  );

  // --- 清除 ---
  click('#btn-clear-bg');
  await sleep(250);
  check('清掉之后消息区没有背景图', !getComputedStyle($('#messages')).backgroundImage.includes('data:image'), getComputedStyle($('#messages')).backgroundImage);
  check('没背景时「清除」是禁用的', byId('btn-clear-bg').disabled === true);

  click('#btn-boldcolor-reset');
  await sleep(250);
  check(
    '复位后加粗颜色不再自定义（留空 = 跟随主题配色）',
    (await window.mimitale.getSettings()).settings.chatBoldColor === ''
  );

  // 留空时加粗色应当等于**当前主题配色** —— 不是「跟随正文颜色」。
  // 使用说明一直写着「留空就跟随主题配色」，而样式表以前回落到 inherit（正文色），
  // 两边不一致（2026-10-08 修）。这里把「留空到底等于什么颜色」钉死。
  const accentProbe = document.createElement('span');
  accentProbe.style.color = 'var(--accent)';
  document.body.appendChild(accentProbe);
  const accentRgb = getComputedStyle(accentProbe).color;
  const accentHex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  accentProbe.remove();

  const strongNow = $('#messages .bubble strong');
  check(
    '留空时加粗色 = 主题配色（不是正文色）',
    !!strongNow && getComputedStyle(strongNow).color === accentRgb && accentRgb !== getComputedStyle($('#messages .bubble')).color,
    `${strongNow ? getComputedStyle(strongNow).color : '没有 strong'} vs 主题色 ${accentRgb}`
  );
  check(
    '没自定义时色盘显示的就是主题配色',
    byId('appearance-boldcolor').value.toLowerCase() === accentHex.toLowerCase(),
    `${byId('appearance-boldcolor').value} vs ${accentHex}`
  );

  click('#btn-close-appearance');
  await waitFor('外观弹窗关闭', () => !shown('#appearance-modal'));
});

// ---------------------------------------------------------------------------
//  场景 15b：编辑类弹窗头上的「放大到窗口」按钮
//  四个弹窗各一颗（角色卡 / 世界书 / 设置 / 预设），行为一样：把**那个弹窗自己**
//  铺满应用窗口（纯渲染层：给 .modal 挂 modal-max，CSS 撑满；不碰 BrowserWindow，
//  所以这里没有假后端可验 —— 验的就是 class + 按钮状态）。
//  ⚠️ 场景结束必须把两个弹窗都关掉、且不留 modal-max：后面的截图/布局断言
//     都按「弹窗是正常大小」算，留着放大的状态会拍出一张铺满屏幕的图。
// ---------------------------------------------------------------------------
await scenario('编辑弹窗的放大按钮', async () => {
  const ids = ['btn-fs-chars', 'btn-fs-worldbooks', 'btn-fs-settings', 'btn-fs-preset'];
  const maxed = (id) => byId(id).classList.contains('modal-max');
  check('四个编辑弹窗头上都有放大按钮', ids.every((id) => !!byId(id)));

  // --- 开一下、放大、还原 ---
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  check('刚打开时不是放大状态', !maxed('settings-modal'));

  click('#btn-fs-settings');
  await waitFor('弹窗放大', () => maxed('settings-modal'));
  check('点一下把弹窗放大到窗口', maxed('settings-modal'));
  // 图标是「四角向外 / 向内」两张 SVG 二选一，只看 class 验不出来；
  // aria-pressed 和 title 是读屏 / 悬停唯一能读到的状态，必须跟着走。
  check('放大后按钮标成「已按下」', byId('btn-fs-settings').getAttribute('aria-pressed') === 'true');
  check('放大后按钮改说「还原」', /还原/.test(byId('btn-fs-settings').getAttribute('title') || ''));

  click('#btn-fs-settings');
  await waitFor('弹窗还原', () => !maxed('settings-modal'));
  check('再点一下还原回正常大小', !maxed('settings-modal'));
  check('还原后按钮回到「未按下」', byId('btn-fs-settings').getAttribute('aria-pressed') === 'false');

  // --- 状态挂在各自的弹窗上：放大了设置，别的不该跟着放大 ---
  click('#btn-fs-settings');
  await waitFor('设置再放大', () => maxed('settings-modal'));
  check('放大只作用于它自己那个弹窗',
    !maxed('worldbooks-modal') && !maxed('chars-modal') && !maxed('preset-modal'));

  // --- 关掉弹窗时把放大状态摘掉，下次打开别记住 ---
  click('#btn-close-settings');
  await waitFor('设置弹窗关闭', () => !shown('#settings-modal'));
  check('关掉弹窗时放大状态被摘掉', !maxed('settings-modal'));

  click('#btn-settings');
  await waitFor('设置弹窗重开', () => shown('#settings-modal'));
  check('重新打开回到正常大小（不记住上次放大）', !maxed('settings-modal'));
  click('#btn-close-settings');
  await waitFor('设置弹窗再关', () => !shown('#settings-modal'));

  // --- 另一颗按钮管的是它自己那个弹窗 ---
  // 弹窗得真的打开再点：按钮在 .modal-head 里，弹窗没开时它压根不可见。
  // 注意 #btn-worldbooks 进的是**列表页**，编辑器得再从卡片上点「编辑」才出来。
  click('#btn-worldbooks');
  await waitFor('切到世界书列表页', () => shown('#view-worldbooks'));
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书编辑器打开', () => shown('#worldbooks-modal'));
  click('#btn-fs-worldbooks');
  await waitFor('世界书放大', () => maxed('worldbooks-modal'));
  check('世界书那颗按钮放大的是世界书弹窗', maxed('worldbooks-modal') && !maxed('settings-modal'));
  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));

  check('收尾后没有任何弹窗还留着放大状态',
    ['settings-modal', 'worldbooks-modal', 'chars-modal', 'preset-modal'].every((id) => !maxed(id)));
});

// ---------------------------------------------------------------------------
//  场景 12：导出（角色卡 / 世界书 / 会话）
//
//  这里只负责「点按钮 + 看渲染层交了什么东西给主进程」；
//  真正的「写 PNG → 读 PNG」往返由宿主侧用同一份实现跑（见 smoke-test.js）。
// ---------------------------------------------------------------------------
await scenario('导出', async () => {
  // 说明：导出交上去的东西在页面里看不见（发给主进程了），
  // 所以具体内容由宿主侧断言（见 smoke-test.js 的 probeExports）；
  // 这里只负责点按钮 + 确认给了反馈。

  // --- 角色卡 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click(buttonByText($$('#char-page-grid .char-card')[0], '编辑'));
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  // 先给它绑一本世界书再导出 —— 这样「导出的卡带不带 character_book」
  // 才验得到（宿主侧的 probeExports 会看导出的卡里有没有这本）。
  click('#c-wb-add-btn');
  await waitFor('世界书选择浮层出现', () => !!$('.cwb-picker'));
  const exportBook = $$('.cwb-picker .cwb-picker-row').find((o) =>
    String(o.textContent || '').includes('冒烟测试世界')
  );
  if (exportBook) {
    click(exportBook);
    await waitFor('导出场景：世界书绑上了', () => $$('#c-wb-list .cwb-row').length === 1);
  } else {
    check('导出场景：能选到种子世界书', false, JSON.stringify($$('.cwb-picker .cwb-picker-row').map((o) => o.textContent.trim())));
  }

  click('#btn-export-char');
  await sleep(300);
  check('导出角色卡后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);
  click('#btn-close-chars');
  await sleep(150);

  // --- 会话 ---
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await clickMoreItem('#btn-export-convo');
  await sleep(300);
  check('导出会话后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);

  // --- 空会话不该导出：点「聊天」会新建一个还没说话的空会话 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  await startChatWith($$('#char-page-grid .char-card')[0]);
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(150);
  await clickMoreItem('#btn-export-convo');
  await sleep(250);
  check('空会话不给导出', $('#toast').textContent.includes('还是空的'), $('#toast').textContent);
});

// ---------------------------------------------------------------------------
//  场景 15：世界书递归扫描
//
//  种子世界里埋了一条链：世界总览(递归) → 十二泰坦 / 火种。
//  只要会话里出现「翁法罗斯」，总览命中，它的正文再带出另外两条。
//  真实现跑在 main/worldbook-match.js，假后端直接 require 它。
// ---------------------------------------------------------------------------
await scenario('世界书：递归扫描', async () => {
  // 先让当前会话里出现触发词
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  setValue('#input', '翁法罗斯到底是个什么样的地方？');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 8000);
  await sleep(250);

  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  await sleep(150);

  click('#btn-preview-wb');
  await sleep(400);
  const toast = $('#toast').textContent;

  check('直接命中的那条在', toast.includes('世界总览'), toast);
  check('递归把「十二泰坦」带进来了', toast.includes('十二泰坦'), toast);
  check('递归带进来的条目也能再往下带（火种）', toast.includes('火种'), toast);
  check('说明了有几条是递归来的', toast.includes('2 条是递归带进来的'), toast);
  check('没命中的条目不会被塞进来', !toast.includes('无关条目'), toast);

  // 预览失败时不该弹「命中 0 条」之外的东西
  check('预览给的是命中摘要', toast.includes('命中 3 条'), toast);
});

// ---------------------------------------------------------------------------
//  场景 16：世界书 —— 新建条目 + 「保存后才生效」
// ---------------------------------------------------------------------------
await scenario('世界书：新建条目', async () => {
  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));
  check('种子里那本世界书有卡片', $$('#wb-page-grid .char-card').length === 1);

  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));

  click('#btn-new-entry');
  setValue('#wb-e-title', '冒烟测试条目');
  setValue('#wb-e-keys', '冒烟');
  setValue('#wb-e-content', '命中时注入的设定内容');

  // 左栏那一行跟着表单走（改了名字立刻看得到 —— 以前是点「保存条目」才回填的）
  await waitFor('条目出现在列表里', () => $('#wb-entry-list').textContent.includes('冒烟测试条目'));

  // 「保存后才生效」：改动先落在草稿里，没点保存之前磁盘上不该有它
  check('没保存的条目不会提前落盘',
    !((await savedWorldbooks())[0].entries || []).some((e) => e.title === '冒烟测试条目'),
    `落盘的是 ${JSON.stringify(((await savedWorldbooks())[0].entries || []).map((e) => e.title))}`);
  check('底部亮起「有未保存的改动」', shown('#wb-dirty-hint'), byId('wb-dirty-hint').textContent);

  click('#btn-save-wb');
  await sleep(300);

  const books = await savedWorldbooks();
  const titles = (books[0].entries || []).map((e) => e.title);
  check('点「保存」之后条目才落盘', titles.includes('冒烟测试条目'), `落盘的是 ${JSON.stringify(titles)}`);
  check('保存完「有未保存的改动」自己收掉', !shown('#wb-dirty-hint'), byId('wb-dirty-hint').textContent);
  check('保存有提示', $('#toast').textContent.includes('已保存'), $('#toast').textContent);

  // 顺便把这本书导出一次（这时书里已经有条目了，才验得到条目字段的映射）
  click('#btn-export-wb');
  await sleep(300);
  check('导出世界书后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);
});

// ---------------------------------------------------------------------------
//  场景 16b：世界书 —— 关弹窗时「没保存的改动」要拦一下
// ---------------------------------------------------------------------------
await scenario('世界书：放弃未保存的改动', async () => {
  // 世界书弹窗还开着（上一条场景留下的）
  check('世界书弹窗还开着', shown('#worldbooks-modal'));

  setValue('#wb-name', '改了一半的名字');
  await sleep(120);
  check('改名之后亮起未保存提示', shown('#wb-dirty-hint'), byId('wb-dirty-hint').textContent);

  // 点关闭 → 先问一句；选「继续改」就什么都别动
  click('#btn-close-worldbooks');
  await waitFor('弹放弃确认框', () => shown('#confirm-modal'));
  check('有未保存的改动时关弹窗会问一句', shown('#confirm-modal'));
  click('#confirm-cancel');
  await sleep(120);
  check('选「继续改」弹窗留着', shown('#worldbooks-modal'));
  check('名字还是改了一半的那个', byId('wb-name').value === '改了一半的名字', byId('wb-name').value);

  // 再来一次，这回真的放弃
  click('#btn-close-worldbooks');
  await waitFor('再弹一次确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));

  const names = (await savedWorldbooks()).map((b) => b.name);
  check('放弃之后改的名字没落盘', !names.includes('改了一半的名字'), JSON.stringify(names));
  check('列表页卡片还是落盘过的那个名字',
    $$('#wb-page-grid .char-card-name').some((n) => n.textContent === '冒烟测试世界'),
    JSON.stringify($$('#wb-page-grid .char-card-name').map((n) => n.textContent)));
});

// ---------------------------------------------------------------------------
//  场景 11：世界书 —— 新建「本书角色」，同时验证编辑器没被世界书弹窗盖住
// ---------------------------------------------------------------------------
await scenario('世界书：本书角色', async () => {
  // 上一条场景把弹窗关掉了，这里自己从列表页开进去
  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));

  click('#btn-new-wb-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  check('标题是「新建本书角色」', byId('chars-title').textContent === '新建本书角色', byId('chars-title').textContent);

  // 回归测试：角色编辑器必须盖在世界书弹窗上面（否则点了跟没反应一样）
  const cx = Math.floor(innerWidth / 2);
  const cy = Math.floor(innerHeight / 2);
  const top = document.elementFromPoint(cx, cy);
  const where = top ? (top.closest('#chars-modal') ? 'chars' : top.closest('#worldbooks-modal') ? 'worldbooks' : 'other') : 'null';
  check('编辑器没有被世界书弹窗盖住', where === 'chars', `最上层是 ${where}`);

  const before = ((await savedWorldbooks())[0].characters || []).length;

  setValue('#c-name', '冒烟NPC');
  click('#btn-save-char');
  await waitFor('副本 chip 出现', () => $('#wb-char-list').textContent.includes('冒烟NPC'));

  const after = ((await savedWorldbooks())[0].characters || []).length;
  check('副本已落盘', after === before + 1, `期望 ${before + 1}，实际 ${after}`);

  click('#btn-close-chars');
  await sleep(120);
  check('副本保存后关闭不弹确认框', !shown('#confirm-modal'));

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
});

// ---------------------------------------------------------------------------
//  场景 11.5：AI 生成角色 —— 角色库那一侧
//
//  假后端认「system 里有『你是一位角色设定师』」（见 tools/smoke-test.js）。
//  这里只验「点按钮 → 弹窗 → 生成 → 字段真的填进编辑器草稿 → 保存才落盘」这条链，
//  不验生成质量（那是提示词的事，测不了）。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：角色库', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));

  const before = (await savedCharacters()).length;

  // 列表页确实多了一个入口，而且它不会顺手创建什么
  check('角色库有「AI 生成」按钮', !!byId('btn-ai-char'));

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  // 角色库这条路姓「角色」，不是「NPC」—— 两者提示词完全不同
  check('弹窗是角色库那一版', $('.ai-gen-modal').textContent.includes('AI 生成角色'), $('.ai-gen-modal').textContent.slice(0, 40));

  const prompt = $('#ai-gen-prompt');
  check('弹窗里有描述输入框', !!prompt);
  setValue('#ai-gen-prompt', '一个话很少的守夜人');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  // 生成完直接把字段填进角色编辑器草稿
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  // 解析失败时也会开草稿（把原文塞进描述），光看「有没有开」分不出成功和兜底 ——
  // 所以再看一眼描述框：兜底那份的标题一定是「未命名角色」。
  check('生成后打开的是新建草稿', byId('chars-title').textContent === '新建角色', byId('chars-title').textContent);
  check(
    '走的是正常解析，不是「解析失败」兜底',
    byId('c-desc').value.length > 0 && byId('c-name').value !== '未命名角色',
    `name=${byId('c-name').value} / desc=${byId('c-desc').value.slice(0, 30)}`
  );
  check('名字已回填', byId('c-name').value === '守夜人', byId('c-name').value);
  check('描述已回填', byId('c-desc').value.includes('深夜值班'), byId('c-desc').value);
  check('标签已回填', byId('c-tags').value.includes('测试'), byId('c-tags').value);
  check('属性已回填', $('#c-attr-list') && $('#c-attr-list').textContent.includes('好感度'), $('#c-attr-list') && $('#c-attr-list').textContent);

  // 最要紧的一条：**这一步还不该落盘** —— 和「新建角色」一样，点保存才算数
  await sleep(150);
  check('生成后还没落盘（要用户点保存才创建）', (await savedCharacters()).length === before, `期望 ${before}，实际 ${(await savedCharacters()).length}`);

  click('#btn-save-char');
  await waitFor('落盘完成', async () => (await savedCharacters()).length === before + 1);
  const saved = (await savedCharacters())[before] || {};
  check('保存后角色进了角色库', saved.name === '守夜人', saved.name);
  check('落盘的属性也跟着进来了', (saved.attributes || []).length === 2, JSON.stringify(saved.attributes));
  // ⚠️ 这两条断言故意盯着**归一化之后的形状**，不是模型给的原样：
  //   · 数值字段落盘是 meter（没有 number 这个类型）
  //   · dynamic 是默认频率，存储时那个键会被省掉（见 main/panel-fields.js）
  const attrs = saved.attributes || [];
  check('数值属性落成了 meter', attrs.some((a) => a.name === '好感度' && a.type === 'meter'), JSON.stringify(attrs));
  check('默认频率（dynamic）不写多余的键', attrs.some((a) => a.name === '好感度' && a.mode === undefined), JSON.stringify(attrs));
});

// ---------------------------------------------------------------------------
//  场景 11.55：AI 生成角色 —— 角色库那侧的「背景 / 基调」（可选）
//
//  只有角色库那侧有这个框（世界书自带条目 + 开场白当大纲）。
//  验两件事：① 世界书那侧不该冒出这个框；② 填了之后那段真的进了 system。
//  第 ② 条靠假后端认「【背景 / 基调】」返回不同的名字（见 tools/smoke-test.js）。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：背景/基调框', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  check('角色库那侧有「背景 / 基调」框', !!byId('ai-gen-brief'));

  setValue('#ai-gen-prompt', '一个值夜班的店员');
  setValue('#ai-gen-brief', '现代都市的深夜便利店，安静、有点孤独');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  // 名字跟着「有没有基调」变 —— 还是「守夜人」就说明那段没拼进 system
  check('背景/基调确实拼进了提示词', byId('c-name').value === '便利店店员', byId('c-name').value);

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#chars-modal'));
});

// ---------------------------------------------------------------------------
//  场景 11.6：AI 生成角色 —— 模型返回的不是干净 JSON
//
//  真模型经常多写一句「好的，我按你说的写了一个」、再把 JSON 包进 ```json 围栏。
//  这条验的是兜底：必须剥掉围栏、切出花括号块，正常生成出角色，而不是报错。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：模型输出带围栏和废话', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  setValue('#ai-gen-prompt', '冒烟：烂JSON');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  check('带围栏的输出也能解析出角色', byId('c-name').value === '油烟贩子', byId('c-name').value);
  check('描述里没有残留的围栏标记', !byId('c-desc').value.includes('```'), byId('c-desc').value);

  // 这份草稿不要了 —— 关掉时弹的确认框要按「放弃」走
  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#chars-modal'));
});

// ---------------------------------------------------------------------------
//  场景 11.7：AI 生成 NPC —— 世界书那一侧
//
//  和角色库那条路共用弹窗和草稿，但上下文完全不同：它要带这本书的条目和副本名单。
//  假后端据 system 里有没有「【世界：」分辨走的是不是 NPC 那条路，返回的角色名
//  也因此不同（见 tools/smoke-test.js）—— 落盘的名字对不上就说明没带上下文。
// ---------------------------------------------------------------------------
await scenario('AI 生成 NPC：依据世界书', async () => {
  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));

  check('世界书里有「AI 生成」按钮', !!byId('btn-ai-wb-char'));

  const before = ((await savedWorldbooks())[0].characters || []).length;

  click('#btn-ai-wb-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  check('弹窗是 NPC 那一版', $('.ai-gen-modal').textContent.includes('AI 生成 NPC'), $('.ai-gen-modal').textContent.slice(0, 40));
  check('状态行说明了依据哪本书', $('.ai-gen-status').textContent.includes('冒烟测试世界'), $('.ai-gen-status').textContent);
  // 世界书那侧不该有「背景 / 基调」框 —— 它本身就有大纲（条目 + 开场白）
  check('世界书那侧没有「背景 / 基调」框', !byId('ai-gen-brief'));

  setValue('#ai-gen-prompt', '酒馆后厨的帮工');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  check('标题是「新建本书角色」', byId('chars-title').textContent === '新建本书角色', byId('chars-title').textContent);
  // 名字来自假后端的「带世界上下文」分支 —— 对不上就说明 system 里没带上这本书的设定
  check('生成时确实带上了这本书的上下文', byId('c-name').value === '后厨帮工', byId('c-name').value);

  await sleep(150);
  check('生成后副本还没落盘', ((await savedWorldbooks())[0].characters || []).length === before, String(((await savedWorldbooks())[0].characters || []).length));

  click('#btn-save-char');
  await waitFor('副本 chip 出现', () => $('#wb-char-list').textContent.includes('后厨帮工'));
  check('副本已落进这本书', ((await savedWorldbooks())[0].characters || []).length === before + 1, String(((await savedWorldbooks())[0].characters || []).length));

  click('#btn-close-chars');
  await sleep(120);
  check('副本保存后关闭不弹确认框', !shown('#confirm-modal'));

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
});

// ---------------------------------------------------------------------------
//  场景 12：进入世界 —— 玩家角色弹窗
// ---------------------------------------------------------------------------
await scenario('进入世界：用角色卡当自己', async () => {
  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));

  click(buttonByText($$('#wb-page-grid .char-card')[0], '游玩'));
  await waitFor('玩家角色弹窗打开', () => shown('#player-modal'));
  check('弹窗里有角色名输入框', !!byId('player-name'));

  // 角色库里有「属性测试角色」（带金币/上衣两个属性）
  const options = $$('#player-char option').map((o) => o.textContent);
  check('下拉里有「自己写一个」和角色库的人', options.includes('（自己写一个）') && options.includes('属性测试角色'), JSON.stringify(options));

  // --- 选一张角色卡：名字和设定应该自动填进去 ---
  const cardId = $$('#player-char option').find((o) => o.textContent === '属性测试角色').value;
  setValue('#player-char', cardId).dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(80);

  check('名字被自动填上了', byId('player-name').value === '属性测试角色', byId('player-name').value);
  check('设定也带过来了', byId('player-profile').value.length > 0, `${byId('player-profile').value.length} 字`);
  check('预览说明了会带上哪些属性', shown('#player-char-preview') && byId('player-char-preview').textContent.includes('金币'), byId('player-char-preview').textContent);

  // 填完还能改 —— 改了以你改的为准
  setValue('#player-name', '改过的名字');
  check('选了之后名字仍然可改', byId('player-name').value === '改过的名字');

  // --- 开始游玩：你自己的状态挪进「我的状态」卡，入口条只留人 ---
  click('#btn-start-play');
  await waitFor('进入世界', () => shown('#view-chat') && !shown('#player-modal'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  // 旧面板的**字段列表**已经不在了 —— 玩家自己的属性只在「我的状态」卡里。
  // 标题是「在场角色 N」（见上面那条断言）。
  check(
    '旧的「当前状态」字段区已经不在了',
    !byId('panel-fields') && !byId('btn-panel-collapse') && /在场角色/.test(byId('panel-box').textContent || '')
  );

  // 顶栏头像（2026-09-30）：世界书会话**没绑角色卡**（主角在 convo.player 里），
  // 所以走的是「方角 + 书名首字」那条分支 —— 形状本身就是分类，一眼区分
  // 「跟角色聊」和「在书里玩」。只绑角色的圆头像在场景 15 里验过。
  {
    const av = byId('topbar-avatar');
    check(
      '世界书会话的顶栏头像是方角的「书」',
      !!av && av.classList.contains('book'),
      av ? av.className : 'no-node'
    );
    check(
      '世界书会话的顶栏头像取书名首字',
      !!av && (av.textContent || '').trim().length === 1,
      av ? av.textContent : ''
    );
  }

  const myAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
  check('入口条上有「我」的头像', !!myAvatar);
  click(myAvatar);
  await waitFor('我的状态卡出现', () => !!$('#state-cards .state-card[data-owner="player"]'));

  const cardNames = $$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent);
  const cardValue = (field) => {
    const row = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
      (r) => r.querySelector('.sc-name').textContent === field
    );
    return row ? row.querySelector('.sc-value').textContent : null;
  };

  check('「我的状态」卡里有用角色卡种下的属性', cardNames.includes('金币') && cardNames.includes('上衣'), JSON.stringify(cardNames));
  check('身份四件套也在这张卡里', ['姓名', '年龄', '性别', '种族'].every((n) => cardNames.includes(n)), JSON.stringify(cardNames));
  check('姓名用的是你改过的名字', cardValue('姓名') === '改过的名字', String(cardValue('姓名')));
  check(
    '年龄/性别/种族来自角色卡',
    cardValue('年龄') === '18' && cardValue('性别') === '女' && cardValue('种族') === '精灵',
    JSON.stringify({ 年龄: cardValue('年龄'), 性别: cardValue('性别'), 种族: cardValue('种族') })
  );
  check('值来自角色卡的初始值', cardValue('金币') === '100', String(cardValue('金币')));

  // 收掉这张卡，别影响后面的场景
  const closeMyCard = $('#state-cards .state-card[data-owner="player"] .sc-close');
  if (closeMyCard) click(closeMyCard);

  // 会话里记下了「你用哪张卡当自己」，而且以你改过的名字为准
  await sleep(200); // persistConversations 是防抖的
  const convos = (await window.mimitale.getConversations()).conversations;
  const worldConvo = convos.find((c) => c.title === '冒烟测试世界');
  check('会话里记下了玩家角色', !!worldConvo && !!worldConvo.player, JSON.stringify(worldConvo && worldConvo.player));
  check('用的是你改过的名字', !!worldConvo && worldConvo.player.name === '改过的名字', worldConvo ? worldConvo.player.name : '');
  check('也记下了是哪张角色卡', !!worldConvo && worldConvo.player.characterId === cardId, worldConvo ? String(worldConvo.player.characterId) : '');
  check('玩家角色带上了设定文本', !!worldConvo && String(worldConvo.player.profile).length > 0);

  // 剧情选项：这张卡没在编辑器里配过 ── 按新默认应该是「开、每轮 4 条」。
  // 以前这里落的是 null，所以「世界书里自己写的主角 / 没配过的卡」全程没有选项。
  check(
    '进世界的会话也默认带上剧情选项（每轮 4 条）',
    !!worldConvo && !!worldConvo.optionsSpec && worldConvo.optionsSpec.count === 4,
    JSON.stringify(worldConvo && worldConvo.optionsSpec)
  );

  // 发一条：让「身份 + 属性真的注入给了模型」这件事也能被宿主验到
  setValue('#input', '冒烟测试：世界里的状态');
  click('#btn-send');
  await waitFor('收到回复', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
});

notes.push(`磁盘上的角色数：${(await savedCharacters()).length}`);
notes.push(`磁盘上的世界书数：${(await savedWorldbooks()).length}`);
notes.push(`会话数：${$$('#convo-list .convo-item').length}`);

// ---------------------------------------------------------------------------
//  场景 13：角色卡 —— 每个字段都能原样存下来
//
//  主进程的 normalizeCharacter 是白名单式的，只保留显式列出的字段，漏一个就
//  静默丢掉。这里把每个可编辑字段都填上不同值，再逐个核对回来没有。
// ---------------------------------------------------------------------------
await scenario('角色卡：字段往返不丢', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '字段往返测试';
  setValue('#c-name', NAME);
  setValue('#c-tags', '甲, 乙');
  // 年龄/性别/种族已从编辑器移除，不再通过 UI 填；它们的白名单保留行为
  // 由下方 saveCharacters 补数据后单独验证。
  setValue('#c-desc', 'D-描述');
  setValue('#c-personality', 'P-性格');
  setValue('#c-scenario', 'S-场景');
  setValue('#c-first', 'F-开场白');
  setValue('#c-example', 'E-示例');
  setValue('#c-system', 'SP-系统提示');
  setValue('#c-post', 'PH-后指令');
  setValue('#c-notes', 'CN-备注');

  setValue('#c-attr-new', '金币');
  click('#btn-add-attr');
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length === 1);
  setValue($$('#c-attr-list .attr-row')[0].querySelector('.attr-value'), '777');

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  // 身份三项走导入/数据层通道进来：验证 normalizeCharacter 白名单仍保留它们
  // （导入的外部卡会带这些字段，不能丢）。
  await window.mimitale.saveCharacters({
    characters: (await savedCharacters()).map((c) =>
      c.name === NAME ? { ...c, age: '23', gender: '男', race: '龙' } : c
    )
  });
  await sleep(100);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);

  const expect = {
    tags: ['甲', '乙'],
    age: '23',
    gender: '男',
    race: '龙',
    description: 'D-描述',
    personality: 'P-性格',
    scenario: 'S-场景',
    firstMes: 'F-开场白',
    mesExample: 'E-示例',
    systemPrompt: 'SP-系统提示',
    postHistoryInstructions: 'PH-后指令',
    creatorNotes: 'CN-备注'
  };
  for (const [key, want] of Object.entries(expect)) {
    const got = saved ? saved[key] : undefined;
    check(`字段 ${key} 没被丢掉`, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
  check(
    '属性没被丢掉',
    !!saved && Array.isArray(saved.attributes) && saved.attributes.length === 1 && saved.attributes[0].value === '777',
    JSON.stringify(saved && saved.attributes)
  );
});

// ---------------------------------------------------------------------------
//  场景：角色头像 / 形象 —— 两张图各管一处
//    头像（1:1）→ 消息气泡、状态卡；形象（2:3）→ 角色库列表，点开看大图。
//    上传走**真裁剪组件**（不是往框里直接塞图）：images:pick 的桩给一张
//    1×1 PNG，裁剪浮层照常弹、照常按目标比例输出。
// ---------------------------------------------------------------------------
await scenario('角色：头像和形象是两张图', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');

  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '双图测试角色';
  setValue('#c-name', NAME);

  // --- 两个上传框各就各位 ---
  check('编辑器里有两个上传框（头像 / 形象）', !!byId('char-avatar') && !!byId('char-portrait'));
  check(
    '两个框一开始都是「点击上传」',
    !!byId('char-avatar').querySelector('.char-avatar-empty') &&
      !!byId('char-portrait').querySelector('.char-avatar-empty')
  );

  // --- 头像 / 形象 挪到了表单最顶上，和角色名同级（不再有折叠的「图片」块）---
  check(
    '头像 / 形象 是表单第一个区块',
    !!$('.char-media-top') && byId('char-form').firstElementChild === $('.char-media-top')
  );
  check('没有可折叠的「图片」块了', !$('.char-media-section'));

  // --- 传头像：点框 → 弹裁剪 → 「用这块」 ---
  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪头像」', byId('crop-layer').textContent.includes('裁剪头像'));
  click('#crop-ok');
  // dataURL 的解码是异步的，等到尺寸出来再断言，别读到 0
  await waitFor('头像按 384 落进框里', () => {
    const i = byId('char-avatar').querySelector('img');
    return !!i && i.naturalWidth === 384;
  });

  const avImg = byId('char-avatar').querySelector('img');
  check(
    '头像按 1:1 裁（384×384）',
    !!avImg && avImg.naturalWidth === 384 && avImg.naturalHeight === 384,
    avImg ? `${avImg.naturalWidth}×${avImg.naturalHeight}` : '框里没图'
  );

  // 这张卡只有一张图 —— 形象那一栏先沿用头像，并标出「沿用」
  check(
    '还没单独设形象时，形象框先沿用头像并标记',
    !!byId('char-portrait').querySelector('img') && byId('char-portrait').classList.contains('is-inherited')
  );

  // --- 传形象 ---
  click('#char-portrait');
  await waitFor('裁剪浮层又弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪角色形象」', byId('crop-layer').textContent.includes('裁剪角色形象'));
  click('#crop-ok');
  // 光等「框里有 img」不够 —— 还没单独设形象时，框里本来就沿用着头像那张。
  // 等到尺寸变成 1024 才说明新裁的那张真的换上了。
  await waitFor('形象换成新裁的那张', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });
  check('设过形象之后不再标「沿用头像」', !byId('char-portrait').classList.contains('is-inherited'));

  const ptImg = byId('char-portrait').querySelector('img');
  check(
    '形象按 2:3 裁（1024×1536）',
    !!ptImg && ptImg.naturalWidth === 1024 && ptImg.naturalHeight === 1536,
    `实际 ${ptImg && ptImg.naturalWidth}×${ptImg && ptImg.naturalHeight} / 视口 ${window.innerWidth}×${window.innerHeight} / dpr ${window.devicePixelRatio}`
  );

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(200);

  // --- 落盘：两张图是两个字段，都要留下 ---
  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  check('头像存进 avatar', isImg(saved && saved.avatar), String(saved && saved.avatar).slice(0, 24));
  check('形象存进 portrait（另一个字段）', isImg(saved && saved.portrait), String(saved && saved.portrait).slice(0, 24));
  check('两张图不是同一份', !!saved && saved.avatar !== saved.portrait);

  // --- 列表上铺的是形象，点它能看大图 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);

  const media = card && card.querySelector('.char-card-avatar');
  check('列表卡上铺的是形象图', !!media && !!media.querySelector('img'));
  check('列表卡上的形象能点（包在按钮里）', !!media && media.tagName === 'BUTTON');
  click(media);
  await sleep(300);

  // --- 老卡兼容：只有一张图（没有 portrait 键）的卡 ---
  // 用真实交互造：新建一张卡、只传头像、保存 —— 落盘后照样没有 portrait 键，
  // 这就是老卡那种「只有一张图」的形态（不走 saveCharacters 硬塞：那样绕开了
  // 渲染层，界面上根本看不到这张卡）。
  const OLD = '只有一张图的老卡';
  click('#btn-chars');
  await waitFor('切回角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', OLD);
  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('头像按 384 落进框里', () => { const i = byId('char-avatar').querySelector('img'); return !!i && i.naturalWidth === 384; });
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(200);

  const opened = (await savedCharacters()).find((c) => c.name === OLD);
  check('只传过头像的卡，落盘后没有 portrait 键', !!opened && !('portrait' in opened));

  const oldCard = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === OLD
  );
  check('只有一张图的卡，列表上显示的还是它那张图', !!oldCard && !!oldCard.querySelector('.char-card-avatar img'));
  if (!oldCard) return;

  click(buttonByText(oldCard, '编辑'));
  await waitFor('编辑器打开', () => shown('#chars-modal'));
  check('老卡的形象框先沿用头像那张图', byId('char-portrait').classList.contains('is-inherited'));

  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  // 换头像之后形象栏要接过原来那张，于是不再标「沿用头像」。
  // （不能等 img.src 变化：images:pick 的桩每次都给同一张 1×1 PNG，
  //   两次裁出来的字节是一样的，src 根本不变。）
  await waitFor('形象接过了旧头像', () => !byId('char-portrait').classList.contains('is-inherited'));
  click('#btn-save-char');
  // 改已有的角色不会自动关弹窗（留着接着改别的字段），这里等落盘再自己关
  await sleep(400);
  click('#btn-close-chars');
  await sleep(150);

  const fixed = (await savedCharacters()).find((c) => c.name === OLD);
  check(
    '老卡换头像时，原来那张图原封不动留成了形象',
    !!fixed && !!opened && fixed.portrait === opened.avatar,
    String(fixed && fixed.portrait).slice(0, 24)
  );
  check('老卡的头像还是有的', !!fixed && isImg(fixed.avatar));
});

// ---------------------------------------------------------------------------
//  场景 14：角色属性 —— 粘贴文本批量生成
// ---------------------------------------------------------------------------
await scenario('角色属性：粘贴文本批量生成', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '粘贴测试角色');

  check('粘贴区一开始是收着的', !shown('#c-attr-paste'));
  click('#btn-attr-paste');
  await waitFor('粘贴区展开', () => shown('#c-attr-paste'));

  // 故意混几种写法 + 两行认不出来的（空行 / 光一个名字 / 保留字）
  setValue(
    '#c-attr-paste-text',
    ['金币：9900', '【上衣】：衬衫', '年龄 16', '- 下装：裙子', '', '籍贯', '旁白：不该收进来'].join('\n')
  );
  click('#btn-attr-paste-apply');
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length >= 4);
  await sleep(80);

  const names = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const valueOf = (n) => {
    const row = $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === n);
    return row ? row.querySelector('.attr-value').value : null;
  };

  check('四种写法都认出来了', ['金币', '上衣', '年龄', '下装'].every((n) => names.includes(n)), JSON.stringify(names));
  check(
    '值也对',
    valueOf('金币') === '9900' && valueOf('上衣') === '衬衫' && valueOf('年龄') === '16' && valueOf('下装') === '裙子',
    JSON.stringify({ 金币: valueOf('金币'), 上衣: valueOf('上衣'), 年龄: valueOf('年龄'), 下装: valueOf('下装') })
  );
  check('认不出的行跳过（光一个名字）', !names.includes('籍贯'), JSON.stringify(names));
  check('保留字不收（旁白）', !names.includes('旁白'), JSON.stringify(names));
  check('解析完自动收起粘贴区', !shown('#c-attr-paste'));

  // 再贴一次：同名的应该覆盖值，而不是加出第二条
  click('#btn-attr-paste');
  await waitFor('粘贴区展开', () => shown('#c-attr-paste'));
  setValue('#c-attr-paste-text', '金币：1\n新字段：值');
  click('#btn-attr-paste-apply');
  await waitFor('新字段出现', () => $$('#c-attr-list .attr-name').some((n) => n.textContent === '新字段'));
  await sleep(80);

  const names2 = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('同名没有加出第二条', names2.filter((n) => n === '金币').length === 1, JSON.stringify(names2));
  check('同名的值被覆盖了', valueOf('金币') === '1', String(valueOf('金币')));
  check('新字段加进来了', names2.includes('新字段'), JSON.stringify(names2));

  // 存盘往返（顺带再验一次白名单没漏字段）
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '粘贴测试角色');
  check(
    '粘贴出来的属性也落盘了',
    !!saved && saved.attributes.length === 5 && saved.attributes.some((a) => a.name === '金币' && a.value === '1'),
    JSON.stringify(saved && saved.attributes)
  );
});

// ---------------------------------------------------------------------------
//  场景 14.5：角色属性 —— 套用官方互动模板
//
//  一键种入官方固定分组（状态栏 / 关系 / 背包）和默认字段，字段带好
//  类型 / 范围 / 变化规则。这是「互动模板」的核心体验：不用手动建组、
//  不用逐条填类型。
// ---------------------------------------------------------------------------
await scenario('角色属性：套用互动模板', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '模板测试角色');

  // 空卡还没有任何分组
  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);

  check('模板入口在属性区里', !!byId('btn-attr-template'));
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // 三个官方分组都出现在标签栏里（各带字段计数）
  check(
    '三个固定分组都出现了',
    ['状态栏', '关系', '背包'].every((g) => tabLabels().some((t) => t.startsWith(g))),
    JSON.stringify(tabLabels())
  );
  check('状态栏组里有 3 个字段（时间 / 地点 / 心情）', tabLabels().some((t) => t.startsWith('状态栏 3')), JSON.stringify(tabLabels()));
  check('关系组里有 2 个字段（好感度 / 关系阶段）', tabLabels().some((t) => t.startsWith('关系 2')), JSON.stringify(tabLabels()));
  check('背包组里有 1 个字段（物品）', tabLabels().some((t) => t.startsWith('背包 1')), JSON.stringify(tabLabels()));

  // 应用完停在「状态栏」，能看到刚种进来的字段
  const names = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('应用完停在状态栏，能看到时间/地点/心情', ['时间', '地点', '心情'].every((n) => names.includes(n)), JSON.stringify(names));

  // 切到「关系」：好感度是带范围的数值，关系阶段是文本，都有变化规则
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    click(tab);
  };
  clickTab('关系');
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-name').some((n) => n.textContent === '好感度'));

  // 好感度是带范围的数值字段，「更多」默认就是展开的（有范围就展开）——
  // 直接断言范围 0~100 和变化规则，不再点按钮（点了反而会收起）。
  const favorRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '好感度');
  await waitFor('好感度的范围框可见', () => !!favorRow().parentElement.querySelector('.attr-more .attr-num'));
  const numInputs = favorRow().parentElement.querySelectorAll('.attr-more .attr-num');
  check('好感度范围是 0~100', numInputs[0].value === '0' && numInputs[1].value === '100', JSON.stringify(Array.from(numInputs).map((i) => i.value)));
  check(
    '好感度带变化规则',
    favorRow().parentElement.querySelector('.attr-more .attr-hint').value.includes('示好'),
    favorRow().parentElement.querySelector('.attr-more .attr-hint').value
  );

  // 保存后落盘：类型/范围/hint/分组都在
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '模板测试角色');
  const byName = (n) => ((saved && saved.attributes) || []).find((a) => a.name === n) || {};
  check('模板字段都落盘了', !!saved && saved.attributes.length === 6, JSON.stringify(saved && (saved.attributes || []).map((a) => a.name)));
  check(
    '好感度类型/范围/规则/分组都对',
    byName('好感度').type === 'meter' && byName('好感度').min === 0 && byName('好感度').max === 100 &&
      String(byName('好感度').hint || '').includes('示好') && byName('好感度').group === '关系',
    JSON.stringify(byName('好感度'))
  );
  check('关系阶段带「按好感度自动」的变化规则', String(byName('关系阶段').hint || '').includes('好感度'), JSON.stringify(byName('关系阶段')));
  check('物品是列表类型、归到背包', byName('物品').type === 'list' && byName('物品').group === '背包', JSON.stringify(byName('物品')));

  // 再套一次：已存在的字段不重复加
  click('#btn-attr-template');
  await sleep(80);
  check('再套一次不会重复加字段', $$('#c-attr-list .attr-row').length === 3, `实际 ${$$('#c-attr-list .attr-row').length}`);
});

// ---------------------------------------------------------------------------
//  场景 15：角色属性 —— 分组标签栏
//
//  属性在数据上仍是一维数组（分组记在每个字段自己的 group 上），
//  分组只是视图键：点哪个标签就只铺哪一组，在某一组里加字段自动带这个分组。
//  这个场景专门盯「视图分层」，落盘的形状由上面的场景 13 / 14 把关。
// ---------------------------------------------------------------------------
await scenario('角色属性：分组标签栏', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '分组测试角色');

  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    click(tab);
  };

  // 空卡：总得有个地方落笔，所以默认就该有「未分组」这一桶
  check(
    '空卡默认只有一个「未分组」标签',
    JSON.stringify(tabLabels()) === JSON.stringify(['未分组 0']),
    JSON.stringify(tabLabels())
  );

  setValue('#c-attr-new', '金币');
  click('#btn-add-attr');
  await waitFor('金币出现', () => listedNames().includes('金币'));
  check('标签上的计数跟着涨', tabLabels()[0] === '未分组 1', JSON.stringify(tabLabels()));

  // 新建一个分组：回车确认，应该立刻切过去
  const newTabInput = $('#c-attr-tabs .attr-tab-new');
  check('标签栏末尾有「新建分组」入口', !!newTabInput);
  setValue(newTabInput, '背包');
  newTabInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor('切到新分组', () => tabLabels().some((t) => t.startsWith('背包')));
  check(
    '新建的空分组也在标签栏里，且排在未分组前面',
    JSON.stringify(tabLabels()) === JSON.stringify(['背包 0', '未分组 1']),
    JSON.stringify(tabLabels())
  );
  check('切到空分组后列表是空的', listedNames().length === 0, JSON.stringify(listedNames()));
  // 空组光秃秃的会让人以为界面坏了 —— 得有一句话告诉他下一步干嘛
  check(
    '空分组里有引导文案',
    !!$('#c-attr-list .attr-empty') && $('#c-attr-list .attr-empty').textContent.includes('背包'),
    ($('#c-attr-list .attr-empty') || {}).textContent
  );
  // 组名和字段数拆成了两个节点（数字做成徽标），但整串得还是「名字 空格 数字」——
  // 测试是按整串比对的，拆节点时最容易把那个空格弄丢
  check(
    '标签里的组名和计数是两个节点，中间的空格还在',
    !!$('#c-attr-tabs .attr-tab-name') && !!$('#c-attr-tabs .attr-tab-count') &&
      $('#c-attr-tabs .attr-tab').textContent === '背包 0',
    JSON.stringify(($('#c-attr-tabs .attr-tab') || {}).textContent)
  );

  // 在「背包」这一页加字段：应该自动归到背包，不用再去「更多」里填分组
  setValue('#c-attr-new', '道具');
  click('#btn-add-attr');
  await waitFor('道具出现', () => listedNames().includes('道具'));
  check('在当前分组里加字段，自动带上这个分组', tabLabels()[0] === '背包 1', JSON.stringify(tabLabels()));

  setValue('#c-attr-new', '上衣');
  click('#btn-add-attr');
  await waitFor('上衣出现', () => listedNames().includes('上衣'));
  check('继续加还是这一组', tabLabels()[0] === '背包 2', JSON.stringify(tabLabels()));

  // 切回未分组：只该看到金币
  clickTab('未分组');
  await waitFor('切回未分组', () => listedNames().length === 1);
  check('切组之后只显示那一组的字段', listedNames().join(',') === '金币', JSON.stringify(listedNames()));

  // 再切回背包：还是那两行，顺序也没变
  clickTab('背包');
  await waitFor('切回背包', () => listedNames().length === 2);
  check('切回去还是那两行、顺序不变', listedNames().join(',') === '道具,上衣', JSON.stringify(listedNames()));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '分组测试角色');
  const byName = (n) => ((saved && saved.attributes) || []).find((a) => a.name === n) || {};
  check('三个字段都存下来了', !!saved && saved.attributes.length === 3, JSON.stringify(saved && saved.attributes));
  check(
    '分组落在字段自己身上',
    byName('道具').group === '背包' && byName('上衣').group === '背包',
    JSON.stringify(saved && saved.attributes)
  );
  // 未分组的字段不写 group —— 数据形状要和以前完全一样，老卡的往返才不会变样
  check('未分组的字段不写 group', !!saved && saved.attributes.length === 3 && byName('金币').group === undefined, JSON.stringify(byName('金币')));
  check(
    '编辑器的视图状态没被写进角色卡（_activeGroup / _extraGroups）',
    !!saved &&
      saved.attributes.every((a) => !('_activeGroup' in a) && !('_extraGroups' in a)),
    JSON.stringify(saved && Object.keys(saved.attributes[0] || {}))
  );
});

// ---------------------------------------------------------------------------
//  场景：角色属性 —— 分组的改名 / 解散 / 顺序稳定
//
//  分组以前只能靠「在某个字段的『更多』里填 group」间接建出来，建完就没有
//  入口了 —— 改不了名，也解散不掉。另外标签栏按**字段在数组里的先后**排，
//  于是空分组会被已经有字段的组顶到后面去，看着像在按字段数量排队。
//  这个场景盯这两件事。
// ---------------------------------------------------------------------------
await scenario('角色属性：分组改名与解散', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '分组改名角色');

  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    return click(tab);
  };
  const newGroup = (name) => {
    const box = $('#c-attr-tabs .attr-tab-new');
    setValue(box, name);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return waitFor(`分组「${name}」出现`, () => tabLabels().some((t) => t.startsWith(name)));
  };
  const addAttr = (name) => {
    setValue('#c-attr-new', name);
    click('#btn-add-attr');
    return waitFor(`属性「${name}」出现`, () => listedNames().includes(name));
  };
  const openGroupEdit = () => {
    click($('#c-attr-tabs .attr-tab-edit'));
    return waitFor('分组操作条出现', () => shown('#c-attr-group-edit'));
  };
  // 改名走 change（回车 / 失焦），而 setValue 只补一个 input —— 手动补齐
  const renameTo = (name) => {
    const box = $('#c-attr-group-edit input.attr-group-name');
    setValue(box, name);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // --- 顺序：先建的空分组不该被「后建的、已经填了字段的组」顶下去 ---
  await newGroup('状态');
  await newGroup('关系');
  await addAttr('好感度');
  check(
    '先建的分组留在原位，没被后面填了字段的组顶到后面',
    JSON.stringify(tabLabels()) === JSON.stringify(['状态 0', '关系 1']),
    JSON.stringify(tabLabels())
  );

  clickTab('状态');
  await addAttr('体温');
  check(
    '回头给先建的那一组填字段，顺序仍然是创建顺序',
    JSON.stringify(tabLabels()) === JSON.stringify(['状态 1', '关系 1']),
    JSON.stringify(tabLabels())
  );

  // --- 改名：空分组改名不能把它改没了 ---
  clickTab('状态');
  await openGroupEdit();
  check(
    '操作条里带出了当前分组名',
    $('#c-attr-group-edit input.attr-group-name').value === '状态',
    $('#c-attr-group-edit input.attr-group-name').value
  );
  renameTo('心情');
  await waitFor('改名生效', () => tabLabels().some((t) => t.startsWith('心情')));
  check(
    '改名后标签留在原来的位置（没跳到末尾）',
    JSON.stringify(tabLabels()) === JSON.stringify(['心情 1', '关系 1']),
    JSON.stringify(tabLabels())
  );
  check('改名后仍停在那一组，字段也还在', listedNames().join(',') === '体温', JSON.stringify(listedNames()));

  // --- 改名时按 Esc：只该取消改名，**不能**把整个角色编辑器一起关掉 ---
  // 以前这两个输入框的 Esc 分支只 preventDefault、没 stopPropagation，
  // 事件冒泡到入口层的全局 Esc 链（document 上）就把 charsModal 关了。
  await openGroupEdit();
  {
    const escBox = $('#c-attr-group-edit input.attr-group-name');
    escBox.value = '不该生效的名字';
    escBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(120);
    check('改名时按 Esc 不会关掉角色编辑器', shown('#chars-modal'));
    check('改名时按 Esc 也不会连弹「放弃新建」确认框', !shown('#confirm-modal'));
    check('按 Esc 是「放弃改名」，名字没被改掉', tabLabels().some((t) => t.startsWith('心情')), JSON.stringify(tabLabels()));
  }

  // --- 改成已有的名字 = 并组 ---
  clickTab('关系');
  await openGroupEdit();
  renameTo('心情');
  await waitFor('并组完成', () => listedNames().length === 2);
  check(
    '改成已有的名字就是并组，被并掉的那个位置不占坑',
    JSON.stringify(tabLabels()) === JSON.stringify(['心情 2']),
    JSON.stringify(tabLabels())
  );
  check('两组的字段合到一起，一个都没丢', listedNames().join(',') === '好感度,体温', JSON.stringify(listedNames()));

  // --- 解散：字段退回「未分组」，动之前先问一句 ---
  // 并组/改名完成后操作条会自动收起来（免得留在那儿被误点第二次），
  // 所以要重新点开「⋯」再拿里面的按钮。
  await openGroupEdit();
  click($('#c-attr-group-edit .btn-danger'));
  await waitFor('确认弹窗出现', () => shown('#confirm-modal'));
  check(
    '确认弹窗把「属性会退回未分组」说清楚了',
    byId('confirm-message').textContent.includes('未分组') && byId('confirm-message').textContent.includes('2'),
    byId('confirm-message').textContent
  );
  click('#confirm-ok');
  await waitFor('解散完成', () => tabLabels().length === 1 && tabLabels()[0] === '未分组 2');
  check('解散之后属性退回「未分组」，一个都没少', listedNames().join(',') === '好感度,体温', JSON.stringify(listedNames()));

  // --- 空分组直接删，不该弹确认 ---
  await newGroup('临时');
  await openGroupEdit();
  click($('#c-attr-group-edit .btn-danger'));
  await waitFor('空分组被删掉', () => tabLabels().join() === '未分组 2');
  check('删空分组不弹确认（没什么可丢的）', !shown('#confirm-modal'));

  // --- 视图状态别跟着落盘 ---
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '分组改名角色');
  check('结果落盘：两个属性都在「未分组」', !!saved && saved.attributes.length === 2, JSON.stringify(saved && saved.attributes));
  check(
    '解散过的分组没有留在数据里（字段上不写 group）',
    !!saved && saved.attributes.every((a) => a.group === undefined),
    JSON.stringify(saved && saved.attributes)
  );
  check(
    '创建顺序表也没被写进角色卡',
    !!saved && saved.attributes.every((a) => !('_groupOrder' in a) && !('_groupEditOpen' in a)),
    JSON.stringify(saved && Object.keys(saved.attributes[0] || {}))
  );
});

// ---------------------------------------------------------------------------
//  场景 19：会话分支 + 存档点
//
//  「分支」= 另开一个会话把前 N 条复制过去（当前这条线一个字节都不动）；
//  「存档点」= 当前会话内的快照，读档会整个退回去。
// ---------------------------------------------------------------------------
await scenario('会话：分支与存档点', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  const before = await window.mimitale.getConversations();
  const origin = before.conversations.find((c) => c.id === before.activeId);
  check('有一个够长的会话可以分支', !!origin && (origin.messages || []).length >= 2, `消息 ${origin && (origin.messages || []).length} 条`);

  // --- 分支 ---
  const nodes = $$('#messages .msg');
  check('消息列表够长', nodes.length >= 2, String(nodes.length));
  check('消息上有「分支」入口', !!buttonByText(nodes[1], '分支'), '没找到');

  click(buttonByText(nodes[1], '分支'));
  await sleep(500);

  const after = await window.mimitale.getConversations();
  check('多出了一个会话', after.conversations.length === before.conversations.length + 1, `${before.conversations.length} → ${after.conversations.length}`);

  const branch = after.conversations.find((c) => c.id === after.activeId);
  check('新会话成了当前会话', !!branch && branch.id !== origin.id, branch && String(branch.id));
  check('标题标了「分支」', !!branch && String(branch.title).includes('（分支）'), branch && branch.title);
  check('前两条原样复制过去了', !!branch && branch.messages.length === 2, branch && String(branch.messages.length));
  check('消息内容也对得上', !!branch && branch.messages[1].content === origin.messages[1].content, '');
  check('绑定的世界书跟着走', !!branch && (branch.worldbookIds || []).length === (origin.worldbookIds || []).length, '');

  // 关键：原来那条线一个字都没动
  const originAfter = after.conversations.find((c) => c.id === origin.id);
  check(
    '原来那条线完好无损',
    !!originAfter && originAfter.messages.length === origin.messages.length,
    `${origin.messages.length} 条 → ${originAfter && originAfter.messages.length} 条`
  );

  // --- 存档点 ---
  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  await sleep(200);

  check('记忆弹窗里有「存档点」一节', !!byId('checkpoint-list'), '没找到');
  check('一开始没有存档点', byId('checkpoint-list').textContent.includes('还没有存档点'), byId('checkpoint-list').textContent.trim().slice(0, 24));

  click('#btn-save-checkpoint');
  await sleep(350);
  check('存下了一个档', $$('#checkpoint-list .checkpoint-row').length === 1, String($$('#checkpoint-list .checkpoint-row').length));
  const rowName = $('#checkpoint-list .checkpoint-name').textContent;
  check('档名写明了存的时候有几条消息', rowName.includes('2 条消息'), rowName);

  click('#btn-close-memory');
  await sleep(250);

  // --- 存完档再聊一条，然后读档退回去 ---
  setValue('#input', '这条是存完档之后聊的，读档应该把它退掉');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 10000);
  // 落盘是防抖的（350ms），等久一点再读磁盘，否则读到的是上一步的快照
  await sleep(700);

  const grownNodes = $$('#messages .msg').length;
  check('界面上长长了（存档之后又聊了）', grownNodes > 2, `${grownNodes} 条`);

  const grown = (await window.mimitale.getConversations()).conversations.find((c) => c.id === branch.id);
  check('新消息也落盘了', grown.messages.length === grownNodes, `界面 ${grownNodes} 条 / 磁盘 ${grown.messages.length} 条`);

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  await sleep(200);

  click(buttonByText($('#checkpoint-list .checkpoint-row'), '读档'));
  await waitFor('读档前先确认', () => shown('#confirm-modal'));
  check('确认文案说明了会丢内容', $('#confirm-message').textContent.includes('回到'), $('#confirm-message').textContent.trim().slice(0, 30));
  click('#confirm-ok');
  await sleep(600);

  const restored = (await window.mimitale.getConversations()).conversations.find((c) => c.id === branch.id);
  check('读档后退回到存档时的条数', restored.messages.length === 2, `${grown.messages.length} → ${restored.messages.length}`);
  check('存档点本身还留着（能再读一次）', $$('#checkpoint-list .checkpoint-row').length === 1, String($$('#checkpoint-list .checkpoint-row').length));

  // --- 删掉存档点 ---
  click(buttonByText($('#checkpoint-list .checkpoint-row'), '删除'));
  await waitFor('删除前先确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await sleep(450);
  check('删掉后回到空状态', byId('checkpoint-list').textContent.includes('还没有存档点'), byId('checkpoint-list').textContent.trim().slice(0, 24));

  click('#btn-close-memory');
  await sleep(200);
});

// ---------------------------------------------------------------------------
//  场景 20：语义检索（RAG）
//
//  关键词匹配的死角：世界书里写着「十二泰坦」，但对话里问的是「那些神」——
//  按关键词永远命中不了。这里就验这件事：问「那些神」，那条设定能不能被捞回来。
//  具体注入了什么由宿主侧断言（见 smoke-test.js 的 probeRag）。
// ---------------------------------------------------------------------------
await scenario('语义检索', async () => {
  // 先在设置里打开并配好
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  await sleep(200);

  check('设置里有语义检索这一节', !!byId('s-rag-enabled') && !!byId('s-embedding-provider'));
  check('默认是关的（开着要额外花钱）', byId('s-rag-enabled').checked === false);

  const embOptions = Array.from(byId('s-embedding-provider').options).map((o) => o.value);
  check('向量服务商下拉把三个服务商都列上了', embOptions.length === 4 && embOptions.includes('p-emb'), JSON.stringify(embOptions));

  setValue('#s-embedding-provider', 'p-emb');
  await sleep(200);
  const embModelOptions = Array.from(byId('s-embedding-model').options).map((o) => o.value);
  check(
    '向量模型也是下拉，跟着服务商走',
    byId('s-embedding-model').tagName === 'SELECT' && embModelOptions.length === 1 && embModelOptions[0] === 'emb-model-x',
    `${byId('s-embedding-model').tagName} ${JSON.stringify(embModelOptions)}`
  );
  setValue('#s-embedding-model', 'emb-model-x');
  click('#s-rag-enabled');
  await sleep(120);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#settings-modal'));
  await sleep(400);

  const saved = (await window.mimitale.getSettings()).settings;
  check('语义检索配置落盘了', saved.ragEnabled === true && saved.embeddingProviderId === 'p-emb' && saved.embeddingModel === 'emb-model-x', JSON.stringify({ on: saved.ragEnabled, p: saved.embeddingProviderId, m: saved.embeddingModel }));
  check('聊天模型没被动过', saved.activeProviderId === 'p-test' && saved.activeModel === 'test-model', `${saved.activeProviderId}/${saved.activeModel}`);

  // 发一条「关键词命不中、但意思相关」的话
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(200);
  setValue('#input', '那些神到底是谁？');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 12000);
  await sleep(400);

  // 负向对照：关掉之后不该再注入
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  await sleep(200);
  click('#s-rag-enabled');
  await sleep(120);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#settings-modal'));
  await sleep(300);

  const off = (await window.mimitale.getSettings()).settings;
  check('关掉之后落盘也是关的', off.ragEnabled === false, String(off.ragEnabled));

  setValue('#input', '关了语义检索之后再问一句，这句不该带往事');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 12000);
  await sleep(400);
});

// ---------------------------------------------------------------------------
//  准备悬停验证（必须放最后：它会把卡片摆好交给宿主）
// ---------------------------------------------------------------------------
let hoverProbe = null;
await scenario('准备悬停验证', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));

  // 这里可能已经有别的角色卡了（属性场景留下的），所以按「多了一张」判断
  const beforeCards = $$('#char-page-grid .char-card').length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', '悬停验证角色');
  click('#btn-save-char');
  await waitFor('卡片出现', () => $$('#char-page-grid .char-card').length === beforeCards + 1);
  click('#btn-close-chars');
  await sleep(120);

  const card = $$('#char-page-grid .char-card')[0];
  const r = card.getBoundingClientRect();
  hoverProbe = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  check('卡片已就位，坐标可交给宿主', !!hoverProbe && hoverProbe.x > 0 && hoverProbe.y > 0, JSON.stringify(hoverProbe));
});

// ---------------------------------------------------------------------------
//  帮我想想：给几个下一步让你挑
// ---------------------------------------------------------------------------
await scenario('帮我想想（给几个下一步）', async () => {
  // 回聊天视图，并确保末尾有一条 AI 回复（工具条上才有「帮我想想」）
  const convoItem = $('#convo-list .convo-item');
  if (convoItem) {
    click(convoItem);
    await waitFor('切回聊天视图', () => shown('#view-chat'));
    await sleep(250);
  }

  const lastAssistant = () => $$('#messages .msg.assistant').pop();
  const actionsOf = (node) =>
    node ? Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim()) : [];

  check('AI 回复上有「帮我想想」', actionsOf(lastAssistant()).includes('帮我想想'), JSON.stringify(actionsOf(lastAssistant())));
  check('用户消息上没有「帮我想想」', !actionsOf($$('#messages .msg.user').pop()).includes('帮我想想'));

  // 建议条默认收起、且是空的
  check('建议条默认不显示', !shown('#suggest-strip'));
  check('建议列表一开始是空的', byId('suggest-list').children.length === 0);

  // 点「帮我想想」→ 假后端会回 5 条带序号和引号的选项
  const trigger = Array.from(lastAssistant().querySelectorAll('.msg-actions .mini-btn'))
    .find((b) => b.textContent.trim() === '帮我想想');
  click(trigger);
  await waitFor('建议出现', () => shown('#suggest-strip') && byId('suggest-list').children.length > 0, 8000);
  await sleep(200);

  const items = $$('#suggest-list .suggest-btn');
  const texts = items.map((b) => b.textContent.trim());

  check('渲染出 4 个建议按钮（第 5 条被丢掉）', items.length === 4, `${items.length}: ${JSON.stringify(texts)}`);
  check('按钮都是 button 元素', items.every((b) => b.tagName === 'BUTTON'), true);
  check('序号被剥掉', !texts.some((t) => /^\d+\s*[.、)）]/.test(t)), JSON.stringify(texts));
  check('引号被剥掉', !texts.some((t) => /^[「『"']/.test(t) || /[」』"']$/.test(t)), JSON.stringify(texts));
  check('第一条内容正确', texts[0] === '我想先喝一杯，压压惊', JSON.stringify(texts[0]));
  check('四条彼此不同', new Set(texts).size === texts.length, JSON.stringify(texts));

  // 点第一条 → 当成玩家的话发出去，建议条收起
  const beforeUser = $$('#messages .msg.user').length;
  click(items[0]);
  await sleep(250);

  check('点选项后建议条自动收起', !shown('#suggest-strip'));
  await waitFor('选项被当成玩家消息发出', () => $$('#messages .msg.user').length === beforeUser + 1, 8000);
  check('发出去的就是选项内容',
    String($$('#messages .msg.user').pop().textContent || '').includes('我想先喝一杯，压压惊'));

  // 等这轮回复收尾，别把后面的场景搅乱
  await waitFor('这一轮回复结束', () => {
    const nodes = $$('#messages .msg.assistant');
    return nodes.length > 0 && !nodes[nodes.length - 1].querySelector('.waiting');
  }, 8000);
  await sleep(250);

  // ✕ 能收起
  const trigger2 = Array.from(lastAssistant().querySelectorAll('.msg-actions .mini-btn'))
    .find((b) => b.textContent.trim() === '帮我想想');
  if (trigger2) {
    click(trigger2);
    await waitFor('建议再次出现', () => shown('#suggest-strip'), 8000);
    click('#btn-suggest-close');
    await sleep(150);
    check('点 ✕ 能收起建议条', !shown('#suggest-strip'));
    check('收起后列表也清空', byId('suggest-list').children.length === 0);
  }
});

// ---------------------------------------------------------------------------
//  角色自带的世界书：绑定 / 解绑 / 开关 / 存盘
// ---------------------------------------------------------------------------
await scenario('角色：绑定自带的世界书', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '自带世界书测试';
  setValue('#c-name', NAME);
  await sleep(100);

  // 没绑定时：这一块也要显示（以前是「有绑定才显示」，导致找不到入口加书）
  check('没绑定时这块也显示出来', shown('#c-worldbook-box'));
  check('没绑定时有「＋ 绑定」按钮', shown('#c-wb-add-btn'));
  check('没绑定时清单是空状态提示', $$('#c-wb-list .cwb-row').length === 0);
  check('没绑定时开关藏起来（开着也没意义）', !shown('#c-wb-switch'));
  check('空状态给了引导文字', String(byId('c-wb-list').textContent || '').includes('点「＋ 绑定」'));

  // 点「＋ 绑定」→ 浮层列出可选的库
  click('#c-wb-add-btn');
  await waitFor('选择浮层出现', () => !!$('.cwb-picker'));
  const options = $$('.cwb-picker .cwb-picker-row');
  check('浮层列出了可选世界书', options.length > 0, `${options.length} 个`);
  check('浮层里有冒烟测试世界',
    options.some((o) => String(o.textContent || '').includes('冒烟测试世界')),
    JSON.stringify(options.map((o) => o.textContent.trim())));

  // 选一本 → 绑定
  const target = options.find((o) => String(o.textContent || '').includes('冒烟测试世界'));
  click(target);
  await waitFor('浮层关闭', () => !$('.cwb-picker'));
  await waitFor('清单里出现这本', () => $$('#c-wb-list .cwb-row').length === 1);
  await sleep(150);

  check('绑定后清单里有一行', $$('#c-wb-list .cwb-row').length === 1);
  check('行里是那本书的名字',
    String($$('#c-wb-list .cwb-row')[0].textContent || '').includes('冒烟测试世界'));
  check('绑定后开关出现了', shown('#c-wb-switch'));
  check('绑定后开关默认是开的', byId('c-wb-enabled').checked === true);
  check('说明文字提到「单独聊天会带上」',
    String(byId('c-wb-hint').textContent || '').includes('单独跟它聊天时会带上'),
    String(byId('c-wb-hint').textContent || '').slice(0, 60));

  // 关掉开关 → 说明跟着变
  setChecked('#c-wb-enabled', false);
  await sleep(150);
  check('关掉开关后说明改成「已停用」',
    String(byId('c-wb-hint').textContent || '').includes('已停用'),
    String(byId('c-wb-hint').textContent || '').slice(0, 60));

  // 存盘 → 两个字段都要落盘（归一化白名单最容易漏）
  setChecked('#c-wb-enabled', true);
  await sleep(100);
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'), 8000);
  await sleep(200);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  check('worldbookIds 落盘了（没被归一化丢掉）',
    !!saved && Array.isArray(saved.worldbookIds) && saved.worldbookIds.length === 1,
    JSON.stringify(saved && saved.worldbookIds));
  check('worldbookEnabled 落盘了', !!saved && saved.worldbookEnabled === true,
    JSON.stringify(saved && saved.worldbookEnabled));

  // 解绑 → 清单回到空状态
  if (saved && Array.isArray(saved.worldbookIds) && saved.worldbookIds.length) {
    click($$('#c-wb-list .cwb-row')[0].querySelector('.cwb-row-del'));
    await waitFor('解绑后清单空掉', () => $$('#c-wb-list .cwb-row').length === 0, 8000);
    await sleep(150);
    check('解绑后开关又藏起来', !shown('#c-wb-switch'));
    check('解绑后回到空状态提示',
      String(byId('c-wb-list').textContent || '').includes('点「＋ 绑定」'));
  }
});

// ---------------------------------------------------------------------------
//  角色自带的世界书：绑上之后顶部要能看出来生效
//
//  放在最后：这个场景会通过「聊天」入口新建一条会话，
//  建完当前会话就变了 —— 排在中间会把后面场景的起点搅乱
//  （第一次放在「重新生成候选」前面，直接把那个场景弄挂了）。
// ---------------------------------------------------------------------------
await scenario('角色自带的世界书：顶部能看出生效', async () => {
  // 造一张绑了世界书的角色，存档
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  const NAME = '顶栏生效测试';
  setValue('#c-name', NAME);
  await sleep(80);

  click('#c-wb-add-btn');
  await waitFor('选择浮层出现', () => !!$('.cwb-picker'));
  const target = $$('.cwb-picker .cwb-picker-row').find((o) =>
    String(o.textContent || '').includes('冒烟测试世界')
  );
  click(target);
  await waitFor('清单里出现这本', () => $$('#c-wb-list .cwb-row').length === 1);
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'), 8000);
  await sleep(200);

  // 关掉编辑器，回聊天视图（关编辑器不会自动切页，得点会话）
  click('#btn-close-chars');
  await sleep(200);
  click('#convo-list .convo-item');
  await waitFor('回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  // 头部不该无中生有：还没绑角色的会话不显示「角色自带」
  const beforeBind = String(byId('convo-meta').textContent || '');
  check('绑之前头部没有「角色自带」', !beforeBind.includes('（角色自带）'), beforeBind);

  const chars = (await savedCharacters()).filter((c) => c.name === NAME);
  const targetChar = chars[0];
  check('角色建好并且绑了世界书',
    !!targetChar && Array.isArray(targetChar.worldbookIds) && targetChar.worldbookIds.length === 1,
    JSON.stringify(targetChar && targetChar.worldbookIds));

  if (targetChar) {
    // 用角色卡上的「聊天」入口绑定角色
    // （顶部那个角色下拉在重构里已经去掉了，别再用它）
    click('#btn-chars');
    await waitFor('切到角色库页面', () => shown('#view-chars'));
    await sleep(300);
    const card = $$('.char-card').find((c) => String(c.textContent || '').includes(NAME));
    if (!card) {
      check('角色卡出现在列表里', false, JSON.stringify($$('.char-card').map((c) => c.textContent.trim().slice(0, 20))));
    } else {
      const chatBtn = buttonByText(card, '聊天');
      if (!chatBtn) {
        check('角色卡上有「聊天」按钮', false, JSON.stringify(Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim())));
      } else {
        await startChatWith(card);
        await waitFor('回到聊天视图', () => shown('#view-chat'), 8000);
        await sleep(500);

        const meta = String(byId('convo-meta').textContent || '');
        check('绑上角色后头部显示它自带的世界书', meta.includes('冒烟测试世界'), meta);
        check('并且标明了是「角色自带」', meta.includes('（角色自带）'), meta);
      }
    }
  }
});

// ---------------------------------------------------------------------------
//  场景 20：导入后重发 id 时，角色 → 世界书的绑定必须跟着改写
//
//  这一条是**真 bug 的回归测试**：导入时主进程把内嵌世界书自动绑到角色上，
//  渲染层随后给两边都重发 id —— 只换书的 id 不改写角色里的指向，
//  绑定就指到一本不存在的书，表现是「书在库里但就是不生效」，全程不报错。
//
//  逻辑在 renderer/js/data/library-reissue.js，是个 ES module，
//  所以这里用动态 import 拿真代码来测（不是照抄一份）。
// ---------------------------------------------------------------------------
await scenario('导入：重发 id 时绑定要跟着走', async () => {
  let mod = null;
  try {
    // 按页面 URL 解析相对路径（executeJavaScript 里没有 import.meta）
    const url = new URL('js/data/library-reissue.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('导入重发 id 的模块能加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.reissueImportedIds === 'function') {
    check('导入重发 id 的模块能加载', true);

    // 主进程刚给的那批：角色自带世界书，绑的是主进程生成的旧 id
    const out = mod.reissueImportedIds(
      [
        { id: 'w-old-1', name: '卡里自带的世界书', entries: [], characters: [{ id: 'wc-old', name: '副本' }] },
        { id: 'w-old-2', name: '另一本', entries: [] }
      ],
      [
        { id: 'c-old-1', name: '导入的角色', worldbookIds: ['w-old-1'] },
        { id: 'c-old-2', name: '没绑书的角色', worldbookIds: [] }
      ],
      'stamp1'
    );

    const book1 = out.books[0];
    const char1 = out.chars[0];

    check('书拿到了新 id', !!book1 && book1.id === 'wstamp1-0', book1 && book1.id);
    check('角色拿到了新 id', !!char1 && char1.id === 'cstamp1-0', char1 && char1.id);
    check(
      '角色指向的世界书**跟着改写**了（这是那个 bug 的关键）',
      !!char1 && Array.isArray(char1.worldbookIds) && char1.worldbookIds[0] === book1.id,
      char1 ? `worldbookIds=${JSON.stringify(char1.worldbookIds)} 书的 id=${book1 && book1.id}` : '没有角色'
    );
    check(
      '改写后的指向在库里真的能对上（不是悬空引用）',
      !!char1 && out.books.some((b) => b.id === char1.worldbookIds[0]),
      JSON.stringify(out.books.map((b) => b.id))
    );
    check('书里的角色副本也换了 id', !!book1 && book1.characters[0].id === 'wcstamp1-0-0', book1 && book1.characters[0].id);
    check('没绑书的角色不受影响', !!out.chars[1] && out.chars[1].worldbookIds.length === 0, JSON.stringify(out.chars[1] && out.chars[1].worldbookIds));
    check('原来的 id 没有被顺手改掉（只读输入）', !!out.books[0] && !!char1, '');

    // 两次导入不能撞 id
    const again = mod.reissueImportedIds([{ id: 'w-old-1', name: 'x', entries: [] }], [{ id: 'c-old-1', name: 'y', worldbookIds: ['w-old-1'] }], 'stamp2');
    check('两次导入的 id 不撞车', again.books[0].id !== book1.id && again.chars[0].id !== char1.id, `${again.books[0].id} vs ${book1.id}`);
    check(
      '第二次导入的绑定同样跟着改写',
      again.chars[0].worldbookIds[0] === again.books[0].id,
      JSON.stringify(again.chars[0].worldbookIds)
    );

    // 指向一本这次没导入的书时，别把 id 弄丢（宁可留着悬空，也不要静默清掉）
    const orphan = mod.reissueImportedIds([], [{ id: 'c-old-9', name: 'z', worldbookIds: ['w-not-imported'] }], 'stamp3');
    check(
      '指向本次没导入的书时，原样留着不吞掉',
      orphan.chars[0].worldbookIds[0] === 'w-not-imported',
      JSON.stringify(orphan.chars[0].worldbookIds)
    );

    // 没传 worldbookIds / 没传 characters 的脏数据不该崩
    let dirtyOk = true;
    let dirtyDetail = '';
    try {
      const dirty = mod.reissueImportedIds([null, { id: 'w-old-3', name: 'n' }], [{ id: 'c-old-3', name: 'm' }], 'stamp4');
      dirtyOk = dirty.books.length === 2 && dirty.chars.length === 1 && !('worldbookIds' in dirty.chars[0]);
      dirtyDetail = JSON.stringify(dirty);
    } catch (err) {
      dirtyOk = false;
      dirtyDetail = '崩了：' + ((err && err.message) || err);
    }
    check('脏数据（缺 id / 缺 worldbookIds）不崩', dirtyOk, dirtyDetail);

    let emptyOk = true;
    try {
      const empty = mod.reissueImportedIds(undefined, null, 'stamp5');
      emptyOk = empty.books.length === 0 && empty.chars.length === 0;
    } catch (err) {
      emptyOk = false;
    }
    check('空输入返回空结果', emptyOk);
  }
});

// ---------------------------------------------------------------------------
//  场景 21：剧情选项（每轮给几个可点选项，点一下就当玩家回复发出去）
//
//  这是「互动模板」里最特别的一块：选项不是一次性的建议，而是跟着最新一条
//  AI 回复走（挂在气泡下面），每轮由模型跟着状态栏一起更新，
//  玩家点一下就当作自己说了那句话；不满意还能「换一批」。
// ---------------------------------------------------------------------------
await scenario('剧情选项', async () => {
  // --- 1) 在角色编辑器里开剧情选项 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '选项测试角色';
  setValue('#c-name', NAME);
  await sleep(80);

  // 剧情选项现在**默认就是开的**（4 条）—— 所有角色（角色卡 / 世界书副本 /
  // 进世界时自己写的主角）一律如此，只有明确取消勾选才没有。
  check('默认就开着剧情选项', byId('c-options-on').checked === true, String(byId('c-options-on').checked));
  check('默认每轮给 4 条', byId('c-options-count').value === '4', byId('c-options-count').value);
  check('开着时配置区是展开的', shown('#c-options-config'));

  setValue('#c-options-count', '3');
  setValue('#c-options-hint', '语气轻松些，总有一条冒险的选择');

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'), 8000);
  await sleep(150);

  const saved = await savedCharacters();
  const mine = saved.find((c) => c.name === NAME);
  check(
    '选项配置落盘了（没被白名单丢掉）',
    !!mine && !!mine.optionsSpec && mine.optionsSpec.count === 3 && mine.optionsSpec.hint === '语气轻松些，总有一条冒险的选择',
    JSON.stringify(mine && mine.optionsSpec)
  );

  // --- 2) 用这个角色开一个会话 → 配置该跟过来 ---
  click('#btn-close-chars');
  await sleep(150);
  const card = $$('#char-page-grid .char-card').find((c) => String(c.textContent || '').includes(NAME));
  check('新角色出现在列表里', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'), 8000);
  await sleep(300);

  // --- 3) 发一条 → 回复里带选项 → 面板出现可点按钮 ---
  setValue('#input', '选项测试：随便说点什么');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 12000);
  await sleep(300);

  // 剧情选项挂在最新一条 AI 回复的气泡下面（不在状态卡里）
  const optionBtns = $$('#messages .msg-option-btn');
  check('气泡下面出现了剧情选项按钮', optionBtns.length > 0, `实际 ${optionBtns.length} 个`);
  check(
    '选项块确实长在 AI 回复的气泡下面',
    $$('#messages .msg.assistant .msg-options').length > 0,
    `实际 ${$$('#messages .msg.assistant .msg-options').length} 块`
  );
  // 选项块底下有个「换一批」按钮，这批不满意可以重新让模型给一批
  check(
    '剧情选项有「换一批」按钮',
    $$('#messages .msg-options-reroll').some((n) => n.textContent.includes('换一批')),
    JSON.stringify($$('#messages .msg-options-reroll').map((n) => n.textContent))
  );

  // --- 点「换一批」→ 重新发请求、解析、写回、重绘 ---
  {
    const rerollBtn = $$('#messages .msg-options-reroll')[0];
    click(rerollBtn);
    // 点下去立刻：选项换成骨架屏、按钮禁用并显示「换一批中…」
    check(
      '点「换一批」后选项换成骨架屏',
      $$('#messages .msg-option-skeleton').length > 0,
      `骨架条 ${$$('#messages .msg-option-skeleton').length} 条`
    );
    check(
      '点「换一批」后按钮显示「换一批中…」',
      $$('#messages .msg-options-reroll').some((n) => n.textContent.includes('换一批中')),
      JSON.stringify($$('#messages .msg-options-reroll').map((n) => n.textContent))
    );
    // 点下去按钮立刻禁用；完成后整块重绘（按钮换成新的、可点）或原地恢复
    await waitFor(
      '换一批完成（按钮恢复可点且选项还在）',
      () => {
        const btn = $$('#messages .msg-options-reroll')[0];
        return !!btn && !btn.disabled && $$('#messages .msg-option-btn').length > 0;
      },
      12000
    );
    // 换一批完成后整块重绘过，要重新抓节点
    const afterReroll = $$('#messages .msg-option-btn').map((b) => b.querySelector('.opt-text').textContent);
    check(
      '换一批后选项按钮还在（写回并重绘成功）',
      afterReroll.length > 0,
      JSON.stringify(afterReroll)
    );
    // 换一批的返回也会被解析成干净的选项（没有「【」残留、没有序号）
    check(
      '换一批后的选项是干净的',
      afterReroll.every((t) => t && !t.includes('【') && !/^\d/.test(t)),
      JSON.stringify(afterReroll)
    );
  }

  const texts = optionBtns.map((b) => b.querySelector('.opt-text').textContent);
  check(
    '序号和引号都被剥掉了（模型爱带，得容忍）',
    texts.includes('我想先喝一杯，压压惊') && texts.includes('我直接问他叫什么名字'),
    JSON.stringify(texts)
  );
  check('重复的选项只留一个', texts.filter((t) => t === '我想先喝一杯，压压惊').length === 1, JSON.stringify(texts));

  // 选项行不该留在消息气泡里（它已经变成按钮了）
  const bodyText = byId('messages').textContent;
  check('消息正文里看不到「【剧情选项】：」原文', !bodyText.includes('【剧情选项】：'), bodyText.slice(-160));
  check('状态栏原文也不在气泡里', !bodyText.includes('【好感度】：63/100'), bodyText.slice(-160));

  // 这一轮的状态栏照常被收下（选项和状态栏是一起回来的）。
  // ⚠️ 状态字段现在不存在「当前状态」面板里了 —— 面板已去掉，
  // 字段按 owner 分给了各人的状态卡。这个会话是单角色聊天，所以字段归那张卡。
  {
    // 读**内存里**的会话（不是盘上那份）：面板是每轮回复后同步的，
    // 落盘有防抖，此时读盘可能还是上一次的快照（原来用 DOM 断言，读的就是内存）。
    const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    const ca = (stateMod.state.conversations || []).find((c) => c.id === stateMod.state.activeId);
    check(
      '同一条回复里的状态栏被收下了（「好感度」进了会话状态）',
      !!ca && panelValByName(ca.panel, '好感度') === '63/100',
      JSON.stringify(ca && ca.panel)
    );

    // 「剧情选项」是**程序读的指令行**，不是状态字段。
    // 它的形状和面板行一模一样（行首【】、值也不长），所以扫描时很容易被误收 ——
    // 而 cleanAssistantText 又把它剥掉了，于是表现为「气泡里看不见、状态里却多一个字段」。
    // 这条断言盯的就是那个分裂：选项行和状态栏同一条消息回来，它绝不能进字段表。
    check(
      '「剧情选项」没被当成状态字段收下',
      !!ca && !panelValByName(ca.panel, '剧情选项') && !panelDefByName(ca.panelDefs, '剧情选项'),
      JSON.stringify({ panel: ca && Object.keys(ca.panel || {}), defs: ca && Object.keys(ca.panelDefs || {}) })
    );
  }

  // 「好感度」是模型自己输出、这个角色卡上没声明过的字段。
  // 它的值写成「63/100」，从形状就能看出是个带范围的数值 —— 该有进度条。
  // （以前只认角色卡上声明过的属性，模型自己冒出来的数值永远没有进度条。）
  // 这条现在去状态卡里验：字段归角色（owner = 本局的角色），不在面板里。
  {
    const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
    check('入口条上有角色头像（模型自己冒的字段归它）', !!charAvatar);
    if (charAvatar) {
      click(charAvatar);
      await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

      const charCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
      const favorRow = Array.from(charCard().querySelectorAll('.sc-row')).find(
        (r) => (r.querySelector('.sc-name') || {}).textContent === '好感度'
      );
      check('模型自己给的数值字段也认出了满值（/100）', !!favorRow && !!favorRow.querySelector('.sc-bar'),
        favorRow ? favorRow.outerHTML.slice(0, 160) : '没找到「好感度」那一行');
      const inferredBar = favorRow && favorRow.querySelector('.sc-bar');
      check(
        '推断出来的满值接进了进度条（63/100 → 63%）',
        !!inferredBar && inferredBar.querySelector('.sc-bar-fill').style.width === '63%',
        inferredBar ? inferredBar.querySelector('.sc-bar-fill').style.width : '没有进度条'
      );

      // 推断出来的范围也要真的生效：在卡里手填越界值会被夹回来
      click(charCard().querySelector('.sc-edit'));
      await waitFor('卡切到编辑态', () => !!charCard().querySelector('input.sc-input'));
      const input = Array.from(charCard().querySelectorAll('.sc-row')).find(
        (r) => (r.querySelector('.sc-name') || {}).textContent === '好感度'
      ).querySelector('input.sc-input');
      if (input) {
        setValue(input, '150');
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(300);
        const cv = await window.mimitale.getConversations();
        const ca = cv.conversations.find((c) => c.id === cv.activeId);
        check(
          '推断出来的范围也真的夹得住（150 → 100/100）',
          !!ca && panelValByName(ca.panel, '好感度') === '100/100',
          JSON.stringify(ca && panelValByName(ca.panel, '好感度'))
        );
      }
      // 把卡关掉，别影响下面的选项断言（它们抓的是气泡里的按钮，不冲突）
      click(charCard().querySelector('.sc-close'));
      await sleep(150);
    }
  }

  // --- 4) 选一个选项 → 当作玩家回复发出去，选项消失 ---
  // （换一批重绘过整块，选项按钮要重新抓；文字取 .opt-text，别把序号/箭头算进去）
  const beforeCount = $$('#messages .msg').length;
  const pick = $$('#messages .msg-option-btn')[0];
  const pickText = pick.querySelector('.opt-text').textContent;

  // 数字键快捷选择：选项按钮印着 1、2、3… 序号，输入框为空时按数字键直接选中
  const idxLabels = $$('#messages .msg-option-btn').map((b) => (b.querySelector('.opt-index') || {}).textContent);
  const expectedIdx = idxLabels.map((_, i) => String(i + 1)).join(',');
  check('选项按钮印着连续的数字序号（1、2、3…）', idxLabels.join(',') === expectedIdx && idxLabels.length > 0, JSON.stringify(idxLabels));

  // 输入框为空时按「1」→ 应该选中第一个选项（和上面的 pick 是同一个）
  const inputEl = byId('input');
  inputEl.value = '';
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 12000);
  await sleep(300);

  // 点选项/按数字键都是「直接发送」，不该把选项文字写进输入框 —— 输入框保持原样（空）
  check('选选项后输入框没有被塞进文字', byId('input').value === '', `输入框当前值：${JSON.stringify(byId('input').value)}`);

  const userMsgs = $$('#messages .msg')
    .filter((m) => m.classList.contains('user'))
    .map((m) => m.textContent);
  check(
    '按数字键真的把对应选项当玩家回复发出去了',
    userMsgs.some((t) => t.includes(pickText)),
    JSON.stringify(userMsgs.slice(-3))
  );
  check('消息确实变多了', $$('#messages .msg').length > beforeCount, `${beforeCount} → ${$$('#messages .msg').length}`);

  // 用过就清掉、然后由**新一轮**的回复重新填上 —— 所以点完之后不该还是
  // 「刚才那一批旧选项」，而应该是新一批。这里验的是「没有把旧选项留着重复点」：
  // 点完立刻发消息，假后端会再给一批，所以只能验「选项内容仍然是干净的」。
  const convos = await window.mimitale.getConversations();
  const active = convos.conversations.find((c) => c.id === convos.activeId);
  check(
    '点完选项后选项区仍然干净（要么空、要么是新一轮给的）',
    !!active && Array.isArray(active.options) && active.options.every((t) => typeof t === 'string' && t.trim() && !t.includes('【')),
    JSON.stringify(active && active.options)
  );
  check(
    '选项按钮个数没有越堆越多（被 MAX_OPTIONS 夹住）',
    !!active && active.options.length <= 6,
    `实际 ${active && active.options.length}`
  );
  check('配置本身还在（下一轮还会给新选项）', !!active && !!active.optionsSpec && active.optionsSpec.count === 3,
    JSON.stringify(active && active.optionsSpec));
});

// ---------------------------------------------------------------------------
//  场景 21b：剧情选项的默认值与「关掉」这条路
//
//  以前默认是不开：新建的卡、导入的卡、进世界时自己写的主角，全都没有剧情选项。
//  现在统一默认开、每轮 4 条。关掉要在角色编辑器里取消勾选，而且**必须写 false** ——
//  主进程的 normalizeCharacter 把「没有这个字段 / null」当成「没配过」→ 回落到默认开，
//  所以写 null 的话一存盘又变回开着的（这里把这条往返钉死）。
// ---------------------------------------------------------------------------
await scenario('剧情选项：默认开、关掉要写 false', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '关掉选项的角色';
  setValue('#c-name', NAME);
  await sleep(80);

  check('新建的卡默认开着剧情选项', byId('c-options-on').checked === true, String(byId('c-options-on').checked));
  check('默认每轮 4 条', byId('c-options-count').value === '4', byId('c-options-count').value);

  click('#c-options-on'); // 取消勾选 = 这张卡不要剧情选项
  await sleep(80);
  check('取消勾选后配置区收起来', !shown('#c-options-config'));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'), 8000);
  await sleep(150);

  const saved = await savedCharacters();
  const mine = saved.find((c) => c.name === NAME);
  check(
    '「关掉」落盘成 false（不是 null/undefined，否则会被归一化变回默认开）',
    !!mine && mine.optionsSpec === false,
    JSON.stringify(mine && mine.optionsSpec)
  );

  // 用这张卡开一局：会话上不该有剧情选项
  click('#btn-close-chars');
  await sleep(150);
  const card = $$('#char-page-grid .char-card').find((c) => String(c.textContent || '').includes(NAME));
  check('关掉选项的角色也出现在列表里', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'), 8000);
  await sleep(300);

  const convo = await activeConvo();
  check(
    '关掉的卡开的会话 optionsSpec 是 null（不注入剧情选项）',
    !!convo && convo.optionsSpec === null,
    JSON.stringify(convo && convo.optionsSpec)
  );
});

// ---------------------------------------------------------------------------
//  场景 22：身份四项的分组兜底（panelFieldGroup）
//
//  身份四项（姓名/年龄/性别/种族）现在种面板时会带上「身份」分组，但**老会话**
//  种的时候还没有分组这个概念，panelDefs 里没记 group。panelFieldGroup 负责按
//  字段名兜底，让新旧会话的分组展示和提示词注入一致。
//  纯函数，动态 import 真代码来测（同场景 20 的路数）。
// ---------------------------------------------------------------------------
await scenario('面板：身份分组的兜底', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.panelFieldGroup === 'function') {
    check('panelFieldGroup 能从真模块里拿到', true);

    // 老会话形状：defs 里只有数值字段的定义，身份四项什么都没记
    const legacyConvo = {
      panelFields: ['姓名', '年龄', '金币'],
      panel: { 姓名: '阿莉', 年龄: '18', 金币: '100' },
      panelDefs: { 金币: { type: 'meter', min: 0, max: 100 } }
    };

    check(
      '老会话的身份字段兜底归进「身份」组',
      mod.panelFieldGroup(legacyConvo, '姓名') === mod.IDENTITY_GROUP && mod.panelFieldGroup(legacyConvo, '年龄') === mod.IDENTITY_GROUP,
      JSON.stringify([mod.panelFieldGroup(legacyConvo, '姓名'), mod.panelFieldGroup(legacyConvo, '年龄')])
    );
    check('不是身份四项的字段不兜底（保持没分组）', mod.panelFieldGroup(legacyConvo, '金币') === '', mod.panelFieldGroup(legacyConvo, '金币'));
    check(
      'defs 里记过 group 的以 defs 为准（不被兜底覆盖）',
      mod.panelFieldGroup({ panelFields: ['好感度'], panel: {}, panelDefs: { 好感度: { type: 'meter', group: '关系' } } }, '好感度') === '关系'
    );

    // 新会话形状：种的时候 group 已经记进 defs —— 兜底不该多事
    const newConvo = {
      panelFields: ['姓名'],
      panel: { 姓名: '阿莉' },
      panelDefs: { 姓名: { type: 'text', group: mod.IDENTITY_GROUP } }
    };
    check('新会话的身份字段直接读 defs（结果一致）', mod.panelFieldGroup(newConvo, '姓名') === mod.IDENTITY_GROUP);
  }
});

// ---------------------------------------------------------------------------
//  场景 22b：归一化定义表不能丢掉「分组」信息
//
//  这是**真 bug 的回归测试**：normalizePanelDefs 以前把「type=text 且没有
//  范围/hint」的定义当成「没意义」直接丢掉。但「状态栏」里的时间/地点/心情
//  正是这种纯文本、没有范围/hint 的字段，它们的 group 是唯一的归属依据。
//  重启后读盘走 normalizePanelDefs，group 一丢，这几个字段就散回「未分组」。
// ---------------------------------------------------------------------------
await scenario('面板：归一化不丢分组', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.normalizePanelDefs === 'function') {
    check('normalizePanelDefs 能从真模块里拿到', true);

    // 种进去之后、写盘再读回来的形状：纯文本字段只有 type + group，没有范围/hint
    const defs = mod.normalizePanelDefs({
      时间: { type: 'text', group: '状态栏' },
      地点: { type: 'text', group: '状态栏' },
      心情: { type: 'text', group: '状态栏' },
      好感度: { type: 'meter', min: 0, max: 100, group: '关系' }
    });

    check(
      '纯文本字段的 group 被保留（时间/地点/心情都还在「状态栏」里）',
      defs['时间'] && defs['时间'].group === '状态栏' &&
        defs['地点'] && defs['地点'].group === '状态栏' &&
        defs['心情'] && defs['心情'].group === '状态栏',
      JSON.stringify(defs)
    );
    check('带范围的数值字段照常保留（含 group）', defs['好感度'] && defs['好感度'].group === '关系', JSON.stringify(defs['好感度']));

    // 反过来：确实没意义的纯文本定义（连 group 都没有）还是该丢掉
    const empty = mod.normalizePanelDefs({ 随便: { type: 'text' } });
    check('没有 group 的空定义仍然被丢掉', !('随便' in empty), JSON.stringify(empty));
  }
});

// ---------------------------------------------------------------------------
//  场景 22c：流式阶段把「当前状态」那段砍掉（不抖）+ 抬头也剥掉
//
//  这是**用户体验问题的回归测试**。面板是收尾时（syncConvoPanel）才解析赋值的，
//  所以流式过程中模型正在吐的状态栏原文还躺在正文里。以前气泡会先整块冒出
//  「【当前状态】」「—— 状态栏 ——」「【时间】：夜晚」再在收尾被剥掉，忽长忽短。
//
//  修法分两半：
//    · 流式显示用 cutTrailingStatusBlock —— 从第一个状态行起**整体截断**、只进不退，
//      半截字段行不会闪（用 cleanAssistantText 的话，半截行匹配不上正则会闪一下）。
//    · cleanAssistantText 额外剥掉「[当前状态] / 【当前状态】」抬头（收尾渲染用）。
// ---------------------------------------------------------------------------
await scenario('流式：当前状态那段在显示前就砍掉', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.cutTrailingStatusBlock === 'function') {
    // 这一局的面板字段名 —— 流式截断要靠它区分「面板字段」和「正文小标题」
    const fields = ['时间', '地点', '心情', '好感度'];

    const streamed = [
      '*她抬头看向你，眼睛闪着期待。*',
      '',
      '[当前状态]',
      '—— 状态栏 ——',
      '【时间】：夜晚',
      '【地点】：图书馆四楼',
      '【心情】：烦躁',
      '',
      '—— 关系 ——',
      '【好感度】：63/100',
      '',
      '【剧情选项】：问她要不要一起走 / 帮她还书 / 假装没看见'
    ].join('\n');

    // --- 流式显示：从状态块起整体截断，正文保留 ---
    const shown = mod.cutTrailingStatusBlock(streamed, fields);
    check('流式显示只剩正文（动作描写还在）', shown.includes('她抬头看向你'), shown);
    check(
      '状态块整个被砍掉（抬头/分组/字段/选项都不在）',
      !shown.includes('当前状态') && !shown.includes('—— 状态栏 ——') &&
        !shown.includes('【时间】') && !shown.includes('【好感度】') && !shown.includes('剧情选项'),
      shown
    );

    // --- 半截字段行也不该闪：只要行首是【，哪怕还没写到冒号，也照样被砍 ---
    const partial = mod.cutTrailingStatusBlock('*正文*\n\n【时间】：夜', fields);
    check('半截字段行（【时间】：夜）也被砍掉，不会闪一下', partial.trim() === '*正文*', JSON.stringify(partial));

    // --- 回归：内心描写 / 上帝视角的【心理】【旁白】是正文小标题，不能被当状态块砍掉 ---
    // 真 bug：以前只看「行首是【】」就砍，这几段在整个流式过程中都不显示，
    // 直到最后重绘才一次性蹦出来。
    const narrated = [
      '她抬头看你。',
      '',
      '【心理】',
      '其实她很想留下。',
      '',
      '【旁白】',
      '雨还在下。'
    ].join('\n');
    const narratedShown = mod.cutTrailingStatusBlock(narrated, fields);
    check(
      '【心理】/【旁白】这种正文小标题不被砍掉',
      narratedShown.includes('其实她很想留下') && narratedShown.includes('雨还在下'),
      JSON.stringify(narratedShown)
    );

    // --- 收尾渲染：cleanAssistantText 也要剥掉抬头 ---
    const groups = ['状态栏', '关系'];
    const final = mod.cleanAssistantText(streamed, fields, groups);
    check('收尾渲染只剩正文', final.includes('她抬头看向你'), final);
    check(
      '抬头「[当前状态]」被剥掉',
      !final.includes('当前状态') && !final.includes('[当前状态]') && !final.includes('【当前状态】'),
      final
    );
    check(
      '字段行 / 分组小标题 / 剧情选项都被剥掉',
      !final.includes('【时间】') && !final.includes('—— 关系 ——') && !final.includes('剧情选项'),
      final
    );

    // --- 继续（continue）场景：base + delta 的组合，别把夹在中间的正文误砍 ---
    // 继续时 assistant.content 已经躺着上一轮的状态块，onChunk 里是
    // `base(cleanAssistantText 剥旧状态块) + cutTrailingStatusBlock(本轮 delta)`。
    // 这里模拟两次继续后的原文：两个旧状态块之间夹着正文，必须都保住。
    const continuedBefore = [
      '*第一轮正文。*',
      '',
      '[当前状态]',
      '【时间】：夜晚',
      '',
      '*继续后的正文。*',
      '',
      '[当前状态]',
      '【时间】：深夜'
    ].join('\n');
    const base = mod.cleanAssistantText(continuedBefore, fields, groups);
    const delta = '\n\n*再继续的正文。*\n\n【时间】：凌晨';
    const composed = base + mod.cutTrailingStatusBlock(delta, fields);
    check(
      '继续时旧状态块被剥掉、夹在中间的正文都保住、本轮状态块被砍',
      composed.includes('第一轮正文') && composed.includes('继续后的正文') &&
        composed.includes('再继续的正文') && !composed.includes('当前状态') && !composed.includes('【时间】'),
      composed
    );
  }
});

// ---------------------------------------------------------------------------
//  场景 22b：【心理】/【旁白】**单独占一行**也要认（渲染层）
//
//  模型最常见的写法是「标记单独一行、内容写在下一段」（它把标记当成小标题）：
//
//      【心理】
//      苏晴：这人原来有学长带。
//
//  而 ui/markdown.js 原来只认同行写法（`【心理】内容`），于是标记行匹配上
//  「标记 + 空内容」→ 渲染出一个**空的** `<p class="msg-inner">`，真正的内容
//  成了普通段落。用户看到的就是「选了内心描写 / 上帝视角，心理旁白一点样式都没有」
//  —— 也就是他报的「叙述模式依旧无效」（2026-10-08，拿真实回复来报的）。
//
//  下面那两段原文就是从用户 data/conversations.json 里抄出来的真实形状。
// ---------------------------------------------------------------------------
await scenario('叙述：心理/旁白标记单独一行也要认', async () => {
  let md = null;
  try {
    md = await import(new URL('js/ui/markdown.js', document.baseURI).href);
  } catch (err) {
    check('markdown 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!md || typeof md.renderMarkdown !== 'function') return;

  // --- 1) 真实形状：标记单独一行，内容在下一段（中间没有空行）---
  const separate = [
    '苏晴把钥匙翻过来看了眼标签，又翻回去。',
    '',
    '【心理】',
    '苏晴：这人原来有学长带。那也好，箱子的事有人管了。',
    '',
    '【旁白】',
    '图书馆门口正对着一条下坡路，通向东边的宿舍区。'
  ].join('\n');
  const html = md.renderMarkdown(separate);

  check(
    '标记单独一行：心理那段被包进 msg-inner，且**有内容**',
    /<p class="msg-inner">苏晴：这人原来有学长带/.test(html),
    html.slice(html.indexOf('msg-inner') - 20, html.indexOf('msg-inner') + 80)
  );
  check(
    '标记单独一行：旁白那段被包进 msg-aside，且有内容',
    /<p class="msg-aside">图书馆门口正对着一条下坡路/.test(html),
    html.slice(html.indexOf('msg-aside') - 20, html.indexOf('msg-aside') + 80)
  );
  check(
    '不能再出现空的 msg-inner / msg-aside 块',
    !/class="msg-(inner|aside)"><\/p>/.test(html),
    html.match(/class="msg-(inner|aside)">[^<]{0,20}/g)
  );
  check(
    '标记本身不显示出来',
    !html.includes('【心理】') && !html.includes('【旁白】'),
    html
  );

  // --- 2) 标记和内容之间隔了空行，同样要认 ---
  const spaced = ['【心理】', '', '', '她在心里叹了口气。'].join('\n');
  const spacedHtml = md.renderMarkdown(spaced);
  check(
    '标记与内容之间有空行也认',
    /<p class="msg-inner">她在心里叹了口气。<\/p>/.test(spacedHtml),
    spacedHtml
  );

  // --- 3) 同行写法（老形状）不能被这次改动弄坏 ---
  const inline = md.renderMarkdown('【心理】其实她很想留下。\n\n【旁白】雨还在下。');
  check(
    '同行写法照旧（【心理】内容）',
    /<p class="msg-inner">其实她很想留下。<\/p>/.test(inline) &&
      /<p class="msg-aside">雨还在下。<\/p>/.test(inline),
    inline
  );

  // --- 4) 模型忘了写内容（标记吊在整篇末尾）：不能留一个空块占位置 ---
  const empty = md.renderMarkdown('正文一段。\n\n【心理】');
  check(
    '标记吊在末尾、后面没内容 → 不留空块',
    !/class="msg-(inner|aside)"/.test(empty) && empty.includes('正文一段'),
    empty
  );
});

// ---------------------------------------------------------------------------
//  场景 23：正文剥分组小标题（—— 身份 —— / —— 状态栏 ——）
//
//  模型照着注入的格式输出状态栏时，会把「—— 组名 ——」小标题也一起抄进正文。
//  字段行被剥掉后，这些孤零零的分组标题就漏在气泡里。cleanAssistantText 要能
//  把它们一并剥掉，且不能误删正文里「—— 他顿了顿 ——」这种破折号引语。
// ---------------------------------------------------------------------------
await scenario('正文：分组小标题也要剥掉', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (!mod || typeof mod.cleanAssistantText !== 'function') return;

  const text = [
    '*她抬头看向你，眼睛里闪着期待的光。*',
    '',
    '—— 身份 ——',
    '【姓名】：莉莉娅',
    '【年龄】：18',
    '',
    '—— 状态栏 ——',
    '【时间】：夜晚',
    '【地点】：主人的家',
    '',
    '—— 关系 ——',
    '【好感度】：40/100',
    '',
    '「主人，今晚想聊点什么？」'
  ].join('\n');

  const fields = ['姓名', '年龄', '时间', '地点', '好感度'];
  const groups = ['身份', '状态栏', '关系'];

  const cleaned = mod.cleanAssistantText(text, fields, groups);

  check(
    '分组小标题被剥掉了（身份/状态栏/关系都不在）',
    !cleaned.includes('—— 身份 ——') && !cleaned.includes('—— 状态栏 ——') && !cleaned.includes('—— 关系 ——'),
    cleaned
  );
  check('字段行也被剥掉了', !cleaned.includes('【姓名】') && !cleaned.includes('【好感度】'), cleaned);
  check('正文（动作描写 + 台词）完好保留', cleaned.includes('她抬头看向你') && cleaned.includes('今晚想聊点什么'), cleaned);

  // 破折号引语不该被误删：组名不在 knownGroups 里
  const prose = ['他顿了顿，说：', '—— 我有点累了 ——', '然后就走了。'].join('\n');
  const proseCleaned = mod.cleanAssistantText(prose, [], ['身份']);
  check('正文里「—— 破折号引语 ——」不被误删', proseCleaned.includes('—— 我有点累了 ——'), proseCleaned);

  // 没传分组名时，标题保留原样（向后兼容，不会乱删）
  const noGroups = mod.cleanAssistantText(text, fields);
  check('不传分组名时不误删标题（保持旧行为）', noGroups.includes('—— 身份 ——'), noGroups);

  // 模型会在状态块最前面加一行 `【状态栏】`（第一个分组名套方括号当块标题），
  // 不是字段行、不是 `—— 组名 ——`、也不是 `【当前状态】`，需要单独剥。
  const real = [
    '她扶着门框，僵在原地，没敢回头。',
    '',
    '【状态栏】',
    '—— 状态栏 ——',
    '【露西诺·时间】：深夜',
    '【露西诺·地点】：迷夜酒馆·二楼走廊',
    '',
    '—— 穿着 ——',
    '【露西诺·披风】：已解下（搭在椅背上）',
  ].join('\n');
  const realCleaned = mod.cleanAssistantText(
    real,
    ['露西诺·时间', '露西诺·地点', '露西诺·披风'],
    ['状态栏', '穿着']
  );
  check('模型自加的「【状态栏】」标题被剥掉', !realCleaned.includes('【状态栏】'), realCleaned);
  check('「—— 状态栏 ——」小标题也剥掉', !realCleaned.includes('—— 状态栏 ——'), realCleaned);
  check('字段行照旧剥掉', !realCleaned.includes('【露西诺·时间】'), realCleaned);
  check('正文完好保留', realCleaned.includes('她扶着门框，僵在原地'), realCleaned);

  // 正文里恰好整行是「【不是组名的东西】」的，不能误删
  const quote = ['她指了指门牌。', '【迷夜酒馆·休息室】', '门牌上这么写着。'].join('\n');
  const quoteCleaned = mod.cleanAssistantText(quote, [], ['状态栏']);
  check('正文里「【非组名】」整行引用不被误删', quoteCleaned.includes('【迷夜酒馆·休息室】'), quoteCleaned);
});

// ---------------------------------------------------------------------------
//  场景 24：选项解析容忍「字母标签」
//
//  模型有时把格式示例当成要求，输出「A / 选项一 / B / 选项二 …」——
//  拆出来就是一堆孤立单字母按钮。extractOptionsFromText 要：
//  丢掉孤立字母、剥掉「A. 」前缀，内容原样保留；真选项里的多字组合不受影响。
// ---------------------------------------------------------------------------
await scenario('选项：字母标签容错', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (!mod || typeof mod.extractOptionsFromText !== 'function') return;

  // 截图里的实际形状：字母标签和内容交替，全在一行用「 / 」隔开
  const labeled = mod.extractOptionsFromText(
    '【剧情选项】：A / 推门进去，问她今晚打烊前还有没有空位 / B / 在吧台坐下，点一杯麦酒顺便打听镇上的传闻 / C / 把几个铜板放在桌上，预订二楼的房间'
  );
  check(
    '孤立字母标签被丢掉，只剩 3 条真选项',
    labeled.length === 3 &&
      labeled[0] === '推门进去，问她今晚打烊前还有没有空位' &&
      labeled[1] === '在吧台坐下，点一杯麦酒顺便打听镇上的传闻' &&
      labeled[2] === '把几个铜板放在桌上，预订二楼的房间',
    JSON.stringify(labeled)
  );

  // 标签贴在内容前面（A. 内容）也要剥掉
  const prefixed = mod.extractOptionsFromText('【剧情选项】：A. 走过去抱住她 / B、退后一步观察 / C: 转身离开');
  check(
    '「A. 」「A、」「A: 」前缀被剥掉',
    prefixed.join('|') === '走过去抱住她|退后一步观察|转身离开',
    JSON.stringify(prefixed)
  );

  // 真选项里的多字组合（OK / B超）不能被误伤
  const real = mod.extractOptionsFromText('【剧情选项】：打开 B超报告给她看 / 说 OK 然后走人');
  check('多字组合（B超/OK）不被当成标签', real.join('|') === '打开 B超报告给她看|说 OK 然后走人', JSON.stringify(real));

  // 模型把示例整个照抄（全是字母）→ 没有可用选项 → 空数组（保持上一轮的）
  const placeholder = mod.extractOptionsFromText('【剧情选项】：A / B / C');
  check('全是占位字母时返回空（保持上一轮选项）', placeholder.length === 0, JSON.stringify(placeholder));
});

// ---------------------------------------------------------------------------
//  场景 25：普通回复的选项指令也要「避开上一批」
//
//  用户反馈：剧情选项「卡住」，同一批 3 个选项连着出现好几次，但「换一批」回来的
//  是对的。根因是「换一批」的指令里显式要求避开上一批，普通回复的 optionsInstruction
//  没有 —— 局面没怎么变时模型会原地打转，一遍遍给同样的选项。这里锁住这个修复。
// ---------------------------------------------------------------------------
await scenario('选项：普通回复也要避开上一批', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.optionsInstruction === 'function') {
    const convo = {
      optionsSpec: { count: 3, hint: '' },
      options: ['先喝汤，别接她这句话', '说上次是觉得她只切一小块太亏了', '把煎蛋夹到她碗里，一句话不说']
    };
    const text = mod.optionsInstruction(convo);
    check(
      '上一轮有选项时，指令里要求避开它们',
      text.includes('上一轮已经给过') && text.includes('先喝汤，别接她这句话') && text.includes('不要重复上一轮的'),
      text
    );

    const empty = mod.optionsInstruction({ optionsSpec: { count: 3, hint: '' }, options: [] });
    check('上一轮没有选项时不画蛇添足', !empty.includes('上一轮已经给过'), empty);

    const none = mod.optionsInstruction({ optionsSpec: null, options: [] });
    check('没开剧情选项时不注入', none === '', JSON.stringify(none));
  }
});

// ---------------------------------------------------------------------------
//  场景 26：状态卡（点「我」的头像 / 面板栏头像打开）
//
//  这张卡是「查看别人的状态」的入口：默认**只读**（纯文本展示），点「编辑」才
//  把值变成输入框。覆盖：聊天里点「我」的头像能开、面板栏的头像行、
//  只读↔编辑切换、改值落盘、加字段 / 删字段。
// ---------------------------------------------------------------------------
await scenario('状态卡：点头像查看与编辑', async () => {
  const worldItem = $$('#convo-list .convo-item').find((it) => {
    const t = it.querySelector('.convo-title');
    return t && t.textContent.trim() === '冒烟测试世界';
  });
  check('找到「冒烟测试世界」会话', !!worldItem);
  if (worldItem) click(worldItem);
  await waitFor('切到世界会话', () => shown('#view-chat'));
  await sleep(300);

  const myCard = () => $('#state-cards .state-card[data-owner="player"]');

  // --- 聊天里点「我」的头像 → 开我的状态卡 ---
  const myAvatar = $$('#messages .msg.user .msg-avatar')[0];
  check('用户消息的头像挂上了「可点」标记', !!myAvatar && myAvatar.classList.contains('clickable'));
  if (myAvatar) click(myAvatar);
  await waitFor('我的状态卡出现', () => !!myCard());

  check(
    '卡片默认是只读的（值是文本，没有输入框）',
    $$('#state-cards .state-card[data-owner="player"] .sc-value').length > 0 &&
      $$('#state-cards .state-card[data-owner="player"] input.sc-input').length === 0,
    JSON.stringify({ 值: $$('#state-cards .state-card[data-owner="player"] .sc-value').length, 输入框: $$('#state-cards .state-card[data-owner="player"] input.sc-input').length })
  );
  check(
    '卡里有玩家角色卡种下的属性',
    $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '金币'),
    JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
  );

  // --- 点「编辑」→ 值变成输入框 ---
  click(myCard().querySelector('.sc-edit'));
  await waitFor('编辑态出现输入框', () => $$('#state-cards .state-card[data-owner="player"] input.sc-input').length > 0);
  check('编辑态下按钮变成「完成」', myCard().querySelector('.sc-edit').textContent.trim() === '完成', myCard().querySelector('.sc-edit').textContent);

  // --- 改一个值 → 落到会话面板上 ---
  const ageRow = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
    (r) => r.querySelector('.sc-name').textContent === '年龄'
  );
  const ageInput = ageRow.querySelector('input.sc-input');
  setValue(ageInput, '19');
  ageInput.dispatchEvent(new Event('blur', { bubbles: true }));
  await sleep(300);
  let cv = await window.mimitale.getConversations();
  let wc = cv.conversations.find((c) => c.title === '冒烟测试世界');
  check('卡片里改的值落到了会话面板上', !!wc && wc.panel && panelValByName(wc.panel, '年龄') === '19', wc ? String(panelValByName(wc.panel, '年龄')) : 'null');

  // --- 加一个字段 ---
  setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '心情');
  click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
  await waitFor('新字段出现', () =>
    $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '心情')
  );
  await sleep(200);
  cv = await window.mimitale.getConversations();
  wc = cv.conversations.find((c) => c.title === '冒烟测试世界');
  check(
    '新字段归到玩家名下（owner=player）',
    !!wc && panelDefByName(wc.panelDefs, '心情') && panelDefByName(wc.panelDefs, '心情').owner === 'player',
    JSON.stringify(wc && panelDefByName(wc.panelDefs, '心情'))
  );

  // --- 删掉它 ---
  const moodRow = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
    (r) => r.querySelector('.sc-name').textContent === '心情'
  );
  check('新字段行里有删除按钮', !!moodRow && !!moodRow.querySelector('.sc-del'));
  click(moodRow.querySelector('.sc-del'));
  await sleep(250);
  check(
    '删掉之后卡里就没了',
    !$$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '心情'),
    JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
  );

  // --- 入口条：我（+ 角色）的头像都在，点角色头像开那张卡 ---
  const castOwners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
  check('入口条上第一个头像是「我」', castOwners[0] === 'player', JSON.stringify(castOwners));

  // --- ✕ 收掉我那张卡 ---
  click(myCard().querySelector('.sc-close'));
  await sleep(150);
  check('点 ✕ 把卡收掉了', !myCard());

  // --- 绑了角色的会话：头像行只有那个角色（普通聊天不显示「我」），点它开卡 ---
  const charConvo = $$('#convo-list .convo-item').find((it) => {
    const t = it.querySelector('.convo-title');
    return t && t.textContent.trim().startsWith('选项测试');
  });
  if (charConvo) {
    click(charConvo);
    await sleep(400);
    const owners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
    check(
      '绑了角色的会话里入口条只有那个角色（没有「我」）',
      !owners.includes('player') && owners.length === 1,
      JSON.stringify(owners)
    );

    const charBtn = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
    if (charBtn) {
      const charOwner = charBtn.dataset.owner;
      const charCard = () => $(`#state-cards .state-card[data-owner="${CSS.escape(charOwner)}"]`);
      click(charBtn);
      await waitFor('角色状态卡出现', () => !!charCard());
      check('点角色头像能开那个角色的卡', !!charCard());
      check('角色卡里也有字段', $$(`#state-cards .state-card[data-owner="${CSS.escape(charOwner)}"] .sc-name`).length > 0);
      click(charCard().querySelector('.sc-close'));
      await sleep(150);
    }

    // --- 玩家卡里加一个「角色已经占了」的名字 → 提示要说清是谁占的 ---
    // 字段名全局唯一（面板注入给模型的是「【名字】：值」，同名模型分不出是谁的），
    // 所以单角色聊天里「姓名/性别」这类名字是加不进玩家卡的。
    // ⚠️ 以前这里只查「整张面板有没有这个名字」，于是玩家卡明明没有也会报
    //    「已经有了」—— 用户会懵（「我没加啊」）。现在必须说清是**角色**占了。
    // 普通聊天的入口条没有「我」（2026-10-08），玩家卡从自己消息的头像开。
    const myMsgAvatar = $$('#messages .msg.user .msg-avatar').pop();
    if (myMsgAvatar) {
      click(myMsgAvatar);
      await waitFor('我的状态卡从自己消息的头像打开', () => !!$('#state-cards .state-card[data-owner="player"]'));
      click($('#state-cards .state-card[data-owner="player"] .sc-edit'));
      await sleep(250);

      setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '姓名');
      click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
      await sleep(150);
      const toast = byId('toast');
      check(
        '加角色已占用的名字时，提示说的是「角色那边占了」而不是干巴巴的「已经有了」',
        !!toast && toast.textContent.includes('角色那边占了') && toast.textContent.includes('我的姓名'),
        toast ? toast.textContent : '(没有提示)'
      );
      check(
        '同名字段确实没有被加进去',
        !$$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '姓名'),
        JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
      );

      // 按提示换个不冲突的名字就能加上
      setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '我的姓名');
      click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
      await waitFor(
        '换个名字就加上了',
        () => $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '我的姓名')
      );
      check('换个名字就能加成（提示给的活路走得通）', true);
    }
  }
});

// ---------------------------------------------------------------------------
//  场景 26：切世界书时，编辑器残留的旧表单不能盖到刚切过去的那一本。
//
//  老根因：stash 写的是 currentWorldbook()，此时已被改成新书，旧书名会写进新书。
//  现在书名 / 开场白 / 条目**按书各存一份草稿**（「保存后才生效」），
//  结构上就没有「旧表单盖到新书」这条路了 —— 这条场景改成钉住新语义：
//    · 改了一半的名字不会跑到列表页的卡片上（没保存就不算数）；
//    · 新建的书用自己的默认名，不继承上一本残留的输入；
//    · 切回原来那本，没保存的改动还在（草稿是按书存的，不是全局一个）；
//    · 点「保存」之后才真的落盘，两本书各是各的名字。
// ---------------------------------------------------------------------------
await scenario('世界书：切书时旧表单不能盖住新书', async () => {
  const namesOnPage = () => $$('#wb-page-grid .char-card-name').map((n) => n.textContent);
  const cardNamed = (name) => $$('#wb-page-grid .char-card').find((c) => c.title === name);

  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));

  // 打开种子里那本，改名「甲书」—— 故意**不保存**，留一份脏草稿
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  await sleep(150);
  setValue('#wb-name', '甲书');
  await sleep(200);
  check('书名已经改成「甲书」', $('#wb-name').value === '甲书', `输入框里是「${$('#wb-name').value}」`);
  check('没保存之前列表页上还没改名', !namesOnPage().includes('甲书'), JSON.stringify(namesOnPage()));

  // 新建一本：它得用自己的默认名，不能被输入框里残留的「甲书」盖掉
  click('#btn-new-worldbook');
  await sleep(300);
  check(
    '新建的书用自己的默认名（没继承上一本的）',
    $('#wb-name').value === '新世界书',
    `输入框里是「${$('#wb-name').value}」`
  );

  // 切回「甲书」那本：草稿是按书存的，没保存的改动不该被切没了
  click(buttonByText(cardNamed('冒烟测试世界'), '编辑'));
  await sleep(300);
  check(
    '切回原来那本，没保存的书名还在（草稿按书各存一份）',
    $('#wb-name').value === '甲书',
    `输入框里是「${$('#wb-name').value}」`
  );

  // 保存它 —— 到这一刻列表页才该改名叫「甲书」
  click('#btn-save-wb');
  await sleep(350);
  check('保存之后列表页上才改名', namesOnPage().includes('甲书'), JSON.stringify(namesOnPage()));

  // 给新建的那本起个自己的名字并保存
  click(buttonByText(cardNamed('新世界书'), '编辑'));
  await sleep(300);
  check(
    '新建的那本还在，名字还是它自己的默认名',
    $('#wb-name').value === '新世界书',
    `输入框里是「${$('#wb-name').value}」`
  );
  setValue('#wb-name', '乙书');
  await sleep(120);
  click('#btn-save-wb');
  await sleep(350);
  check(
    '两本书各是各的名字',
    namesOnPage().includes('甲书') && namesOnPage().includes('乙书'),
    JSON.stringify(namesOnPage())
  );

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
  await sleep(400);
  const names = (await savedWorldbooks()).map((b) => b.name);
  check(
    '两本书的名字都各自落盘了（没有互相覆盖）',
    names.includes('甲书') && names.includes('乙书'),
    JSON.stringify(names)
  );
});

// ---------------------------------------------------------------------------
//  场景 26b：世界书列表页卡片右上角的删除 ×
//
//  以前这里是**故意没有** × 的（怕「攒了很多条目一下删没了」），删除只留在编辑器里。
//  现在跟角色卡对齐：悬停浮出、点一下弹确认框 —— 确认框里会把条目数 / 角色副本数 /
//  被几个会话用着都摆出来，危险的部分靠确认框兜，不靠藏起来。
// ---------------------------------------------------------------------------
await scenario('世界书：卡片上删除', async () => {
  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));

  // 先造一本一次性的书，走真实的「新建 + 保存」
  click('#btn-new-worldbook');
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  setValue('#wb-name', '待删的临时世界');
  click('#btn-save-wb');
  await sleep(300);
  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
  await sleep(200);

  const namesOnPage = () => $$('#wb-page-grid .char-card-name').map((n) => n.textContent);
  const card = $$('#wb-page-grid .char-card').find((c) => c.title === '待删的临时世界');
  check('新建的书出现在列表页上', !!card, JSON.stringify(namesOnPage()));
  if (!card) return;

  const del = card.querySelector('.char-card-del');
  check('世界书卡片右上角有删除 ×', !!del);
  if (!del) return;

  // 和角色卡同一套：平时透明、鼠标移上来（或键盘 Tab 到）才浮出来
  check('删除 × 平时是透明的（悬停才浮出）',
    parseFloat(getComputedStyle(del).opacity) === 0, getComputedStyle(del).opacity);

  del.click();
  await waitFor('删除先弹确认框', () => shown('#confirm-modal'));
  check('确认框里点明了删的是哪本',
    byId('confirm-message').textContent.includes('待删的临时世界'), byId('confirm-message').textContent);
  click('#confirm-ok');
  await sleep(350);

  check('卡片被删掉了', !namesOnPage().includes('待删的临时世界'), JSON.stringify(namesOnPage()));
  const after = (await savedWorldbooks()).map((b) => b.name);
  check('卡片上删除也落了盘', !after.includes('待删的临时世界'), JSON.stringify(after));
});

// ---------------------------------------------------------------------------
//  场景 27：世界书里多个角色有同名字段时，各自保留、不互相挤掉。
//  修复：面板字段身份升级成「字段名 + owner」复合键，同名但归属不同的字段各自独立。
// ---------------------------------------------------------------------------
await scenario('面板：同名属性按 owner 各自保留', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.appendPanelFields !== 'function') {
    check('panel 模块能动态加载', false);
    return;
  }
  check('panel 模块能动态加载', true);

  // 造一个空会话，两个角色：姐姐（id=sis）和妹妹（id=young）都有「好感度」
  const convo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };

  mod.seedPanelFromCharacters(
    convo,
    [{ id: 'sis', name: '姐姐', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '5/100' }] }],
    'sis'
  );
  mod.seedPanelFromCharacters(
    convo,
    [{ id: 'young', name: '妹妹', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '80/100' }] }],
    'young'
  );

  check(
    '两个角色的同名「好感度」各自种进去（两条，不是被挤成一条）',
    convo.panelFields.length === 2,
    JSON.stringify(convo.panelFields)
  );
  check(
    '按 owner 能拆开两个「好感度」',
    convo.panelFields.filter((k) => mod.panelFieldOwner(convo, k) === 'sis').length === 1 &&
      convo.panelFields.filter((k) => mod.panelFieldOwner(convo, k) === 'young').length === 1,
    JSON.stringify(convo.panelFields.map((k) => [k, mod.panelFieldOwner(convo, k)]))
  );
  check(
    '姐姐的好感度值没被妹妹盖掉',
    convo.panelFields.some((k) => mod.panelFieldOwner(convo, k) === 'sis' && convo.panel[k] === '5/100'),
    JSON.stringify(convo.panel)
  );

  // 注入提示词：同名字段有冲突 → 加「角色名·」前缀；无冲突字段保持纯名
  const withPlayer = { ...convo, player: { name: '我' } };
  // 妹妹再加一个独有字段，验证「无冲突不加前缀」
  mod.seedPanelFromCharacters(
    withPlayer,
    [{ id: 'young', name: '妹妹', attributes: [{ name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' }] }],
    'young'
  );
  const prompt = mod.formatPanelForPrompt(withPlayer);
  // 这里 owner 用的是假 id（sis/young，不在角色库/世界书里），panelOwnerLabel
  // 查不到角色名时退回 id 本身作前缀 —— 真实场景里 owner 是世界书副本 id，
  // 能查到角色名。断言按「前缀 = 归属 id」来验冲突确实加了前缀。
  check('注入里同名「好感度」带归属前缀区分', prompt.includes('sis·好感度') && prompt.includes('young·好感度'), prompt);
  check('注入里无冲突的「铜板」保持纯字段名（不带前缀）', prompt.includes('【铜板】') && !prompt.includes('young·铜板'), prompt);

  // 描述（hint）里的 {{user}} 要展开成玩家名再注入。原样注入的话模型会看见
  // 占位符本身，然后开始猜它指谁。
  const hintConvo = {
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: [],
    player: { name: '测试者甲' }
  };
  mod.seedPanelFromCharacters(
    hintConvo,
    [
      {
        id: 'other',
        name: '对方',
        attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '0/100', hint: '对{{user}}的信赖与在意' }]
      }
    ],
    'other'
  );
  const hintPrompt = mod.formatPanelForPrompt(hintConvo);
  check(
    '字段描述里的 {{user}} 展开成玩家名，不再原样注入',
    !hintPrompt.includes('{{user}}') && hintPrompt.includes('对测试者甲的信赖与在意'),
    hintPrompt
  );

  // 模型照抄前缀（「前缀妹妹·好感度」）时要拆回给原来的 owner，不能新建一个
  // 名字里带前缀的重复字段。同名字段开始带前缀之后这条路径才第一次被走到 ——
  // 角色库里的卡按名字反查以前是查不到的（characterById 是按 id 查的）。
  // 卡临时塞进内存 state（不走保存：那条路绕开渲染层，列表不会刷新）。
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const backupChars = stateMod.state.characters;
  stateMod.state.characters = [
    ...(Array.isArray(backupChars) ? backupChars : []),
    { id: 'pfx-sis', name: '前缀姐姐', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '5/100' }] },
    { id: 'pfx-young', name: '前缀妹妹', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '80/100' }] }
  ];

  const round = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };

  // 老数据：同一个人身上「好感度」和「前缀妹妹·好感度」两份都躺着 → 并回一份
  const dupBase = mod.panelKey('好感度', 'pfx-young');
  const dupBad = mod.panelKey('前缀妹妹·好感度', 'pfx-young');
  const legacyDup = {
    panel: { [dupBase]: '80/100', [dupBad]: '90/100' },
    panelFields: [dupBase, dupBad],
    panelDefs: {},
    messages: [],
    player: null
  };

  try {
    mod.seedPanelFromCharacters(round, stateMod.state.characters.slice(-2), (c) => c.id);
    round.messages = [{ role: 'assistant', content: '【前缀妹妹·好感度】：90/100' }];
    mod.syncConvoPanel(round);
    mod.syncConvoPanel(legacyDup);
  } finally {
    stateMod.state.characters = backupChars;
  }
  check(
    '照抄「前缀妹妹·好感度」拆回那张卡的字段，不新建带前缀的重复字段',
    mod.convoPanelFields(round).length === 2 &&
      round.panel[mod.panelKey('好感度', 'pfx-young')] === '90/100' &&
      !mod.convoPanelFields(round).some((k) => mod.panelFieldName(k).includes('·')),
    JSON.stringify(round.panelFields) + ' ' + JSON.stringify(round.panel)
  );
  check(
    '老数据里重复的「前缀妹妹·好感度」被并回「好感度」',
    mod.convoPanelFields(legacyDup).length === 1 && legacyDup.panel[dupBase] === '90/100',
    JSON.stringify(legacyDup.panelFields) + ' ' + JSON.stringify(legacyDup.panel)
  );

  // 单角色聊天：字段名不冲突时，注入不该加前缀（保持老行为）
  const solo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.seedPanelFromCharacters(
    solo,
    [{ id: 'only', name: '单角', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '20/100' }] }],
    'only'
  );
  const soloPrompt = mod.formatPanelForPrompt(solo);
  check('单角色不冲突时注入保持纯字段名（【好感度】）', soloPrompt.includes('【好感度】') && !soloPrompt.includes('单角·好感度'), soloPrompt);

  // 迁移：老格式（纯字段名键 + def.owner）能就地升级成复合键
  const legacy = {
    panel: { 好感度: '20/100' },
    panelFields: ['好感度'],
    panelDefs: { 好感度: { type: 'meter', min: 0, max: 100, owner: 'oldid' } }
  };
  mod.migrateConvoPanel(legacy);
  check(
    '老格式面板能迁移成复合键（键里带 owner）',
    legacy.panelFields.length === 1 && legacy.panelFields[0] === '好感度\u0000oldid' && legacy.panel['好感度\u0000oldid'] === '20/100',
    JSON.stringify(legacy)
  );
});

// ---------------------------------------------------------------------------
//  场景 28：进世界之后才往书里加角色，新 NPC 的属性也要种进会话。
//  修复抽出 seedWorldbookCharactersIntoConvos，遍历绑定这本书的会话补种。验证：
//  绑了这本书的会种入、没绑的不碰、同名属性不盖掉已有的。
// ---------------------------------------------------------------------------
await scenario('世界书：进世界后加角色也能种进会话', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载（场景28）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.seedWorldbookCharactersIntoConvos !== 'function') {
    check('panel 模块能动态加载（场景28）', false);
    return;
  }
  check('panel 模块能动态加载（场景28）', true);

  // 两个会话：A 绑了这本书，B 没绑
  const book = { id: 'bk1', name: '酒馆' };
  const convos = [
    { id: 'cA', worldbookIds: ['bk1'], panel: {}, panelFields: [], panelDefs: {}, messages: [] },
    { id: 'cB', worldbookIds: ['other'], panel: {}, panelFields: [], panelDefs: {}, messages: [] }
  ];
  // 新加入的副本：一个角色，带一个「生命」属性
  const copies = [
    { id: 'wc_new', name: '新来的NPC', attributes: [{ name: '生命', type: 'meter', min: 0, max: 100, value: '50/100' }] }
  ];

  const seeded = mod.seedWorldbookCharactersIntoConvos(convos, book, copies);

  check('只种进了绑了这本书的那一个会话', seeded === 1, `seeded=${seeded}`);
  check(
    '绑了这本书的会话拿到了新 NPC 的属性（归属=副本 id）',
    convos[0].panelFields.length === 1 &&
      mod.panelFieldOwner(convos[0], convos[0].panelFields[0]) === 'wc_new' &&
      convos[0].panel[convos[0].panelFields[0]] === '50/100',
    JSON.stringify(convos[0].panelFields)
  );
  check(
    '没绑这本书的会话完全没被碰',
    convos[1].panelFields.length === 0,
    JSON.stringify(convos[1].panelFields)
  );

  // 会话里已有同名的「生命」（属于另一个角色）时，新 NPC 的「生命」不该盖掉它
  const clashConvo = { id: 'cC', worldbookIds: ['bk1'], panel: {}, panelFields: [], panelDefs: {}, messages: [] };
  mod.seedPanelFromCharacters(clashConvo, [{ id: 'wc_old', name: '老角色', attributes: [{ name: '生命', type: 'meter', min: 0, max: 100, value: '90/100' }] }], 'wc_old');
  mod.seedWorldbookCharactersIntoConvos([clashConvo], book, copies);
  check(
    '同名的「生命」按 owner 并存（老角色的 90 和新 NPC 的 50 都留着）',
    clashConvo.panelFields.length === 2 &&
      clashConvo.panelFields.some((k) => mod.panelFieldOwner(clashConvo, k) === 'wc_old' && clashConvo.panel[k] === '90/100') &&
      clashConvo.panelFields.some((k) => mod.panelFieldOwner(clashConvo, k) === 'wc_new' && clashConvo.panel[k] === '50/100'),
    JSON.stringify(clashConvo.panel)
  );
});

// ---------------------------------------------------------------------------
//  场景 29：选卡当自己时，玩家设定里的 {{char}}/{{user}} 宏要替换成玩家本人。
//  修复：拼设定时不带 scenario、宏替换成角色名；注入层 playerProfileForPrompt 兜底替换。
// ---------------------------------------------------------------------------
await scenario('选卡当自己：玩家设定的宏替换成本人', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.playerProfileForPrompt !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }
  check('cast 模块能动态加载', true);

  // 老会话 / 手写的 profile：还带着字面的 {{char}}、{{user}}、<BOT>、<USER>
  const convo = {
    player: {
      name: '露西娅',
      profile:
        '{{char}}，十八岁的魅魔混血姑娘。被{{user}}善意对待时第一反应是慌。' +
        '开场背景：{{char}}端着托盘摔倒，<USER>这个外乡人坐在邻桌。'
    }
  };

  const out = mod.playerProfileForPrompt(convo);

  check(
    '{{char}} 被替换成玩家本人（露西娅）',
    !out.includes('{{char}}') && !out.includes('{{CHAR}}') && out.includes('露西娅，十八岁'),
    out
  );
  check(
    '{{user}} 被替换成玩家本人',
    !out.includes('{{user}}') && !out.includes('{{USER}}') && out.includes('被露西娅善意对待'),
    out
  );
  check(
    '<USER> 也被替换',
    !out.includes('<USER>') && !out.includes('<user>'),
    out
  );
  check(
    '最终文本不再含任何裸宏占位符',
    !/\{\{(char|user)\}\}/i.test(out) && !/<(BOT|USER)>/i.test(out),
    out
  );

  // 没写设定 / 没有玩家角色时返回空串，不该崩
  check('没有 player 时返回空串', mod.playerProfileForPrompt({}) === '', String(mod.playerProfileForPrompt({})));
  check('有 player 但没 profile 时返回空串', mod.playerProfileForPrompt({ player: { name: '甲' } }) === '');
});

// ---------------------------------------------------------------------------
//  场景 30：世界书的 NPC 名单不该把玩家本人（同名副本）当成 NPC。
//  修复：worldbookCast 把同名副本标成「玩家本人」，判定逻辑抽成纯函数 isPlayerCharacterCopy。
// ---------------------------------------------------------------------------
await scenario('世界书：同名副本不把玩家当 NPC', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.isPlayerCharacterCopy !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }
  check('cast 模块能动态加载', true);

  const convo = {
    worldbookIds: ['bk1'],
    player: { name: '姐姐', profile: '', characterId: null },
    gmMode: true
  };

  // 与玩家同名的副本 = 玩家本人
  check(
    '与玩家同名的副本被判为玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_self', name: '姐姐' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_self', name: '姐姐' }))
  );
  // 不同名的副本 = 真 NPC
  check(
    '不同名的副本被判为 NPC（不是玩家）',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_npc', name: '妹妹' }) === false,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_npc', name: '妹妹' }))
  );
  // 前后有空格也能识别（trim 后比较）
  check(
    '副本名字前后带空格也能识别',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_sp', name: ' 姐姐 ' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_sp', name: ' 姐姐 ' }))
  );
  // 空 convo / 空角色不崩
  check('空 convo 返回 false', mod.isPlayerCharacterCopy(null, { name: '姐姐' }) === false);
  check('空角色返回 false', mod.isPlayerCharacterCopy(convo, null) === false);
});

// ---------------------------------------------------------------------------
//  场景 31：玩家不同名时，书里同名检测不误判
//
//  边界：玩家起的名字和书里角色都不一样时，书里角色全部是 NPC（不该误删）。
//  另一个边界：玩家没有角色卡（名字来自设置里的默认名）时也能识别。
// ---------------------------------------------------------------------------
await scenario('世界书：玩家不同名不误判', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.isPlayerCharacterCopy !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }

  const convo = {
    worldbookIds: ['bk2'],
    player: { name: '旅行者', profile: '', characterId: null },
    gmMode: true
  };

  check(
    '玩家名不同时，同名副本（妹妹）不当玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_a', name: '妹妹' }) === false,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_a', name: '妹妹' }))
  );
  check(
    '玩家名匹配时（旅行者）才算玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_me', name: '旅行者' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_me', name: '旅行者' }))
  );
});

// ---------------------------------------------------------------------------
//  场景 32：状态字段分「每轮维护 / 变了才说」。static 给几乎不变的设定，
//  dynamic 给随剧情变的状态；措辞是「一旦变化就必须输出」。
// ---------------------------------------------------------------------------
await scenario('面板：静态字段「变了才说」，动态字段每轮维护', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.appendPanelFields !== 'function') {
    check('panel 模块能动态加载', false);
    return;
  }
  check('panel 模块能动态加载', true);

  // 造一个会话：铜板（动态）+ 生日（静态，几乎不变）
  const convo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(convo, [
    { name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' },
    { name: '生日', type: 'text', value: '3月15日', mode: 'static' }
  ]);

  // 1) mode 落进了 panelDefs（静态字段才记 mode，动态字段不记，保持数据干净）
  check(
    '静态字段的 mode 记进 panelDefs',
    mod.convoPanelDef(convo, '生日') && mod.convoPanelDef(convo, '生日').mode === 'static',
    JSON.stringify(convo.panelDefs)
  );
  check(
    '动态字段不写 mode（默认值不落盘）',
    !mod.convoPanelDef(convo, '铜板') || mod.convoPanelDef(convo, '铜板').mode === undefined,
    JSON.stringify(convo.panelDefs && convo.panelDefs['铜板'])
  );

  // 2) 注入提示词：动态字段的规则说「每轮完整输出」；静态字段说「变了就必须说」
  const prompt = mod.formatPanelForPrompt(convo);
  check('注入里有「完整输出一遍」的动态字段规则', prompt.includes('完整输出一遍'), prompt);
  // ⚠️ 静态字段有两处措辞，按分支不同：
  //    · 已有值的主分支：'只要剧情里发生了变化（换了、脱了、被拿走…），就必须在状态栏里输出那行新值'
  //    · 冷启动分支（一个值都还没有）：'一旦发生变化就必须输出（没变化才省略）'
  //    两条都表达了同一个意思，这里掐「必须…输出」这个核心承诺。
  check(
    '注入里点名静态字段「变化了就必须输出」',
    /必须[^。\n]{0,20}输出/.test(prompt) && prompt.includes('发生了变化'),
    prompt
  );
  // 老措辞「只在变化时输出」会把判断交给模型（自判「没变」就省掉整行），
  // 现在必须出现「判断标准」，把门槛挪到「这一轮有没有发生相关的事」。
  check(
    '静态字段的措辞把门槛挪到「有没有发生」，而不是「变没变」',
    prompt.includes('判断标准'),
    prompt
  );
  check('静态字段值仍在注入里（当前值要给模型看）', prompt.includes('3月15日'), prompt);
  check('动态字段值仍在注入里', prompt.includes('3/100'), prompt);

  // 2b) 冷启动分支（一个值都还没有）也必须带上静态字段的说法
  const coldStart = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(coldStart, [
    { name: '铜板', type: 'meter', min: 0, max: 100, value: '' },
    { name: '生日', type: 'text', value: '', mode: 'static' }
  ]);
  const coldPrompt = mod.formatPanelForPrompt(coldStart);
  check('冷启动分支里静态字段也提示「一旦发生变化就必须输出」', coldPrompt.includes('一旦发生变化就必须输出'), coldPrompt);

  // 3) 全静态字段的会话：不该出现「每轮完整输出」的动态规则（没有动态字段）
  const allStatic = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(allStatic, [
    { name: '生日', type: 'text', value: '3月15日', mode: 'static' },
    { name: '血型', type: 'text', value: 'O型', mode: 'static' }
  ]);
  const staticPrompt = mod.formatPanelForPrompt(allStatic);
  check(
    '全静态字段时不注入「每轮完整输出」的动态规则',
    !staticPrompt.includes('完整输出一遍'),
    staticPrompt
  );

  // 4) 老数据（无 mode）一律按动态处理：注入仍要求每轮维护
  const legacy = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(legacy, [{ name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' }]);
  const legacyPrompt = mod.formatPanelForPrompt(legacy);
  check('老数据（无 mode）仍按动态字段每轮维护', legacyPrompt.includes('完整输出一遍'), legacyPrompt);
});

// ---------------------------------------------------------------------------
//  场景：推理模型只吐思考、正文被截断 → 给出明确提示而不是空气泡
//
//  用户反馈：有时会思考，但是不返回内容。根因是推理模型（deepseek-reasoner 等）
//  可能把 max_tokens 全花在 reasoning_content 上，正文还没开始就被截断 ——
//  界面上留下一个「只有思考过程、没有正文」的气泡。修成：content 为空但 reasoning
//  非空时，把正文替换成一句提示，告诉用户发生了什么、怎么补救。
// ---------------------------------------------------------------------------
await scenario('聊天：只思考不回答时给出提示', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '只思考不回答');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束', () => byId('btn-send').disabled === false, 8000);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文不该是空白 —— 应该被替换成「截断」提示
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文有「截断」提示，而不是空着', contentText.includes('截断'), contentText.slice(0, 60));

  // 思考过程仍保留、可展开
  const reasoningNode = assistant ? assistant.querySelector('.reasoning') : null;
  check('思考过程还在（可展开）', !!reasoningNode, reasoningNode ? '有' : '无');

  // 思考量标在折叠标题上（两次尝试各 5，累加 = 10）—— 「思考花了多少」是判断
  // 「是不是它在吃额度」最直接的一个数，光放在状态栏里太容易错过
  const summaryText = reasoningNode ? reasoningNode.querySelector('summary').textContent : '';
  check('思考标题标出了 token 数', summaryText.includes('10 tokens'), summaryText);

  // 不该出现错误气泡（这条不算错误，是正常回复 + 提示）
  check('没有错误气泡', $$('#messages .msg.error').length === 0);

  // 流式正常结束，没卡住
  check('发送按钮恢复可用', byId('btn-send').disabled === false);
});

// ---------------------------------------------------------------------------
//  场景：正文写了一半撞上限（finish_reason='length'）→ 自动接着写完
//
//  用户反馈：一轮里回复有时长有时短，还有一次状态栏写到一半就没了。
//  根因：撞到回复上限被截断，但界面上没有任何标记 —— 看不出这条是残缺的。
//  修成：服务商的 finish_reason='length' 记在这条消息上；有正文时自动接着写
//  （设置里可关），续写接在同一条气泡里，写完挂一行轻说明。
// ---------------------------------------------------------------------------
await scenario('聊天：正文被截断时自动接着写完', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '截断正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  // 自动续写会再发一次请求，得等它彻底停下来
  await waitFor('流式状态结束（含自动续写）', () => byId('btn-send').disabled === false, 8000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文照常显示（半截也是真正文，绝不能被替换成提示文字）
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文照常显示', contentText.includes('冒烟测试回复'), contentText.slice(0, 40));

  // 关键：自动续写的后半段被接了上来 —— 而且是同一条气泡，不是新消息
  check('自动续写接回了后半段', contentText.includes('自动接着写完的后半段'), contentText.slice(0, 80));
  check(
    '续写没有多出消息（还是同一条气泡）',
    $$('#messages .msg').length === beforeMsgs + 2,
    `期望 ${beforeMsgs + 2}，实际 ${$$('#messages .msg').length}`
  );

  // 救回来之后是「轻说明」口径：指出中间断过，但不催着点「继续」
  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check('挂了「撞过上限」说明', !!note, note ? note.textContent : '无');
  check(
    '说明是「已自动接着写完」的口径',
    note ? note.textContent.includes('自动接着写完') : false,
    note ? note.textContent : '无'
  );

  // 思考 token 要标出来（usage.reasoning_tokens 由主进程归一后带上来）
  const usageText = byId('usage-text').textContent;
  check('用量行标出了思考 token', usageText.includes('其中思考 6'), usageText);

  check('没有错误气泡', $$('#messages .msg.error').length === 0);
  check('发送按钮恢复可用', byId('btn-send').disabled === false);
});

// ---------------------------------------------------------------------------
//  场景：续写也撞上限 → 只续有限次就停下，剩下的交给用户
//
//  自动续写最怕变成无底洞（每续一次都要再花一次钱）。这里让续写请求也返回
//  'length'，验证它到上限就停手，并把「还能点继续 / 调大上限」说明白。
// ---------------------------------------------------------------------------
await scenario('聊天：截断续到上限后停下并提示', async () => {
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '截断到底');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束（含两次自动续写）', () => byId('btn-send').disabled === false, 10000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('续写的字也接上了', contentText.includes('又挤出来一点'), contentText.slice(0, 80));

  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check('仍然挂着「被截断」说明', !!note, note ? note.textContent : '无');
  check(
    '说明里写明续了 2 次仍没写完',
    note ? note.textContent.includes('自动接着写了 2 次') : false,
    note ? note.textContent : '无'
  );
  check(
    '说明里指出还能点「继续」',
    note ? note.textContent.includes('继续') : false,
    note ? note.textContent : '无'
  );
});

// ---------------------------------------------------------------------------
//  场景：关掉「截断后自动续写」→ 只挂说明，不自己花钱接着写
// ---------------------------------------------------------------------------
await scenario('设置：关掉自动续写后不再自己续', async () => {
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  click('#s-autocontinue');
  await sleep(150);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#settings-modal'));

  const saved = (await window.mimitale.getSettings()).settings;
  check('关掉之后落盘也是关的', saved.autoContinue === false, String(saved.autoContinue));

  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', '截断正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束', () => byId('btn-send').disabled === false, 8000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('没有自动续写（正文停在半截）', !contentText.includes('自动接着写完的后半段'), contentText.slice(0, 80));

  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check(
    '挂了「点继续」的说明',
    note ? note.textContent.includes('点「继续」') : false,
    note ? note.textContent : '无'
  );

  // 改回来，免得影响后面的场景
  click('#btn-settings');
  await waitFor('设置弹窗重新打开', () => shown('#settings-modal'));
  click('#s-autocontinue');
  await sleep(150);
  click('#btn-save-settings');
  await waitFor('设置再次关闭', () => !shown('#settings-modal'));
});

// ---------------------------------------------------------------------------
//  场景：思考挤掉正文 → 自动重试一次，直接把正文救回来（用户无感）
//
//  上一个场景验证「重试也失败 → 兜底提示」，这个验证主路径：第一次只返回
//  思考，应用自动带着引导语重发一次，模型正常写出正文 —— 界面上不该出现
//  「截断」字样，第一次的思考过程也该保留。
// ---------------------------------------------------------------------------
await scenario('聊天：思考挤掉正文时自动重试救回', async () => {
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '思考挤掉正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束（含自动重试）', () => byId('btn-send').disabled === false, 8000);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文应该是重试拿回来的真回复，而不是截断提示
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文是自动重试拿回来的真回复', contentText.includes('冒烟测试回复'), contentText.slice(0, 60));
  check('没有「截断」提示', !contentText.includes('截断'), contentText.slice(0, 60));

  // 第一次的思考过程仍保留、可展开
  const reasoningNode = assistant ? assistant.querySelector('.reasoning') : null;
  check('第一次的思考过程还在（可展开）', !!reasoningNode, reasoningNode ? '有' : '无');

  // 思考量要跨请求累加（第一次 5 + 重试 12 = 17）：只看最后一次会漏掉
  // 「正是第一次的长思考把额度吃光」这个关键事实
  const summaryText = reasoningNode ? reasoningNode.querySelector('summary').textContent : '';
  check('思考量跨请求累加后标在标题上', summaryText.includes('17 tokens'), summaryText);

  // 没有错误气泡，也没多出一条消息（重写的是同一条，不是新气泡）
  check('没有错误气泡', $$('#messages .msg.error').length === 0);
  check('没有多出额外的消息', $$('#messages .msg').length === beforeMsgs + 2);
});

// ---------------------------------------------------------------------------
//  场景 33：剧情选项同步只认「最新一轮」，不回退到历史里的旧选项
//
//  用户反馈：玩世界书时剧情选项「每次第一个都是之前的，要换一批才跟着新剧情」，
//  以及「一会有一会没有，好奇怪」。根因是模型不是每轮都稳定输出选项行。两轮修复：
//    1) 从历史里往回找 → 命中几轮前旧选项（严重过时）；
//    2) 只看最新一条、没给就清空 → 选项凭空消失（时有时无闪烁）。
//  最终语义：只看最新一条 assistant，给了用新的；没给则**保留上一批**（紧邻、
//  基本贴合当前局面），不清空也不回退几轮前。这里用纯函数直测 syncConvoOptions。
// ---------------------------------------------------------------------------
await scenario('选项：同步只认最新一轮，不回退旧选项', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.syncConvoOptions !== 'function') {
    check('suggestions 模块能动态加载', false);
    return;
  }
  check('suggestions 模块能动态加载', true);

  // 1) 最新一条 assistant 给了选项 → 用新的
  const withOpts = {
    optionsSpec: { count: 3, hint: '' },
    options: [],
    messages: [
      { role: 'assistant', content: '【剧情选项】：老选项甲 / 老选项乙 / 老选项丙' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '正文……\n【剧情选项】：新选项一 / 新选项二 / 新选项三' }
    ]
  };
  mod.syncConvoOptions(withOpts);
  check(
    '最新一条给了选项就用新的',
    JSON.stringify(withOpts.options) === JSON.stringify(['新选项一', '新选项二', '新选项三']),
    JSON.stringify(withOpts.options)
  );

  // 2) 最新一条 assistant 没给选项 → 保留上一批（紧邻的），而不是清空、也不是
  //    回退到历史里几轮前的旧选项。选项应该常驻，不能「一会有一会没有」。
  const noOpts = {
    optionsSpec: { count: 3, hint: '' },
    options: ['残留的旧选项'],
    messages: [
      { role: 'assistant', content: '【剧情选项】：几轮前的旧选项A / 旧选项B / 旧选项C' },
      { role: 'user', content: '继续推进' },
      { role: 'assistant', content: '这一段只有正文，没写剧情选项行。' }
    ]
  };
  const changed = mod.syncConvoOptions(noOpts);
  check(
    '最新一条没给选项时保留上一批（选项常驻不断档）',
    JSON.stringify(noOpts.options) === JSON.stringify(['残留的旧选项']),
    JSON.stringify(noOpts.options)
  );
  check('保留动作被检测到（返回无变化）', changed === false, String(changed));

  // 3) 没开剧情选项 → 直接清空
  const noSpec = {
    optionsSpec: null,
    options: ['残留'],
    messages: [{ role: 'assistant', content: '【剧情选项】：甲 / 乙 / 丙' }]
  };
  mod.syncConvoOptions(noSpec);
  check('没开剧情选项时直接清空', Array.isArray(noSpec.options) && noSpec.options.length === 0, JSON.stringify(noSpec.options));

  // 4) 最后一条不是 assistant（边界，比如空历史）→ 清空、不崩
  const empty = { optionsSpec: { count: 3, hint: '' }, options: ['残留'], messages: [] };
  mod.syncConvoOptions(empty);
  check('空历史不崩且清空', Array.isArray(empty.options) && empty.options.length === 0, JSON.stringify(empty.options));

  // 5) 最后一条是用户消息（玩家刚发话、AI 还没回）→ 也没有可依附的剧情，清空
  const endsWithUser = {
    optionsSpec: { count: 3, hint: '' },
    options: ['残留'],
    messages: [
      { role: 'assistant', content: '【剧情选项】：甲 / 乙 / 丙' },
      { role: 'user', content: '我接着往下走。' }
    ]
  };
  mod.syncConvoOptions(endsWithUser);
  check(
    '最后一条是用户消息时清空',
    Array.isArray(endsWithUser.options) && endsWithUser.options.length === 0,
    JSON.stringify(endsWithUser.options)
  );
});

// ---------------------------------------------------------------------------
//  场景 33：世界书副本的「在状态栏显示」开关（showInPanel）。
//  副本有 description 照旧进 GM 名单（不受开关影响）；showInPanel（默认 false）
//  控制状态是否进「当前状态」入口条。单角色聊天绑的卡不受此开关管（TA 就是主角）。
// ---------------------------------------------------------------------------
await scenario('世界书：副本的「在状态栏显示」开关', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载（场景33）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.panelEntities !== 'function') {
    check('cast 模块能动态加载（场景33）', false);
    return;
  }
  check('cast 模块能动态加载（场景33）', true);

  const key = (name, owner) => `${name}\u0000${owner}`;
  // 造一个「进了世界」的会话：player 有字段，另有两个副本各有一个字段
  const mkConvo = () => ({
    gmMode: true,
    characterId: null,
    player: { name: '我', profile: '', characterId: null },
    worldbookIds: ['bk1'],
    panel: {
      [key('姓名', 'player')]: '我',
      [key('生命', 'wc_show')]: '80/100',
      [key('生命', 'wc_hide')]: '50/100'
    },
    panelFields: [key('姓名', 'player'), key('生命', 'wc_show'), key('生命', 'wc_hide')],
    panelDefs: {
      [key('姓名', 'player')]: { type: 'text', owner: 'player' },
      [key('生命', 'wc_show')]: { type: 'meter', min: 0, max: 100, owner: 'wc_show' },
      [key('生命', 'wc_hide')]: { type: 'meter', min: 0, max: 100, owner: 'wc_hide' }
    },
    messages: []
  });

  // 把两张副本塞进「本会话绑定的世界书」，一个勾了一个没勾。
  // 直接改真模块读的那份 state —— 和页面共用同一个模块实例。
  let lib = null;
  try {
    lib = await import(new URL('js/data/library.js', document.baseURI).href);
  } catch (err) {
    check('library 模块能动态加载（场景33）', false, (err && err.message) || String(err));
  }
  if (!lib || typeof lib.worldbooks !== 'function') return;
  check('library 模块能动态加载（场景33）', true);

  const wbList = lib.worldbooks();
  const saved = wbList.slice();
  wbList.push({
    id: 'bk1',
    name: '开关测试世界',
    entries: [],
    characters: [
      { id: 'wc_show', name: '要显示的NPC', showInPanel: true, attributes: [{ name: '生命', value: '80/100' }] },
      { id: 'wc_hide', name: '不显示的NPC', attributes: [{ name: '生命', value: '50/100' }] }
    ]
  });

  try {
    const owners = mod.panelEntities(mkConvo()).map((e) => e.owner);
    check('勾了的副本出现在入口条上', owners.includes('wc_show'), JSON.stringify(owners));
    check('没勾的副本不出现在入口条上', !owners.includes('wc_hide'), JSON.stringify(owners));
    check('「我」永远在第一个', owners[0] === 'player', JSON.stringify(owners));

    // 关键边界：单角色聊天绑的那张卡**不看开关**（TA 就是这局主角）。
    // 「wc_hide」在世界书里是 showInPanel:false，但当它成为会话的绑定卡时，
    // 依然必须出头像 —— 用户反馈里「状态栏不显示角色卡状态」就是这条被破坏了。
    const soloHide = {
      gmMode: false,
      characterId: 'wc_hide',
      player: null,
      worldbookIds: ['bk1'],
      panel: { [key('金币', 'wc_hide')]: '100' },
      panelFields: [key('金币', 'wc_hide')],
      panelDefs: { [key('金币', 'wc_hide')]: { type: 'text', owner: 'wc_hide' } },
      messages: []
    };
    const so = mod.panelEntities(soloHide).map((e) => e.owner);
    check(
      '单角色会话绑的副本即使没勾开关也显示（TA 是这局主角）',
      so.includes('wc_hide'),
      JSON.stringify(so)
    );

    // 角色库的卡（没有 showInPanel 字段）当单卡主角 → 同样豁免
    const libChars = lib.characters ? lib.characters() : [];
    if (libChars.length) {
      const c = libChars[0];
      const soloLib = {
        gmMode: false,
        characterId: c.id,
        player: null,
        worldbookIds: [],
        panel: { [key('金币', c.id)]: '7' },
        panelFields: [key('金币', c.id)],
        panelDefs: { [key('金币', c.id)]: { type: 'text', owner: c.id } },
        messages: []
      };
      const so2 = mod.panelEntities(soloLib).map((e) => e.owner);
      check('角色库的卡当单卡主角也显示（豁免开关）', so2.includes(c.id), JSON.stringify(so2));
    }
  } finally {
    // 还原世界书列表，别污染后面的场景
    wbList.length = 0;
    wbList.push(...saved);
  }
});

// ---------------------------------------------------------------------------
//  场景 33b：把「世界书同名副本」名下的字段并回「我」（mergePlayerOwnedFields）。
//
//  玩家挑一张卡当自己（convo.player.name = 卡名），而这本书里正好有个**同名副本**
//  也在显示状态 —— 同一个人会占两张状态卡、属性存两份，注入时还被拆成
//  「角色名·字段名」前缀。合并只认名字，把副本那份并到 'player' 名下。
// ---------------------------------------------------------------------------
await scenario('面板：世界书同名副本的字段并回「我」', async () => {
  let mod = null;
  try {
    mod = await import(new URL('js/data/panel.js', document.baseURI).href);
  } catch (err) {
    check('panel 模块能动态加载（场景33b）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.mergePlayerOwnedFields !== 'function') {
    check('mergePlayerOwnedFields 可用（场景33b）', false);
    return;
  }
  check('mergePlayerOwnedFields 可用（场景33b）', true);

  const lib = await import(new URL('js/data/library.js', document.baseURI).href);
  const wbList = lib.worldbooks();
  const saved = wbList.slice();
  wbList.push({
    id: 'bk_merge',
    name: '同名副本测试',
    entries: [],
    characters: [
      { id: 'wc_dup', name: '同名人', showInPanel: true, attributes: [{ name: '好感度', value: '30' }] },
      { id: 'wc_other', name: '别人', showInPanel: true, attributes: [{ name: '好感度', value: '10' }] }
    ]
  });
  const key = (name, owner) => `${name}\u0000${owner}`;

  try {
    // 1) 副本有、玩家没有的同名字段 → 整条搬给玩家
    const c1 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100', [key('好感度', 'wc_other')]: '10/100' },
      panelFields: [key('好感度', 'wc_dup'), key('好感度', 'wc_other')],
      panelDefs: {
        [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' },
        [key('好感度', 'wc_other')]: { type: 'meter', max: 100, owner: 'wc_other' }
      },
      messages: []
    };
    mod.mergePlayerOwnedFields(c1);
    check(
      '同名副本的字段搬到了「我」名下',
      c1.panelFields.includes(key('好感度', 'player')) && !c1.panelFields.includes(key('好感度', 'wc_dup')),
      JSON.stringify(c1.panelFields)
    );
    check(
      '搬过去的定义 owner 也改成 player',
      c1.panelDefs[key('好感度', 'player')] && c1.panelDefs[key('好感度', 'player')].owner === 'player',
      JSON.stringify(c1.panelDefs[key('好感度', 'player')])
    );
    check(
      '不同名的角色不动',
      c1.panelFields.includes(key('好感度', 'wc_other')),
      JSON.stringify(c1.panelFields)
    );

    // 2) 两边都有同名字段 → 保留玩家那份值，副本键删掉
    const c2 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'player')]: '88/100', [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'player'), key('好感度', 'wc_dup')],
      panelDefs: {
        [key('好感度', 'player')]: { type: 'meter', max: 100, owner: 'player' },
        [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' }
      },
      messages: []
    };
    mod.mergePlayerOwnedFields(c2);
    check(
      '同名字段保留玩家那份值',
      c2.panel[key('好感度', 'player')] === '88/100' && !c2.panelFields.includes(key('好感度', 'wc_dup')),
      `${c2.panel[key('好感度', 'player')]} / ${JSON.stringify(c2.panelFields)}`
    );

    // 3) 手改标记跟着键一起搬
    const c3 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      panelManual: { [key('好感度', 'wc_dup')]: true },
      messages: []
    };
    mod.mergePlayerOwnedFields(c3);
    check(
      '手改标记跟着搬到玩家键',
      c3.panelManual[key('好感度', 'player')] === true && !c3.panelManual[key('好感度', 'wc_dup')],
      JSON.stringify(c3.panelManual)
    );

    // 4) 幂等：再调一次什么都不动
    const before = JSON.stringify([c1.panelFields, c1.panel]);
    mod.mergePlayerOwnedFields(c1);
    check('合并是幂等的', JSON.stringify([c1.panelFields, c1.panel]) === before, '二次调用改了数据');

    // 5) 名字对不上的副本不动（没撞名就不该合并）
    const c4 = {
      player: { name: '别人不知道我是谁', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      messages: []
    };
    mod.mergePlayerOwnedFields(c4);
    check(
      '名字对不上时保持不变',
      c4.panelFields.length === 1 && c4.panelFields[0] === key('好感度', 'wc_dup'),
      JSON.stringify(c4.panelFields)
    );

    // 6) 「我」那张卡要能找到卡对象（挑世界书副本当自己时，player.characterId 是空的，
    //    得按名字把同名副本找回来）—— 否则状态卡没立绘、没表情图。
    const castMod = await import(new URL('js/data/cast.js', document.baseURI).href);
    const withFields = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      messages: []
    };
    const meEnt = castMod.panelEntities(withFields).find((e) => e.owner === 'player');
    check(
      '挑同名副本当自己时，「我」能找到那张卡',
      !!meEnt && !!meEnt.card && meEnt.card.id === 'wc_dup',
      JSON.stringify(meEnt && meEnt.card && meEnt.card.id)
    );
    const foreign = { ...withFields, player: { name: '跟谁都不重名', profile: '', characterId: null } };
    const meEnt2 = castMod.panelEntities(foreign).find((e) => e.owner === 'player');
    check(
      '名字对不上时不硬塞一张卡给「我」',
      !!meEnt2 && !meEnt2.card,
      JSON.stringify(meEnt2 && meEnt2.card)
    );
  } finally {
    wbList.length = 0;
    wbList.push(...saved);
  }
});

// ---------------------------------------------------------------------------
//  场景 34：「同步属性」把角色库同名卡的属性补进世界书副本（副本是快照，
//  角色库后来补的属性不会回流）。钉住 syncCopyAttrsFromSource 四条语义：
//  按名字补属性、已有字段不覆盖、源卡没有的进 missing、补进去是深拷贝。
// ---------------------------------------------------------------------------
await scenario('世界书：同步属性把角色库的属性补进副本', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载（场景34）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.syncCopyAttrsFromSource !== 'function') {
    check('panel 模块能动态加载（场景34）', false);
    return;
  }
  check('panel 模块能动态加载（场景34）', true);

  // 角色库：露西娅有 2 个属性；「路人甲」在角色库里没有同名卡
  const sources = [
    {
      id: 'lib_lucy',
      name: '露西娅',
      attributes: [
        { name: '生命', type: 'meter', min: 0, max: 100, value: '100/100', group: '生存' },
        { name: '心情', type: 'text', value: '闯祸了的慌', group: '状态栏' }
      ]
    }
  ];

  const copies = [
    // 空壳副本 —— 该被补满
    { id: 'wc_a', name: '露西娅', attributes: [] },
    // 副本上已经有「生命」（这本书的当前值）→ 只补缺的「心情」，不覆盖生命
    { id: 'wc_b', name: '露西娅', attributes: [{ name: '生命', value: '42/100' }] },
    // 角色库里没有同名卡 → 进 missing，一动不动
    { id: 'wc_c', name: '路人甲', attributes: [] }
  ];

  const res = mod.syncCopyAttrsFromSource(copies, sources);

  check('补了 2 个副本（有同名卡且缺属性）', res.touched === 2, JSON.stringify(res));
  check('一共补上 3 条属性（2 + 1）', res.added === 3, JSON.stringify(res));
  check('角色库里没同名卡的副本进 missing', res.missing.length === 1 && res.missing[0] === '路人甲', JSON.stringify(res.missing));

  check('空壳副本被补满 2 个属性', copies[0].attributes.length === 2, JSON.stringify(copies[0].attributes));
  check(
    '副本已有的「生命」不被角色库的初始值覆盖',
    copies[1].attributes.length === 2 &&
      copies[1].attributes.find((a) => a.name === '生命').value === '42/100' &&
      copies[1].attributes.some((a) => a.name === '心情'),
    JSON.stringify(copies[1].attributes)
  );
  check('没同名卡的副本完全没被碰', copies[2].attributes.length === 0, JSON.stringify(copies[2].attributes));

  // 深拷贝：改副本上的属性值，不该影响角色库那张卡
  copies[0].attributes[0].value = '改了副本';
  check(
    '补进去的是深拷贝（改副本不回流角色库）',
    sources[0].attributes[0].value === '100/100',
    sources[0].attributes[0].value
  );

  // 幂等：再同步一次，已经没有可补的了
  const again = mod.syncCopyAttrsFromSource(copies, sources);
  check('再同步一次没什么可补的（幂等）', again.touched === 0 && again.added === 0, JSON.stringify(again));
});

// ---------------------------------------------------------------------------
//  场景：Markdown 渲染的边界
//
//  markdown.js 自己写着「不依赖任何别的东西，可以单独拿去测」—— 这里就单独测它。
//  下面六条都是「以前渲染错、用户一眼看得见」的：
//    嵌套强调匹配不上、`a * 2 * b` 被判成斜体、链接文字里的行内代码不还原、
//    表格完全不认（竖线原样显示）、`![](url)` 多出一个孤零零的 `!`、
//    自动链接把句尾的中文标点吞进 href。
// ---------------------------------------------------------------------------
await scenario('Markdown：渲染边界', async () => {
  const md = await import(new URL('js/ui/markdown.js', document.baseURI).href);
  const inline = (s) => md.renderInline(s);

  // 行内规则不认 `*` 的嵌套是踩过的坑：外层 ** 会原样露出来
  check(
    '加粗里面套斜体（**a *b* c**）两边都生效',
    inline('**这句话的 *重点* 部分**') === '<strong>这句话的 <em>重点</em> 部分</strong>',
    inline('**这句话的 *重点* 部分**')
  );
  check('普通加粗没受影响', inline('**加粗**') === '<strong>加粗</strong>', inline('**加粗**'));
  check('普通斜体没受影响', inline('*斜体*') === '<em>斜体</em>', inline('*斜体*'));

  // 数值公式里的孤立星号不能被当成强调
  check(
    '「伤害 = 攻击 * 2 * 倍率」不会被当成斜体',
    !inline('伤害 = 攻击 * 2 * 倍率').includes('<em>'),
    inline('伤害 = 攻击 * 2 * 倍率')
  );
  check('「2 * 3 * 4」也不会', !inline('2 * 3 * 4').includes('<em>'), inline('2 * 3 * 4'));

  // 链接文字里的行内代码：以前占位符不还原，会显示成字面的 \u0000C0\u0000
  const linkCode = inline('[`code`](https://example.com)');
  check(
    '链接文字里的行内代码能正常渲染',
    linkCode.includes('<code>code</code>') && linkCode.includes('href="https://example.com"'),
    linkCode
  );
  check('没有占位符漏出来', !linkCode.includes('\u0000'), JSON.stringify(linkCode));

  // 图片：外链图片受 CSP 限制加载不出来，退化成链接；不能留一个孤立的 `!`
  const img = inline('![图](https://example.com/y.png)');
  check('外链图片退化成链接，不留孤立的「!」', !img.startsWith('!') && img.includes('<a href='), img);

  // 自动链接别把句尾的中文标点吞进 href
  const auto = inline('见 https://example.com/x。');
  check(
    '自动链接不吞句尾的中文句号',
    auto.includes('href="https://example.com/x"') && auto.includes('。'),
    auto
  );

  // --- 块级：表格 ---
  const block = (s) => md.renderMarkdown(s);
  const table = block(['| 角色 | 好感 |', '| --- | --- |', '| 露西娅 | 41 |'].join('\n'));
  check('表格生成了 <table>', table.includes('<table>') && table.includes('</table>'), table.slice(0, 120));
  check('表头进了 <th>', table.includes('<th>角色</th>') && table.includes('<th>好感</th>'), table.slice(0, 160));
  check('数据行进 <td> 且没有残留竖线', table.includes('<td>露西娅</td>') && !table.includes('|'), table.slice(0, 200));
  check('分隔行 |---| 不会被当成正文', !table.includes('---'), table.slice(0, 200));
  check('表格里的行内格式照样生效', block('| a |\n| --- |\n| **粗** |').includes('<td><strong>粗</strong></td>'));

  // 单独一行的 `---` 仍然该是分隔线（别被表格逻辑吃掉）
  check('单独的 --- 还是 <hr />', block('---').includes('<hr />'), block('---'));
});

// ---------------------------------------------------------------------------
//  场景：Esc 链 + 浮层清理 + 删掉当前世界书之后编辑器的去向
//
//  这几条都是「以前漏了」的坑，单独钉住：
//    · 世界书 / 记忆 / 视角三个弹窗**没接进入口层的全局 Esc 链** —— 只开着它们时
//      按 Esc 毫无反应，和别的弹窗行为不一致；
//    · 角色编辑器里那个「＋ 绑定」选书浮层挂在 document.body 上、z-index 还比
//      编辑器高，关编辑器时如果不一起收掉，它就悬在屏幕上（而且盖着编辑器，
//      用户连关闭按钮都点不到了）；
//    · 删掉「当前正在编辑」的那本世界书后，编辑器里的书名输入框还留着**刚删掉那本**
//      的名字。这时关弹窗 → stashWorldbookName() 会把残留名字写进列表里第一本书
//      → 别人的书被静默改名 + 覆盖开场白，而且立刻落盘。
// ---------------------------------------------------------------------------
await scenario('Esc 链与弹窗清理', async () => {
  // 世界书编辑器要从列表页点「编辑」进去（侧栏那个按钮只切页面）
  const openBookEditor = async () => {
    click('#btn-worldbooks');
    await waitFor('切到世界书页面', () => shown('#view-worldbooks'));
    click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
    await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  };

  // --- 三个以前漏掉的弹窗 ---
  await openBookEditor();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉世界书弹窗', () => !shown('#worldbooks-modal'));
  check('Esc 关得掉世界书弹窗', !shown('#worldbooks-modal'));

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉记忆弹窗', () => !shown('#memory-modal'));
  check('Esc 关得掉记忆弹窗', !shown('#memory-modal'));

  click('#btn-perspective');
  await waitFor('视角弹窗打开', () => shown('#perspective-modal'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉视角弹窗', () => !shown('#perspective-modal'));
  check('Esc 关得掉视角弹窗', !shown('#perspective-modal'));

  // --- 选书浮层：Esc 只关最上面那层，别顺手把编辑器也关了 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  const card = $$('#char-page-grid .char-card')[0];
  if (!card) {
    check('角色库里有一张卡可以做这个验证', false);
    return;
  }
  click(buttonByText(card, '编辑'));
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  click('#c-wb-add-btn');
  await waitFor('选书浮层出现', () => !!$('.cwb-picker'));
  check('「＋ 绑定」会弹出选书浮层', !!$('.cwb-picker'));

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉选书浮层', () => !$('.cwb-picker'));
  check('Esc 关的是最上面那层选书浮层', !$('.cwb-picker'));
  check('浮层下面的角色编辑器还开着（没被一起关掉）', shown('#chars-modal'));

  // --- 直接点 ✕ 关编辑器：残留的浮层也必须收掉 ---
  click('#c-wb-add-btn');
  await waitFor('选书浮层再次出现', () => !!$('.cwb-picker'));
  click('#btn-close-chars');
  await waitFor('角色编辑器关闭', () => !shown('#chars-modal'));
  check('关编辑器时残留的选书浮层被一起收掉（没悬空）', !$('.cwb-picker'));

  // --- 删掉当前正在编辑的那本世界书：编辑器必须真的切到另一本 ---
  const namesBefore = (await savedWorldbooks()).map((w) => w.name);
  await openBookEditor();

  click('#btn-new-worldbook'); // 新建一本，它会成为「当前编辑」的那本
  await waitFor('新建的世界书进编辑器', () => $('#wb-name').value === '新世界书', 3000);
  setValue('#wb-name', '待删的书');
  click('#btn-del-worldbook');
  await waitFor('删除前先确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await sleep(250);

  check(
    '删完当前这本之后，书名输入框切到了另一本（不是残留的「待删的书」）',
    $('#wb-name').value !== '待删的书',
    `输入框里是「${$('#wb-name').value}」`
  );

  // 关掉弹窗 —— 以前这一步会把残留的书名写进列表里第一本书
  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
  await sleep(250);

  const namesAfter = (await savedWorldbooks()).map((w) => w.name);
  check(
    '关弹窗没把残留书名写到别的书上（落盘的书名一本没变）',
    JSON.stringify(namesAfter) === JSON.stringify(namesBefore),
    `之前 ${JSON.stringify(namesBefore)} / 之后 ${JSON.stringify(namesAfter)}`
  );
  check('新建的那本确实删掉了（数量回到原样）', namesAfter.length === namesBefore.length, `${namesAfter.length} vs ${namesBefore.length}`);
});

// ---------------------------------------------------------------------------
//  场景：记忆弹窗 —— 「清空全部摘要」必须真的能清
//
//  这是一个**纯人肉才能发现**的 bug：函数写好了、`export` 着，按钮也在
//  HTML 里、`.disabled` 还跟着摘要条数切换 —— 就是没人写过 addEventListener。
//  按钮看着一切正常，点下去毫无反应，而 使用说明.md 里明明写着有这功能。
//  DOM 断言全绿也照不出来，所以这里**真的点它**，看确认框出不出来、摘要少没少。
//
//  自己造摘要（而不是等自动压缩）：模块是页面共享的同一个实例，
//  往当前会话塞两条摘要就行。断言部分一律走真实 DOM + 落盘桥。
// ---------------------------------------------------------------------------
await scenario('记忆：清空全部摘要', async () => {
  const mod = await import(new URL('js/core/state.js', document.baseURI).href);
  const convo = mod.state.conversations.find((c) => c.id === mod.state.activeId);
  if (!convo) {
    check('有活跃会话可以做这个验证', false, 'activeId 找不到对应会话');
    return;
  }
  check('有活跃会话可以做这个验证', true);

  // 造两条摘要：范围盖住前几条消息（end 用 messages 长度封顶）
  const total = Array.isArray(convo.messages) ? convo.messages.length : 0;
  const half = Math.max(1, Math.floor(total / 2));
  convo.summaries = [
    { id: 'smoke_s1', title: '第 1 段', start: 0, end: half, text: '冒烟测试造的摘要一', at: Date.now() },
    { id: 'smoke_s2', title: '第 2 段', start: half, end: total, text: '冒烟测试造的摘要二', at: Date.now() }
  ];

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));

  check('两条摘要都铺出来了', $$('#memory-list .memory-card').length === 2, String($$('#memory-list .memory-card').length));
  check('摘要行显示条数', $('#memory-summary-line').textContent.includes('2 段'), $('#memory-summary-line').textContent);
  check('有摘要时「清空」按钮可用', $('#btn-memory-clear').disabled === false);

  // --- 先取消一次：危险动作不该只点一下就打出去 ---
  click('#btn-memory-clear');
  await waitFor('清空前先确认', () => shown('#confirm-modal'));
  check('点「清空」会先弹确认框', shown('#confirm-modal'));
  check(
    '确认框说清了后果（原文会回到上下文）',
    $('#confirm-title').textContent.includes('清空') && $('#confirm-message').textContent.includes('token'),
    `${$('#confirm-title').textContent} / ${$('#confirm-message').textContent}`
  );

  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  await sleep(150);
  check('取消之后摘要一条没少', $$('#memory-list .memory-card').length === 2, String($$('#memory-list .memory-card').length));

  // --- 真清空 ---
  click('#btn-memory-clear');
  await waitFor('再次弹确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('摘要清空（列表变空）', () => $$('#memory-list .memory-card').length === 0);

  check('清空后列表空了', $$('#memory-list .memory-card').length === 0);
  check('清空后列表给了空态文案', $('#memory-list .memory-empty') !== null);
  check('清空后摘要行回到「还没有摘要」', $('#memory-summary-line').textContent.includes('还没有摘要'), $('#memory-summary-line').textContent);
  check('摘要清零后「清空」按钮变灰', $('#btn-memory-clear').disabled === true);
  check('「⋯」上的摘要角标收起来了', $('#memory-count').classList.contains('hidden'));
  check('提示条说了摘要已清空', $('#toast').textContent.includes('摘要已清空'), $('#toast').textContent);

  // 落盘才算真清掉（渲染层清内存、主进程写文件是异步的）。
  // 注意别把这个轮询塞进 waitFor —— waitFor 里 `if (ok) return ok`，
  // 回调返回 Promise 永远为真，会当场"通过"。
  let saved = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const cs = await window.mimitale.getConversations();
    const a = cs.conversations.find((c) => c.id === cs.activeId);
    if (a && Array.isArray(a.summaries) && a.summaries.length === 0) {
      saved = a;
      break;
    }
    await sleep(50);
  }
  check('清空真的落盘了（不是只清了界面）', !!saved, saved ? '' : '磁盘上还留着摘要');

  click('#btn-close-memory');
  await waitFor('记忆弹窗关闭', () => !shown('#memory-modal'));
});

// ---------------------------------------------------------------------------
//  场景：规则文案的段落边界
//
//  narration.js 的提示词是**拼接**出来的（【扮演规则】+ 节奏段 + 【标重点】…），
//  任何一段末尾漏掉 \n，两段就会粘成一行。2026-09-30 逮到过两处：
//  单角色拼出「…一律不要出现。【标重点】」，世界模式拼出
//  「…一律不要出现。不要提到自己是 AI、语言模型或助手。」。
//
//  这类问题**肉眼几乎看不出来** —— 都在字符串的接缝上，得 dump 出来才发现，
//  而模型读到的是一行挤在一起的指令。所以钉一条断言，以后改文案不会再漏。
// ---------------------------------------------------------------------------
await scenario('规则段：段落之间不粘连', async () => {
  let mod = null;
  try {
    mod = await import(new URL('js/data/narration.js', document.baseURI).href);
  } catch (err) {
    check('narration 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod) return;

  for (const pace of ['step', 'brisk']) {
    const solo = mod.roleplayRuleText('测试角色', '测试玩家', { paceMode: pace });
    check(
      `单角色(${pace})：节奏段后面换行再接【标重点】`,
      solo.includes('\n【标重点】') && !solo.includes('。【标重点】'),
      JSON.stringify(solo.slice(-70))
    );
    // 单角色模式下不能出现「NPC」，也不能点名角色自己（该用第二人称「你」）——
    // 前者会怂恿它凭空造人，后者和「第一人称扮演」的口径打架。
    check(`单角色(${pace})：不出现「NPC」`, !solo.includes('NPC'), JSON.stringify(solo.match(/.{10}NPC.{10}/g)));
    check(
      `单角色(${pace})：不出现「你替 TA」这种自我指涉`,
      !solo.includes('你替 TA'),
      JSON.stringify(solo.match(/.{10}你替.{10}/g))
    );

    const gm = mod.gmRuleText('测试角色', '测试玩家', { paceMode: pace });
    check(
      `世界(${pace})：节奏段后面换行再接「不要提到自己是 AI」`,
      gm.includes('\n不要提到自己是 AI') && !gm.includes('。不要提到'),
      JSON.stringify(gm.slice(-130))
    );
    check(
      `世界(${pace})：「不要提到自己是 AI」后面换行再接【标重点】`,
      gm.includes('\n【标重点】'),
      JSON.stringify(gm.slice(-70))
    );

    // 占位符防呆：替换链里漏了哪个 {xxx}，它会**原样发给模型**（提示词里冒出一行
    // "{standByMe}" 这种），而别的断言一条都不会响 —— 所以单独钉一条。
    for (const [label, text] of [['单角色', solo], ['世界', gm]]) {
      check(
        `${label}(${pace})：没有没替换掉的占位符`,
        !/\{[a-zA-Z]+\}/.test(text),
        JSON.stringify(text.match(/\{[a-zA-Z]+\}/g))
      );
    }
  }

  // 「标准」不再是空串了（2026-09-30 补了硬约束，和 hint「只写对话和动作」对齐），
  // 但它不能含占位符 —— 那说明有东西没被替换，会原样发给模型。
  const standard = mod.narrationInstruction({ narrationMode: 'standard' });
  check(
    '标准叙述模式有约束，且不含占位符',
    standard.trim().length > 0 && !/\{[a-zA-Z]+\}/.test(standard),
    JSON.stringify(standard)
  );

  // 【标重点】的定位：加粗 = **角色说出口的台词**（2026-10-08 改的）。
  // 加粗色默认跟随主题配色，台词上色才认得出谁在说话；这条规则要是退回
  // 「关键信息用加粗」，那个颜色就白设了。
  const soloRule = mod.roleplayRuleText('测试角色', '测试玩家', { paceMode: 'step' });
  check(
    '【标重点】要求把「说出口的台词」加粗',
    soloRule.includes('说出口的台词') && soloRule.includes('加粗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 90))
  );
  check(
    '【标重点】明确说「动作/神态/环境/心理不加粗」',
    soloRule.includes('不加粗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 200))
  );
  // 只写「一律用加粗」模型不会照做（2026-10-08 实测：真实回复里一个 ** 都没有）——
  // 规则里必须带正反例，跟「称呼铁律」一个套路。这条钉住例子别被删掉。
  check(
    '【标重点】带 ✔/✗ 正反例（光说「要加粗」模型不照做）',
    soloRule.includes('✔') && soloRule.includes('✗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 260))
  );

  // 普通聊天用的节奏段（paceInstruction）：它是**单独可注入**的，
  // 否则「推进节奏」在没绑卡的会话里就是个死设置。
  const plainPace = mod.paceInstruction({ paceMode: 'brisk' }, false);
  check(
    'paceInstruction 能单独给出节奏段（普通聊天靠它）',
    plainPace.includes('【推进节奏】') && plainPace.includes('多推进一些情节') && !/\{[a-zA-Z]+\}/.test(plainPace),
    JSON.stringify(plainPace.slice(0, 80))
  );
});

// ---------------------------------------------------------------------------
//  看大图（lightbox）
//
//  这里只盖「逻辑」那一半：滚轮 / 按钮 / 双击 / 百分比 / Esc。
//  「真实鼠标点按钮」那条在宿主侧（probeLightboxClick）—— 页面里 dispatchEvent
//  复现不出指针捕获那套行为，而这正是这个浮层最容易踩的坑。
// ---------------------------------------------------------------------------
await scenario('看图：灯箱缩放与关闭', async () => {
  const NAME = '灯箱测试角色';

  // 走真实交互造这张卡（新建 → 传形象 → 保存）。
  // 不能拿 saveCharacters 硬塞：那绕开了渲染层，列表刷新不出来，卡在页面上根本找不到。
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));
  setValue('#c-name', NAME);

  click('#char-portrait');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('形象按 1024 落进框里', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(200);

  const cardEl = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('有形象的卡，那块图是可点的', !!cardEl && !!cardEl.querySelector('.char-card-avatar.clickable'));
  if (!cardEl) return;

  click(cardEl.querySelector('.char-card-avatar.clickable'));
  await waitFor('灯箱打开', () => !!byId('lightbox'));

  const layer = byId('lightbox');
  const lbImg = layer.querySelector('.lightbox-img');
  check('灯箱里拿的正是这张形象', !!lbImg && !!lbImg.src && lbImg.src === cardEl.querySelector('.char-card-avatar img').src);

  // 缩放全写在 transform 上，读它是最可靠的做法
  const scaleOf = () => {
    const m = /scale\(([\d.]+)\)/.exec(lbImg.style.transform || '');
    return m ? Number(m[1]) : 1;
  };

  layer.dispatchEvent(
    new WheelEvent('wheel', { deltaY: -120, clientX: 300, clientY: 200, bubbles: true, cancelable: true })
  );
  await sleep(60);
  const afterWheelIn = scaleOf();
  check('滚轮向上 = 放大', afterWheelIn > 1.05, lbImg.style.transform);

  layer.dispatchEvent(
    new WheelEvent('wheel', { deltaY: 120, clientX: 300, clientY: 200, bubbles: true, cancelable: true })
  );
  await sleep(60);
  check('滚轮向下 = 缩回去', scaleOf() < afterWheelIn, lbImg.style.transform);

  const beforeBtnIn = scaleOf();
  click('#lightbox-in');
  await sleep(60);
  const afterBtnIn = scaleOf();
  check('点「＋」放大', afterBtnIn > beforeBtnIn, `${beforeBtnIn} → ${afterBtnIn}`);
  check('放大后百分比跟着变', /^\d+%$/.test((byId('lightbox-pct').textContent || '').trim()), byId('lightbox-pct').textContent);

  click('#lightbox-out');
  await sleep(60);
  check('点「−」缩小', scaleOf() < afterBtnIn, lbImg.style.transform);

  // 「适应窗口 / 实际大小」是同一个按钮，按当前状态在两个档位间切。
  // 一开始是适应窗口（scale = 1），按钮该显示「切到实际大小」那一档。
  check(
    '按钮初始是「切到实际大小」（图标 zoom-actual）',
    byId('lightbox-reset').classList.contains('is-actual'),
    byId('lightbox-reset').className
  );
  click('#lightbox-reset');
  await sleep(60);
  const actualScale = scaleOf();
  const pctAtActual = (byId('lightbox-pct').textContent || '').trim();
  check('切到实际大小后百分比是 100%', pctAtActual === '100%', pctAtActual);
  check(
    '切到实际大小后按钮变成「切到适应」（图标 zoom-fit）',
    byId('lightbox-reset').classList.contains('is-fit'),
    byId('lightbox-reset').className
  );
  check(
    '实际大小那一档 scale 和「适应」不同（原图与视口尺寸不等）',
    Math.abs(actualScale - 1) > 1e-6,
    `适应时 1，实际大小 ${actualScale}`
  );

  // 再点一下：回适应窗口
  click('#lightbox-reset');
  await sleep(60);
  check('再点回适应窗口（scale = 1）', Math.abs(scaleOf() - 1) < 1e-6, lbImg.style.transform);
  check('回到适应后百分比不再是 100%', (byId('lightbox-pct').textContent || '').trim() !== '100%' || actualScale === 1);
  check(
    '按钮又变回「切到实际大小」',
    byId('lightbox-reset').classList.contains('is-actual'),
    byId('lightbox-reset').className
  );

  // 按钮上不该再有文字（全是图标）
  check(
    '工具条按钮没有文字（只有图标）',
    ['#lightbox-in', '#lightbox-out', '#lightbox-reset', '#lightbox-close'].every((sel) => {
      const b = byId(sel.slice(1));
      return !!b && !!b.querySelector('svg') && !(b.textContent || '').trim();
    }),
    ['#lightbox-in', '#lightbox-out', '#lightbox-reset', '#lightbox-close']
      .map((s) => `${s}「${(byId(s.slice(1)).textContent || '').trim()}」`)
      .join(' ')
  );

  lbImg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 200 }));
  await sleep(60);
  check('双击图片放大', scaleOf() > 1.05, lbImg.style.transform);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(80);
  check('Esc 关掉灯箱', !byId('lightbox'));
  check('Esc 没顺带把角色库页面也关掉', shown('#view-chars'));
});

// ---------------------------------------------------------------------------
//  裁剪组件的输出尺寸
//
//  这里直接调 ui/imageCrop.js 的导出入口（编辑器点上传框走的也是它）——
//  因为要喂一张**指定尺寸的小图**进去，而上传那条路的桩图尺寸是固定的。
// ---------------------------------------------------------------------------
await scenario('裁剪：原图不够大时不硬撑放大', async () => {
  const mod = await import(new URL('js/ui/imageCrop.js', document.baseURI).href);

  const small = (() => {
    const cv = document.createElement('canvas');
    cv.width = 200;
    cv.height = 200;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#cfd9e8';
    ctx.fillRect(0, 0, 200, 200);
    return cv.toDataURL('image/png');
  })();

  const done = mod.openImageCrop({ dataUrl: small, aspect: 2 / 3, outWidth: 1024, title: '裁剪角色形象' });
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  const outUrl = await done;

  const size = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve({ w: 0, h: 0 });
    im.src = outUrl;
  });

  // 200×200 的原图上，2:3 的框最多只能圈到 133×200 —— 输出就该是这么大。
  // 硬撑到 1024×1536 只会把同一份信息摊得更糊、文件还更大。
  check('输出按原图能给的最大信息量走，不放大', size.w === 133 && size.h === 200, `${size.w}×${size.h}`);

  // 存下来的格式：优先 1.0 的 webp（有损编码里已经到顶，肉眼看不出区别），
  // 体积只有 PNG 的 1/3 左右 —— 这个文件每存一次角色就要整个重写一遍。
  check(
    '用 1.0 的 webp 存（无损级别，体积比 PNG 小三倍）',
    outUrl.startsWith('data:image/webp'),
    outUrl.slice(0, 30)
  );
});

// ---------------------------------------------------------------------------
//  预设：列表页 / 编辑器 / 绑定到会话
//
//  预设是「叠在对话上的一层指令」，和角色库、世界书同级：
//    · 列表页在侧栏「预设」里，新建/编辑/删除都走它；
//    · 编辑器和世界书编辑器同一套手感 —— 保存后才生效，没保存就关要问一句；
//    · 会话的「视角」弹窗里选一个预设绑上去，聊天时它才进系统提示词。
//  这里全程只点真实按钮、读真实 DOM、走 window.mimitale 这个桥。
// ---------------------------------------------------------------------------
await scenario('预设：列表页渲染与新建', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 两条种子预设都该在列表里
  await waitFor('列表里有种子预设', () => $$('#preset-page-grid .char-card').length >= 2);
  const names = $$('#preset-page-grid .char-card-name').map((n) => n.textContent.trim());
  check('列表里能看到「冒烟测试预设」', names.includes('冒烟测试预设'), names.join(' / '));
  check('列表里能看到「带条目的预设」', names.includes('带条目的预设'), names.join(' / '));

  // 「冒烟测试预设」的说明来自 description（导入形态），列表副标题该显示它而不是正文
  const card = $$('#preset-page-grid .char-card').find((c) => {
    const t = c.querySelector('.char-card-name');
    return t && t.textContent.trim() === '冒烟测试预设';
  });
  check(
    '列表副标题显示说明（description），不是发给模型的正文',
    card && /测试用的说明/.test(card.textContent),
    card ? card.textContent.trim().slice(0, 60) : '没找到卡片'
  );

  // 新建：点「＋ 新建预设」
  click('#btn-new-preset');
  await waitFor('新建弹窗打开了', () => shown('#preset-modal'));
  check('新建时标题是「新建预设」', byId('preset-title').textContent.trim() === '新建预设');
  check('新建时没有可删的东西 → 删除按钮藏起来', byId('btn-del-preset').classList.contains('hidden'));

  // 名字和正文都空着，点保存要被拦下来
  click('#btn-save-preset');
  await sleep(60);
  check('没填名字时保存被拦下（弹窗还开着）', shown('#preset-modal'));

  setValue('#pr-name', '严格推进');
  click('#btn-save-preset');
  await sleep(60);
  check('没填正文时保存也被拦下', shown('#preset-modal'));

  // 补齐正文再保存
  setValue('#pr-content', '每一轮都要推进一个具体事件。');
  setValue('#pr-note', '这个说明只给人看');
  setValue('#pr-tags', '叙事, 节奏');
  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  await waitFor('列表里出现新建的预设', () =>
    $$('#preset-page-grid .char-card-name').some((n) => n.textContent.trim() === '严格推进')
  );

  // 落盘验证：走桥读回来，看主进程归一化之后还剩什么
  const saved = (await window.mimitale.getPresets()).presets || [];
  const made = saved.find((p) => p.name === '严格推进');
  check('新建的预设落盘了', !!made, JSON.stringify(saved.map((p) => p.name)));
  check('正文按原样存下来', made && made.content === '每一轮都要推进一个具体事件。', made && made.content);
  check('说明存成 note', made && made.note === '这个说明只给人看', made && made.note);
  check('标签按逗号拆开', made && Array.isArray(made.tags) && made.tags.join('|') === '叙事|节奏', made && JSON.stringify(made.tags));
  check('新建的预设默认启用', made && made.enabled !== false);
  check('新建的预设拿到了 id', made && typeof made.id === 'string' && made.id.startsWith('pr'), made && made.id);
});

// 导入形态：正文只在 metadata.systemPromptContent 里，description 是给人看的说明。
// 这是别人分享预设时最常见的形态，归一层要能认出来。
await scenario('预设：导入形态的正文来源', async () => {
  const saved = (await window.mimitale.getPresets()).presets || [];
  const imported = saved.find((p) => p.id === 'pr-test');
  check('导入来的预设还在', !!imported);
  check(
    '正文取自 metadata.systemPromptContent',
    imported && imported.content === '每一轮都要推进一个具体事件，不要停在原地。',
    imported && imported.content
  );
  check(
    'description 只当说明，不混进正文',
    imported && /测试用的说明/.test(imported.note || '') && !/测试用的说明/.test(imported.content || ''),
    imported && imported.note
  );
});

await scenario('预设：编辑已有预设并落盘', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 点开「带条目的预设」的编辑
  const card = await waitFor('找到「带条目的预设」卡', () =>
    $$('#preset-page-grid .char-card').find((c) => {
      const t = c.querySelector('.char-card-name');
      return t && t.textContent.trim() === '带条目的预设';
    })
  );
  click(buttonByText(card, '编辑'));
  await waitFor('编辑弹窗打开了', () => shown('#preset-modal'));
  check('编辑时标题是「编辑预设」', byId('preset-title').textContent.trim() === '编辑预设');
  check('编辑时删除按钮可见（有东西可删）', !byId('btn-del-preset').classList.contains('hidden'));
  check('表单填的是这条预设的正文', byId('pr-content').value.includes('最前面的总则'));

  // 改一下正文，看看「有未保存的改动」亮不亮
  setValue('#pr-content', '最前面的总则。（改过了）');
  check('改了之后底部亮出「有未保存的改动」', byId('pr-foot-hint').classList.contains('pr-dirty'));

  // 关掉要被问一句 —— 点「取消」，弹窗留着
  click('#btn-close-preset');
  await waitFor('弹出「放弃改动」确认框', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await sleep(80);
  check('点「取消」之后编辑弹窗还开着', shown('#preset-modal'));
  check('「有未保存的改动」还亮着（没被清掉）', byId('pr-foot-hint').classList.contains('pr-dirty'));

  // 这次真保存
  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  const saved = (await window.mimitale.getPresets()).presets || [];
  const edited = saved.find((p) => p.id === 'pr-entries');
  check('改动落盘了', edited && edited.content.includes('改过了'), edited && edited.content);

  // 条目要活下来：归一化白名单漏一个字段就会被静默丢掉
  check('条目数没丢', edited && Array.isArray(edited.entries) && edited.entries.length === 2, edited && JSON.stringify(edited.entries));
  const keyEntry = edited && (edited.entries || []).find((e) => e.id === 'pe-key');
  check('关键词条目还认得「暗号」', keyEntry && (keyEntry.keys || []).includes('暗号'), keyEntry && JSON.stringify(keyEntry.keys));
  check('关键词条目没被当成常驻', keyEntry && keyEntry.constant !== true);
  const constEntry = edited && (edited.entries || []).find((e) => e.id === 'pe-const');
  check('无关键词的条目被当常驻', constEntry && constEntry.constant === true);
});

// ---------------------------------------------------------------------------
//  角色表情图 —— 按回复正文里的词换状态卡上的图
//
//  ⚠️ 放在预设那几条**聊天场景之前**：最后一条 chat:send 会被宿主侧的
//  probePresetInjection 拿来当「预设到底注没注入」的样本，这里插在后面会把它顶掉。
// ---------------------------------------------------------------------------
await scenario('角色：表情图按回复关键词切换', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');
  // 假后端每次回复的正文里都带着这句（见 smoke-test.js 的 chat:send）
  const TRIGGER = '这是加粗';

  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '表情测试角色';
  setValue('#c-name', NAME);

  // 状态卡的入口条只列「真的持有字段的人」，所以这张卡得有属性才看得见状态卡
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // 先给一张形象 —— 没命中表情时状态卡铺的就是它
  click('#char-portrait');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('形象按 1024 落进框里', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });

  // --- 表情图编辑挪进了独立弹窗：从编辑器入口打开 ---
  check('编辑器里有「管理表情图」入口', !!byId('btn-manage-expr'));
  click('#btn-manage-expr');
  await waitFor('表情弹窗打开了', () => shown('#expr-modal'));
  // 它是从角色编辑器里点开的：层级必须高过角色编辑弹窗，否则整块被盖住，看着像没反应
  check(
    '表情弹窗压在角色编辑器之上',
    Number(getComputedStyle(byId('expr-modal')).zIndex) > Number(getComputedStyle(byId('chars-modal')).zIndex),
    `expr=${getComputedStyle(byId('expr-modal')).zIndex} chars=${getComputedStyle(byId('chars-modal')).zIndex}`
  );
  check('弹窗里有「添加表情」按钮', !!byId('btn-add-expr'));
  check('还没加表情时有一句提示', /还没有表情图/.test(byId('char-expr-list').textContent));
  click('#btn-add-expr');
  await waitFor('多了一行表情', () => $$('#char-expr-list .char-expr-row').length === 1);
  check(
    '编辑器入口跟着显示已设条数',
    /已设 1 条/.test(byId('char-expr-summary').textContent),
    byId('char-expr-summary').textContent
  );

  // 名都没起就传图要拦住 —— 没名字的条目匹配不上任何东西，存下去等于白存
  click($('#char-expr-list .char-expr-thumb'));
  await sleep(250);
  check('没起名字就传图会被拦下（不弹裁剪）', !byId('crop-layer'));

  setValue('#char-expr-list .char-expr-name', '表情甲');
  setValue('#char-expr-list .char-expr-keys', TRIGGER);

  click($('#char-expr-list .char-expr-thumb'));
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪表情图」', byId('crop-layer').textContent.includes('裁剪表情图'));
  click('#crop-ok');
  await waitFor('表情图按 640 落进缩略图', () => {
    const i = $('#char-expr-list .char-expr-thumb img');
    return !!i && i.naturalWidth === 640;
  });
  const exThumb = $('#char-expr-list .char-expr-thumb img');
  check(
    '表情图按 1:1 裁（640×640）',
    !!exThumb && exThumb.naturalWidth === 640 && exThumb.naturalHeight === 640,
    exThumb ? `${exThumb.naturalWidth}×${exThumb.naturalHeight}` : '缩略图里没图'
  );

  // 关掉表情弹窗再回编辑器保存
  click('#btn-expr-done');
  await waitFor('表情弹窗关掉了', () => !shown('#expr-modal'));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(200);

  // --- 落盘 ---
  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  const expr = saved && Array.isArray(saved.expressions) ? saved.expressions[0] : null;
  check('表情表落在了角色卡上', !!expr, JSON.stringify(saved && saved.expressions));
  check(
    '表情名和触发词都存下来了',
    !!expr && expr.name === '表情甲' && Array.isArray(expr.keywords) && expr.keywords.includes(TRIGGER),
    JSON.stringify(expr && { name: expr.name, keywords: expr.keywords })
  );
  check('表情图是 dataURL', isImg(expr && expr.image), String(expr && expr.image).slice(0, 24));
  check('表情图和形象是两份，没互相顶掉', !!expr && isImg(saved.portrait) && expr.image !== saved.portrait);

  // --- 开一场，看状态卡上铺哪张 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('入口条上有这个角色', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const scCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');

  check('状态卡上有角色图', !!scCard().querySelector('.sc-photo img'));
  check(
    '还没说过话时铺的是角色形象（没有表情标签）',
    !scCard().querySelector('.sc-photo-tag'),
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );

  // --- 说一句：回复正文里带上了触发词，卡上的图该换过来 ---
  setValue('#input', '冒烟测试：表情');
  click('#btn-send');
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').disabled === false, 8000);

  // 卡片在刷新时会被重建，每次都要重新拿一遍节点
  await waitFor('状态卡换上了表情图', () => {
    const node = scCard();
    return !!node && !!node.querySelector('.sc-photo-tag');
  });
  const tag = scCard().querySelector('.sc-photo-tag');
  check('卡上标出了命中的表情名', !!tag && tag.textContent === '表情甲', tag ? tag.textContent : '没有标签');
  const photo = scCard().querySelector('.sc-photo img');
  check(
    '铺的是那张表情图（不是形象）',
    !!photo && photo.getAttribute('src') === expr.image,
    photo ? `长度 ${String(photo.getAttribute('src')).length} / 表情图 ${String(expr.image).length}` : '没有图'
  );
});

// ---------------------------------------------------------------------------
//  角色表情图（词表）—— 差分文件名都得认得出情绪
//
//  认不出就退回「拿文件名当名字」，导进来一片 Char_C1_flustered_transparent：
//  图进来了，名字不能看，还得一条条手改 —— 所以词表按差分集的键逐个过一遍。
// ---------------------------------------------------------------------------
await scenario('角色：表情词典认得差分文件名', async () => {
  const mod = await import(new URL('js/views/charExpressions.js', document.baseURI).href);

  // 键 → 中文名。一套立绘差分的完整划分（基础 / 常态 / 亲密 / 状态 / 关系）
  const EXPECTED = {
    neutral: '平静', smile: '微笑', shy: '害羞', confused: '困惑', panicked: '慌张',
    sad: '难过', teary: '委屈', surprised: '惊讶', proud: '得意', angry: '生气',
    disgust: '嫌弃', curious: '好奇', smirk: '坏笑', cold: '冷漠', tired: '疲惫',
    relieved: '安心', flustered: '脸红别脸', panting: '喘气', resist: '抗拒', dazed: '迷离',
    defiant: '挑衅', pleading: '求饶', enduring: '隐忍', afterglow: '事后', happy: '开心',
    helpless: '无奈', serious: '认真', blank: '发呆', scared: '害怕', aching: '心疼',
    tipsy: '微醺', sleepy: '犯困', hopeful: '期待', clingy: '撒娇', sulky: '赌气',
    moved: '感动', jealous: '嫉妒', worried: '担忧', apologetic: '道歉', thankful: '感谢',
    peeking: '偷看', uneasy: '不安'
  };

  const keyOf = (file) => (mod.emotionFromFileName(file) || {}).key;
  const missed = [];
  const wrongName = [];
  for (const [key, name] of Object.entries(EXPECTED)) {
    // 中性占位：真差分集就是「角色_编号_英文键_transparent.png」这个形状
    const got = mod.emotionFromFileName(`Char_${key}_transparent.png`);
    if (!got) missed.push(key);
    else if (got.key !== key || got.name !== name) wrongName.push(`${key}→${got.key}/${got.name}`);
  }
  check(`${Object.keys(EXPECTED).length} 个差分键都认得出`, missed.length === 0, missed.join(','));
  check('认出来的中文名也对得上', wrongName.length === 0, wrongName.join(' '));

  // 中文文件名走另一条路，抽几个有代表性的
  check('中文文件名照样认得出', keyOf('Char_害羞_透明.png') === 'shy');
  check('中文同义词也能落到键上', keyOf('Char_吃醋_透明.png') === 'jealous');
  check('没见过的词不硬猜（退回文件名）', mod.emotionFromFileName('Char_0231.png') === null);
});

// ---------------------------------------------------------------------------
//  角色表情图（二）—— 批量导入 / 默认脸 / <emo> 标签
//
//  ⚠️ 同上：必须留在预设那几条聊天场景之前。
// ---------------------------------------------------------------------------
await scenario('角色：表情图批量导入、默认脸与 emo 标签', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');

  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '批量表情测试角色';
  setValue('#c-name', NAME);

  // 状态卡入口条只列「真的持有字段的人」，所以得有属性才看得见状态卡
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // --- 批量导入：假后端给六个文件，前三个文件名是英文、后三个是中文 ---
  click('#btn-manage-expr');
  await waitFor('表情弹窗打开了', () => shown('#expr-modal'));
  check('弹窗里有「批量导入」按钮', !!byId('btn-batch-expr'));
  click('#btn-batch-expr');
  await waitFor(
    '六张里导进五张（末张「羞怯」和英文的 shy 撞同一个情绪键，被跳过）',
    () => $$('#char-expr-list .char-expr-row').length === 5
  );

  const rows = () => $$('#char-expr-list .char-expr-row');
  const thumbOk = rows().every((r) => {
    const img = r.querySelector('.char-expr-thumb img');
    return !!img && img.naturalWidth === 640 && img.naturalHeight === 640;
  });
  check('批量导入的图都按 1:1 裁过（640×640）', thumbOk);

  const names = $$('#char-expr-list .char-expr-name').map((i) => i.value);
  check(
    '英文文件名认出了中文情绪名',
    names.slice(0, 3).join(',') === '害羞,微笑,慌张',
    names.join(',')
  );
  check(
    '中文文件名也认（正名「惊讶」+ 同义词「气愤」）',
    names.slice(3).join(',') === '惊讶,生气',
    names.join(',')
  );

  // 给「微笑」挂上一个关键词：假后端每轮回复里都有「这是加粗」，
  // 这样等会儿发 <emo> 标签时，正文关键词和标签会指向**两张不同的图**，
  // 才验得出「标签优先」。
  setValue($$('#char-expr-list .char-expr-keys')[1], '这是加粗');

  // --- 默认脸（单选） ---
  const star = (i) => rows()[i].querySelector('.char-expr-default');
  check('每行都有默认脸开关', rows().every((r) => !!r.querySelector('.char-expr-default')));
  check('一开始没人是默认脸', !star(0).classList.contains('is-on') && !star(1).classList.contains('is-on'));

  click(star(1));
  await sleep(30);
  check('点一下就把这条设成默认脸', star(1).classList.contains('is-on'));
  check(
    '别的行没被一起点亮',
    rows().every((r, i) => i === 1 || !r.querySelector('.char-expr-default').classList.contains('is-on'))
  );

  click(star(1));
  await sleep(30);
  check('再点一下取消', !star(1).classList.contains('is-on'));
  click(star(1));
  await sleep(30);
  check('重新点上', star(1).classList.contains('is-on'));

  // 关掉表情弹窗再保存
  click('#btn-expr-done');
  await waitFor('表情弹窗关掉了', () => !shown('#expr-modal'));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#chars-modal'));
  await sleep(200);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  const exprs = (saved && saved.expressions) || [];
  check('五条表情都在卡上', exprs.length === 5, JSON.stringify(exprs.map((e) => e.name)));
  check(
    '情绪键落盘了（中文文件名映射到同一套英文键）',
    exprs.map((e) => e.key).join(',') === 'shy,smile,panicked,surprised,angry',
    JSON.stringify(exprs.map((e) => e.key))
  );
  check('每条都带了图', exprs.every((e) => isImg(e.image)));

  // 透明底立绘压在卡片底色上，轮廓得描出来（白发 + 浅底最容易糊）。
  // 描边色跟着主题反着走，所以拿的是算出来的值，不是写死的字符串。
  {
    const edgeVar = getComputedStyle(document.documentElement).getPropertyValue('--art-edge').trim();
    check('定义了立绘描边变量 --art-edge', edgeVar.startsWith('0 0 1px'), edgeVar);
    const thumb = rows()[0].querySelector('.char-expr-thumb');
    const shadow = getComputedStyle(thumb).boxShadow;
    check(
      '表情缩略图上描边生效了（不是 none）',
      !!shadow && shadow !== 'none' && shadow.includes('inset') === false,
      shadow
    );
  }
  const defEntry = exprs.find((e) => e.default === true);
  check('默认脸只落了一条，而且是「微笑」', exprs.filter((e) => e.default === true).length === 1 &&
    !!defEntry && defEntry.name === '微笑', defEntry && defEntry.name);
  const shyEntry = exprs.find((e) => e.name === '害羞');
  const smileEntry = exprs.find((e) => e.name === '微笑');

  // --- 开一场：没说过话时该铺默认脸，而不是形象图 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);

  // 列表卡那个圆头像也是透明底素材压底色，同一个坑（见 --art-edge 那段）
  {
    const av = card.querySelector('.char-card-avatar');
    const avShadow = av ? getComputedStyle(av).boxShadow : '';
    check('角色库列表卡的头像有描边', !!avShadow && avShadow !== 'none', avShadow);
  }
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('入口条上有这个角色', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const scCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
  const scPhoto = () => scCard().querySelector('.sc-photo img');

  check(
    '没说过话时铺的是默认脸「微笑」',
    !!scPhoto() && scPhoto().getAttribute('src') === smileEntry.image,
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );
  check('卡上标着默认脸的名字', (scCard().querySelector('.sc-photo-tag') || {}).textContent === '微笑');

  // 卡面那块 1:1 的立绘区：白发素材压在卡片底色上，就靠这条描边勾出轮廓
  {
    const photoShadow = getComputedStyle(scCard().querySelector('.sc-photo')).boxShadow;
    check('状态卡图区有描边（不是 none）', !!photoShadow && photoShadow !== 'none', photoShadow);
  }

  // --- 发一句，回复里既有「这是加粗」又有 <emo>shy</emo>：标签该赢 ---
  setValue('#input', '冒烟测试：表情标签');
  click('#btn-send');
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').disabled === false, 8000);

  await waitFor(
    '状态卡换成了标签指定的那张',
    () => {
      const tag = scCard() && scCard().querySelector('.sc-photo-tag');
      return !!tag && tag.textContent === '害羞';
    },
    6000
  );
  check(
    '<emo> 标签压过了正文关键词（害羞 赢了 微笑）',
    !!scPhoto() && scPhoto().getAttribute('src') === shyEntry.image,
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );

  // 标签是给程序读的，不该留在气泡正文里
  check(
    '气泡正文里看不见 <emo> 标签',
    !$('#messages').textContent.includes('<emo>'),
    ($('#messages').textContent.match(/<emo>[^<]*<\/emo>/) || [''])[0]
  );
});

await scenario('预设：绑定到会话的「视角」弹窗', async () => {
  // 种子数据里没有会话，先用角色库起一场对话
  click('#btn-chars');
  await waitFor('角色库出来了', () => shown('#view-chars'));
  const charCard = await waitFor('角色库里有卡可开聊', () => $$('#char-page-grid .char-card')[0]);
  check('角色库里有卡可开聊', !!charCard);

  const chatBtn = buttonByText(charCard, '聊天');
  check('角色卡上有「聊天」按钮', !!chatBtn);
  if (chatBtn) await startChatWith(charCard);
  await waitFor('切回对话视图', () => shown('#view-chat'));

  // 打开「视角」弹窗
  click('#btn-perspective');
  await waitFor('视角弹窗打开了', () => shown('#perspective-modal'));

  // —— 预设是多选列表，不是下拉 ——
  const rows = () => $$('#p-preset-list .preset-pick-row');
  const names = () => $$('#p-preset-list .preset-pick-name').map((n) => n.textContent.trim());
  await waitFor('预设列表铺出来了', () => rows().length >= 3);

  check(
    '列表里列出了所有启用的预设',
    ['冒烟测试预设', '带条目的预设', '全局通用预设'].every((n) => names().includes(n)),
    names().join(' / ')
  );

  // 「可全局」的徽标只挂在勾了 global 的那条上
  const globalRow = () =>
    rows().find((r) => {
      const n = r.querySelector('.preset-pick-name');
      return n && n.textContent.trim() === '全局通用预设';
    });
  check(
    '勾了「可全局」的预设带徽标',
    globalRow() && !!globalRow().querySelector('.preset-pick-badge')
  );
  const plainRow = () =>
    rows().find((r) => {
      const n = r.querySelector('.preset-pick-name');
      return n && n.textContent.trim() === '带条目的预设';
    });
  check(
    '没勾「可全局」的预设不带徽标',
    plainRow() && !plainRow().querySelector('.preset-pick-badge')
  );

  // 会话是刚建的 —— 没手动配过，应该自动跟随全局预设（只勾上那一条）
  const boxState = () =>
    Object.fromEntries(
      rows().map((r) => [
        r.querySelector('.preset-pick-name').textContent.trim(),
        r.querySelector('.preset-pick-box').checked
      ])
    );
  let st = boxState();
  check('没配过的会话自动勾上「可全局」的预设', st['全局通用预设'] === true, JSON.stringify(st));
  check('没配过的会话不勾其它预设', st['带条目的预设'] === false, JSON.stringify(st));

  const stateNote = () => byId('p-preset-list').querySelector('.preset-pick-state');
  await waitFor('列表下有状态说明', () => stateNote());
  check('自动跟随全局时状态说明写「跟随全局」', /跟随全局/.test(stateNote().textContent), stateNote().textContent.trim());

  // 轮询落盘（视角弹窗是「改动即时生效」的异步链，固定 sleep 会偶尔跑输）
  const settleIds = async (want, label) => {
    const t0 = Date.now();
    for (;;) {
      const a = await activeConvo();
      const got = a ? a.dialoguePresetIds : undefined;
      if (JSON.stringify(got) === JSON.stringify(want)) return a;
      if (Date.now() - t0 > 3000) return null;
      await sleep(25);
    }
  };

  // —— 勾第二条：从「跟随全局」转成「手动配过」——
  const boxFor = (name) =>
    rows()
      .find((r) => r.querySelector('.preset-pick-name').textContent.trim() === name)
      .querySelector('.preset-pick-box');
  boxFor('带条目的预设').checked = true;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));

  // 全局那条还勾着（用户没取消），加上新勾的这条 → 两条。
  // 顺序按列表里的行序来（DOM 顺序），不是按勾选先后。
  let bound = await settleIds(['pr-entries', 'pr-global'], '勾第二条');
  check(
    '勾上第二条之后会话记下两条 id',
    !!bound,
    bound ? JSON.stringify(bound.dialoguePresetIds) : `等 3 秒也没等到落盘；当前=${JSON.stringify((await activeConvo())?.dialoguePresetIds)}`
  );
  st = boxState();
  check('手动配过之后两条都勾着', st['全局通用预设'] && st['带条目的预设'], JSON.stringify(st));
  check('手动配过之后状态说明变成「这一场单独配置」', /单独配置/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 全不勾：显式「一条都不要」，存成空数组（不是 null）——
  boxFor('全局通用预设').checked = false;
  boxFor('全局通用预设').dispatchEvent(new Event('change', { bubbles: true }));
  boxFor('带条目的预设').checked = false;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));
  const cleared = await settleIds([], '全不勾');
  check('全不勾时存成空数组（不是 null）', !!cleared, cleared ? JSON.stringify(cleared.dialoguePresetIds) : '等 3 秒也没等到落盘');
  check('全不勾等于「这一场一条都不用」', !!cleared && Array.isArray(cleared.dialoguePresetIds) && cleared.dialoguePresetIds.length === 0);
  check('全不勾之后状态说明挑明「一条都不用」', /一条都不用/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 关键的一条：手动配成「全不选」之后，全局预设**不该**再自动回来 ——
  // 关掉弹窗再打开，状态要从盘上重读，这时候最容易把「没配过」和「配成全不选」搞混
  click('#btn-close-perspective');
  await sleep(60);
  click('#btn-perspective');
  await waitFor('视角弹窗重新打开', () => shown('#perspective-modal'));
  await waitFor('列表重新铺出来了', () => rows().length >= 3);
  st = boxState();
  check('重开之后仍然是「一条都不勾」', !st['全局通用预设'] && !st['带条目的预设'], JSON.stringify(st));
  check('重开之后仍标「这一场单独配置」（没回落全局）', /单独配置/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 只勾「带条目的预设」一条，留给后面的「注入」场景用 ——
  boxFor('带条目的预设').checked = true;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));
  await settleIds(['pr-entries'], '只勾一条');

  click('#btn-close-perspective');
  await sleep(60);
  check('关掉视角弹窗', !shown('#perspective-modal'));
});

await scenario('预设：绑好后发一轮，正文进提示词', async () => {
  setValue('#input', '准备好了吗');
  click('#btn-send');
  // 等这一轮回复落成消息（真实流式通道跑完）
  await waitFor('这一轮回复渲染出来了', () => $$('#messages .msg').length >= 2, 8000);
});

// ---------------------------------------------------------------------------
//  预设：导入 / 导出
//
//  导入的「文件」由宿主侧的 smoke:preset-import-queue 塞进来（测试没有真文件框）。
//  这里验的是渲染层那一半：导进来的要重发 id、要进库、要落盘、要有提示；
//  导出则把 util:saveFile 收到的内容交给宿主侧断言（probePresetExport）。
// ---------------------------------------------------------------------------
await scenario('预设：导入文件', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));
  await waitFor('列表有种子预设', () => $$('#preset-page-grid .char-card').length >= 2);

  const before = $$('#preset-page-grid .char-card').length;

  // 「文件里的东西」由宿主侧事先塞好（测试没有真文件框），这里只管点导入。
  // 第一批要拿到的是「导入的预设甲 / 乙」（见 smoke-test.js 的 seedPresetImportQueue）。
  click('#btn-import-preset');
  await waitFor('导入后列表变长了', () => $$('#preset-page-grid .char-card').length >= before + 2, 5000);

  const names = $$('#preset-page-grid .char-card-name').map((n) => n.textContent.trim());
  check('导入的预设进了列表', names.includes('导入的预设甲') && names.includes('导入的预设乙'), names.join(' / '));

  // 落盘 + 归一化：正文该来自 metadata.systemPromptContent，说明该是 description
  const saved = (await window.mimitale.getPresets()).presets || [];
  const a = saved.find((p) => p.name === '导入的预设甲');
  check('导入的预设落盘了', !!a, JSON.stringify(saved.map((p) => p.name)));
  check('导入时正文取自 metadata.systemPromptContent', a && a.content === '导入的正文甲。', a && a.content);
  check('导入时 description 当说明、不混进正文', a && a.note === '这是说明，不该混进正文', a && a.note);
  check('导入的预设拿到了新 id', a && typeof a.id === 'string' && a.id.startsWith('pr'), a && a.id);

  // ⚠️ id 必须重发：直接沿用文件里的 id，两条同 id 的会互相顶掉
  const ids = saved.map((p) => p.id);
  check('导入后所有预设 id 互不重复', new Set(ids).size === ids.length, JSON.stringify(ids));
});

await scenario('预设：导入时出错要把好的收下', async () => {
  const before = $$('#preset-page-grid .char-card').length;

  // 第二批：一个能读到的 + 一条错误（见 seedPresetImportQueue）
  click('#btn-import-preset');
  await waitFor('导入的预设进了列表', () =>
    $$('#preset-page-grid .char-card-name').some((n) => n.textContent.trim() === '导入的预设丙')
  , 5000);
  check('有错误时照样把好的导入进来', $$('#preset-page-grid .char-card').length >= before + 1);
});

await scenario('预设：导出单条与全部', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 单条：卡片上的「导出」按钮
  const cardEl = await waitFor('找到「带条目的预设」卡', () =>
    $$('#preset-page-grid .char-card').find((c) => {
      const t = c.querySelector('.char-card-name');
      return t && t.textContent.trim() === '带条目的预设';
    })
  );
  check('预设卡片上有「导出」按钮', !!buttonByText(cardEl, '导出'));
  click(buttonByText(cardEl, '导出'));
  await sleep(200);

  // 全部：页面右上角
  click('#btn-export-presets');
  await sleep(200);

  // 具体内容由宿主侧看 util:saveFile 收到的 payload（probePresetExport）
  check('导出没有卡住界面', shown('#view-presets'));
});

// ---------------------------------------------------------------------------
//  开聊前先定「你是谁」
//
//  点角色卡的「聊天」不再直接建会话 —— 先弹「你是谁」（和「进世界」共用同一个
//  弹窗），填完才建；什么都不填就以默认的「你」开始（会话上不存 player）。
//
//  这个场景会**建三条新会话**，所以放在最后跑 —— 否则后面所有依赖「当前会话」
//  的场景都会跑在它新建的会话上（预设绑定那几条就是这么被顶掉的）。
// ---------------------------------------------------------------------------
await scenario('开聊前先定「你是谁」', async () => {
  const settlePlayer = async (want) => {
    const t0 = Date.now();
    for (;;) {
      const a = await activeConvo();
      const p = a && a.player;
      if (want === null ? !p : p && p.name === want.name && p.profile === want.profile) return a;
      if (Date.now() - t0 > 3000) return null;
      await sleep(25);
    }
  };

  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  const card = await waitFor('角色库里有卡可开聊', () => $$('#char-page-grid .char-card')[0]);

  // —— 点「聊天」先弹窗，这时还没建会话 ——
  click(buttonByText(card, '聊天'));
  await waitFor('「你是谁」弹窗打开', () => shown('#player-modal'));
  check('角色卡的「聊天」会先问「你是谁」', shown('#player-modal'));
  check('名字默认是空的（留空就是「你」）', byId('player-name').value === '', JSON.stringify(byId('player-name').value));

  // —— 填好身份再开始：落到新会话上 ——
  setValue('#player-name', '测试者甲');
  setValue('#player-profile', 'P-玩家设定');
  click('#btn-start-play');
  await waitFor('弹窗关掉并进入对话', () => !shown('#player-modal') && shown('#view-chat'));

  const stored = await settlePlayer({ name: '测试者甲', profile: 'P-玩家设定' });
  check(
    '填好的身份落到新会话上',
    !!stored,
    stored ? JSON.stringify(stored.player) : '等 3 秒也没等到落盘'
  );

  // —— 再开一场、什么都不填：会话上不存 player，界面回到默认的「你」——
  click('#btn-chars');
  await waitFor('切回角色库页面', () => shown('#view-chars'));
  await startChatWith($$('#char-page-grid .char-card')[0]);
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const blank = await settlePlayer(null);
  check(
    '什么都不填也能开聊，player 不落盘',
    !!blank,
    blank ? JSON.stringify(blank.player) : '等 3 秒也没等到'
  );

  // —— 挑一张角色卡当自己：绑定的那个角色仍要留在入口条里 ——
  // ⚠️ 这条守着一个真 bug：玩家一旦有身份，单卡会话绑的卡就丢掉了「永远显示」
  //    的豁免，掉进 showsInPanel（默认 false）里被过滤掉 —— 入口条只剩「我」，
  //    那个角色的状态卡再也点不开，表情键也不注入。
  click('#btn-chars');
  await waitFor('切回角色库页面', () => shown('#view-chars'));
  const soloCard = $$('#char-page-grid .char-card')[0];
  click(buttonByText(soloCard, '聊天'));
  await waitFor('「你是谁」弹窗打开（挑卡当自己）', () => shown('#player-modal'));

  const selfOptions = Array.from(byId('player-char').options).filter((o) => o.value);
  check('开聊前能从角色库挑一张卡当自己', selfOptions.length > 0, `${selfOptions.length} 个可选`);
  setValue('#player-char', selfOptions[0].value);
  click('#btn-start-play');
  await waitFor('弹窗关掉并进入对话（挑卡当自己）', () => !shown('#player-modal') && shown('#view-chat'));
  await sleep(250);

  const castAvatars = $$('#panel-cast .panel-avatar');
  check(
    '挑卡当自己后，绑定的角色仍在入口条里（普通聊天不显示「我」）',
    castAvatars.some((a) => a.dataset.owner !== 'player') &&
      !castAvatars.some((a) => a.dataset.owner === 'player'),
    `入口条 ${castAvatars.length} 个：` + castAvatars.map((a) => a.dataset.owner).join('、')
  );

  // —— 身份只在开聊前定：视角弹窗里已经没有「我是谁」了 ——
  click('#btn-perspective');
  await waitFor('视角弹窗打开', () => shown('#perspective-modal'));
  check('视角弹窗里不再有「我是谁」', !byId('p-player-name') && !byId('p-player-char'));
  click('#btn-close-perspective');
  await sleep(60);
});

// ---------------------------------------------------------------------------
//  「＋ 新对话」：直接建空白会话；场上没有角色时「在场角色」整条收掉
//
//  2026-10-08 两处行为变化一起钉住：
//    · 「＋ 新对话」不再先跳角色库，点下去就建一个空白会话并切回聊天屏；
//    · 普通聊天的入口条不显示「我」—— 空白会话名单为空，横幅整条隐藏。
// ---------------------------------------------------------------------------
await scenario('新对话：直接建空白会话，只剩「我」时入口条收起', async () => {
  const before = $$('#convo-list .convo-item').length;
  click('#btn-new');
  await waitFor('会话列表多了一条', () => $$('#convo-list .convo-item').length === before + 1);
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  check('空白会话里「在场角色」入口条整条收掉', !shown('#panel-box'));
});

// 帮助页：纯静态内容，只验「切得过去、小节齐全、目录锚点对得上、复制按钮接对了」。
// 目录锚点那条不是客套 —— 改正文时最容易忘了同步目录里的 id，
// 点一下发现跳不动才发现，有了这条能在跑测试时就拦住。
await scenario('帮助：切页、正文与复制提示词', async () => {
  click('#btn-help');
  await waitFor('切到帮助页', () => shown('#view-help'));
  check('侧栏「帮助」高亮', byId('btn-help').classList.contains('active'));
  check('切走后聊天视图让位', !shown('#view-chat'));

  const sections = $$('#view-help .help-sec');
  check('帮助正文有 11 个小节', sections.length === 11, `实际 ${sections.length} 节`);

  const lead = $('#view-help .help-lead');
  check('页首那句总纲在', !!lead && /小引擎/.test(lead.textContent));

  const anchors = $$('#view-help .help-toc a').map((a) => a.getAttribute('href'));
  check('目录条目数与小节数一致', anchors.length === sections.length, `目录 ${anchors.length} 条`);
  const missing = anchors.filter((h) => !h || !document.querySelector(`#view-help ${h}`));
  check('目录锚点全部命中真实小节', missing.length === 0, missing.join(' '));

  // 复制：点完要弹提示。提示里带「故事优化提示词」才说明按钮真接到了那段文本
  // （不是空点一下），剪贴板本身走的是 util:copy 那条桥，页面里看不到。
  click('#btn-copy-help-prompt');
  await waitFor(
    '复制后弹出提示',
    () => shown('#toast') && /故事优化提示词/.test(byId('toast').textContent)
  );
  check('复制按钮弹出了对的提示', /故事优化提示词/.test(byId('toast').textContent), byId('toast').textContent);
});

// ---------------------------------------------------------------------------
//  默认人设：按模型各存一份，管「没绑角色卡」的对话
//
//  这一段只负责造现场和验界面；「这段人设到底有没有拼进提示词」由宿主侧的
//  probeAssistantPersona 断言（页面读不到发给模型的消息）。
// ---------------------------------------------------------------------------
await scenario('默认人设：按模型可编辑，并注入没绑卡的对话', async () => {
  const PERSONA_TEXT = '你是一只叫团子的猫，只用喵喵叫和动作回应。';

  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);
  const viewMod = await import(new URL('js/views/viewSwitch.js', document.baseURI).href);

  // 造一条**不绑角色卡**的会话（通用助手那一类）
  viewMod.showView('chat');
  convMod.createConvo(true);
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const model = String((stateMod.state.settings || {}).activeModel || '');
  check('当前有模型可配', !!model, model || '（设置里没有 activeModel）');

  // --- 1) 「模型服务」里有一行入口，点开才进编辑弹窗 ---
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));

  const hintText = () => (byId('s-assistant-hint') || {}).textContent || '';
  check('模型服务里有「默认人设」入口按钮', !!byId('btn-assistant-persona'));
  check(
    '入口那行写着当前模型还没配',
    hintText().includes(model) && /未设置/.test(hintText()),
    hintText()
  );

  click('#btn-assistant-persona');
  await waitFor('人设弹窗打开', () => shown('#persona-modal'));
  check(
    '人设弹窗里能选「给哪个模型」，默认落在当前这个模型上',
    byId('persona-model').value === model,
    `${byId('persona-model').value}（可选项 ${byId('persona-model').options.length} 个）`
  );
  check(
    '这个模型还没配过人设，两个框都是空的',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」`
  );

  // 先试一次「取消」：没保存的字必须丢掉，不能被之后「保存设置」顺带带走
  setValue('#persona-name', '不该留下');
  setValue('#persona-text', '这段也不该留下');
  click('#btn-cancel-persona');
  await waitFor('人设弹窗关掉', () => !shown('#persona-modal'));
  check(
    '取消后弹窗字段回填成空（草稿被丢掉）',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」正文「${byId('persona-text').value}」`
  );

  // --- 1.5) 「套用聊天风格模板」：空框直接填；有内容时先问一句再覆盖 ---
  // 这段模板补的是「API 没有网页版那层官方语气」的缺口，属于默认对话的核心体验，
  // 所以顺手守住两条：空框不打扰、非空不偷改。
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开一次', () => shown('#persona-modal'));
  check('人设弹窗里有「套用聊天风格模板」', !!byId('btn-persona-template'));

  click('#btn-persona-template');
  await sleep(80);
  const tplText = byId('persona-text').value;
  check(
    '空框时点模板直接填进去，不弹确认',
    tplText.includes('【说话方式】') && !shown('#confirm-modal'),
    String(tplText).slice(0, 24)
  );

  click('#btn-persona-template');
  await waitFor('有内容时点模板要先确认', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  check('在确认框里点「取消」，正文一个字都不变', byId('persona-text').value === tplText);

  // 模板是草稿，别让它影响后面「正经配一套」那一步 —— 清掉再取消
  setValue('#persona-text', '');
  click('#btn-cancel-persona');
  await waitFor('放弃模板草稿', () => !shown('#persona-modal'));

  // --- 2) 正经配一套并保存 ---
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开', () => shown('#persona-modal'));
  setValue('#persona-name', '烟测助手');
  setValue('#persona-text', PERSONA_TEXT);
  click('#btn-save-persona');
  await waitFor('保存后人设弹窗关闭', () => !shown('#persona-modal'));
  await sleep(150);

  const saved = (await window.mimitale.getSettings()).settings;
  const map = saved.assistantPersonas || {};
  check(
    '默认人设按模型名落盘',
    !!(map[model] && map[model].name === '烟测助手'),
    JSON.stringify(map)
  );
  check(
    '人设正文也落了盘',
    !!(map[model] && map[model].persona === PERSONA_TEXT),
    (map[model] || {}).persona
  );
  check(
    '入口那行跟着变成「已设置」',
    /已设置/.test(hintText()) && hintText().includes('烟测助手'),
    hintText()
  );

  click('#btn-close-settings');
  await waitFor('设置弹窗关闭', () => !shown('#settings-modal'));

  // --- 3) 空状态标题跟着人设的名字走 ---
  const emptyTitle = $('#messages .empty h2') ? $('#messages .empty h2').textContent : '';
  check('空状态标题用了默认人设的名字', emptyTitle.includes('烟测助手'), emptyTitle);

  // --- 4) 换成另一个模型：那一份是空的，刚才那份还在（= 每个模型一份）---
  const convo = stateMod.state.conversations.find((c) => c.id === stateMod.state.activeId);
  if (convo) convo.model = '另一个模型';
  click('#btn-settings');
  await waitFor('设置弹窗再开一次', () => shown('#settings-modal'));
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开', () => shown('#persona-modal'));
  check(
    '另一个模型的人设是空的（两边各自独立）',
    byId('persona-name').value === '',
    byId('persona-name').value
  );
  check(
    '切模型后弹窗顶上的下拉框跟着换了',
    byId('persona-model').value === '另一个模型',
    byId('persona-model').value
  );

  // --- 4.5) 弹窗里能**直接换编辑对象** -----------------------------------
  // 这一节守的是那个报上来的 bug：编辑对象从前跟着「会话在用的模型」走，
  // 界面上又没有任何地方能改 —— 想给另一个模型配人设就无从下手，
  // 弹窗永远只有会话那一个模型的一份。
  const personaOptions = [...byId('persona-model').options].map((o) => o.value);
  check(
    '下拉框列出了各服务商的模型，也带上当前会话在用的这个',
    personaOptions.includes(model) && personaOptions.includes('另一个模型'),
    personaOptions.join(' , ')
  );

  setValue('#persona-model', model);
  await sleep(80);
  check(
    '换到另一个模型，字段里换成那一份（不是刚才那份空的）',
    byId('persona-name').value === '烟测助手' && byId('persona-text').value === PERSONA_TEXT,
    `名字「${byId('persona-name').value}」`
  );
  check('字段里没有未保存的改动时，换编辑对象不弹确认框', !shown('#confirm-modal'));

  setValue('#persona-model', '另一个模型');
  await sleep(80);
  check(
    '换回来字段又变回那一份空草稿',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」`
  );

  // 挑着模型存一份：必须进到**选中的**那个模型名下，不能覆盖另一份。
  // 拿 img-model-x 当靶子 —— 它是服务商列表里真实存在的一个模型（另一个服务商名下的），
  // 正好顺带验「跨服务商的模型都能选」。存完「另一个模型」还是干净的，
  // 下面「没配名字时空状态标题不提名字」那条断言才不会被打乱。
  const PICKED = 'img-model-x';
  setValue('#persona-model', PICKED);
  await sleep(80);
  check(
    '另一个服务商名下的模型也能选，字段同样是空的',
    byId('persona-model').value === PICKED &&
      byId('persona-name').value === '' &&
      byId('persona-text').value === '',
    byId('persona-model').value
  );

  const PERSONA_TEXT_2 = '你是只回答天气的助手。';
  setValue('#persona-name', '第二个助手');
  setValue('#persona-text', PERSONA_TEXT_2);

  // 有未保存的改动时换编辑对象：先问一句。点「取消」= 不切，草稿一个字都不动。
  // （草稿只活在字段里、没有按模型分别暂存，所以这里必须拦一下，
  //   否则「点开看看另一个模型」就会把刚写的整段吃掉。）
  setValue('#persona-model', model);
  await waitFor('有草稿时换编辑对象先弹确认', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  await sleep(80);
  check(
    '在确认框点「取消」：编辑对象退回原处，草稿还在',
    byId('persona-model').value === PICKED &&
      byId('persona-name').value === '第二个助手' &&
      byId('persona-text').value === PERSONA_TEXT_2,
    `${byId('persona-model').value} / ${byId('persona-name').value}`
  );

  click('#btn-save-persona');
  await waitFor('保存另一个模型的人设后弹窗关闭', () => !shown('#persona-modal'));
  await sleep(150);

  const savedByPick = (await window.mimitale.getSettings()).settings.assistantPersonas || {};
  check(
    '挑着模型存：这一份进了选中的那个模型，原来那份没被动',
    (savedByPick[PICKED] || {}).name === '第二个助手' &&
      (savedByPick[PICKED] || {}).persona === PERSONA_TEXT_2 &&
      (savedByPick[model] || {}).name === '烟测助手' &&
      !savedByPick['另一个模型'],
    JSON.stringify(savedByPick)
  );
  check(
    '入口那行摘要说的仍是「当前在用」那个模型，不是刚编辑的那个',
    hintText().includes('另一个模型') && /未设置/.test(hintText()),
    hintText()
  );

  click('#btn-close-settings');
  await waitFor('设置弹窗关闭', () => !shown('#settings-modal'));

  // 「另一个模型」没配人设 = 通用助手连名字都没有 —— 标题不该硬套一个内置假名
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);
  const anonTitle = ($('#messages .empty h2') || {}).textContent || '';
  check('没配名字时空状态标题不提名字', anonTitle === '开始聊天吧～', anonTitle);

  if (convo) convo.model = model;
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  // --- 5) 真的聊一句，注入内容交给宿主侧 probe 断言 ---
  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', '你好');
  click('#btn-send');
  await waitFor('通用助手回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式结束', () => byId('btn-send').disabled === false, 8000);
});

await scenario('消息操作按钮：平时收起来、悬停才浮出', async () => {
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);
  const viewMod = await import(new URL('js/views/viewSwitch.js', document.baseURI).href);

  viewMod.showView('chat');

  // 得切到一条**有消息**的会话上（前面场景新建的那条是空的）
  const withMsgs = stateMod.state.conversations.find((c) => (c.messages || []).length >= 2);
  check('能找到一条有消息的会话用来验按钮', !!withMsgs);
  if (!withMsgs) return;

  stateMod.state.activeId = withMsgs.id;
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const actions = $('#messages .msg .msg-actions');
  check('消息上有操作栏', !!actions);
  if (!actions) return;

  // 平时是透明的（靠 .msg:hover 浮出来）。真鼠标悬停那一条在宿主侧的探针里。
  check(
    '操作按钮不悬停时不露头',
    getComputedStyle(actions).opacity === '0',
    getComputedStyle(actions).opacity
  );
  // 操作栏里那几颗按钮（复制 / 删除 / 分支）的排版 —— 数一下别是空的
  check(
    '操作栏里有按钮',
    actions.querySelectorAll('.mini-btn').length >= 2,
    String(actions.querySelectorAll('.mini-btn').length)
  );
});

// ---------------------------------------------------------------------------
//  请求记录（顶栏「⋯」→ 请求记录）
//
//  它回答的是「这几轮到底给模型发了什么」。数据在主进程内存里（main/request-log.js），
//  所以页面侧只验「列表有没有、详情是不是原文、清空管不管用」——
//  「记下来的那一份对不对」在宿主侧的 probeRequestLog 里（页面看不到真正发出去的东西）。
// ---------------------------------------------------------------------------
await scenario('请求记录：列表、原文 JSON、清空', async () => {
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);

  // 先发一条带标记的消息：最新那条记录就认得出来是哪一次
  const MARK = '请求记录标记语';
  convMod.createConvo(true);
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', MARK);
  click('#btn-send');
  await waitFor('这一轮回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式结束', () => byId('btn-send').disabled === false, 8000);

  // --- 1) 从「⋯」里打开，最新一条排在最前 ---
  await clickMoreItem('#btn-request-log');
  await waitFor('请求记录弹窗打开', () => shown('#requests-modal'));

  const items = $$('#requests-list .requests-item');
  check('刚才那一轮被记下来了', items.length >= 1, `列表里 ${items.length} 条`);

  const first = items[0];
  check(
    '最新一条排在最前面，认得出是我刚发的那句',
    !!first && first.textContent.includes(MARK),
    first ? first.textContent.slice(0, 50) : '（列表是空的）'
  );

  // --- 2) 点开看原文 ---
  if (first) click(first);
  await sleep(60);
  const json = byId('requests-json').textContent;
  check('详情里是我刚那轮的原文 JSON', json.includes(MARK), json.slice(0, 70));
  // 只断言这几个字段「在」—— 它们正是和官方网页版最容易不一样的地方
  check(
    '原文里带着 stream / temperature / max_tokens',
    json.includes('"stream"') && json.includes('"temperature"') && json.includes('"max_tokens"'),
    json.slice(0, 110)
  );
  check('有内容时「复制 JSON」可用', byId('btn-copy-request').disabled === false);

  // --- 3) 清空 ---
  click('#btn-clear-requests');
  await sleep(150);
  check('清空后列表空了', $$('#requests-list .requests-item').length === 0);
  check('清空后「复制 JSON」禁用', byId('btn-copy-request').disabled === true);

  // --- 4) 关掉，别挡着后面的场景 ---
  click('#btn-close-requests');
  await waitFor('请求记录弹窗关掉', () => !shown('#requests-modal'));
});

return { results, notes, hoverProbe };
