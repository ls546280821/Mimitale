// ---------------------------------------------------------------------------
//  世界书列表页
//
//  世界书是「一个世界」：从这里点「游玩」进入，进去前先创建你自己的角色。
//  它不再是「给某个对话挂上去的设定」—— 绑到已经开始的对话上那套已经拿掉了。
//
//  这个文件只装**列表页本身**（卡片网格 + 两个按钮）。两处刻意的边界：
//
//   · 「点编辑 = 打开世界书编辑器」由入口层通过 initWorldbookList 注入。
//     那个动作要设 editingWorldbookId（编辑器弹窗的状态）并调
//     openWorldbooksModal（编辑器本体，还没拆），属于跨视图编排 ——
//     本模块若直接调，就得反过来 import 编辑器；入口层注入则两边都不用认识谁。
//
//   · 「点游玩 = 打开玩家角色弹窗」直接 import views/player.js。
//     这是**单向**依赖：player 只依赖 core 和 data 层、不认识任何视图
//     （它只是弹窗 + 一个 getPlayingBook），所以不构成循环。
//
//  重绘入口是 renderWorldbookPage()，由入口层的 refreshLibraryPage()
//  在「当前正停在世界书页」时调用（那个分发要读 currentView，属于入口层）。
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { button, card, renderListPage } from '../ui/build.js';
import { worldbooks, worldbookCharacters } from '../data/library.js';
import { openPlayerModal } from './player.js';

/** 打开世界书编辑器（入口层注入，见文件头说明） */
let openEditor = () => {};

export function initWorldbookList({ openEditor: fn } = {}) {
  if (typeof fn === 'function') openEditor = fn;
}

export function renderWorldbookPage() {
  const list = worldbooks();
  renderListPage({
    grid: el.wbPageGrid,
    empty: el.wbPageEmpty,
    sub: el.wbPageSub,
    subText: list.length
      ? `共 ${list.length} 个世界 · 点「游玩」进入，进去前先创建你自己的角色`
      : '导入酒馆的 lorebook，或自己写一个世界',
    items: list,
    card: worldbookCard
  });
}

/**
 * 一张世界书卡片：世界名 + 设定条数 / 角色数 + 编辑/游玩
 *
 * 这里**故意不做**角色卡那种悬停删除 `×`：
 * 一本书里可能攒了很多条目和角色副本，删掉找不回来，
 * 所以删除入口刻意留在编辑器里（「删除本书」）—— 得先点进去、看得见全书内容再删。
 * 角色卡可以快捷删，是因为单张角色卡的信息量小、重建成本低。
 */
function worldbookCard(book) {
  const charCount = worldbookCharacters(book).length;

  return card({
    title: book.name,
    sub: charCount ? `${book.entries.length} 条设定 · ${charCount} 个角色` : `${book.entries.length} 条设定`,
    avatarText: '世',
    avatarClass: 'worldbook-avatar',
    actions: [
      button({ class: 'btn btn-ghost btn-sm', text: '编辑', onClick: () => openEditor(book.id) }),
      button({ class: 'btn btn-primary btn-sm', text: '游玩', onClick: () => openPlayerModal(book.id) })
    ]
  });
}
