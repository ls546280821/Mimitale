'use strict';

// ============================================================================
//  views/chatExport.js —— 导出
//
//  三种：角色卡（PNG / JSON）、世界书（JSON）、当前会话（Markdown）。
//  格式都对齐「导入」那条链路能读的形状，所以导出的东西能再导回来，
//  酒馆那边也认（角色卡是 v2 规范，世界书是 lorebook 规范）。
//
//  世界书那一项不在这儿 —— 它在世界书编辑器自己的「导出」里（views/worldbook.js）。
//  这里管的是角色卡和当前会话这两项，以及「复制全文」。
// ============================================================================

import { activeConvo, safeFileName } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { saveExport } from '../data/export.js';
import {
  characterAttrs,
  characterForConvo,
  convoWorldbookIds,
  worldbookById,
  worldbookPayload
} from '../data/library.js';
import { convoPanel, convoPanelFields } from '../data/panel.js';
import { convoPlayer, userName, speakerName } from '../data/cast.js';
import { currentEditorCharacter } from './characterEditor.js';

/**
 * UTF-8 文本 → base64。
 * 不能用裸 btoa：它只吃 Latin-1，中文会直接抛错；先按 UTF-8 取字节再 base64。
 */
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 导出用的角色卡（酒馆 v2 规范）。
 * 自家多出来的字段（年龄/性别/种族/属性）塞进 extensions.barbara ——
 * 规范里 extensions 就是给各家放私有数据的，酒馆会原样保留，我们自己也能读回来。
 *
 * ⚠️ `extensions.barbara` 这个键名**不要**跟着应用改名走。
 * 它是**已经写进用户文件的数据格式**：改名前导出的卡里就是这个键，
 * 一改就读不回年龄/性别/种族/属性了。要改必须同时保留对旧键的读取。
 *
 * character_book：这张卡绑定的世界书（导入时自动绑上的那本）。
 * 导出时一起带走，别人拿到这张卡就能直接用上它的背景设定 ——
 * 酒馆也认这个字段，会当成「角色绑定的世界书」。
 */
function characterCardPayload(character) {
  // 只带第一本：v2 规范里 character_book 是单本（酒馆同样只导出主世界书）
  const boundId = Array.isArray(character.worldbookIds) ? character.worldbookIds[0] : null;
  const boundBook = boundId ? worldbookById(boundId) : null;

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name || '',
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      first_mes: character.firstMes || '',
      mes_example: character.mesExample || '',
      creator_notes: character.creatorNotes || '',
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      tags: Array.isArray(character.tags) ? character.tags : [],
      alternate_greetings: [],
      character_book: boundBook ? worldbookPayload(boundBook) : null,
      creator: '',
      character_version: '',
      extensions: {
        barbara: {
          age: character.age || '',
          gender: character.gender || '',
          race: character.race || '',
          attributes: characterAttrs(character),
          // 开关也带上：别人导入后拿到的状态跟你这边一致
          worldbookEnabled: character.worldbookEnabled !== false
        }
      }
    }
  };
}

/** 当前会话导出成 Markdown */
function conversationMarkdown(convo) {
  const lines = [];
  const character = characterForConvo(convo);
  const player = convoPlayer(convo);

  lines.push(`# ${convo.title || '对话'}`);
  lines.push('');
  const meta = [];
  if (character) meta.push(`角色：${character.name}`);
  if (player && player.name) meta.push(`我：${player.name}`);
  const book = convoWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .find(Boolean);
  if (book) meta.push(`世界：${book.name}`);
  meta.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`> ${meta.join(' · ')}`);
  lines.push('');

  // 状态面板单独列一段：正文里那几行注入时会被剥掉，导出的快照留着更有用
  const panelFields = convoPanelFields(convo);
  const panel = convoPanel(convo);
  const filled = panelFields.filter((n) => String(panel[n] || '').trim());
  if (filled.length) {
    lines.push('## 当前状态');
    lines.push('');
    for (const name of filled) lines.push(`- ${name}：${panel[name]}`);
    lines.push('');
  }

  lines.push('## 对话');
  lines.push('');
  for (const message of convo.messages || []) {
    const content = String(message.content || '').trim();
    if (!content) continue;
    if (message.role === 'user') lines.push(`**${player && player.name ? player.name : userName()}：**`);
    else if (message.role === 'error') lines.push('**（出错了）**');
    else lines.push(`**${character ? character.name : speakerName(convo)}：**`);
    lines.push('');
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n');
}

/** 角色头像 → PNG 数据（没有头像就画一张带首字母的占位图） */
function avatarPngDataUrl(character) {
  return new Promise((resolve) => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const placeholder = () => {
      ctx.fillStyle = '#4a86e8';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${Math.round(size * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((character.name || '?').slice(0, 1), size / 2, size / 2 + 8);
      resolve(canvas.toDataURL('image/png'));
    };

    if (!character.avatar) {
      placeholder();
      return;
    }

    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        const out = canvas.toDataURL('image/png');
        if (out.startsWith('data:image/png')) resolve(out);
        else placeholder();
      } catch (err) {
        placeholder();
      }
    };
    img.onerror = placeholder;
    img.src = character.avatar;
  });
}

/** 导出当前编辑的角色卡：存 .png 就是带数据的酒馆卡，存 .json 就是纯数据 */
export async function exportCharacter() {
  // 「当前编辑的角色」由角色编辑器持有 —— 这里只问一声（从它那儿取）
  const character = currentEditorCharacter();
  if (!character) return;

  const name = safeFileName(character.name);
  const json = JSON.stringify(characterCardPayload(character), null, 2);
  const png = await avatarPngDataUrl(character);

  await saveExport({
    title: '导出角色卡',
    fileName: `${name}.png`,
    filters: [
      { name: 'PNG 角色卡（带数据，酒馆可直接导入）', extensions: ['png'] },
      { name: 'JSON 角色卡（纯数据，方便改）', extensions: ['json'] }
    ],
    text: json,
    base64: String(png).split(',')[1] || '',
    pngText: { keyword: 'chara', text: base64Utf8(json) }
  });
}

/** 导出当前会话为 Markdown */
export async function exportConversation() {
  const convo = activeConvo();
  if (!convo || !(convo.messages || []).length) {
    showToast('当前会话还是空的', 'error');
    return;
  }

  await saveExport({
    title: '导出对话',
    fileName: `${safeFileName(convo.title || '对话')}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '纯文本', extensions: ['txt'] }
    ],
    text: conversationMarkdown(convo)
  });
}
