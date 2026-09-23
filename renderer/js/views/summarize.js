'use strict';

// ============================================================================
//  views/summarize.js —— 分段记忆摘要的「后台调度」
//
//  摘要的参数、纯逻辑、运行态（summarizingConvos / summaryFailures）都在
//  data/memory.js 里；这里只留「什么时候压一段」以及压完怎么刷新界面。
//
//  问题：只把最近 maxTurns 轮发给模型，超出去的历史模型完全看不见。
//  调大轮数就烧 token，调小就忘事 —— 这是个死结。
//  做法：把较早的对话按段压缩成摘要，摘要常驻上下文、原文丢弃。
//  生成时机是每轮回复之后、后台静默进行，不阻塞聊天。
// ============================================================================

import { activeConvo, uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { persistConversations } from '../data/persist.js';
import {
  MAX_SUMMARY_FAILURES,
  SUMMARY_RETRY_COOLDOWN_MS,
  SUMMARY_TRIGGER_MESSAGES,
  SUMMARY_MIN_MESSAGES,
  convoSummaries,
  nextSegmentTitle,
  buildTranscript,
  pendingSummaryRange,
  generateSummary,
  summarizingConvos,
  summaryFailures,
  charNameForSummary
} from '../data/memory.js';
import { renderHeader } from './header.js';
import { renderMemoryModal } from './memoryUi.js';

/**
 * 达到阈值就在后台压一段。
 * 返回是否真的压了新的一段。
 */
export async function maybeSummarize(convo) {
  if (!convo || summarizingConvos.has(convo.id)) return false;

  const failures = summaryFailures.get(convo.id) || 0;
  if (failures >= MAX_SUMMARY_FAILURES) {
    const lastAttempt = Number(convo.summaryLastAttempt) || 0;
    if (Date.now() - lastAttempt < SUMMARY_RETRY_COOLDOWN_MS) return false;
  }

  const { start, pending } = pendingSummaryRange(convo);
  if (pending.length < SUMMARY_TRIGGER_MESSAGES) return false;

  // 压缩到「留下最近几轮原文」为止，避免把刚聊完的内容也压掉
  const keepNewest = SUMMARY_MIN_MESSAGES;
  const slice = pending.slice(0, Math.max(SUMMARY_MIN_MESSAGES, pending.length - keepNewest));
  if (slice.length < SUMMARY_MIN_MESSAGES) return false;

  summarizingConvos.add(convo.id);
  convo.summaryBusy = true;
  convo.summaryLastAttempt = Date.now();
  renderHeader();

  try {
    const transcript = buildTranscript(slice, charNameForSummary(convo));
    const previous = convoSummaries(convo).map((s) => String(s.text || '')).join('\n\n');

    const text = await generateSummary(convo, transcript, previous);
    if (!text) return false;

    // 关键：这里必须以 convo.summaries 的当前值重新取，不能用闭包里的旧引用
    const list = convoSummaries(convo);
    list.push({
      id: `s${uid()}`,
      title: nextSegmentTitle(convo),
      text,
      start,
      end: start + slice.length,
      at: now()
    });
    convo.summaries = list;
    convo.summaryBusy = false;
    convo.updatedAt = now();

    summaryFailures.delete(convo.id);
    persistConversations(0);
    renderHeader();
    showToast(`已把较早的 ${slice.length} 条对话压缩成「${list[list.length - 1].title}」`, 'ok');
    return true;
  } catch (err) {
    console.error('生成摘要失败', err);
    convo.summaryBusy = false;
    const next = (summaryFailures.get(convo.id) || 0) + 1;
    summaryFailures.set(convo.id, next);
    if (next >= MAX_SUMMARY_FAILURES) {
      showToast('摘要连续失败，已暂停自动摘要（可在记忆面板手动重试）', 'error');
    }
    renderHeader();
    return false;
  } finally {
    summarizingConvos.delete(convo.id);
  }
}

/** 手动压一段（记忆面板里的按钮） */
export async function summarizeNow() {
  const convo = activeConvo();
  if (!convo) return;

  const { pending } = pendingSummaryRange(convo);
  if (pending.length < SUMMARY_MIN_MESSAGES) {
    showToast(`还没压缩的对话只有 ${pending.length} 条，太少，攒到 ${SUMMARY_MIN_MESSAGES} 条再压`, 'error');
    return;
  }

  // 手动触发时绕过阈值判断，直接压
  summarizingConvos.delete(convo.id);
  const { start, pending: nowPending } = pendingSummaryRange(convo);
  const keepNewest = SUMMARY_MIN_MESSAGES;
  const slice = nowPending.slice(0, Math.max(SUMMARY_MIN_MESSAGES, nowPending.length - keepNewest));
  if (slice.length < SUMMARY_MIN_MESSAGES) {
    showToast('可压缩的内容太少', 'error');
    return;
  }

  summarizingConvos.add(convo.id);
  convo.summaryBusy = true;
  renderHeader();
  renderMemoryModal();

  try {
    const transcript = buildTranscript(slice, charNameForSummary(convo));
    const previous = convoSummaries(convo).map((s) => String(s.text || '')).join('\n\n');
    const text = await generateSummary(convo, transcript, previous);
    if (!text) {
      showToast('摘要返回为空', 'error');
      return;
    }

    const list = convoSummaries(convo);
    list.push({
      id: `s${uid()}`,
      title: nextSegmentTitle(convo),
      text,
      start,
      end: start + slice.length,
      at: now()
    });
    convo.summaries = list;
    convo.updatedAt = now();
    summaryFailures.delete(convo.id);
    persistConversations(0);
    showToast(`已压缩 ${slice.length} 条对话`, 'ok');
  } catch (err) {
    console.error('压缩失败', err);
    showToast((err && err.message) || '压缩失败', 'error');
  } finally {
    convo.summaryBusy = false;
    summarizingConvos.delete(convo.id);
    renderHeader();
    renderMemoryModal();
  }
}
