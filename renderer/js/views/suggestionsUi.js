'use strict';

// ============================================================================
//  views/suggestionsUi.js —— 建议条 + 剧情选项的动作
//
//  两件事共用一条建议条（#suggest-strip）的只有「帮我想想」：
//    · 帮我想想：额外发一次请求，把几个「下一步」渲染成按钮
//    · 剧情选项：跟着最新一条 AI 回复走（画在 chatMessages.js 的气泡下面），
//      这里的 pickOption / rerollOptions / closeOptions 是它三个按钮的动作
//  纯逻辑（怎么解析、怎么拼指令）在 data/suggestions.js ——
//  那边 composer 也要用（每轮回复完要 syncConvoOptions），
//  沉下去两边就不用互相 import。
//
//  动作由入口层注入：
//    · send     —— 点选项 / 点建议 = 发一条消息，那是 composer 的事
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { persistConversations } from '../data/persist.js';
import { buildApiMessages } from '../data/messages.js';
import { matchWorldbookSection } from '../data/cast.js';
import { recallSection } from '../data/rag.js';
import {
  suggestInstruction,
  parseSuggestions,
  rerollOptionsInstruction,
  extractOptionsFromText
} from '../data/suggestions.js';
import { refreshAll } from './refresh.js';

// 当前建议属于哪个会话 —— 切走时要清掉
let suggestionsConvoId = null;

let actions = { send: () => {} };

export function hideSuggestions() {
  el.suggestStrip.classList.add('hidden');
  el.suggestList.innerHTML = '';
  suggestionsConvoId = null;
}

/** 换会话了就把上一局的建议收起来（全量重绘时调） */
export function dropSuggestionsIfConvoChanged() {
  const convoNow = activeConvo();
  if (suggestionsConvoId && suggestionsConvoId !== (convoNow ? convoNow.id : null)) {
    hideSuggestions();
  }
}

/** 玩家点了某个剧情选项：当作他说了这句话发出去 */
export function pickOption(convo, text) {
  if (!convo || !text) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再选');
    return;
  }
  // 用过就清掉 —— 它是「这一轮的选项」，点完就该消失，不能留着重复点
  convo.options = [];
  hideSuggestions();
  refreshAll();
  // 直接发送，不把选项文字写进输入框 —— 输入框保持原样
  actions.send(text);
}

/** 玩家点了「✕」：收起这一批剧情选项（下一轮回复会带回新的） */
export function closeOptions(convo) {
  if (!convo) return;
  if (state.streaming) return;
  if (!Array.isArray(convo.options) || !convo.options.length) return;
  convo.options = [];
  persistConversations(0);
  refreshAll();
}

function renderSuggestions(options) {
  el.suggestList.innerHTML = '';

  if (!options || !options.length) {
    hideSuggestions();
    return;
  }

  const convo = activeConvo();
  suggestionsConvoId = convo ? convo.id : null;

  options.forEach((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggest-btn';
    btn.textContent = text;
    btn.title = '点一下，就当你说这句话发出去';
    btn.addEventListener('click', () => {
      if (state.streaming) {
        showToast('正在生成，等它写完再用');
        return;
      }
      hideSuggestions();
      // 直接发送，不把建议文字写进输入框 —— 输入框保持原样
      actions.send(text);
    });
    el.suggestList.appendChild(btn);
  });

  el.suggestStrip.classList.remove('hidden');
}

/** 点「帮我想想」：要几个选项，渲染成按钮 */
export async function suggestNextActions(trigger) {
  const convo = activeConvo();
  if (!convo) return;

  if (state.streaming) {
    showToast('正在生成，等它写完再想');
    return;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return;
  }

  const history = convo.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  if (!history.length) {
    showToast('还没有对话内容，先聊两句', 'error');
    return;
  }

  const label = trigger || null;
  const originalText = label ? label.textContent : '';
  if (label) {
    label.disabled = true;
    label.textContent = '在想…';
  }

  try {
    // 和「换一批」一样复用 buildApiMessages：人设、玩家角色、世界书、面板状态、
    // 剧情选项指令全都带着，模型才知道「你是谁、这是什么世界」，否则它只能看到
    // 一截裸对话，会把你当 NPC、把主角当外乡人（实测踩过）。再追加一句「帮我想想」。
    const worldbookSection = await matchWorldbookSection(convo);
    const ragSection = await recallSection(convo);
    const messages = buildApiMessages(convo, worldbookSection, ragSection);
    messages.push({ role: 'user', content: suggestInstruction() });

    const response = await api.sendChat({
      requestId: `suggest-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '想不出来');
    }

    const options = parseSuggestions(response.content);
    if (!options.length) {
      showToast('这次没想出可用的选项，再点一次试试', 'error');
      return;
    }

    renderSuggestions(options);
  } catch (err) {
    showToast((err && err.message) || '想不出来，稍后再试', 'error');
  } finally {
    if (label) {
      label.disabled = false;
      label.textContent = originalText || '帮我想想';
    }
  }
}

/**
 * 点「换一批」：让模型按同一套设定重新给一批剧情选项。
 *
 * 和「帮我想想」的区别：这里复用 buildApiMessages —— 人设、面板状态、剧情选项
 * 指令**全都带着**（跟正常回复同一套上下文），只追加一条「换一批」指令，
 * 所以换出来的选项和正常那批是同一个角色、同一个局面下的，只是内容换了一版。
 *
 * 结果直接写回 convo.options 并重绘面板 —— 它是剧情选项的延续，不是临时建议条。
 */
export async function rerollOptions(convo) {
  if (!convo) return false;
  if (state.streaming) {
    showToast('正在生成，等它写完再换');
    return false;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return false;
  }

  // 换之前先把旧的存住：万一这次失败，面板上还留着上一批，别把按钮清空
  const previous = Array.isArray(convo.options) ? convo.options.slice() : [];

  try {
    const worldbookSection = await matchWorldbookSection(convo);
    const ragSection = await recallSection(convo);

    // 完整上下文（含剧情选项指令）已经由 buildApiMessages 组好，再追加换一批指令
    const messages = buildApiMessages(convo, worldbookSection, ragSection);
    messages.push({ role: 'user', content: rerollOptionsInstruction(convo) });

    const response = await api.sendChat({
      requestId: `reroll-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '换一批失败');
    }

    // 优先按「【剧情选项】：A / B / C」解析；模型偶尔会漏掉标记、只吐选项本身，
    // 那就退化成按行解析兜底。
    let items = extractOptionsFromText(String(response.content || ''));
    if (!items.length) items = parseSuggestions(response.content);
    if (!items.length) {
      showToast('这次没生成出可用选项，再换一次试试', 'error');
      return false;
    }

    // 写回前确认还是这个会话 —— 请求期间用户可能切走了，别把结果写到别处
    const current = activeConvo();
    if (!current || current.id !== convo.id) return false;

    convo.options = items;
    refreshAll();
    return true;
  } catch (err) {
    convo.options = previous;
    showToast((err && err.message) || '换一批失败，稍后再试', 'error');
    return false;
  }
}

/** 绑建议条自己的按钮。send 由入口层注入 */
export function initSuggestionsUi(injected) {
  actions = { send: () => {}, ...(injected || {}) };
  el.btnSuggestClose.addEventListener('click', hideSuggestions);
}
