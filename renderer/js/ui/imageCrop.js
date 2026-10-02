'use strict';

// ============================================================================
//  ui/imageCrop.js —— 选好图之后、存下来之前，框一下要哪一块
//
//  两处用：角色头像（1:1）、角色形象（2:3）。存下来的比例是固定的，
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
 * 把宽高比拆成整数对。传进来的 aspect 多半是 `2 / 3` 这种浮点值，
 * 直接拿它做除法和取整会一路带歪（340 / (2/3) = 510.0000 → 510，
 * 但换个比例比如 3/4：340 / 0.75 = 453.33 → 453，453/340 = 1.3324 ≠ 4/3，
 * 输出就成了 1024×1364）。这里把它还原成 [2, 3]，后面的尺寸全用整数算。
 */
function ratio(aspect) {
  const a = Number(aspect);
  if (!Number.isFinite(a) || a <= 0) return [1, 1];
  // 常见比例直接给整数，省得靠浮点反推（1:1 / 2:3 / 3:2 / 3:4 / 4:3 够用了）
  for (let h = 1; h <= 16; h += 1) {
    const w = a * h;
    if (Math.abs(w - Math.round(w)) < 1e-9) return [Math.round(w), h];
  }
  // 兜底：放大到百万分之一精度再约分
  return [Math.round(a * 1000), 1000];
}

/**
 * 不弹界面，直接把一张图按比例**从顶部对齐**裁好、缩到 outWidth、转成 dataURL。
 * 给「批量导入表情图」用 —— 二十几张逐个开裁剪浮层点确定，没人受得了。
 *
 * 为什么顶部对齐：差分素材都是「头顶对齐」的立绘，从上往下裁才不会把脸切掉
 * （和状态卡 .sc-photo 的 object-position: center top 是同一套对齐）。
 *
 * @param {string} dataUrl 原图
 * @param {object} options
 * @param {number} [options.aspect]   宽高比（1 = 正方形）
 * @param {number} [options.outWidth] 输出宽度（高度按 aspect 算）
 * @returns {Promise<string>} 裁好的 dataURL（解不开时 reject）
 */
export function cropTopToDataUrl(dataUrl, options) {
  const opts = options || {};
  const outWidth = Math.max(16, Math.round(Number(opts.outWidth) || 512));
  const [rw, rh] = ratio(Number(opts.aspect) || 1);
  const target = rw / rh;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const srcW = Math.max(1, image.naturalWidth);
      const srcH = Math.max(1, image.naturalHeight);

      // 在原图里取一块比例正确的最大矩形：先按宽度铺满，算出来太高就反过来按高度定
      let cw = srcW;
      let ch = Math.round(cw / target);
      if (ch > srcH) {
        ch = srcH;
        cw = Math.round(ch * target);
      }
      const ox = Math.round((srcW - cw) / 2);
      const oy = 0; // 顶部对齐，脸留在框里

      // 输出高度**从宽度按整数比算**，不借道裁剪框的取整结果（比例会歪）
      const w = Math.max(1, Math.min(outWidth, cw));
      const h = Math.max(1, Math.round((w * rh) / rw));

      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, ox, oy, cw, ch, 0, 0, w, h);

      let url = out.toDataURL('image/webp', 0.85);
      if (url.startsWith('data:image/')) return resolve(url);

      // 浏览器不支持编码 webp，给了张 PNG 回来，那就用它
      url = out.toDataURL('image/png');
      resolve(url.startsWith('data:image/') ? url : dataUrl);
    };
    image.onerror = () => reject(new Error('这张图解不开'));
    image.src = dataUrl;
  });
}

/**
 * 打开裁剪浮层。
 *
 * @param {object} options
 * @param {string} options.dataUrl   原图（dataURL）
 * @param {number} [options.aspect]  宽高比（1 = 正方形，2/3 = 竖版）
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

      // 比例一律按**整数**算（2:3 → [2, 3]）。aspect 是 2/3 这种浮点传进来的，
      // 拿它做除法/取整都会跑偏：340 / 0.75 = 453.33 → 453，453/340 就是 1.3324，
      // 不是 4/3 —— 视口比例一歪，输出尺寸跟着歪（1024×1536 会变成 1024×1364）。
      // 用整数比则 vh = vw * b / a，误差只来自一次取整。
      const [rw, rh] = ratio(aspect);

      // 视口尺寸：先按宽度取上限，再按窗口高度收 —— 太高的竖图不能顶到屏幕外
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.52, 460));
      let vw = Math.round(Math.min(VIEW_MAX_W, Math.max(180, window.innerWidth - 120)));
      let vh = Math.round((vw * rh) / rw);
      if (vh > maxH) {
        vh = Math.round(maxH);
        vw = Math.round((vh * rw) / rh);
      }

      // scale = 原图 1px 在视口里占几 px。minScale 是「图片刚够铺满视口」，
      // 低于它就露出空白，所以是缩放下限。
      const minScale = Math.max(vw / image.width, vh / image.height);
      // 理论上限：取景框最多只能缩到原图的 1 个像素（再小就是凭空放大），
      // 即 scale 不超过 1。再加上「别超过目标输出的像素数」——
      // 这样默认停在「刚好够目标尺寸」，图省事的用户不用手动缩放就能拿到全清晰度，
      // 想裁小一点他自己往里推。留一点余量让手感不至于顶死。
      const fitForOutput = vw / outWidth;
      const maxScale = Math.max(minScale, Math.min(1, fitForOutput) * ZOOM_RANGE);

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
        // 高度**直接从 w 按整数比算**：w * rh / rw。
        // 中间不能借道视口的取整结果 —— vw/vh 一取整比例就歪了（340 / 453 = 1.3324），
        // 拿它换算出来是 1365 而不是 1536。
        const h = Math.max(1, Math.round((w * rh) / rw));

        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;

        // 落笔范围和输出同比例，图片不会被拉扁
        const k = w / vw;
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(image, ox * k, oy * k, image.width * scale * k, image.height * scale * k);

        // 先按 1.0 存 webp（在有损编码里已经到顶，肉眼看不出区别了）。它体积只有
        // PNG 的 1/3 左右 —— 而这个文件每存一次角色就要整个重写一遍，体积是实打实的成本。
        let url = out.toDataURL('image/webp', 1);
        if (url.startsWith('data:image/')) return url;

        // 浏览器给了张 PNG 回来，说明它压根不支持编码 webp —— 那就直接用这张。
        // 少走「先试 webp 再转 PNG」那一趟，也省得把图重新编码一遍掉细节。
        url = out.toDataURL('image/png');
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
