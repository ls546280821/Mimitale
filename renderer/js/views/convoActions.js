'use strict';

// ============================================================================
//  views/convoActions.js —— 会话/消息的增删改（左侧列表和气泡上的那些动作）
//
//  换会话、删会话、清空、删一条消息、从某条消息分叉。
//  共同点：都是「改数据 + 弹确认 + 全量重绘 + 落盘」——所以集中在这里一份，
//  左侧列表（views/chatList.js）和消息气泡（views/chatMessages.js）都直接用它。
//
//  这些动作以前挂在入口层，靠注入传给列表页和消息渲染；现在它们自己成模块，
//  谁要用谁 import —— 视图之间单向 import 不会成环，比绕一圈注入清楚。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { createConvo, branchSkeleton } from '../data/conversations.js';
import { persistConversations } from '../data/persist.js';
import { shiftSummariesForRemoval } from '../data/memory.js';
import { showView } from './viewSwitch.js';
import { renderAll } from './redraw.js';
import { resetPetTurns } from '../data/petContext.js';

export function switchConvo(id) {
  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再切换会话');
    return;
  }
  state.activeId = id;
  state.usage = null;
  showView('chat');
  renderAll({ forceScroll: true });
  persistConversations(0);
}

export async function removeConvo(id) {
  const convo = state.conversations.find((c) => c.id === id);
  if (!convo) return;

  // 正在生成时不能删：删完 state.activeId 就换人了，而流式回调是按「当前会话的
  // 最后一条消息」追加的（main.js 的 onChunk）—— 后面那些分片会写进**另一个会话**，
  // 再被 finally 里的 persistConversations 落盘。旁边的 switchConvo / removeMessage /
  // branchFromMessage 都有这道守卫，就这里当初漏了。
  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再删除会话');
    return;
  }

  const ok = await confirmDialog({
    title: '删除会话',
    message: `删除会话「${convo.title || '新对话'}」？此操作无法撤销。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  state.conversations = state.conversations.filter((c) => c.id !== id);
  // 桌宠的「攒了几轮」是按会话 id 记的，会话没了就把那条计数删掉 ——
  // 否则这个 Map 会随着删掉的会话一直长，而且 id 万一被复用会带着旧计数。
  resetPetTurns(id);
  if (state.activeId === id) {
    state.activeId = state.conversations.length ? state.conversations[0].id : null;
  }
  if (!state.conversations.length) createConvo(true);
  state.usage = null;
  renderAll({ forceScroll: true });
  persistConversations(0);
  el.input.focus();
}

export async function clearConvo() {
  const convo = activeConvo();
  if (!convo || !convo.messages.length) {
    showToast('当前会话已经是空的');
    return;
  }

  const ok = await confirmDialog({
    title: '清空对话',
    message: '清空当前会话的所有消息？此操作无法撤销。',
    confirmText: '清空',
    danger: true
  });
  // 不管确定还是取消，都把光标放回输入框：
  // 弹窗关掉后焦点会留在弹窗里，不主动交还的话输入框点起来像是「没反应」。
  if (!ok) {
    el.input.focus();
    return;
  }

  convo.messages = [];
  // 摘要必须一起清：它的 start/end 是**按当时的消息下标**记的，消息没了这些下标
  // 就成了过期坐标 —— 留着会让 buildApiMessages 以为「前面一大段已经被压缩过」，
  // 于是把新对话整段切掉（用户刚打的那句话都发不出去）。
  // （buildApiMessages 里还有一道兜底，但这里才是问题的源头。）
  convo.summaries = [];
  convo.title = '新对话';
  state.usage = null;
  renderAll({ forceScroll: true });
  persistConversations(0);
  el.input.focus();
  showToast('已清空当前对话', 'ok');
}

/** 删除单独一条消息 */
export async function removeMessage(index) {
  const convo = activeConvo();
  if (!convo) return;

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再删除消息');
    return;
  }

  const message = convo.messages[index];
  if (!message) return;

  const label =
    message.role === 'user' ? '你发的这条' : message.role === 'error' ? '这条错误提示' : '这条回答';

  const ok = await confirmDialog({
    title: '删除消息',
    message: `删除${label}？此操作无法撤销。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  // 先挪摘要覆盖点再删（要靠被删的那条算它在上下文里的位置）
  shiftSummariesForRemoval(convo, index);
  convo.messages.splice(index, 1);
  convo.updatedAt = now();
  state.usage = null;
  renderAll({ forceScroll: false });
  persistConversations(0);
  showToast('已删除这条消息', 'ok');
}

/**
 * 从某条消息分出一条新线。
 *
 * 做法是**另开一个会话，把前 N 条原样复制过去**（见 data/conversations.js 的
 * branchSkeleton）—— 当前会话一个字节都不动。所以走岔了随时切回来，两边还能
 * 并排对比（侧栏里就是两条会话）。比真做消息树简单得多，也不会因为一次误操作
 * 丢掉整条线。
 */
export function branchFromMessage(index) {
  const convo = activeConvo();
  if (!convo) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再分支');
    return;
  }

  const cut = Math.max(0, Math.min(index, convo.messages.length - 1)) + 1;
  const branch = branchSkeleton(convo, cut);

  state.conversations.unshift(branch);
  state.activeId = branch.id;
  persistConversations(0);
  renderAll({ forceScroll: true });
  showToast(`已分出一条新线（前 ${cut} 条照搬，原来那条没动）`, 'ok');
}
