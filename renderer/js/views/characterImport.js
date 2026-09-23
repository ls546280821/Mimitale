'use strict';

// ============================================================================
//  views/characterImport.js —— 「导入角色卡」这条通道
//
//  角色卡和世界书共用同一个文件框（主进程的 api.importCard 负责挑文件、解析、
//  把 PNG 里嵌的 chara 数据读出来）。两个入口只有三处不同：点的是哪个按钮、
//  忙时写什么字、导进来之后往哪儿落 —— 所以中间那一段（含「出错 / 取消 /
//  没内容」的兜底）只留这一份实现（pickImportFiles）。
//
//  「导入世界书」留在入口层：它要同时动角色库、世界书列表页、角色列表页 ——
//  属于跨视图编排，所以那边的函数从这里取 pickImportFiles / warnImportErrors。
//
//  导入进来的东西要**重新发一批 id**（并改写角色 → 世界书的指向），
//  见 data/library-reissue.js —— 那段逻辑以前在两个导入函数里各有一份，
//  而且夹在弹窗和落盘之间，测不到；「绑定指到不存在的书」这个 bug 就是这么漏掉的。
//
//  「导完直接打开第一个角色」要开角色编辑器弹窗，那个动作用注入拿 ——
//  视图不向上 import 入口层。
// ============================================================================

import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbooks } from '../data/library.js';
import { persistCharacters } from '../data/persist.js';
import { reissueImportedIds } from '../data/library-reissue.js';
import { renderCharacterPage } from './characterList.js';

// 导入时重发 id 用的自增序号：同一毫秒里连导几次也不会撞车
let importSeq = 0;

// 入口层注入的动作
let actions = { openEditor: () => {} };

/** 重发一批 id（见 data/library-reissue.js） */
function reissueImported(books, chars) {
  importSeq += 1;
  return reissueImportedIds(books, chars, `${Date.now().toString(36)}-${importSeq}`);
}

/**
 * 「导入角色卡」和「导入世界书」共用的前半程：弹文件框 → 解析 → 重发一批 id。
 *
 * 两个入口只有三处不同 —— 点的是哪个按钮、忙时写什么字、以及导进来之后往哪儿落 ——
 * 所以那三处交给参数和调用方，中间这一段（含「出错 / 取消 / 没内容」的兜底）
 * 只留这一份实现。以前是两份几乎逐行重复的代码，还各自跑偏过一次：
 * 只有角色卡那边会在忙时改按钮文字。
 *
 * @returns {Promise<{freshBooks: object[], freshChars: object[], errors: string[]}|null>}
 *          null = 用户取消 / 出错 / 文件里什么都没有，调用方直接 return 即可。
 */
export async function pickImportFiles({ before, button, busyText, idleText } = {}) {
  if (before) before();

  let result = null;
  try {
    if (button) {
      button.disabled = true;
      if (busyText) button.textContent = busyText;
    }
    result = await api.importCard();
  } catch (err) {
    showToast((err && err.message) || '导入失败', 'error');
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      if (idleText) button.textContent = idleText;
    }
  }

  if (!result || result.canceled) return null;

  const added = Array.isArray(result.characters) ? result.characters : [];
  const addedBooks = Array.isArray(result.worldbooks) ? result.worldbooks : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  if (!added.length && !addedBooks.length) {
    showToast(errors.length ? errors[0] : '没有导入任何内容', 'error');
    return null;
  }

  // 重新发一批 id（并把角色→世界书的指向一起改写，见 data/library-reissue.js）
  const { books: freshBooks, chars: freshChars } = reissueImported(addedBooks, added);
  return { freshBooks, freshChars, errors };
}

/** 个别文件导入失败：主提示之后隔一会儿再补一条，不然会被前一条盖掉 */
export function warnImportErrors(errors) {
  if (!errors.length) return;
  console.warn('部分内容导入失败：', errors);
  setTimeout(
    () => showToast(`${errors.length} 个文件没能导入：${errors[0]}`, 'error'),
    CONFIG.TOAST_DURATION_MS + 300
  );
}

async function importCards() {
  const picked = await pickImportFiles({
    before: () => actions.stashForm(),
    button: el.btnImportCard,
    busyText: '导入中…',
    idleText: '导入角色卡',
  });
  if (!picked) return;

  const { freshBooks, freshChars, errors } = picked;

  state.worldbooks = [...worldbooks(), ...freshBooks];
  state.characters = [...characters(), ...freshChars];

  renderCharacterPage();
  // 直接打开刚导入的第一个角色，方便马上核对设定对不对
  if (freshChars.length) actions.openEditor(freshChars[0].id);
  await persistCharacters();

  const parts = [];
  if (freshChars.length) parts.push(`${freshChars.length} 个角色：${freshChars.map((c) => c.name).join('、')}`);
  if (freshBooks.length) parts.push(`${freshBooks.length} 个世界书`);
  showToast(`已导入 ${parts.join('，')}`, 'ok');

  warnImportErrors(errors);
}

/**
 * 绑「导入角色卡」按钮。
 * 注入：openEditor —— 导入完成后打开第一个新角色（那是角色编辑器的事）；
 *       stashForm  —— 导入前先把编辑器里填到一半的内容收进内存。
 */
export function initCharacterImport(injected) {
  actions = { openEditor: () => {}, stashForm: () => {}, ...(injected || {}) };

  el.btnImportCard.addEventListener('click', importCards);
}
