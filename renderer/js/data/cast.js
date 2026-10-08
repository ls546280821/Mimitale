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

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { asArray } from '../core/util.js';
import {
  characterForConvo,
  characterById,
  convoWorldbookIds,
  worldbookById,
  worldbookCharacters,
  showsInPanel,
  WORLDBOOK_SCAN_DEPTH,
  recursiveDepthSetting
} from './library.js';
import { convoPanelFields, panelFieldOwner } from './panel.js';

/** {{user}} 的替换值（默认名；世界会话用玩家角色名覆盖） */
export function userName() {
  return '你';
}

/**
 * 「默认人设」是按**模型**各存一份的，所以先要确定用哪一份。
 *
 * 口径：会话自己用的模型优先（每个会话都记着自己的模型），没有会话
 * （比如空状态页）才退回设置里的当前模型。都没配就返回空串 —— 调用方
 * 拿空串去查表，查不到自然落到内置默认。
 *
 * 纯读，不改 convo —— 别在这儿调 ensureConvoEndpoint()：那会就地补全会话对象，
 * 而这一层（data/cast.js）只做「把数据读成谁是谁」，不该产生副作用。
 */
function assistantModelKey(convo) {
  const own = convo && String(convo.model || '').trim();
  if (own) return own;
  const s = state.settings || {};
  return String(s.activeModel || '').trim();
}

/** 某个模型的默认人设条目（没配过就是 null） */
function assistantPersonaEntry(convo) {
  const s = state.settings || {};
  const map = s.assistantPersonas;
  if (!map || typeof map !== 'object') return null;
  const entry = map[assistantModelKey(convo)];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * 通用助手的名字 —— 没绑定角色卡的会话里，AI 那一侧是谁。
 * 按会话当前用的模型取「默认人设」那一份。
 *
 * **没写名字就是空串**：这里不兜任何内置假名，空名字怎么显示由上层自己决定
 * —— 气泡和导出用「AI」，空状态标题则干脆不提名字（「开始聊天吧～」）。
 */
export function assistantName(convo) {
  const entry = assistantPersonaEntry(convo);
  return String((entry && entry.name) || '').trim();
}

/**
 * 通用助手的设定正文，同样是按模型取。
 * 空串是**正常状态**：这个模型没配人设 = 不扮演任何角色，跟以前一样。
 */
export function assistantPersona(convo) {
  const entry = assistantPersonaEntry(convo);
  return String((entry && entry.persona) || '').trim();
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

  return asArray(character.worldbookIds);
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

/**
 * 把一段文本里的 {{char}}/{{user}}/<BOT>/<USER> 统一替换成玩家名 ——
 * 挑一张卡当自己时，这些宏都指玩家本人。纯函数，只读不改。
 */
function substituteSelf(text, name) {
  const who = String(name || '').trim() || '你';
  return String(text)
    .replace(/\{\{char\}\}/gi, () => who)
    .replace(/\{\{user\}\}/gi, () => who)
    .replace(/<BOT>/gi, () => who)
    .replace(/<USER>/gi, () => who);
}

/**
 * 把玩家角色设定里的宏统一替换成玩家名，拼成能直接注入的文本。纯函数，只读不改。
 */
export function playerProfileForPrompt(convo) {
  const player = convoPlayer(convo);
  if (!player || !player.profile) return '';
  return substituteSelf(player.profile, player.name || convoUserName(convo));
}

/**
 * 把一张角色卡拼成「玩家角色」的设定文本：描述 + 性格都带上。
 * 开场背景（scenario）不带 —— 那是「这张卡当 NPC」的场景预设，不是「我是谁」。
 * 「挑一张卡当自己」时用它预填设定框（填完还能改）。
 */
export function playerProfileFromCharacter(character) {
  if (!character) return '';
  const name = String(character.name || '').trim() || '你';
  const bits = [];
  const desc = String(character.description || '').trim();
  const personality = String(character.personality || '').trim();
  if (desc) bits.push(substituteSelf(desc, name));
  if (personality) bits.push(`【性格】${substituteSelf(personality, name)}`);
  return bits.join('\n');
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
 * 场景（世界本身）的 owner 标识 —— 已停用。老数据里读到 'scene' 按「无主」处理，
 * 别再新增。常量只保留用于兼容。
 */
const SCENE_OWNER = 'scene';

/**
 * 本局有状态的每个人：我（玩家，永远第一）+ 要显示状态的角色卡。
 * 单角色聊天绑的卡永远显示；世界书副本只有 showInPanel === true 才显示
 * （属性照旧种进面板，只是不显示）。AI 现编的 NPC 没有卡，不列。
 * 返回 [{ owner, kind, name, avatar, card }]，owner 直接喂给 openStateCard。
 * card 是这张卡本身（找不到就是 null），给状态卡取形象图 / 表情图用。
 *
 * 这是**数据层**的全量名单：提示词注入（data/messages.js）和状态卡排序
 * （views/stateCard.js）用它，玩家字段照常生效。
 * 入口条那条横幅别直接用它 —— 走 panelCastForDisplay（普通聊天不显示「我」）。
 */
export function panelEntities(convo) {
  if (!convo) return [];

  const out = [];
  const seen = new Set();

  const player = convoPlayer(convo);
  // 「我」的那张卡：优先玩家挑的角色库卡（convo.player.characterId）；
  // 挑的是世界书副本当自己时那里是空的 —— 这时按**名字**在本会话绑定的书里
  // 找回那个同名副本（就是玩家本人，见 data/panel.js 的 mergePlayerOwnedFields）。
  // 不这么兜的话，「我」这张卡拿不到卡对象 → 状态卡没有立绘、没有表情图。
  let playerCard = player && player.characterId ? characterById(player.characterId) : null;
  if (!playerCard && player) {
    const playerName = convoUserName(convo);
    for (const bookId of convoWorldbookIds(convo)) {
      const book = worldbookById(bookId);
      const copy = book
        ? worldbookCharacters(book).find((c) => c && String(c.name || '').trim() === playerName)
        : null;
      if (copy) {
        playerCard = copy;
        break;
      }
    }
  }
  out.push({
    owner: 'player',
    kind: 'player',
    name: convoUserName(convo),
    avatar: (playerCard && playerCard.avatar) || '',
    card: playerCard || null
  });
  seen.add('player');

  // 单卡会话绑的那张卡：不管开关，永远显示（TA 就是这局的主角）。
  // ⚠️ 不能拿「玩家有没有设身份」当条件 —— 开聊时挑了一张卡当自己之后，
  //    玩家一有身份，绑定的那个角色就会掉进 showsInPanel（默认 false）被过滤掉，
  //    入口条只剩「我」，那个角色的状态卡再也点不开。
  //    进世界的会话 characterId 为空，这里自然拿不到。
  const soloCardId = convo.characterId ? String(convo.characterId) : '';

  for (const name of convoPanelFields(convo)) {
    const owner = panelFieldOwner(convo, name);
    // 无主字段不归任何人（正常情况下扫描收尾时已经并给主角或丢掉了，
    // 这里只是兜底：读到老数据里的 'scene' 也当无主跳过，不再冒出一个入口）
    if (!owner || owner === SCENE_OWNER) continue;
    if (seen.has(owner)) continue;

    const card = findCardById(convo, owner);
    // 世界书副本要勾了「在状态栏显示」才出头像；单卡会话绑的那张豁免。
    if (owner !== soloCardId && !showsInPanel(card)) continue;

    seen.add(owner);
    out.push({
      owner,
      kind: 'character',
      name: (card && card.name) || owner,
      avatar: (card && card.avatar) || '',
      card: card || null
    });
  }

  return out;
}

/**
 * 「在场角色」入口条要显示的人（panelEntities 的显示版）。
 *
 * 「我」只在**玩世界书**的会话里出现 —— 普通聊天（绑角色 / 空白会话）里
 * 玩家状态不占一个头像；这样一来只剩「我」的会话名单为空，
 * 入口条整条收掉（panelUi 按空名单隐藏横幅）。
 * 普通聊天里想给「我」加状态，点自己消息的头像照样能开那张卡。
 */
export function panelCastForDisplay(convo) {
  if (!convo) return [];
  const entities = panelEntities(convo);
  if (convoWorldbookIds(convo).length) return entities;
  return entities.filter((e) => e.owner !== 'player');
}

/**
 * 助手那一侧显示成谁：
 *   · 绑了角色卡 → 角色名
 *   · 进了世界 → 世界名（那个世界里的所有 NPC 都算它说的）
 *   · 都没有 → 通用助手，用设置里「默认人设」那个名字
 */
export function speakerName(convo) {
  const character = characterForConvo(convo);
  if (character) return character.name;

  const book = convoWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .find(Boolean);
  if (book) return book.name;

  return assistantName(convo);
}

// 名单太长会吃掉上下文，给个总预算；单个 NPC 的描述也截一下
const MAX_CAST_CHARS = 3000;
const MAX_CAST_PER_NPC = 160;

/**
 * 书里的某个角色副本是不是「玩家本人」。
 *
 * 玩家用某张卡「进入世界」时，那张卡（或同名角色）可能也在书里当 NPC ——
 * 副本名字和玩家名撞了，GM 名单里就冒出两个同名的人。判断只认名字：
 * 副本名字和玩家名一样，就视为玩家本人、不当 NPC。纯函数，只读传入的 convo。
 */
export function isPlayerCharacterCopy(convo, character) {
  if (!convo || !character) return false;
  const playerName = convoUserName(convo);
  return String(character.name || '').trim() === playerName;
}

/**
 * 「这个世界的人」：把书里的角色副本列给 GM（每轮注入，有长度上限）。
 * 与玩家同名的副本（玩家用某卡进世界）标成「玩家扮演」，不当 NPC 罗列，
 * 否则 GM 名单里会冒出两个同名、分不清谁是谁。
 */
export function worldbookCast(convo) {
  const books = convoWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .filter(Boolean);
  const cast = books.flatMap((b) => worldbookCharacters(b));
  if (!cast.length) return '';

  const playerName = convoUserName(convo);

  const lines = [];
  let total = 0;
  let npcCount = 0;

  for (const c of cast) {
    // 与玩家同名的副本 = 玩家本人，不是 NPC：跳过，别让 GM 当成另一个人来演
    if (isPlayerCharacterCopy(convo, c)) continue;
    npcCount += 1;

    // 身份用括号缀在名字后面：GM 不知道 NPC 几岁、什么族，照样会瞎编
    const who = [c.age && `${c.age}岁`, c.gender, c.race].filter(Boolean).join('·');
    const bits = [c.description, c.personality]
      .map((s) => String(s || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(' ');
    const head = who ? `${c.name}（${who}）` : c.name;
    const line = `- ${head}：${bits.slice(0, MAX_CAST_PER_NPC) || '（没写设定）'}`;

    if (total + line.length > MAX_CAST_CHARS) {
      lines.push(`- （还有 ${cast.length - npcCount + 1} 人没列出）`);
      break;
    }
    lines.push(line);
    total += line.length;
  }

  // 玩家本人明确点出来，和 NPC 名单分开 —— 免得模型把主角当 NPC 之一
  const header =
    `【这个世界的人】\n` +
    `「${playerName}」是玩家本人扮演的主角，不是 NPC —— 不要把他/她当成别的 NPC 来描写或替他说话。\n` +
    (lines.length ? `以下角色是你扮演的 NPC，各自有各自的立场、语气和说话习惯：\n` : '');
  return header + lines.join('\n');
}
