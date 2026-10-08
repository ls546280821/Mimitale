'use strict';

// ============================================================================
//  main/characters.js —— 角色卡的数据整理
//
//  独立成模块是为了让 tools/smoke-test.js 能 require 它，跑真正的归一化。
//
//  ⚠️ normalizeCharacter 是白名单式的：只保留显式列出的字段，漏一个就静默丢失。
//  加字段时必须在这里同步加一行。
// ============================================================================

// 头像存成 dataURL 直接塞进 JSON，超过这个长度就不带了，免得文件爆掉。
// 这个上限必须大于「导入上限 × 4/3」（base64 会膨胀约 1.34 倍），
// 否则合法导入的 PNG 会在保存时被悄悄丢掉头像。
const MAX_AVATAR_CHARS = 18000000; // ≈ 13MB 的 PNG，留足余量

// 属性归一化用共享的那一份（主进程 / 渲染层 / 冒烟测试同一份）
const { normalizePanelFields } = require('./panel-fields.js');

// 剧情选项：每轮给几个。上下限和渲染层的 MAX_OPTIONS 对齐。
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 6;
// 没在卡上配过的角色，默认就给这么多条 —— 也就是「默认开着」。
// 想彻底关掉这张卡的选项，得在角色编辑器里把开关取消（那时存的是 `false`）。
const DEFAULT_OPTIONS = 4;

// 角色「属性」的条数上限，和渲染层状态面板的 MAX_PANEL_FIELDS 保持一致
const MAX_ATTRIBUTES = 120;

// 一张卡最多带几张「表情图」。每张都是 base64，所以要有上限。
// 一套完整的情绪差分动辄二三十张，所以给得比一般列表宽。
const MAX_EXPRESSIONS = 60;
// 表情名 / 触发词的单个长度上限
const MAX_EXPRESSION_NAME = 24;
// 一条表情最多几个额外的触发词
const MAX_EXPRESSION_KEYWORDS = 8;
// 表情的「情绪键」（英文短标识）长度上限，给 <emo> 标签用
const MAX_EXPRESSION_KEY = 16;

// 一个角色最多绑几本世界书。导入角色卡时内嵌的那本会自动绑上，
// 之后用户还能手工加，所以给一个够用但不会失控的上限。
const MAX_CHARACTER_WORLDBOOKS = 50;

/**
 * 世界书 id 列表归一化。
 * 去重、去空、限制条数 —— 和渲染层的 normalizeIdList 一个思路。
 */
function normalizeWorldbookIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CHARACTER_WORLDBOOKS) break;
  }
  return out;
}

function newCharacterId() {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

/**
 * 性别归一化。
 * 酒馆卡里常写成 male / female，统一成选择框认的那几个值；
 * 认不出来的一律留空（宁可不填，也不要塞个编辑器里选不中的值进去 —— 那样一保存就丢了）。
 */
function normalizeGender(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return '';
  if (['男', 'male', 'm', 'man', '男性'].includes(text)) return '男';
  if (['女', 'female', 'f', 'woman', '女性'].includes(text)) return '女';
  if (['其他', 'other', 'nonbinary', 'non-binary', '未知'].includes(text)) return '其他';
  return '';
}

/**
 * 剧情选项的配置归一化。
 *
 * 三种情况分得清清楚楚：
 *   · `false`（角色编辑器里明确把开关关掉）→ 原样返回 `false` —— 它是「这张卡不要
 *     剧情选项」的唯一记号，必须活过归一化，否则关掉的角色一存盘就又变成默认开了；
 *   · 没有这个字段 / 形状不对（老卡、手改过的 JSON）→ 给**默认配置**（4 条）。
 *     以前这里返回 null = 不注入，导致「新卡、世界书里自己写的角色、导入的卡」
 *     全都不带剧情选项；现在一律默认开；
 *   · 对象 → 按里面的 count / hint 整理。
 *
 * 调用方只要判空即可（`false` 在 JS 里就是 falsy，和以前的 null 一样落到「不注入」）。
 */
function normalizeOptionsSpec(value) {
  if (value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { count: DEFAULT_OPTIONS, hint: '' };
  }

  const raw = Number(value.count);
  const count = isFinite(raw) ? Math.max(MIN_OPTIONS, Math.min(MAX_OPTIONS, Math.round(raw))) : DEFAULT_OPTIONS;
  const hint = typeof value.hint === 'string' ? value.hint.trim().slice(0, 200) : '';

  return { count, hint };
}

/**
 * 角色「属性」：一串 { name, type, value, min?, max?, hint? }，名字去重，顺序保留。
 *
 * 归一化本身交给 main/panel-fields.js —— 那个模块主进程、渲染层、冒烟测试
 * 三方共用一份。属性以前是「只有名字和值」，现在还能带类型、范围、变化规则，
 * 分开写两份归一化迟早会漂。
 */
function normalizeAttributes(value) {
  return normalizePanelFields(value).slice(0, MAX_ATTRIBUTES);
}

/**
 * 角色「表情图」：一串 { name, keywords, key, default, image }，名字去重、顺序保留。
 *
 *   · name     —— 表情名，同时是默认的触发词（例如「害羞」）
 *   · keywords —— 额外触发词。回复正文里出现名字或任一触发词，就算命中
 *   · key      —— 英文情绪键（例如 shy）。模型在正文里写 <emo>shy</emo> 时按它对上，
 *                 比中文关键词匹配更准；不填也不影响用
 *   · default  —— 标了这一条的，就是「没命中任何表情时显示的那张」。整张卡只留一条
 *   · image    —— dataURL。允许暂缺（先填名字、图以后再传）
 */
function normalizeExpressions(value) {
  if (!Array.isArray(value)) return [];
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const out = [];
  const seen = new Set();
  let hasDefault = false;
  for (const item of value) {
    const r = item && typeof item === 'object' ? item : {};
    const name = str(r.name, MAX_EXPRESSION_NAME);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const keywords = Array.isArray(r.keywords)
      ? r.keywords
          .map((k) => str(k, MAX_EXPRESSION_NAME))
          .filter((k) => k && k !== name)
          .filter((k, i, list) => list.indexOf(k) === i)
          .slice(0, MAX_EXPRESSION_KEYWORDS)
      : [];

    // 情绪键只留字母数字下划线连字符 —— 它是给 <emo> 标签做精确比对的，
    // 夹进空格或标点只会让比对永远落空。
    const key = str(r.key, MAX_EXPRESSION_KEY).toLowerCase().replace(/[^a-z0-9_-]/g, '');

    // 默认脸只认第一条：后面再有标 true 的，当没标。整张卡只能有一个兜底，
    // 多留几个的话「没命中时显示哪张」就变成看顺序了。
    const isDefault = r.default === true && !hasDefault;
    if (isDefault) hasDefault = true;

    const raw = typeof r.image === 'string' && r.image.startsWith('data:image/') ? r.image : '';

    out.push({
      name,
      keywords,
      ...(key ? { key } : {}),
      ...(isDefault ? { default: true } : {}),
      image: raw.length <= MAX_AVATAR_CHARS ? raw : ''
    });
    if (out.length >= MAX_EXPRESSIONS) break;
  }
  return out;
}

/** 把任意来源的角色数据整理成内部统一格式，顺便挡住非法值 */
function normalizeCharacter(raw, source) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

  const avatar = typeof r.avatar === 'string' && r.avatar.startsWith('data:image/') ? r.avatar : '';
  // 角色形象（2:3 立绘），和头像分开存：头像是消息气泡 / 状态卡上那个小圆图，
  // 形象是角色库列表上那张竖版图、点开能看大图。
  const portrait = typeof r.portrait === 'string' && r.portrait.startsWith('data:image/') ? r.portrait : '';
  // 表情图（多张，按回复正文里的关键词取用）。空数组就不落这个键。
  const expressions = normalizeExpressions(r.expressions);

  return {
    id: typeof r.id === 'string' && r.id ? r.id : newCharacterId(),
    name: str(r.name, 120).trim() || '未命名角色',
    avatar: avatar.length <= MAX_AVATAR_CHARS ? avatar : '',
    // ⚠️ 只在原来就有这个键时才写出来（哪怕是空串）。
    //    「没有这个键」= 老卡，只有一张图，读的时候用头像顶上（见 library.js 的
    //    characterPortrait）；「键在、值是空串」= 用户明确不要形象。
    //    写成 portrait: '' 会把老卡全变成「没有形象」，列表就只剩首字色块了。
    ...(typeof r.portrait === 'string' ? { portrait: portrait.length <= MAX_AVATAR_CHARS ? portrait : '' } : {}),
    ...(expressions.length ? { expressions } : {}),
    description: str(r.description, 20000),
    personality: str(r.personality, 10000),
    scenario: str(r.scenario, 10000),
    firstMes: str(r.firstMes, 10000),
    mesExample: str(r.mesExample, 30000),
    systemPrompt: str(r.systemPrompt, 10000),
    postHistoryInstructions: str(r.postHistoryInstructions, 10000),
    creatorNotes: str(r.creatorNotes, 5000),
    // 身份三项。酒馆卡规范里没有它们，有些卡会写在 extensions 里，
    // 所以这里有就收、没有就是空（种族不硬塞「人类」，免得给精灵安个人类）。
    age: str(r.age, 40).trim(),
    gender: normalizeGender(r.gender),
    race: str(r.race, 40).trim(),
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 20)
      : [],
    // 状态面板的字段模板。少了这一行，界面上填的属性一存盘就没了。
    attributes: normalizeAttributes(r.attributes),
    // 剧情选项的配置（每轮给几个 + 额外要求）。没配过的角色默认给 4 条；
    // 只有 `false` 才表示「这张卡明确不要剧情选项」。
    optionsSpec: normalizeOptionsSpec(r.optionsSpec),
    // 角色自带的世界书。导入带 character_book 的角色卡时自动绑上，
    // 之后用户也能自己加/删。
    worldbookIds: normalizeWorldbookIds(r.worldbookIds),
    // 开关：关掉后这张角色在哪儿都不带入自带的那些书。
    // 缺省视为开启（导入即可用）；只有显式 false 才算关。
    worldbookEnabled: r.worldbookEnabled !== false,
    // 「在状态栏显示」：只对世界书副本有意义，勾了才让这个 NPC 的状态进入口条。
    // ⚠️ 白名单式，必须显式保留，否则一存盘就丢。只在显式 true 时写出来。
    ...(r.showInPanel === true ? { showInPanel: true } : {}),
    source: ['png', 'json', 'manual'].includes(r.source) ? r.source : source || 'manual',
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

module.exports = {
  normalizeCharacter,
  normalizeAttributes,
  normalizeExpressions,
  normalizeOptionsSpec,
  normalizeGender,
  normalizeWorldbookIds,
  newCharacterId,
  MAX_AVATAR_CHARS,
  MAX_CHARACTER_WORLDBOOKS,
  MAX_EXPRESSIONS,
  DEFAULT_OPTIONS
};
