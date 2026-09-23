// ---------------------------------------------------------------------------
//  进入世界：玩家角色弹窗
//
//  进世界之前先问一句「你是谁」—— 名字手填，或者挑一张角色卡当自己
//  （选了只是把名字和设定**填**进输入框，填完还能改，改了以你改的为准）。
//
//  这个文件只装弹窗本身。真正「开始游玩」的编排（建会话 + 种状态面板 +
//  切换视图 + 生成开局）留在 main.js —— 它要调 createConvo / seedIdentity /
//  seedPanelFromCharacters / applyMacros / showView，而 views 层不许向上
//  import 入口。等那几个动作各自归位（createConvo 该进 data/conversations.js、
//  seed* 该进 data/panel.js），再把它一起搬过来。
//
//  不登记刷新总线：弹窗是「打开时按需重画」的，不参与全局重绘。
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { characterById, characters, characterAttrs, worldbookById } from '../data/library.js';

/** 弹窗正对着哪本书（关掉就清空） */
let playingBookId = null;

/** 弹窗里现在这本书 —— 给 main.js 的「开始游玩」用 */
export function getPlayingBook() {
  return worldbookById(playingBookId);
}

/**
 * 把角色卡拼成「玩家角色」的设定文本。
 * 主角是 GM 要伺候的对象，所以描述和性格都要给到，不然它只知道一个名字。
 */
function playerProfileFromCharacter(character) {
  if (!character) return '';
  const bits = [];
  const desc = String(character.description || '').trim();
  const personality = String(character.personality || '').trim();
  const scenario = String(character.scenario || '').trim();
  if (desc) bits.push(desc);
  if (personality) bits.push(`【性格】${personality}`);
  if (scenario) bits.push(`【背景】${scenario}`);
  return bits.join('\n');
}

/** 下拉框下面那行预览：让「会被带进世界的是什么」一眼可见 */
function updatePlayerCharPreview() {
  const host = el.playerCharPreview;
  if (!host) return;

  const character = characterById(el.playerChar.value);
  if (!character) {
    host.innerHTML = '';
    host.classList.add('hidden');
    return;
  }

  const attrs = characterAttrs(character);

  host.innerHTML = '';
  if (character.avatar) {
    const img = document.createElement('img');
    img.src = character.avatar;
    img.alt = '';
    host.appendChild(img);
  }

  const text = document.createElement('span');
  text.textContent = attrs.length
    ? `会带上 ${attrs.length} 个属性：${attrs.map((a) => a.name).join('、')}`
    : '这张卡没有定义属性，只会带上名字和设定';
  host.appendChild(text);

  host.classList.remove('hidden');
}

/** 把「用角色卡当自己」的下拉填好（角色库为空时整块隐藏） */
function renderPlayerCharOptions() {
  if (!el.playerCharField) return;

  const list = characters();
  el.playerCharField.classList.toggle('hidden', !list.length);

  el.playerChar.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = list.length ? '（自己写一个）' : '角色库还是空的';
  el.playerChar.appendChild(none);

  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    el.playerChar.appendChild(opt);
  }

  el.playerChar.value = '';
  updatePlayerCharPreview();
}

/**
 * 选了一张角色卡：把名字和设定填到下面的输入框里。
 * 注意是「填」不是「锁」—— 填完还能改，改了就以你改的为准。
 */
export function applyPlayerCharChoice() {
  const character = characterById(el.playerChar.value);
  if (character) {
    el.playerName.value = character.name;
    el.playerProfile.value = playerProfileFromCharacter(character);
  } else {
    // 选回「自己写一个」：把名字还原成设置里的默认值，设定清空
    el.playerName.value = (state.settings && state.settings.userName) || '';
    el.playerProfile.value = '';
  }
  updatePlayerCharPreview();
}

export function openPlayerModal(bookId) {
  const book = worldbookById(bookId);
  if (!book) return;

  playingBookId = bookId;

  if (el.playerTitle) el.playerTitle.textContent = `进入「${book.name}」`;
  if (el.playerSub) {
    el.playerSub.textContent = '先给这个世界里的自己一个身份，然后就可以开始了';
  }

  // 每次打开都重列一遍角色库（可能刚加过新角色），并回到「自己写一个」
  renderPlayerCharOptions();
  el.playerName.value = (state.settings && state.settings.userName) || '';
  el.playerProfile.value = '';

  el.playerModal.classList.remove('hidden');
  el.playerName.focus();
  el.playerName.select();
}

export function closePlayerModal() {
  el.playerModal.classList.add('hidden');
  playingBookId = null;
}
