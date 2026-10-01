'use strict';

// ============================================================================
//  ui/lightbox.js —— 点开一张图放大看
//
//  角色库卡片上的形象、聊天里的图都走这里：铺满一层，滚轮 / 按钮缩放，
//  按住拖动平移，双击在「适应窗口」和 2.5 倍之间来回切。
//  工具条上的按钮全是图标（图形见 ui/icons.js 的 zoom-*）；
//  其中「适应窗口 / 实际大小」是**同一个按钮**，按当前状态在两个档位间切 ——
//  和常见看图工具一致。快捷键：0 适应、1 实际大小、+/- 缩放。
//
//  缩放以指针位置为锚点 —— 滚轮指到哪，那块画面就不动，放大时不用再找位置。
//  1 倍 = 图片按窗口自适应后的尺寸（不是原始像素），工具条上的百分比按
//  原始像素算，所以小图点开显示的会是 100% 以上。
//
//  同一时间只开一层，再开一张会先把上一张关掉。
// ============================================================================

import { h } from './build.js';
import { iconHtml } from './icons.js';

const MIN_SCALE = 0.15;
const MAX_SCALE = 10;
// 滚轮 / 加减号每一档的倍数
const ZOOM_STEP = 1.15;
const DOUBLE_CLICK_SCALE = 2.5;
// 松手时位移不超过这么多像素，算「点了一下」而不是「拖过」
const CLICK_SLOP = 4;
// 缩放后图片边缘之外还留这么多像素可以拖出去，免得图一放大就出不了视野
const PAN_MARGIN = 80;
// 百分比落在这个区间内就当作「已经是实际大小」，不用再切
const ACTUAL_EPSILON = 0.02;

let current = null; // 当前浮层的关闭函数

/** 关掉正开着的浮层（没开着就什么都不做）。 */
export function closeLightbox() {
  if (current) current();
}

/**
 * 打开看图浮层。
 *
 * @param {string} src     图片（dataURL）
 * @param {object} [options]
 * @param {string} [options.title] 工具条上显示的名字
 */
export function openLightbox(src, { title = '' } = {}) {
  if (!src) return;
  closeLightbox();

  const img = h('img', { class: 'lightbox-img', src, alt: title || '图片' });
  img.draggable = false;

  // 「适应窗口」= scale 1；offset 是相对居中位置的平移量
  let scale = 1;
  const offset = { x: 0, y: 0 };

  const pct = h('span', { class: 'lightbox-pct', id: 'lightbox-pct', text: '100%' });

  // 图标按钮：文案只有图标，名字（title / aria-label）由下面的函数按状态挂。
  // 图标是我们自己登在 ui/icons.js 里的静态字符串，insertAdjacentHTML 是安全的。
  const iconButton = (id, icon, titleText, extraClass) => {
    const btn = h('button', {
      id,
      class: ['btn', 'btn-ghost', 'btn-sm', 'icon-btn', extraClass].filter(Boolean),
      type: 'button',
      title: titleText,
      'aria-label': titleText
    });
    btn.insertAdjacentHTML('afterbegin', iconHtml(icon));
    return btn;
  };

  const btnOut = iconButton('lightbox-out', 'zoom-out', '缩小');
  const btnIn = iconButton('lightbox-in', 'zoom-in', '放大');
  // 一个按钮管两件事：「适应窗口」和「实际大小」来回切 —— 这也是各家看图工具的惯例。
  const btnFit = iconButton('lightbox-reset', 'zoom-fit', '适应窗口');
  const btnClose = iconButton('lightbox-close', 'close', '关闭（Esc）');

  const bar = h(
    'div',
    { class: 'lightbox-bar' },
    title ? h('span', { class: 'lightbox-title', text: title }) : null,
    h('span', { class: 'lightbox-zoom' }, btnOut, pct, btnIn),
    h('span', { class: 'lightbox-actions' }, btnFit, btnClose),
    h('span', { class: 'lightbox-hint', text: '滚轮缩放 · 拖动平移 · 双击切换' })
  );

  const layer = h('div', { class: 'lightbox', id: 'lightbox' }, img, bar);

  function apply() {
    img.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
  }

  /**
   * 当前显示的是不是正好「实际大小」（scale = 原图像素 1:1）。
   * 边上还有一个退化情况：图片自适应后本来就正好是原始像素（natural ≈ laid）——
   * 那时两档完全重合，切了也看不出变化，所以直接判成「已经是实际大小」，
   * 让按钮停在「回适应」那一档，别给用户一个按了没反应的按钮。
   */
  function atActualSize() {
    const natural = img.naturalWidth || 0;
    const laid = img.clientWidth || 0;
    if (!natural || !laid) return false;
    return Math.abs((laid * scale) / natural - 1) <= ACTUAL_EPSILON;
  }

  /** 按钮的图标 / 名字跟着当前状态走：已经是实际大小，再点就是回适应，反之亦然 */
  function syncFitButton() {
    const actual = atActualSize();
    const icon = actual ? 'zoom-fit' : 'zoom-actual';
    const label = actual ? '适应窗口' : '实际大小（1:1）';
    const svg = iconHtml(icon);
    if (svg) btnFit.innerHTML = svg;
    btnFit.className = ['btn', 'btn-ghost', 'btn-sm', 'icon-btn', actual ? 'is-fit' : 'is-actual'].join(' ');
    btnFit.title = label;
    btnFit.setAttribute('aria-label', label);
  }

  function updatePercent() {
    // clientWidth 是布局宽度，不受 transform 影响 —— 拿它换算出「相对原图多少」
    const natural = img.naturalWidth || 0;
    const laid = img.clientWidth || 0;
    if (!natural || !laid) return;
    pct.textContent = `${Math.round(((laid * scale) / natural) * 100)}%`;
    syncFitButton();
  }

  // 图比视口小的时候只让拖一小段（够晃一下就行），比视口大时按溢出的部分拖
  function clampOffset() {
    const w = (img.clientWidth || 0) * scale;
    const h2 = (img.clientHeight || 0) * scale;
    const mx = Math.max(0, (w - layer.clientWidth) / 2) + PAN_MARGIN;
    const my = Math.max(0, (h2 - layer.clientHeight) / 2) + PAN_MARGIN;
    offset.x = Math.min(mx, Math.max(-mx, offset.x));
    offset.y = Math.min(my, Math.max(-my, offset.y));
  }

  /** 以视口某点为锚缩放：那个点下面的画面保持不动。不传坐标就以视口中心为锚 */
  function zoomAt(factor, clientX, clientY) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (Math.abs(next - scale) < 1e-6) return;

    const cx = layer.clientWidth / 2;
    const cy = layer.clientHeight / 2;
    const ax = typeof clientX === 'number' ? clientX : cx;
    const ay = typeof clientY === 'number' ? clientY : cy;

    // 锚点在图片自身坐标系里的位置，缩放前后都不该动
    const qx = (ax - cx - offset.x) / scale;
    const qy = (ay - cy - offset.y) / scale;

    scale = next;
    offset.x = ax - cx - qx * scale;
    offset.y = ay - cy - qy * scale;

    clampOffset();
    apply();
    updatePercent();
  }

  /** 回到「适应窗口」：scale 1、居中 */
  function fitToWindow() {
    scale = 1;
    offset.x = 0;
    offset.y = 0;
    apply();
    updatePercent();
  }

  /**
   * 切到「实际大小」：图片按原始像素 1:1 显示。
   * scale 1 是「适应后的尺寸」，实际大小要反推回去 —— 原图比窗口小就是放大，
   * 比窗口大就是缩小。以视口中心为锚，切完大致还在中间。
   */
  function actualSize() {
    const natural = img.naturalWidth || 0;
    const laid = img.clientWidth || 0;
    if (!natural || !laid) return;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, natural / laid));
    offset.x = 0;
    offset.y = 0;
    clampOffset();
    apply();
    updatePercent();
  }

  /** 那个一键按钮：已经是实际大小就回适应，否则切到实际大小 */
  function toggleFit() {
    if (atActualSize()) fitToWindow();
    else actualSize();
  }

  // --- 拖动平移 + 点空白关闭 ---
  let drag = null;
  layer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // 工具条上的按钮自己处理点击。这里要是也对整层 setPointerCapture，指针就被夺走了：
    // 按钮收不到 click，pointerup 还会被判成「点了背景」把浮层一并关掉。
    if (event.target.closest && event.target.closest('.lightbox-bar')) return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
      id: event.pointerId,
      moved: false,
      // 「按在图片外那圈上」在这里就得记下来 —— 指针被捕获后 pointerup 的目标是整层，
      // 到那会儿再判断已经分不出按的是哪儿了。
      backdrop: event.target === layer
    };
    layer.classList.add('dragging');
    if (layer.setPointerCapture) layer.setPointerCapture(event.pointerId);
  });

  layer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) drag.moved = true;
    offset.x = drag.ox + dx;
    offset.y = drag.oy + dy;
    clampOffset();
    apply();
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    // 没拖动过、而且按的是图片外面那圈 —— 当成「点了背景，关掉」
    const clickedBackdrop = !drag.moved && drag.backdrop;
    drag = null;
    layer.classList.remove('dragging');
    if (clickedBackdrop) close();
  }
  layer.addEventListener('pointerup', endDrag);
  layer.addEventListener('pointercancel', endDrag);

  layer.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
    },
    { passive: false }
  );

  img.addEventListener('dblclick', (event) => {
    event.preventDefault();
    // 双击同样是在「适应」和「放大」之间切，放大档固定 2.5 倍
    if (scale > 1.05) fitToWindow();
    else zoomAt(DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
  });

  btnIn.addEventListener('click', () => zoomAt(ZOOM_STEP));
  btnOut.addEventListener('click', () => zoomAt(1 / ZOOM_STEP));
  btnFit.addEventListener('click', toggleFit);
  btnClose.addEventListener('click', () => close());

  // Esc 用捕获阶段拦下：底下的角色编辑器 / 弹窗也在听 Esc，
  // 不拦住的话会连它们一起关掉。
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(ZOOM_STEP);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAt(1 / ZOOM_STEP);
    } else if (event.key === '0') {
      // 和按钮一致：0 = 适应窗口（各家看图工具的惯例）
      event.preventDefault();
      fitToWindow();
    } else if (event.key === '1') {
      // 1 = 实际大小（1:1），和 0 配成一对
      event.preventDefault();
      actualSize();
    }
  }
  document.addEventListener('keydown', onKey, true);

  function close() {
    if (current !== close) return;
    current = null;
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
  }
  current = close;

  // 图片解码完再显出来，免得先看到一块空白
  const reveal = () => {
    layer.classList.add('ready');
    updatePercent();
  };
  img.addEventListener('load', reveal);
  img.addEventListener('error', reveal);
  if (img.complete) reveal();

  document.body.appendChild(layer);
  apply();
  updatePercent();
}
