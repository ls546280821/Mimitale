'use strict';

// ============================================================================
//  renderer/pet/pet.js —— 宠物窗口里的那一小块逻辑
//
//  它只管「演」：显示形象、把气泡里的字一句句冒出来、拖动、右键叫菜单。
//  所有**判断**（该不该说话、说几句、用哪个模型、记什么）都在主进程和主界面那边，
//  这里一点都不掺和 —— 宠物页面越笨越不容易出事，它连 API Key 都拿不到。
//
//  ────────────────────────────────────────────────────────────────────────
//  最要紧的是「鼠标穿透」这一段，它决定了这功能好不好用。
//
//  窗口是 300×380 的矩形，宠物不是。窗口如果一直收鼠标，桌面上就多出一片
//  **看不见的点击死区**：用户点不到宠物旁边的图标，而且完全不知道为什么 ——
//  这是桌宠类功能被骂得最多的一条。
//
//  做法分两层：
//    ① 窗口默认穿透，但把鼠标移动事件转发进来：
//         setIgnoreMouseEvents(true, { forward: true })
//       所以「穿透状态下也能知道鼠标在哪」。
//    ② 指针位置到底算不算「在宠物身上」，这里按**图片的 alpha 通道**逐像素判。
//       不是拿矩形判 —— 拿矩形判的话，宠物头顶那片透明区域照样是死区。
//       具体是把形象画进一张同尺寸的离屏 canvas，取一次 getImageData 存成掩码，
//       之后每次 mousemove 查表（O(1)），比反复 getImageData 快得多。
//  ────────────────────────────────────────────────────────────────────────
// ============================================================================

const spriteWrap = document.getElementById('sprite-wrap');
const spriteEmpty = document.getElementById('sprite-empty');
const bubble = document.getElementById('bubble');
const bubbleLines = document.getElementById('bubble-lines');

// rig 动态形象（部件贴图渲染）。形象只有这一种 —— 第一版那张静态立绘
// 的 <img> 渲染路径已经移除。引擎在 cat.js / cat-figure.js（名字是历史遗留，
// 它最初为蓝白猫写，现在服务所有 rig 形象包，包括默认的大肥鱼）。
import { catRig } from './cat.js';

// alpha 低于这个值就当「这里是透明的」，鼠标穿过去。
// 给 16 而不是 0：图片边缘半透明的抗锯齿像素不该咬住鼠标。
const ALPHA_THRESHOLD = 16;

// ---------------------------------------------------------------------------
//  状态
// ---------------------------------------------------------------------------

/** 当前是否已经让窗口「穿透鼠标」。要缓存，否则每次 mousemove 都会跨进程发一遍 */
let clickThroughApplied = null;

/** 形象的不透明掩码：{ w, h, alpha }。取不到（读像素被拒 / 图还没加载）时为 null */
let mask = null;

/**
 * 宠物**头顶**在 sprite-wrap 坐标系里的 y（px）。
 * 由掩码扫出来（见 rebuildMask），用来把气泡贴着它放 ——
 * 画布比宠物大，光看窗口尺寸摆不准。读不到时为 null，此时气泡退回 CSS 默认位置。
 */
let spriteTopInWrap = null;

/** 气泡自动收起 / 逐句冒字用的定时器 */
let bubbleTimer = null;
let lineTimer = null;

let streaming = false;
let streamBuffer = '';

// ---------------------------------------------------------------------------
//  和主进程的来往
// ---------------------------------------------------------------------------

function applyState(payload) {
  if (!payload) return;

  const pet = payload.pet || {};
  const scale = Math.max(0.4, Math.min(2, Number(pet.scale) || 1));
  document.documentElement.style.setProperty('--scale', String(scale));

  // 「允许哪些空闲手势」（设置页那三个勾）。**必须放在下面几个提前 return 之前** ——
  // 形象没加载出来（rig 为 null）时这里会 return，但用户关掉动作的意图跟
  // 有没有形象无关；放在后面的话，一旦 rig 缺失这个设置就永远传不到渲染层。
  catRig.setGestures(pet.gestureEnabled);

  // 形象只有 rig 一种：模型 + 贴图都由主进程转成 dataUrl 推来（CSP 拦 fetch），
  // 渲染交给 cat.js。资产缺失时 rig 为 null → 露出「形象没加载出来」占位。
  const rigData = pet.rig || null;
  if (!rigData || !rigData.model) {
    catRig.dispose();
    spriteEmpty.hidden = false;
    mask = null;
    return;
  }

  spriteEmpty.hidden = true;
  catRig.mount(spriteWrap);
  catRig.applyState(rigData)
    .then(() => {
      // 贴图解码 + 首帧渲染之后掩码才有像素可读；等一小会儿再重建
      setTimeout(() => requestAnimationFrame(rebuildMask), 150);
    })
    .catch((err) => {
      // WebGL 起不来之类的初始化失败：露出占位框，别让窗口空着什么都不显示
      console.warn('[pet] 动态形象初始化失败:', err && err.message);
      catRig.dispose();
      spriteEmpty.hidden = false;
      mask = null;
    });
  mask = null;
}

async function pullState() {
  try {
    applyState(await window.petBridge.getState());
  } catch (err) {
    console.warn('[pet] 取状态失败', err);
  }
}

// ---------------------------------------------------------------------------
//  不透明掩码
// ---------------------------------------------------------------------------

/** 掩码的像素源：rig 的 canvas（preserveDrawingBuffer 开着，能读像素）。 */
function maskSource() {
  return catRig.active ? catRig.canvas || null : null;
}

/**
 * 把当前显示尺寸的形象画进离屏 canvas，取 alpha 存成掩码。
 *
 * 用 data: URL 的图片不会污染 canvas，getImageData 拿得到像素；
 * 万一环境变了读不出来（画布被污染），就退化成 null ——
 * 那时候按「整个矩形都算宠物」处理（保守：宁可多咬住一点，也别让宠物点不动）。
 *
 * 掩码除了给点选判断用，还顺手算出**宠物头顶的 y**（见 `spriteTopInWrap`）——
 * 气泡要贴着它放，别飘在画布上方那片空白里。
 *
 * ⚠️ 调用的时机比函数本身更要紧：`fitCanvas` 一改 canvas 的像素尺寸就清空绘制缓冲，
 *    所以**尺寸刚变过的那一帧画布是空的**。在那一帧调用本函数会得到一张全透明的
 *    掩码（= 宠物点不动）。正确时机见文件下方 resize 那条注释。
 */
function rebuildMask() {
  const previous = mask;
  spriteTopInWrap = null;
  const src = maskSource();
  if (!src) { mask = null; return; }

  const rect = src.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w <= 0 || h <= 0) { mask = null; return; }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;

    const alpha = new Uint8Array(w * h);
    let solid = 0;
    for (let i = 0; i < w * h; i += 1) {
      const a = pixels[i * 4 + 3];
      alpha[i] = a;
      if (a >= ALPHA_THRESHOLD) solid += 1;
    }

    // 整张画布都透明 = 这份像素根本还没画上去（fitCanvas 刚给 canvas 改过像素尺寸、
    // 绘制缓冲被清空；或者首帧还没渲染）。**别拿它当掩码** —— 那等于宣告
    // 「宠物身上一个实心像素都没有」，命中判断全部落空，宠物就点不动了。
    // 真正防这件事的是 resize 那条路（`catRig.refit(rebuildMask)`，等下一帧画完），
    // 这里只是兜底：读不到东西就保留上一份能用的掩码。
    if (!solid && previous) {
      mask = previous;
      syncBubbleAnchor();
      return;
    }

    mask = { w, h, alpha };

    // 头顶：第一个「这一行有足够多不透明像素」的行。
    // ⚠️ 不能只判 alpha > 0 —— 半透明的发梢 / 抗锯齿边缘会零星落在很上面，
    //    按它对齐会让气泡和头之间又冒出一条缝。要求一行里至少 2% 宽度的实心像素，
    //    才算「头顶真的到这儿了」。
    const need = Math.max(2, Math.round(w * 0.02));
    for (let y = 0; y < h; y += 1) {
      let n = 0;
      const base = y * w;
      for (let x = 0; x < w; x += 1) {
        if (alpha[base + x] > 128) {
          n += 1;
          if (n >= need) break;
        }
      }
      if (n >= need) {
        // canvas 顶 → wrap 顶的偏移，再加回这一行
        spriteTopInWrap = rect.top - spriteWrap.getBoundingClientRect().top + y;
        break;
      }
    }
  } catch (err) {
    console.warn('[pet] 算不出不透明掩码，退化成整块矩形:', err && err.message);
    mask = null;
    spriteTopInWrap = null;
  }
  syncBubbleAnchor();
}

/**
 * 把气泡下沿锚到宠物头顶上方一点。
 *
 * 为什么需要：窗口是 300×380，但 rig 画布只有 300×300 一块方图（`fitCanvas` 按宽度
 * 贴合、等比收高），**剩下 80px 是画布上方的空白**，而且 view 盒子本身在角色头顶
 * 还留了动画余量。气泡是绝对定位、钉在窗口顶部的，于是它的下沿和宠物之间就出现
 * 一条「说不清是哪来的」间隔 —— 而且说几句话都会让气泡高度变、间隔跟着变。
 * 用实测到的头顶位置去摆，间隔就恒定且贴合了。
 *
 * 拿不到头顶（掩码读不出 / rig 没起来）就不设，退回 CSS 的默认位置。
 */
function syncBubbleAnchor() {
  const wrap = spriteWrap.getBoundingClientRect();
  if (!wrap.height) return;
  if (spriteTopInWrap == null) {
    bubble.style.removeProperty('--bubble-bottom');
    return;
  }

  // ⚠️ 气泡**框**的下沿不是视觉下沿：尾巴（::before/::after）和那三个装饰点
  //    都挂在框外、往下伸。按 CSS 的 `bottom` 摆的是**框**，所以要把这截
  //    「外挂高度」补进气口里，否则尾巴会压在宠物头上（2026-08-10 实测到过）。
  //    这里不改 CSS 常量，而是量真实值：读尾巴伪元素的 bottom 偏移。
  const tailDrop = overhangBelowBubble();
  const gap = 8;
  let fromBottom = wrap.height - (spriteTopInWrap - gap - tailDrop);

  // 别把气泡顶出窗口上沿：锚点太靠上（宠物很高 / 窗口很矮）时，气泡得整体下移。
  // ⚠️ 预留量要按**气泡自己的高度**算，不能写死一个小数字 ——
  //    0.7× 时窗口只有 266px 高，而气泡（固定字号）有 ~98px，
  //    写死 46px 会让气泡顶边跑到 -19px（整个上半截在窗口外，什么都看不见）。
  const reserve = bubble.offsetHeight + tailDrop + 6;
  const maxFromBottom = Math.max(0, wrap.height - reserve);
  fromBottom = Math.min(fromBottom, maxFromBottom);
  bubble.style.setProperty('--bubble-bottom', `${fromBottom.toFixed(1)}px`);
}

/**
 * 气泡**框外**往下伸的那一截有多高（目前就是尾巴）。
 *
 * 为什么要量而不是写死：尾巴尺寸在 CSS 里，改了 CSS 这里忘了跟就会压头发
 * （2026-10-10 把尾巴从 7.5px 加到 9px 时，气泡就压到 ahoge 上了）。
 *
 * 尾巴现在是「旋转圆角方块」（见 pet.css 的 .bubble::before）：视觉探出量
 * 是对角线的一半，**没法**从 CSS 的 bottom 偏移读出来 —— 所以实测值写在
 * :root 的 `--tail-overhang` 里，这里优先用它；变量缺失（旧样式表）再退回
 * 从 ::before 上量 bottom 偏移的旧量法。
 */
function overhangBelowBubble() {
  const rootCs = getComputedStyle(document.documentElement);
  const declared = parseFloat(rootCs.getPropertyValue('--tail-overhang'));
  if (Number.isFinite(declared) && declared > 0) return declared;

  const cs = getComputedStyle(bubble, '::before');
  if (cs && cs.content && cs.content !== 'none') {
    const off = parseFloat(cs.bottom);
    if (Number.isFinite(off) && off < 0) return Math.abs(off);
    const bw = parseFloat(cs.borderTopWidth);
    if (Number.isFinite(bw)) return bw;
  }
  return 0;
}

// 窗口尺寸变了（用户改「大小」/ 系统缩放变化）：两件事都得做 ——
//   ① 立刻让 rig 按新尺寸重建位图。不这么做的话位图要等 draw 里那个 20 帧周期才重算，
//      中间那几帧是旧尺寸的像素被 CSS 拉伸，看着就是「宠物被拉长了一瞬间」。
//   ② 重建不透明掩码（点选命中区要跟着新尺寸走）。
//
// ⚠️⚠️ ②**绝不能在 ① 的同一帧里做**（2026-10-10 修的 bug）。
//    `fitCanvas` 给 `canvas.width / height` 赋新值会**当场清空 WebGL 绘制缓冲**，
//    所以 ① 之后这一帧的 canvas 是**空白**的 —— 用它算出来的掩码整张透明，
//    `inSprite` 于是次次落空 → 窗口一直判定「鼠标不在宠物身上」→ 一直保持鼠标穿透
//    → **宠物看得见、但点不动也拖不走**。
//    用户实测的形态正是这个：长按（拖动时系统重算了内容区尺寸 → 触发 resize）
//    之后就点不到了，去设置里改一次大小/缩放又能点 —— 因为那条路是在
//    `pet:state` → `applyState` 之后**延迟 150ms** 才重建掩码的，那时画布早画好了。
//    所以这里把重建挂到 `refit` 的「下一帧画完」回调上（cat.js 的帧循环负责触发）。
/**
 * 拖动期间攒下的「尺寸变了，等松手再重建」标记。
 * 为什么要攒：见下面 resize 那条注释 —— 拖动中重建就是「一直闪」。
 */
let refitPending = false;

/** 按当前窗口尺寸重建位图 + 命中掩码（掩码必须等下一帧画完，见 cat.js 的 refit） */
function refitNow() {
  refitPending = false;
  catRig.refit(rebuildMask);
}

window.addEventListener('resize', () => requestAnimationFrame(() => {
  // 拖动中**先不重建**（2026-10-10 修「拖动时一直闪」）：
  // 拖动时窗口跟着光标跑，而主进程那边同时还在把系统重算出来的尺寸纠回去，
  // 一次拖动能触发几十次 resize。每次都重建 = 每帧给 canvas 重设一次像素尺寸 =
  // 每帧清空一次绘制缓冲 → 视觉上就是「闪个不停」。
  // 攒到松手（mouseup / blur）后统一补一次 —— 那时尺寸已经纠稳，一次就够。
  if (dragging) { refitPending = true; return; }
  refitNow();
}));
// 气泡内容一变高，下沿就该重新对一次头顶（气泡是「底边锚定」的）
if (window.ResizeObserver) {
  new ResizeObserver(() => requestAnimationFrame(syncBubbleAnchor)).observe(bubble);
}

// ---------------------------------------------------------------------------
//  命中判断 + 穿透
// ---------------------------------------------------------------------------

/** 点是不是落在气泡上（气泡是实心的矩形，不用查掩码） */
function inBubble(x, y) {
  if (bubble.hidden) return false;
  const r = bubble.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** 点是不是落在宠物的**实体像素**上 */
function inSprite(x, y) {
  if (!catRig.active) {
    // rig 起不来时露出的是**实心**占位框，它必须照常接鼠标。
    // 早先这里直接 return false，结果是：形象一坏整块就穿透，
    // 用户连右键菜单都调不出来，只能回主界面设置 —— 而占位框上明明写着
    // 「形象没加载出来」这类提示，却点不动，很像 bug。
    if (spriteEmpty.hidden) return false;
    const r = spriteEmpty.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  const src = catRig.canvas;
  if (!src) return false;
  const mirrored = catRig.mirrored;
  const r = src.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  if (!mask) return true;

  let px = Math.floor(((x - r.left) / r.width) * mask.w);
  // 镜像（面朝左）时 canvas 像素没翻、显示翻了 —— 掩码索引要跟着反，
  // 不然点击命中区是左右错位的（点尾巴才算点到脸）
  if (mirrored) px = mask.w - 1 - px;
  const py = Math.floor(((y - r.top) / r.height) * mask.h);
  if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) return false;
  return mask.alpha[py * mask.w + px] >= ALPHA_THRESHOLD;
}

function setClickThrough(ignore) {
  if (clickThroughApplied === ignore) return;
  clickThroughApplied = ignore;
  try {
    window.petBridge.setClickThrough(ignore);
  } catch (err) {
    /* 主进程还没准备好就忽略这一次 */
  }
}

// ---------------------------------------------------------------------------
//  气泡
// ---------------------------------------------------------------------------

function clearBubbleTimers() {
  clearTimeout(bubbleTimer);
  clearTimeout(lineTimer);
  bubbleTimer = null;
  lineTimer = null;
}

function hideBubble() {
  bubble.hidden = true;
  bubbleLines.replaceChildren();
  spriteWrap.classList.remove('talking');
}

/** 把 `*动作*` 渲染成斜体（用 DOM 拼，绝不走 innerHTML —— 内容是模型给的） */
function renderLine(text) {
  const p = document.createElement('p');
  p.className = 'bubble-line';

  for (const part of String(text || '').split(/(\*[^*\n]{1,40}\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      p.appendChild(em);
    } else {
      p.appendChild(document.createTextNode(part));
    }
  }
  return p;
}

/** 按内容长度决定挂多久：短句 4 秒起，长句多留一会儿，最多 20 秒 */
function hideDelayFor(text) {
  const len = String(text || '').length;
  return Math.min(20000, Math.max(4000, 1800 + len * 130));
}

/** 两句之间的停顿（ms）。有点节奏但别拖 —— 5 句也才 2 秒内说完 */
const LINE_GAP_MS = 460;

/**
 * 把气泡正文滚到「最后一句尽量完整可见」的位置。
 *
 * 背景：`scrollTop = scrollHeight` 会滚到最底，而最上面那句常常被切掉半行
 * （行高 21px，可视高度不一定是行高的整数倍），露出半截字形，很难看。
 *
 * ⚠️ 但"对齐到行边界"不能无脑做 —— 如果最后一行比可视区还高（固定字号 +
 *    窄窗口时很常见），把它对到顶边就会让**底部**超出可视区，
 *    也就是"最新那句话没读完"，比顶部切半行严重得多。
 *
 * 所以规则是：
 *   1. 先滚到底（保证最新内容一定在视野里），拿到 maxScroll；
 *   2. 找**包含内容末尾**的那一行；
 *   3. 只有当这一行的**顶边 >= maxScroll**（即单独把它对上顶边也不会超出）
 *      时才吸附，否则保持滚到底。
 * 一句话：能整齐就整齐，整齐不了就保证"最后一句读全"。
 */
function scrollToLastLine() {
  const view = bubbleLines.clientHeight;
  if (!view) return;

  bubbleLines.scrollTop = bubbleLines.scrollHeight;
  const max = bubbleLines.scrollTop;
  if (max <= 0) return; // 没超出，不用滚

  const kids = bubbleLines.children;
  const last = kids[kids.length - 1];
  if (!last) return;

  // 最后一行整体（含它上面的分隔间距）的高度
  const lastTop = last.offsetTop;
  const lastBottom = lastTop + last.offsetHeight;
  // 吸附后可视区 = [lastTop, lastTop + view)，要能装下整行才吸
  if (lastBottom <= lastTop + view && lastTop <= max) {
    bubbleLines.scrollTop = lastTop;
  }
}

/**
 * 一句句往外冒（「每次说 3 句」就是三次）。
 *
 * 收起的时机按**最后一句**算：每加一句就把定时器往后推，
 * 否则「说到第二句的时候气泡自己收了」。
 *
 * 气泡现在有 max-height（见 pet.css 的 .bubble-lines），冒到超出的句子要跟着
 * 往下滚一点点，否则用户只能看见前两句、以为它就说这么多。
 */
function showLines(lines) {
  clearBubbleTimers();
  hideBubble();

  const list = (Array.isArray(lines) ? lines : [lines])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!list.length) return;

  bubble.hidden = false;
  spriteWrap.classList.add('talking');

  let index = 0;
  const next = () => {
    if (index >= list.length) {
      scheduleHide(list.join(''));
      return;
    }
    bubbleLines.appendChild(renderLine(list[index]));
    index += 1;
    // 新句子进到视野里（气泡还矮的时候不产生滚动，这行是空操作）
    scrollToLastLine();
    lineTimer = setTimeout(next, LINE_GAP_MS);
  };
  next();
}

function scheduleHide(text) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, hideDelayFor(text));
}

function showOne(text) {
  showLines([text]);
}

// ---------------------------------------------------------------------------
//  收到主进程推来的消息
// ---------------------------------------------------------------------------

window.petBridge.onState((payload) => {
  applyState(payload);
  requestAnimationFrame(rebuildMask);
});

window.petBridge.onWalk?.((payload) => catRig.walk(payload));

/**
 * 这一轮「想」的过程中有没有真收到一句完整的 pet:say。
 * 用来分辨「生成失败」和「生成成功」—— 两条路的收尾都是 busy:false（见 onBusy）。
 */
let saidThisCycle = false;

window.petBridge.onBusy((busy) => {
  catRig.setBusy(busy === true);
  spriteWrap.classList.toggle('busy', busy === true);
  if (busy === true) {
    saidThisCycle = false;
    streaming = true;
    streamBuffer = '';
    clearBubbleTimers();
    bubble.hidden = false;
    bubbleLines.replaceChildren();
    const p = document.createElement('p');
    p.className = 'bubble-line typing';
    p.textContent = '嗯…我想想…';
    bubbleLines.appendChild(p);
  } else {
    streaming = false;
    // 失败 / 被停掉时，主进程只发 busy:false、**不发 pet:say**，而收气泡的
    // hideBubble 只有 showLines（成功那条路）会调，也没有任何定时器会来收 ——
    // 不在这里收掉的话，「嗯…我想想…」会一直挂在宠物头上，要等下一次成功
    // 说话才被顶掉（没配 API Key / 网络错的时候就能看到）。
    // 成功那条路是「先 say 再 busy:false」，所以拿这个标志避开它，别把刚说出来的话抹了。
    if (!saidThisCycle) hideBubble();
  }
});

window.petBridge.onChunk((text) => {
  catRig.chunk();
  if (!streaming) {
    // 没收到 busy 就先来了增量（比如窗口刚起来 / 热重载 / 重新启用桌宠），
    // 补一个占位节点再往下写。少了 appendChild 这一句，下面的
    // firstElementChild 就是 null，整段增量会被白白攒进 streamBuffer
    // 而一个字都不显示，只有最后 pet:say 才一次性铺出来。
    streaming = true;
    streamBuffer = '';
    bubble.hidden = false;
    bubbleLines.replaceChildren();
    const p = document.createElement('p');
    p.className = 'bubble-line typing';
    bubbleLines.appendChild(p);
  }
  streamBuffer += String(text || '');
  const node = bubbleLines.firstElementChild;
  if (node) {
    node.textContent = streamBuffer;
    node.classList.add('typing');
    // 流式的句子会一直变长 —— 跟着滚到底，否则超过气泡上限之后
    // 用户看到的是「它说了半句就卡住了」。
    // ⚠️ 这里**故意**用最底而不是 scrollToLastLine()：整段话就是一个在不断变长的
    //    段落，正在写的字永远在末尾，切掉末尾等于切掉"它刚说的话"；
    //    顶边被切掉的半行是已经读过一次的旧内容，两害相权取轻。
    bubbleLines.scrollTop = bubbleLines.scrollHeight;
  }
});

window.petBridge.onSay((payload) => {
  saidThisCycle = true;
  streaming = false;
  catRig.said();
  spriteWrap.classList.remove('busy');
  const lines = payload && Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) showLines(lines);
  else if (payload && payload.text) showOne(payload.text);
  // 空回复：什么都不说就好，别留一个空气泡挂在那儿（占位那句也一起收掉）
  else hideBubble();
});

// ---------------------------------------------------------------------------
//  拖动 / 点一下 / 右键
// ---------------------------------------------------------------------------

let dragging = false;

/**
 * 最近一次的指针位置（窗口坐标）。
 * 只在「拖动中途失焦」那条兜底路上用：blur 事件本身不带坐标，而没有坐标就重算不了
 * 穿透状态 —— 不复位的话窗口会卡在不穿透那一侧，整块矩形变成点不动的死区。
 */
let lastPointer = null;

spriteWrap.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  // 只有按在**宠物的实体像素**上才算拖。sprite-wrap 铺满整个窗口，
  // 不加这道判断的话，在宠物旁边的透明区域按一下也会把宠物拖走。
  if (!inSprite(event.clientX, event.clientY)) return;
  dragging = true;
  catRig.dragBegin();
  spriteWrap.classList.add('dragging');
  window.petBridge.dragStart();
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
  // 视线跟踪的原料：相对窗口中心的偏移（cat.js 内部会 clamp / 衰减）
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  catRig.mouseMove((event.clientX - cx) / 40, (event.clientY - cy) / 40);
  // 拖动中一律不穿透：窗口跟着光标跑，中途一穿透就可能把 mouseup 弄丢
  if (dragging) {
    setClickThrough(false);
    return;
  }
  setClickThrough(!(inBubble(event.clientX, event.clientY) || inSprite(event.clientX, event.clientY)));
});

document.addEventListener('mouseup', async (event) => {
  if (!dragging || event.button !== 0) return;
  dragging = false;
  catRig.dragEnd();
  spriteWrap.classList.remove('dragging');
  // 拖动中攒下的重建补上（拖动里窗口尺寸变过，那时故意没重建，见 resize 那条注释）
  if (refitPending) requestAnimationFrame(refitNow);
  // 拖完光标可能停在透明区域上，主动重算一次
  setClickThrough(!(inBubble(event.clientX, event.clientY) || inSprite(event.clientX, event.clientY)));

  let moved = false;
  try {
    // 「点」和「拖」只能由主进程判：窗口跟着光标跑，这里的 clientX/Y 拖动时几乎不变
    moved = (await window.petBridge.dragEnd()) === true;
  } catch (err) {
    /* 拿不到就当没拖动 */
  }

  if (!moved) {
    // 「点一下」= 摸它一下：主进程在本地给一句应声，不调模型、不花钱
    try {
      const res = await window.petBridge.poke();
      if (res && res.text) { catRig.poked(); showOne(res.text); }
    } catch (err) {
      /* 摸不到不该报错 */
    }
  }
});

// 拖动时窗口跟着光标跑，有可能收不到 mouseup（在窗口外面松的手）。
// 一失去焦点就当作拖完了，不然宠物会一直「粘」在鼠标上。
// ⚠️ 复位拖动的同时**必须把穿透状态也重算一次**：少了这一步，窗口会停在
//    「不穿透」那一侧 —— 整块 300×380 的矩形就变成桌面上一片点不动的死区
//    （点宠物旁边的图标毫无反应，看着就像「宠物丢了」）。
//    blur 事件不带坐标，所以用最后一次记录的指针位置，和 mouseup 同口径。
window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  catRig.dragEnd();
  spriteWrap.classList.remove('dragging');
  window.petBridge.dragEnd();
  // 拖动中攒下的重建也补上（和 mouseup 同一条口径）
  if (refitPending) requestAnimationFrame(refitNow);
  const p = lastPointer;
  setClickThrough(!(p && (inBubble(p.x, p.y) || inSprite(p.x, p.y))));
});

// 右键交给主进程弹**原生菜单**（理由见 preload-pet.js）
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  setClickThrough(false);
  window.petBridge.openMenu();
});

// 滚轮不做任何事 —— 透明窗口上默认的滚轮行为只会让人一脸问号
document.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });

// ---------------------------------------------------------------------------
//  起步
//
//  一进来先按「全穿透」算，等鼠标第一次划过再校正。
//  反过来（先假设不穿透）的话，宠物窗口一出现就会咬住桌面那一块。
// ---------------------------------------------------------------------------

setClickThrough(true);
window.petBridge.ready();
pullState();
