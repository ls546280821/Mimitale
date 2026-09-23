'use strict';

// ============================================================================
//  views/appearance.js —— 对话窗口外观（字号 / 加粗颜色 / 背景图）
//
//  这三样只影响「怎么显示」，一个字都不会进提示词。
//  实现上都是往 <html> 上写 CSS 变量，样式表里用 var() 取 ——
//  这样换主题、换背景都不用重写一套规则。
//
//  入口层只从这儿取两个：
//    · applyChatAppearance()  启动时把设置里的外观刷到 CSS 变量上
//    · closeAppearanceModal() 全局 Esc 处理器要按固定顺序关弹窗 ——
//                             那是一条链，留在入口层，这里只提供「关这一个」
//  其余（打开、回填、落盘、选图、滑块）都由 initAppearance() 内部接线。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';

const CHAT_FONT_MIN = 12;
const CHAT_FONT_MAX = 22;
const CHAT_FONT_DEFAULT = 14;
// 没设自定义颜色时，色盘控件显示的主题色（只是给色盘一个初始值，不是生效值）
const BOLD_COLOR_FALLBACK = '#409eff';

/** 把当前设置里的外观写到 CSS 变量上（值空就删掉变量，退回样式表里的默认） */
export function applyChatAppearance() {
  const s = state.settings || {};
  const root = document.documentElement;

  const size = Number(s.chatFontSize);
  const px = Number.isFinite(size) && size >= CHAT_FONT_MIN && size <= CHAT_FONT_MAX ? size : CHAT_FONT_DEFAULT;
  root.style.setProperty('--chat-font-size', `${px}px`);

  if (s.chatBoldColor) root.style.setProperty('--chat-bold-color', s.chatBoldColor);
  else root.style.removeProperty('--chat-bold-color');

  // dataURL 里不会出现引号，包一层更保险
  if (s.chatBackground) root.style.setProperty('--chat-bg-image', `url("${s.chatBackground}")`);
  else root.style.removeProperty('--chat-bg-image');
}

/** 滑块的「已选比例」是 CSS 渐变画的，所以值一变就得把 --range-fill 同步过去 */
function syncRangeFill() {
  const input = el.appearanceFontSize;
  if (!input) return;

  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-fill', `${pct}%`);
}

/** 外观面板里各控件的当前值（从内存里的设置读，不读 DOM —— 打开时要用它回填） */
function renderAppearanceForm() {
  const s = state.settings || {};

  const size = Number(s.chatFontSize);
  const px = Number.isFinite(size) && size >= CHAT_FONT_MIN && size <= CHAT_FONT_MAX ? Math.round(size) : CHAT_FONT_DEFAULT;
  el.appearanceFontSize.value = String(px);
  el.appearanceFontSizeValue.textContent = `${px}px`;
  syncRangeFill();

  el.appearanceBoldColorText.value = s.chatBoldColor || '';
  el.appearanceBoldColor.value = s.chatBoldColor || BOLD_COLOR_FALLBACK;

  const bg = s.chatBackground || '';
  el.appearanceBgPreview.innerHTML = '';
  if (bg) {
    const img = document.createElement('img');
    img.src = bg;
    img.alt = '';
    el.appearanceBgPreview.appendChild(img);
  }
  el.appearanceBgPreview.classList.toggle('hidden', !bg);
  el.btnClearBg.disabled = !bg;
}

/** 改一项外观：立刻生效 + 落盘 */
async function persistAppearance(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  applyChatAppearance();
  renderAppearanceForm();

  try {
    // 主进程会把不合法/超限的值洗掉，所以用它的返回值覆盖本地
    state.settings = await api.saveSettings(patch);
  } catch (err) {
    console.error('保存外观设置失败', err);
    showToast('外观没能保存到磁盘', 'error');
    return;
  }
  applyChatAppearance();
  renderAppearanceForm();
}

/**
 * 背景图先压到最长边 1920 再存。
 * 头像那套是「居中裁成正方形」，背景不能裁 —— 裁了就变形，所以只等比缩。
 */
function shrinkBackground(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const max = 1920;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // 背景图不需要透明，webp 有透明通道也不亏；压到 0.82 体积和观感比较平衡
        const out = canvas.toDataURL('image/webp', 0.82);
        resolve(out.startsWith('data:image/') ? out : dataUrl);
      } catch (err) {
        resolve(dataUrl);
      }
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function pickChatBackground() {
  let result;
  try {
    result = await api.pickImage();
  } catch (err) {
    showToast((err && err.message) || '选择图片失败', 'error');
    return;
  }

  if (!result || result.canceled) return;
  if (!result.dataUrl) {
    showToast(result.error || '这张图片用不了', 'error');
    return;
  }

  showToast('正在压缩背景图…');
  const shrunk = await shrinkBackground(result.dataUrl);
  await persistAppearance({ chatBackground: shrunk });
  showToast('背景图已换上', 'ok');
}

/**
 * 文本框里可能是 #abc / #aabbcc / #aabbccdd，也可能带不带 #。
 * 认不出来就返回 null（调用方提示一下，不要静默丢掉）。
 */
function normalizeHexColor(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (!t.startsWith('#')) t = `#${t}`;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t) ? t.toLowerCase() : null;
}

function openAppearanceModal() {
  renderAppearanceForm();
  el.appearanceModal.classList.remove('hidden');
}

export function closeAppearanceModal() {
  el.appearanceModal.classList.add('hidden');
  el.input.focus();
}

/** 绑定外观弹窗的所有事件（打开 / 关闭 / 字号 / 配色 / 背景图） */
export function initAppearance() {
  // 对话窗口外观：改完立即生效 + 落盘，所以没有「保存」按钮
  el.btnAppearance.addEventListener('click', openAppearanceModal);
  el.btnCloseAppearance.addEventListener('click', closeAppearanceModal);
  el.btnCloseAppearance2.addEventListener('click', closeAppearanceModal);
  el.appearanceModal.addEventListener('click', (event) => {
    if (event.target === el.appearanceModal) closeAppearanceModal();
  });

  // 字号：拖动时实时预览，松手才落盘 —— 不然拖一次要写几十遍配置文件
  el.appearanceFontSize.addEventListener('input', () => {
    const px = Number(el.appearanceFontSize.value);
    el.appearanceFontSizeValue.textContent = `${px}px`;
    syncRangeFill();
    state.settings = { ...(state.settings || {}), chatFontSize: px };
    applyChatAppearance();
  });
  el.appearanceFontSize.addEventListener('change', () => {
    persistAppearance({ chatFontSize: Number(el.appearanceFontSize.value) });
  });

  // 加粗颜色：和字号一个道理 —— 色盘拖动时 input 每帧都触发，
  // 只预览不落盘（不然拖一次色盘要写几十次配置文件），松手（change）才落盘。
  // 手填的等回车/失焦再认
  el.appearanceBoldColor.addEventListener('input', () => {
    const hex = el.appearanceBoldColor.value;
    state.settings = { ...(state.settings || {}), chatBoldColor: hex };
    el.appearanceBoldColorText.value = hex;
    applyChatAppearance();
  });
  el.appearanceBoldColor.addEventListener('change', () => {
    persistAppearance({ chatBoldColor: el.appearanceBoldColor.value });
  });
  el.appearanceBoldColorText.addEventListener('change', () => {
    const hex = normalizeHexColor(el.appearanceBoldColorText.value);
    if (hex === null) {
      showToast('颜色要写成 #rgb 或 #rrggbb，比如 #e06c75', 'error');
      renderAppearanceForm();
      return;
    }
    persistAppearance({ chatBoldColor: hex });
  });
  el.btnBoldColorReset.addEventListener('click', () => persistAppearance({ chatBoldColor: '' }));

  el.btnPickBg.addEventListener('click', pickChatBackground);
  el.btnClearBg.addEventListener('click', () => persistAppearance({ chatBackground: '' }));
}
