'use strict';

// ============================================================================
//  views/requestLog.js —— 「请求记录」弹窗
//
//  一件事的两个视角：左边「最近发过哪几次」，右边「那一次到底发了什么」。
//  右边的 JSON 就是服务端收到的原文 —— system 提示词、带进去的每一轮、采样参数，
//  一个字段都不加工。
//
//  为什么值得有：用户拿官方网页版和本应用对比时，差异几乎总在**请求**里
//  （那边有官方预置的系统提示词，我们只发最近 N 轮、参数也是自己设的），
//  而请求以前是看不见的，只能靠猜。现在摊开就能自己看。
//
//  数据来自主进程的内存（main/request-log.js）：不落盘、不进 settings、重启即空。
//  所以它每次打开现拉一次就行，不向刷新总线登记
//  （和 views/perspectiveUi.js 一样，只做事件绑定）。
// ============================================================================

import { el } from '../core/dom.js';
import { api } from '../core/api.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';

/** 当前这一屏的记录（从新到旧） */
let entries = [];
/** 右边正在看哪一条（记 requestId） */
let selectedId = '';

const pad2 = (n) => String(n).padStart(2, '0');

function timeText(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 取**最后一条**用户消息的开头当小标题。
 * 取最后的而不是第一条：请求里带的是最近 N 轮，最后那条才是「我刚问的这句」——
 * 拿第一条会显示成一小时前那句话，对不上。
 */
function previewOf(entry) {
  const msgs = (entry.body && entry.body.messages) || [];
  let user = null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].role === 'user') {
      user = msgs[i];
      break;
    }
  }

  let text = '';
  if (user) {
    const content = user.content;
    if (typeof content === 'string') text = content;
    // 带图的用户消息是多模态数组，文字散在 text 段里
    else if (Array.isArray(content)) text = content.map((part) => (part && part.text) || '').join(' ');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '（只发了图片，或还没开口）';
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** 一行小字：这次带了多少条、以及三个采样参数 —— 对比网页版时最常看的就是这几个 */
function statsOf(entry) {
  const body = entry.body || {};
  const bits = [];
  if (Array.isArray(body.messages)) bits.push(`${body.messages.length} 条消息`);
  if (Number.isFinite(Number(body.temperature))) bits.push(`temp ${body.temperature}`);
  if (Number.isFinite(Number(body.max_tokens))) bits.push(`上限 ${body.max_tokens}`);
  if (Number.isFinite(Number(body.top_p))) bits.push(`top_p ${body.top_p}`);
  return bits.join(' · ');
}

function renderList() {
  if (!el.requestsList) return;
  clear(el.requestsList);

  if (!entries.length) {
    el.requestsList.appendChild(
      h('p', { class: 'requests-empty', text: '还没有记录 —— 发一条消息就会出现。' })
    );
    return;
  }

  for (const entry of entries) {
    el.requestsList.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: ['requests-item', entry.id && entry.id === selectedId && 'is-active'],
          'data-id': entry.id
        },
        h('span', { class: 'requests-item-top' }, [
          h('span', { class: 'requests-item-time', text: timeText(entry.at) }),
          h('span', { class: 'requests-item-model', text: (entry.body && entry.body.model) || '（没写模型名）' })
        ]),
        h('span', { class: 'requests-item-preview', text: previewOf(entry) }),
        h('span', { class: 'requests-item-stats', text: statsOf(entry) })
      )
    );
  }
}

function renderDetail() {
  if (!el.requestsJson) return;

  const entry = entries.find((item) => item.id === selectedId);
  if (!entry) {
    el.requestsSummary.textContent = '从左边选一次请求';
    el.requestsJson.textContent = entries.length
      ? '从左边选一次请求，这里显示它发出去的原文。'
      : '发一条消息，这里就会出现它实际发出去的完整内容。';
    if (el.btnCopyRequest) el.btnCopyRequest.disabled = true;
    return;
  }

  el.requestsSummary.textContent = `${timeText(entry.at)} · ${entry.url || '（地址没记到）'}`;
  el.requestsJson.textContent = JSON.stringify(entry.body, null, 2);
  if (el.btnCopyRequest) el.btnCopyRequest.disabled = false;
}

async function openRequestLog() {
  const result = await api.requestLog();
  entries = (result && result.entries) || [];
  if (el.requestsMax) el.requestsMax.textContent = String((result && result.max) || entries.length || 0);

  // 默认选中最新那条：点进来多半就是想看「刚才那次到底发了什么」。
  // 但如果用户上次选过、而那条还在（没被挤出 20 条之外），就保留他的选择。
  if (!entries.some((entry) => entry.id === selectedId)) {
    selectedId = entries[0] ? entries[0].id : '';
  }

  renderList();
  renderDetail();
  el.requestsModal.classList.remove('hidden');
}

/** 关弹窗。导出是为了让入口层的 Esc 链统一关它（见 main.js） */
export function closeRequestLog() {
  if (!el.requestsModal) return;
  el.requestsModal.classList.add('hidden');
  el.input.focus();
}

/** 事件绑定（在 init() 里调用） */
export function initRequestLog() {
  if (!el.btnRequestLog || !el.requestsModal) return;

  el.btnRequestLog.addEventListener('click', openRequestLog);
  el.btnCloseRequests.addEventListener('click', closeRequestLog);
  el.requestsModal.addEventListener('click', (event) => {
    if (event.target === el.requestsModal) closeRequestLog();
  });

  el.requestsList.addEventListener('click', (event) => {
    const target = event.target;
    const item = target && target.closest ? target.closest('.requests-item') : null;
    if (!item) return;
    selectedId = item.getAttribute('data-id') || '';
    renderList();
    renderDetail();
  });

  el.btnCopyRequest.addEventListener('click', async () => {
    const entry = entries.find((item) => item.id === selectedId);
    if (!entry) return;
    await api.copyText(JSON.stringify(entry.body, null, 2));
    showToast('已复制这次请求的 JSON', 'ok');
  });

  // 不弹确认：这份记录本来就是临时的（重启就空），问一句反而啰嗦
  el.btnClearRequests.addEventListener('click', async () => {
    await api.clearRequestLog();
    entries = [];
    selectedId = '';
    renderList();
    renderDetail();
    showToast('请求记录已清空', 'ok');
  });
}
