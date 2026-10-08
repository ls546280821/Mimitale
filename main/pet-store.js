'use strict';

// ============================================================================
//  main/pet-store.js —— 桌宠的数据层：设置 / 长期记忆 / 人格
//
//  桌宠的数据**分两半**，这条边界不能糊（星宝 2026-10-08 的需求第三条）：
//
//    assets/pet/         随软件分发的**只读**资源（形象 / 皮肤 / 动画 / Live2D）
//      default/          默认形象
//      skins/            以后：多套皮肤
//      animations/       以后：帧动画
//      live2d/           以后：Live2D 模型
//
//    <数据目录>/pet/      用户数据，**可写**
//      config.json       桌宠设置（形状见下面的 DEFAULT_PET_CONFIG）
//      persona/<id>.md   人格设定（**唯一真源**，用 md 是为了方便直接用编辑器改 / 分享）
//      memory/long_term.json   长期记忆条目，按 petId 分开存
//      memory/summaries.json   记忆被挤出上限后折叠成的摘要
//      skins/            用户自己换的形象（从别处选进来的图拷贝到这儿）
//      cache/  logs/     缓存与日志
//
//  分开的好处就是星宝列的那三条：软件更新不会覆盖用户记忆和设置；
//  换形象 / 加皮肤不用动代码；桌宠将来要成为软件整体形象时资源可以直接复用。
//
//  ⚠️ 数据目录不是 %APPDATA%（见 main/data-dir.js，默认是程序旁边的 data\），
//     所以配置落在 `data/pet/config.json`。别照着老印象去 %APPDATA% 找。
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

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

const DEFAULT_PERSONA = `你是「蓝自」，一只住在人家桌面上的蓝白猫娘。

## 你是谁
- 身份：陪用户玩角色扮演的**旁观者**，不是剧情里的角色。
- 性格：聪明、憋萌、可靠；有点懒、爱吃、爱摸鱼，但正事上从不掉链子。
- 口头禅：「嗯…我想想…」「让我再摸一会儿…」「已为你找到答案～」

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

/** 一只桌宠的默认形状 */
function defaultPet(id) {
  return {
    id,
    name: '蓝自',
    // --- 长什么样 ---
    // kind 现在只有 'png'；以后加 'sprite'（帧动画）/ 'live2d' 时只加分支，
    // 不动上层（设置页只认 resolvePetImage 的结果）
    look: {
      kind: 'png',
      source: 'assets', // 'assets' = 随软件分发；'user' = 用户自己换的，在 data/pet/skins
      skin: 'default',
      file: '8cb9700671c063df79e4cdcfedd513c1.png'
    },
    // --- 显示 ---
    visible: true,
    scale: 1,
    bounds: null, // { x, y, displayId }：桌面坐标 + 在哪个屏（拔屏后要能回主屏）
    // --- 发言 ---
    speakEnabled: true, // 主动发言总开关
    speakEveryTurns: 3, // 每隔几轮主对话说一次
    speakLines: 3, // 每次说几句
    mutedUntil: 0, // 临时静音到什么时候（时间戳，0 = 没静音）
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

function normalizeLook(raw) {
  const look = raw && typeof raw === 'object' ? raw : {};
  const kind = ['png', 'sprite', 'live2d'].includes(look.kind) ? look.kind : 'png';
  return {
    kind,
    source: look.source === 'user' ? 'user' : 'assets',
    skin: safeId(look.skin || 'default').toLowerCase(),
    file: String(look.file || '').trim().slice(0, 200) || defaultPet('x').look.file
  };
}

/** 一个时间戳：非法就归零（0 = 没静音） */
function normalizeTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    speakEnabled: p.speakEnabled !== false,
    speakEveryTurns: clampInt(p.speakEveryTurns, SPEAK_EVERY_MIN, SPEAK_EVERY_MAX, base.speakEveryTurns),
    speakLines: clampInt(p.speakLines, SPEAK_LINES_MIN, SPEAK_LINES_MAX, base.speakLines),
    mutedUntil: normalizeTs(p.mutedUntil),
    useMainModel: p.useMainModel !== false,
    providerId: String(p.providerId || '').trim().slice(0, 60),
    model: String(p.model || '').trim().slice(0, 120),
    temperature: Number.isFinite(Number(p.temperature))
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

/** 覆盖式保存（界面传完整一份回来）。返回写盘的 Promise —— 别改成 return data */
function savePetConfig(config) {
  const data = normalizePetConfig(config);
  return writeJson(petConfigFile(), data).then(() => data);
}

/** 关窗口时的最后一次保存：同步写，理由同 main/store.js 的 immediate 那套 */
function savePetConfigNow(config) {
  const data = normalizePetConfig(config);
  writeJsonNow(petConfigFile(), data);
  return data;
}

/** 改**其中一只**的字段，别的原样带过 */
function patchPet(petId, patch) {
  const config = loadPetConfig();
  const index = config.pets.findIndex((p) => p.id === petId);
  if (index < 0) return Promise.reject(new Error('找不到这只桌宠'));

  const merged = { ...config.pets[index], ...(patch && typeof patch === 'object' ? patch : {}) };
  config.pets[index] = merged;
  return savePetConfig(config);
}

function findPet(config, petId) {
  const list = (config || loadPetConfig()).pets;
  return list.find((p) => p.id === petId) || list[0] || null;
}

// ---------------------------------------------------------------------------
//  形象
// ---------------------------------------------------------------------------

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng'
};

/** 形象文件的绝对路径；找不到返回 '' */
function petImagePath(look) {
  const shape = normalizeLook(look);
  if (shape.kind !== 'png') return ''; // 以后 sprite / live2d 走别的分支
  const dir = shape.source === 'user' ? petUserSkinDir() : path.join(petAssetsDir(), shape.skin);
  const file = path.join(dir, shape.file);
  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch (err) {
    return '';
  }
}

// 形象读出来转成 data URL 给宠物窗口用。
// 为什么不用 file:// 直链：宠物窗口是独立文档，`assets/pet/` 不在它的相对路径上，
// 而且打包后资源在 asar 里、用户换的形象又在数据目录里 —— 两处都要能显示，
// 与其加一套自定义协议，不如读一次转 base64（一张图也就几百 KB，且只在形象变化时才重读）。
let imageCache = { key: '', url: '' };

function petImageDataUrl(look) {
  const file = petImagePath(look);
  if (!file) return '';
  const key = `${file}:${statKey(file)}`;
  if (imageCache.key === key) return imageCache.url;

  try {
    const buf = fs.readFileSync(file);
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
    const url = `data:${mime};base64,${buf.toString('base64')}`;
    imageCache = { key, url };
    return url;
  } catch (err) {
    console.warn('[pet] 读形象失败:', err.message);
    return '';
  }
}

/** 文件指纹（大小 + mtime）：用来判断缓存要不要失效 */
function statKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${st.mtimeMs}`;
  } catch (err) {
    return '0';
  }
}

/** 把一张用户选中的图拷进 data/pet/skins，返回新的 look */
function importPetSkin(sourcePath) {
  const src = String(sourcePath || '');
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('只支持 png / jpg / gif / webp / bmp 图片');

  fs.mkdirSync(petUserSkinDir(), { recursive: true });
  const file = `skin-${Date.now().toString(36)}${ext}`;
  fs.copyFileSync(src, path.join(petUserSkinDir(), file));
  return { kind: 'png', source: 'user', skin: 'user', file };
}

/** 列出可选形象：内置 default 目录 + 用户自己换进来的 */
function listPetSkins() {
  const out = [];
  const push = (dir, source, skin) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      return;
    }
    for (const name of names) {
      if (!IMAGE_MIME[path.extname(name).toLowerCase()]) continue;
      out.push({ source, skin, file: name, label: source === 'user' ? `我换的 · ${name}` : `内置 · ${name}` });
    }
  };
  push(path.join(petAssetsDir(), 'default'), 'assets', 'default');
  push(petUserSkinDir(), 'user', 'user');
  return out;
}

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
  const store = loadMemoryStore();
  const bucket = store.pets[id] && typeof store.pets[id] === 'object' ? store.pets[id] : {};
  const items = Array.isArray(bucket.items) ? bucket.items.slice() : [];

  const kind = MEMORY_ITEM_KINDS.has(item && item.kind) ? item.kind : 'event';
  const text = String((item && item.text) || '').trim().slice(0, MAX_MEMORY_TEXT);
  if (!text) return Promise.resolve(items);

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

  return Promise.all(writes).then(() => items);
}

/** 清空记忆（条目 + 摘要）。reset 只删条目、保留折叠摘要，clear 全清。 */
function clearPetMemory(petId, keepDigest) {
  const id = safeId(petId);
  const store = loadMemoryStore();
  delete store.pets[id];
  const writes = [writeJson(petMemoryFile(), store)];

  if (!keepDigest) {
    const summaries = loadSummaryStore();
    delete summaries.pets[id];
    writes.push(writeJson(petSummaryFile(), summaries));
  }
  return Promise.all(writes).then(() => true);
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
  MEMORY_MAX_ITEMS_MIN,
  MEMORY_MAX_ITEMS_MAX,
  // 设置
  normalizePetConfig,
  loadPetConfig,
  savePetConfig,
  savePetConfigNow,
  patchPet,
  findPet,
  // 形象
  petImagePath,
  petImageDataUrl,
  importPetSkin,
  listPetSkins,
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
