'use strict';

// ============================================================================
//  main/store.js —— userData 读写：设置以外的全部本地数据
//
//  所有 JSON 都写在 Electron 的 userData 目录里，整份重写，带 backup 兜底。
//  落盘走「先写 .tmp 再 rename」的原子写：写入中途崩溃/断电时，
//  主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
// ============================================================================

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { normalizeCharacter } = require('./characters.js');
const { createWorldbookNormalizer } = require('./worldbook-store.js');

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

let writeQueue = Promise.resolve();

/**
 * 真正落盘的同步实现：先备份旧文件，再写入新内容。
 * 同步是故意的 —— 关窗口时的「最后一次保存」必须在这一个事件循环里写完，
 * 否则程序可能在微任务执行前就退出了。
 */
function writeJsonNow(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 写入前保留一份备份，主文件损坏时用得上
    const backupFile = file + '.backup';
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, backupFile);
    }

    // 原子写：先写临时文件再 rename —— 写入中途崩溃/断电时，
    // 主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
    // （Node 的 rename 在 Windows 上也是替换语义，目标已存在也能盖。）
    const tmpFile = file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, file);
    return true;
  } catch (err) {
    console.error('[store] 写入失败:', file, err.message);
    return false;
  }
}

/** 排队写入：把并发的保存请求串起来，避免互相覆盖。 */
function writeJson(file, data) {
  writeQueue = writeQueue.then(() => writeJsonNow(file, data));
  return writeQueue;
}

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
        // 恢复备份到主文件
        fs.copyFileSync(backupFile, file);
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
  const data = loadJsonWithFallback(userDataFile('conversations.json'));
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

  const file = userDataFile('conversations.json');
  const data = { conversations: limited, activeId };

  // 关窗口时的最后一次保存必须立刻落盘，不能排队等微任务
  if (options && options.immediate) {
    writeJsonNow(file, data);
  } else {
    writeJson(file, data);
  }

  return { conversations: limited, activeId };
}

// ---------------------------------------------------------------------------
//  角色库
//  一个角色 = 一张角色卡。支持两种来源：
//    · 酒馆（SillyTavern）的 PNG 角色卡：元数据以 base64 JSON 藏在 PNG 的 tEXt 块里
//    · 普通 JSON 角色卡
//  也可以完全手写。数据存在 userData\characters.json。
// ---------------------------------------------------------------------------

function charactersFile() {
  return userDataFile('characters.json');
}

function loadCharacters() {
  const data = loadJsonWithFallback(charactersFile());
  if (!data || !Array.isArray(data.characters)) return { characters: [] };
  return { characters: data.characters.map((c) => normalizeCharacter(c)) };
}

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
    writeJsonNow(charactersFile(), data);
    if (books) writeJsonNow(worldbooksFile(), books);
  } else {
    writeJson(charactersFile(), data);
    if (books) writeJson(worldbooksFile(), books);
  }
  return data;
}

// ---------------------------------------------------------------------------
//  世界书 / World Info（Lorebook）
//  数据存在 userData\worldbooks.json。词条生效范围只由「会话绑定了哪本书」决定；
//  每本书还能装若干「角色副本」，这些副本与角色库里的角色互相独立、互不影响。
// ---------------------------------------------------------------------------

// 世界书数量上限。和会话一样给个上限，免得角色卡反复导入把文件撑到几十 MB。
const MAX_WORLDBOOKS = 200;

function worldbooksFile() {
  return userDataFile('worldbooks.json');
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

function saveWorldbooks(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.worldbooks) ? payload.worldbooks : [];
  const data = { worldbooks: list.slice(-MAX_WORLDBOOKS).map((w) => normalizeStoredWorldbook(w)) };

  if (opts.immediate) {
    writeJsonNow(worldbooksFile(), data);
  } else {
    writeJson(worldbooksFile(), data);
  }
  return data;
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
//  语义检索（RAG）的向量仓库
//
//  存在 userData\vectors.json：{ version, items: { "<model>::<key>": "<base64 float32>" } }
//  键里带上**模型名**，所以换 embedding 模型不会污染 —— 不同模型的向量空间根本不可比，
//  带上模型名之后老向量自然用不上，也就不会算出一堆假相似度。
// ---------------------------------------------------------------------------

const VECTORS_VERSION = 1;

function vectorsFile() {
  return userDataFile('vectors.json');
}

function loadVectors() {
  const data = loadJsonWithFallback(vectorsFile());
  if (!data || data.version !== VECTORS_VERSION || !data.items || typeof data.items !== 'object') {
    return { version: VECTORS_VERSION, items: {} };
  }
  return { version: VECTORS_VERSION, items: data.items };
}

function saveVectors(store) {
  try {
    writeJson(vectorsFile(), store);
  } catch (err) {
    // 向量只是加速用的缓存，存不下去也不该影响聊天
    console.error('向量缓存写入失败', err);
  }
}

module.exports = {
  userDataFile,
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
  loadVectors,
  saveVectors
};
