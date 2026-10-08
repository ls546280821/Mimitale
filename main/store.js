'use strict';

// ============================================================================
//  main/store.js —— 本地数据读写：设置以外的全部数据
//
//  所有 JSON 都写在**数据目录**里（位置由 main/data-dir.js 决定：默认是程序
//  旁边的 data\，不再是 C 盘的 %APPDATA%），整份重写，带 backup 兜底。
//  落盘走「先写 .tmp 再 rename」的原子写：写入中途崩溃/断电时，
//  主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
// ============================================================================

const { safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { dataDir } = require('./data-dir.js');
const { normalizeCharacter } = require('./characters.js');
const { createWorldbookNormalizer } = require('./worldbook-store.js');
const { normalizePreset, MAX_PRESETS } = require('./presets.js');

/**
 * 数据目录里某个文件的全路径。
 *
 * ⚠️ 名字里以前叫 userDataFile —— 现在数据**未必**在 Electron 的 userData 里了
 *    （见 main/data-dir.js），所以改名，免得下一个人照着名字去 %APPDATA% 找。
 */
function dataFile(name) {
  return path.join(dataDir(), name);
}

let writeQueue = Promise.resolve();

// ---------------------------------------------------------------------------
//  瞬时文件锁的重试
//
//  Windows 上安全软件（360 / Defender）和索引服务会在一个文件刚被写过的几十毫秒内
//  短暂独占它，这时 copy / rename 会吃到 EPERM / EBUSY / EACCES —— 哪怕文件本身
//  权限完全正常、手动重试一次就过。不重试的话，表现就是「偶尔一次保存失败」，
//  用户看到的是随机弹框 + 随机丢数据，而代码看起来毫无问题。
//
//  退避表：30 / 70 / 150 / 250 ms，合计约 0.5 秒。
//  ⚠️ 原来只有 4 次、15/30/45 ms（合计 90 毫秒）—— 2026-10-08 实测不够：
//     杀软在「刚写过的文件」上独占的时间能超过 90ms，四次全落空，于是整次保存作废。
//     也不能无限拉长：`immediate` 那条路（关窗口时的最后一次保存）是同步的，
//     主进程会一直卡在这里等，退避太久用户会觉得点了关闭没反应。
// ---------------------------------------------------------------------------

const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 第 n 次失败之后等多久（毫秒） */
const RETRY_BACKOFF_MS = [30, 70, 150, 250];

// ---------------------------------------------------------------------------
//  ⚠️ 2026-10-08 更正：下面那一整段「瞬时文件锁 / 杀软」的叙事是**误诊**，
//     别再照着它去查杀软了。当晚实测（同一台机器、同一个真实数据目录）：
//
//   · 用 node.exe 按「写 .tmp → rename」往 %APPDATA%\Mimitale 连打 300 次：
//     **300/300 全过，最慢 5ms** —— 不存在什么几十毫秒的瞬时锁。
//   · 真失败长这样，而且**每次**都失败、不是偶尔：
//       EPERM: operation not permitted, open '...\characters.json.tmp'
//     注意是 **open `.tmp`**：连新建文件都不让，不是 rename 撞锁。
//   · 失败范围与杀软无关，只跟**可执行文件放在哪**有关（同一份二进制，只换位置）：
//       C:\Program Files\nodejs\node.exe                     → 能写 %TEMP% / %APPDATA%
//       %TEMP%\nametest-out\other.exe                        → 能写
//       E:\工作\Mimitale\tools\...\other.exe                  → EPERM
//       E:\工作\Mimitale\node_modules\electron\dist\electron.exe → EPERM
//     用**计划任务**启动同样是 EPERM（不是从某个父进程继承来的限制）——
//     也就是：**从项目目录里跑起来的进程被沙箱限制在这个目录内**，
//     写 %APPDATA% 一律被拒。（E:\工作\Mimitale 上挂着沙箱的写权限项 S-1-4-*、
//     Everyone 的 S,DC 拒绝项和 Low 完整性标签，正是这套沙箱留下的痕迹。）
//
//  结论：这是**权限判定**，不是时序窗口 —— 重试再久也救不回来，只会把「关闭卡」
//  从 0 秒拖成两秒多。那句「文件可能被杀软临时占用或带了只读属性」两条都不成立。
//  再遇到这个症状，先跑 probeDirWritable() 看进程能不能在数据目录里建出文件。
// ---------------------------------------------------------------------------

/**
 * 关窗口那一次（immediate）用的短退避表。
 *
 * 为什么必须比上面那张短：这条路的写是**同步**的（sleepSync 就卡在主进程里），
 * 关窗口时会连写四个文件（会话 / 角色 / 世界书 / 预设）。按 30·70·150·250 走，
 * 一个文件失败要烧 500ms，实测四个文件加起来 **约 2.5 秒主进程完全卡死** ——
 * 用户看到的就是「关闭软件的时候卡」。
 *
 * 而这条路本来就只有「尽力而为」的语义（窗口已经没了，失败也没人看得到提示），
 * 拿两秒多的卡顿去赌一次瞬时锁并不划算：真·瞬时锁 60ms 内就放开了，
 * 真被拒绝的（权限 / 沙箱）等两秒照样写不进去。用户点保存 / 删卡那几条**异步**路
 * 仍然走完整的退避表，外加渲染层那次 1.2 秒的补试。
 */
const CLOSE_RETRY_BACKOFF_MS = [10, 30];

/** 同步睡一会儿。Atomics.wait 在 Node 主线程可用，别写成忙等烧 CPU。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 同步重试。只对「像是被临时锁住」的错误码重试 ——
 * 磁盘满、路径不存在这类重试一万次也没用，原样抛出去。
 */
function withRetry(fn, delays = RETRY_BACKOFF_MS) {
  let lastErr = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_LOCK_CODES.has(err && err.code)) throw err;
      if (i < delays.length) sleepSync(delays[i]);
    }
  }
  throw lastErr;
}

/**
 * 给主文件留一份备份。**整体吞错，只 warn。**
 *
 * ⚠️ 备份失败绝不能拖垮主写入。备份只是「主文件坏了时的兜底」，为了它让本次保存
 *    整个失败，等于拿「旧数据 + 没备份」换「新数据根本没落盘」—— 明显更亏。
 *    2026-10-08 就是这里爆的：copyFileSync 撞上杀软的瞬时锁（EPERM），
 *    异常一路冒到 writeJsonNow 外面，整个保存作废，还弹了个主进程崩溃框。
 *
 * 备份也走「先 copy 到 .tmp 再 rename 顶掉」，跟主文件同一个道理：
 * 直接 copyFileSync 覆盖 .backup，写到一半失败会留下半个 JSON —— 兜底就废了，
 * 而且下次 loadJsonWithFallback 真会读到它。
 */
function tryBackup(file, delays) {
  const backup = file + '.backup';
  const tmp = backup + '.tmp';
  try {
    if (!fs.existsSync(file)) return;
    withRetry(() => {
      fs.copyFileSync(file, tmp);
      fs.renameSync(tmp, backup);
    }, delays);
  } catch (err) {
    console.warn(
      '[store] 备份失败（不影响本次写入）:',
      path.basename(backup),
      err.message,
      '——常见原因：被安全软件临时锁住 / 文件带了只读属性'
    );
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      /* 没有就算了 */
    }
  }
}

/**
 * 真正落盘的同步实现：先备份旧文件，再写入新内容。
 * 同步是故意的 —— 关窗口时的「最后一次保存」必须在这一个事件循环里写完，
 * 否则程序可能在微任务执行前就退出了。
 *
 * ⚠️ 失败时**必须抛**，不能只 return false：
 *   以前这里 return false，writeJson 把 false 当结果 resolve，
 *   而 save* 那几个函数返回的是自己那份 payload、根本不看写没写成功 ——
 *   于是一路成功到界面，用户看到「已保存」，磁盘上却还是旧文件
 *   （renderer/js/data/persist.js 里那几个「保存失败，请检查磁盘空间」的
 *   提示因此全是死代码）。下次启动读回旧数据，中间改的全没了。
 *   最常见的触发条件不是「磁盘满」，而是安全软件锁住 userData 里的文件 ——
 *   main.js 开头记着的那种机器就是这个状态。
 */
function writeJsonNow(file, data, delays) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 写入前保留一份备份（失败不影响本次写入，见 tryBackup）
    tryBackup(file, delays);

    // 原子写：先写临时文件再 rename —— 写入中途崩溃/断电时，
    // 主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
    // （Node 的 rename 在 Windows 上也是替换语义，目标已存在也能盖。）
    // 整段重试：杀软/索引服务可能刚好在这一刻锁着文件（EPERM / EBUSY）。
    // delays 只由「关窗口」那条同步路传 CLOSE_RETRY_BACKOFF_MS（见那段注释）。
    const tmpFile = file + '.tmp';
    const text = JSON.stringify(data, null, 2);
    withRetry(() => {
      fs.writeFileSync(tmpFile, text, 'utf8');
      fs.renameSync(tmpFile, file);
    }, delays);
    return true;
  } catch (err) {
    console.error('[store] 写入失败:', file, err.message);
    // 顺手清掉可能留下的半截临时文件，别让它挡住下次写入
    try {
      fs.unlinkSync(file + '.tmp');
    } catch (cleanupErr) {
      /* 没有就算了 */
    }
    throw new Error(`写入失败（${path.basename(file)}）：${err.message}`);
  }
}

/**
 * 排队写入：把并发的保存请求串起来，避免互相覆盖。失败会 reject。
 *
 * ⚠️ 队尾必须自己把异常吃掉（写成 .then(ok, err) 的**两个**处理函数），
 *    否则一次失败会把 writeQueue 永久钉在 rejected 状态：之后每次
 *    writeQueue.then(...) 都直接跳过成功回调、原样继续拒绝 ——
 *    等于「写坏一次，从此以后所有保存都静默不写」，比原来的吞异常还糟。
 *    这里把错误「复制」一份给调用方，队尾本身恢复成正常状态。
 */
function writeJson(file, data) {
  const result = writeQueue.then(() => writeJsonNow(file, data));
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// 数据目录的挑选、能不能写（probeDirWritable）都在 main/data-dir.js ——
// 那是「数据放哪」的问题，不归落盘逻辑管。

function loadJsonWithFallback(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // 主文件失败，尝试备份
    const backupFile = file + '.backup';
    if (fs.existsSync(backupFile)) {
      try {
        const raw = fs.readFileSync(backupFile, 'utf8');
        const data = JSON.parse(raw);
        // 顺手把备份回填成主文件，下次就不用再走这条兜底路了。
        // ⚠️ 回填失败**不能**连累已经读到手里的数据 —— 跟 tryBackup 一个道理：
        //    辅助动作失败不该把主流程一起带走。之前这个 copyFileSync 一抛，
        //    外层 catch 就把 data 扔了、返回 null，于是「备份明明读得出来」
        //    却还是被判成「读失败」，接着就是界面报「上次没能读出来，先别改它」。
        try {
          withRetry(() => fs.copyFileSync(backupFile, file));
        } catch (restoreErr) {
          console.warn('[store] 备份回填失败（数据已读到）:', path.basename(file), restoreErr.message);
        }
        return data;
      } catch (backupErr) {
        // 备份也失败
      }
    }
    return null;
  }
}

function encryptApiKey(plaintext) {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext;
  }
  try {
    const buffer = safeStorage.encryptString(plaintext);
    return buffer.toString('base64');
  } catch (err) {
    console.error('[crypto] 加密失败:', err.message);
    return plaintext;
  }
}

function decryptApiKey(encrypted) {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) {
    return encrypted;
  }
  try {
    // 检查是否是 base64 编码的加密数据
    if (!/^[A-Za-z0-9+/]+=*$/.test(encrypted)) {
      return encrypted; // 明文，直接返回
    }
    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (err) {
    // 解密失败，可能是明文 API Key（旧版本数据）
    return encrypted;
  }
}

// ---------------------------------------------------------------------------
//  会话
// ---------------------------------------------------------------------------

function loadConversations() {
  const data = loadJsonWithFallback(dataFile('conversations.json'));
  if (!data || !Array.isArray(data.conversations)) {
    return { conversations: [], activeId: null };
  }

  // 限制会话数量，防止无限增长
  const MAX_CONVERSATIONS = 100;
  let conversations = data.conversations;
  if (conversations.length > MAX_CONVERSATIONS) {
    // 保留最近更新的会话
    conversations = conversations
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_CONVERSATIONS);
  }

  // 限制每个会话的消息数量
  const MAX_MESSAGES_PER_CONVERSATION = 200;
  conversations = conversations.map(c => {
    if (Array.isArray(c.messages) && c.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      return {
        ...c,
        messages: c.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)
      };
    }
    return c;
  });

  return {
    conversations,
    activeId: data.activeId || (conversations[0] && conversations[0].id) || null
  };
}

function saveConversations(payload, options) {
  const conversations = Array.isArray(payload && payload.conversations) ? payload.conversations : [];
  const activeId = (payload && payload.activeId) || null;

  // 限制会话数量
  const MAX_CONVERSATIONS = 100;
  let limited = conversations;
  if (limited.length > MAX_CONVERSATIONS) {
    limited = limited
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_CONVERSATIONS);
  }

  const file = dataFile('conversations.json');
  const data = { conversations: limited, activeId };

  // 关窗口时的最后一次保存必须立刻落盘，不能排队等微任务
  if (options && options.immediate) {
    writeJsonNow(file, data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  // ⚠️ 返回的是**写盘的 Promise**，不是 data —— 见 saveCharacters 上面那段长注释。
  return writeJson(file, data).then(() => data);
}

// ---------------------------------------------------------------------------
//  角色库
//  一个角色 = 一张角色卡。支持两种来源：
//    · 酒馆（SillyTavern）的 PNG 角色卡：元数据以 base64 JSON 藏在 PNG 的 tEXt 块里
//    · 普通 JSON 角色卡
//  也可以完全手写。数据存在 userData\characters.json。
// ---------------------------------------------------------------------------

function charactersFile() {
  return dataFile('characters.json');
}

function loadCharacters() {
  const data = loadJsonWithFallback(charactersFile());
  if (!data || !Array.isArray(data.characters)) return { characters: [] };
  return { characters: data.characters.map((c) => normalizeCharacter(c)) };
}

/**
 * 保存角色库。
 *
 * ⚠️ 返回值是**写盘的 Promise**，不是那份 data —— 这一条是必须的，别改回去。
 *
 * 以前这里是「发起 writeJson(...) 之后立刻 return data」：写盘是异步排队的，
 * 它失败时那个 Promise 没有任何人接管（unhandled rejection），而 ipcMain.handle
 * 已经拿着 data 成功返回了 —— 于是 `ipcRenderer.invoke` 正常 resolve，
 * 渲染层那些 `.catch(() => showToast('没能保存到磁盘'))` **全是死代码**：
 * 磁盘一个字节没动，界面照样弹「已删除 / 已保存」。
 *
 * 2026-10-08 星宝报的「角色卡和世界书删掉之后，重开软件还是会有」就是这个：
 * 杀软短暂锁住 characters.json → rename 抛 EPERM → 保存作废，
 * 界面报「已删除」，磁盘上那张卡还在，重启自然又回来了。
 * 端到端复现见 tools/mp-e2e-delete.js 的 E 段。
 */
function saveCharacters(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.characters) ? payload.characters : [];
  const data = { characters: list.map((c) => normalizeCharacter(c)) };
  // 导入角色卡时可能顺带解析出内嵌世界书，跟角色同一次写入落盘
  const hasWorldbooks = payload && Array.isArray(payload.worldbooks);
  const books = hasWorldbooks
    ? { worldbooks: payload.worldbooks.slice(-MAX_WORLDBOOKS).map((w) => normalizeStoredWorldbook(w)) }
    : null;

  if (opts.immediate) {
    writeJsonNow(charactersFile(), data, CLOSE_RETRY_BACKOFF_MS);
    if (books) writeJsonNow(worldbooksFile(), books, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }

  return writeJson(charactersFile(), data)
    .then(() => (books ? writeJson(worldbooksFile(), books) : undefined))
    .then(() => data);
}

// ---------------------------------------------------------------------------
//  世界书 / World Info（Lorebook）
//  数据存在 userData\worldbooks.json。词条生效范围只由「会话绑定了哪本书」决定；
//  每本书还能装若干「角色副本」，这些副本与角色库里的角色互相独立、互不影响。
// ---------------------------------------------------------------------------

// 世界书数量上限。和会话一样给个上限，免得角色卡反复导入把文件撑到几十 MB。
const MAX_WORLDBOOKS = 200;

function worldbooksFile() {
  return dataFile('worldbooks.json');
}

function newWorldbookId() {
  return `w${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

/**
 * 落盘时走一遍归一化。
 * 归一化本身在 main/worldbook-parse.js（导入链路 require 的是同一份），
 * 这里只把主进程特有的两样东西注进去：id 生成规则、角色副本的归一化器。
 * 具体实现在 main/worldbook-store.js —— 冒烟测试的假后端 require 的是同一份。
 */
const normalizeStoredWorldbook = createWorldbookNormalizer({
  makeId: newWorldbookId,
  normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
});

function loadWorldbooks() {
  const data = loadJsonWithFallback(worldbooksFile());
  if (!data || !Array.isArray(data.worldbooks)) return { worldbooks: [] };
  // 保留最近的若干本，防止无限增长
  const list = data.worldbooks.slice(-MAX_WORLDBOOKS);
  return { worldbooks: list.map((w) => normalizeStoredWorldbook(w)) };
}

/** 保存世界书。返回值是写盘的 Promise（理由见 saveCharacters 上面那段）。 */
function saveWorldbooks(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.worldbooks) ? payload.worldbooks : [];
  const data = { worldbooks: list.slice(-MAX_WORLDBOOKS).map((w) => normalizeStoredWorldbook(w)) };

  if (opts.immediate) {
    writeJsonNow(worldbooksFile(), data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  return writeJson(worldbooksFile(), data).then(() => data);
}

/** 一组世界书 id 对应的全部条目（去重，同一个 id 只取一次） */
function worldbookEntriesByIds(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.trim()))];
  if (!wanted.length) return [];

  const { worldbooks } = loadWorldbooks();
  const byId = new Map(worldbooks.map((w) => [w.id, w]));

  const entries = [];
  for (const bookId of wanted) {
    const book = byId.get(bookId);
    if (!book) continue;
    for (const entry of book.entries) {
      entries.push({ ...entry, worldbookId: book.id, worldbookName: book.name });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
//  预设（Preset）
//  数据存在 userData\presets.json。预设是「叠在对话上的一层指令」——
//  只由「会话绑定了哪一个」决定生效，和角色卡、世界书互不影响。
// ---------------------------------------------------------------------------

function presetsFile() {
  return dataFile('presets.json');
}

/** 给一个没有 id 的预设补 id（界面新建时不一定带） */
function newPresetId() {
  return `pr${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

function loadPresets() {
  const data = loadJsonWithFallback(presetsFile());
  if (!data || !Array.isArray(data.presets)) return { presets: [] };
  const list = data.presets.slice(-MAX_PRESETS);
  return { presets: list.map((p) => normalizePreset(p)) };
}

function savePresets(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.presets) ? payload.presets : [];
  // ⚠️ 归一化 + 补 id 一起做：normalizePreset 不认识没有 id 的对象，
  //    漏掉这一步会让界面新建的预设每次存盘都换一个 id（绑定关系当场断掉）。
  const data = {
    presets: list
      .slice(-MAX_PRESETS)
      .map((p) => {
        const preset = normalizePreset(p);
        if (!preset.id) preset.id = newPresetId();
        return preset;
      })
  };

  if (opts.immediate) {
    writeJsonNow(presetsFile(), data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  return writeJson(presetsFile(), data).then(() => data);
}

// ---------------------------------------------------------------------------
//  语义检索（RAG）的向量仓库
//
//  存在 userData\vectors.json：{ version, items: { "<model>::<key>": "<base64 float32>" } }
//  键里带上**模型名**，所以换 embedding 模型不会污染 —— 不同模型的向量空间根本不可比，
//  带上模型名之后老向量自然用不上，也就不会算出一堆假相似度。
// ---------------------------------------------------------------------------

const VECTORS_VERSION = 1;

function vectorsFile() {
  return dataFile('vectors.json');
}

function loadVectors() {
  const data = loadJsonWithFallback(vectorsFile());
  if (!data || data.version !== VECTORS_VERSION || !data.items || typeof data.items !== 'object') {
    return { version: VECTORS_VERSION, items: {} };
  }
  return { version: VECTORS_VERSION, items: data.items };
}

function saveVectors(store) {
  // 向量只是加速用的缓存，存不下去也不该影响聊天（也别让 reject 变成
  // unhandled rejection —— writeJson 是异步的，写在这个 try 里接不住）。
  writeJson(vectorsFile(), store).catch((err) => {
    console.error('向量缓存写入失败', err && err.message);
  });
}

module.exports = {
  dataFile,
  writeJson,
  writeJsonNow,
  loadJsonWithFallback,
  encryptApiKey,
  decryptApiKey,
  loadConversations,
  saveConversations,
  loadCharacters,
  saveCharacters,
  newWorldbookId,
  loadWorldbooks,
  saveWorldbooks,
  worldbookEntriesByIds,
  newPresetId,
  loadPresets,
  savePresets,
  loadVectors,
  saveVectors
};
