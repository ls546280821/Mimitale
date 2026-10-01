'use strict';

// ============================================================================
//  ui/imageCrop.js —— 选好图之后、存下来之前，框一下要哪一块
//
//  两处用：角色头像（1:1）、角色形象（3:4）。存下来的比例是固定的，
//  所以这里不提供自由比例 —— 界面上只有「拖动 / 缩放 / 确定」三件事，
//  框住的那块就是最终存下来的那块。
//
//  视口用 canvas 直接绘制（拖动和缩放都是重画，不走 CSS transform）——
//  这样屏幕上看到的裁剪结果和输出的像素是同一套坐标，不存在对不齐。
//
//  只用 canvas 标准 API，零依赖。返回 Promise<string|null>：
//  确定得到 dataURL，取消（按钮 / Esc / 点空白）得 null。
// ============================================================================

import { h } from './build.js';

// 视口宽度上限；实际会再按窗口高度收一档，保证高窗口里也放得下
const VIEW_MAX_W = 340;
// 允许放大到「刚好铺满视口」的几倍
const ZOOM_RANGE = 4;

/**
 * 打开裁剪浮层。
 *
 * @param {object} options
 * @param {string} options.dataUrl   原图（dataURL）
 * @param {number} [options.aspect]  宽高比（1 = 正方形，3/4 = 竖版）
 * @param {number} [options.outWidth] 输出宽度（高度按 aspect 算）
 * @param {string} [options.title]   浮层标题
 * @param {string} [options.hint]    标题下的一行说明
 * @returns {Promise<string|null>} 裁剪后的 dataURL，取消为 null
 */
export function openImageCrop({ dataUrl, aspect = 1, outWidth = 512, title = '裁剪图片', hint = '' }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => build(img);
    img.src = dataUrl;

    // 浮层建好之后就一直挂在这儿，直到用户确定 / 取消 —— 两条路都调 resolve
    function build(image) {
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      // 视口尺寸：先按宽度取上限，再按窗口高度收 —— 太高的竖图不能顶到屏幕外
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.52, 460));
      let vw = Math.min(VIEW_MAX_W, Math.max(180, window.innerWidth - 120));
      let vh = vw / aspect;
      if (vh > maxH) {
        vh = maxH;
        vw = vh * aspect;
      }

      const minScale = Math.max(vw / image.width, vh / image.height);
      const maxScale = minScale * ZOOM_RANGE;

      // 当前变换：图片左上角相对视口左上角的位移 + 缩放倍数
      let scale = minScale;
      let ox = (vw - image.width * scale) / 2;
      let oy = (vh - image.height * scale) / 2;

      const canvas = h('canvas', { class: 'crop-canvas' });
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;

      const ctx = canvas.getContext('2d');

      // 图片永远铺满视口（不留空白边）：位移夹在「图片边缘贴着视口边缘」之间
      function clamp() {
        const w = image.width * scale;
        const hh = image.height * scale;
        ox = Math.min(0, Math.max(vw - w, ox));
        oy = Math.min(0, Math.max(vh - hh, oy));
      }

      function draw() {
        clamp();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, vw, vh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, ox, oy, image.width * scale, image.height * scale);
      }

      /** 以视口内某点为锚缩放：那个点下面的画面保持不动 */
      function zoomTo(next, anchorX, anchorY) {
        const from = scale;
        const to = Math.min(maxScale, Math.max(minScale, next));
        if (Math.abs(to - from) < 1e-6) return;
        ox = anchorX - (anchorX - ox) * (to / from);
        oy = anchorY - (anchorY - oy) * (to / from);
        scale = to;
        draw();
        syncZoomInput();
      }

      // --- 视口：拖拽平移 + 滚轮缩放 ---
      const view = h('div', { class: 'crop-view', id: 'crop-view' }, canvas);

      let drag = null;
      view.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        drag = { x: event.clientX, y: event.clientY, ox, oy, id: event.pointerId };
        view.classList.add('dragging');
        if (view.setPointerCapture) view.setPointerCapture(event.pointerId);
      });
      view.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        ox = drag.ox + (event.clientX - drag.x);
        oy = drag.oy + (event.clientY - drag.y);
        draw();
      });
      const endDrag = (event) => {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        drag = null;
        view.classList.remove('dragging');
      };
      view.addEventListener('pointerup', endDrag);
      view.addEventListener('pointercancel', endDrag);

      view.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const rect = view.getBoundingClientRect();
          zoomTo(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
        },
        { passive: false }
      );

      // --- 缩放滑块：和滚轮共用 zoomTo，两者永远一致 ---
      const zoomInput = h('input', {
        id: 'crop-zoom',
        class: 'crop-zoom',
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        'aria-label': '缩放'
      });

      function syncZoomInput() {
        const value = Math.round(((scale - minScale) / (maxScale - minScale)) * 100);
        if (Number(zoomInput.value) !== value) zoomInput.value = String(value);
      }

      zoomInput.addEventListener('input', () => {
        const next = minScale + (maxScale - minScale) * (Number(zoomInput.value) / 100);
        zoomTo(next, vw / 2, vh / 2);
      });

      // --- 输出：按视口这块直接缩放画到目标尺寸 ---
      function output() {
        // 视口框住的这块，在原图上本来有多少像素（scale = 图上 1px 在视口里占几 px）。
        // 目标尺寸比它大就按原样输出 —— 放大只是把同一份信息摊得更糊、文件更大，
        // 一个细节都补不出来（老卡里的小图尤其明显）。
        const srcWidth = Math.max(1, Math.round(vw / scale));
        const w = Math.max(1, Math.min(outWidth, srcWidth));
        const h = Math.max(1, Math.round(w / aspect));

        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;

        const k = w / vw;
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(image, ox * k, oy * k, image.width * scale * k, image.height * scale * k);

        // webp 体积小又支持透明；浏览器不支持时会自动退回 png
        let url = out.toDataURL('image/webp', 0.94);
        if (!url.startsWith('data:image/')) url = out.toDataURL('image/png');
        return url.startsWith('data:image/') ? url : dataUrl;
      }

      // --- 组装浮层 ---
      const head = h(
        'div',
        { class: 'crop-head' },
        h('div', { class: 'crop-heading' },
          h('span', { class: 'crop-title', text: title }),
          hint ? h('span', { class: 'crop-hint', text: hint }) : null
        )
      );

      const zoomRow = h(
        'div',
        { class: 'crop-zoom-row' },
        h('span', { class: 'crop-zoom-label', text: '小' }),
        zoomInput,
        h('span', { class: 'crop-zoom-label', text: '大' })
      );

      const btnCancel = h('button', {
        id: 'crop-cancel',
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '取消'
      });
      const btnOk = h('button', {
        id: 'crop-ok',
        class: 'btn btn-primary btn-sm',
        type: 'button',
        text: '用这块'
      });

      const foot = h(
        'div',
        { class: 'crop-foot' },
        h('span', { class: 'field-help', text: '拖动画面移动，滚轮或滑块缩放。' }),
        h('span', { class: 'crop-foot-btns' }, btnCancel, btnOk)
      );

      const overlay = h(
        'div',
        { class: 'crop-layer', id: 'crop-layer' },
        h('div', { class: 'crop-card', role: 'dialog', 'aria-modal': 'true' }, head, view, zoomRow, foot)
      );

      function shut(result) {
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
        resolve(result);
      }

      // Esc 用捕获阶段拦下：底下的角色编辑器也在听 Esc（冒泡阶段），
      // 不拦住的话关掉的是整个编辑器。
      const keyHandler = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        shut(null);
      };

      btnCancel.addEventListener('click', () => shut(null));
      btnOk.addEventListener('click', () => shut(output()));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) shut(null);
      });
      document.addEventListener('keydown', keyHandler, true);

      document.body.appendChild(overlay);
      draw();
      syncZoomInput();
      view.focus?.();

      return new Promise(() => {}); // 结果由 shut() 直接 resolve 外层
    }
  });
}
