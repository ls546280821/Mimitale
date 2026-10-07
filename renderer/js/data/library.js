// ---------------------------------------------------------------------------
//  角色库 / 世界书：只读访问器
//
//  这里放「从 state 里把一张卡、一本书捞出来」这类查询。它们被上下两头同时用 ——
//  界面拿它填列表，组装提示词拿它取设定，所以属于共享数据层，
//  不能跟着某一个功能模块走（否则谁都 import 谁）。
//
//  只读：写入分别走 persist.js（落盘）和各处的编辑逻辑。
// ---------------------------------------------------------------------------

import { state } from '../core/state.js';
import { uid, asArray } from '../core/util.js';
import { normalizePanelFields } from '../core/panel-fields.js';

// --- 角色库 ---

export function characters() {
  return asArray(state.characters);
}

export function characterById(id) {
  if (!id) return null;
  return characters().find((c) => c.id === id) || null;
}

/** 当前会话绑定的角色（没绑就是 null，走通用助手） */
export function characterForConvo(convo) {
  return convo ? characterById(convo.characterId) : null;
}

/**
 * 读角色卡上的属性（容错老数据 / 导入的角色卡）。
 *
 * 老数据只有 {name, value}，这里走一遍共享归一化，于是 type/min/max/hint
 * 缺省都补成合理的值（type 默认 text）。范围/hint 是可选增强 ——
 * 没有它们的属性行为和以前完全一样。
 */
export function characterAttrs(character) {
  if (!character || !Array.isArray(character.attributes)) return [];
  return normalizePanelFields(character.attributes);
}

/**
 * 这张卡的状态要不要进「在场角色」入口条（showInPanel）。
 * 只对世界书副本有意义：true 才显示，默认 false。单角色聊天绑的卡不受此开关管
 * （那种会话里 TA 就是主角，见 cast.js 的 panelEntities）。
 */
export function showsInPanel(character) {
  return !!(character && character.showInPanel === true);
}

/**
 * 角色形象：角色库列表上那张 2:3 竖版图（点开能看大图）。
 * 和头像（character.avatar）是两个字段 —— 头像是消息气泡 / 状态卡上的小圆图。
 *
 * 判定看**键在不在**，不是看值真假：
 *   · 有这个键     → 用它（空串 = 用户就是要这块空着，别再拿头像顶上）
 *   · 没有这个键   → 老卡，只有一张图，那张图同时当头像和形象用。
 *     拿头像兜底，老卡进列表才不会变成一个孤零零的首字色块。
 */
export function characterPortrait(character) {
  if (!character) return '';
  return typeof character.portrait === 'string' ? character.portrait : character.avatar || '';
}

// --- 世界书 ---

export function worldbooks() {
  return asArray(state.worldbooks);
}

export function worldbookById(id) {
  if (!id) return null;
  return worldbooks().find((w) => w.id === id) || null;
}

/**
 * 一本书里的「本书角色」（从角色库复制进来的独立副本）。
 * 和角色库里的那个角色互相独立 —— 改这边不影响那边，反之亦然。
 */
export function worldbookCharacters(book) {
  return asArray(book && book.characters);
}

/**
 * 世界书角色副本的 id：单独一个前缀，和角色库、会话的 id 不会看混。
 * 两头都要用 —— 世界书编辑器里「加入副本」发一个，角色编辑器在
 * 「世界书作用域」下起草新角色时也发一个，所以沉在这儿。
 */
export function newWorldbookCharId() {
  return `wc${uid()}`;
}

/** 会话绑定了哪些世界书（id 列表，容错老数据） */
export function convoWorldbookIds(convo) {
  return asArray(convo && convo.worldbookIds);
}

// --- 预设 ---

/**
 * 用户自建的「预设」：叠在对话上的一层指令。
 *
 * 注意别和 state.presets 搞混 —— 那是「添加服务商」时一键填充的内置模板
 * （DeepSeek / OpenAI / Kimi…），完全是另一回事。
 */
export function dialoguePresets() {
  return asArray(state.dialoguePresets);
}

export function dialoguePresetById(id) {
  if (!id) return null;
  return dialoguePresets().find((p) => p.id === id) || null;
}

/** 会话绑定的预设 id 列表（**没手动配过** = null；显式全不选 = 空数组，容错老数据） */
export function convoDialoguePresetIds(convo) {
  const raw = convo && convo.dialoguePresetIds;
  // 老数据是单值字符串（dialoguePresetId），这里一并兜住，读到就当「配过一条」
  if (!Array.isArray(raw)) {
    const legacy = convo && convo.dialoguePresetId;
    if (typeof legacy === 'string' && legacy.trim()) return [legacy];
    return null;
  }
  return raw.filter((id) => typeof id === 'string' && id.trim());
}

/**
 * 会话实际生效的预设（**可能有多条**，按列表顺序拼进提示词）。
 *
 * 规则：
 *   · 会话**手动配过**（`dialoguePresetIds` 是数组）→ 就用它配的那几条；
 *     显式配成空数组 = 这一场就是不用，不回落全局。
 *   · 会话**没配过**（null）→ 自动带上所有勾了「可全局」的预设。
 * 被删掉 / 停用的 id 静默跳过 —— 提示词那边当它不存在，不去打扰用户。
 */
export function effectiveDialoguePresets(convo) {
  const picked = convoDialoguePresetIds(convo);
  const ids = picked === null ? globalDialoguePresets().map((p) => p.id) : picked;
  const out = [];
  for (const id of ids) {
    const preset = dialoguePresetById(id);
    if (preset && preset.enabled !== false) out.push(preset);
  }
  return out;
}

/** 勾了「可全局」的预设（新对话默认带上的那几条） */
export function globalDialoguePresets() {
  return dialoguePresets().filter((p) => p.enabled !== false && p.global === true);
}

/** 能给会话选用的预设（关掉的仍然保留数据，只是不出现在列表里） */
export function selectableDialoguePresets() {
  return dialoguePresets().filter((p) => p.enabled !== false);
}

/** 扫一遍近期消息拼注入块时，往回看几条消息 */
export const WORLDBOOK_SCAN_DEPTH = 6;

/** 递归扫描最多连锁几层（设置里调，0 = 关掉递归） */
export function recursiveDepthSetting() {
  const value = Number((state.settings || {}).worldbookRecursiveDepth);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? Math.floor(value) : 3;
}

/**
 * 把书里的「角色副本」转成能导出的形状。
 *
 * 副本是完整角色对象，直接塞出去会带上一堆内部字段（worldbookIds / optionsSpec /
 * 时间戳…），而且**头像和立绘是 base64**，几十个副本能把文件撑到几十兆 ——
 * 导入那边本来也是从零归一化一遍，所以这里只留「设定」那几项。
 * 图片仍然是原样带上（副本的头像就是它的一部分），但只在确实存在时才写键。
 */
function worldbookCharacterPayload(character) {
  const c = character && typeof character === 'object' ? character : {};
  const out = {
    name: c.name || '',
    description: c.description || '',
    personality: c.personality || '',
    scenario: c.scenario || '',
    firstMes: c.firstMes || '',
    mesExample: c.mesExample || '',
    systemPrompt: c.systemPrompt || '',
    postHistoryInstructions: c.postHistoryInstructions || '',
    creatorNotes: c.creatorNotes || '',
    age: c.age || '',
    gender: c.gender || '',
    race: c.race || '',
    tags: asArray(c.tags)
  };
  if (Array.isArray(c.attributes) && c.attributes.length) out.attributes = c.attributes;
  if (typeof c.avatar === 'string' && c.avatar) out.avatar = c.avatar;
  if (typeof c.portrait === 'string' && c.portrait) out.portrait = c.portrait;
  if (c.showInPanel === true) out.showInPanel = true;
  return out;
}

/**
 * 世界书导出成酒馆 lorebook 的形状（导入那边认的就是这个）。
 *
 * 两头都要用：角色卡导出时把绑定的书塞进 character_book 字段，
 * 世界书编辑器里的「导出本书」直接导出整本 —— 所以沉在这儿。
 *
 * ⚠️ opening 和 characters 也一起导出（酒馆规范里没有这两个字段，多出来的键
 * 别家会忽略）。少了它们，「导出这本书再导回来」就等于**丢掉开场白和全部 NPC** ——
 * 而那正是别人分享一份世界书时最想要的两样东西。
 */
export function worldbookPayload(book) {
  const entries = {};
  (book.entries || []).forEach((entry, index) => {
    entries[String(index)] = {
      uid: index,
      comment: entry.title || '',
      key: asArray(entry.keys),
      keysecondary: asArray(entry.secondaryKeys),
      content: entry.content || '',
      constant: entry.constant === true,
      selective: Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0,
      selectiveLogic: entry.selectiveLogic || 'AND_ANY',
      order: Number.isFinite(entry.order) ? entry.order : 100,
      probability: Number.isFinite(entry.probability) ? entry.probability : 100,
      disable: entry.enabled === false,
      // 递归：写法两边都给 —— 酒馆认 excludeRecursion（true = 不参与递归），
      // 我们自己认 recursive。这样导出的书酒馆能用，我们自己再导回来也不丢这个开关。
      excludeRecursion: entry.recursive !== true,
      recursive: entry.recursive === true,
      matchWholeWords: entry.matchWholeWords === true,
      caseSensitive: entry.caseSensitive === true
    };
  });

  const payload = { name: book.name || '未命名世界', description: book.description || '', entries };
  if (typeof book.opening === 'string' && book.opening) payload.opening = book.opening;
  const cast = asArray(book.characters);
  if (cast.length) payload.characters = cast.map(worldbookCharacterPayload);
  return payload;
}
