'use strict';

// ============================================================================
//  data/panel.js —— 状态（世界模型的状态栏）：解析 / 归一化 / 夹取 / 注入
//
//  模型每轮输出一段固定格式的状态栏，比如：
//      【金币】：100
//      【时间】：早上
//  把它交给模型自己「抄上一轮」是靠不住的 —— 历史会被 maxTurns 截断，
//  一旦截出去模型就开始编数值。所以这里把它解析出来存到会话上，
//  每轮由程序权威注入，数值就不会漂了。
//
//  ★ 字段是「字段名 + owner」的复合键（owner 空 = 场景字段）。
//    以前这些字段画在顶部那块「当前状态」面板里；那个面板已经去掉
//    （一个面板只能显示一个角色的状态，是旧版单角色的遗留），
//    现在按 owner 分给各人的状态卡（views/stateCard.js），面板只剩入口条。
//    → 本文件里「面板」这些叫法都指「状态字段本身」，跟那块已经删掉的
//      界面面板不是一回事，别被名字带偏。
//
//  纯逻辑，不碰 DOM。字段的类型/范围/变化规则由 main/panel-fields.js 定义，
//  主进程加载的是同一个文件，所以「范围怎么夹」两边跑的是同一份代码。
//
//  剧情选项（【剧情选项】：A / B / C）的解析也在这里：它和状态栏是同一类东西 ——
//  程序读的中间产物，解析出来之后正文里就该剥掉（值已经由状态字段权威注入、
//  选项已经变成可点的按钮，原文留在气泡里只会吵）。
// ============================================================================

import { now, asArray } from '../core/util.js';
import {
  clampFieldValue,
  normalizePanelField,
  groupPanelFields,
  describePanelField,
  trimNumber
} from '../core/panel-fields.js';
// 面板的写入口（setPanelField）改完值要落盘，所以 data 层里有一条
// panel → persist 的单向依赖。方向是单一的，不构成环。
import { persistConversations } from './persist.js';
// 「把角色卡的属性种进面板」要读卡上的 attributes（走共享归一化）。
// library 只依赖 core，不反向依赖这里，所以不成环。
// 复合键方案还需要「owner id → 角色名」的解析（注入加前缀 / 扫描解析前缀用），
// 所以把角色库 / 世界书的查询也一起引进来（它们同样不反向依赖 panel）。
import {
  characterAttrs,
  characterById,
  characters,
  convoWorldbookIds,
  worldbookById,
  worldbookCharacters
} from './library.js';
// 表情标签 <emo>…</emo> 也要从正文里剥掉，而「长什么样」只有 expressions.js 知道。
// 它同样只依赖 library，不反向依赖这里，不成环。
import { stripEmoTags } from './expressions.js';

// 字段行：全角/半角冒号都认。字段名限制在 24 字内，避免把长句子误当成字段。
const PANEL_LINE_RE = /^【([^】\n]{1,24})】[：:]\s*(.*)$/;
// 单行最长长度：面板行都是「字段：短值」，超长的更像正文
const PANEL_LINE_MAX = 200;
// 还没有已知字段时，值超过这个长度就不认为是面板（首次扫描的兜底判断）
const PANEL_GUESS_VALUE_MAX = 60;

// 明确不当面板的字段名：这些是我们自己注入的提示词段落，或消息渲染用的标记。
//
// ⚠️ 「剧情选项」必须在这里 —— 它 /值/ 长得很像一个面板字段（行首【】、值也不长），
// 但它是**程序读的指令行**：解析出来变成按钮之后就该消失（见 stripOptionsLine）。
// 以前漏了它，于是 syncConvoPanel 扫描时把它收成了一个名叫「剧情选项」的面板字段，
// 而 cleanAssistantText 又把这一行剥掉了 —— 扫描和剥离两套规则不一致，
// 结果就是气泡里看不见、面板上却凭空多出一个字段。
// 注意这里只能用字面量：OPTIONS_LABEL 定义在下面（它是 export 给别处用的），
// 往上提会把这段常量的可读顺序打乱，而这个名字本来也不会变。
const PANEL_RESERVED = new Set([
  '心理', '内心', '心声', '旁白', '上帝视角', '全知',
  '扮演规则', '主持规则', '当前场景', '世界设定', '参考信息', '叙述要求',
  '剧情选项'
]);

export const MAX_PANEL_FIELDS = 120;

// ---------------------------------------------------------------------------
//  字段的「身份」：字段名 + 归属（owner）
//
//  以前一个字段就是「名字」一个维度 —— panelFields 存字段名、panel / panelDefs
//  的键也是字段名。这套在世界书里撞了个大 bug：两个角色都有「好感度」「生命」
//  这种同名字段时，字段名全局去重，后种进去的那个角色的同名字段全被挤掉，
//  点它的状态卡就只剩几个没撞名的字段（「显示不全」）。
//
//  现在字段的身份升级成「字段名 + owner」：
//    · owner 为空 = 场景字段（不归属任何人），键仍是纯字段名（向后兼容老数据）；
//    · owner 非空 = 某个人的字段（'player' 或角色卡 id），键 = name + SEP + owner。
//  这样每个角色都能各自持有自己的「好感度」，互不挤占。
//
//  ⚠️ 键里用 \u0000 分隔：它不可能出现在字段名或角色 id 里，天然不会撞。
// ---------------------------------------------------------------------------
const OWNER_SEP = '\u0000';

/** 字段的存储键：owner 为空就是纯字段名，否则「字段名\u0000owner」 */
export function panelKey(name, owner) {
  const n = String(name == null ? '' : name);
  const o = typeof owner === 'string' && owner ? owner : '';
  return o ? `${n}${OWNER_SEP}${o}` : n;
}

/** 从存储键拆出字段名和 owner（键里没有分隔符就 owner 为空） */
export function panelKeyParts(key) {
  const k = String(key == null ? '' : key);
  const i = k.indexOf(OWNER_SEP);
  return i < 0 ? { name: k, owner: '' } : { name: k.slice(0, i), owner: k.slice(i + 1) };
}

/** 存储键的显示名（去掉 owner 尾巴，就是字段名本身） */
export function panelFieldName(key) {
  return panelKeyParts(key).name;
}

/**
 * owner id → 显示名（注入状态栏时给字段加「谁的前缀」用）。
 *   · 'player' → 玩家在会话里的名字（没进世界就退回「我」）
 *   · 角色卡 id / 世界书副本 id → 那张卡的名字
 *   · 空 / 查不到 → 空串（无前缀，字段名原样）
 */
export function panelOwnerLabel(convo, owner) {
  const o = String(owner == null ? '' : owner);
  if (!o) return '';

  if (o === 'player') {
    const p = convo && convo.player;
    const n = String((p && p.name) || '').trim();
    return n || '我';
  }

  const card = findCardForOwner(convo, o);
  return (card && card.name) || o;
}

/**
 * owner id → 卡对象。先查角色库，再查本会话绑定的世界书里的角色副本。
 * （和 cast.js 的 findCardById 是同一套查找，但 panel 不能 import cast ——
 * cast 反向 import panel，会成环。）
 */
function findCardForOwner(convo, id) {
  const target = String(id || '').trim();
  if (!target) return null;

  // 'player' 不是卡 id，但「挑一张卡当自己」之后「我」名下也有卡属性 ——
  // 认领字段 / 取描述时都得能顺着它找到那张卡。
  if (target === 'player') {
    const picked = convo && convo.player && convo.player.characterId;
    return picked ? findCardForOwner(convo, picked) : null;
  }

  const direct = characterById(target);
  if (direct) return direct;

  if (convo) {
    for (const bookId of convoWorldbookIds(convo)) {
      const book = worldbookById(bookId);
      const found = book ? worldbookCharacters(book).find((c) => c && c.id === target) : null;
      if (found) return found;
    }
  }
  return null;
}

/**
 * 注入状态栏时的字段名：只有「同一个字段名被多个 owner 共用」时才拼
 * 「角色名·字段名」前缀（否则模型分不清同名归属）；无冲突的字段保持纯字段名，
 * 单角色聊天完全不受影响。
 *
 * hasClash 由调用方算好传进来（一个字段名是否被多个 owner 共用）。
 */
function panelFieldDisplayName(convo, key, hasClash) {
  const { name, owner } = panelKeyParts(key);
  if (!owner) return name;
  if (!hasClash || !hasClash(name)) return name;
  const label = panelOwnerLabel(convo, owner);
  return label ? `${label}·${name}` : name;
}

/** 会话里「被多个 owner 共用的字段名」集合 —— 只有这些才需要前缀区分 */
function clashingFieldNames(convo) {
  const owners = new Map();
  for (const key of convoPanelFields(convo)) {
    const { name, owner } = panelKeyParts(key);
    if (!owner) continue;
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name).add(owner);
  }
  const clash = new Set();
  for (const [name, set] of owners) {
    if (set.size > 1) clash.add(name);
  }
  return clash;
}

/** 分隔角色名和字段名的点（注入时用「·」拼，扫描时按它拆） */
const OWNER_LABEL_SEP = '·';

/**
 * 扫描时，把模型输出的「字段名」（可能带「角色名·」前缀）拆成归属。
 * 返回 { owner, name }：owner 是反查到的 id（查不到就空 = 无归属/场景）。
 *
 * 为什么只按「·」拆一次、拆不开就当无归属：模型不一定照抄前缀，拆错了
 * 顶多把这条归到场景，不会丢数据、也不会崩 —— 归属信息本来就是种入时定的。
 */
function parseFieldLabel(convo, label) {
  const text = String(label == null ? '' : label).trim();
  const i = text.indexOf(OWNER_LABEL_SEP);
  if (i <= 0) return { owner: '', name: text };

  const head = text.slice(0, i).trim();
  const name = text.slice(i + 1).trim();
  if (!head || !name) return { owner: '', name: text };

  // 反查：head 是某个在场角色的名字（或玩家名）吗？
  const owner = ownerIdByLabel(convo, head);
  return owner ? { owner, name } : { owner: '', name: text };
}

/** 显示名 → owner id 的反查（「露西娅」→ 露西娅副本 id）。查不到返回空。 */
function ownerIdByLabel(convo, label) {
  const text = String(label || '').trim();
  if (!text || !convo) return '';

  const p = convo.player;
  if (p && String(p.name || '').trim() === text) return 'player';

  // 会话里已有的 owner 先认一遍：模型照抄的前缀就是我们注入的显示名，
  // 按它反查最准（角色库可能有同名卡，按名字查会认错人）。
  for (const key of convoPanelFields(convo)) {
    const owner = panelKeyParts(key).owner;
    if (owner && owner !== 'player' && panelOwnerLabel(convo, owner) === text) return owner;
  }

  // 这一局绑定的那张卡优先 —— 角色库里可能有同名的卡，先认正在聊的这位
  const boundId = String(convo.characterId || '').trim();
  if (boundId) {
    const bound = characterById(boundId);
    if (bound && String(bound.name || '').trim() === text) return bound.id;
  }

  // 角色库要按**名字**找。characterById 是按 id 查的，拿名字去查永远查不到 ——
  // 角色库里的卡一旦被写进状态栏（「露西娅·好感度」），前缀就会拆不开。
  const inLibrary = characters().find((c) => c && String(c.name || '').trim() === text);
  if (inLibrary) return inLibrary.id;

  for (const bookId of convoWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    if (!book) continue;
    const found = worldbookCharacters(book).find((c) => c && String(c.name || '').trim() === text);
    if (found) return found.id;
  }
  return '';
}

// 身份四项（姓名/年龄/性别/种族）在状态面板里的分组名。它们和「时间/地点/
// 好感度」这类随剧情变化的动态状态不是一回事，单独成块，跟状态栏/关系/背包并列。
export const IDENTITY_GROUP = '身份';

// 身份四项的字段名。老会话种身份时还没有「身份」分组，panelDefs 里没记 group；
// 按字段名兜底归组（见 panelFieldGroup），新旧会话的展示和注入就一致了。
const IDENTITY_FIELD_NAMES = new Set(['姓名', '年龄', '性别', '种族']);

/**
 * 会话面板字段属于哪个分组：优先用 defs 里记的；没记 group 且是身份四项的，
 * 兜底归进「身份」。分组只是视图键，面板上的分组编辑不存在（组的归属在
 * 种进去那一刻就定了），所以这个兜底不会跟任何手工操作打架。
 */
export function panelFieldGroup(convo, key) {
  const name = panelFieldName(key);
  const group = (convoPanelDef(convo, key) || {}).group || '';
  if (group) return group;
  return IDENTITY_FIELD_NAMES.has(name) ? IDENTITY_GROUP : '';
}

export const OPTIONS_LABEL = '剧情选项';
// 方括号可有可无：指令让模型输出「【剧情选项】：A / B / C」，但模型偶尔会
// 漏掉方括号只写「剧情选项：A / B / C」，两边都要能解析出来才稳。
export const OPTIONS_LINE_RE = /^【?剧情选项】?[：:]\s*(.*)$/;

export function panelFieldAllowed(name) {
  return !PANEL_RESERVED.has(name) && !name.includes('的设定') && !name.includes('的性格');
}

/**
 * 从一段文本里抽出面板字段（保持出现顺序）。
 *
 * knownFields：已经确立的字段名。给了它就以它为准 —— 正文里出现的
 * 「【某某】：……」不会被误收。只有第一次扫（还没有已知字段）时才靠
 * 形态猜测，这时候用「值很短」这个条件兜一下，避免把整段正文当面板。
 */
function extractPanelFromText(text, knownFields) {
  const known = knownFields && knownFields.length ? new Set(knownFields) : null;
  const found = new Map();

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '');
    if (line.length > PANEL_LINE_MAX) continue;

    const m = line.match(PANEL_LINE_RE);
    if (!m) continue;

    const name = m[1].trim();
    if (!name || !panelFieldAllowed(name)) continue;

    const value = m[2].trim();

    // 已知字段直接收；未知字段只在首次扫描时按形态判断
    if (!known && value.length > PANEL_GUESS_VALUE_MAX) continue;
    if (known && !known.has(name) && value.length > PANEL_GUESS_VALUE_MAX) continue;

    found.set(name, value.slice(0, 500));
    if (found.size >= MAX_PANEL_FIELDS) break;
  }

  return found;
}

/**
 * 从一段文本里剥掉面板行。
 * 面板由程序权威注入，历史里再留一份只会白烧 token，还可能和注入值冲突。
 * 传了 knownFields 就只剥那些字段（正文里提到同名字样不会被误删）。
 */
export function stripPanelLines(text, knownFields) {
  const source = String(text || '');
  if (!source.trim()) return source;

  const known = knownFields && knownFields.length ? new Set(knownFields) : null;

  const out = source
    .split('\n')
    .filter((rawLine) => {
      const line = rawLine.trim().replace(/^[-*+]\s+/, '');
      if (line.length > PANEL_LINE_MAX) return true;

      const m = line.match(PANEL_LINE_RE);
      if (!m) return true;

      const name = m[1].trim();
      if (!name || !panelFieldAllowed(name)) return true;

      if (known) return !known.has(name);

      // 没有已知字段（首轮）时保守一点：只剥「短值」的面板行
      return m[2].trim().length > PANEL_GUESS_VALUE_MAX;
    });

  return collapseBlankLines(out.join('\n')).trim();
}

/**
 * 会话里有哪些「分组名」—— 从 panelDefs 各字段的 group 收集，再加上身份四项
 * 兜底的「身份」。这些组名就是注入时 `—— 组名 ——` 小标题的来源，
 * 剥正文时拿它来认分组标题（只剥已知组名，避免误删正文里「—— 破折号 ——」引语）。
 */
export function panelGroupNames(convo) {
  const names = new Set();
  const defs = convoPanelDefs(convo);
  for (const key of Object.keys(defs)) {
    const g = (defs[key] || {}).group;
    if (g) names.add(g);
  }
  // 身份四项可能没记 group（老会话），但 panelFieldGroup 会兜底成「身份」，
  // 所以只要面板里有身份字段，就把「身份」也算作已知分组。
  for (const key of convoPanelFields(convo)) {
    if (IDENTITY_FIELD_NAMES.has(panelFieldName(key))) {
      names.add(IDENTITY_GROUP);
      break;
    }
  }
  return names;
}

/** 分组标题正则：`—— 组名 ——`。中文全角破折号，两边可有空格。 */
const GROUP_HEADER_RE = /^——\s*([^—\n]{1,24})\s*——$/;

/**
 * 裸方括号组名：`【组名】`。模型会把分组名套上方括号当「状态块标题」写回来，
 * 处理上和 `—— 组名 ——` 同等对待：组名在 knownGroups 里才剥。
 */
const GROUP_BRACKET_RE = /^【\s*([^】【\n]{1,24})\s*】$/;

// 状态块抬头：程序注入的是 ASCII 的 `[当前状态]`（见 formatPanelForPrompt），
// 模型照抄回来时可能原样带 ASCII 方括号，也可能写成全角 `【当前状态】`。
// 两者都是给模型看的块标题，不是正文，正文里留着很突兀。
const STATUS_HEADER_RE = /^[\[【]\s*当前状态\s*[\]】]$/;

/**
 * 从一段文本里剥掉分组小标题。认两种形状：
 *   · `—— 组名 ——`（程序注入的形状，模型照抄）
 *   · `【组名】`（模型自己发明的变体，把组名套上方括号当块标题）
 * 都只剥 knownGroups 里列出的组名 —— 正文里「—— 他顿了顿 ——」这种破折号引语、
 * 或整行只有 `【别的什么】` 的引用，组名不在列表里，不会被误删。
 */
function stripPanelGroupHeaders(text, knownGroups) {
  const source = String(text || '');
  if (!source.trim()) return source;
  const known = knownGroups && knownGroups.length ? new Set(knownGroups) : null;
  if (!known || !known.size) return source;

  const out = source.split('\n').filter((rawLine) => {
    const line = rawLine.trim();
    let m = line.match(GROUP_HEADER_RE);
    if (m) return !known.has(m[1].trim());
    m = line.match(GROUP_BRACKET_RE);
    if (m) return !known.has(m[1].trim());
    return true;
  });

  return collapseBlankLines(out.join('\n')).trim();
}

/** 连续空行压成一个，去掉首尾空白（剥面板后容易留下空格） */
function collapseBlankLines(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 把「【剧情选项】：…」这一行剥掉。
 * 它和状态栏一样是给程序读的：程序把它解析成按钮之后，正文里再留一份
 * 就是重复（选项已经是可点的按钮了，原文留在气泡里只会吵）。
 */
function stripOptionsLine(text) {
  const source = String(text || '');
  if (!source.includes(OPTIONS_LABEL)) return source;

  const out = source.split('\n').filter((rawLine) => !OPTIONS_LINE_RE.test(rawLine.trim()));
  return collapseBlankLines(out.join('\n')).trim();
}

/**
 * 从一段文本里剥掉「[当前状态] / 【当前状态】」抬头。
 * 它是程序注入的状态块标题（模型照抄回来时也会带一行），和状态栏行一样是
 * 给模型看的排版提示 —— 值已经由面板权威持有，正文里再留这个标题只会突兀。
 */
function stripStatusHeader(text) {
  const source = String(text || '');
  if (!source.trim()) return source;
  const out = source.split('\n').filter((rawLine) => !STATUS_HEADER_RE.test(rawLine.trim()));
  return collapseBlankLines(out.join('\n')).trim();
}

/**
 * 助手消息的正文该怎么给模型/界面看：状态块抬头、状态栏行、分组小标题、
 * 剧情选项行、表情标签都剥掉。它们都是程序读的中间产物 —— 值已经由面板权威注入，
 * 选项已经变成按钮，表情已经换成卡上的图，抬头和分组标题是给模型看的排版提示，
 * 正文里留着只会像漏网之鱼一样突兀地挂在那儿。
 */
export function cleanAssistantText(text, panelFields, knownGroups) {
  return stripEmoTags(
    stripStatusHeader(
      stripOptionsLine(stripPanelGroupHeaders(stripPanelLines(text, panelFields), knownGroups))
    )
  );
}

/**
 * 状态块的一行长什么样（流式阶段用它判断「状态块从这一行开始」）。
 * 都是程序注入的固定格式，模型照抄回来时行首一定长这样：
 *   · 【字段】：值          字段行（剧情选项行也是这个形状）
 *   · 【当前状态】          全角写法的块抬头
 *   · [当前状态]            ASCII 写法的块抬头（程序注入的就是这个）
 *   · —— 组名 ——          分组小标题
 *   · 剧情选项：…           漏掉方括号的选项行
 *   · <emo>shy</emo>       表情标签（模型按提示写在回复末尾，和状态块同一片）
 */
function isStatusBlockLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('【')) return true;
  if (t.startsWith('——')) return true;
  if (t.startsWith('[当前状态')) return true;
  if (t.startsWith('剧情选项')) return true;
  if (/^<\s*emo\b/i.test(t)) return true;
  return false;
}

/**
 * 流式阶段的显示文本：把末尾的「状态块」整体砍掉，只留正文。
 *
 * 为什么不用 cleanAssistantText：它在流式阶段会**抖动**。每 token 重算时，
 * 半截的字段行（【时间】还没写到冒号）匹配不上正则，会闪一两帧再被剥掉 ——
 * 字段多的时候一行闪一次，气泡就上下抖。
 *
 * 这里改成「从第一个状态行起整体截断」：状态行一旦认出就从那行砍断，
 * 砍断点只进不退，正文（前半段）逐 token 稳定增长，不会忽长忽短。
 * 收尾重绘（renderMessages）仍走 cleanAssistantText 做精确剥除，
 * 所以这里宁可多砍一点也没关系 —— 反正状态块是模型最后输出的、永远在末尾。
 */
export function cutTrailingStatusBlock(text) {
  const lines = String(text || '').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (isStatusBlockLine(lines[i])) {
      cut = i;
      break;
    }
  }
  // 正文里（不在末尾）出现标签时行级截断兜不住，这里再抹一道
  return stripEmoTags(lines.slice(0, cut).join('\n'));
}

export function convoPanelFields(convo) {
  return asArray(convo && convo.panelFields);
}

export function convoPanel(convo) {
  return convo && convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
}

/**
 * 字段定义表（名字 → {type, min, max, hint}）。
 *
 * 为什么存在**会话**上、而不是每轮去查角色卡：
 *   · 面板值本来就存在会话上，定义跟着走才不会两边对不上；
 *   · 这一局中途换了角色、或者把角色卡删了，正在进行的局仍然该受原来的约束；
 *   · 老会话没有这张表 → 返回空，一切照旧（范围/hint 是可选增强）。
 */
export function convoPanelDefs(convo) {
  return convo && convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};
}

/**
 * 归一化整张定义表。读盘进来的数据不可信（用户手改过 JSON、版本更老），
 * 所以只留真正能用的条目，其余丢掉 —— 丢一条定义只是少了范围提示，
 * 留一条坏定义却可能让夹取逻辑算出个乱值。
 *
 * 兼容两种键：老格式纯字段名（owner 记在 def.owner 里）、新格式复合键
 * （「字段名\u0000owner」，owner 既在键里也在 def.owner 里）。归一化时按
 * 字段名处理、按复合键写回，两种输入产出同一种规范格式。
 */
export function normalizePanelDefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out = {};
  let count = 0;
  for (const rawKey of Object.keys(value)) {
    if (count >= MAX_PANEL_FIELDS) break;
    const raw = value[rawKey];
    if (!raw || typeof raw !== 'object') continue;

    const { name, owner: keyOwner } = panelKeyParts(rawKey);
    const owner = (raw.owner && typeof raw.owner === 'string' ? raw.owner : keyOwner) || '';

    const def = normalizePanelField({ ...raw, name, owner, value: '' });
    if (!def) continue;
    // normalizePanelField 对没有意义的定义只回 type:'text' 且没有范围/hint，
    // 这种和「没有定义」等价，不用存。但**分组（group）和归属（owner）本身是有意义的**——
    // 「状态栏」里的时间/地点/心情都是纯文本、没有范围/hint，全靠 group 才
    // 不被拆散成零散字段；玩家的字段全靠 owner 才能从面板里拆出来单独看。
    // 漏掉的话，重启后这些字段会被 normalize 丢光分组/归属信息、散回「未分组」。
    const hasRange = typeof def.min === 'number' || typeof def.max === 'number';
    const hasMode = def.mode && def.mode !== 'dynamic';
    if (def.type === 'text' && !def.hint && !hasRange && !def.group && !def.owner && !hasMode) continue;

    const key = panelKey(def.name, def.owner);
    out[key] = {
      type: def.type,
      ...(typeof def.min === 'number' ? { min: def.min } : {}),
      ...(typeof def.max === 'number' ? { max: def.max } : {}),
      ...(def.hint ? { hint: def.hint } : {}),
      ...(def.group ? { group: def.group } : {}),
      ...(def.owner ? { owner: def.owner } : {}),
      ...(def.mode && def.mode !== 'dynamic' ? { mode: def.mode } : {})
    };
    count += 1;
  }
  return out;
}

/** 某个字段的定义（可能是 undefined —— 表示没有范围/hint） */
export function convoPanelDef(convo, name) {
  const def = convoPanelDefs(convo)[name];
  return def && typeof def === 'object' ? def : null;
}

/**
 * 字段属于谁：'player' = 玩家自己；某个角色卡 id = 那个角色；空 = 场景/不归属。
 * 用来把「我的状态」从面板里拆出去单独看（面板只显示 owner 为空的）。
 *
 * 归属以**存储键里的 owner** 为准（复合键方案）；老数据（纯字段名键）则退回
 * def 里记的 owner —— 迁移前两者是一致的，迁移后键里就是权威。
 */
export function panelFieldOwner(convo, key) {
  const fromKey = panelKeyParts(key).owner;
  if (fromKey) return fromKey;
  const owner = (convoPanelDef(convo, key) || {}).owner;
  return typeof owner === 'string' && owner ? owner : '';
}

/**
 * 会话里去重后的「显示名」列表（有归属冲突的字段是「角色名·字段名」，其余原名）。
 * 剥正文 / 流式剥状态块时用它做 knownFields —— 因为注入和模型照抄的都是显示名。
 */
export function convoFieldDisplayNames(convo) {
  const clash = clashingFieldNames(convo);
  const seen = new Set();
  const out = [];
  for (const key of convoPanelFields(convo)) {
    const dn = panelFieldDisplayName(convo, key, (name) => clash.has(name));
    if (dn && !seen.has(dn)) {
      seen.add(dn);
      out.push(dn);
    }
  }
  return out;
}

/**
 * 把一个值按字段范围夹回去。返回夹过之后的字符串。
 * 没有定义 / 不是数值字段 / 解析不出数字，都原样返回。
 * defs 可以不传（默认用会话上的定义表）—— 同步历史时定义表还在构建中，
 * 那时要显式把新的传进来，否则新推断出来的范围当轮不生效。
 */
function clampPanelValue(convo, name, value, defs) {
  const table = defs && typeof defs === 'object' ? defs : convoPanelDefs(convo);
  const def = table[name];
  if (!def || typeof def !== 'object') return value;
  return clampFieldValue(value, def).value;
}

/**
 * 把会话历史里出现过的面板字段同步到 convo.panel。
 * 取「最近一条提到该字段的助手消息」的值，所以手动改过的旧轮次会被更新的值覆盖。
 * 返回是否发生了变化 —— 调用方据此决定要不要重绘面板。
 *
 * 注意这里是**累积**而不是「从历史重建」：
 * 角色卡带过来的字段、以及用户在面板里手动加的字段，这一轮模型可能压根没提到
 * （小模型经常不听话），从零重建会把它们连值一起抹掉。
 * 所以以现有面板为底，把历史里扫到的值盖上去。
 */
/**
 * 自愈：同一个角色身上可能同时躺着「好感度」和「露西娅·好感度」两份。
 *
 * 前缀拆不开的那些日子里，模型照抄「角色名·字段名」会被当成一个新字段名
 * 整个存下来。现在拆得开了，已经落盘的还得并回去。
 * 只在前缀确实指同一个 owner、且那个 owner 已经有去掉前缀的同名字段时才合并 ——
 * 保守起见不碰任何正常的复合键（字段名里本来带间隔号的会被前缀反查挡掉）。
 */
function healPrefixedKeys(convo) {
  const fields = convoPanelFields(convo);
  if (!fields.length) return false;

  const panel = { ...convoPanel(convo) };
  const remove = new Set();

  for (const key of fields) {
    const { name, owner } = panelKeyParts(key);
    if (!owner || !name.includes(OWNER_LABEL_SEP)) continue;

    const i = name.indexOf(OWNER_LABEL_SEP);
    const head = name.slice(0, i).trim();
    const rest = name.slice(i + 1).trim();
    if (!head || !rest) continue;
    if (ownerIdByLabel(convo, head) !== owner) continue;

    const target = panelKey(rest, owner);
    if (!fields.includes(target)) continue;

    // 手改过的以面板里的为准；否则用这份 —— 它是模型最近写进来的
    if (!(convo.panelManual && convo.panelManual[target]) && String(panel[key] || '').trim()) {
      panel[target] = panel[key];
    }
    remove.add(key);
  }

  if (!remove.size) return false;

  const defs = { ...convoPanelDefs(convo) };
  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  for (const key of remove) {
    delete panel[key];
    delete defs[key];
  }
  convo.panelDefs = defs;
  return true;
}

export function syncConvoPanel(convo) {
  if (!convo || !Array.isArray(convo.messages)) return false;

  // 先把老数据里「角色名·字段名」重复的字段并回去，再按正常流程扫
  healPrefixedKeys(convo);

  const beforeFields = convoPanelFields(convo).join('\u0001');
  const beforePanel = JSON.stringify(convoPanel(convo));

  const existingFields = convoPanelFields(convo);
  const existingPanel = convoPanel(convo);

  // 字段顺序：先保留已有的（角色卡种下的 / 手动加的），新发现的追加在后面。
  // 顺带把「保留名」剔出去（按字段名维度过滤），让老会话里的同名脏字段一跑就自愈。
  const order = existingFields.filter((key) => panelFieldAllowed(panelFieldName(key)));
  const defs = { ...convoPanelDefs(convo) };
  // 定义表里也要清：脏字段的定义留着的话，cleanAssistantText 剥旧消息时
  // 还会把它当「已知字段」照剥（那边是按 knownFields 判断的），不一致。
  for (const key of Object.keys(defs)) {
    if (!panelFieldAllowed(panelFieldName(key))) delete defs[key];
  }

  // 已存在的复合键集合（判断扫描到的字段是不是新字段）
  const keySet = new Set(order);
  // 传给 extractPanelFromText 的「已知字段名」：显示名（有冲突才带归属前缀），去重。
  // 模型看到的/照抄的就是显示名（注入时 formatPanelForPrompt 写的就是它），
  // 所以这里必须以显示名做 knownFields，否则带前缀的字段会被当成未知字段，
  // 值一长就被误 skip。
  const clash = clashingFieldNames(convo);
  const knownNames = [];
  const known = new Set();
  for (const key of order) {
    const dn = panelFieldDisplayName(convo, key, (name) => clash.has(name));
    if (dn && !known.has(dn)) {
      known.add(dn);
      knownNames.push(dn);
    }
  }
  const latest = new Map();

  for (const msg of convo.messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const content = String(msg.content || '');
    if (!content.includes('【')) continue;

    const found = extractPanelFromText(content, knownNames);
    for (const [rawName, value] of found) {
      // 模型可能带「角色名·字段名」前缀（我们注入时就是这么写的）。拆出归属，
      // 反查到 owner 就更新那个角色的字段；拆不开就退回纯字段名（场景/无归属）。
      const { owner, name } = parseFieldLabel(convo, rawName);
      const key = panelKey(name, owner);

      if (!keySet.has(key)) {
        if (order.length >= MAX_PANEL_FIELDS) continue;
        order.push(key);
        keySet.add(key);
        // 模型自己冒出来的字段：从值的形状补个定义（「63/100」= 带范围的数值），
        // 否则它永远没有进度条、也不受范围约束。
        if (!defs[key]) {
          const inferred = inferPanelDef(name, value);
          if (inferred) {
            const d = { ...inferred };
            if (owner) d.owner = owner;
            defs[key] = d;
          }
        }
        // 有新字段时，后续消息扫描用的 knownNames 也要带上它（带上原始写法，
        // 让 extractPanelFromText 认它是已知字段）
        if (!known.has(rawName)) {
          known.add(rawName);
          knownNames.push(rawName);
        }
      }
      latest.set(key, value);
    }
  }

  // 值：历史里扫到的优先（最新一轮说了算），没扫到的沿用面板里现有的。
  // 有范围的数值字段在这里夹一下 —— 模型写 150/100、-5/100 都会被拉回范围内，
  // 否则面板上会长期挂着一个越界的数，而且下一轮它还会照抄那个越界值。
  const panel = {};
  for (const key of order) {
    const value = latest.has(key) ? latest.get(key) : existingPanel[key];
    if (value !== undefined) panel[key] = clampPanelValue(convo, key, value, defs);
  }

  convo.panelFields = order;
  convo.panel = panel;
  convo.panelDefs = defs;

  // 扫描收尾：把「AI 没带前缀、落到无主批里」的字段并回主角。
  // 入口条上已经没有「世界」这张卡了，所以不归属任何人的字段必须有个归处 ——
  // 而 AI 输出的状态栏本来就是「你此刻的状态」，归给主角是唯一说得通的解释。
  absorbTopLevelIntoPlayer(convo);

  const afterFields = convoPanelFields(convo).join('\u0001');
  return beforeFields !== afterFields || beforePanel !== JSON.stringify(convoPanel(convo));
}

/**
 * 把「AI 冒出来、没带角色前缀」的无主字段认领给合适的人。
 * 规则（按顺序）：① 卡上声明过该字段名 → 归那张卡；② 单角色聊天 → 全归绑卡；
 * ③ 主角已有同名字段 → 并回主角（AI 值覆盖，手改除外）；④ 其余 → 归主角。
 * 认不出「主角是谁」（没绑卡也没玩家角色）时原样不动。幂等，返回是否改动。
 */
export function absorbTopLevelIntoPlayer(convo) {
  if (!convo) return false;
  // 认不出主角是谁就不动（普通会话刚开局时就是这样）
  if (!absorbingOwnerName(convo)) return false;

  const ownerOf = (key) => panelFieldOwner(convo, key);
  const orphans = convoPanelFields(convo).filter((key) => !ownerOf(key));
  if (!orphans.length) return false;

  // 角色卡上声明过的字段名 → 那张卡的 owner。
  // 只算「本局真实持有字段的 owner」（避免把角色库里没进这局的卡也算进来）。
  const ownerByFieldName = new Map();
  const activeOwners = new Set(convoPanelFields(convo).map(ownerOf).filter(Boolean));
  // 「我」排在最后认领。挑一张卡当自己以后 player 名下也有卡属性，跳过它会让
  // 玩家卡上写死的字段名（比如「对某某的感情」）被别的角色认走；
  // 但也不能抢在角色前面 —— 同名字段（好感度/地点）历史上一直归角色。
  const claimOrder = [...activeOwners].filter((owner) => owner !== 'player');
  claimOrder.push('player');
  for (const owner of claimOrder) {
    const card = findCardForOwner(convo, owner);
    if (!card) continue;
    for (const attr of characterAttrs(card)) {
      const n = String((attr && attr.name) || '').trim();
      if (n && !ownerByFieldName.has(n)) ownerByFieldName.set(n, owner);
    }
  }

  // 单角色聊天（绑了卡、但没进世界）→ 无主字段全归那张卡。
  // 判据只看「会话绑了哪张卡」：开聊时挑一张卡当自己也会写 convo.player，
  // 但那不改变「这张卡是这局的主角」—— 拿玩家身份当条件会把字段认给错的人。
  // 进世界的会话 characterId 为空，这里自然拿不到。
  const soloOwner = (convo.characterId && activeOwners.has(convo.characterId))
    ? convo.characterId
    : '';

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  const remove = new Set();

  // 把一条无主字段认领给某个 owner（搬键/值/定义，或覆盖同名）
  const claim = (key, owner) => {
    const fieldName = panelFieldName(key);
    const value = panel[key];
    const target = panelKey(fieldName, owner);
    if (fields.includes(target)) {
      // 那边已经有同名字段 → 用无主这份（这一轮的）覆盖，手改过的除外
      if (!(convo.panelManual && convo.panelManual[target]) && String(value || '').trim()) {
        panel[target] = value;
      }
    } else if (fields.length < MAX_PANEL_FIELDS) {
      fields.push(target);
      if (value !== undefined) panel[target] = value;
      if (defs[key]) defs[target] = { ...defs[key], owner };
    }
    remove.add(key);
  };

  for (const key of orphans) {
    const fieldName = panelFieldName(key);

    // 规则 1：角色卡上声明过这个字段名 → 归那张角色
    const cardOwner = ownerByFieldName.get(fieldName);
    if (cardOwner) {
      claim(key, cardOwner);
      continue;
    }

    // 规则 2：单角色聊天 → 全归那张卡
    if (soloOwner) {
      claim(key, soloOwner);
      continue;
    }

    // 规则 3 / 4：并回主角
    const target = panelKey(fieldName, 'player');
    if (fields.includes(target)) {
      // 主角已经有同名字段 —— 值怎么取舍：
      //   · 主角那边是**空的**（种进去时没值）→ 用无主这份填上；
      //   · 主角那边有值、但**玩家手动改过**→ 保留手改的；
      //   · 其余情况（两边都是 AI 写的）→ 无主那份是这一轮的，覆盖掉旧的。
      const had = String(panel[target] || '').trim();
      const now = String(panel[key] || '').trim();
      if (!had) {
        if (now) panel[target] = panel[key];
      } else if (convo.panelManual && convo.panelManual[target]) {
        // 手改优先，不动
      } else {
        panel[target] = panel[key];
      }
      remove.add(key);
    } else if (fields.length < MAX_PANEL_FIELDS) {
      // AI 新发现的字段 → 整个搬到主角名下（键、值、定义都搬）
      const newKey = panelKey(fieldName, 'player');
      fields.push(newKey);
      if (panel[key] !== undefined) panel[newKey] = panel[key];
      if (defs[key]) defs[newKey] = { ...defs[key], owner: 'player' };
      remove.add(key);
    }
  }

  if (!remove.size) return false;

  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  for (const key of remove) delete panel[key];
  for (const key of remove) delete defs[key];
  convo.panelDefs = defs;
  return true;
}

/**
 * 主角的「名字」——用来认哪些无主字段其实是主角的。
 * 会话绑了卡就用卡名（单角色聊天）；没绑卡但进了世界就用玩家名。
 * 都拿不到就返回空（= 不做任何合并，避免瞎猜）。
 */
function absorbingOwnerName(convo) {
  const cardId = convo && convo.characterId;
  if (cardId) {
    const card = findCardForOwner(convo, cardId);
    const cardName = card && String(card.name || '').trim();
    if (cardName) return cardName;
  }
  const p = convo && convo.player;
  const playerName = p && String(p.name || '').trim();
  return playerName || '';
}

/**
 * 手动改一个字段的值（面板 UI 里直接编辑）。
 * 顺手给这个字段打上「手动改过」的标记 —— 下一轮扫描时，无主那份不会
 * 把它顶掉（见 absorbTopLevelIntoPlayer 的手改优先）。
 */
export function setPanelField(convo, name, value) {
  if (!convo) return;
  const fields = [...convoPanelFields(convo)];
  if (!fields.includes(name)) fields.push(name);
  convo.panelFields = fields.slice(0, MAX_PANEL_FIELDS);

  const prev = String(convoPanel(convo)[name] == null ? '' : convoPanel(convo)[name]);
  const text = String(value == null ? '' : value).trim().slice(0, 500);
  // 界面上「/100」是拆成后缀单独显示的，输入框里只有分子。存的时候把分母拼回去，
  // 否则「60/100」改一下变成「60」，分母就永久丢了。
  const merged = mergeMeterValue(text, prev, convoPanelDef(convo, name));

  convo.panel = { ...convoPanel(convo), [name]: clampPanelValue(convo, name, merged) };
  markPanelManual(convo, name);
  convo.updatedAt = now();
  persistConversations(0);
}

/**
 * 记下「这个字段是玩家手动改过的」。
 *
 * 为什么要记：AI 每轮会把状态栏原样再输出一遍，玩家的手改会在下一轮扫描时
 * 被 AI 的旧值顶掉（这正是「我改了但一会儿又变回去」的由来）。
 * 有了这张表，扫描遇到「无主那份 vs 主角那份」时就知道该听谁的。
 *
 * 存在会话上的 `panelManual`（复合键 → true）。老会话没有这个键 = 谁都没手改过。
 */
function markPanelManual(convo, key) {
  if (!convo) return;
  const table = convo.panelManual && typeof convo.panelManual === 'object' ? convo.panelManual : {};
  convo.panelManual = { ...table, [key]: true };
}

/**
 * 把「只有分子」的值和分母拼回「60/100」。有范围上限的数值字段统一存成
 * 「分子/满值」一种格式；只对数值型 + 有 max 的字段生效，别的原样返回。
 */
function mergeMeterValue(value, prev, def) {
  const text = String(value == null ? '' : value).trim();
  if (!text || !def || def.type !== 'meter' || typeof def.max !== 'number') return text;
  if (text.includes('/')) return text;

  // 分母优先用旧值里的（可能和 max 不同，比如按比例的分数字段），没有就用 max
  const m = String(prev == null ? '' : prev).match(/^[-+]?\d+(?:\.\d+)?\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  const total = m ? m[1] : trimNumber(def.max);
  return `${text}/${total}`;
}

/**
 * 字段说明图例：有范围 / 变化规则的字段才出现。
 *
 * 单独列在图例里，而不是跟在值后面 —— 值本身要**原样回显**给模型看
 * （它就是模型上一轮写的），掺上注解会影响它照着抄。
 */
/** 这一局绑定角色的名字（世界会话没绑卡 → 空） */
function boundCharacterLabel(convo) {
  const id = String((convo && convo.characterId) || '').trim();
  if (!id) return '';
  const card = findCardForOwner(convo, id);
  return (card && String(card.name || '').trim()) || '';
}

/**
 * 展开字段描述里的宏。
 *
 * 描述是**卡作者写给「这张卡当 NPC」的场合**用的，原样注入的话模型会看见
 * 「{{user}}」这种占位符然后开始猜它指谁 —— 玩家自己也挑了一张卡当角色时，
 * 它会绕不出来（「卢西恩是玩家，{{user}} 也是玩家，那这是谁对谁的？」）。
 *   · {{char}} / <BOT>   → 这条字段的主人
 *   · {{user}} / <USER>  → 对话的另一方
 * 「另一方」对玩家的字段来说就是这一局绑定的角色 —— 卡作者写「对{{user}}的信赖」
 * 时假设这张卡是 NPC，被玩家拿去当自己以后，指对面那个人才说得通。
 */
function panelMacroText(convo, owner, text) {
  const raw = String(text || '');
  if (!raw) return '';

  const self = panelOwnerLabel(convo, owner) || '';
  const playerLabel = panelOwnerLabel(convo, 'player') || '你';
  const other = owner === 'player' ? boundCharacterLabel(convo) || playerLabel : playerLabel;

  return raw
    .replace(/\{\{char\}\}/gi, () => self || other)
    .replace(/<BOT>/gi, () => self || other)
    .replace(/\{\{user\}\}/gi, () => other)
    .replace(/<USER>/gi, () => other);
}

function panelFieldLegend(convo, fields) {
  const clash = clashingFieldNames(convo);
  const lines = [];
  for (const key of fields) {
    const def = convoPanelDef(convo, key);
    if (!def) continue;
    const desc = describePanelField(def);
    if (!desc) continue;
    // 图例里也用「角色名·字段名」的显示名（有冲突时），和正文保持一致
    const name = panelFieldDisplayName(convo, key, (n) => clash.has(n));
    lines.push(`- ${name}：${panelMacroText(convo, panelKeyParts(key).owner, desc)}`);
  }
  return lines;
}

/**
 * 分组标题在注入文本里的写法：**刻意不用【】**。
 *
 * 用「【关系】：」的话会被自己的面板解析器当成一个名叫「关系」的字段
 * （PANEL_LINE_RE 认的就是这个形状），于是模型照着输出、下一轮就多出
 * 一个垃圾字段。用「—— 关系 ——」这种破折号包法就不会误匹配。
 */
function panelGroupHeader(title) {
  return `—— ${title} ——`;
}

/**
 * 从值的形状推断字段定义 —— 只用于**模型自己冒出来的字段**。
 *
 * 「【好感度】：63/100」这种「数字/数字」的形状本身就说明了它是个带范围的数值：
 * 分子是当前值、分母是满值。不做这一步的话，卡片里没声明过的数值字段永远
 * 拿不到进度条，明明值里已经写着满值是多少。
 *
 * 只认这一个形状（中间一个斜杠、两边都是数字），而且只在字段还没有定义时补。
 * 刻意**不**推断 min：分母只能告诉我们上限，下限猜不出来（写 0 会错，
 * 留空则由夹取逻辑按「只夹上限」处理）。
 */
function inferPanelDef(name, value) {
  const m = String(value == null ? '' : value).trim().match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const total = Number(m[2]);
  if (!isFinite(total) || total <= 0) return null;

  return { type: 'meter', max: total };
}

/**
 * 状态表的「开场白」和「收尾要求」。
 *
 * 为什么不是 `[当前状态]` 这种块标题（2026-09-30 实测改的）：
 * 以前注入块第一行是 `[当前状态]`，后面跟一串「这是权威状态 / 必须完整输出」的命令句。
 * 实测（DeepSeek V4 Flash，真实 API）模型会把它读成**外部塞进来的一段指令**，
 * 有安全对齐的模型直接拒绝执行 —— thinking 里原话是
 * 「…an artifact/injection. I should not execute it and shouldn't reference it.」
 * 于是整轮一个状态字段都不写，用户看到的就是「状态卡不跟着剧情走」。
 *
 * 换成现在这套：① 把所有权交给模型（「由你在每轮回复的末尾维护」——这是你前几轮
 * 自己写过的东西，不是别人的命令）；② 在**最末尾**给出格式承诺（行怎么写、冒号用
 * 全角、字段名原样、必须落在正文之后）。同一上下文实测：改前 0 行，改后 18 行
 * 且字段名/格式全对。
 *
 * ⚠️ 抬头刻意**不做成标记**（没有【】、没有 []）—— 那种形状本身就是「注入感」的来源，
 * 而且模型照抄回正文时还得额外剥一次。现在它是一句自然的话，模型几乎不会复制它。
 */
const PANEL_PROMPT_LEAD = '这是本局的状态表，由你在每轮回复的末尾维护 —— 下面是当前的值。';

/** 收尾的格式承诺：放在整块的最末（离生成位置最近，权重最高） */
const PANEL_PROMPT_TAIL =
  '正文写完后，另起一行接着把更新过的状态表写出来 —— 每行都是「【字段名】：新值」的写法，\n' +
  '冒号用全角「：」，字段名和顺序照上面那份表原样保留，一个都不能少。\n' +
  // 值防膨胀：不加这条，模型会习惯往值里塞括号补充说明，状态表就慢慢长回十几二十行。
  // 值是**快照**，细节属于正文。
  '每行的值要短（十几个字以内）—— 不要用括号补充说明，细节写进正文，不要堆进状态值。\n' +
  '状态表是你这轮回复的一部分，必须写在正文末尾。';

/**
 * 「最后一声提醒」：注入在**所有 system 段的末尾**（见 data/messages.js）。
 *
 * 为什么面板段自己还不够：状态表那段在对话历史之后，但角色卡的
 * `post_history_instructions` 又排在它后面 —— 那是角色口吻的提醒（「保持…口吻」），
 * 最容易把模型的注意力拉回「写正文」。实测同一上下文、同一个输入：
 * 只在中间给面板段时，模型约四分之一的回合忘了写状态表（真实 API 对照，
 * 「我明天要出差几天」这种没有明显状态变化的输入最容易漏）；在这之后再补一句
 * 极短的提醒，命中率明显上去。它刻意短 —— 只负责「别忘了」，不重复格式细节。
 *
 * 2026-09-30：原来它身上还挂着「每行「【字段名】：新值」」这半句格式要求 —— 那正是
 * 上面这条注释说不该做的事（格式已经在 PANEL_PROMPT_TAIL 里交代全了，这里再说一遍
 * 只是白占字数）。删掉，只留「别忘了写」。
 */
export const PANEL_PROMPT_REMINDER =
  '（提醒：这一次回复的最后，一定要接着写出上面那张状态表，一行都不能少。）';

/**
 * 模型整轮没提状态表时，程序补问一句（不进历史，只这一次请求）。
 * 实测有效：漏掉的那一轮，补问之后 18 个字段全回来了。
 *
 * 2026-09-30 加强措辞：思考型模型（实测 DeepSeek V4 Flash）会把状态表
 * **只在思考过程中推演一遍**，正文一个字不写 —— 界面上看不到、扫描也扫不到，
 * 状态卡就停在旧值上。补问是专门为「要回状态表」发的一次请求，不是常驻提示词，
 * 所以这里加字不会让主路径的提示词变长，可以把它说死：
 * 直接给出这几行、落在回复里、别只在思考中列出。
 */
export const PANEL_PROMPT_NUDGE =
  '（你这条回复的末尾没有状态表。现在只补这一件事：不要重写正文、不要解释，' +
  '直接给出下面这张表 —— 每行「【字段名】：新值」，字段名照上面那份原样，一行都不能少。' +
  '这几行要落在回复里，别只在思考中列出。）';


/** 面板拼成注入块；没有面板就返回空串 */
export function formatPanelForPrompt(convo) {
  const fields = convoPanelFields(convo);
  if (!fields.length) return '';

  const panel = convoPanel(convo);
  // 只有「同名字段被多个 owner 共用」才加前缀（见 clashingFieldNames）
  const clash = clashingFieldNames(convo);
  const label = (key) => panelFieldDisplayName(convo, key, (name) => clash.has(name));

  // 把字段按「更新频率」分成两组：动态字段每轮维护、静态字段变了才说。
  // 老数据没有 mode，一律按动态处理（向后兼容，行为不变）。
  const isStatic = (key) => {
    const def = convoPanelDef(convo, key);
    return !!def && def.mode === 'static';
  };
  const dynamicKeys = fields.filter((key) => !isStatic(key));
  const staticKeys = fields.filter(isStatic);

  // 按分组拼。分组的字段顺序由 groupPanelFields 保序，没分组的排最后。
  // 分组桶里存的 key 是复合键，注入时把显示名换成「角色名·字段名」（无冲突保持原名）。
  const grouped = (keys) =>
    groupPanelFields(
      keys.map((key) => ({ key, name: panelFieldName(key), group: panelFieldGroup(convo, key) }))
    );

  // 拼一组字段的「组标题 + 字段行」，只留当前有值的字段
  const renderGroups = (keys) => {
    const lines = [];
    let groupCount = 0;
    for (const bucket of grouped(keys)) {
      const filled = bucket.fields.filter((f) => {
        const v = panel[f.key];
        return v !== undefined && v !== '';
      });
      if (!filled.length) continue;

      if (bucket.id) {
        groupCount += 1;
        lines.push(panelGroupHeader(bucket.id));
      }
      for (const f of filled) {
        lines.push(`【${label(f.key)}】：${panel[f.key]}`);
      }
    }
    return { lines, grouped: groupCount > 0 };
  };

  const dyn = renderGroups(dynamicKeys);
  const stat = renderGroups(staticKeys);

  const legend = panelFieldLegend(convo, fields);
  const legendBlock = legend.length
    ? '\n\n字段的取值范围与变化规则（务必遵守，数值超出范围会被程序拉回）：\n' + legend.join('\n')
    : '';
  // 有分组时交代一句 —— 否则模型看不懂那些破折号标题是干什么的
  const groupNote = dyn.grouped || stat.grouped
    ? '\n（「—— 组名 ——」是状态分组的小标题，照抄即可，不要当成字段输出。）'
    : '';

  // 一个值都还没有 = 刚用角色卡的属性模板开的局。
  // 这时候也要把字段名告诉模型，否则它不知道要维护哪些状态 ——
  // 而「模型得自己碰巧输出【金币】：100」正是属性模板要解决的冷启动问题。
  const dynamicNames = dynamicKeys.map(label);
  const staticNames = staticKeys.map(label);
  if (!dyn.lines.length && !stat.lines.length) {
    const parts = [
      '这是本局的状态表，从这一轮开始由你在每次回复的末尾维护 —— 现在还不知道里面该填什么。'
    ];
    parts.push(`需要维护这些状态字段：${dynamicNames.join('、')}`);
    parts.push('请在每次回复的末尾，用「【字段】：值」的格式把它们完整输出一遍' +
      '（还不知道的写「未知」）；之后每轮照抄并更新，不要凭空改动已有数值。');
    if (staticNames.length) {
      parts.push(`下面这些字段平时不变，但**一旦发生变化就必须输出**（没变化才省略）：${staticNames.join('、')}`);
    }
    return (
      parts.join('\n') + groupNote + legendBlock + '\n\n' + PANEL_PROMPT_TAIL
    );
  }

  const rules = [];
  if (dynamicKeys.length) {
    rules.push(
      '正文里发生了什么，状态表就跟着变：时间推进、地点挪动、心情起伏、数值增减都要如实更新，\n' +
      '不要照抄旧值 —— 剧情里只要发生了消耗或获得（花钱、付账、受伤、进食、休息、喝酒、\n' +
      '还债……），对应的数值就**必须**在状态表里更新成新的数。\n' +
      '每次回复末尾都要把下面列出的字段完整输出一遍，不得省略、不得用「（状态略）」\n' +
      '「同上」之类带过 —— 没有变化的字段照抄原值即可。'
    );
  }
  if (staticKeys.length) {
    // 措辞必须是「一旦变化就必须输出」，不能写「只在变化时输出」——后者把判断交给模型，会整行省略。
    rules.push(
      '另外这些字段平时不用照抄（几乎不变的设定），但**只要剧情里发生了变化\n' +
      '（换了、脱了、被拿走、受伤、状态改变），就必须在状态栏里输出那行新值**，不能省。\n' +
      '判断标准是「这一轮有没有发生跟它有关的事」，不是「你还记不记得它原来是什么」。'
    );
  }

  const body = [PANEL_PROMPT_LEAD, rules.join('\n\n'), dyn.lines.join('\n'), stat.lines.join('\n')]
    .filter(Boolean);

  return body.join('\n') + groupNote + legendBlock + '\n\n' + PANEL_PROMPT_TAIL;
}

// ---------------------------------------------------------------------------
//  写入：把字段种进会话面板
//
//  这四个是「面板怎么长出来」的写入口，被入口层和聊天流程两头调用 ——
//  角色卡绑定、进世界开新会话、每轮回复后同步玩家名。
//  所以它们属于数据层，不属于状态面板视图（views/panelUi.js 只管画和点）。
// ---------------------------------------------------------------------------

/**
 * 往状态面板里补字段。已存在的跳过（同名的保留面板里的当前值 ——
 * 半路给会话绑角色，不该把这一局已经跑出来的数值冲掉），
 * 初始值只在「这个字段是刚种进去的」时候落地。
 *
 * pairs 的元素可以是 [name, value]，也可以是完整定义对象
 * {name, value, type, min, max, hint} —— 后者会把范围/hint 一起记到
 * convo.panelDefs 上，之后注入提示词时告诉模型（见 formatPanelForPrompt）。
 */
export function appendPanelFields(convo, pairs) {
  if (!convo || !pairs.length) return false;

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  // 去重键是「字段名 + owner」：同名的字段，只要归属不同的人，就能各自存在。
  // 以前用字段名去重，世界书里两个角色同名属性会互相挤掉（后种的全丢）。
  const known = new Set(fields);
  let changed = false;

  for (const pair of pairs) {
    // 两种形状都收：[name, value] 和完整定义对象
    const raw = Array.isArray(pair) ? { name: pair[0], value: pair[1] } : pair || {};
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name || !panelFieldAllowed(name)) continue;
    if (fields.length >= MAX_PANEL_FIELDS) break;

    // 归一化一遍：范围写反了会被换正，类型不认识会退回 text。owner 也从这里拿。
    const def = normalizePanelField({ ...raw, name });
    if (!def) continue;

    const owner = typeof def.owner === 'string' ? def.owner : '';
    const key = panelKey(name, owner);
    if (known.has(key)) continue;

    fields.push(key);
    known.add(key);
    changed = true;

    // 范围/hint/分组/归属/更新频率记到会话上（只有真的有内容才记，免得存一堆空壳）
    if (def.type !== 'text' || def.hint || def.group || def.owner || def.mode) {
      defs[key] = {
        type: def.type,
        ...(typeof def.min === 'number' ? { min: def.min } : {}),
        ...(typeof def.max === 'number' ? { max: def.max } : {}),
        ...(def.hint ? { hint: def.hint } : {}),
        ...(def.group ? { group: def.group } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
        ...(def.mode && def.mode !== 'dynamic' ? { mode: def.mode } : {})
      };
    }

    // 初始值也过一遍范围（卡作者自己写越界了，也一样夹回来），
    // 并统一成「分子/满值」格式（卡里 initial 常是裸数字 20）
    const text = String(def.value == null ? '' : def.value).trim();
    if (text) panel[key] = clampFieldValue(mergeMeterValue(text, '', def), def).value.slice(0, 500);
  }

  if (!changed) return false;

  convo.panelFields = fields;
  convo.panel = panel;
  convo.panelDefs = defs;
  convo.updatedAt = now();
  return true;
}

/**
 * 把角色卡上的「属性」种进会话的状态面板（连类型/范围/hint 一起）。
 *
 * ownerFor 决定这批字段归谁（'player' = 玩家，默认 = 这张卡自己的 id）：
 *   · 角色聊天：seedPanelFromCharacters(convo, [next]) —— 归绑定角色（next.id）。
 *   · 玩世界书：玩家自己的卡 seedPanelFromCharacters(convo, [card], 'player')，
 *     书里角色 seedPanelFromCharacters(convo, bookChars) —— 各归各的 id。
 */
export function seedPanelFromCharacters(convo, list, ownerFor) {
  if (!convo || !Array.isArray(list)) return false;

  const pairs = [];
  for (const character of list) {
    const owner =
      typeof ownerFor === 'function'
        ? ownerFor(character)
        : ownerFor != null
          ? String(ownerFor)
          : (character && character.id) || '';
    for (const attr of characterAttrs(character)) {
      pairs.push(owner ? { ...attr, owner } : attr);
    }
  }
  return appendPanelFields(convo, pairs);
}

/**
 * 把「归在别的 owner 名下、但其实就是玩家本人」的字段并到 'player' 名下。
 *
 * 场景：玩家挑了一张卡当自己（convo.player.characterId = 角色库那张卡），
 * 而这个世界书里还有一个**同名副本**（名字和玩家名一样）。两者 id 不同
 * （一个是角色库 id、一个是 wc 前缀），种字段时各归各的，于是同一个人
 * 在入口条上出现两张卡、同一属性被存成两份，注入时还会被拆成
 * 「角色名·字段名」的前缀（clashingFieldNames 认为它在跟别人抢）。
 *
 * 判定只看名字（和 cast.js 的 isPlayerCharacterCopy 一个口径）：副本名字
 * 等于玩家名，就视为玩家本人。不动名字对不上的 owner。
 *
 * 合并规则：
 *   · 目标键（fieldName\u0000player）还没有 → 整条搬过去（键/值/定义都搬）
 *   · 已经有 → 保留目标那份值（先种的玩家卡属性优先），只删掉多余的键
 *   · panelManual 上手改过的标记跟着键一起搬
 *
 * 幂等：搬完那一侧就没有键了，再调一次无事发生。返回是否改动。
 */
export function mergePlayerOwnedFields(convo) {
  if (!convo) return false;

  const playerName = String((convo.player && convo.player.name) || '').trim();
  if (!playerName) return false;

  // 本会话绑定的世界书里，哪些副本名字和玩家名一样 → 它们的 owner 要并过来
  const aliases = new Set();
  for (const bookId of convoWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    for (const copy of worldbookCharacters(book)) {
      const id = copy && copy.id ? String(copy.id) : '';
      if (id && String(copy.name || '').trim() === playerName) aliases.add(id);
    }
  }
  // 玩家挑的那张角色库里、名字自己也撞了的卡不算别名 —— 那种情况 player
  // 本来就是它的 owner，不用动。
  if (!aliases.size) return false;

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  const manual = convo.panelManual && typeof convo.panelManual === 'object'
    ? { ...convo.panelManual }
    : null;

  const remove = new Set();
  let changed = false;

  // 遍历用快照：循环里会往 fields 里 push 目标键，直接遍历会被新加的键带着跑
  for (const key of [...fields]) {
    const { name, owner } = panelKeyParts(key);
    if (!owner || !aliases.has(owner)) continue;

    const target = panelKey(name, 'player');
    // 目标键是否已经存在（原本就在 fields 里，或前面几条刚搬过去）
    const hasTarget = fields.includes(target) && !remove.has(target);
    if (!hasTarget && fields.length + 1 - remove.size <= MAX_PANEL_FIELDS) {
      if (panel[key] !== undefined) panel[target] = panel[key];
      if (defs[key]) defs[target] = { ...defs[key], owner: 'player' };
      fields.push(target);
    }
    // 目标已存在 → 保留玩家那份的值（开聊时先种的玩家卡属性优先），只删多余键
    delete panel[key];
    delete defs[key];
    if (manual && manual[key]) {
      manual[target] = true;
      delete manual[key];
    }
    remove.add(key);
    changed = true;
  }

  if (!changed) return false;

  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  convo.panelDefs = defs;
  if (manual) convo.panelManual = manual;
  convo.updatedAt = now();
  return true;
}

/**
 * 把「身份四项」（姓名/年龄/性别/种族）种进状态面板，归到「身份」分组。
 * 单角色对话种的是绑卡身份，玩世界书种的是玩家自己（姓名来自弹窗填写）。
 * 四项标 static（偶尔才变）。
 */
export function seedIdentity(convo, name, character, owner) {
  const pairs = [];
  const trimmed = String(name || '').trim();
  // 身份四项是「偶尔变」的设定（年龄一年才涨一岁、改名也少见），标 static ——
  // 模型只在变化时输出，不用每轮都照抄一遍姓名/年龄/性别/种族。
  if (trimmed) pairs.push({ name: '姓名', value: trimmed, group: IDENTITY_GROUP, owner, mode: 'static' });

  if (character) {
    const age = String(character.age || '').trim();
    const gender = String(character.gender || '').trim();
    const race = String(character.race || '').trim();
    if (age) pairs.push({ name: '年龄', value: age, group: IDENTITY_GROUP, owner, mode: 'static' });
    if (gender) pairs.push({ name: '性别', value: gender, group: IDENTITY_GROUP, owner, mode: 'static' });
    if (race) pairs.push({ name: '种族', value: race, group: IDENTITY_GROUP, owner, mode: 'static' });
  }

  return appendPanelFields(convo, pairs);
}

/**
 * 面板里的「姓名」被剧情改了 → 跟着改会话上的玩家名。
 * 不跟着改就会出现「面板说你叫 A，消息标签和 {{user}} 还叫你 B」的矛盾。
 * 只对设了玩家角色的会话生效（没设身份就没有名字可同步）。
 */
export function syncPlayerNameFromPanel(convo) {
  const player = convo && convo.player;
  if (!player || typeof player !== 'object') return false;

  // 「姓名」现在可能带 owner 后缀（玩家自己的是「姓名\u0000player」）；
  // 优先取玩家那份，取不到再退回纯字段名（老数据 / 无归属）。
  const name = String(
    convoPanel(convo)[panelKey('姓名', 'player')] || convoPanel(convo)['姓名'] || ''
  ).trim();
  if (!name || name === player.name) return false;

  player.name = name.slice(0, 40);
  convo.updatedAt = now();
  return true;
}

/**
 * 把老格式的面板就地升级成复合键。
 *
 * 老格式：panelFields 是字段名数组，panel / panelDefs 的键是纯字段名，
 * 归属信息放在 panelDefs[name].owner 里（可能没有，= 场景字段）。
 * 新格式：键 = name + '\u0000' + owner（owner 为空时仍是纯字段名）。
 *
 * 迁移是幂等的：已经带分隔符的键原样保留。挂点：应用启动读盘后
 * （main.js 的 init 里）对每个会话调一次 —— 之后内存里就全是新格式，
 * 落盘也跟着升级，老数据只迁移这一次。
 */
export function migrateConvoPanel(convo) {
  if (!convo || typeof convo !== 'object') return;

  const fields = asArray(convo.panelFields);
  const panel = convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
  const defs = convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};

  // 已经迁过（任一键含分隔符）就不动，避免重复处理
  const alreadyMigrated = fields.some((k) => String(k).includes(OWNER_SEP));
  if (alreadyMigrated) return;

  const newFields = [];
  const newPanel = {};
  const newDefs = {};

  for (const raw of fields) {
    const name = String(raw == null ? '' : raw);
    if (!name) continue;
    const owner = String((defs[name] && defs[name].owner) || '');
    const key = panelKey(name, owner);
    if (newFields.includes(key)) continue; // 同名同归属只留一个（老数据不该有，兜底）
    newFields.push(key);
    if (panel[name] !== undefined) newPanel[key] = panel[name];
    if (defs[name]) newDefs[key] = defs[name];
  }

  convo.panelFields = newFields;
  convo.panel = newPanel;
  convo.panelDefs = newDefs;
}

/**
 * 往书里新加角色副本后，把它们的属性种进所有「正在玩这本书」的会话，让新 NPC
 * 立刻可见。纯函数：只改传入的 conversations，不落盘。返回实际种入的会话数。
 */
export function seedWorldbookCharactersIntoConvos(conversations, book, copies) {
  if (!Array.isArray(conversations) || !book || !Array.isArray(copies) || !copies.length) return 0;

  let seeded = 0;
  for (const convo of conversations) {
    if (!convo || !convoWorldbookIds(convo).includes(book.id)) continue;
    if (seedPanelFromCharacters(convo, copies)) seeded += 1;
  }
  return seeded;
}

/**
 * 把角色库同名卡的属性补进世界书副本（纯函数，只改传入的 copies）。
 * 副本是快照，角色库后来补的属性不会回流，所以需要这一步。只按名字匹配
 * （副本 id 另发）、只补副本没有的字段，已有值不覆盖。
 * 返回 { touched, added, missing }。
 */
export function syncCopyAttrsFromSource(copies, sources) {
  const empties = { touched: 0, added: 0, missing: [] };
  if (!Array.isArray(copies) || !copies.length) return empties;

  const byName = new Map();
  for (const s of asArray(sources)) {
    const n = String((s && s.name) || '').trim();
    if (n && !byName.has(n)) byName.set(n, s);
  }

  let touched = 0;
  let added = 0;
  const missing = [];

  for (const copy of copies) {
    if (!copy) continue;
    const src = byName.get(String(copy.name || '').trim());
    if (!src) {
      missing.push(copy.name);
      continue;
    }
    const srcAttrs = characterAttrs(src);
    if (!srcAttrs.length) continue;

    if (!Array.isArray(copy.attributes)) copy.attributes = [];
    const have = new Set(copy.attributes.map((a) => String((a && a.name) || '').trim()));
    const fresh = srcAttrs.filter((a) => a && a.name && !have.has(String(a.name).trim()));
    if (!fresh.length) continue;

    // 深拷贝一份再塞（别把角色库的数组引进来，两边要各自独立）
    for (const a of fresh) copy.attributes.push(JSON.parse(JSON.stringify(a)));
    touched += 1;
    added += fresh.length;
  }

  return { touched, added, missing };
}
