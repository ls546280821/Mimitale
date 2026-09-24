'use strict';

// ============================================================================
//  ui/auto-grow.js —— 文本框自动长高 + 拖拽高度记忆
//
//  给「填内容有时很多」的文本框用（角色描述 / 性格 / 场景 / 开场白 / 示例对话）。
//  目的是把两件事一起解决：
//    · 内容多的时候框太矮，只能看到一小截 → 输入时自动长高
//    · 内容少的时候框占地方，一屏放不下几项 → 自动缩回去
//
//  设计上的几个取舍：
//
//  1) **长高有上限**。不限的话，一段几千字的描述会把整个表单顶到屏幕外，
//     反而更难用（想改下面的字段得滚半天）。到上限之后由浏览器内部的
//     滚动条接棒 —— 那个滚动条只在需要时出现，不会常驻占位。
//
//  2) **手动拖过之后就不再自动长高**。用户在 `resize: vertical` 的框上拖过高度，
//     说明「我就要这么高」，这时候内容再多也不该擅自改回去。否则会出现
//     「每敲一个字框都跳一下」的怪事。所以拖拽会自动记一次「已锁定」。
//
//  3) 高度**只在编辑弹窗打开的这一段时间里有效**，不落盘。它属于「此刻怎么摆」，
//     不是角色数据的一部分 —— 写进角色卡会把用户的存档弄脏。
//     但连续编辑时应当记住（见 rememberHeight）。
//
//  4) 单靠 `input` 事件不够：**程序回填**（打开编辑器往框里塞值）不走 input，
//     所以打开时得显式调一次 syncAutoGrowAll。
//
//  ⚠️ 用得最狠的两个坑（都踩过，别再踩）：
//
//  · **CSS 里不能给这些框写 `transition: height`**。看起来是个无伤大雅的
//    平滑效果，实际上 Chromium 会在每次布局时重新触发这个过渡，
//    元素于是永远停在起始值：JS 明明写下 `height: 334px`（`style.height`
//    查得到），`getComputedStyle().height` 却一直是 84px，等多久都不收敛。
//    排查时的迷惑点是「到底哪条规则把它压回去了」—— 其实一条都没有，
//    是过渡本身在作祟。本模块的输出天然是瞬时的，不要给它加动画。
//
//  · **量高度必须在元素可见之后**。`display: none` 的元素 `scrollHeight` 是 0，
//    量什么都是下限。调用方（视图层）要注意顺序：先把容器露出来，再 sync。
// ============================================================================

// 自动长高的上限（px）。到这个高度就停，多出来的内容交给框内滚动。
const GROW_MAX = 420;
// 每次重算的最小高度（px）。太矮的话一行都没有，看着像坏了。
const GROW_MIN = 84;

/**
 * 量一次文本框内容需要多高。
 *
 * 做法：把 height 设成 'auto' 再读 scrollHeight —— 这是唯一可靠的办法。
 * 直接读 scrollHeight 会拿到**当前高度下**的滚动高度，框已经很高时
 * 它就不长了（经典的自增长踩坑点）。
 *
 * ⚠️ 但只把 height 设成 'auto' **不够**：`<textarea rows="5">` 上的 rows
 * 是一个 HTML 属性而不是 CSS，height:auto 会退回 rows 撑出来的高度（五行），
 * 于是「只有一行字」的框也被量成五行高。所以量之前先把 rows 摘掉、
 * 量完再按原值装回去 —— 这样 scrollHeight 才是纯内容高度。
 *
 * box-sizing 要考虑：通用规则里是 border-box（style.css 的控件段），
 * 那 scrollHeight 不含边框，所以要补上上下边框。用 getComputedStyle 读，
 * 不写死 —— 免得以后改了边框宽度这里就对不上。
 */
function measureHeight(el) {
  const prevH = el.style.height;
  const rows = el.getAttribute('rows');

  el.style.height = 'auto';
  if (rows !== null) el.removeAttribute('rows');
  const scroll = el.scrollHeight;
  if (rows !== null) el.setAttribute('rows', rows);
  el.style.height = prevH;

  const cs = window.getComputedStyle(el);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return scroll + border;
}

/**
 * 按内容调整一个文本框的高度。
 * 已经「锁定」（用户手动拖过）的框直接跳过。
 */
export function autoGrow(el) {
  if (!el || el.dataset.growLocked === '1') return;

  const need = measureHeight(el);
  const next = Math.min(GROW_MAX, Math.max(GROW_MIN, need));

  // 只在真的变了才写 —— 否则每次输入都触发一次样式重算
  if (el.style.height !== `${next}px`) el.style.height = `${next}px`;
}

/**
 * 给一个文本框接上自动增高。
 *
 * @param {HTMLTextAreaElement} el
 * @param {object} [opts]
 * @param {string} [opts.key]  高度记忆的键（重开编辑器时沿用上次拖的高度）；
 *                             不传就不记忆。建议用「字段名」而不是角色 id，
 *                             这样它是「习惯」而不是「某张卡的数据」。
 */
export function attachAutoGrow(el, opts) {
  if (!el || el.dataset.autoGrow === '1') return;
  el.dataset.autoGrow = '1';

  const key = opts && opts.key ? String(opts.key) : '';

  // 先按上次拖过的位置恢复（如果有），没有就走内容自适应
  const saved = heightOf(key);
  if (saved) {
    el.style.height = `${saved}px`;
    el.dataset.growLocked = '1';
  }

  el.addEventListener('input', () => {
    // 用户开始打字 = 从这一刻起由内容说了算，
    // 除非他之前手动拖过（拖过的框不再自动长高）
    autoGrow(el);
  });

  // 拖拽结束（鼠标松开）时记下来：既要记住高度，也要锁定不再自动长高。
  // 用 mouseup 而不是 resize —— 没有 resize 事件可用，而拖拽结束
  // 唯一能观察到的信号就是鼠标松开。
  el.addEventListener('mouseup', () => {
    const h = Math.round(el.getBoundingClientRect().height);
    if (h <= 0) return;
    // 和「内容自适应应该得到的高度」不一样 → 说明用户手动调过
    const natural = Math.min(GROW_MAX, Math.max(GROW_MIN, measureHeight(el)));
    if (Math.abs(h - natural) > 4) {
      el.dataset.growLocked = '1';
      el.style.height = `${h}px`;
      rememberHeight(key, h);
    }
  });

  autoGrow(el);
}

/**
 * 重算一批文本框的高度（忽略锁定）。
 * 用在「打开编辑器、程序回填了值」之后 —— 回填不走 input 事件，得显式来一次。
 *
 * ⚠️ 调用时机必须在元素**可见之后**：`display: none` 的元素 scrollHeight 是 0，
 * 这时候量出来永远是下限（84px）。编辑器就是栽在这上面 ——
 * 原来在填表单时同步，而那一刻弹窗还没摘掉 .hidden。
 */
export function syncAutoGrowAll(list) {
  for (const el of list || []) {
    if (!el) continue;
    if (el.dataset.growLocked === '1') continue;
    el.style.height = '';
    autoGrow(el);
  }
}

/**
 * 「这个框上次拖到多高」—— 只活在内存里，不落盘。
 *
 * 为什么不写进角色卡：高度是「此刻怎么摆」，不是角色设定。
 * 写进去会变成导出卡里的垃圾字段（而且用户换了显示器就全不对了）。
 * 为什么要记：连续编辑时，拖好的高度不该每开一次弹窗就丢。
 *
 * key 用**字段名**（charform:desc）而不是角色 id —— 记忆是「我习惯把示例对话
 * 拖这么高」，属于习惯而不是某张卡的数据，所以不做「换角色就清掉」这回事。
 * 上限 40 条，够用；超出就整体清空（比搞 LRU 简单，边界情况也不值得）。
 */
const heightStore = new Map();
const HEIGHT_STORE_MAX = 40;

function rememberHeight(key, px) {
  if (!key) return;
  if (heightStore.size >= HEIGHT_STORE_MAX) heightStore.clear();
  heightStore.set(String(key), Math.round(px));
}

function heightOf(key) {
  return key ? heightStore.get(String(key)) || 0 : 0;
}
