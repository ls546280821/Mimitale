'use strict';

// ============================================================================
//  ui/modalMax.js —— 把弹窗放大到整个应用窗口
//
//  四个编辑弹窗（角色卡 / 世界书 / 设置 / 预设）头上那颗按钮调它。
//
//  ⚠️ 注意这里的「放大」是**弹窗自己铺满窗口**，不是把窗口切成全屏
//  （那需要 BrowserWindow.setFullScreen，是另一回事，本项目没做）。
//  这么做是因为这几个编辑器字段多，小窗里写长文本只能来回滚。
//
//  实现上只做一件事：给**那个弹窗的 .modal 元素**挂 / 摘 `modal-max`，
//  剩下的交给 style.css —— 那边把卡片撑到 100%×100%、去掉圆角和描边。
//  状态挂在各自的弹窗上，所以：① 四个弹窗各记各的；② 弹窗 A 放大不影响 B。
// ============================================================================

const MAX_CLASS = 'modal-max';

/** 按钮 → 所属弹窗。按钮都在 .modal-head 里，closest 一层就够。 */
function modalOf(btn) {
  return btn && btn.closest ? btn.closest('.modal') : null;
}

/** 把放大状态「画」到弹窗和它头上那颗按钮上（图标、标题、aria）。 */
function paint(modal, on) {
  modal.classList.toggle(MAX_CLASS, on);
  modal.querySelectorAll('.fs-btn').forEach((btn) => {
    // 图标是 expand / restore 两张 SVG 二选一，靠 CSS 换（见 style.css 的 .fs-btn 段）。
    // 这里只负责把状态讲清楚 —— 标题和 aria 得跟着走，
    // 不然读屏用户听到的永远是「放大到窗口」，而眼前已经是还原图标了。
    const label = on ? '还原窗口大小' : '放大到窗口大小';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  });
}

/** 切一次。按钮传进来就行（调用方从 el 上拿）。 */
export function toggleModalMax(btn) {
  const modal = modalOf(btn);
  if (!modal) return;
  paint(modal, !modal.classList.contains(MAX_CLASS));
}

/**
 * 弹窗被关掉时把放大状态摘掉，下次打开回到正常大小。
 *
 * 为什么不直接在「关闭」那些地方逐个加一行：这四个弹窗的关闭路径相当散
 * （各自的 × 按钮、Esc、点遮罩、保存后自动关、还有相互顶替时被动关），
 * 全仓库十几处 `classList.add('hidden')`，漏一处就会出现「关之前放大了，
 * 再打开还是放大的」这种莫名其妙的记忆。这里用 MutationObserver 盯着
 * `hidden` 这一个信号，是唯一不用改十几处的地方。
 *
 * ⚠️ 只能认**「变成 hidden」这一下**，不能写成「只要 hidden 就清」——
 * 弹窗平时本来就带着 hidden，光按现状判断的话，往一个没打开的弹窗上加
 * modal-max（比如下面那条「各弹窗互不影响」的断言就是这么干的）会被立刻抹掉。
 * 所以这里记一份上一次的状态，只在 true 的跳变上动手。
 */
export function initModalMax() {
  const modals = document.querySelectorAll('.modal');
  if (!modals.length || typeof MutationObserver !== 'function') return;

  const wasHidden = new WeakMap();

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      const target = record.target;
      const nowHidden = target.classList.contains('hidden');
      const before = wasHidden.get(target);
      wasHidden.set(target, nowHidden);

      if (nowHidden && before === false && target.classList.contains(MAX_CLASS)) {
        paint(target, false);
      }
    });
  });

  modals.forEach((modal) => {
    wasHidden.set(modal, modal.classList.contains('hidden'));
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
}
