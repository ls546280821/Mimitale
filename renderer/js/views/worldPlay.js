'use strict';

// ============================================================================
//  views/worldPlay.js —— 「进入世界」按下开始之后的事
//
//  弹窗本身（填名字 / 挑一张角色卡当自己）在 views/player.js。
//  这里管的是按了「开始」之后：建会话、把这个世界装上、种状态面板、
//  切到对话视图，以及「书里没写开场白时让模型按设定现生成一段」。
//
//  开局那段用独立的 requestId 调接口，所以流式分片不会被聊天窗口的监听器接住 ——
//  生成过程不会闪在界面里，写完才一次性落进去。生成期间空会话显示「正在生成开局…」，
//  那个状态存在 views/chatMessages.js 里（setOpeningBusy）。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { characterById, worldbookCharacters } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters } from '../data/panel.js';
import { applyMacros } from '../data/messages.js';
import { convoUserName, convoPlayer, worldbookCast } from '../data/cast.js';
import { gmRuleText } from '../data/narration.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { createConvo } from '../data/conversations.js';
import { persistConversations } from '../data/persist.js';
import { getPlayingBook, closePlayerModal } from './player.js';
import { showView } from './viewSwitch.js';
import { renderAll } from './redraw.js';
import { renderMessages, setOpeningBusy } from './chatMessages.js';
import { applyCharacterChoice } from './chatList.js';

/**
 * 「开始游玩」：建一个会话，把这个世界装上，并存下玩家自己的角色。
 * 世界模型本来就应该由 GM 叙述，所以顺手把 GM 模式打开。
 */
export function startWorldPlay() {
  const book = getPlayingBook();
  if (!book) return;

  const name = el.playerName.value.trim();
  const profile = el.playerProfile.value.trim();

  if (!name) {
    showToast('给你的角色起个名字吧', 'error');
    el.playerName.focus();
    return;
  }

  const convo = createConvo(true);
  convo.worldbookIds = [book.id];
  convo.gmMode = true;
  convo.title = book.name;
  convo.updatedAt = now();

  // 你在这个世界里的身份。选了角色卡就记住是哪张（名字/设定仍以输入框为准，
  // 因为选完还能改）。
  const pickedCard = characterById(el.playerChar.value);
  convo.player = { name, profile, characterId: pickedCard ? pickedCard.id : null };

  // 状态面板：先种「你自己」的身份和属性（主角的数值优先），再种本书角色的。
  // 同名以先出现的为准，所以自己卡上的「金币」不会被书里的盖掉。
  // 归属（owner）：你自己的身份和卡标成 'player'（在「我的状态」卡里看，
  // 不挤在「当前状态」面板里）；书里角色的各归各的 id。
  seedIdentity(convo, name, pickedCard, 'player');
  if (pickedCard) seedPanelFromCharacters(convo, [pickedCard], 'player');
  seedPanelFromCharacters(convo, worldbookCharacters(book));

  // 开场：书里写了就用书里的；没写就让模型按设定现生成一段
  const opening = String(book.opening || '').trim();
  if (opening) {
    convo.messages = [
      {
        role: 'assistant',
        content: applyMacros(opening, null, name),
        at: now(),
        greeting: true
      }
    ];
  }

  closePlayerModal();
  showView('chat');
  renderAll({ forceScroll: true });
  persistConversations(0);

  showToast(`进入「${book.name}」—— 你是「${name}」`, 'ok');
  el.input.focus();

  // 没写开场白就去生成一段。失败也不影响玩，只是开局空着
  if (!opening) generateWorldOpening(convo, book);
}

/**
 * 让模型按世界设定写一段开局场景，然后作为第一条消息放进会话。
 *
 * 用独立的 requestId 调接口，所以流式分片不会被聊天窗口的监听器接住 ——
 * 生成过程不会闪在界面里，写完才一次性落进去。
 */
async function generateWorldOpening(convo, book) {
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint || !endpoint.provider.apiKey) {
    // 还没配好模型，就别硬来了 —— 用户配好之后可以自己开个头
    return;
  }

  setOpeningBusy(convo.id);
  renderMessages({ forceScroll: true });

  try {
    const me = convoUserName(convo);
    const parts = [gmRuleText('', me, convo)];
    const player = convoPlayer(convo);
    if (player && player.profile) parts.push(`【玩家角色：${player.name || me}】\n${player.profile}`);
    const cast = worldbookCast(convo);
    if (cast) parts.push(cast);
    // 开局这段不按关键词，把这本书的设定尽量都带上，免得开局世界是空的
    const lore = book.entries
      .filter((e) => e.enabled !== false && String(e.content || '').trim())
      .slice(0, 40)
      .map((e) => `【${e.title}】\n${String(e.content).trim()}`)
      .join('\n\n');
    if (lore) parts.push(`[世界设定]\n${lore.slice(0, 12000)}`);

    const response = await api.sendChat({
      requestId: `opening-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: parts.join('\n\n') },
        {
          role: 'user',
          content: `（开场）故事开始了。请用一段具体的场景开场：交代「${player && player.name ? player.name : me}」此刻在哪里、正遇到什么，并留下可以行动的方向。不要替玩家做决定。`
        }
      ]
    });

    if (!response || response.ok !== true) throw new Error((response && response.error) || '调用失败');

    const text = String(response.content || '').trim();
    if (!text) return;

    // 生成期间用户可能已经自己说了话，那就别把开局硬插到后面
    if (activeConvo() !== convo || convo.messages.length) return;

    convo.messages = [{ role: 'assistant', content: text, at: now(), greeting: true }];
    convo.updatedAt = now();
    persistConversations(0);
    if (activeConvo() === convo) renderAll({ forceScroll: true });
  } catch (err) {
    console.error('生成开局失败', err);
    if (activeConvo() === convo) showToast('开局没生成出来，直接开始也行', 'error');
  } finally {
    setOpeningBusy(null);
    if (activeConvo() === convo) renderMessages({ forceScroll: true });
  }
}

/** 点「聊天」：新建一个会话并绑上这个角色，然后切回聊天视图 */
export function chatWithCharacter(id) {
  const character = characterById(id);
  if (!character) return;

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再开新会话');
    return;
  }

  createConvo(true);
  // 复用「绑定角色」那套逻辑：自动插入开场白、自动把会话标题起成角色名
  applyCharacterChoice(id);

  showView('chat');
  showToast(`开始和「${character.name}」聊天`, 'ok');
}
