// ---------------------------------------------------------------------------
//  世界书编辑器（World Info / Lorebook）
//
//  左栏选书，中栏列条目，右栏编辑。数据在主进程的 worldbooks.json。
//  词条只由「会话绑定了哪本书」生效；每本书还能装若干角色副本（独立个体）。
//
//  「保存后才生效」：书名 / 开场白 / 条目全是**草稿**（wbDrafts，按书各存一份），
//  改动只进内存里的那一份，点底部「保存」才写回 state.worldbooks 并落盘。
//  没保存就关弹窗要问一句「放弃改动？」。角色副本不在此列 ——
//  见 wbDrafts 上面那段注释。
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
//  「删除某一本」（deleteWorldbookById）同理：列表页卡片右上角的 × 也走它。
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
import { seedWorldbookCharactersIntoConvos, syncCopyAttrsFromSource } from '../data/panel.js';
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
import { renderAll } from './redraw.js';

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
// 打开「AI 生成 NPC」弹窗（视图不向上 import 入口层，编排放注入里）
let aiDraftInBook = () => {};

export function initWorldbook(opts = {}) {
  if (typeof opts.openInBook === 'function') openInBook = opts.openInBook;
  if (typeof opts.draftInBook === 'function') draftInBook = opts.draftInBook;
  if (typeof opts.releaseScope === 'function') releaseScope = opts.releaseScope;
  if (typeof opts.stashDraft === 'function') stashDraft = opts.stashDraft;
  if (typeof opts.importBooks === 'function') importBooks = opts.importBooks;
  if (typeof opts.aiDraftInBook === 'function') aiDraftInBook = opts.aiDraftInBook;

  // --- 编辑器本体 ---
  el.wb.btnExport.addEventListener('click', exportWorldbook);
  el.wb.btnClose.addEventListener('click', closeWorldbooksModal);
  el.wb.btnClose2.addEventListener('click', closeWorldbooksModal);
  el.wb.btnImport.addEventListener('click', importBooks);
  el.wb.btnNew.addEventListener('click', newWorldbook);
  el.wb.btnNewEntry.addEventListener('click', newEntry);
  el.wb.btnDelBook.addEventListener('click', deleteWorldbook);
  el.wb.btnDelEntry.addEventListener('click', deleteEntry);
  el.wb.btnSave.addEventListener('click', saveWorldbook);
  el.wb.btnPreview.addEventListener('click', previewWorldbook);
  el.wb.btnAddChars.addEventListener('click', openWorldbookCharPicker);
  el.wb.btnNewChar.addEventListener('click', newWorldbookCharacter);
  // 「AI 生成」→ 按这本书的设定生成一个 NPC 副本。生成结果一样落到角色编辑器
  // 草稿里（和「＋ 新建」同一条路），看过再保存。
  if (el.wb.btnAiChar) {
    el.wb.btnAiChar.addEventListener('click', () => {
      const book = currentWorldbook();
      if (!book) return;
      aiDraftInBook(book.id);
    });
  }
  if (el.wb.btnSyncAttrs) el.wb.btnSyncAttrs.addEventListener('click', syncWorldbookCharAttrs);

  // 从角色库多选加入
  el.wbPicker.btnClose.addEventListener('click', closeWorldbookCharPicker);
  el.wbPicker.btnCancel.addEventListener('click', closeWorldbookCharPicker);
  el.wbPicker.btnConfirm.addEventListener('click', confirmWorldbookCharPicker);
  el.wbPicker.modal.addEventListener('click', (event) => {
    if (event.target === el.wbPicker.modal) closeWorldbookCharPicker();
  });

  // 书名 / 开场白 / 条目全是**草稿**：边打字边留在内存里的草稿里，
  // 点「保存」才写回世界书并落盘（见文件头）。所以这里只写草稿 + 举「未保存」的旗子，
  // 不再顺手重画列表页 —— 没保存的东西不该在外面的卡片上露头。
  el.wb.name.addEventListener('input', () => {
    if (!currentDraft()) return;
    stashWorldbookName();
    markDraftDirty();
  });

  el.wb.opening.addEventListener('input', () => {
    const draft = currentDraft();
    if (!draft) return;
    draft.opening = el.wb.opening.value.slice(0, 4000);
    markDraftDirty();
  });

  // 条目表单里的任何一下改动都算「这本书有未保存的改动」。
  // 回填（fillEntryForm）是程序写 .value，不触发事件 —— 所以不会误标。
  // input 管文本 / 数字 / 文本域，change 管下拉和几个勾选框。
  el.wb.form.addEventListener('input', markDraftDirty);
  el.wb.form.addEventListener('change', markDraftDirty);

  // 条目名 / 关键词跟着左栏那一行实时走。以前这一步是「保存条目」那颗按钮干的，
  // 现在没有它了 —— 不同步的话，新建的条目会一直叫「新条目」，
  // 直到整本书保存才改过来，看着像名字没生效。
  el.wb.e.title.addEventListener('input', () => {
    const entry = currentEntry();
    if (!entry) return;
    entry.title = el.wb.e.title.value.trim().slice(0, 200) || '未命名条目';
    renderEntryList();
  });

  el.wb.e.keys.addEventListener('input', () => {
    const entry = currentEntry();
    if (!entry) return;
    entry.keys = parseEntryKeys(el.wb.e.keys.value);
    renderEntryList();
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

/**
 * 编辑器里的草稿：bookId → { name, opening, entries, dirty, isNew }。
 *
 * 「保存后才生效」就落在这儿。书名 / 开场白 / 条目的改动一律先写进草稿，
 * 界面上（列表页卡片、会话注入用的 state.worldbooks）看到的还是**上次保存过**的那份；
 * 点「保存」才 commitDraft() 写回 state.worldbooks 并落盘。
 *
 * 三处刻意的选择：
 *   · **每本书各留一份**（不是一个全局草稿）—— 在两本书之间来回切不会把没保存的改动弄丢，
 *     也不用在切换的半路上弹一个「要保存吗」。
 *   · **不含 characters**。世界书里的角色副本由「本书角色」那一排按钮直接改、直接落盘，
 *     角色编辑器也在往上写（它认的是 currentWorldbook()）。草稿只认书名/开场白/条目，
 *     提交时也只覆盖这三个字段，两边才不会互相踩。
 *   · `isNew`：新建出来还没保存过的书。关弹窗时要是被放弃，连壳一起收掉
 *     （它从来没进过 worldbooks.json，留着就是一个重启就没的幽灵）。
 */
const wbDrafts = new Map();

/** 条目的深拷贝：草稿改了不能顺手改到 state 里那份 */
function cloneEntries(entries) {
  return JSON.parse(JSON.stringify(Array.isArray(entries) ? entries : []));
}

function draftFor(book) {
  if (!book) return null;
  let draft = wbDrafts.get(book.id);
  if (!draft) {
    draft = {
      name: book.name || '未命名世界书',
      opening: book.opening || '',
      entries: cloneEntries(book.entries),
      dirty: false,
      isNew: false
    };
    wbDrafts.set(book.id, draft);
  }
  return draft;
}

/** 编辑器里正在显示的那一本的草稿 */
function currentDraft() {
  return currentWorldbook() ? draftFor(currentWorldbook()) : null;
}

/** 有未保存改动的那些书（关弹窗时用它拼提示语） */
function unsavedDrafts() {
  const out = [];
  for (const [id, draft] of wbDrafts) {
    const book = worldbookById(id);
    if (book && draft.dirty) out.push({ book, draft });
  }
  return out;
}

/** 举旗子：这本书有未保存的改动 */
function markDraftDirty() {
  const draft = currentDraft();
  if (!draft) return;
  if (!draft.dirty) draft.dirty = true;
  renderDirtyHint();
}

/**
 * 底部的「有未保存的改动」提示。
 * 只显示当前这本的状态 + 顺带说一句别的书还欠着几本 ——
 * 把别的书的改动说成本书的，会让人以为点了「保存」就全存了。
 */
function renderDirtyHint() {
  const node = el.wb.dirtyHint;
  if (!node) return;

  const mine = currentDraft();
  const all = unsavedDrafts().length;
  const others = all - (mine && mine.dirty ? 1 : 0);

  let text = '';
  if (mine && mine.dirty) text = others ? `有未保存的改动（另有 ${others} 本）` : '有未保存的改动';
  else if (others) text = `另有 ${others} 本有未保存的改动`;

  node.textContent = text;
  node.classList.toggle('hidden', !text);
}

/** 草稿写回世界书（点「保存」时用）。返回是否真的提交了 */
function commitDraft(bookId) {
  const book = worldbookById(bookId);
  const draft = wbDrafts.get(bookId);
  if (!book || !draft) return false;

  book.name = String(draft.name || '').trim().slice(0, 120) || '未命名世界书';
  book.opening = String(draft.opening || '').slice(0, 4000);
  book.entries = cloneEntries(draft.entries);
  book.updatedAt = now();

  // 草稿作废：下次进这本书会按刚保存的内容重新拷一份
  wbDrafts.delete(bookId);
  return true;
}

/**
 * 丢掉所有草稿（关弹窗时「放弃改动」那一步）。
 * 新建但没保存过的书连壳一起收掉 —— 它还不算存在。
 */
function discardDrafts() {
  for (const [id, draft] of [...wbDrafts]) {
    if (draft.isNew) {
      state.worldbooks = worldbooks().filter((w) => w.id !== id);
      // 编辑器里正显示着这本，而它现在不存在了 —— 选中项一起清掉，
      // 免得下次打开时拿着一个指向空气的 id 去查
      if (editingWorldbookId === id) editingWorldbookId = null;
    }
    wbDrafts.delete(id);
  }
}

/**
 * 把「正在编辑的这本书」保存到磁盘。
 *
 * 保存的粒度是**整本书**（书名 + 开场白 + 所有条目）—— 条目不是独立对象，
 * 拆成「保存条目」只会让人以为存过了其实没存。所以界面上只有一个「保存」。
 */
async function saveWorldbook() {
  const book = currentWorldbook();
  const draft = currentDraft();
  if (!book || !draft) return;

  // 输入框里的内容可能还没进草稿（比如刚敲完就点保存）
  stashWorldbookName();
  stashEntryForm();

  if (!draft.dirty) {
    showToast('没有要保存的改动');
    return;
  }

  // 既没关键词也不是常驻的条目永远不会被注入，提醒一下（但不阻止保存）。
  // 提醒并进保存结果那一条 toast 里 —— 弹两条只有后一条看得见。
  const dead = draft.entries.filter((e) => !e.constant && !(Array.isArray(e.keys) && e.keys.length));

  const name = draft.name;
  commitDraft(book.id);

  // 保存之后才是「真的改了」：列表页卡片、条目数、会话注入用的数据都在这一刻对齐
  renderWorldbookPage();
  renderWorldbookChars();
  renderDirtyHint();

  // 失败提示由 persistLibrary 弹（「世界书没能写进磁盘…」）——
  // 这里再弹一条会把那条更具体的盖掉。
  if (!(await persistLibrary())) return;
  const tail = dead.length ? ` · ${dead.length} 条没有关键词也不是常驻，永远不会被注入` : '';
  showToast(`「${name}」已保存${tail}`, 'ok');
}

/** 世界书的条目数展示 */
function wbEntryCountText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const on = list.filter((e) => e.enabled !== false).length;
  return on === total ? `${total} 条条目` : `${total} 条条目 · ${on} 条启用`;
}

export function currentWorldbook() {
  return worldbookById(editingWorldbookId);
}

function currentEntry() {
  const draft = currentDraft();
  if (!draft) return null;
  return draft.entries.find((e) => e.id === editingEntryId) || null;
}

/** 把世界书表单里的内容写进草稿（书名 + 开场白）。不落盘，只改内存里的那一份 */
function stashWorldbookName() {
  const draft = currentDraft();
  if (!draft || el.wb.entriesWrap.classList.contains('hidden')) return;
  draft.name = (el.wb.name.value.trim() || '未命名世界书').slice(0, 120);
  draft.opening = el.wb.opening.value.slice(0, 4000);
}

/** 关键词输入框 → 关键词数组（逗号分隔，中英文逗号都认） */
function parseEntryKeys(value) {
  return String(value || '')
    .split(/[,，]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** 把条目表单里的内容写进草稿里的那条条目 */
function stashEntryForm() {
  const entry = currentEntry();
  if (!entry || el.wb.form.classList.contains('hidden')) return;

  entry.title = el.wb.e.title.value.trim().slice(0, 200) || parseEntryKeys(el.wb.e.keys.value)[0] || '未命名条目';
  entry.keys = parseEntryKeys(el.wb.e.keys.value);
  entry.secondaryKeys = parseEntryKeys(el.wb.e.keys2.value);
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

/** 把「编辑器里正在填的东西」先写进草稿 —— 导入 / 切书 / 打开角色编辑器之前要调 */
export function stashWorldbookForm() {
  stashWorldbookName();
  stashEntryForm();
}

function renderEntryList() {
  el.wb.entryList.innerHTML = '';

  const draft = currentDraft();
  if (!draft) return;

  const entries = draft.entries;
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

/**
 * 把编辑焦点安全地切到某一本。
 *
 * 外面要用这个，**不要自己去动 editingWorldbookId** —— 切换前必须让
 * selectWorldbook 先把界面上的表单 stash 回原来那一本（理由见 selectWorldbook 上面）。
 * AI 生成角色那条路要它：弹窗开着的时候用户可能已经换了书，生成完得切回原来那本，
 * 新副本才落对地方。
 *
 * @returns {boolean} 有没有切过去（书不存在就是 false）
 */
export function focusWorldbook(id) {
  if (!worldbookById(id)) return false;
  selectWorldbook(id);
  return true;
}

/**
 * 选中一本世界书。
 *
 * ⚠️ 这是**唯一**改 editingWorldbookId 的地方，而且改之前必须先 stash ——
 * 那两个 stash 读的是界面上的输入框，只有此时 currentWorldbook() 还指着
 * 「正在显示的那一本」才写得对。外部（openWorldbooksModal 的调用方）
 * 千万别抢先把 editingWorldbookId 设成目标书，否则脏表单会盖到新书上。
 *
 * 现在 stash 写的是**草稿**（不是世界书本身），所以「盖到新书上」这件事
 * 从结构上就不成立了 —— 每本书的草稿各归各的。
 */
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
    renderDirtyHint();
    return;
  }

  // 有草稿就显示草稿（切走再切回来不会丢没保存的改动），没有就按当前内容新拷一份
  const draft = draftFor(book);
  el.wb.name.value = draft.name;
  el.wb.opening.value = draft.opening;
  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  // 底部提示写的是**落盘过的**书名：一眼分得清「界面上在改什么」和「盘上是什么」
  el.wb.footHint.textContent = `「${book.name}」只保存在你自己电脑上`;

  // 上一本书选中的条目在新书里不存在，自动落到第一条
  if (!currentEntry()) {
    editingEntryId = draft.entries.length ? draft.entries[0].id : null;
  }

  renderEntryList();
  fillEntryForm(currentEntry());
  renderWorldbookChars();
  renderDirtyHint();
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
        // 「显示状态」：勾上之后这个副本的状态会出现在右栏「在场角色」入口条上。
        // 不做成按钮是因为它是个**每本书各自一份**的持久开关，勾选状态要一眼看见。
        h(
          'label',
          { class: 'wb-char-chip-show', title: '把这个副本的状态显示在右栏「在场角色」入口条上' },
          (() => {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = c.showInPanel === true;
            cb.addEventListener('change', () => toggleWorldbookCharShowInPanel(c.id, cb.checked));
            return cb;
          })(),
          h('span', { text: '显示状态' })
        ),
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
  const copies = [];
  for (const src of picked) {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newWorldbookCharId();
    copy.createdAt = now();
    copy.updatedAt = now();
    book.characters.push(copy);
    copies.push(copy);
  }
  book.updatedAt = now();

  renderWorldbookChars();
  renderWorldbookPage();

  const ok = await persistLibrary();
  showToast(ok ? `已加入 ${picked.length} 个角色副本` : '加入失败，没能写入磁盘', ok ? 'ok' : 'error');

  // 正在玩这本书的会话：把新角色的属性也种进它们的状态面板，立刻就能点开看。
  // 加入副本本身只动了世界书（persistLibrary），不回头通知会话 —— 这里补上，
  // 否则「进世界之后再往书里加角色」会看不到新 NPC 的状态。
  if (ok) {
    const seeded = seedWorldbookCharactersIntoConvos(state.conversations, book, copies);
    if (seeded) {
      persistConversations(0);
      if (activeConvo() && convoWorldbookIds(activeConvo()).includes(book.id)) {
        renderAll();
      }
    }
  }
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

/**
 * 把角色库同名卡的属性补进本书副本。副本是快照，角色库后来补的属性不会回流，
 * 所以需要这一步。只按名字匹配（副本 id 另发）、只补副本没有的字段，已有值不覆盖；
 * 只补属性，不动 description / personality 等其它字段。
 */
async function syncWorldbookCharAttrs() {
  const book = currentWorldbook();
  if (!book) return;

  const copies = worldbookCharacters(book);
  if (!copies.length) {
    showToast('这本书里还没有角色副本', 'error');
    return;
  }

  const { touched, added, missing } = syncCopyAttrsFromSource(copies, characters());
  if (!touched) {
    const why = missing.length
      ? `这些副本在角色库里没有同名卡：${missing.join('、')}`
      : '所有副本的属性都已经是最新的了';
    showToast(why, 'error');
    return;
  }

  book.updatedAt = now();
  const saved = await persistLibrary();
  renderWorldbookChars();
  renderWorldbookPage();

  if (saved) {
    // 正在玩这本书的会话：把补上的属性也种进面板，头像 / 状态卡立刻可见。
    // 属性是「新副本才有」还是「老副本补的」对种子层没区别 —— 按 owner 去重。
    const seeded = seedWorldbookCharactersIntoConvos(state.conversations, book, copies);
    if (seeded) {
      persistConversations(0);
      if (activeConvo() && convoWorldbookIds(activeConvo()).includes(book.id)) {
        renderAll();
      }
    }
    showToast(`已补 ${added} 个属性到 ${touched} 个副本`, 'ok');
  } else {
    showToast('补属性失败，没能写入磁盘', 'error');
  }
}

/**
 * 切换某个副本「在状态栏显示」。
 *
 * `showInPanel` 存在**这本世界书里的副本**上（不是角色库那张卡）—— 同一个角色
 * 放进不同的书，可以这本书显示、那本书不显示。改完立刻重绘当前会话：
 * 勾上的人头像马上出现在「当前状态」入口条上（属性早就种在面板里了，只是原先
 * 被 panelEntities 过滤掉），取消则立刻收掉。
 */
async function toggleWorldbookCharShowInPanel(id, on) {
  const book = currentWorldbook();
  if (!book) return;

  const target = worldbookCharacters(book).find((c) => c.id === id);
  if (!target) return;

  target.showInPanel = on === true;
  target.updatedAt = now();
  book.updatedAt = now();

  await persistLibrary();
  // 「当前状态」入口条是按当前会话的面板画的 —— 正在玩这本书就得重绘一次，
  // 头像才会立刻增删。别的会话不动。
  if (activeConvo() && convoWorldbookIds(activeConvo()).includes(book.id)) {
    renderAll();
  }
  showToast(on ? `「${target.name}」的状态会显示了` : `「${target.name}」的状态已隐藏`, 'ok');
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
 * 目标那一本**必须由 openWorldbooksModal 去切**（见那里的注释）：
 * 调用方如果自己先写 editingWorldbookId，就会把界面上残留的旧表单盖到新书上。
 */
export function editWorldbookFromPage(id) {
  if (!worldbookById(id)) return;
  openWorldbooksModal(id);
}

/** 打开编辑器并切到指定的一本（导入完成、外部要跳转时用） */
export function openWorldbookEditor(id) {
  if (!worldbookById(id)) return;
  renderWorldbookPage();
  openWorldbooksModal(id);
}

/**
 * 打开编辑器，可选地切到某一本（不传就沿用当前选中的 / 第一本）。
 *
 * ⚠️ 这里**只传目标 id，不先改 editingWorldbookId** —— 顺序是这套东西的全部要点：
 * selectWorldbook 一上来会把「界面上正在显示的表单」写回 currentWorldbook()，
 * 也就是**还没切走的那一本**。要是调用方抢先把 editingWorldbookId 换成新书，
 * 那次回写就落在新书头上，输入框里残留的旧书名会被写进新书、界面也仍然显示旧名字。
 * 用户看到的就是「导入世界书后，书名还是上一本的名字」；
 * 点另一张卡的「编辑」也一样会改名（那本真的会被存成上一本的名字，是丢数据）。
 */
function openWorldbooksModal(targetId) {
  // 角色库可能没开着（侧边栏可以直接进世界书），stashCharForm 内部会自己判断
  stashDraft();

  const wanted = typeof targetId === 'string' && targetId ? targetId : editingWorldbookId;
  const next = worldbookById(wanted) ? wanted : worldbooks().length ? worldbooks()[0].id : null;

  selectWorldbook(next);
  renderWorldbookChars();

  el.wb.modal.classList.remove('hidden');
}

/**
 * 关世界书编辑器。导出是为了让入口层的 Esc 链统一关它（见 main.js）。
 *
 * 「保存后才生效」的另一面是「不保存就会丢」，所以有草稿改动时先问一句。
 * 选「继续改」就直接返回，弹窗留着 —— 和角色编辑器放弃新建那个确认框同一个套路。
 */
export async function closeWorldbooksModal() {
  stashWorldbookName();
  stashEntryForm();

  const pending = unsavedDrafts();
  if (pending.length) {
    const names = pending.map(({ draft, book }) => `「${draft.name || book.name}」`).slice(0, 3).join('、');
    const tail = pending.length > 3 ? ` 等 ${pending.length} 本` : '';
    const ok = await confirmDialog({
      title: '放弃未保存的改动',
      message: `${names}${tail}有没保存的改动，关掉就丢了。`,
      confirmText: '放弃改动',
      danger: true
    });
    if (!ok) return;
  }

  // 放弃：草稿清掉，新建但没保存过的书连壳一起收掉
  discardDrafts();

  el.wb.modal.classList.add('hidden');
  renderWorldbookChars();
  renderDirtyHint();
  // 列表页可能还开着（编辑完回来看得到最新状态）。放掉草稿之后要重画一次 ——
  // 没保存的东西不该留在卡片上（本来也没露过头，这里是给「新建又放弃」收尾）。
  renderWorldbookPage();
}

/** 新建一本世界书，并直接进编辑器 */
function newWorldbook() {
  const book = {
    id: `w${uid()}`,
    name: '新世界书',
    entries: [],
    characters: [],
    createdAt: now(),
    updatedAt: now()
  };

  state.worldbooks = [...worldbooks(), book];

  // 新建的这本还没落盘，所以草稿从出生起就是脏的：点「保存」才真的写进
  // worldbooks.json；直接关掉的话它会被当成「没建成」收回去（见 discardDrafts）。
  const draft = draftFor(book);
  draft.isNew = true;
  draft.dirty = true;

  // 切到新书这一步交给 openWorldbooksModal —— 它会先把旧书的表单收进旧书的草稿再切。
  // 自己在这里先写 editingWorldbookId 的话，旧书残留的书名会被写进这本新书里。
  openWorldbooksModal(book.id);
  el.wb.name.focus();
  el.wb.name.select();
}

function newEntry() {
  const draft = currentDraft();
  if (!draft) return;

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

  draft.entries = [...draft.entries, entry];
  markDraftDirty();

  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  selectEntry(entry.id);

  el.wb.e.title.focus();
  el.wb.e.title.select();
}

async function deleteEntry() {
  const entry = currentEntry();
  const draft = currentDraft();
  if (!entry || !draft) return;

  stashEntryForm();

  const ok = await confirmDialog({
    title: '删除条目',
    message: `删除条目「${entry.title}」？`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  draft.entries = draft.entries.filter((e) => e.id !== entry.id);
  markDraftDirty();

  editingEntryId = draft.entries.length ? draft.entries[0].id : null;
  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  fillEntryForm(currentEntry());

  showToast('条目已删除，点「保存」才会写进磁盘');
}

/**
 * 删掉一本书。两个入口共用这一份逻辑：编辑器里的「删除本书」，
 * 和列表页卡片右上角那个 ×（跟角色卡一样，悬停浮出来）。
 * 返回是否真的删了。
 */
export async function deleteWorldbookById(id) {
  const book = worldbookById(id);
  if (!book) return false;

  // 表单里正在填的东西先收进草稿 —— 确认框弹出来这一下 currentWorldbook()
  // 还指着这本，写进去才有地方落（确认之后整本连同草稿一起没了，不会留下脏数据）。
  if (editingWorldbookId === book.id) {
    stashWorldbookName();
    stashEntryForm();
  }

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
  if (!ok) return false;

  // 改之前的样子，写盘失败时按这几样退回去（理由同 characterEditor 的 deleteCharacterById）
  const beforeBooks = worldbooks();
  const unbound = [];

  state.worldbooks = beforeBooks.filter((w) => w.id !== book.id);

  // 会话上还绑着这本书的要一起摘掉，别留下指向空气的 id
  for (const convo of state.conversations) {
    const ids = convoWorldbookIds(convo);
    if (ids.includes(book.id)) {
      convo.worldbookIds = ids.filter((wid) => wid !== book.id);
      convo.updatedAt = now();
      unbound.push([convo, ids]);
    }
  }

  // 角色编辑器可能正开在这本书的副本上，退回角色库
  releaseScope();

  // ⚠️ 编辑器里正显示着这本时必须走 selectWorldbook 真正「切」到另一本 ——
  // 它会重填书名 / 开场白 / 条目表单。以前这里只改 editingWorldbookId 再重画列表页，
  // 编辑区里还留着**刚删掉那本**的字段；接着关弹窗时 stashWorldbookName() 会把这个
  // 残留书名写进 currentWorldbook() —— 也就是列表里第一本书 —— 等于把别人的书改名 +
  // 覆盖开场白。（现在草稿是按书存的，这一步仍然要有：不切的话界面显示的就是不存在的那本。）
  if (editingWorldbookId === book.id) {
    selectWorldbook(worldbooks().length ? worldbooks()[0].id : null);
  }

  renderWorldbookPage();
  renderDirtyHint();

  if (!(await persistLibrary())) {
    // 写盘失败（看到 toast 了）→ 把内存也退回去：书还在列表里、会话绑定也恢复，
    // 界面和磁盘一致，用户能直接再删一次。草稿故意留到最后才删，就是为了这一下。
    state.worldbooks = beforeBooks;
    for (const [convo, ids] of unbound) convo.worldbookIds = ids;
    if (editingWorldbookId !== book.id) selectWorldbook(book.id);
    renderWorldbookPage();
    renderDirtyHint();
    return false;
  }

  // 真的写进磁盘了，草稿才可以丢
  wbDrafts.delete(book.id);

  persistConversations(0);
  showToast('世界书已删除');
  return true;
}

/** 编辑器底部那个「删除本书」：删的就是当前正在编辑的这本 */
async function deleteWorldbook() {
  await deleteWorldbookById(editingWorldbookId);
}

/**
 * 预览「正在编辑的这本书」会在当前会话里命中哪些条目。
 * 用的就是真实请求时的扫描逻辑，方便排查关键词写没写对。
 *
 * ⚠️ 预览跑在**主进程**里，读的是已经落盘的那份数据 —— 所以有没保存的改动时
 * 得先说一声，不然会拿着旧内容预览，看着像关键词没写对。
 */
async function previewWorldbook() {
  const book = currentWorldbook();
  if (!book) {
    showToast('先选一本书', 'error');
    return;
  }

  const draft = currentDraft();
  if (draft && draft.dirty) {
    showToast('有未保存的改动，先点「保存」再预览命中', 'error');
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

/** 导出当前编辑的世界书（导出的是界面上这份草稿，不是盘上那份） */
async function exportWorldbook() {
  const book = currentWorldbook();
  const draft = currentDraft();
  if (!book || !draft) return;

  stashWorldbookName();
  stashEntryForm();

  await saveExport({
    title: '导出世界书',
    fileName: `${safeFileName(draft.name)}.json`,
    filters: [{ name: '世界书 JSON（酒馆可直接导入）', extensions: ['json'] }],
    text: JSON.stringify(worldbookPayload({ ...book, name: draft.name, entries: draft.entries }), null, 2)
  });
}
