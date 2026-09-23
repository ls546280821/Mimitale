// ---------------------------------------------------------------------------
//  世界书编辑器（World Info / Lorebook）
//
//  左栏选书，中栏列条目，右栏编辑。数据在主进程的 worldbooks.json。
//  词条只由「会话绑定了哪本书」生效；每本书还能装若干角色副本（独立个体）。
//
//  两处刻意的边界：
//
//   · 本书角色的「编辑 / 新建」要切角色编辑器的作用域（charEditorScope）
//     再打开角色编辑器弹窗 —— 那是跨视图编排，由入口层通过 initWorldbook
//     注入四个动作（openInBook / draftInBook / releaseScope / stashDraft），
//     本模块不向上 import 入口层，也不 import 角色编辑器。
//
//   · 「导入世界书」留在入口层（它要同时动角色库、世界书列表页和角色列表页），
//     同样靠注入拿进来（importBooks）。
//
//  弹窗只在打开时渲染，不参与整体重绘，所以不向刷新总线登记 ——
//  只做事件绑定（和 views/perspectiveUi.js 一样）。
//
//  只有「编辑某一本」这个入口动作（editWorldbookFromPage）例外：它要设
//  editingWorldbookId —— 那是**本模块**的状态，所以它住在这儿并导出，
//  由入口层反过来注入给世界书列表页（列表页不需要知道「当前选中的是哪本」）。
// ---------------------------------------------------------------------------

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo, safeFileName } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, button, clear } from '../ui/build.js';
import { saveExport } from '../data/export.js';
import { persistLibrary, persistConversations } from '../data/persist.js';
import {
  characters,
  worldbooks,
  worldbookById,
  worldbookCharacters,
  newWorldbookCharId,
  convoWorldbookIds,
  worldbookPayload,
  WORLDBOOK_SCAN_DEPTH,
  recursiveDepthSetting
} from '../data/library.js';
import { renderWorldbookPage } from './worldbookList.js';

// --- 入口层注入的跨视图编排动作 ---
// openInBook(id)：把编辑焦点切到这本书里的某个角色副本并打开角色编辑器
// draftInBook()：在「世界书副本」作用域下起草一个新角色
// releaseScope()：删掉本书时把角色编辑器作用域退回角色库
// stashDraft()：把角色编辑器表单里的内容先写回内存（导入前要先保存）
// importBooks()：导入世界书（入口层跨角色库的编排）
let openInBook = () => {};
let draftInBook = () => {};
let releaseScope = () => {};
let stashDraft = () => {};
let importBooks = async () => {};

export function initWorldbook(opts = {}) {
  if (typeof opts.openInBook === 'function') openInBook = opts.openInBook;
  if (typeof opts.draftInBook === 'function') draftInBook = opts.draftInBook;
  if (typeof opts.releaseScope === 'function') releaseScope = opts.releaseScope;
  if (typeof opts.stashDraft === 'function') stashDraft = opts.stashDraft;
  if (typeof opts.importBooks === 'function') importBooks = opts.importBooks;

  // --- 编辑器本体 ---
  el.wb.btnExport.addEventListener('click', exportWorldbook);
  el.wb.btnClose.addEventListener('click', closeWorldbooksModal);
  el.wb.btnClose2.addEventListener('click', closeWorldbooksModal);
  el.wb.btnImport.addEventListener('click', importBooks);
  el.wb.btnNew.addEventListener('click', newWorldbook);
  el.wb.btnNewEntry.addEventListener('click', newEntry);
  el.wb.btnDelBook.addEventListener('click', deleteWorldbook);
  el.wb.btnDelEntry.addEventListener('click', deleteEntry);
  el.wb.btnSaveEntry.addEventListener('click', saveEntry);
  el.wb.btnPreview.addEventListener('click', previewWorldbook);
  el.wb.btnAddChars.addEventListener('click', openWorldbookCharPicker);
  el.wb.btnNewChar.addEventListener('click', newWorldbookCharacter);

  // 从角色库多选加入
  el.wbPicker.btnClose.addEventListener('click', closeWorldbookCharPicker);
  el.wbPicker.btnCancel.addEventListener('click', closeWorldbookCharPicker);
  el.wbPicker.btnConfirm.addEventListener('click', confirmWorldbookCharPicker);
  el.wbPicker.modal.addEventListener('click', (event) => {
    if (event.target === el.wbPicker.modal) closeWorldbookCharPicker();
  });

  // 世界书名称和条目内容都是边打字边留在内存里，关闭弹窗时统一落盘
  el.wb.name.addEventListener('input', () => {
    const book = currentWorldbook();
    if (!book) return;
    book.name = el.wb.name.value.trim() || '未命名世界书';
    renderWorldbookPage();
    renderWorldbookChars();
  });

  el.wb.opening.addEventListener('input', () => {
    const book = currentWorldbook();
    if (!book) return;
    book.opening = el.wb.opening.value.slice(0, 4000);
  });

  el.wb.modal.addEventListener('click', (event) => {
    if (event.target === el.wb.modal) closeWorldbooksModal();
  });
}

// ---------------------------------------------------------------------------
//  条目 / 编辑器状态
// ---------------------------------------------------------------------------

const WB_NEW_ENTRY_DEFAULTS = {
  order: 100,
  probability: 100,
  selectiveLogic: 'AND_ANY',
  constant: false,
  enabled: true
};

let editingWorldbookId = null; // 世界书弹窗里当前选中的世界书
let editingEntryId = null; // 编辑器里当前选中的条目

/** 世界书的条目数展示 */
function wbEntryCountText(book) {
  if (!book) return '';
  const total = (book.entries || []).length;
  const on = (book.entries || []).filter((e) => e.enabled !== false).length;
  return on === total ? `${total} 条条目` : `${total} 条条目 · ${on} 条启用`;
}

export function currentWorldbook() {
  return worldbookById(editingWorldbookId);
}

function currentEntry() {
  const book = currentWorldbook();
  if (!book) return null;
  return (book.entries || []).find((e) => e.id === editingEntryId) || null;
}

/** 把世界书表单里的内容写回内存（书名 + 开场白） */
function stashWorldbookName() {
  const book = currentWorldbook();
  if (!book || el.wb.entriesWrap.classList.contains('hidden')) return;
  const name = el.wb.name.value.trim() || '未命名世界书';
  book.name = name.slice(0, 120);
  book.opening = el.wb.opening.value.slice(0, 4000);
  book.updatedAt = now();
}

/** 把条目表单里的内容写回内存 */
function stashEntryForm() {
  const entry = currentEntry();
  if (!entry || el.wb.form.classList.contains('hidden')) return;

  const parseKeys = (value) =>
    String(value || '')
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 200);

  entry.title = el.wb.e.title.value.trim().slice(0, 200) || parseKeys(el.wb.e.keys.value)[0] || '未命名条目';
  entry.keys = parseKeys(el.wb.e.keys.value);
  entry.secondaryKeys = parseKeys(el.wb.e.keys2.value);
  entry.selectiveLogic = el.wb.e.logic.value;
  entry.content = el.wb.e.content.value.slice(0, 20000);

  const order = Number(el.wb.e.order.value);
  entry.order = isFinite(order) ? Math.max(0, Math.min(9999, Math.floor(order))) : WB_NEW_ENTRY_DEFAULTS.order;

  const prob = Number(el.wb.e.prob.value);
  entry.probability = isFinite(prob) ? Math.max(0, Math.min(100, Math.floor(prob))) : 100;

  entry.constant = el.wb.e.constant.checked;
  entry.recursive = el.wb.e.recursive.checked;
  entry.enabled = el.wb.e.enabled.checked;
}

/** 把「编辑器里正在填的东西」先写回内存 —— 导入 / 切书之前要调 */
export function stashWorldbookForm() {
  stashWorldbookName();
  stashEntryForm();
}

function renderEntryList() {
  el.wb.entryList.innerHTML = '';

  const book = currentWorldbook();
  if (!book) return;

  const entries = book.entries || [];
  if (!entries.length) {
    el.wb.entryList.appendChild(
      h('div', { class: 'wb-list-empty', text: '这本书还没有条目，点「＋ 条目」加一条' })
    );
    return;
  }

  for (const entry of entries) {
    el.wb.entryList.appendChild(
      h(
        'div',
        {
          class: ['wb-entry', entry.id === editingEntryId && 'active', entry.enabled === false && 'disabled'],
          title: entry.title,
          onclick: () => selectEntry(entry.id)
        },
        h(
          'div',
          { class: 'wb-entry-title' },
          h('span', { text: entry.title }),
          entry.constant && h('span', { class: 'wb-badge', text: '常驻' }),
          entry.enabled === false && h('span', { class: 'wb-badge', text: '停用' })
        ),
        h('div', { class: 'wb-entry-keys', text: (entry.keys || []).join(' / ') || '（无关键词）' })
      )
    );
  }
}

function showEntryForm(show) {
  el.wb.form.classList.toggle('hidden', !show);
  el.wb.formEmpty.classList.toggle('hidden', !!show);
}

function fillEntryForm(entry) {
  if (!entry) {
    showEntryForm(false);
    return;
  }

  el.wb.e.title.value = entry.title || '';
  el.wb.e.keys.value = (entry.keys || []).join(', ');
  el.wb.e.content.value = entry.content || '';
  el.wb.e.order.value = String(entry.order ?? WB_NEW_ENTRY_DEFAULTS.order);
  el.wb.e.prob.value = String(entry.probability ?? 100);
  el.wb.e.keys2.value = (entry.secondaryKeys || []).join(', ');
  el.wb.e.logic.value = entry.selectiveLogic || 'AND_ANY';
  el.wb.e.constant.checked = entry.constant === true;
  el.wb.e.recursive.checked = entry.recursive === true;
  el.wb.e.enabled.checked = entry.enabled !== false;

  showEntryForm(true);
}

/** 选中一本世界书 */
function selectWorldbook(id) {
  stashWorldbookName();
  stashEntryForm();

  editingWorldbookId = id;
  const book = currentWorldbook();

  el.wb.entriesEmpty.classList.toggle('hidden', !!book);
  el.wb.entriesWrap.classList.toggle('hidden', !book);

  if (!book) {
    editingEntryId = null;
    showEntryForm(false);
    renderWorldbookChars();
    return;
  }

  el.wb.name.value = book.name;
  el.wb.opening.value = book.opening || '';
  el.wb.entryCount.textContent = wbEntryCountText(book);
  el.wb.footHint.textContent = `「${book.name}」只保存在你自己电脑上`;

  // 上一本书选中的条目在新书里不存在，自动落到第一条
  if (!currentEntry()) {
    editingEntryId = (book.entries || []).length ? book.entries[0].id : null;
  }

  renderEntryList();
  fillEntryForm(currentEntry());
  renderWorldbookChars();
}

function selectEntry(id) {
  stashEntryForm();
  editingEntryId = id;
  renderEntryList();
  fillEntryForm(currentEntry());
}

// ---------------------------------------------------------------------------
//  本书角色：从角色库复制进来的独立副本
//  和角色库里的那个角色互相独立 —— 改这边不影响那边，反之亦然。
// ---------------------------------------------------------------------------

/** 画「本书角色」那一排 */
export function renderWorldbookChars() {
  const host = el.wb.charList;
  if (!host) return;
  clear(host);

  const book = currentWorldbook();
  if (!book) return;

  for (const c of worldbookCharacters(book)) {
    host.appendChild(
      h(
        'div',
        { class: 'wb-char-chip', title: c.name },
        h(
          'div',
          { class: 'wb-char-chip-avatar' },
          c.avatar ? h('img', { src: c.avatar, alt: '' }) : c.name.slice(0, 1)
        ),
        h('span', { class: 'wb-char-chip-name', text: c.name }),
        button({
          class: 'wb-char-chip-btn',
          text: '编辑',
          title: '编辑这个副本的设定',
          onClick: () => editWorldbookCharacter(c.id)
        }),
        button({
          class: 'wb-char-chip-btn',
          text: '移除',
          title: '从本书移除（角色库里的不受影响）',
          onClick: () => removeWorldbookCharacter(c.id)
        })
      )
    );
  }
}

/** 把选中的角色库角色复制进本书：深拷贝一份，id 另发，两边从此互不相干 */
async function addWorldbookCharacters(ids) {
  const book = currentWorldbook();
  if (!book) return;

  const wanted = new Set(ids);
  const picked = characters().filter((c) => wanted.has(c.id));
  if (!picked.length) return;

  book.characters = worldbookCharacters(book);
  for (const src of picked) {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newWorldbookCharId();
    copy.createdAt = now();
    copy.updatedAt = now();
    book.characters.push(copy);
  }
  book.updatedAt = now();

  renderWorldbookChars();
  renderWorldbookPage();

  const ok = await persistLibrary();
  showToast(ok ? `已加入 ${picked.length} 个角色副本` : '加入失败，没能写入磁盘', ok ? 'ok' : 'error');
}

/**
 * 在本书里新建一个角色副本。
 * 和角色库那边一样：先只做成草稿给用户填，点「保存角色」之后才真的加进这本书 ——
 * 免得点一下就在书里多出一个空的「新角色」。
 */
function newWorldbookCharacter() {
  if (!currentWorldbook()) return;
  draftInBook();
}

/** 从本书移除一个角色副本（角色库里的角色不动） */
async function removeWorldbookCharacter(id) {
  const book = currentWorldbook();
  if (!book) return;

  const target = worldbookCharacters(book).find((c) => c.id === id);
  if (!target) return;

  const ok = await confirmDialog({
    title: '移除角色',
    message: `把「${target.name}」从这本书里移除？角色库里的那个角色不受影响。`,
    confirmText: '移除',
    danger: true
  });
  if (!ok) return;

  book.characters = worldbookCharacters(book).filter((c) => c.id !== id);
  book.updatedAt = now();

  renderWorldbookChars();
  renderWorldbookPage();
  await persistLibrary();
  showToast('已移除', 'ok');
}

/** 打开角色编辑器，但作用域切到这本书的角色副本 */
function editWorldbookCharacter(id) {
  const book = currentWorldbook();
  if (!book) return;
  openInBook(id);
}

// --- 从角色库多选加入 ---

let wbPickerChars = [];
const wbPickerPicked = new Set();

function openWorldbookCharPicker() {
  const list = characters();
  if (!list.length) {
    showToast('角色库里还没有角色，先建一个吧', 'error');
    return;
  }

  wbPickerChars = list;
  wbPickerPicked.clear();
  renderWorldbookCharPicker();
  el.wbPicker.modal.classList.remove('hidden');
}

export function closeWorldbookCharPicker() {
  el.wbPicker.modal.classList.add('hidden');
  wbPickerChars = [];
  wbPickerPicked.clear();
}

function renderWorldbookCharPicker() {
  const host = el.wbPicker.list;
  host.innerHTML = '';

  if (!wbPickerChars.length) {
    const tip = document.createElement('div');
    tip.className = 'wb-picker-empty';
    tip.textContent = '角色库是空的';
    host.appendChild(tip);
    return;
  }

  for (const c of wbPickerChars) {
    const row = document.createElement('label');
    row.className = `wb-picker-row${wbPickerPicked.has(c.id) ? ' picked' : ''}`;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = wbPickerPicked.has(c.id);
    box.addEventListener('change', () => {
      if (box.checked) wbPickerPicked.add(c.id);
      else wbPickerPicked.delete(c.id);
      row.classList.toggle('picked', box.checked);
      updateWorldbookCharPickerHint();
    });

    const av = document.createElement('div');
    av.className = 'wb-picker-avatar';
    if (c.avatar) {
      const img = document.createElement('img');
      img.src = c.avatar;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = c.name.slice(0, 1);
    }

    const name = document.createElement('span');
    name.className = 'wb-picker-name';
    name.textContent = c.name;

    row.append(box, av, name);
    host.appendChild(row);
  }

  updateWorldbookCharPickerHint();
}

function updateWorldbookCharPickerHint() {
  if (!el.wbPicker.hint) return;
  el.wbPicker.hint.textContent = wbPickerPicked.size
    ? `已选 ${wbPickerPicked.size} 个`
    : '加入的是副本，之后两边各改各的';
}

async function confirmWorldbookCharPicker() {
  const ids = [...wbPickerPicked];
  if (!ids.length) {
    showToast('先勾选要加入的角色', 'error');
    return;
  }
  closeWorldbookCharPicker();
  await addWorldbookCharacters(ids);
}

// ---------------------------------------------------------------------------
//  世界书编辑器
//  只负责编辑「当前这一本」：选书、新建、游玩、导入都在世界书列表页那边。
//  「绑定到会话」整套已经拿掉 —— 世界书是一个世界，从列表页点「游玩」进入，
//  不再往已经开始的对话上挂。
// ---------------------------------------------------------------------------

/**
 * 打开编辑器去编辑某一本。这是列表页「编辑」按钮的动作，由入口层注入给列表页。
 *
 * 它留在这儿而不是跟着列表页走：要设 editingWorldbookId —— 那是**编辑器弹窗**
 * 的状态，只有这一区在读（currentWorldbook / selectWorldbook / openWorldbooksModal）。
 * 列表页不需要知道有「当前选中的是哪本」这回事。
 */
export function editWorldbookFromPage(id) {
  const book = worldbookById(id);
  if (!book) return;
  editingWorldbookId = id;
  openWorldbooksModal();
}

/** 打开编辑器并切到指定的一本（导入完成、外部要跳转时用） */
export function openWorldbookEditor(id) {
  const book = worldbookById(id);
  if (!book) return;
  editingWorldbookId = id;
  renderWorldbookPage();
  openWorldbooksModal();
}

function openWorldbooksModal() {
  // 角色库可能没开着（侧边栏可以直接进世界书），stashCharForm 内部会自己判断
  stashDraft();

  if (!editingWorldbookId || !currentWorldbook()) {
    editingWorldbookId = worldbooks().length ? worldbooks()[0].id : null;
  }

  selectWorldbook(editingWorldbookId);
  renderWorldbookChars();

  el.wb.modal.classList.remove('hidden');
}

function closeWorldbooksModal() {
  stashWorldbookName();
  stashEntryForm();

  el.wb.modal.classList.add('hidden');
  renderWorldbookChars();
  persistLibrary();

  // 列表页可能还开着（编辑完回来看得到最新状态）
  renderWorldbookPage();
}

/** 新建一本世界书，并直接进编辑器 */
function newWorldbook() {
  stashWorldbookName();
  stashEntryForm();

  const book = {
    id: `w${uid()}`,
    name: '新世界书',
    entries: [],
    characters: [],
    createdAt: now(),
    updatedAt: now()
  };

  state.worldbooks = [...worldbooks(), book];
  editingWorldbookId = book.id;
  renderWorldbookPage();

  openWorldbooksModal();
  el.wb.name.focus();
  el.wb.name.select();
}

function newEntry() {
  const book = currentWorldbook();
  if (!book) return;

  stashEntryForm();

  const entry = {
    id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`,
    title: '新条目',
    keys: [],
    secondaryKeys: [],
    selectiveLogic: WB_NEW_ENTRY_DEFAULTS.selectiveLogic,
    content: '',
    order: WB_NEW_ENTRY_DEFAULTS.order,
    constant: false,
    matchWholeWords: false,
    caseSensitive: false,
    probability: WB_NEW_ENTRY_DEFAULTS.probability,
    enabled: true
  };

  book.entries = [...(book.entries || []), entry];
  book.updatedAt = now();

  el.wb.entryCount.textContent = wbEntryCountText(book);
  renderEntryList();
  selectEntry(entry.id);

  el.wb.e.title.focus();
  el.wb.e.title.select();
}

async function saveEntry() {
  const entry = currentEntry();
  const book = currentWorldbook();
  if (!entry || !book) return;

  stashEntryForm();

  // 没关键词又不是常驻的条目永远不会触发，提醒一下（但不阻止保存）
  if (!entry.constant && !entry.keys.length) {
    showToast('这条既没有关键词、也不是常驻，永远不会被注入', 'error');
  }

  book.updatedAt = now();
  el.wb.entryCount.textContent = wbEntryCountText(book);
  renderEntryList();
  fillEntryForm(entry);

  await persistLibrary();
  showToast('条目已保存', 'ok');
}

async function deleteEntry() {
  const entry = currentEntry();
  const book = currentWorldbook();
  if (!entry || !book) return;

  stashEntryForm();

  const ok = await confirmDialog({
    title: '删除条目',
    message: `删除条目「${entry.title}」？`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  book.entries = (book.entries || []).filter((e) => e.id !== entry.id);
  book.updatedAt = now();

  editingEntryId = book.entries.length ? book.entries[0].id : null;
  el.wb.entryCount.textContent = wbEntryCountText(book);
  renderEntryList();
  fillEntryForm(currentEntry());

  await persistLibrary();
  showToast('条目已删除');
}

async function deleteWorldbook() {
  const book = currentWorldbook();
  if (!book) return;

  stashWorldbookName();

  const charCount = worldbookCharacters(book).length;
  const usedByConvo = state.conversations.filter((c) => convoWorldbookIds(c).includes(book.id)).length;
  const bits = [`${(book.entries || []).length} 条条目`];
  if (charCount) bits.push(`${charCount} 个角色副本`);
  const tail = usedByConvo ? `；它还在 ${usedByConvo} 个会话里生效，删掉后那些会话会失去它的设定` : '';

  const ok = await confirmDialog({
    title: '删除世界书',
    message: `删除「${book.name}」？这本书里的 ${bits.join('、')}会一起删掉${tail}。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  state.worldbooks = worldbooks().filter((w) => w.id !== book.id);

  // 会话上还绑着这本书的要一起摘掉，别留下指向空气的 id
  for (const convo of state.conversations) {
    const ids = convoWorldbookIds(convo);
    if (ids.includes(book.id)) {
      convo.worldbookIds = ids.filter((id) => id !== book.id);
      convo.updatedAt = now();
    }
  }

  // 角色编辑器可能正开在这本书的副本上，退回角色库
  releaseScope();

  editingWorldbookId = worldbooks().length ? worldbooks()[0].id : null;
  renderWorldbookPage();

  persistConversations(0);
  await persistLibrary();
  showToast('世界书已删除');
}

/**
 * 预览「正在编辑的这本书」会在当前会话里命中哪些条目。
 * 用的就是真实请求时的扫描逻辑，方便排查关键词写没写对。
 * 以前是预览「会话绑定的那些书」，绑定那套拿掉之后改成预览当前编辑的这本。
 */
async function previewWorldbook() {
  const book = currentWorldbook();
  if (!book) {
    showToast('先选一本书', 'error');
    return;
  }

  const convo = activeConvo();

  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  const history = convo.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );

  if (!history.length) {
    showToast('这个会话还没有消息，先聊两句再看预览', 'error');
    return;
  }

  try {
    const result = await api.previewWorldbook({
      worldbookIds: [book.id],
      scanDepth: WORLDBOOK_SCAN_DEPTH,
      recursiveDepth: recursiveDepthSetting(),
      messages: history.slice(-WORLDBOOK_SCAN_DEPTH).map((m) => ({ role: m.role, content: m.content }))
    });

    const hits = (result && result.hits) || [];
    if (!hits.length) {
      showToast(`扫了最近 ${result.scanDepth} 条消息，${result.total} 条条目一条都没命中`, 'error');
      return;
    }

    const names = hits.map((h) => h.title).join('、');
    // 递归带进来的单独说一声 —— 不然用户只会觉得「怎么突然多塞了这么多设定」
    const viaChain = Number(result && result.recursiveCount) || 0;
    const tail = viaChain ? `（其中 ${viaChain} 条是递归带进来的）` : '';
    showToast(`「${book.name}」命中 ${hits.length} 条：${names}${tail}`);
  } catch (err) {
    console.error('预览失败', err);
    showToast('预览失败', 'error');
  }
}

/** 导出当前编辑的世界书 */
async function exportWorldbook() {
  const book = currentWorldbook();
  if (!book) return;

  await saveExport({
    title: '导出世界书',
    fileName: `${safeFileName(book.name)}.json`,
    filters: [{ name: '世界书 JSON（酒馆可直接导入）', extensions: ['json'] }],
    text: JSON.stringify(worldbookPayload(book), null, 2)
  });
}
