'use strict';

// ============================================================================
//  main/worldbook-parse.js —— 世界书的归一化与「形状识别」
//
//  从 main.js 抽出来的，原因和 main/characters.js 一样：
//  导入角色卡的逻辑要能单独测。以前这段夹在 registerIpc() 的闭包里，
//  只有走真实的文件对话框才能跑到 —— 结果是「卡里内嵌的世界书被丢掉」
//  和「导出时 character_book 写死 null」这两个 bug 长期没人发现。
//
//  这里只做纯解析：给一块数据，返回内部格式。不碰磁盘、不生成 id
//  （id 由调用方给，因为主进程和导入链路生成方式不同）。
//
//  ⚠️ normalizeWorldbook 是**白名单式**的（和 normalizeCharacter 一个道理）：
//  加字段时记得同步这里，否则就是静默丢失。
// ============================================================================

// 单个世界书的条目数上限。匹配是每轮同步跑的，上万条会让每句话都卡一下。
const MAX_WORLDBOOK_ENTRIES = 5000;
// 一条注入内容的最大长度，防止畸形文件把上下文撑爆
const MAX_WORLDBOOK_CONTENT = 20000;
// 每个条目的关键词数量上限
const MAX_WORLDBOOK_KEYS = 200;
// 每本世界书里能装多少个「角色副本」。副本自带头像（base64），所以不能不限量。
const MAX_WORLDBOOK_CHARACTERS = 50;
// 世界书开场白的上限
const MAX_WORLDBOOK_OPENING = 4000;

/** 把一条 entry 的不同写法（ST 的 key/keys、constant、order…）统一成内部格式 */
function normalizeWorldbookEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

  // ST 内部是 key + keysecondary；导出到 character_book 时叫 keys / secondary_keys
  const pickKeys = (a, b) => {
    const value = Array.isArray(a) ? a : Array.isArray(b) ? b : typeof a === 'string' ? [a] : [];
    return value
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim().slice(0, 200))
      .slice(0, MAX_WORLDBOOK_KEYS);
  };

  const keys = pickKeys(r.keys, r.key);
  const secondaryKeys = pickKeys(r.secondary_keys, r.keysecondary);
  const content = str(r.content, MAX_WORLDBOOK_CONTENT);
  // 内容为空、又没有任何关键词的条目没有任何作用，直接丢掉
  if (!content.trim() && !keys.length) return null;

  const logic = String(r.selectiveLogic || r.selective_logic || '').toUpperCase();
  const selectiveLogic = ['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL'].includes(logic) ? logic : 'AND_ANY';

  let probability = Number(r.probability);
  if (!isFinite(probability)) probability = 100;
  probability = Math.max(0, Math.min(100, probability));

  let order = Number(r.order);
  if (!isFinite(order)) order = 100;

  // 酒馆新版本用 enabled，老版本/部分导出工具用 disable（true = 停用）。
  // 两个都认，否则导入老世界书时停用的条目会全部复活。
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : r.disable === true ? false : true;

  return {
    id: typeof r.id === 'string' && r.id ? r.id : `e${Math.random().toString(36).slice(2, 10)}`,
    // comment 是酒馆里的条目备注；没有就退回首关键词，方便在界面里认出来
    title: str(r.title || r.comment, 200).trim() || keys[0] || '未命名条目',
    keys,
    secondaryKeys,
    selectiveLogic,
    content,
    order,
    // 蓝圈：无条件注入，不需要关键词
    constant: r.constant === true || r.strategy === 'constant',
    // 递归：这条命中后，它的正文也参与下一轮扫描，能再带出别的条目。
    // 默认关 —— 递归会明显增加 token，得一条条显式打开。
    recursive: r.recursive === true,
    // 酒馆默认开启「全词匹配」，但官方文档明确说这对中日文有害（不用空格分词），
    // 所以这里默认关闭，只有显式打开才启用。
    matchWholeWords: bool(r.matchWholeWords ?? r.match_whole_words, false),
    caseSensitive: bool(r.caseSensitive ?? r.case_sensitive, false),
    probability,
    enabled
  };
}

/** 世界书的条目列表：可能是数组，也可能是酒馆导出时那种以索引为键的对象 */
function worldbookEntryList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];

  const values = Object.values(raw);
  // 对象形式：{ "0": {...}, "1": {...} }。
  // 只认「所有值都是对象」的情况，免得把单个 entry 误当成一本书。
  if (values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return values;
  }
  return [];
}

/**
 * 把世界书（数组或带 entries 的对象）整理成内部格式。
 *
 * 两个依赖都由调用方注入，因为这个模块不碰磁盘、也不认主进程的其它类型：
 *   · makeId            —— 怎么发世界书 id（主进程和导入链路规则不同）
 *   · normalizeCharacters —— 书里「角色副本」的归一化器（就是 characters.js 那个）。
 *                           不传就当没有副本 —— 导入链路用不到这个字段。
 *
 * ⚠️ 白名单式：加字段时两个都得同步，否则静默丢失。
 */
function normalizeWorldbook(raw, fallbackName, makeId, normalizeCharacters) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rawEntries = Array.isArray(raw) ? raw : worldbookEntryList(r.entries);
  const name =
    String(r.name || r.title || (typeof fallbackName === 'string' ? fallbackName : '') || '').trim() || '未命名世界书';

  const entries = [];
  for (const item of rawEntries) {
    const entry = normalizeWorldbookEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_WORLDBOOK_ENTRIES) break;
  }

  // 书里的角色是「独立副本」：从角色库加进来时复制一份，之后两边各改各的，
  // 单独跟角色库里的那个角色聊天不会影响这里。
  const characters = [];
  if (typeof normalizeCharacters === 'function') {
    const rawChars = Array.isArray(r.characters) ? r.characters : [];
    for (const item of rawChars) {
      characters.push(normalizeCharacters(item));
      if (characters.length >= MAX_WORLDBOOK_CHARACTERS) break;
    }
  }

  const genId = typeof makeId === 'function' ? makeId : () => `w${Date.now().toString(36)}`;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : genId(),
    name: name.slice(0, 120),
    // 进这个世界时自动作为第一条消息；留空则由界面那边让模型现生成一段开局
    opening: typeof r.opening === 'string' ? r.opening.slice(0, MAX_WORLDBOOK_OPENING) : '',
    entries,
    characters,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

/**
 * 角色卡里内嵌的世界书。
 * ST 导出角色卡时会把「角色绑定的世界书」一起塞进 character_book。
 */
function worldbookFromCharacterBook(raw, characterName, makeId) {
  if (!raw || typeof raw !== 'object') return null;
  const book = normalizeWorldbook(raw, `${characterName || '角色'}的世界书`, makeId);
  // 一个条目都没有就没必要存一份空世界书
  if (!book.entries.length) return null;
  return book;
}

/** 把单独的 lorebook 文件（`{entries:[...]}` 或裸数组）转成世界书 */
function worldbookFromLorebook(raw, fallbackName, makeId) {
  if (!raw || typeof raw !== 'object') return null;
  const book = normalizeWorldbook(raw, fallbackName, makeId);
  if (!book.entries.length) return null;
  return book;
}

/**
 * 这个 JSON 看起来是「独立的世界书文件」，而不是角色卡吗？
 *
 * 必须单独判断：酒馆导出的世界书同样带 name / description，
 * 而 characterFromCard 只要看到 name 或 description 就认定是角色卡 ——
 * 结果整本书被导入成一个空角色，几十条条目被静默丢掉。
 * 顶层有 entries、又没有角色卡专属字段的，按世界书处理。
 */
function looksLikeLorebook(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
  if (!card.entries) return false;
  return !card.first_mes && !card.char_name && !card.personality && !card.mes_example;
}

// 只导出外部真正要用的。normalizeWorldbookEntry / worldbookEntryList 是
// 这个文件的内部步骤，导出去只会让人以为别处可以直接调它们。
module.exports = {
  MAX_WORLDBOOK_ENTRIES,
  MAX_WORLDBOOK_CHARACTERS,
  MAX_WORLDBOOK_OPENING,
  normalizeWorldbook,
  worldbookFromCharacterBook,
  worldbookFromLorebook,
  looksLikeLorebook
};
