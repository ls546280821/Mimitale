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

const sprite = document.getElementById('sprite');
const spriteWrap = document.getElementById('sprite-wrap');
const spriteEmpty = document.getElementById('sprite-empty');
const bubble = document.getElementById('bubble');
const bubbleLines = document.getElementById('bubble-lines');

// alpha 低于这个值就当「这里是透明的」，鼠标穿过去。
// 给 16 而不是 0：图片边缘半透明的抗锯齿像素不该咬住鼠标。
const ALPHA_THRESHOLD = 16;

// ---------------------------------------------------------------------------
//  状态
// ---------------------------------------------------------------------------

let petState = null;

/** 当前是否已经让窗口「穿透鼠标」。要缓存，否则每次 mousemove 都会跨进程发一遍 */
let clickThroughApplied = null;

/** 形象的不透明掩码：{ w, h, alpha }。取不到（读像素被拒 / 图还没加载）时为 null */
let mask = null;

/** 气泡自动收起 / 逐句冒字用的定时器 */
let bubbleTimer = null;
let lineTimer = null;

let streaming = false;
let streamBuffer = '';

// ---------------------------------------------------------------------------
//  和主进程的来往
// ---------------------------------------------------------------------------

let appliedImage = '';

function applyState(payload) {
  if (!payload) return;
  petState = payload;

  const pet = payload.pet || {};
  const scale = Math.max(0.4, Math.min(2, Number(pet.scale) || 1));
  document.documentElement.style.setProperty('--scale', String(scale));

  const image = pet.image || '';
  if (image && image !== appliedImage) {
    appliedImage = image;
    sprite.src = image;
    sprite.hidden = false;
    spriteEmpty.hidden = true;
    // 换图之后原来的掩码作废；等图片解码完再重建
    mask = null;
  } else if (!image) {
    appliedImage = '';
    sprite.removeAttribute('src');
    sprite.hidden = true;
    spriteEmpty.hidden = false;
    mask = null;
  }
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

/**
 * 把当前显示尺寸的形象画进离屏 canvas，取 alpha 存成掩码。
 *
 * 用 data: URL 的图片不会污染 canvas，getImageData 拿得到像素；
 * 万一环境变了读不出来（画布被污染），就退化成 null ——
 * 那时候按「整个矩形都算宠物」处理（保守：宁可多咬住一点，也别让宠物点不动）。
 */
function rebuildMask() {
  mask = null;
  if (!sprite.complete || !sprite.naturalWidth || sprite.hidden) return;

  const rect = sprite.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w <= 0 || h <= 0) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sprite, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;

    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) alpha[i] = pixels[i * 4 + 3];
    mask = { w, h, alpha };
  } catch (err) {
    console.warn('[pet] 算不出不透明掩码，退化成整块矩形:', err && err.message);
    mask = null;
  }
}

sprite.addEventListener('load', () => {
  // 等一帧：load 时布局可能还没算完，getBoundingClientRect 会拿到 0
  requestAnimationFrame(rebuildMask);
});

window.addEventListener('resize', () => requestAnimationFrame(rebuildMask));

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
  if (sprite.hidden) return false;
  const r = sprite.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  if (!mask) return true;

  const px = Math.floor(((x - r.left) / r.width) * mask.w);
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

/**
 * 一句句往外冒（「每次说 3 句」就是三次）。
 *
 * 收起的时机按**最后一句**算：每加一句就把定时器往后推，
 * 否则「说到第二句的时候气泡自己收了」。
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
    lineTimer = setTimeout(next, 520);
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

window.petBridge.onBusy((busy) => {
  spriteWrap.classList.toggle('busy', busy === true);
  if (busy === true) {
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
  }
});

window.petBridge.onChunk((text) => {
  if (!streaming) {
    // 没收到 busy 就先来了增量（比如窗口刚起来），补一个占位
    streaming = true;
    streamBuffer = '';
    bubble.hidden = false;
    bubbleLines.replaceChildren();
  }
  streamBuffer += String(text || '');
  const node = bubbleLines.firstElementChild;
  if (node) {
    node.textContent = streamBuffer;
    node.classList.add('typing');
  }
});

window.petBridge.onSay((payload) => {
  streaming = false;
  spriteWrap.classList.remove('busy');
  const lines = payload && Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) showLines(lines);
  else if (payload && payload.text) showOne(payload.text);
  // 空回复：什么都不说就好，别留一个空气泡挂在那儿
});

// ---------------------------------------------------------------------------
//  拖动 / 点一下 / 右键
// ---------------------------------------------------------------------------

let dragging = false;

spriteWrap.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  // 只有按在**宠物的实体像素**上才算拖。sprite-wrap 铺满整个窗口，
  // 不加这道判断的话，在宠物旁边的透明区域按一下也会把宠物拖走。
  if (!inSprite(event.clientX, event.clientY)) return;
  dragging = true;
  spriteWrap.classList.add('dragging');
  window.petBridge.dragStart();
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
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
  spriteWrap.classList.remove('dragging');
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
      if (res && res.text) showOne(res.text);
    } catch (err) {
      /* 摸不到不该报错 */
    }
  }
});

// 拖动时窗口跟着光标跑，有可能收不到 mouseup（在窗口外面松的手）。
// 一失去焦点就当作拖完了，不然宠物会一直「粘」在鼠标上。
window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  spriteWrap.classList.remove('dragging');
  window.petBridge.dragEnd();
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
