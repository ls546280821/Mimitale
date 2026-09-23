// ============================================================================
//  renderer/js/data/library-reissue.js
//
//  导入进来的角色 / 世界书要重新发一批 id。
//
//  为什么必须重发：主进程是在同一毫秒里连着给一批文件生成 id 的
//  （newWorldbookId 只精确到毫秒），连导两张卡就可能撞上同一个 id。
//
//  ⚠️ 关键在「改写绑定」这一步，不写就是 bug：
//  主进程自动绑到角色上的 worldbookIds 用的是**它自己那批旧 id**。
//  只换世界书的 id 而不改写角色里的指向，绑定就会指到一个根本不存在的书，
//  表现是「卡导进来了、书也在库里、但聊起来就是不生效」——
//  全程不报错，只能靠人发现。
//
//  单独成模块是为了能测：以前这段写在 importCards() / importWorldbooks()
//  两个函数里各一份，而这两个函数夹在弹窗和落盘中间，
//  冒烟测试根本走不到（characters:import 在测试里是个桩）。
// ============================================================================

/**
 * 给一批导入结果重新发 id，并改写角色 → 世界书的指向。
 *
 * @param {object[]} books 主进程解析出来的世界书
 * @param {object[]} chars 主进程解析出来的角色
 * @param {string}   stamp 本次导入的时间戳（同一毫秒里的多次导入靠它区分）
 * @returns {{ books: object[], chars: object[] }}
 */
export function reissueImportedIds(books, chars, stamp) {
  const list = Array.isArray(books) ? books : [];
  const list2 = Array.isArray(chars) ? chars : [];
  const prefix = String(stamp || '');

  // 旧 id → 新 id。角色的 worldbookIds 靠这张表改写。
  const bookIdMap = new Map();

  const freshBooks = list.map((w, i) => {
    const book = { ...w, id: `w${prefix}-${i}` };
    if (w && typeof w.id === 'string') bookIdMap.set(w.id, book.id);
    // 书里的角色副本也一起换，免得两次导入撞上同一个 id
    if (Array.isArray(book.characters)) {
      book.characters = book.characters.map((c, j) => ({ ...c, id: `wc${prefix}-${i}-${j}` }));
    }
    return book;
  });

  const freshChars = list2.map((c, i) => {
    const character = { ...c, id: `c${prefix}-${i}` };
    if (Array.isArray(character.worldbookIds)) {
      character.worldbookIds = character.worldbookIds.map((id) =>
        bookIdMap.has(id) ? bookIdMap.get(id) : id
      );
    }
    return character;
  });

  return { books: freshBooks, chars: freshChars };
}
