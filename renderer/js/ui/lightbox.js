'use strict';

// ============================================================================
//  ui/lightbox.js —— 点开一张图放大看
//
//  角色库卡片上的形象、聊天里的图都走这里：铺满一层，滚轮 / 按钮缩放，
//  按住拖动平移，双击在「适应窗口」和 2.5 倍之间来回切。
//
//  缩放以指针位置为锚点 —— 滚轮指到哪，那块画面就不动，放大时不用再找位置。
//  1 倍 = 图片按窗口自适应后的尺寸（不是原始像素），工具条上的百分比按
//  原始像素算，所以小图点开显示的会是 100% 以上。
//
//  同一时间只开一层，再开一张会先把上一张关掉。
// ============================================================================

import { h } from './build.js';

const MIN_SCALE = 0.15;
const MAX_SCALE = 10;
// 滚轮 / 加减号每一档的倍数
const ZOOM_STEP = 1.15;
const DOUBLE_CLICK_SCALE = 2.5;
// 松手时位移不超过这么多像素，算「点了一下」而不是「拖过」
const CLICK_SLOP = 4;
// 缩放后图片边缘之外还留这么多像素可以拖出去，免得图一放大就出不了视野
const PAN_MARGIN = 80;

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

  const btnOut = h('button', {
    id: 'lightbox-out',
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '−',
    title: '缩小',
    ariaLabel: '缩小'
  });
  const btnIn = h('button', {
    id: 'lightbox-in',
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '＋',
    title: '放大',
    ariaLabel: '放大'
  });
  const btnReset = h('button', {
    id: 'lightbox-reset',
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '适应',
    title: '回到适应窗口',
    ariaLabel: '适应窗口'
  });
  const btnClose = h('button', {
    id: 'lightbox-close',
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '关闭',
    title: '关闭（Esc）'
  });

  const bar = h(
    'div',
    { class: 'lightbox-bar' },
    title ? h('span', { class: 'lightbox-title', text: title }) : null,
    h('span', { class: 'lightbox-zoom' }, btnOut, pct, btnIn),
    h('span', { class: 'lightbox-actions' }, btnReset, btnClose),
    h('span', { class: 'lightbox-hint', text: '滚轮缩放 · 拖动平移 · 双击切换' })
  );

  const layer = h('div', { class: 'lightbox', id: 'lightbox' }, img, bar);

  function apply() {
    img.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
  }

  function updatePercent() {
    // clientWidth 是布局宽度，不受 transform 影响 —— 拿它换算出「相对原图多少」
    const natural = img.naturalWidth || 0;
    const laid = img.clientWidth || 0;
    if (!natural || !laid) return;
    pct.textContent = `${Math.round(((laid * scale) / natural) * 100)}%`;
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

  function reset() {
    scale = 1;
    offset.x = 0;
    offset.y = 0;
    apply();
    updatePercent();
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
    if (scale > 1.05) reset();
    else zoomAt(DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
  });

  btnIn.addEventListener('click', () => zoomAt(ZOOM_STEP));
  btnOut.addEventListener('click', () => zoomAt(1 / ZOOM_STEP));
  btnReset.addEventListener('click', reset);
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
      event.preventDefault();
      reset();
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
