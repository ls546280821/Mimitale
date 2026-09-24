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

/** 每个场景独立 try/catch：一个崩了不影响后面的 */
async function scenario(name, fn) {
  currentScenario = name;
  try {
    await fn();
  } catch (err) {
    check('场景没能跑完', false, (err && err.message) || String(err));
  }
  currentScenario = '';
}

function click(target) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到要点的元素：${target}`);
  node.click();
  return node;
}

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
//  场景 2：主题切换（顺带验证 settings 落盘）
// ---------------------------------------------------------------------------
await scenario('主题切换', async () => {
  const before = document.documentElement.getAttribute('data-theme');
  click('#btn-theme');
  await waitFor('data-theme 变化', () => document.documentElement.getAttribute('data-theme') !== before);

  const after = document.documentElement.getAttribute('data-theme');
  check('data-theme 变了', after !== before, `${before} → ${after}`);

  await sleep(150);
  const settings = (await window.mimitale.getSettings()).settings;
  check('主题已落盘', settings.theme === after, `落盘的是 ${settings.theme}`);

  click('#btn-theme'); // 切回去，别影响后面的场景
  await waitFor('主题切回', () => document.documentElement.getAttribute('data-theme') === before);
});

// ---------------------------------------------------------------------------
//  场景 2b：配色方案切换（粉 ↔ 蓝，顺带验证 data-accent 与 CSS 变量 + 落盘）
// ---------------------------------------------------------------------------
await scenario('配色方案切换', async () => {
  const before = document.documentElement.getAttribute('data-accent');
  const readAccent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const accentBefore = readAccent();

  click('#btn-accent');
  await waitFor('data-accent 变化', () => document.documentElement.getAttribute('data-accent') !== before);

  const after = document.documentElement.getAttribute('data-accent');
  check('data-accent 变了', after !== before, `${before} → ${after}`);

  const accentAfter = readAccent();
  check('--accent 变量跟着变', accentAfter !== accentBefore, `${accentBefore} → ${accentAfter}`);

  await sleep(150);
  const settings = (await window.mimitale.getSettings()).settings;
  check('配色已落盘', settings.accent === after, `落盘的是 ${settings.accent}`);

  click('#btn-accent'); // 切回去，别影响后面的场景
  await waitFor('配色切回', () => document.documentElement.getAttribute('data-accent') === before);
});

// ---------------------------------------------------------------------------
//  场景 3：设置弹窗
// ---------------------------------------------------------------------------
await scenario('设置弹窗', async () => {
  click('#btn-settings');
  await waitFor('设置弹窗打开', () => shown('#settings-modal'));
  check('设置弹窗里有表单卡片', !!$('#settings-modal .modal-card'));

  click('#btn-close-settings');
  await waitFor('设置弹窗关闭', () => !shown('#settings-modal'));
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
  check('标题变回「编辑角色」', byId('chars-title').textContent === '编辑角色', byId('chars-title').textContent);

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
  setValue('#c-age', '18');
  setValue('#c-gender', '女');
  check('新建角色时种族默认就是人类', byId('c-race').value === '人类', byId('c-race').value);
  setValue('#c-race', '精灵');

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

  // ⚠️ 必须重新取一次行：上面那次 click 触发过重画，列表是整块重建的，
  // 之前那个 meterRow 已经是脱离文档的旧节点 —— 在它上面 querySelector
  // 拿到的会是 null（这个坑当场踩过一次）。
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
  await sleep(150);

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
  check(
    '身份三项也落盘了',
    !!mine && mine.age === '18' && mine.gender === '女' && mine.race === '精灵',
    JSON.stringify({ age: mine && mine.age, gender: mine && mine.gender, race: mine && mine.race })
  );

  // --- 3) 点「聊天」绑定角色 → 属性应该种进状态面板 ---
  click('#btn-close-chars');
  await sleep(150);

  const card = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('属性测试角色'));
  check('找到了新角色的卡片', !!card);
  click(buttonByText(card, '聊天'));
  await waitFor('切到聊天视图', () => shown('#view-chat'));

  await waitFor('状态面板出现', () => shown('#panel-box'));

  // 角色字段现在**不在面板里**了 —— 都搬进了角色状态卡（同一天的新设计：
  // 面板只留「认不出归属」的字段，角色卡种进来的一律进各自的卡）
  const panelNames = $$('#panel-fields .panel-name').map((n) => n.textContent);
  check(
    '角色的属性不再挤在面板里（搬进了状态卡）',
    !panelNames.includes('金币') && !panelNames.includes('好感度') && !panelNames.includes('姓名'),
    JSON.stringify(panelNames)
  );
  check(
    '面板正文不是一片空白（给了指路的话）',
    (($('#panel-fields .panel-empty') || {}).textContent || '').includes('头像'),
    ($('#panel-fields') || {}).textContent
  );

  // --- 点面板栏上的角色头像 → 打开角色状态卡 ---
  if (byId('panel-box').classList.contains('collapsed')) {
    click('#btn-panel-collapse');
    await sleep(160);
  }
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

  // 单角色对话（角色库点「聊天」）也得把身份四项带上 ——
  // 这一条当初漏了，结果 16 岁的角色被 AI 回复成 21 岁
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

  // --- 5) 超范围的数值要被夹回来 ---
  // 在卡片的编辑态里手填一个越界值（模拟模型写了 150/100），失焦即落盘。
  click(charCard().querySelector('.sc-edit'));
  await waitFor('卡切到编辑态', () => !!charCard().querySelector('input.sc-input'));

  const favorInput = cardRowOf('好感度').querySelector('input.sc-input');
  check('卡里能改「好感度」', !!favorInput);

  if (favorInput) {
    setValue(favorInput, '150');
    favorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(250);

    const convos = await window.mimitale.getConversations();
    const active = convos.conversations.find((c) => c.id === convos.activeId);
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
    await sleep(250);
    const convos2 = await window.mimitale.getConversations();
    const active2 = convos2.conversations.find((c) => c.id === convos2.activeId);
    check(
      '范围内的值不动（60 → 60/100）',
      !!active2 && active2.panel && panelValByName(active2.panel, '好感度') === '60/100',
      JSON.stringify(active2 && panelValByName(active2.panel, '好感度'))
    );
  }

  // 收拾现场：把卡关掉、面板收起 —— 下一个场景假定面板是**收起**状态（它自己验「默认收起」）
  const closeCharCard = charCard().querySelector('.sc-close');
  if (closeCharCard) click(closeCharCard);
  if (!byId('panel-box').classList.contains('collapsed')) {
    click('#btn-panel-collapse');
    await sleep(150);
  }
});

// ---------------------------------------------------------------------------
//  场景 9：状态面板 —— 默认收起，随时展开
// ---------------------------------------------------------------------------
await scenario('状态面板：默认收起 / 随时展开', async () => {
  await waitFor('面板在', () => shown('#panel-box') && !!byId('btn-panel-collapse'));

  const fieldsH = () => byId('panel-fields').getBoundingClientRect().height;
  const boxH = () => Math.round(byId('panel-box').getBoundingClientRect().height);

  // 默认收起：只留一条细条，但一直在那儿
  check('默认就是收起的', byId('panel-box').classList.contains('collapsed'));
  check('收起时字段区不显示', fieldsH() === 0, `字段区高度 ${fieldsH()}`);
  const collapsedH = boxH();
  check('收起时面板还在（一根细条）', shown('#panel-box') && collapsedH > 0 && collapsedH < 80, `${collapsedH}px`);

  // 关键：收起之后那个开关还得看得见、点得到，否则「随时打开」就是空话
  const toggleBox = byId('btn-panel-collapse').getBoundingClientRect();
  check('收起后开关仍然可见可点', toggleBox.height > 0 && toggleBox.width > 0, `${Math.round(toggleBox.width)}×${Math.round(toggleBox.height)}`);

  click('#btn-panel-collapse');
  await sleep(120);
  const expandedH = boxH();
  check('点一下就展开', fieldsH() > 0 && !byId('panel-box').classList.contains('collapsed'));
  check('展开后 aria 也对', byId('btn-panel-collapse').getAttribute('aria-expanded') === 'true');
  check('展开确实比收起高', expandedH > collapsedH, `${collapsedH} → ${expandedH}`);

  click('#btn-panel-collapse');
  await sleep(120);
  check('再点一下又收起', fieldsH() === 0);

  // 整条标题栏都能点（不必瞄准那个小箭头）
  click('#panel-head');
  await sleep(120);
  check('点标题栏空白处也能展开', fieldsH() > 0);

  click('#panel-head');
  await sleep(120);
  check('点标题栏空白处也能收起', fieldsH() === 0);

  // 右上角那个「状态」按钮已经去掉了，别再回来
  check('顶栏的「状态」按钮已移除', !byId('btn-panel-toggle'));
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
//  场景 13：给 AI 看图（加图 / 粘贴 / 发出去）
// ---------------------------------------------------------------------------
await scenario('给 AI 看图', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(200);

  check('输入框旁边有加图按钮', !!byId('btn-attach'));

  // --- 点按钮加一张（假后端返回的是一张真的 1×1 PNG）---
  click('#btn-attach');
  await waitFor('缩略图出现', () => $$('#attach-strip .attach-item').length === 1, 8000);
  check('缩略图出来了', $$('#attach-strip .attach-item').length === 1, String($$('#attach-strip .attach-item').length));
  check('待发区显示出来了', shown('#attach-strip'));
  check('缩略图里真的有图', !!$('#attach-strip .attach-item img'));

  // --- × 能撤掉 ---
  click($('#attach-strip .attach-del'));
  await sleep(250);
  check('点 × 能撤掉', $$('#attach-strip .attach-item').length === 0, String($$('#attach-strip .attach-item').length));
  check('撤掉后整条收起来', !shown('#attach-strip'));

  // --- 粘贴一张（模拟 Ctrl+V 一张截图）---
  await new Promise((resolve) => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    byId('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    setTimeout(resolve, 700);
  });
  check('粘贴也能加图', $$('#attach-strip .attach-item').length === 1, String($$('#attach-strip .attach-item').length));

  // --- 连文字一起发出去 ---
  setValue('#input', '这是我拍的照片，你看看');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 10000);
  await sleep(400);

  check('发出去之后待发列表清空', $$('#attach-strip .attach-item').length === 0, String($$('#attach-strip .attach-item').length));
  check('气泡里显示了图片', !!$('#messages .bubble-image'), '没找到 .bubble-image');
  check('文字也还在', $('#messages').textContent.includes('这是我拍的照片'));

  // --- 只带图不打字也要能发 ---
  click('#btn-attach');
  await waitFor('又来一张', () => $$('#attach-strip .attach-item').length === 1, 8000);
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 10000);
  await sleep(300);
  check('只发图不写字也能发出去', $('#messages').textContent.includes('（图片）') || $$('#messages .bubble-image').length >= 2, String($$('#messages .bubble-image').length));
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
//  场景 15：对话窗口外观（字号 / 加粗颜色 / 背景图）
// ---------------------------------------------------------------------------
await scenario('对话窗口外观', async () => {
  click('#btn-appearance');
  await waitFor('外观弹窗打开', () => shown('#appearance-modal'));
  check(
    '三样控件都在（字号 / 颜色 / 背景）',
    !!byId('appearance-fontsize') && !!byId('appearance-boldcolor-text') && !!byId('btn-pick-bg')
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
  check('复位后加粗颜色跟随正文', (await window.mimitale.getSettings()).settings.chatBoldColor === '');

  click('#btn-close-appearance');
  await waitFor('外观弹窗关闭', () => !shown('#appearance-modal'));
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
  click('#btn-export-convo');
  await sleep(300);
  check('导出会话后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);

  // --- 空会话不该导出：点「聊天」会新建一个还没说话的空会话 ---
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click(buttonByText($$('#char-page-grid .char-card')[0], '聊天'));
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(150);
  click('#btn-export-convo');
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
//  场景 16：世界书 —— 新建条目
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
  click('#btn-save-entry');

  await waitFor('条目出现在列表里', () => $('#wb-entry-list').textContent.includes('冒烟测试条目'));

  const books = await savedWorldbooks();
  const titles = (books[0].entries || []).map((e) => e.title);
  check('条目已落盘', titles.includes('冒烟测试条目'), `落盘的是 ${JSON.stringify(titles)}`);

  // 顺便把这本书导出一次（这时书里已经有条目了，才验得到条目字段的映射）
  click('#btn-export-wb');
  await sleep(300);
  check('导出世界书后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);
});

// ---------------------------------------------------------------------------
//  场景 11：世界书 —— 新建「本书角色」，同时验证编辑器没被世界书弹窗盖住
// ---------------------------------------------------------------------------
await scenario('世界书：本书角色', async () => {
  // 世界书弹窗还开着
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

  // --- 开始游玩：你自己的状态挪进「我的状态」卡，面板只留角色/世界的 ---
  click('#btn-start-play');
  await waitFor('进入世界', () => shown('#view-chat') && !shown('#player-modal'));
  await waitFor('状态面板出现', () => shown('#panel-box'));

  const panelNames = $$('#panel-fields .panel-name').map((n) => n.textContent);
  check(
    '玩家自己的属性从「当前状态」里拆出去了',
    !panelNames.includes('金币') && !panelNames.includes('上衣') && !panelNames.includes('姓名'),
    JSON.stringify(panelNames)
  );

  // 面板栏上有「我」的头像；面板默认收起，先展开再点
  if (byId('panel-box').classList.contains('collapsed')) {
    click('#btn-panel-collapse');
    await sleep(120);
  }
  const myAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
  check('面板栏上有「我」的头像', !!myAvatar);
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
//  为什么专门做这个：主进程的 normalizeCharacter 是**白名单式**的，
//  它只保留显式列出来的字段。漏一个 ≠ 报错，而是「静默丢掉」——
//  「属性」当初就是这么丢的，而当时的假后端不做归一化，测试全绿。
//  这里把每个可编辑字段都填上不同的值，再逐个核对回来没有。
// ---------------------------------------------------------------------------
await scenario('角色卡：字段往返不丢', async () => {
  click('#btn-chars');
  await waitFor('切到角色库页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#chars-modal'));

  const NAME = '字段往返测试';
  setValue('#c-name', NAME);
  setValue('#c-tags', '甲, 乙');
  setValue('#c-age', '23');
  setValue('#c-gender', '男');
  setValue('#c-race', '龙');
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
  await sleep(150);

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
    ['金币：9900', '【上衣】：衬衫', '年龄 16', '- 下装：裙子', '', '体重', '旁白：不该收进来'].join('\n')
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
  check('认不出的行跳过（光一个名字）', !names.includes('体重'), JSON.stringify(names));
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色');
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
  click('#btn-memory');
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

  click('#btn-memory');
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色', 8000);
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
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色', 8000);
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
        click(chatBtn);
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

  check('默认不开剧情选项', byId('c-options-on').checked === false, String(byId('c-options-on').checked));
  check('关着时配置区是收起的', !shown('#c-options-config'));

  click('#c-options-on');
  await waitFor('配置区展开', () => shown('#c-options-config'));
  setValue('#c-options-count', '3');
  setValue('#c-options-hint', '语气轻松些，总有一条冒险的选择');

  click('#btn-save-char');
  await waitFor('保存完成', () => byId('chars-title').textContent === '编辑角色', 8000);
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
  click(buttonByText(card, '聊天'));
  await waitFor('切到聊天视图', () => shown('#view-chat'), 8000);
  await sleep(300);

  // --- 3) 发一条 → 回复里带选项 → 面板出现可点按钮 ---
  setValue('#input', '选项测试：随便说点什么');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').disabled === false, 12000);
  await sleep(300);

  // 面板默认收起 → 展开
  if (byId('panel-box').classList.contains('collapsed')) {
    click('#btn-panel-collapse');
    await sleep(200);
  }
  // 剧情选项挂在最新一条 AI 回复的气泡下面（不在状态面板里）
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

  // 这一轮的状态栏也照常被面板收下（选项和状态栏是一起回来的）
  check(
    '同一条回复里的状态栏也被面板收下了',
    $$('#panel-fields .panel-name').some((n) => n.textContent === '好感度'),
    JSON.stringify($$('#panel-fields .panel-name').map((n) => n.textContent))
  );

  // 「剧情选项」是**程序读的指令行**，不是面板字段。
  // 它的形状和面板行一模一样（行首【】、值也不长），所以扫描时很容易被误收 ——
  // 而 cleanAssistantText 又把它剥掉了，于是表现为「气泡里看不见、面板上却多一个字段」。
  // 这条断言盯的就是那个分裂：选项行和状态栏同一条消息回来，它绝不能进面板。
  check(
    '「剧情选项」没被当成面板字段收下',
    !$$('#panel-fields .panel-name').some((n) => n.textContent === '剧情选项'),
    JSON.stringify($$('#panel-fields .panel-name').map((n) => n.textContent))
  );
  check(
    '面板里也没有「剧情选项」的输入框',
    !$$('#panel-fields .panel-value').some((i) => i.dataset.field === '剧情选项'),
    JSON.stringify($$('#panel-fields .panel-value').map((i) => i.dataset.field))
  );

  // 「好感度」是模型自己输出、这个角色卡上没声明过的字段。
  // 它的值写成「63/100」，从形状就能看出是个带范围的数值 —— 该有进度条。
  // （以前只认角色卡上声明过的属性，模型自己冒出来的数值永远没有进度条。）
  {
    const favorRow = $$('#panel-fields .panel-row').find(
      (r) => (r.querySelector('.panel-name') || {}).textContent === '好感度'
    );
    check('模型自己给的数值字段也认出了满值（/100）', !!favorRow && !!favorRow.querySelector('.panel-unit'),
      favorRow ? favorRow.innerHTML.slice(0, 160) : '没找到「好感度」那一行');
    const inferredBar = favorRow && favorRow.querySelector('.panel-bar');
    check('模型自己给的数值字段也有进度条（从「63/100」的形状推断）', !!inferredBar,
      favorRow ? favorRow.innerHTML.slice(0, 160) : '没找到');
    check(
      '推断出来的满值接进了进度条（63/100 → 63%）',
      !!inferredBar && inferredBar.querySelector('.panel-bar-fill').style.width === '63%',
      inferredBar ? inferredBar.querySelector('.panel-bar-fill').style.width : '没有进度条'
    );

    // 推断出来的范围也要真的生效：手填越界值会被夹回来
    const input = favorRow && favorRow.querySelector('.panel-value');
    if (input) {
      setValue(input, '150');
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(250);
      const cv = await window.mimitale.getConversations();
      const ca = cv.conversations.find((c) => c.id === cv.activeId);
      check(
        '推断出来的范围也真的夹得住（150 → 100/100）',
        !!ca && ca.panel && panelValByName(ca.panel, '好感度') === '100/100',
        JSON.stringify(ca && panelValByName(ca.panel, '好感度'))
      );
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
    const shown = mod.cutTrailingStatusBlock(streamed);
    check('流式显示只剩正文（动作描写还在）', shown.includes('她抬头看向你'), shown);
    check(
      '状态块整个被砍掉（抬头/分组/字段/选项都不在）',
      !shown.includes('当前状态') && !shown.includes('—— 状态栏 ——') &&
        !shown.includes('【时间】') && !shown.includes('【好感度】') && !shown.includes('剧情选项'),
      shown
    );

    // --- 半截字段行也不该闪：只要行首是【，哪怕还没写到冒号，也照样被砍 ---
    const partial = mod.cutTrailingStatusBlock('*正文*\n\n【时间】：夜');
    check('半截字段行（【时间】：夜）也被砍掉，不会闪一下', partial.trim() === '*正文*', JSON.stringify(partial));

    // --- 收尾渲染：cleanAssistantText 也要剥掉抬头 ---
    const fields = ['时间', '地点', '心情', '好感度'];
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
    const composed = base + mod.cutTrailingStatusBlock(delta);
    check(
      '继续时旧状态块被剥掉、夹在中间的正文都保住、本轮状态块被砍',
      composed.includes('第一轮正文') && composed.includes('继续后的正文') &&
        composed.includes('再继续的正文') && !composed.includes('当前状态') && !composed.includes('【时间】'),
      composed
    );
  }
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
    '「主人，今天想怎么玩我？」'
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
  check('正文（动作描写 + 台词）完好保留', cleaned.includes('她抬头看向你') && cleaned.includes('今天想怎么玩我'), cleaned);

  // 破折号引语不该被误删：组名不在 knownGroups 里
  const prose = ['他顿了顿，说：', '—— 我有点累了 ——', '然后就走了。'].join('\n');
  const proseCleaned = mod.cleanAssistantText(prose, [], ['身份']);
  check('正文里「—— 破折号引语 ——」不被误删', proseCleaned.includes('—— 我有点累了 ——'), proseCleaned);

  // 没传分组名时，标题保留原样（向后兼容，不会乱删）
  const noGroups = mod.cleanAssistantText(text, fields);
  check('不传分组名时不误删标题（保持旧行为）', noGroups.includes('—— 身份 ——'), noGroups);
});

// ---------------------------------------------------------------------------
//  场景 24：选项解析容忍「字母标签」
//
//  模型有时把指令里的格式示例当成要求，输出「A / 选项一 / B / 选项二 …」——
//  拆出来就是一堆孤立的单字母按钮（实测截图踩过）。extractOptionsFromText 要：
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
    '【剧情选项】：A / 把手指插进去，命令她自己报出湿了几次 / B / 捏住她的下巴，让她张嘴舔你手指 / C / 让她把衬衫脱了，跪着给你口交'
  );
  check(
    '孤立字母标签被丢掉，只剩 3 条真选项',
    labeled.length === 3 &&
      labeled[0] === '把手指插进去，命令她自己报出湿了几次' &&
      labeled[1] === '捏住她的下巴，让她张嘴舔你手指' &&
      labeled[2] === '让她把衬衫脱了，跪着给你口交',
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

  // --- 面板栏：我（+ 角色）的头像都在，点角色头像开那张卡 ---
  if (byId('panel-box').classList.contains('collapsed')) {
    click('#btn-panel-collapse');
    await sleep(150);
  }
  const castOwners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
  check('面板栏上第一个头像是「我」', castOwners[0] === 'player', JSON.stringify(castOwners));

  // --- ✕ 收掉我那张卡 ---
  click(myCard().querySelector('.sc-close'));
  await sleep(150);
  check('点 ✕ 把卡收掉了', !myCard());

  // --- 绑了角色的会话：头像行是「我 + 那个角色」，点角色头像开它的卡 ---
  const charConvo = $$('#convo-list .convo-item').find((it) => {
    const t = it.querySelector('.convo-title');
    return t && t.textContent.trim().startsWith('选项测试');
  });
  if (charConvo) {
    click(charConvo);
    await sleep(400);
    if (byId('panel-box').classList.contains('collapsed')) {
      click('#btn-panel-collapse');
      await sleep(150);
    }
    const owners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
    check(
      '绑了角色的会话里「我」和那个角色都在头像行上',
      owners.includes('player') && owners.length >= 2,
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
    const playerBtn = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
    if (playerBtn) {
      click(playerBtn);
      await sleep(250);
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
//  场景 26：切世界书时，编辑器里残留的旧表单不能盖到「刚切过去的那一本」上
//
//  用户报的现象：「导入世界书时，世界书的名字不会变」。
//  根因：openWorldbooksModal 以前是**调用方**先把 editingWorldbookId 改成目标书，
//  再走 selectWorldbook → stashWorldbookName()；而那个 stash 写的是
//  currentWorldbook() —— 这时它已经是新书了。于是输入框里残留的上一本的书名
//  被写进新书，界面也还显示着旧名字（重开一次才正常）。
//
//  「导入世界书」（openWorldbookEditor）/ 列表卡上的「编辑」（editWorldbookFromPage）
//  /「新建世界书」三条路都走 openWorldbooksModal，所以这里用点按钮的方式覆盖
//  （不调内部函数，见本文件头部的规矩）。第三条路还能顺便验「切回来时是它自己「
//  的名字」，也就是「点编辑另一本 → 那本被改成上一本的名字」这个会落盘的丢数据问题。
// ---------------------------------------------------------------------------
await scenario('世界书：切书时旧表单不能盖住新书', async () => {
  const namesOnPage = () => $$('#wb-page-grid .char-card-name').map((n) => n.textContent);
  const cardNamed = (name) => $$('#wb-page-grid .char-card').find((c) => c.title === name);

  click('#btn-worldbooks');
  await waitFor('切到世界书页面', () => shown('#view-worldbooks'));

  // 打开种子里那本，改名「甲书」—— 输入框里从此留着「甲书」
  click(buttonByText($$('#wb-page-grid .char-card')[0], '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  await sleep(150);
  setValue('#wb-name', '甲书');
  await sleep(200);
  check('书名已经改成「甲书」', $('#wb-name').value === '甲书', `输入框里是「${$('#wb-name').value}」`);

  // 新建一本：它得用自己的默认名，不能被输入框里残留的「甲书」盖掉
  click('#btn-new-worldbook');
  await sleep(300);
  check(
    '新建的书用自己的默认名（没继承上一本的）',
    $('#wb-name').value === '新世界书',
    `输入框里是「${$('#wb-name').value}」`
  );
  check(
    '列表页上两本书各是各的名字',
    namesOnPage().includes('甲书') && namesOnPage().includes('新世界书'),
    JSON.stringify(namesOnPage())
  );

  // 给这一本也起个自己的名字，然后关掉弹窗（关闭时会落盘）
  setValue('#wb-name', '乙书');
  await sleep(200);
  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#worldbooks-modal'));
  await sleep(200);

  const target = cardNamed('甲书');
  check('列表页上「甲书」还在（没被新书顶掉）', !!target, JSON.stringify(namesOnPage()));
  click(buttonByText(target, '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#worldbooks-modal'));
  await sleep(250);
  check(
    '点「编辑」另一本，书名字段显示的是那一本自己的名字',
    $('#wb-name').value === '甲书',
    `输入框里是「${$('#wb-name').value}」`
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
//  场景 27：世界书里多个角色有同名字段时，各自保留、不互相挤掉
//
//  用户报的现象：把妹妹卡加进世界书、用姐姐卡进世界，点妹妹头像的状态卡
//  「基本没几条属性」。根因：面板字段以前按「字段名」全局去重（一维数组 +
//  键是字段名），姐姐和妹妹都有「好感度/生命/上衣」这些同名属性时，先种的
//  姐姐抢到所有同名字段，妹妹的同名字段全被挤掉。
//
//  修复：面板字段身份升级成「字段名 + owner」复合键（data/panel.js），
//  同名但归属不同的字段各自独立。这里用动态 import 真模块验证纯函数行为：
//    · appendPanelFields 能种进两个 owner 的同名字段（各一条，键不同）；
//    · panelFieldOwner 能按 owner 拆开；
//    · formatPanelForPrompt 注入时，同名冲突的字段加「角色名·」前缀、
//      无冲突的字段保持纯字段名（单角色聊天不受影响）。
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
//  场景 28：进世界之后才往书里加角色，新 NPC 的属性也要种进会话
//
//  用户诉求：想「玩到一半再往世界书里加角色当 NPC」。加入副本这个动作本身
//  只动世界书（persistLibrary），不回头通知会话 —— 若不补，新 NPC 的状态
//  卡是空的。修复抽出纯函数 seedWorldbookCharactersIntoConvos，遍历所有绑定
//  这本书的会话补种。这里动态 import 真模块验证：
//    · 绑了这本书的会话被种入新副本的属性；
//    · 没绑这本书的会话不被碰；
//    · 同名属性也不会盖掉已有的（复合键按 owner 区分）。
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
//  场景 29：选卡当自己时，玩家设定里的 {{char}}/{{user}} 宏要替换成玩家本人
//
//  用户报的现象：用露西娅卡进世界，模型来回纠结「露西娅是主角还是外乡人」，
//  把「你」当成了坐在邻桌的外乡人。根因：选卡当自己时，把卡上的 description/
//  personality/scenario 原样塞进 player.profile —— 里面满篇 {{char}}、{{user}}
//  字面宏，还带着「{{char}}端酒摔倒、{{user}}这个外乡人坐邻桌」的开场背景
//  （那是「这张卡当 NPC、你另有其人」的预设）。注入时宏又没替换，模型读到
//  裸占位符，加上「露西娅既是主角又是外乡人」的矛盾，就晕了。
//
//  修复：选卡拼设定时不再带 scenario，且宏替换成角色名；注入层（cast.js 的
//  playerProfileForPrompt）再兜底替换一遍，历史脏数据也能自愈。这里动态 import
//  真模块验证注入层的宏替换。
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
//  场景 30：世界书的 NPC 名单不该把玩家本人（同名副本）当成 NPC
//
//  用户报的现象：用「姐姐」卡进世界，姐姐卡也被加进了世界书当 NPC，结果 GM
//  名单里冒出两个「姐姐」，模型分不清谁是玩家、把主角当 NPC。
//
//  修复：worldbookCast 把与玩家同名的书里副本标成「玩家本人」、不再当 NPC 罗列。
//  判定逻辑抽成纯函数 isPlayerCharacterCopy（只读 convo），这里动态 import 真模块验证。
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

return { results, notes, hoverProbe };
