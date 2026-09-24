'use strict';

// ============================================================================
//  views/characterEditor.js —— 角色编辑器（弹窗本体）
//
//  一个弹窗编辑「一张角色卡」，两处复用：
//    · 作用域 'library'    改的是角色库里的角色
//    · 作用域 'worldbook'  改的是当前世界书里的那个独立副本（不动角色库）
//  所以这里所有读写都走 editorCharacterById() —— 同一套表单才能编辑两份数据。
//
//  「新建角色」是个**草稿**：它先只活在编辑器里，不进任何列表、也不写磁盘，
//  点了「保存角色」才真正被创建（commitCharDraft）。关掉编辑器就等于放弃。
//
//  表单里的改动是「读的时候填进去、保存/切走的时候收回来」（fillCharForm /
//  stashCharForm）—— 中途不写回角色卡，所以填到一半关掉不会留下半个改动。
//
//  属性区（快捷候选词 / 类型 / 范围）搬去了 views/charAttributes.js，
//  它接收本模块的草稿数组（传引用），保存时由本模块一起写回角色卡。
//
//  入口层只从这儿取六样东西：
//    openCharacterEditor / startCharacterDraftInBook / releaseEditorScope /
//    stashCharacterForm / currentEditorCharacter / deleteCharacterById
//  动作注入：rerender（保存和删除之后要全量重绘，那属于入口层的编排）。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { MAX_PANEL_FIELDS } from '../data/panel.js';
import {
  characters,
  characterAttrs,
  worldbooks,
  worldbookById,
  worldbookCharacters,
  newWorldbookCharId
} from '../data/library.js';
import { persistCharacters, persistConversations, persistLibrary } from '../data/persist.js';
import { currentWorldbook, renderWorldbookChars } from './worldbook.js';
import { renderWorldbookPage } from './worldbookList.js';
import { renderCharacterPage } from './characterList.js';
import { renderCharAttrs, initCharAttrsUi } from './charAttributes.js';
import { attachAutoGrow, syncAutoGrowAll } from '../ui/auto-grow.js';

// ---------------------------------------------------------------------------
//  长文本框：自动增高 + 拖拽高度记忆
//
//  这五个框（描述 / 性格 / 场景 / 开场白 / 示例对话）有时会填很多，
//  固定 rows 的框看不全内容。行为细节都在 ui/auto-grow.js 里，
//  这里只负责「哪些框」和「什么时候重算」。
//
//  key 用**字段名**而不是角色 id：拖高是「我习惯把示例对话拖这么高」，
//  换个角色也该沿用 —— 按角色记的话，每换一张卡都要重拖一遍。
// ---------------------------------------------------------------------------

/** 五个长文本框 + 各自的记忆 key */
function longTextAreas() {
  const c = el.c || {};
  return [
    [c.desc, 'desc'],
    [c.personality, 'personality'],
    [c.scenario, 'scenario'],
    [c.first, 'first'],
    [c.example, 'example']
  ].filter((pair) => pair[0]);
}

/** 给五个框接上自动增高。接线只需一次（重复调用会被 ignore） */
function wireAutoGrow() {
  for (const [node, key] of longTextAreas()) {
    attachAutoGrow(node, { key: `charform:${key}` });
  }
}

// ---------------------------------------------------------------------------
//  编辑器的状态
// ---------------------------------------------------------------------------

let editingCharacterId = null; // 角色库里当前正在编辑的角色
// 角色编辑器的作用域：'library' = 角色库；'worldbook' = 当前世界书里的角色副本。
// 同一个编辑器两处复用 —— 从世界书里点「编辑」改的是书里那份副本，不动角色库。
let charEditorScope = 'library';
let charDraftAvatar = ''; // 正在编辑的角色头像（dataURL）
// 正在编辑的角色「自带世界书」开关。跟头像一样是草稿：改动先留在这里，
// 保存时才写回角色卡 —— 这样切换开关能立刻反映到界面上。
let charDraftWbEnabled = true;
// 「新建角色」做出来的草稿：它先只活在编辑器里，不进任何列表、也不写磁盘，
// 点了「保存角色」才真正被创建。关掉编辑器就等于放弃这次新建。
let charDraft = null; // { character, scope, bookId }
// 编辑器打开期间的属性草稿，点「保存角色」才写回角色卡（和 charDraftAvatar 一个套路）
let charAttrs = [];
// 角色编辑器里「给角色绑世界书」那个浮层（自己起一个，不复用世界书页的选择器）
let worldbookPickerEl = null;

// 性别是选择框，只认这几个值（导入的卡会在主进程先归一化过来）
const GENDERS = ['男', '女', '其他'];

// 入口层注入的动作
let actions = { rerender: () => {} };

/**
 * 角色编辑器当前能看到的角色列表：角色库，或者某本世界书里的角色副本。
 * 编辑器里所有读写都走这两个函数，副本才能被同一套表单编辑。
 */
function editorCharacterList() {
  if (charEditorScope === 'worldbook') return worldbookCharacters(currentWorldbook());
  return characters();
}

function editorCharacterById(id) {
  if (!id) return null;
  // 新建的草稿还没进任何列表，但编辑表单照样得能读写它
  if (charDraft && charDraft.character.id === id) return charDraft.character;
  return editorCharacterList().find((c) => c.id === id) || null;
}

/** 编辑器里现在放着的是一个还没保存的新角色吗？ */
function isCharDraft() {
  return !!charDraft && editingCharacterId === charDraft.character.id;
}

// ---------------------------------------------------------------------------
//  打开 / 关闭
// ---------------------------------------------------------------------------

export function openCharsModal() {
  // 弹窗现在只是「编辑某一个角色」的表单，没有列表了。
  // 谁打开它谁负责先设好 editingCharacterId / charEditorScope。
  // 编辑器的入口指向了别的角色，说明「新建」那个草稿已经被放弃了，顺手清掉。
  if (charDraft && editingCharacterId !== charDraft.character.id) discardCharDraft();

  // 长文本框的接线在 fillCharForm() 里（新建和编辑两条路都经过那儿）

  let current = editorCharacterById(editingCharacterId);

  if (!current) {
    // 兜底：没指定就退回作用域里的第一个（世界书副本也走这里）
    const list = editorCharacterList();
    editingCharacterId = list.length ? list[0].id : null;
    current = editorCharacterById(editingCharacterId);
  }

  // 先让弹窗可见再填表：fillCharForm 最后会量文本框高度，
  // 而隐藏状态下（display:none）量什么都是 0。
  el.charsModal.classList.remove('hidden');

  if (current) {
    fillCharForm(current);
  } else {
    showCharForm(false);
  }

  updateCharEditorScopeUi();
}

/** 弹窗标题跟着作用域变，免得改半天不知道改的是哪一份 */
function updateCharEditorScopeUi() {
  const inBook = charEditorScope === 'worldbook';
  const book = inBook ? currentWorldbook() : null;
  const creating = isCharDraft();

  if (el.charsTitle) {
    if (creating) el.charsTitle.textContent = inBook ? '新建本书角色' : '新建角色';
    else el.charsTitle.textContent = inBook ? '编辑本书角色' : '编辑角色';
  }
  if (el.charsSub) {
    if (creating) {
      // 说清楚「现在还没这个东西」，免得用户以为点一下就已经建好了
      el.charsSub.textContent = inBook
        ? `填好内容点「保存角色」才会加进这本书${book ? ` · ${book.name}` : ''}`
        : '填好内容点「保存角色」，保存后才会出现在角色库里';
    } else {
      el.charsSub.textContent = inBook
        ? `这本书里的独立副本，改它不影响角色库${book ? ` · ${book.name}` : ''}`
        : '改完记得点右下角「保存角色」';
    }
  }
}

export async function closeCharsModal() {
  // 新建的角色还没保存：关掉就等于放弃，先问一句，免得辛苦填的设定白写
  if (isCharDraft()) {
    const typed = el.c.name.value.trim();
    const ok = await confirmDialog({
      title: '放弃新建',
      message: `「${typed || '新角色'}」还没保存，关掉就不会创建这个角色。`,
      confirmText: '放弃',
      danger: true
    });
    if (!ok) return;
  }

  // 草稿从没进过任何列表，丢掉它不用刷新界面
  discardCharDraft();
  el.charsModal.classList.add('hidden');
  el.input.focus();
}

/** 底部提示：跟着编辑器作用域变，免得不知道改的是哪一份 */
function charFootHintText(character) {
  // 还没保存的新角色没什么来源好说的，先提醒它还不存在
  if (isCharDraft()) return '还没保存 · 点右下角「保存角色」才会创建这个角色';
  if (charEditorScope === 'worldbook') return '改的是世界书里的副本，角色库里的那个角色不受影响';
  if (!character) return '角色卡只保存在你自己电脑上';
  if (character.source === 'png') return '来自酒馆 PNG 角色卡';
  if (character.source === 'json') return '来自 JSON 角色卡';
  return '这是你自己写的角色';
}

/** 有角色时显示右边的编辑表单，没有就显示空状态 */
function showCharForm(show) {
  el.charForm.classList.toggle('hidden', !show);
  el.charEmpty.classList.toggle('hidden', !!show);
  // 新建的新角色还没保存，没有可删的东西
  el.btnDelChar.disabled = !show || isCharDraft();
  el.btnSaveChar.disabled = !show;
  if (!show) el.charFootHint.textContent = charFootHintText(null);
}

// ---------------------------------------------------------------------------
//  头像
// ---------------------------------------------------------------------------

function renderCharAvatar() {
  el.charAvatar.innerHTML = '';

  if (charDraftAvatar) {
    const img = document.createElement('img');
    img.src = charDraftAvatar;
    img.alt = '';
    el.charAvatar.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'char-avatar-empty';
    span.textContent = '点击上传';
    el.charAvatar.appendChild(span);
  }

  // 没有头像就没有可清除的东西
  el.btnClearAvatar.classList.toggle('hidden', !charDraftAvatar);
}

/**
 * 头像统一缩成 256×256 再存。
 * 直接存原图的话，一张手机照片就能把 characters.json 撑到几十 MB，
 * 而且每次保存设置都要重写整个文件。
 * 只用 canvas 的标准 API，不引入任何依赖。
 */
function shrinkAvatar(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        // 从原图居中裁出一个正方形再缩放，避免变形
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

        // webp 体积小又支持透明；浏览器不支持时会自动退回 png
        const out = canvas.toDataURL('image/webp', 0.9);
        resolve(out.startsWith('data:image/') ? out : dataUrl);
      } catch (err) {
        // 压缩失败就用原图，不能因为优化把功能搞坏
        resolve(dataUrl);
      }
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function pickAvatar() {
  // 用编辑器那套查找：正在新建的草稿不在角色库里，但一样要能传头像
  if (!editorCharacterById(editingCharacterId)) return;

  let result;
  try {
    result = await api.pickImage();
  } catch (err) {
    showToast((err && err.message) || '选择图片失败', 'error');
    return;
  }

  if (!result || result.canceled) return;

  if (!result.dataUrl) {
    showToast(result.error || '这张图片用不了', 'error');
    return;
  }

  charDraftAvatar = await shrinkAvatar(result.dataUrl);
  renderCharAvatar();
  showToast('头像已更换，记得点「保存角色」', 'ok');
}

function clearAvatar() {
  if (!charDraftAvatar) return;
  charDraftAvatar = '';
  renderCharAvatar();
  showToast('头像已清除，记得点「保存角色」');
}

// ---------------------------------------------------------------------------
//  表单：填进去 / 收回来
// ---------------------------------------------------------------------------

function fillCharForm(character) {
  if (!character) {
    showCharForm(false);
    return;
  }

  el.c.name.value = character.name || '';
  el.c.tags.value = (character.tags || []).join(', ');
  el.c.desc.value = character.description || '';
  el.c.personality.value = character.personality || '';
  el.c.scenario.value = character.scenario || '';
  el.c.first.value = character.firstMes || '';
  el.c.example.value = character.mesExample || '';
  el.c.system.value = character.systemPrompt || '';
  el.c.post.value = character.postHistoryInstructions || '';
  el.c.notes.value = character.creatorNotes || '';
  el.c.age.value = character.age || '';
  el.c.gender.value = GENDERS.includes(character.gender) ? character.gender : '';
  el.c.race.value = character.race || '';

  // 长文本框：值刚被程序塞进去，不走 input 事件 —— 所以这里显式重算一次高度。
  // 漏了这一步的表现是「框里明明写着两千字，高度还是两行」，得手动敲一下才展开。
  //
  // ⚠️ 接线必须**在这里**、而不是只在 openCharsModal 里：
  //    新建角色的路径（startCharDraft）是自己调 fillCharForm 的，
  //    不经过 openCharsModal —— 少接一次线的表现是「新建角色时框不会长高」。
  //    attachAutoGrow 自带幂等（认 dataset.autoGrow），重复调用没有代价。
  //
  // ⚠️ 但**量高度不能在这一刻做**：调用方（openCharsModal / startCharDraft）
  //    都还没把弹窗的 .hidden 摘掉，而 display:none 的元素 scrollHeight 是 0 ——
  //    量出来永远是下限 84px。所以这里只接线，真正的重算放在
  //    showCharForm(true) 之后（那时弹窗已经可见）。
  wireAutoGrow();

  charDraftAvatar = character.avatar || '';
  renderCharAvatar();

  // 开关的草稿要从这张卡的当前值起算（老数据没这个字段 = 开）
  charDraftWbEnabled = character.worldbookEnabled !== false;

  // 角色自带的世界书：清单 + 绑定按钮 + 开关
  renderCharWorldbookBox(character);

  // 属性：复制一份当草稿，保存时才写回角色卡
  charAttrs = characterAttrs(character);
  renderCharAttrs(charAttrs);

  // 剧情选项：这张卡开没开、给几个、有什么额外要求
  const optSpec = character.optionsSpec && typeof character.optionsSpec === 'object' ? character.optionsSpec : null;
  el.c.optionsOn.checked = !!optSpec;
  el.c.optionsCount.value = String(optSpec ? optSpec.count || 3 : 3);
  el.c.optionsHint.value = optSpec ? optSpec.hint || '' : '';
  renderOptionsConfig();

  el.charFootHint.textContent = charFootHintText(character);

  showCharForm(true);

  // 长文本框的最后一步：到这儿弹窗才是可见的（上面那些调用方刚摘掉 .hidden），
  // 这时候量高度才量得准。见上面那段注释 —— 在隐藏状态下量会永远得到 84px。
  syncAutoGrowAll(longTextAreas().map((pair) => pair[0]));
}

/** 剧情选项的配置区：开关关着就整块收起来（省得看着以为在生效） */
function renderOptionsConfig() {
  if (!el.c.optionsConfig) return;
  el.c.optionsConfig.classList.toggle('hidden', !el.c.optionsOn.checked);
}

// ---------------------------------------------------------------------------
//  角色自带的世界书
// ---------------------------------------------------------------------------

/**
 * 角色自带世界书那一块。
 *
 * 这块**始终显示**（以前是「有绑定才显示」，结果没绑定过的角色
 * 根本找不到入口加书）。没绑定时列出空状态提示，开关和说明照常给。
 */
function renderCharWorldbookBox(character) {
  if (!character) return;

  const ids = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const books = ids.map((id) => worldbookById(id)).filter(Boolean);
  // 开关的当前值以草稿为准（用户可能刚切过还没保存）
  const enabled = charDraftWbEnabled;

  // --- 已绑的清单 ---
  el.c.wbList.innerHTML = '';

  if (!books.length) {
    const empty = document.createElement('p');
    empty.className = 'field-help cwb-empty';
    empty.textContent =
      '还没有绑定。点「＋ 绑定」从世界书库里挑一本 —— 单独跟这个角色聊天时会带上它。';
    el.c.wbList.appendChild(empty);
  } else {
    for (const book of books) {
      const row = document.createElement('div');
      row.className = 'cwb-row';

      const name = document.createElement('span');
      name.className = 'cwb-row-name';
      name.textContent = book.name;
      name.title = book.name;

      const count = document.createElement('span');
      count.className = 'cwb-row-count';
      const n = Array.isArray(book.entries) ? book.entries.length : 0;
      count.textContent = `${n} 条`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cwb-row-del';
      del.title = '解绑（不会删掉世界书本身）';
      del.setAttribute('aria-label', `解绑 ${book.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => unbindWorldbookFromCharacter(book.id));

      row.append(name, count, del);
      el.c.wbList.appendChild(row);
    }
  }

  // --- 开关：没有绑定时藏起来（开着也没意义）---
  const hasBooks = books.length > 0;
  el.c.wbSwitch.classList.toggle('hidden', !hasBooks);
  el.c.wbEnabled.checked = enabled;

  if (!hasBooks) {
    el.c.wbDesc.textContent = '';
    el.c.wbHint.textContent =
      '绑定之后，这张卡单独聊天会带上这本书的设定；被绑进某个世界当角色时不生效（那条会话有自己的世界观）。';
    return;
  }

  const names = books.map((b) => b.name).join('、');
  const total = books.reduce((sum, b) => sum + (Array.isArray(b.entries) ? b.entries.length : 0), 0);
  el.c.wbDesc.textContent = `已绑 ${books.length} 本（共 ${total} 条）：${names}`;

  el.c.wbHint.textContent = enabled
    ? '现在生效。单独跟它聊天时会带上这些设定；但绑进某个世界当角色时不生效 —— 那条会话已经有自己的世界观了。'
    : '已停用。无论单独聊天、还是绑进某个世界当角色，都不会带入这几本书 —— 这张卡保持干净（绑定关系留着，随时能再打开）。';
}

/** 只刷新开关下面的说明文字（切换开关时用，不动清单） */
function updateCharWorldbookHint(character) {
  const books = (character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [])
    .map((id) => worldbookById(id))
    .filter(Boolean);
  if (!books.length) return;

  const enabled = character.worldbookEnabled !== false;
  const names = books.map((b) => b.name).join('、');
  const total = books.reduce((sum, b) => sum + (Array.isArray(b.entries) ? b.entries.length : 0), 0);
  el.c.wbDesc.textContent = `已绑 ${books.length} 本（共 ${total} 条）：${names}`;

  el.c.wbHint.textContent = enabled
    ? '现在生效。单独跟它聊天时会带上这些设定；但绑进某个世界当角色时不生效 —— 那条会话已经有自己的世界观了。'
    : '已停用。无论单独聊天、还是绑进某个世界当角色，都不会带入这几本书 —— 这张卡保持干净（绑定关系留着，随时能再打开）。';
}

async function bindWorldbookToCharacter(bookId) {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const ids = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];
  if (ids.includes(bookId)) {
    showToast('这本已经绑上了');
    return;
  }

  ids.push(bookId);
  character.worldbookIds = ids;
  // 刚绑上就默认启用 —— 绑了却因为开关关着不生效，会让人以为是 bug
  if (character.worldbookEnabled === false && ids.length === 1) {
    character.worldbookEnabled = true;
  }
  character.updatedAt = now();

  renderCharWorldbookBox(character);
  await persistLibrary();
  showToast('已绑定世界书');
}

/** 解绑（不删世界书本身） */
async function unbindWorldbookFromCharacter(bookId) {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const book = worldbookById(bookId);
  character.worldbookIds = (character.worldbookIds || []).filter((id) => id !== bookId);
  character.updatedAt = now();

  renderCharWorldbookBox(character);
  await persistLibrary();
  showToast(book ? `已解绑「${book.name}」（世界书还在库里）` : '已解绑');
}

/**
 * 点「＋ 绑定」：列出还没绑的世界书让用户挑。
 *
 * 自己起一个轻量浮层，而不是复用世界书页那个角色选择器 ——
 * 那个是「角色 → 加进世界书」，方向相反，而且绑了一堆模块级状态，
 * 硬套进来会互相干扰。
 */
function openWorldbookPicker() {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const bound = new Set(Array.isArray(character.worldbookIds) ? character.worldbookIds : []);
  const all = worldbooks();
  const candidates = all.filter((b) => !bound.has(b.id));

  if (!all.length) {
    showToast('世界书库还是空的 —— 先去「世界书」页新建或导入一本', 'error');
    return;
  }
  if (!candidates.length) {
    showToast('所有世界书都已经绑上了');
    return;
  }

  closeWorldbookPicker();

  const overlay = document.createElement('div');
  overlay.className = 'cwb-picker';

  const card = document.createElement('div');
  card.className = 'cwb-picker-card';

  const head = document.createElement('div');
  head.className = 'cwb-picker-head';
  const title = document.createElement('span');
  title.className = 'cwb-picker-title';
  title.textContent = `给「${character.name}」绑定世界书`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn icon-btn-sm';
  close.title = '关闭';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  close.addEventListener('click', closeWorldbookPicker);
  head.append(title, close);

  const list = document.createElement('div');
  list.className = 'cwb-picker-list';

  for (const book of candidates) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cwb-picker-row';

    const name = document.createElement('span');
    name.className = 'cwb-picker-name';
    name.textContent = book.name;

    const meta = document.createElement('span');
    meta.className = 'cwb-picker-meta';
    const n = Array.isArray(book.entries) ? book.entries.length : 0;
    const chars = Array.isArray(book.characters) ? book.characters.length : 0;
    meta.textContent = chars ? `${n} 条 · ${chars} 个角色` : `${n} 条`;

    row.append(name, meta);
    row.addEventListener('click', () => {
      closeWorldbookPicker();
      bindWorldbookToCharacter(book.id);
    });
    list.appendChild(row);
  }

  card.append(head, list);
  overlay.appendChild(card);

  // 点浮层空白处关掉
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeWorldbookPicker();
  });

  document.body.appendChild(overlay);
  worldbookPickerEl = overlay;
}

function closeWorldbookPicker() {
  if (worldbookPickerEl) {
    worldbookPickerEl.remove();
    worldbookPickerEl = null;
  }
}

// ---------------------------------------------------------------------------
//  草稿 / 保存 / 删除
// ---------------------------------------------------------------------------

/** 把表单里的内容写回内存里的角色对象（切走或保存前调用） */
function stashCharForm() {
  const character = editorCharacterById(editingCharacterId);
  if (!character || el.charForm.classList.contains('hidden')) return;

  character.name = el.c.name.value.trim() || '未命名角色';
  character.tags = el.c.tags.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  character.description = el.c.desc.value;
  character.personality = el.c.personality.value;
  character.scenario = el.c.scenario.value;
  character.firstMes = el.c.first.value;
  character.mesExample = el.c.example.value;
  character.systemPrompt = el.c.system.value;
  character.postHistoryInstructions = el.c.post.value;
  character.creatorNotes = el.c.notes.value;
  // 身份三项：年龄和种族是自由文本（「不详」「精灵」都合法），性别用选择框
  character.age = el.c.age.value.trim().slice(0, 40);
  character.gender = GENDERS.includes(el.c.gender.value) ? el.c.gender.value : '';
  character.race = el.c.race.value.trim().slice(0, 40);
  // 属性是编辑期间的草稿（charAttrs），保存时才写回角色卡。
  // ⚠️ 这里以前是个只搬 name/value 的白名单映射 —— 于是 type/min/max/hint
  // 会被静默丢掉（和当初「attributes 整个丢过」是同一个坑）。
  // 现在只摘掉界面自己的临时状态（_moreOpen），其余字段原样带走。
  character.attributes = charAttrs
    .filter((a) => a && typeof a.name === 'string' && a.name.trim())
    .map((a) => {
      const out = { ...a, name: a.name.trim().slice(0, 24), value: String(a.value == null ? '' : a.value).slice(0, 500) };
      delete out._moreOpen;
      return out;
    })
    .slice(0, MAX_PANEL_FIELDS);
  character.avatar = charDraftAvatar;
  // 剧情选项：开关关掉就写 null（不是 false/空对象）—— 一眼能看出「这个会话不开」。
  // 数量夹在 1~6，和注入时用的上限保持一致。
  if (el.c.optionsOn.checked) {
    const raw = Number(el.c.optionsCount.value);
    const count = isFinite(raw) ? Math.max(1, Math.min(6, Math.round(raw))) : 3;
    character.optionsSpec = { count, hint: el.c.optionsHint.value.trim().slice(0, 200) };
  } else {
    character.optionsSpec = null;
  }
  // 角色自带世界书的开关（草稿）。没有绑书时不写这个字段，
  // 免得给没有书的角色平白加一个属性。
  if ((character.worldbookIds || []).length) {
    character.worldbookEnabled = charDraftWbEnabled;
  }
  character.updatedAt = now();
}

/**
 * 角色列表页的「＋ 新建角色」。
 * 先把作用域钉死在角色库 —— 上一次可能是在世界书里编辑副本，作用域还留着。
 */
function newCharacter() {
  charEditorScope = 'library';
  startCharDraft();
}

/**
 * 新建角色：只做一个「草稿」塞进编辑器给用户填。
 * 保存之前它不进角色库 / 世界书，也不写磁盘；关掉编辑器就当没建过。
 */
function startCharDraft() {
  // 上一个角色的表单里可能还有没保存的改动，先收进内存（和以前一样），
  // 再把上一份没保存完的草稿丢掉，免得留下一个永远不会被创建的幽灵角色。
  stashCharForm();
  discardCharDraft();

  const scope = charEditorScope;
  const book = scope === 'worldbook' ? currentWorldbook() : null;
  if (scope === 'worldbook' && !book) return;

  const character = {
    id: scope === 'worldbook' ? newWorldbookCharId() : uid(),
    name: '新角色',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    attributes: [],
    age: '',
    gender: '',
    race: '人类', // 新建的角色默认就是人类，省得每次打
    source: 'manual',
    createdAt: now(),
    updatedAt: now()
  };

  charDraft = { character, scope, bookId: book ? book.id : null };
  editingCharacterId = character.id;

  // 先让弹窗可见再填表：fillCharForm 最后会量文本框高度，
  // 而隐藏状态下（display:none）量什么都是 0。
  el.charsModal.classList.remove('hidden');
  fillCharForm(character);
  updateCharEditorScopeUi();

  el.c.name.focus();
  el.c.name.select();
}

/**
 * 把新建的草稿真正写进角色库 / 世界书。
 * 只有点「保存角色」会走到这里 —— 这就是「保存后才生成」那一步。
 */
function commitCharDraft() {
  if (!charDraft) return true;

  const { character, scope, bookId } = charDraft;

  if (scope === 'worldbook') {
    const book = worldbookById(bookId);
    // 书在编辑期间被删掉了，这个草稿就没有落脚的地方
    if (!book) return false;
    book.characters = worldbookCharacters(book);
    book.characters.push(character);
    book.updatedAt = now();
  } else {
    state.characters = [...characters(), character];
  }

  charDraft = null;
  return true;
}

/** 丢掉没保存的草稿：它从来没进过任何列表，忘掉就行 */
function discardCharDraft() {
  if (!charDraft) return;
  if (editingCharacterId === charDraft.character.id) editingCharacterId = null;
  charDraft = null;
}

async function saveCharacter() {
  if (!editingCharacterId) return;

  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  // 必须先校验再落内存：stashCharForm 会把空名字写成「未命名角色」，
  // 放在它后面校验就晚了 —— 弹了提示，内存却已经被改名，列表也没重绘。
  if (!el.c.name.value.trim()) {
    showToast('给角色起个名字吧', 'error');
    el.c.name.focus();
    return;
  }

  // 这一下到底是「新建」还是「改已有的」，要在落盘前记下来：
  // 草稿一提交 charDraft 就清空了，后面就分不出来了。
  const creating = isCharDraft();
  const scope = creating ? charDraft.scope : charEditorScope;

  stashCharForm();

  // 新建的角色到这一刻才真正被创建（进角色库 / 进这本书）
  if (creating && !commitCharDraft()) {
    showToast('这本书已经不在了，角色没能创建', 'error');
    return;
  }

  // 名字可能被规整过，重新填一遍保证界面和数据一致
  renderCharacterPage();
  fillCharForm(character);
  // 新建的那一行提示语要从「还没保存」换成正常的
  updateCharEditorScopeUi();
  actions.rerender();

  // 改的是书里的副本，书名旁边那排和左栏计数都要跟着刷新
  if (scope === 'worldbook') {
    renderWorldbookChars();
    renderWorldbookPage();
  }

  await persistCharacters();
  showToast(creating ? `角色「${character.name}」已创建` : `角色「${character.name}」已保存`, 'ok');
}

/**
 * 删除一个角色。
 * scope：'library' = 从角色库删掉（默认）；'worldbook' = 只从当前这本书里移除副本。
 *
 * 两个入口共用这一份逻辑：角色卡右上角的 ×，和编辑弹窗底部的「删除角色」。
 * 以前它俩是「谁打开编辑器谁负责」，所以在卡片上删不了 —— 得先点进编辑。
 */
export async function deleteCharacterById(id, scope) {
  const inBook = scope === 'worldbook';

  const character = inBook
    ? worldbookCharacters(currentWorldbook()).find((c) => c.id === id)
    : characters().find((c) => c.id === id);
  if (!character) return;

  const ok = await confirmDialog({
    title: inBook ? '移除角色' : '删除角色',
    message: inBook
      ? `把「${character.name}」从这本书里移除？角色库里的那个角色不受影响。`
      : `删除角色「${character.name}」？用到它的会话会变回通用助手。`,
    confirmText: inBook ? '移除' : '删除',
    danger: true
  });
  if (!ok) return;

  if (inBook) {
    const book = currentWorldbook();
    if (book) {
      book.characters = worldbookCharacters(book).filter((c) => c.id !== character.id);
      book.updatedAt = now();
    }
  } else {
    state.characters = characters().filter((c) => c.id !== character.id);

    // 把绑定了这个角色的会话解绑，免得留下一个指向空气的 id
    for (const convo of state.conversations) {
      if (convo.characterId === character.id) convo.characterId = null;
    }
  }

  // 编辑器如果正开在这个角色上，就没有可编辑的对象了 —— 关掉它。
  // （从卡片删的时候编辑器根本没开，这一段会跳过。）
  if (editingCharacterId === character.id) {
    editingCharacterId = null;
    if (!el.charsModal.classList.contains('hidden')) closeCharsModal();
  }

  if (inBook) {
    // 书里的副本不受会话影响，只需要刷新书那边的界面
    renderWorldbookChars();
    renderWorldbookPage();
  } else {
    actions.rerender();
    persistConversations(0);
  }
  await persistCharacters();

  showToast(inBook ? `已移除「${character.name}」` : `已删除「${character.name}」`);
}

/** 编辑弹窗底部的「删除角色」：删的就是编辑器里正在编辑的这个 */
async function deleteCharacter() {
  // 还没保存的新角色没有任何东西可删（按钮也是禁用的，这里只是兜底）
  if (isCharDraft()) return;

  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  await deleteCharacterById(character.id, charEditorScope);
}

// ---------------------------------------------------------------------------
//  给入口层 / 别的视图用的口子
// ---------------------------------------------------------------------------

/** 打开编辑器，编辑指定角色（scope 省略 = 角色库） */
export function openCharacterEditor(id, scope = 'library') {
  charEditorScope = scope === 'worldbook' ? 'worldbook' : 'library';
  editingCharacterId = id || null;
  openCharsModal();
}

/** 在当前世界书作用域下起草一个新角色（世界书编辑器里的「新建本书角色」） */
export function startCharacterDraftInBook() {
  charEditorScope = 'worldbook';
  startCharDraft();
}

/** 离开世界书作用域（世界书编辑器关掉时收尾） */
export function releaseEditorScope() {
  if (charEditorScope === 'worldbook') charEditorScope = 'library';
}

/** 把当前表单收进内存（切角色 / 导入之前调，免得填的内容白丢） */
export function stashCharacterForm() {
  stashCharForm();
}

/** 编辑器里正在编辑的那个角色（导出角色卡要用） */
export function currentEditorCharacter() {
  return editorCharacterById(editingCharacterId);
}

/** 绑编辑器自己的所有按钮。rerender 由入口层注入 */
export function initCharacterEditor(injected) {
  actions = { rerender: () => {}, ...(injected || {}) };

  el.btnCloseChars.addEventListener('click', closeCharsModal);
  el.btnNewChar.addEventListener('click', newCharacter);
  el.btnSaveChar.addEventListener('click', saveCharacter);
  el.btnDelChar.addEventListener('click', deleteCharacter);

  // 点头像换图 / 清除头像
  el.charAvatar.addEventListener('click', pickAvatar);
  el.btnClearAvatar.addEventListener('click', clearAvatar);

  // 自带世界书的开关：先更新草稿，再按草稿刷新说明文字。
  // 注意不能直接读 editorCharacterById —— 那时角色卡上还是旧值（还没保存），
  // 结果就是「点了开关但说明没变」。
  el.c.wbEnabled.addEventListener('change', () => {
    charDraftWbEnabled = el.c.wbEnabled.checked;
    const character = editorCharacterById(editingCharacterId);
    if (character) {
      updateCharWorldbookHint({ ...character, worldbookEnabled: charDraftWbEnabled });
    }
  });

  // 「＋ 绑定」：挑一本世界书加到这个角色上
  el.c.wbAddBtn.addEventListener('click', openWorldbookPicker);

  // 剧情选项的开关：只切配置区的显示，值在保存时才写回角色卡
  if (el.c.optionsOn) el.c.optionsOn.addEventListener('change', renderOptionsConfig);

  el.charsModal.addEventListener('click', (event) => {
    if (event.target === el.charsModal) closeCharsModal();
  });

  // 属性区的按钮（快捷候选词是渲染时就带的）
  initCharAttrsUi({ getList: () => charAttrs });
}
