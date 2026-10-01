'use strict';

// ============================================================================
//  main/presets.js —— 预设（对话层面叠上去的一层指令）的归一化
//
//  一个预设 = 一段会拼进系统提示词的文本 + 可选的几条采样参数。
//  数据存在 userData\presets.json，只由「会话绑定了哪一个」决定生效。
//
//  ⚠️ 白名单式：没列在这里的字段会被静默丢掉。加字段时这里要同步。
//
//  兼容酒馆那类预设导出：它们把正文放在 metadata.systemPromptContent，
//  或者做成若干条 entries（正文里有 {{char}} 这类可选替换）。
// ============================================================================

// 单个预设的正文上限。预设是「每轮都要带上的指令」，本来就不该太长 ——
// 给足余量（比世界书条目宽），但必须有上限，否则一个误粘贴能把请求撑爆。
const MAX_PRESET_CONTENT = 20000;
const MAX_PRESETS = 200;
const MAX_PRESET_ENTRIES = 100;

/** 采样参数的取值范围。空串 / null / 非数字 = 没设过，不覆盖全局设置 */
function optNumber(value, min, max) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/** 预设里可选挂的条目：正文 + 可选的关键词（有关键词就只在命中时带上） */
function normalizePresetEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const content = typeof r.content === 'string' ? r.content.slice(0, MAX_PRESET_CONTENT).trim() : '';

  const keys = (Array.isArray(r.keys) ? r.keys : typeof r.key === 'string' ? [r.key] : [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim().slice(0, 200))
    .slice(0, 50);

  // 没正文、也没关键词的条目没有任何作用，直接丢掉
  if (!content && !keys.length) return null;

  const title =
    (typeof r.title === 'string' && r.title) || (typeof r.comment === 'string' && r.comment) || '';

  return {
    id: typeof r.id === 'string' && r.id ? r.id : `pe${Math.random().toString(36).slice(2, 10)}`,
    title: String(title).slice(0, 200).trim() || keys[0] || '未命名条目',
    keys,
    content,
    // 有关键词就默认「只在命中时带上」，没关键词就是常驻
    constant: r.constant === true || !keys.length,
    enabled: r.enabled !== false
  };
}

/**
 * 归一化一个预设。
 * @param {object} raw 磁盘上（或界面传来的）预设对象
 */
function normalizePreset(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};

  // 正文来源依次：顶层 content → metadata.systemPromptContent（酒馆那类导出）
  const direct = typeof r.content === 'string' ? r.content : '';
  const fromMeta = typeof meta.systemPromptContent === 'string' ? meta.systemPromptContent : '';
  // ⚠️ 这里刻意**不**回落到 description：描述是给人看的说明，正文是给模型看的指令，
  //    两者混起来会让「描述改了、注入的规则也跟着变」，很难排查。
  const content = (direct || fromMeta).slice(0, MAX_PRESET_CONTENT);

  const rawEntries = Array.isArray(r.entries) ? r.entries : [];
  const entries = [];
  for (const item of rawEntries) {
    const entry = normalizePresetEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_PRESET_ENTRIES) break;
  }

  // 标签：去重、去空、限长 —— 和角色卡那边的 tags 是同一套用法
  const seen = new Set();
  const tags = (Array.isArray(r.tags) ? r.tags : [])
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().slice(0, 24))
    .filter((t) => {
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .slice(0, 10);

  return {
    id: typeof r.id === 'string' && r.id ? r.id : undefined,
    name: (typeof r.name === 'string' ? r.name : '').slice(0, 120).trim() || '未命名预设',
    note: (typeof r.note === 'string'
      ? r.note
      : typeof r.description === 'string'
        ? r.description
        : ''
    )
      .slice(0, 500)
      .trim(),
    tags,
    content,
    entries,
    // 采样参数：null = 用设置里的全局值。只在明确填过的时候才覆盖。
    temperature: optNumber(r.temperature, 0, 2),
    maxTokens: (() => {
      const n = optNumber(r.maxTokens, 64, 32000);
      return n === null ? null : Math.round(n);
    })(),
    topP: optNumber(r.topP, 0, 1),
    // 界面上的「启用」开关。关掉的预设不出现在绑定列表里，但数据保留。
    enabled: r.enabled !== false,
    // 「没挂预设的对话自动带上它」—— 一个预设自己带的范围属性。
    // 多条可以同时为 true（各管一块，比如「禁比喻」+「固定称呼」都不冲突），
    // 会话里手动配过的则以会话配的那份为准。
    global: r.global === true,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

module.exports = {
  MAX_PRESETS,
  MAX_PRESET_CONTENT,
  MAX_PRESET_ENTRIES,
  normalizePreset,
  normalizePresetEntry
};
