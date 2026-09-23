'use strict';

// ============================================================================
//  views/stream.js —— 流式文字的重绘 + 自动跟随滚动
//
//  这里是「文字一顿一顿往外冒」的关键，三件事：
//    1. 不设时间节流，用 requestAnimationFrame 每帧都画。
//       之前限成 50ms（每秒 20 次），而模型每秒吐 20~60 个 token，
//       于是每次重绘都攒下好几个字一起蹦出来 —— 就是「几个字几个字」的来源。
//       每帧画（最多 60 次/秒）后，每个 token 到达后最多一帧就显示出来。
//    2. 记住上次渲染出的 HTML，内容没变就完全不碰 DOM。
//       rAF 在没有新 token 时也会继续触发，靠这个判断避免空转重排。
//    3. 只有真的重绘了才去滚动（见 scrollToBottom 的注释）。
//  注：innerHTML 是整棵子树重建，但实测代价很小（几千字也就 1~2ms），
//      60 次/秒完全撑得住；真正贵的是读 scrollHeight 触发的强制同步布局。
//
//  为什么单独一个模块：绘制（streamPainter）、滚动（scrollToBottom）、
//  「用户在看历史就别拽他」这三件事同时被三处需要 ——
//  入口层的分片接收、composer 的收尾（stop）、messageList 的重绘（scrollToBottom）。
//  谁都不该为了它去 import 另一个功能模块。
// ============================================================================

import { CONFIG } from '../core/config.js';
import { el } from '../core/dom.js';
import { renderMarkdown } from '../ui/markdown.js';

// 用户自己往上翻看历史时，不要被流式输出拽回底部
let userReadingHistory = false;

export function scrollToBottom(force) {
  if (force) userReadingHistory = false;
  if (userReadingHistory) return;

  // 直接给一个远大于最大值的数，浏览器会自动夹到最底部。
  // 不读 scrollHeight 是故意的：读它会强制一次同步布局（reflow），
  // 而流式输出时这里每 50ms 就跑一次，长对话下这个开销很明显。
  // 写 scrollTop 则可以让浏览器把布局推迟到下一个渲染帧。
  el.messages.scrollTop = 1e9;
}

export const streamPainter = (() => {
  let rafId = null;
  let node = null;
  let text = null;
  let lastHtml = null;

  function schedule() {
    if (rafId === null) rafId = requestAnimationFrame(paint);
  }

  function paint() {
    rafId = null;
    if (!node || text === null) return;

    const html = renderMarkdown(text, { streaming: true });
    if (html === lastHtml) return; // 没有新内容，不做任何 DOM 操作

    lastHtml = html;
    node.innerHTML = html;
    scrollToBottom(false);
  }

  return {
    push(target, value) {
      if (target !== node) {
        // 换了目标节点，缓存作废
        node = target;
        lastHtml = null;
      }
      text = value;
      schedule();
    },
    stop() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      node = null;
      text = null;
      lastHtml = null;
    }
  };
})();

/** 绑「用户在看历史就别自动跟随」这一段（挂在消息区上，只绑一次） */
export function initStreamFollow() {
  // 滚轮往上滑 = 用户在读历史，暂停自动跟随
  el.messages.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY < 0) {
        userReadingHistory = true;
      } else {
        const box = el.messages;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < CONFIG.SCROLL_BOTTOM_THRESHOLD;
        if (atBottom) userReadingHistory = false;
      }
    },
    { passive: true }
  );
}
