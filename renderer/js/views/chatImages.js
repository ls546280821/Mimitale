'use strict';

// ============================================================================
//  views/chatImages.js —— 给 AI 看图（选图 / 压缩 / 待发条 / 气泡里的图 / 配图）
//
//  图片跟着**用户消息**走：message.images = [dataURL, ...]。
//  发请求时把这条消息的 content 从字符串换成多模态数组
//   （[{type:'text'},{type:'image_url'}...]）—— 那一步在 data/messages.js。
//  这里只管「怎么把图弄到手、怎么显示出来」。
//
//  模型得**自己支持视觉**才行 —— 这不需要另外接一个模型，但文本模型收到图会报错。
//  所以这里不做拦截（拦了用户会莫名其妙找不到按钮），而是失败了再给一句明确提示。
//
//  两个动作由入口层注入（视图不向上 import 入口）：
//    · rerender     —— 配图成功后要重绘整个对话区
//    · openSettings —— 没配生图时要把用户带去设置
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { persistConversations } from '../data/persist.js';
import { cleanAssistantText, convoPanelFields, panelGroupNames } from '../data/panel.js';
import { messageImages } from '../data/messages.js';

// 一张图最长边压到多少再发。视觉模型内部一般也就缩到这个量级，
// 传原图只是白烧 token 和流量
const CHAT_IMAGE_MAX_EDGE = 1024;
// 单张压完之后的体积上限（base64 字符数）。超了就再压一档
const CHAT_IMAGE_MAX_CHARS = 1600000;
// 一条消息最多带几张
const CHAT_IMAGE_MAX_COUNT = 6;

// 输入框里待发送的图片
let pendingImages = [];

// 入口层注入的两个动作（见文件头）
let actions = { rerender: () => {}, openSettings: () => {} };

/** 待发图（副本 —— 调用方拿到之后随便处理，不影响这里的列表） */
export function getPendingImages() {
  return pendingImages.slice();
}

/** 发出去之后清空待发条 */
export function clearPendingImages() {
  pendingImages = [];
  renderAttachStrip();
}

/**
 * 聊天图片压缩：等比缩到最长边 1024，再转 webp。
 * 和背景图那套一样只缩不裁（裁了内容就变了）。
 */
function shrinkChatImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // 先按 0.82 压；还是太大就降到 0.6 —— 宁可糊一点也别把请求撑爆
        let out = canvas.toDataURL('image/webp', 0.82);
        if (!out.startsWith('data:image/')) {
          out = canvas.toDataURL('image/jpeg', 0.85);
        }
        if (out.length > CHAT_IMAGE_MAX_CHARS && out.startsWith('data:image/webp')) {
          out = canvas.toDataURL('image/webp', 0.6);
        }
        resolve(out.startsWith('data:image/') ? out : dataUrl);
      } catch (err) {
        resolve(dataUrl);
      }
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** 收下一张图：压缩 → 进待发列表 → 重画 */
async function addPendingImage(dataUrl) {
  if (!dataUrl) return;

  if (pendingImages.length >= CHAT_IMAGE_MAX_COUNT) {
    showToast(`一条消息最多带 ${CHAT_IMAGE_MAX_COUNT} 张图`, 'error');
    return;
  }

  const shrunk = await shrinkChatImage(dataUrl);
  pendingImages.push(shrunk);
  renderAttachStrip();
}

/** 点「加图」：走主进程的文件选择框 */
async function pickChatImages() {
  let result;
  try {
    result = await api.pickImage({ title: '选择要发给 AI 的图片' });
  } catch (err) {
    showToast((err && err.message) || '选择图片失败', 'error');
    return;
  }

  if (!result || result.canceled) return;
  if (!result.dataUrl) {
    showToast(result.error || '这张图用不了', 'error');
    return;
  }
  await addPendingImage(result.dataUrl);
}

/** 把剪贴板 / 拖进来的一批文件变成图片收下 */
export async function addImageFiles(files) {
  const images = Array.from(files || []).filter((f) => f && String(f.type || '').startsWith('image/'));
  if (!images.length) return false;

  for (const file of images) {
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    await addPendingImage(dataUrl);
  }
  return true;
}

export function renderAttachStrip() {
  clear(el.attachStrip);
  el.attachStrip.classList.toggle('hidden', !pendingImages.length);

  pendingImages.forEach((src, index) => {
    const thumb = h('div', { class: 'attach-item' }, h('img', { src, alt: '' }));
    thumb.appendChild(
      button({
        class: 'attach-del',
        text: '×',
        title: '不发了',
        ariaLabel: `移除第 ${index + 1} 张图`,
        onClick: () => {
          pendingImages.splice(index, 1);
          renderAttachStrip();
        }
      })
    );
    el.attachStrip.appendChild(thumb);
  });
}

/** 消息气泡里的图（用户发的 + AI 生成的都走这里） */
export function buildMessageImages(message) {
  const images = messageImages(message);
  if (!images.length) return null;

  const wrap = h('div', { class: 'bubble-images' });
  for (const src of images) {
    // 点开看大图：直接 window.open 会被 CSP 拦，交给主进程弹一个窗口
    wrap.appendChild(
      h('img', {
        class: 'bubble-image',
        src,
        alt: '图片',
        title: '点开看大图',
        onclick: () => api.openImage(src).catch(() => showToast('打不开这张图', 'error'))
      })
    );
  }
  return wrap;
}

/**
 * 给某条 AI 回复配一张插画。
 *
 * 用的是**生图那一组独立配置**（服务商 + 模型），和聊天模型无关 ——
 * 换生图模型不会影响这段对话的风格。
 *
 * 提示词直接取这条回复的正文（剥掉状态栏那几行），截一段给模型。
 */
export async function illustrateMessage(index) {
  const convo = activeConvo();
  if (!convo) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再配图');
    return;
  }

  const message = convo.messages[index];
  if (!message || message.role !== 'assistant') return;

  const settings = state.settings || {};
  if (!settings.imageProviderId) {
    showToast('还没有配置生图，请到「设置 → 生图」里选一个服务商', 'error');
    actions.openSettings();
    return;
  }

  const panelFields = convoPanelFields(convo);
  const raw = cleanAssistantText(String(message.content || ''), panelFields, [...panelGroupNames(convo)]);
  // 去掉 markdown 标记和括号里的旁白符号，让提示词更像一句画面描述
  const prompt = raw
    .replace(/\*\*|==|~~|[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  if (!prompt) {
    showToast('这条回复没有可用来配图的文字', 'error');
    return;
  }

  const node = el.messages.querySelector(`.msg[data-index="${index}"]`);
  if (node) node.classList.add('illustrating');

  showToast('正在画…（可能要等十几秒）');

  try {
    const result = await api.generateImage({
      providerId: settings.imageProviderId,
      model: settings.imageModel,
      size: settings.imageSize,
      prompt
    });

    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || '生图失败');
    }

    // 生成的图（PNG 通常一两 MB）先压一档再存进会话，
    // 不然几张图就能把 conversations.json 撑到几十 MB
    const shrunk = await shrinkChatImage(result.dataUrl);
    if (!Array.isArray(message.images)) message.images = [];
    message.images.push(shrunk);
    message.imageModel = result.model || settings.imageModel;

    convo.updatedAt = now();
    persistConversations(0);
    actions.rerender({ forceScroll: false });
    showToast('画好了', 'ok');
  } catch (err) {
    showToast((err && err.message) || '生图失败', 'error');
  } finally {
    if (node) node.classList.remove('illustrating');
  }
}

/** 绑定加图按钮。rerender / openSettings 由入口层注入 */
export function initChatImages(injected) {
  actions = { rerender: () => {}, openSettings: () => {}, ...(injected || {}) };
  el.btnAttach.addEventListener('click', pickChatImages);
}
