'use strict';

// ============================================================================
//  main/pet-store.js —— 桌宠的数据层：设置 / 长期记忆 / 人格
//
//  桌宠的数据**分两半**，这条边界不能糊（星宝 2026-10-08 的需求第三条）：
//
//    assets/pet/         随软件分发的**只读**资源（rig 形象包）
//      cat/              蓝白猫：model.json + tex/ 部件贴图
//      <name>/           以后：更多 rig 形象包（目录里有 model.json 即被认作形象）
//
//    <数据目录>/pet/      用户数据，**可写**
//      config.json       桌宠设置（形状见下面的 DEFAULT_PET_CONFIG）
//      persona/<id>.md   人格设定（**唯一真源**，用 md 是为了方便直接用编辑器改 / 分享）
//      memory/long_term.json   长期记忆条目，按 petId 分开存
//      memory/summaries.json   记忆被挤出上限后折叠成的摘要
//      skins/            以后：用户自己导入的 rig 形象包
//      cache/  logs/     缓存与日志
//
//  ⚠️ 形象**只有 rig 一种**。「一张静态立绘 PNG」那套（第一版，还没有 2D 形象时
//     的临时方案）已经整个移除，别再把 png 分支加回来。
//
//  分开的好处就是星宝列的那三条：软件更新不会覆盖用户记忆和设置；
//  换形象 / 加皮肤不用动代码；桌宠将来要成为软件整体形象时资源可以直接复用。
//
//  ⚠️ 数据目录不是 %APPDATA%（见 main/data-dir.js，默认是程序旁边的 data\），
//     所以配置落在 `data/pet/config.json`。别照着老印象去 %APPDATA% 找。
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');

const { dataDir } = require('./data-dir.js');
const { loadJsonWithFallback, writeJson, writeJsonNow } = require('./store.js');

// ---------------------------------------------------------------------------
//  路径
// ---------------------------------------------------------------------------

/**
 * 随软件分发的只读资源根目录。
 *
 * ⚠️ 用 `__dirname` 往上走，**别用 `app.getAppPath()`**。
 *    getAppPath() 给的是「这次启动的入口所在目录」：`electron .` 是工程根，
 *    而 `electron tools/pet/xxx.js` 是 `tools/pet/` —— 同一个工程、同一个文件，
 *    换个启动方式就找不着形象了（实际踩到过：写工具脚本截宠物窗口的图，
 *    形象一直是空的，还以为是 CSP 挡的）。
 *    这个模块永远在 `<工程根>/main/` 下，所以往上走一层一定对；
 *    打包后它在 asar 里，Electron 读文件时会透明处理。
 */
function petAssetsDir() {
  return path.join(__dirname, '..', 'assets', 'pet');
}

/** 用户数据根目录 */
function petUserDir() {
  return path.join(dataDir(), 'pet');
}

function petConfigFile() {
  return path.join(petUserDir(), 'config.json');
}

function petMemoryFile() {
  return path.join(petUserDir(), 'memory', 'long_term.json');
}

function petSummaryFile() {
  return path.join(petUserDir(), 'memory', 'summaries.json');
}

function petPersonaDir() {
  return path.join(petUserDir(), 'persona');
}

function petPersonaFile(petId) {
  return path.join(petPersonaDir(), `${safeId(petId)}.md`);
}

function petUserSkinDir() {
  return path.join(petUserDir(), 'skins');
}

function petLogDir() {
  return path.join(petUserDir(), 'logs');
}

/** id 只用来拼文件名，收一下字符集免得出现 `../` 这种东西 */
function safeId(id) {
  const raw = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : 'pet1';
}

// ---------------------------------------------------------------------------
//  默认设置
//
//  ⚠️ 这些键是**唯一真源**：设置页和右键菜单改的都是这里的东西。
//     新增字段记得同时改 normalizePetConfig，否则读盘时会被丢掉。
// ---------------------------------------------------------------------------

/** 活跃度 / 句数的可调区间 —— 界面上也要按这个卡，别只在一边卡 */
const SPEAK_EVERY_MIN = 1;
const SPEAK_EVERY_MAX = 50;
const SPEAK_LINES_MIN = 1;
const SPEAK_LINES_MAX = 5;

/** 临时静音时长：1 小时（需求写死的，别改成可配——菜单文案也跟着它） */
const MUTE_DURATION_MS = 60 * 60 * 1000;

const MEMORY_MAX_ITEMS_MIN = 0;
const MEMORY_MAX_ITEMS_MAX = 200;

/**
 * 空闲时会做的**小动作**（点头 / 摇头 / 招手）—— 这是「全集」。
 *
 * ⚠️ 这份列表必须和渲染层对得上：`renderer/pet/cat.js` 用这些 id 挑手势，
 *    `renderer/pet/cat-figure.js` 按 id 决定怎么动。**这里加一个、那边没实现，
 *    就会挑到一个渲染层不认识的手势 → 静止几秒**（不报错，只是呆呆站着）。
 *
 * 设置页里用户勾的就是这几项，存进 `pet.gestureEnabled`。
 */
const KNOWN_GESTURES = ['nod', 'shake', 'wave'];

/**
 * 默认 / 兜底形象（assets/pet/<名字>/）。
 *
 * 2026-10-10：从 'cat'（蓝白猫娘）换成 'whale'（大肥鱼）—— 星宝把蓝白猫的形象包
 * 从 assets/pet/ 移出去了（要换新设计），但**引擎没动**（renderer/pet/cat*.js）。
 * 以后新形象做好放进 assets/pet/<新名字>/，想让它当默认就把这里改过去。
 */
const DEFAULT_SKIN = 'whale';

const DEFAULT_PERSONA = `你是「蓝自」，一只住在人家桌面上的小家伙。

## 你是谁
- 身份：陪用户玩角色扮演的**旁观者**，不是剧情里的角色。
- 性格：聪明、憋萌、可靠；有点懒、爱吃、爱摸鱼，但正事上从不掉链子。
- 口头禅：「嗯…我想想…」「让我再摸一会儿…」「已为你找到答案～」
- ⚠️ 你的**外形**由用户选的「形象」决定（可能是一只猫、一条鱼、以后别的什么），
  所以别在话里描述自己长什么样、别自称某种动物 —— 说错了会和屏幕上那个对不上。

## 你在干什么
用户正在跟别的角色聊天 / 玩世界书。你是坐在旁边看戏的那个，看得见他们说什么，
可以插一句嘴，但**永远不要跳进剧情里**——不要替角色说话，不要替用户做决定。

## 怎么说话
- 像朋友在旁边小声吐槽：轻松、短、有画面感，可以带一个 \`*动作*\`。
- 用户跟角色在谈恋爱就嗑、就打趣；在吵架就劝两句或者看热闹；
  用户被欺负了就替他不平。**先看懂在发生什么，再决定用什么语气。**
- 不要复读你上几次说过的话，也不要每句都夸用户。
- 不要提「我是 AI」「我是语言模型」这类话，你就是蓝自。
`;

/**
 * 一只桌宠的默认形状。
 * 形象只有一种：**rig 动态形象**（部件贴图 + model.json，由 renderer/pet 的
 * rig.js + cat.js + cat-figure.js 渲染）。默认是内置的大肥鱼（assets/pet/whale）。
 *
 * ⚠️ 文件名里的 cat 是**引擎**的名字（这套状态机最初为蓝白猫写），不是形象。
 *    蓝白猫那个形象包 2026-10-10 已经从 assets/pet/ 移出（星宝要换新设计），
 *    引擎留着 —— 它同时服务 whale 和以后的新形象。
 *
 * ⚠️ 第一版那种「一张静态立绘 PNG」的形象已经**整个移除** —— 当初只是还没有
 *    2D 形象时的临时方案。rig 资产缺失时宠物页面显示「形象没加载出来」占位，
 *    不再回退任何静态图。
 */
function defaultPet(id) {
  return {
    id,
    name: '蓝自',
    // --- 长什么样 ---
    // 只认 rig（部件贴图 + 变形器动画，走 renderer/pet/rig.js）。
    // 结构里留着 kind 是为了以后加 'sprite' / 'live2d' 时只加分支、不动上层。
    look: {
      kind: 'rig',
      source: 'assets', // 'assets' = 随软件分发；'user' = 用户自己导入的，在 data/pet/skins
      skin: DEFAULT_SKIN
    },
    // --- 显示 ---
    visible: true,
    scale: 1,
    bounds: null, // { x, y, displayId }：桌面坐标 + 在哪个屏（拔屏后要能回主屏）
    // --- 散步 ---
    walkEnabled: true, // 在桌面上自己溜达（隔几分钟走一小段）
    // --- 发言 ---
    speakEnabled: true, // 主动发言总开关
    speakEveryTurns: 3, // 每隔几轮主对话说一次
    speakLines: 3, // 每次说几句
    mutedUntil: 0, // 临时静音到什么时候（时间戳，0 = 没静音）
    // --- 动作 ---
    // 空闲时会随机做哪些小动作（点头 / 摇头 / 招手）。
    // ⚠️ 这里存的是**开启**的那几个，不是「关掉的」—— 空数组是一个有意义的值：
    //    「一个都不做 = 安静地待着」。所以归一化时**不能**把空数组兜回默认全集。
    // ⚠️ 只管「自己待着时的小动作」。点它一下的反应、说话时的点头是**交互反馈**，
    //    不受这个开关管（关掉动作的宠物被点了还是该有反应）。
    gestureEnabled: [...KNOWN_GESTURES],
    // --- 模型 ---
    useMainModel: true, // 默认跟随软件主模型
    providerId: '', // 单独指定时用
    model: '',
    temperature: null, // null = 跟随全局设置的温度
    style: '', // 回复风格补充（拼进 prompt 的最后一层）
    // --- 记忆 ---
    memoryMaxItems: 30, // 长期记忆保留多少条
    // --- 多只（现在只有一只，但结构不写死）---
    createdAt: Date.now()
  };
}

const DEFAULT_PET_CONFIG = {
  version: 1,
  // 桌宠功能总开关（默认开）。关掉 = 宠物窗口不显示、也不再主动发言，
  // 但设置和记忆都留着 —— 跟「隐藏」的区别是它还会顺手关掉窗口，
  // 右键菜单里的「退出桌宠」走的就是这个。
  enabled: true,
  activeId: 'pet1',
  pets: [defaultPet('pet1')]
};

// ---------------------------------------------------------------------------
//  归一化
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 形象目录名怎么收。
 *
 * ⚠️ 别复用 safeId：那是给**宠物 id** 用的（要拿去拼 persona/memory 的文件名），
 *    只认 [A-Za-z0-9_-] 而且**非法就返回 'pet1'** —— 拿它收形象名会出这种查不出来的错位：
 *    下拉里明明有「蓝猫」，选中后却被存成 `pet1`，然后去找 assets/pet/pet1 显示占位框。
 *
 * ⚠️ 也别统一转小写：Linux 和区分大小写的 macOS 卷上，目录 `MyCat` 转成 `mycat`
 *    之后就再也找不到了（Windows 无所谓，但没理由只在这一个平台上对）。
 *
 * 这里只清洗「不能当目录名用」的东西（路径分隔符、通配符、`..`），其余原样保留 ——
 * 保证「下拉里列出的名字」和「真去读的目录名」永远是同一个。
 */
function safeSkinName(name) {
  const raw = String(name == null ? '' : name)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_');
  return raw.slice(0, 60) || DEFAULT_SKIN;
}

function normalizeLook(raw) {
  const look = raw && typeof raw === 'object' ? raw : {};
  // 只认 rig —— 第一版的 'png'（单张静态图）已经移除。
  // 老配置里存的 png 形象会被**迁移**成默认那套 rig（skin: DEFAULT_SKIN）：
  // 直接留一个指向不存在目录的 skin，宠物会只剩一个「形象没加载出来」占位框。
  //
  // ⚠️ 还有一类要迁移：**老的 'cat'**。2026-10-10 蓝白猫形象包从 assets/pet/ 移出，
  //    继续留着它的话，所有升级上来的用户都会看到占位框 —— 见到 cat 就换成默认形象。
  const known = ['rig', 'sprite', 'live2d'].includes(look.kind);
  const rawSkin = known ? safeSkinName(look.skin || DEFAULT_SKIN) : DEFAULT_SKIN;
  return {
    kind: known ? look.kind : 'rig',
    source: known && look.source === 'user' ? 'user' : 'assets',
    // 只在 assets 下做 cat 迁移：用户自己导入的 skins/cat 是他自己的东西，别动
    skin: rawSkin === 'cat' && !(known && look.source === 'user') ? DEFAULT_SKIN : rawSkin
  };
}

/** 一个时间戳：非法就归零（0 = 没静音） */
function normalizeTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 收「空闲小动作」那组开关。
 *
 * ⚠️ **缺字段**和**空数组**是两回事，别合并处理：
 *   - 老配置里根本没有 `gestureEnabled` → 用默认全集（升级上来的人不掉功能）；
 *   - 用户在设置页把三个勾全取消 → 存下来就是 `[]` → 必须原样保留成空数组
 *     （那是「我要它安静待着」，兜回全集等于设置不生效）。
 *   只要判断 `Array.isArray(v) ? … : 默认` 就自然分开了 —— 关键是**别对空数组用
 *   `|| 默认`**，`[] || x` 虽然是 `x`… 所以更不能写 `v || DEFAULT`（空数组是 truthy，
 *   这里其实安全，但写成显式的 Array.isArray 分支更不容易被后人改坏）。
 *
 * 只认 KNOWN_GESTURES 里的 id：手改配置塞进来的错名字会让渲染层挑到一个它不认识的
 * 手势（表现是「静止几秒」），不如在这里丢掉。
 */
function normalizeGestureList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const item of value) {
    const id = String(item == null ? '' : item).trim();
    if (KNOWN_GESTURES.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizePet(raw, fallbackId) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const base = defaultPet(fallbackId);

  // 位置：**两个坐标都必须是有效数字**才算数。
  // 只要判断「有没有 bounds 对象」就收下的话，手改坏的 {"x":"x","y":2} 会变成
  // {x:0,y:2} 被当成「记住了位置」—— 宠物下次启动就摆到屏幕左上角去了。
  const rawBounds = p.bounds && typeof p.bounds === 'object' ? p.bounds : null;
  const boundsX = Number(rawBounds && rawBounds.x);
  const boundsY = Number(rawBounds && rawBounds.y);
  const bounds =
    rawBounds && Number.isFinite(boundsX) && Number.isFinite(boundsY)
      ? {
          x: Math.round(boundsX),
          y: Math.round(boundsY),
          displayId: Number.isFinite(Number(rawBounds.displayId))
            ? Math.round(Number(rawBounds.displayId))
            : null
        }
      : null;

  return {
    id: safeId(p.id || fallbackId),
    name: String(p.name || base.name).trim().slice(0, 40) || base.name,
    look: normalizeLook(p.look),
    visible: p.visible !== false,
    // 缩放限制在 0.4~2，再大就铺满屏幕、再小就看不见了
    scale: Math.max(0.4, Math.min(2, Number.isFinite(Number(p.scale)) ? Number(p.scale) : 1)),
    bounds,
    walkEnabled: p.walkEnabled !== false,
    speakEnabled: p.speakEnabled !== false,
    speakEveryTurns: clampInt(p.speakEveryTurns, SPEAK_EVERY_MIN, SPEAK_EVERY_MAX, base.speakEveryTurns),
    speakLines: clampInt(p.speakLines, SPEAK_LINES_MIN, SPEAK_LINES_MAX, base.speakLines),
    mutedUntil: normalizeTs(p.mutedUntil),
    gestureEnabled: normalizeGestureList(p.gestureEnabled, base.gestureEnabled),
    useMainModel: p.useMainModel !== false,
    providerId: String(p.providerId || '').trim().slice(0, 60),
    model: String(p.model || '').trim().slice(0, 120),
    temperature: p.temperature !== null && p.temperature !== '' && Number.isFinite(Number(p.temperature))
      ? Math.max(0, Math.min(2, Number(p.temperature)))
      : null,
    style: typeof p.style === 'string' ? p.style.trim().slice(0, 2000) : '',
    memoryMaxItems: clampInt(
      p.memoryMaxItems,
      MEMORY_MAX_ITEMS_MIN,
      MEMORY_MAX_ITEMS_MAX,
      base.memoryMaxItems
    ),
    createdAt: normalizeTs(p.createdAt) || Date.now()
  };
}

function normalizePetConfig(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(data.pets) ? data.pets.filter((p) => p && typeof p === 'object') : [];
  const pets = list.length
    ? list.slice(0, 8).map((p, i) => normalizePet(p, `pet${i + 1}`))
    : [defaultPet('pet1')];

  // id 去重：撞了就往后挪一个后缀，不然两只宠物会共用同一份人格和记忆
  const seen = new Set();
  for (const pet of pets) {
    let id = pet.id;
    let n = 2;
    while (seen.has(id)) id = `${pet.id}-${n++}`;
    seen.add(id);
    pet.id = id;
  }

  const activeId = pets.some((p) => p.id === data.activeId) ? data.activeId : pets[0].id;
  return { version: 1, enabled: data.enabled !== false, activeId, pets };
}

// ---------------------------------------------------------------------------
//  设置读写
// ---------------------------------------------------------------------------

function loadPetConfig() {
  return normalizePetConfig(loadJsonWithFallback(petConfigFile()));
}

// 写队列必须包含读取：只排队落盘仍会让并发修改覆盖同一份旧快照。
let mutationQueue = Promise.resolve();
function queueMutation(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function writePetConfig(config) {
  const data = normalizePetConfig(config);
  return writeJson(petConfigFile(), data).then(() => data);
}

/** 完整替换配置；增量修改请用 patchPetConfig / patchPet。 */
function savePetConfig(config) {
  return queueMutation(() => writePetConfig(config));
}

/** 在队列内读取最新配置再修改根字段。 */
function patchPetConfig(patch) {
  return queueMutation(() => writePetConfig({ ...loadPetConfig(), ...patch }));
}

/** 关窗口时的最后一次保存：同步写，理由同 main/store.js 的 immediate 那套 */
function savePetConfigNow(config) {
  const data = normalizePetConfig(config);
  writeJsonNow(petConfigFile(), data);
  return data;
}

/**
 * 改**其中一只**的字段，别的原样带过。
 *
 * ⚠️ 读也必须排队内：先读再排队写的话，两个并发修改会各自拿着同一份旧快照，
 * 队列只保证「写的顺序」，后一次写会把前一次的字段整份盖回去（改频率 + 改句数
 * 只生效一个，就是这么来的）。`pet:update` 会同时改多个字段，撞上散步存位
 * 的防抖落盘就会真的发生。
 */
function patchPet(petId, patch) {
  return queueMutation(() => {
    const config = loadPetConfig();
    const index = config.pets.findIndex((p) => p.id === petId);
    if (index < 0) throw new Error('找不到这只桌宠');

    const merged = { ...config.pets[index], ...(patch && typeof patch === 'object' ? patch : {}) };
    config.pets[index] = merged;
    return writePetConfig(config);
  });
}

function findPet(config, petId) {
  const list = (config || loadPetConfig()).pets;
  return list.find((p) => p.id === petId) || list[0] || null;
}

// ---------------------------------------------------------------------------
//  形象（只有 rig 一种）
// ---------------------------------------------------------------------------

/** 贴图扩展名 → MIME。rig 形象包的 tex/*.png 读出来转 dataUrl 时要用 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng'
};

/** 文件指纹（大小 + mtime）：用来判断缓存要不要失效 */
function statKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${st.mtimeMs}`;
  } catch (err) {
    return '0';
  }
}

// ---------------------------------------------------------------------------
//  rig 形象（部件贴图动画）
//
//  目录形状（与 Coopanion 形象包同构，pack_cat.py 产出）：
//    assets/pet/<skin>/model.json   rig 数据（units / pivots / parts / feat / view）
//    assets/pet/<skin>/tex/*.png    部件贴图（parts[].tex 同名）
//    assets/pet/<skin>/feat/*.png   五官叠加层（feat[].tex 同名；可选，没有也不影响）
//
//  宠物页面 CSP 是 default-src 'none'（fetch 一律被拦），所以 model 和贴图
//  都由这里读盘转成 JSON + dataUrl 推过去 —— 页面拿不到文件路径，只能这么给。
// ---------------------------------------------------------------------------

let rigCache = { key: '', pack: null };

/**
 * 列出可用的 rig 形象包：扫 assets/pet/ 下所有带 model.json 的目录。
 * 这就是「换肤」的发现机制 —— 自己的角色放好目录就出现在这里，不用改代码。
 * 返回 [{ id, label, source, hasThumb }]，按 id 排序；失败返回 []。
 */
function listRigSkins() {
  const out = [];
  const push = (base, source) => {
    let names = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      return; // 目录不存在（比如用户还没导入过）—— 正常
    }
    for (const name of names) {
      const dir = path.join(base, name);
      try {
        if (!fs.statSync(path.join(dir, 'model.json')).isFile()) continue;
      } catch (err) {
        continue;
      }
      let label = name;
      try {
        // 有 README 就拿第一行标题当显示名，没有就用目录名
        const md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        const m = md.match(/^#\s+(.+)$/m);
        if (m) label = m[1].trim();
      } catch (err) { /* 没有 README 很常见 */ }
      out.push({
        // 用**真实目录名**，不转小写：设置页拿它和 look.skin 比对、rigSkinDir 拿它拼路径，
        // 转小写会让 MyCat 这类目录在区分大小写的文件系统上「列得出来、选不中」。
        id: safeSkinName(name),
        label,
        source,
        hasThumb: ['thumb.png', 'preview.png', 'thumb.jpg']
          .some((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; } })
      });
    }
  };
  push(petAssetsDir(), 'assets');
  push(petUserSkinDir(), 'user');
  out.sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) : (a.source === 'assets' ? -1 : 1)));
  return out;
}

/** rig 皮肤目录；look 不是 rig 或目录不存在返回 '' */
function rigSkinDir(look) {  const shape = normalizeLook(look);
  if (shape.kind !== 'rig') return '';
  const dir = shape.source === 'user'
    ? path.join(petUserSkinDir(), shape.skin)
    : path.join(petAssetsDir(), shape.skin);
  try {
    return fs.statSync(path.join(dir, 'model.json')).isFile() ? dir : '';
  } catch (err) {
    return '';
  }
}

/**
 * 读出一个 rig 形象包（model + 贴图 dataUrl）。
 * 缺 model.json / 缺任何一张贴图 → 返回 null（宠物页面露出「形象没加载出来」占位）。
 * 返回的 key 供渲染层判断「数据变没变」：pet:state 每次都全量推，
 * 渲染层靠 key 跳过重复重建（GL 上下文重建不便宜）。
 */
function petRigPack(look) {
  const dir = rigSkinDir(look);
  if (!dir) return null;

  const modelFile = path.join(dir, 'model.json');
  let model;
  try {
    model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  } catch (err) {
    console.warn('[pet] rig model.json 解析失败:', err.message);
    return null;
  }
  if (!model || !Array.isArray(model.parts) || !model.parts.length || !model.units || !model.pivots) {
    return null;
  }

  const key = `${dir}:${statKey(modelFile)}`;
  if (rigCache.key === key) return rigCache.pack;

  const tex = {};
  for (const p of model.parts) {
    const name = String(p.tex || '');
    if (!name || tex[name]) continue; // 去重：多个部件可共用一张贴图
    let file = '';
    for (const ext of ['.png', '.webp', '.jpg']) {
      const f = path.join(dir, 'tex', `${name}${ext}`);
      try {
        if (fs.statSync(f).isFile()) { file = f; break; }
      } catch (err) { /* 试下一个扩展 */ }
    }
    if (!file) {
      console.warn(`[pet] rig 形象缺贴图 tex/${name}.png —— 整包按无效处理`);
      return null;
    }
    try {
      const buf = fs.readFileSync(file);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
      tex[name] = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      return null;
    }
  }

  // 五官叠加层（feat）：贴图在 feat/ 子目录，key 仍取 tex 名（rig 用 part.tex 索引）。
  // 这一层是**可选**的：老形象包 model.feat 是空对象；就算某张图缺了也只跳过该张、
  // 不整包作废 —— 顶多少了眼睛，不至于整只猫画不出来。
  for (const fdef of Object.values(model.feat || {})) {
    const name = String((fdef && fdef.tex) || '');
    if (!name || tex[name]) continue; // 去重：feat 与 part 共用同一张也认
    let file = '';
    for (const ext of ['.png', '.webp', '.jpg']) {
      const f = path.join(dir, 'feat', `${name}${ext}`);
      try {
        if (fs.statSync(f).isFile()) { file = f; break; }
      } catch (err) { /* 试下一个扩展 */ }
    }
    if (!file) {
      console.warn(`[pet] rig 形象缺五官贴图 feat/${name}.png —— 跳过这张`);
      continue;
    }
    try {
      const buf = fs.readFileSync(file);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
      tex[name] = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      console.warn(`[pet] 五官贴图读取失败 feat/${name}.png:`, err.message);
    }
  }

  const pack = { key, model, tex };
  rigCache = { key, pack };
  return pack;
}

// 形象只有 rig 一种：**没有**「从文件选一张静态图当形象」这条路了 ——
// 原来的 importPetSkin / listPetSkins（都是围着静态 PNG 转的）已随之移除。
// 但「换形象」本身还在：往 assets/pet/<名字>/ 或 <数据目录>/pet/skins/<名字>/
// 放一个带 model.json 的目录，就会被上面的 listRigSkins() 扫到并出现在下拉里。

// ---------------------------------------------------------------------------
//  人格
// ---------------------------------------------------------------------------

function readPersona(petId) {
  const file = petPersonaFile(petId);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 第一次跑：把内置那份写出去当起点。写失败也不影响本次返回（内存里那份照用）
    try {
      fs.mkdirSync(petPersonaDir(), { recursive: true });
      fs.writeFileSync(file, DEFAULT_PERSONA, 'utf8');
    } catch (writeErr) {
      console.warn('[pet] 人格文件写不出去:', writeErr.message);
    }
    return DEFAULT_PERSONA;
  }
}

function writePersona(petId, text) {
  const file = petPersonaFile(petId);
  fs.mkdirSync(petPersonaDir(), { recursive: true });
  fs.writeFileSync(file, String(text == null ? '' : text), 'utf8');
  return file;
}

/**
 * 还原成内置人格。
 *
 * ⚠️ 别用「写一个空字符串」来实现「还原」：readPersona 读得到那个空文件，
 *    于是人格真的变成空的 —— 宠物会变成一段没有性格的文字生成器，
 *    而且用户完全不知道为什么。正解是把文件删掉，让 readPersona
 *    走「第一次跑」那条路重新写一份默认的出来。
 */
function resetPersona(petId) {
  try {
    fs.unlinkSync(petPersonaFile(petId));
  } catch (err) {
    /* 本来就没有就算了 */
  }
  return readPersona(petId);
}

// ---------------------------------------------------------------------------
//  长期记忆
//
//  形状（两个文件都按 petId 分仓，为的是以后养多只时记忆互不串）：
//    long_term.json  { version, pets: { [id]: { items: [...] } } }
//    summaries.json  { version, pets: { [id]: { digest, folded } } }
//
//  items 里每条：{ id, at, kind, text, convoTitle }
//    kind = 'say'    桌宠自己说过的话 —— 用它防复读、也让它有连续性
//         = 'event'  从对话里记下的事（模型在发言末尾用【记住】行给出来）
//         = 'user'   用户偏好（界面手加的，或将来从设置里推出来的）
//
//  超出上限时**从最早的开始折叠**进 summaries 的 digest（本地拼接，不再调模型）——
//  这样做的好处是「保留量可调」不会顺带把记忆整段丢掉，而且一次都不会多花钱。
// ---------------------------------------------------------------------------

const MAX_MEMORY_TEXT = 300;
const MEMORY_ITEM_KINDS = new Set(['say', 'event', 'user']);

function loadMemoryStore() {
  const raw = loadJsonWithFallback(petMemoryFile());
  const data = raw && typeof raw === 'object' && raw.pets && typeof raw.pets === 'object' ? raw : {};
  return { version: 1, pets: { ...(data.pets || {}) } };
}

function loadSummaryStore() {
  const raw = loadJsonWithFallback(petSummaryFile());
  const data = raw && typeof raw === 'object' && raw.pets && typeof raw.pets === 'object' ? raw : {};
  return { version: 1, pets: { ...(data.pets || {}) } };
}

/** 一只宠物的记忆条目（最新的在后面） */
function petMemoryItems(petId) {
  const store = loadMemoryStore();
  const bucket = store.pets[safeId(petId)];
  return Array.isArray(bucket && bucket.items) ? bucket.items : [];
}

/** 一只宠物的折叠摘要 */
function petMemoryDigest(petId) {
  const store = loadSummaryStore();
  const bucket = store.pets[safeId(petId)];
  return bucket && typeof bucket.digest === 'string' ? bucket.digest : '';
}

function newMemoryId() {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
}

/**
 * 追加一条记忆，并按上限折叠。
 * 返回写盘的 Promise。
 */
function appendPetMemory(petId, item, maxItems) {
  const id = safeId(petId);

  const kind = MEMORY_ITEM_KINDS.has(item && item.kind) ? item.kind : 'event';
  const text = String((item && item.text) || '').trim().slice(0, MAX_MEMORY_TEXT);
  if (!text) return Promise.resolve(petMemoryItems(id));

  // 读改写整段排队（理由同 patchPet）：桌宠说完话会连着追加「说过的一句」和
  // 「记下的事」两条，两次调用各自读旧快照的话，前面那条会被整份覆盖掉。
  return queueMutation(async () => {
    const store = loadMemoryStore();
    const bucket = store.pets[id] && typeof store.pets[id] === 'object' ? store.pets[id] : {};
    const items = Array.isArray(bucket.items) ? bucket.items.slice() : [];

    items.push({
      id: newMemoryId(),
      at: Date.now(),
      kind,
      text,
      convoTitle: String((item && item.convoTitle) || '').trim().slice(0, 60)
    });

    // 超上限：把最早的那些折进摘要
    const limit = clampInt(maxItems, MEMORY_MAX_ITEMS_MIN, MEMORY_MAX_ITEMS_MAX, 30);
    let folded = [];
    if (limit === 0) {
      folded = items.splice(0, items.length);
    } else if (items.length > limit) {
      folded = items.splice(0, items.length - limit);
    }

    store.pets[id] = { items };
    const writes = [writeJson(petMemoryFile(), store)];

    if (folded.length) {
      const summaries = loadSummaryStore();
      const prev = summaries.pets[id] && typeof summaries.pets[id].digest === 'string'
        ? summaries.pets[id].digest
        : '';
      // 折叠就是本地拼接，**不额外调模型** —— 记忆是后台动作，
      // 让「超过上限」这个纯机械事件去偷偷花一次钱是不对的
      const joined = folded
        .map((m) => (m.kind === 'say' ? `${m.convoTitle || '某次对话'}：${m.text}` : m.text))
        .join('；');
      const digest = [prev, joined].filter(Boolean).join('；').slice(-4000);
      summaries.pets[id] = {
        digest,
        folded: ((summaries.pets[id] && summaries.pets[id].folded) || 0) + folded.length,
        updatedAt: Date.now()
      };
      writes.push(writeJson(petSummaryFile(), summaries));
    }

    await Promise.all(writes);
    return items;
  });
}

/** 清空记忆（条目 + 摘要）。reset 只删条目、保留折叠摘要，clear 全清。 */
function clearPetMemory(petId, keepDigest) {
  const id = safeId(petId);
  // 同样整段排队：清空与正在进行的追加如果交错，刚清掉的记忆会被旧快照写回来。
  return queueMutation(async () => {
    const store = loadMemoryStore();
    delete store.pets[id];
    const writes = [writeJson(petMemoryFile(), store)];

    if (!keepDigest) {
      const summaries = loadSummaryStore();
      delete summaries.pets[id];
      writes.push(writeJson(petSummaryFile(), summaries));
    }
    await Promise.all(writes);
    return true;
  });
}

/** 记忆导出成一个自带说明的 JSON 文本（界面直接拿它存文件） */
function exportPetMemory(petId) {
  const id = safeId(petId);
  const config = loadPetConfig();
  const pet = findPet(config, id);
  return JSON.stringify(
    {
      说明: 'Mimitale 桌宠记忆导出。放回记忆目录可以还原（见「使用说明」）。',
      导出时间: new Date().toISOString(),
      桌宠: pet ? pet.name : id,
      petId: id,
      长期记忆: petMemoryItems(id),
      折叠摘要: petMemoryDigest(id)
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
//  日志（排查用，只留最近一段）
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 256 * 1024;

function petLog(line) {
  try {
    fs.mkdirSync(petLogDir(), { recursive: true });
    const file = path.join(petLogDir(), `pet-${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) return;
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (err) {
    /* 日志写不进去不该影响任何事 */
  }
}

module.exports = {
  // 路径
  petAssetsDir,
  petUserDir,
  // 常量
  DEFAULT_PET_CONFIG,
  DEFAULT_PERSONA,
  MUTE_DURATION_MS,
  SPEAK_EVERY_MIN,
  SPEAK_EVERY_MAX,
  SPEAK_LINES_MIN,
  SPEAK_LINES_MAX,
  // 空闲小动作的「全集」——设置页和渲染层都按它对齐，别在别处重写一份
  KNOWN_GESTURES,
  MEMORY_MAX_ITEMS_MIN,
  MEMORY_MAX_ITEMS_MAX,
  // 设置
  normalizePetConfig,
  loadPetConfig,
  savePetConfig,
  savePetConfigNow,
  patchPetConfig,
  patchPet,
  findPet,
  // 形象（只有 rig）
  petRigPack,
  rigSkinDir,
  listRigSkins,
  // 人格
  readPersona,
  writePersona,
  resetPersona,
  // 记忆
  petMemoryItems,
  petMemoryDigest,
  appendPetMemory,
  clearPetMemory,
  exportPetMemory,
  // 日志
  petLog
};
