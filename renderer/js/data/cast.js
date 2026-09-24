'use strict';

// ============================================================================
//  data/cast.js —— 「谁在说话」和「这个世界有哪些人」
//
//  只做一件事：把一条会话 + 角色库/世界书读成「谁是谁」。全是纯读，不写。
//
//  为什么要单独一层：同一个口径至少有三处要用 ——
//    · 提示词组装（data/messages.js）：{{user}} 填谁、助手那侧算谁
//    · 界面标签（views/messageList.js）：气泡上写什么名字
//    · 导出（views/exports.js）：Markdown 里的说话人
//  口径分散的后果是「气泡上写世界名、提示词里写角色名」这种对不上的情况，
//  而且很难发现 —— 所以沉到 data 层，谁都不用认识谁。
// ============================================================================

import { state } from '../core/state.js';
import { api } from '../core/api.js';
import {
  characterForConvo,
  characterById,
  convoWorldbookIds,
  worldbookById,
  worldbookCharacters,
  WORLDBOOK_SCAN_DEPTH,
  recursiveDepthSetting
} from './library.js';
import { convoPanelFields, panelFieldOwner } from './panel.js';

/** {{user}} 的替换值（全局默认名） */
export function userName() {
  const name = (state.settings && state.settings.userName) || '';
  return String(name).trim() || '你';
}

/**
 * 这次请求实际要注入哪些世界书。
 *
 * 规则（会话优先，且不合并）：
 *   · 会话绑了世界书（含「进入世界」）→ 只用会话的，角色自带的一律不带入。
 *     一条会话只有一个世界观，不会出现两套设定互相打架。
 *   · 会话没绑 → 才用角色自带的那几本（前提是这张卡的开关是开的）。
 *
 * 角色的开关（worldbookEnabled）关掉后，两种情况都不带入 ——
 * 这样无论单独聊天、还是被绑进某个世界当角色，这张卡都是干净的。
 */
export function effectiveWorldbookIds(convo) {
  const convoIds = convoWorldbookIds(convo);
  if (convoIds.length) return convoIds;

  const character = characterForConvo(convo);
  if (!character) return [];
  if (character.worldbookEnabled === false) return [];

  return Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
}

/**
 * 按当前对话正文去世界书里匹配一段设定，拼成能直接注入的文本。
 * 匹配失败**不抛错**：世界书挂了不该拦住正常聊天，返回空串就行。
 */
export async function matchWorldbookSection(convo) {
  const allIds = [...new Set(effectiveWorldbookIds(convo))];
  if (!allIds.length) return '';

  const history = convo.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );

  try {
    const result = await api.previewWorldbook({
      worldbookIds: allIds,
      scanDepth: WORLDBOOK_SCAN_DEPTH,
      recursiveDepth: recursiveDepthSetting(),
      messages: history.slice(-WORLDBOOK_SCAN_DEPTH).map((m) => ({ role: m.role, content: m.content }))
    });
    return (result && result.section) || '';
  } catch (err) {
    // 世界书匹配失败不该拦住正常聊天
    console.error('世界书匹配失败', err);
    return '';
  }
}

/** 玩家在这个世界里的角色（老的会话没有这个字段） */
export function convoPlayer(convo) {
  const p = convo && convo.player;
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim();
  const profile = String(p.profile || '').trim();
  if (!name && !profile) return null;
  return { name, profile };
}

/** {{user}} 的替换值：进了世界的会话用玩家角色的名字，其它会话用设置里的名字 */
export function convoUserName(convo) {
  const player = convoPlayer(convo);
  return player && player.name ? player.name : userName();
}

/**
 * 按 id 找一张角色卡 —— 先查角色库，再查本会话绑定的世界书里的「本书角色」。
 *
 * 状态面板字段的 owner 存的是「卡 id」：单角色聊天存角色库那张卡、玩世界书存
 * 世界书里那份副本。两种都要能找回名字和头像，所以查找要覆盖两处。
 */
export function findCardById(convo, id) {
  const target = String(id || '').trim();
  if (!target) return null;

  const direct = characterById(target);
  if (direct) return direct;

  for (const bookId of convoWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    const found = book
      ? worldbookCharacters(book).find((c) => c && c.id === target)
      : null;
    if (found) return found;
  }
  return null;
}

/**
 * 「当前状态」栏上要显示哪些人：我（玩家）+ 本局状态面板里出现过的角色卡。
 *
 * 为什么不把 AI 现编的 NPC 也列上：它们没有卡、没有头像，见一个列一个会挤爆。
 * 场景（owner 为空）也不列 —— 它不是「某个人」。我永远排第一个，即使还没种过
 * 字段也要在，这样随时能点开给自己加状态。
 *
 * 返回 [{ owner, kind, name, avatar }]，owner 直接喂给 openStateCard。
 */
export function panelEntities(convo) {
  if (!convo) return [];

  const out = [];
  const seen = new Set();

  const player = convoPlayer(convo);
  const playerCard = player && player.characterId ? characterById(player.characterId) : null;
  out.push({
    owner: 'player',
    kind: 'player',
    name: convoUserName(convo),
    avatar: (playerCard && playerCard.avatar) || ''
  });
  seen.add('player');

  for (const name of convoPanelFields(convo)) {
    const owner = panelFieldOwner(convo, name);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);

    const card = findCardById(convo, owner);
    out.push({
      owner,
      kind: 'character',
      name: (card && card.name) || owner,
      avatar: (card && card.avatar) || ''
    });
  }

  return out;
}

/**
 * 助手那一侧显示成谁：
 *   · 绑了角色卡 → 角色名
 *   · 进了世界 → 世界名（那个世界里的所有 NPC 都算它说的）
 *   · 都没有 → 通用助手，用全局人设那个名字
 */
export function speakerName(convo) {
  const character = characterForConvo(convo);
  if (character) return character.name;

  const book = convoWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .find(Boolean);
  if (book) return book.name;

  return '昔涟';
}

// 名单太长会吃掉上下文，给个总预算；单个 NPC 的描述也截一下
const MAX_CAST_CHARS = 3000;
const MAX_CAST_PER_NPC = 160;

/**
 * 「这个世界的人」：把书里的角色副本列给 GM。
 *
 * 不列的话 GM 根本不知道这个世界有哪些 NPC —— 之前就是这样，它只能现编人物，
 * 或者等你主动提到名字。名单每轮都注入，所以做了长度上限。
 */
export function worldbookCast(convo) {
  const books = convoWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .filter(Boolean);
  const cast = books.flatMap((b) => worldbookCharacters(b));
  if (!cast.length) return '';

  const lines = [];
  let total = 0;

  for (const c of cast) {
    // 身份用括号缀在名字后面：GM 不知道 NPC 几岁、什么族，照样会瞎编
    const who = [c.age && `${c.age}岁`, c.gender, c.race].filter(Boolean).join('·');
    const bits = [c.description, c.personality]
      .map((s) => String(s || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(' ');
    const head = who ? `${c.name}（${who}）` : c.name;
    const line = `- ${head}：${bits.slice(0, MAX_CAST_PER_NPC) || '（没写设定）'}`;

    if (total + line.length > MAX_CAST_CHARS) {
      lines.push(`- （还有 ${cast.length - lines.length} 人没列出）`);
      break;
    }
    lines.push(line);
    total += line.length;
  }

  return `【这个世界的人】\n以下角色由你扮演，各自有各自的立场、语气和说话习惯。\n${lines.join('\n')}`;
}
