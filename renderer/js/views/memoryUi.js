'use strict';

// ============================================================================
//  views/memoryUi.js —— 记忆管理 + 存档点
//
//  「分段记忆摘要」（把较早的对话压成摘要、原文丢弃）和「存档点」（整段对话
//  快照）在界面上是**同一个弹窗**：上面是摘要列表，下面是存档点列表。
//  既然共用一个容器、互相触发重画，它们就必须住在一个文件里 ——
//  拆成两个模块就是两个视图互相 import。
//
//  本模块 = 界面 + 面板上的动作：
//    · 头部的记忆段数指示器（登记在刷新总线上）
//    · 弹窗的开关与重画
//    · 摘要的编辑 / 重新生成 / 删除 / 清空
//    · 存档点的存 / 读 / 删
//
//  「什么时候该自动压一段」是后台调度，留在 main.js 的 maybeSummarize()——
//  它由聊天流程触发，而且压缩开始/结束要改头部的「正在整理记忆…」提示，
//  而 header 还没拆出来。等 header 独立成模块时再考虑把它归位。
//  「手动压一段」按钮（summarizeNow）同理留在 main.js。
//
//  摘要的参数、纯逻辑（区间计算 / 提示词 / 转录 / 请求）都在 data/memory.js，
//  运行态（summarizingConvos / summaryFailures）也在那儿 —— 两头都能向下取，
//  谁都不必认识谁。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, button, clear } from '../ui/build.js';
import { persistConversations } from '../data/persist.js';
import { convoPanel, convoPanelDefs, convoPanelFields, normalizePanelDefs } from '../data/panel.js';
import {
  SUMMARY_TRIGGER_MESSAGES,
  SUMMARY_MIN_MESSAGES,
  MAX_SUMMARY_CHARS,
  convoContextMessages,
  convoSummaries,
  nextSegmentTitle,
  buildTranscript,
  pendingSummaryRange,
  generateSummary,
  summarizingConvos,
  summaryFailures,
  charNameForSummary
} from '../data/memory.js';
import { onRefresh, refreshAll } from './refresh.js';

// ---------------------------------------------------------------------------
//  记忆指示器（头部那个小圆点 + 段数）
// ---------------------------------------------------------------------------

let memoryEditingId = null; // 正在编辑的摘要段

export function renderMemoryIndicator() {
  const convo = activeConvo();
  const count = convo ? convoSummaries(convo).length : 0;

  el.memoryCount.classList.toggle('hidden', count === 0);
  el.memoryCount.textContent = String(count);
  el.btnMemory.title = count
    ? `已压缩 ${count} 段早期剧情`
    : '较早的对话会自动压成摘要';
}

// ---------------------------------------------------------------------------
//  弹窗开关
// ---------------------------------------------------------------------------

export function openMemoryModal() {
  const convo = activeConvo();
  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  memoryEditingId = null;
  renderMemoryModal();
  el.memoryModal.classList.remove('hidden');
}

export function closeMemoryModal() {
  el.memoryModal.classList.add('hidden');
  el.input.focus();
}

// ---------------------------------------------------------------------------
//  摘要列表
// ---------------------------------------------------------------------------

export function renderMemoryModal() {
  const convo = activeConvo();
  if (!convo) return;

  const { messages, pending, covered } = pendingSummaryRange(convo);
  const list = convoSummaries(convo);

  el.memorySummaryLine.textContent = list.length
    ? `已压缩 ${list.length} 段，覆盖前 ${covered} / ${messages.length} 条消息`
    : '还没有摘要';
  el.memoryPendingLine.textContent = convo.summaryBusy
    ? '正在压缩…'
    : `未压缩 ${pending.length} 条（达到 ${SUMMARY_TRIGGER_MESSAGES} 条会自动压缩）`;

  el.btnSummarizeNow.disabled = pending.length < SUMMARY_MIN_MESSAGES || !!convo.summaryBusy;
  el.btnMemoryClear.disabled = list.length === 0;
  el.memoryFootHint.textContent = `「${convo.title || '新对话'}」的摘要只保存在你自己电脑上`;

  // 存档点在下面那一节，跟摘要没关系 —— 得放在「没有摘要就 return」之前
  renderCheckpoints(convo);

  el.memoryList.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent =
      `还没有摘要。聊到 ${SUMMARY_TRIGGER_MESSAGES} 条未压缩消息时会自动压一段，` +
      '也可以点上面的按钮手动压。';
    el.memoryList.appendChild(empty);
    return;
  }

  list.forEach((seg, index) => {
    el.memoryList.appendChild(buildMemoryCard(convo, seg, index, list.length));
  });
}

function buildMemoryCard(convo, seg, index, total) {
  const card = document.createElement('div');
  card.className = 'memory-card';

  const head = document.createElement('div');
  head.className = 'memory-card-head';

  const title = document.createElement('span');
  title.className = 'memory-card-title';
  title.textContent = seg.title || `第 ${index + 1} 段`;

  const meta = document.createElement('span');
  meta.className = 'memory-card-meta';
  const when = seg.at ? new Date(seg.at).toLocaleString('zh-CN', { hour12: false }) : '';
  meta.textContent = `第 ${seg.start + 1}–${seg.end} 条 · ${String(seg.text || '').length} 字${when ? ' · ' + when : ''}`;

  head.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'memory-card-actions';

  const isEditing = memoryEditingId === seg.id;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = `btn btn-ghost btn-sm${isEditing ? ' active' : ''}`;
  editBtn.textContent = isEditing ? '取消编辑' : '编辑';
  editBtn.addEventListener('click', () => {
    memoryEditingId = isEditing ? null : seg.id;
    renderMemoryModal();
  });

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'btn btn-ghost btn-sm';
  regenBtn.textContent = '重新生成';
  regenBtn.title = '用这段对应的原文重新压一次';
  regenBtn.disabled = !!convo.summaryBusy;
  regenBtn.addEventListener('click', async () => {
    regenBtn.disabled = true;
    regenBtn.textContent = '生成中…';
    const ok = await regenerateSummary(convo, seg.id);
    renderMemoryModal();
    if (ok) showToast('已重新生成', 'ok');
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-danger btn-sm';
  delBtn.textContent = '删除';
  delBtn.title = '删掉这段摘要，对应的原文会重新进入上下文';
  delBtn.addEventListener('click', () => deleteSummarySegment(convo, seg.id));

  actions.append(editBtn, regenBtn, delBtn);

  const body = document.createElement('div');
  body.className = 'memory-card-body';

  if (isEditing) {
    const box = document.createElement('textarea');
    box.className = 'memory-edit-box';
    box.value = String(seg.text || '');
    box.spellcheck = false;

    const editActions = document.createElement('div');
    editActions.className = 'memory-card-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', async () => {
      const target = convoSummaries(convo).find((s) => s.id === seg.id);
      if (!target) return;
      let text = box.value.trim();
      if (text.length > MAX_SUMMARY_CHARS) text = `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
      if (!text) {
        showToast('摘要不能为空，要删就点「删除」', 'error');
        return;
      }
      target.text = text;
      target.at = now();
      convo.updatedAt = now();
      memoryEditingId = null;
      persistConversations(0);
      renderMemoryModal();
      showToast('摘要已保存', 'ok');
    });

    editActions.appendChild(saveBtn);
    body.append(box, editActions);
  } else {
    const text = document.createElement('div');
    text.className = 'memory-card-text';
    text.textContent = seg.text || '';
    body.appendChild(text);
  }

  card.append(head, actions, body);
  return card;
}

/** 重新生成某一段（用它的原始消息区间） */
async function regenerateSummary(convo, segmentId) {
  const list = convoSummaries(convo);
  const index = list.findIndex((s) => s.id === segmentId);
  if (index < 0) return false;

  const seg = list[index];
  const messages = convoContextMessages(convo);
  const slice = messages.slice(seg.start, seg.end);
  if (!slice.length) {
    showToast('这段对应的原文已经不在了，无法重新生成', 'error');
    return false;
  }

  if (summarizingConvos.has(convo.id)) {
    showToast('正在压缩中，稍等一下', 'error');
    return false;
  }

  summarizingConvos.add(convo.id);
  try {
    const transcript = buildTranscript(slice, charNameForSummary(convo));
    // 用「这段之前」的摘要当背景
    const previous = list
      .slice(0, index)
      .map((s) => String(s.text || ''))
      .join('\n\n');

    const text = await generateSummary(convo, transcript, previous);
    if (!text) return false;

    const fresh = convoSummaries(convo);
    const target = fresh.find((s) => s.id === segmentId);
    if (!target) return false;
    target.text = text;
    target.at = now();
    convo.updatedAt = now();

    summaryFailures.delete(convo.id);
    persistConversations(0);
    return true;
  } catch (err) {
    console.error('重新生成摘要失败', err);
    showToast((err && err.message) || '重新生成失败', 'error');
    return false;
  } finally {
    summarizingConvos.delete(convo.id);
  }
}

async function deleteSummarySegment(convo, segmentId) {
  const seg = convoSummaries(convo).find((s) => s.id === segmentId);
  if (!seg) return;

  const ok = await confirmDialog({
    title: '删除摘要',
    message: `删除「${seg.title}」？对应的原文会重新进入上下文，占用更多 token。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  convo.summaries = convoSummaries(convo).filter((s) => s.id !== segmentId);
  // 删掉中间某段后，后面各段的覆盖范围就断了 —— 把范围重新编号，
  // 否则 buildApiMessages 会从错误的覆盖点往后取历史。
  renumberSummaries(convo);
  convo.updatedAt = now();
  persistConversations(0);
  renderMemoryModal();
  renderMemoryIndicator();
  showToast('摘要已删除，原文重新进入上下文');
}

/**
 * 删除某段后，把各段的 start/end 重新串起来。
 * 摘要内容不重写 —— 只是让覆盖范围保持连续。
 */
function renumberSummaries(convo) {
  const list = convoSummaries(convo);
  const messages = convoContextMessages(convo);
  let cursor = 0;

  for (const seg of list) {
    const span = Math.max(0, (Number(seg.end) || 0) - (Number(seg.start) || 0));
    seg.start = cursor;
    seg.end = Math.min(messages.length, cursor + span);
    cursor = seg.end;
  }

  // 只保留真正覆盖了内容的段
  convo.summaries = list.filter((s) => s.end > s.start);
}

export async function clearAllSummaries() {
  const convo = activeConvo();
  if (!convo) return;

  const list = convoSummaries(convo);
  if (!list.length) return;

  const ok = await confirmDialog({
    title: '清空全部摘要',
    message: `删除全部 ${list.length} 段摘要？对应的原文会重新进入上下文，token 占用会明显上升。`,
    confirmText: '清空',
    danger: true
  });
  if (!ok) return;

  convo.summaries = [];
  memoryEditingId = null;
  convo.updatedAt = now();
  summaryFailures.delete(convo.id);
  persistConversations(0);
  renderMemoryModal();
  renderMemoryIndicator();
  showToast('摘要已清空');
}

// ---------------------------------------------------------------------------
//  存档点
//
//  「想走另一条剧情线」有两个手段，区别在**代价**：
//    · 分支：从某条消息另开一个会话，这个会话原样留着 —— 什么都不丢（在 main.js）
//    · 存档点：在当前会话里存一份快照，读档 = 整个退回去 —— 存完之后聊的会没
//  所以界面上必须把这点说清楚，不然用户会以为读档也能反悔。
// ---------------------------------------------------------------------------

// 存档点上限。每份都是一整段对话的副本，攒多了会把 conversations.json 撑大
const MAX_CHECKPOINTS = 12;

/** 深拷一份存档点内容（消息 / 面板 / 面板字段定义 / 剧情选项 / 摘要 / 玩家角色） */
function snapshotConvo(convo) {
  return {
    messages: JSON.parse(JSON.stringify(convo.messages || [])),
    panel: { ...(convoPanel(convo) || {}) },
    panelFields: [...convoPanelFields(convo)],
    panelDefs: JSON.parse(JSON.stringify(convoPanelDefs(convo))),
    options: [...(Array.isArray(convo.options) ? convo.options : [])],
    optionsSpec: convo.optionsSpec ? { ...convo.optionsSpec } : null,
    summaries: JSON.parse(JSON.stringify(convoSummaries(convo))),
    player: convo.player ? { ...convo.player } : null
  };
}

/** 存一个档 */
function saveCheckpoint() {
  const convo = activeConvo();
  if (!convo) return;

  const count = (convo.messages || []).length;
  if (!count) {
    showToast('这个会话还是空的，没什么可存的', 'error');
    return;
  }

  if (!Array.isArray(convo.checkpoints)) convo.checkpoints = [];

  const summaries = convoSummaries(convo).length;
  const name = `${count} 条消息${summaries ? ` · ${summaries} 段摘要` : ''}`;
  convo.checkpoints.unshift({ id: uid(), at: now(), name, ...snapshotConvo(convo) });

  if (convo.checkpoints.length > MAX_CHECKPOINTS) convo.checkpoints.length = MAX_CHECKPOINTS;

  persistConversations(0);
  renderMemoryModal();
  showToast(`已存档（${name}）`, 'ok');
}

/** 读档：整个退回去。存完之后聊的内容会丢，所以先确认 */
async function restoreCheckpoint(id) {
  const convo = activeConvo();
  if (!convo) return;

  const point = (convo.checkpoints || []).find((c) => c.id === id);
  if (!point) return;

  const ok = await confirmDialog({
    title: '读档',
    message:
      `回到「${point.name}」？\n\n` +
      '这段时间聊的内容会丢掉。存档点本身还留着，可以再回到这里。\n' +
      '想「保住现在这条线」的话，用消息上的「分支」更稳。',
    confirmText: '读档'
  });
  if (!ok) return;

  const data = JSON.parse(JSON.stringify(point));
  convo.messages = data.messages || [];
  convo.panel = data.panel || {};
  convo.panelFields = data.panelFields || [];
  convo.panelDefs = normalizePanelDefs(data.panelDefs);
  convo.options = Array.isArray(data.options) ? data.options : [];
  convo.optionsSpec = data.optionsSpec || null;
  convo.summaries = data.summaries || [];
  if (data.player) convo.player = data.player;
  convo.updatedAt = now();
  state.usage = null;

  persistConversations(0);
  refreshAll({ forceScroll: true });
  renderMemoryModal();
  showToast('已回到存档点', 'ok');
}

async function deleteCheckpoint(id) {
  const convo = activeConvo();
  if (!convo) return;

  const ok = await confirmDialog({
    title: '删掉这个存档点',
    message: '删掉之后就回不到这个时间点了。',
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  convo.checkpoints = (convo.checkpoints || []).filter((c) => c.id !== id);
  persistConversations(0);
  renderMemoryModal();
  showToast('已删掉存档点', 'ok');
}

function renderCheckpoints(convo) {
  clear(el.checkpointList);

  const points = Array.isArray(convo.checkpoints) ? convo.checkpoints : [];
  el.btnSaveCheckpoint.disabled = !(convo.messages || []).length;

  if (!points.length) {
    el.checkpointList.appendChild(
      h('div', { class: 'memory-empty', text: '还没有存档点。想「先存一下再往前写」就点上面的按钮。' })
    );
    return;
  }

  for (const point of points) {
    const when = new Date(point.at || Date.now()).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    el.checkpointList.appendChild(
      h(
        'div',
        { class: 'checkpoint-row' },
        h(
          'div',
          { class: 'checkpoint-info' },
          h('div', { class: 'checkpoint-name', text: point.name }),
          // 档名里已经写了条数，这里就只报时间，不重复
          h('div', { class: 'checkpoint-time', text: when })
        ),
        button({ class: 'btn btn-primary btn-sm', text: '读档', onClick: () => restoreCheckpoint(point.id) }),
        button({ class: 'btn btn-ghost btn-sm', text: '删除', onClick: () => deleteCheckpoint(point.id) })
      )
    );
  }
}

// ---------------------------------------------------------------------------
//  接线：事件绑定 + 登记刷新总线
// ---------------------------------------------------------------------------

export function initMemoryUi() {
  el.btnMemory.addEventListener('click', openMemoryModal);
  el.btnCloseMemory.addEventListener('click', closeMemoryModal);
  el.btnCloseMemory2.addEventListener('click', closeMemoryModal);
  el.memoryModal.addEventListener('click', (event) => {
    if (event.target === el.memoryModal) closeMemoryModal();
  });
  el.btnSaveCheckpoint.addEventListener('click', saveCheckpoint);

  onRefresh(renderMemoryIndicator);
}
