'use strict';

// ============================================================================
//  views/suggestionsUi.js —— 建议条 + 剧情选项的按钮
//
//  两件事共用一条建议条（#suggest-strip）：
//    · 帮我想想：额外发一次请求，把几个「下一步」渲染成按钮
//    · 剧情选项：面板里常驻的选项，点一下当作玩家说了这句话
//  纯逻辑（怎么解析、怎么拼指令）在 data/suggestions.js ——
//  那边 composer 也要用（每轮回复完要 syncConvoOptions），
//  沉下去两边就不用互相 import。
//
//  两个动作由入口层注入：
//    · send     —— 点选项 / 点建议 = 发一条消息，那是 composer 的事
//    · growInput —— 把内容填进输入框后要让它长高
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { suggestInstruction, parseSuggestions } from '../data/suggestions.js';
import { renderPanel } from './panelUi.js';

// 当前建议属于哪个会话 —— 切走时要清掉
let suggestionsConvoId = null;

let actions = { send: () => {}, growInput: () => {} };

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
  renderPanel();
  el.input.value = text;
  actions.growInput();
  actions.send(text);
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
      el.input.value = text;
      actions.growInput();
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
    // 只带最近几轮，够模型判断局面就行，不用把整段历史塞进去
    const recent = history.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    recent.push({ role: 'user', content: suggestInstruction() });

    const response = await api.sendChat({
      requestId: `suggest-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: recent
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

/** 绑建议条自己的按钮。send / growInput 由入口层注入 */
export function initSuggestionsUi(injected) {
  actions = { send: () => {}, growInput: () => {}, ...(injected || {}) };
  el.btnSuggestClose.addEventListener('click', hideSuggestions);
}
