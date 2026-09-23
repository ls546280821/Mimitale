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
import { uid } from '../core/util.js';
import { normalizePanelFields } from '../core/panel-fields.js';

// --- 角色库 ---

export function characters() {
  return Array.isArray(state.characters) ? state.characters : [];
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

// --- 世界书 ---

export function worldbooks() {
  return Array.isArray(state.worldbooks) ? state.worldbooks : [];
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
  return book && Array.isArray(book.characters) ? book.characters : [];
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
  return convo && Array.isArray(convo.worldbookIds) ? convo.worldbookIds : [];
}

/** 扫一遍近期消息拼注入块时，往回看几条消息 */
export const WORLDBOOK_SCAN_DEPTH = 6;

/** 递归扫描最多连锁几层（设置里调，0 = 关掉递归） */
export function recursiveDepthSetting() {
  const value = Number((state.settings || {}).worldbookRecursiveDepth);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? Math.floor(value) : 3;
}

/**
 * 世界书导出成酒馆 lorebook 的形状（导入那边认的就是这个）。
 *
 * 两头都要用：角色卡导出时把绑定的书塞进 character_book 字段，
 * 世界书编辑器里的「导出本书」直接导出整本 —— 所以沉在这儿。
 */
export function worldbookPayload(book) {
  const entries = {};
  (book.entries || []).forEach((entry, index) => {
    entries[String(index)] = {
      uid: index,
      comment: entry.title || '',
      key: Array.isArray(entry.keys) ? entry.keys : [],
      keysecondary: Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [],
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

  return { name: book.name || '未命名世界', description: book.description || '', entries };
}
