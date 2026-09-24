'use strict';

// ============================================================================
//  views/composer.js —— 输入区与「发送/重新生成」这条链路
//
//  从「按回车」到「回复写完」的全部过程都在这里：
//    发送 → 组装提示词（世界书 + RAG 召回）→ 开流 → 收完定稿 → 后台摘要。
//  外加三个跟它绑在一起的动作：就地编辑一条消息、「继续」、换候选（swipe）。
//
//  流式分片的接收端不在这里 —— 那是入口层的全局监听（api.onChunk），
//  它要把增量写进消息区的节点，用的是 views/stream.js 的绘制器。
//  这里负责的是「什么时候开始 / 结束」，也就是 setStreaming 那对开关。
// ============================================================================

import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { persistConversations } from '../data/persist.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { buildApiMessages } from '../data/messages.js';
import { matchWorldbookSection } from '../data/cast.js';
import { recallSection } from '../data/rag.js';
import { syncConvoPanel, syncPlayerNameFromPanel } from '../data/panel.js';
import { syncConvoOptions } from '../data/suggestions.js';
import { createConvo } from '../data/conversations.js';
import { openSettings } from './settings.js';
import { streamPainter } from './stream.js';
import { getPendingImages, clearPendingImages } from './chatImages.js';
import { renderAll } from './redraw.js';
import { maybeSummarize } from './summarize.js';

function setStreaming(on) {
  state.streaming = on;
  el.btnStop.classList.toggle('hidden', !on);
  el.btnSend.disabled = on;
}

/** 输入框跟着内容长高（上限见 CONFIG.MAX_INPUT_HEIGHT） */
export function autoGrowInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, CONFIG.MAX_INPUT_HEIGHT)}px`;
}

export async function sendMessage(text) {
  const content = String(text || '').trim();
  // 只带图不写字也算一条消息 —— 问「这是什么」不一定非要打字
  const images = getPendingImages();
  if (!content && !images.length) return;

  if (state.streaming) {
    showToast('正在生成中，请稍候或先停止');
    return;
  }

  let convo = activeConvo();
  if (!convo) convo = createConvo(true);

  // 用当前会话绑定的服务商 + 模型；没绑过就用全局默认
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务，请先在设置里添加', 'error');
    openSettings();
    return;
  }
  if (!endpoint.provider.apiKey) {
    showToast(`请先填写「${endpoint.provider.name}」的 API Key`, 'error');
    openSettings();
    return;
  }

  if (convo.messages.length === 0) {
    convo.title = content.slice(0, 24) || (images.length ? '（图片）' : '新对话');
  }

  const message = { role: 'user', content, at: now() };
  if (images.length) message.images = images;
  convo.messages.push(message);

  // 图发出去了就清掉，免得下一条又带上
  clearPendingImages();

  convo.updatedAt = now();
  state.usage = null;
  renderAll({ forceScroll: true });
  persistConversations();

  await requestCompletion(convo);
}

/**
 * 就地编辑一条消息：把气泡内容换成 textarea，保存/取消。
 *
 * 以前改个错字只能「删除 → 重发」，而重发会换一整条新回复。
 * 这里直接改原文，改完接着聊，历史也就跟着变了（发出去的是改后的版本）。
 */
export function editMessage(index) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  const message = convo.messages[index];
  if (!message || message.role === 'error') return;

  const node = el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`);
  const bubble = node ? node.parentElement : null;
  if (!node || !bubble) return;

  const original = String(message.content || '');

  const textarea = h('textarea', {
    class: 'msg-edit-box',
    spellcheck: 'false',
    'aria-label': '编辑消息内容'
  });
  textarea.value = original;

  const finish = (save) => {
    if (save) {
      const next = textarea.value;
      if (!next.trim()) {
        showToast('内容不能为空 —— 想删掉这条就用「删除」', 'error');
        textarea.focus();
        return;
      }
      message.content = next;
      // 这条要是正好是「某一条候选」，改动要落回它那个槽里，
      // 否则切走再切回来就变回老样子了
      if (Array.isArray(message.variants) && Number.isFinite(message.variantIndex)) {
        message.variants[message.variantIndex] = next;
      }
      convo.updatedAt = now();
      // 助手消息里可能写着状态栏，改完要重新扫一遍面板
      if (message.role === 'assistant') syncConvoPanel(convo);
      if (message.role === 'assistant') syncConvoOptions(convo);
      if (message.role === 'assistant') syncPlayerNameFromPanel(convo);
      persistConversations(0);
      showToast('已保存', 'ok');
    }
    // 保存或取消都靠重绘来收拾现场
    renderAll({ forceScroll: false });
  };

  const save = button({ class: 'btn btn-primary btn-sm', text: '保存', onClick: () => finish(true) });
  const cancel = button({ class: 'btn btn-ghost btn-sm', text: '取消', onClick: () => finish(false) });

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    }
  });

  clear(node);
  node.appendChild(textarea);
  node.appendChild(h('div', { class: 'msg-edit-actions' }, save, cancel));

  textarea.focus();
  // 光标放到末尾，接着改最顺手
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // 编辑框比原来的气泡高，展开后可能把「保存 / 取消」顶到视口外面去。
  // 注意要滚**整个内容块**（node）：只滚 textarea 的话，它自己已经完整可见了，
  // scrollIntoView 按规范就该什么都不做 —— 被切掉的其实是它下面那行按钮。
  node.scrollIntoView({ block: 'nearest' });
}

/** 「继续」时追加在提示词末尾的引导。只进这一次请求，不存进会话 */
const CONTINUE_NUDGE = '（接着你上一条回复继续往下写。不要重复已经写过的内容，也不要重新开头。）';

/**
 * 「继续」：让模型接着最后一条回复往下写（回复被 maxTokens 截断时用）。
 *
 * 省事的地方在于**不新建消息**：流式分片本来就是「把增量加到 messages 里最后一条、
 * 再画到它的节点上」，所以只要不加新消息，它自然就续写在原文后面了。
 */
export async function continueLastMessage() {
  const convo = activeConvo();
  if (!convo) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再继续');
    return;
  }

  const last = convo.messages[convo.messages.length - 1];
  if (!last || last.role !== 'assistant' || !String(last.content || '').trim()) {
    showToast('只能在 AI 的回复后面接着写', 'error');
    return;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return;
  }

  const worldbookSection = await matchWorldbookSection(convo);
  const ragSection = await recallSection(convo);
  const requestId = uid();
  state.requestId = requestId;

  const messages = buildApiMessages(convo, worldbookSection, ragSection);
  messages.push({ role: 'user', content: CONTINUE_NUDGE });

  const index = convo.messages.length - 1;
  const bubble = el.messages.querySelector(`.msg[data-index="${index}"] .bubble`);
  if (bubble) bubble.classList.add('streaming');

  const before = String(last.content || '');
  setStreaming(true);

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '调用失败');
    }
    if (response.usage) state.usage = response.usage;

    // 有的服务商不推流式分片，直接给全文 —— 那种情况分片处理器一次都没跑过，
    // 这里补一次追加（正文没变就说明没收到过分片）
    if (String(last.content || '') === before && String(response.content || '').trim()) {
      last.content = before + response.content;
    }
  } catch (err) {
    showToast((err && err.message) || '继续失败', 'error');
  } finally {
    streamPainter.stop();
    setStreaming(false);
    state.requestId = null;
    convo.updatedAt = now();
    // 续写改了正文，同样要落回当前那个候选槽
    if (Array.isArray(last.variants) && Number.isFinite(last.variantIndex)) {
      last.variants[last.variantIndex] = last.content;
    }
    syncConvoPanel(convo);
    syncConvoOptions(convo);
    renderAll({ forceScroll: true });
    persistConversations();
    el.input.focus();
  }
}

/**
 * 调一次模型，把回复流式写进界面。
 *
 * options.variants：已有的候选列表。传了就是「重新生成」——
 * 新生成的那条会作为一个**新候选**接在后面，老的留着可以左右翻，
 * 而不是把老的直接扔掉。
 */
async function requestCompletion(convo, options) {
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return;
  }

  // 世界书在渲染层匹配（和 buildApiMessages 同一个进程，省一次往返）。
  // 之前这里要求「消息数 ≥ 3」才匹配，但那会让世界模型的第一个回合拿不到设定 ——
  // 而开场引导往往正是最需要世界书的时候。匹配本身是本地纯计算，不省这一下。
  const worldbookSection = await matchWorldbookSection(convo);
  const ragSection = await recallSection(convo);

  const requestId = uid();
  state.requestId = requestId;

  // 先插入一个空的助手消息，边收边填
  const assistant = {
    role: 'assistant',
    content: '',
    reasoning: '',
    at: now(),
    model: endpoint.model,
    providerId: endpoint.provider.id
  };

  // 重新生成：把老候选接在前面，新的那条占一个空位先显示「正在思考」。
  // 先占位是为了让「2/3」这种计数在流式过程中就是对的。
  const seeded = options && Array.isArray(options.variants) ? options.variants.filter((v) => String(v || '').trim()) : null;
  if (seeded && seeded.length) {
    assistant.variants = [...seeded, ''];
    assistant.variantIndex = assistant.variants.length - 1;
  }

  convo.messages.push(assistant);

  const index = convo.messages.length - 1;
  renderAll({ forceScroll: true });

  const node = el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`);
  const bubble = node ? node.parentElement : null;

  if (bubble) bubble.classList.add('streaming');

  if (node) {
    const wait = document.createElement('div');
    wait.className = 'waiting';
    wait.textContent = '正在思考';
    node.innerHTML = '';
    node.appendChild(wait);
  }

  setStreaming(true);

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: buildApiMessages(convo, worldbookSection, ragSection)
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '调用失败');
    }

    if (response.usage) state.usage = response.usage;
    // 主进程可能会把模型名规范化，以它返回的为准
    if (response.model) assistant.model = response.model;

    assistant.content = response.content || assistant.content;
    assistant.reasoning = response.reasoning || assistant.reasoning;

    if (!assistant.content && !assistant.reasoning) {
      throw new Error('接口没有返回任何内容。可能是模型名不对，或该模型不支持流式输出。');
    }

    // 推理模型（如 deepseek-reasoner）有时会把 max_tokens 全花在思考过程上，
    // 正文还没开始就被截断 —— 结果只有「思考过程」、没有正文。与其留下一个
    // 空气泡让用户纳闷，不如明确告诉他发生了什么、怎么补救。
    if (!String(assistant.content || '').trim() && String(assistant.reasoning || '').trim()) {
      assistant.content =
        '（模型只输出了思考过程，正文被截断了 —— 通常是思考把字数上限用光了。）\n\n' +
        '点下面这条消息的「继续」让它接着写正文，或到「设置」里把 max_tokens 调大一些。';
    }

    // 定稿：把这一轮的结果写回它那个候选槽
    if (Array.isArray(assistant.variants)) {
      assistant.variants[assistant.variantIndex] = assistant.content;
    }
  } catch (err) {
    const message = (err && err.message) || '未知错误';
    const stopped = /已停止生成/.test(message);

    // 没生成出东西，那个占位的空候选要撤掉，不然会留下一条空白候选
    if (Array.isArray(assistant.variants)) {
      assistant.variants.pop();
      if (!assistant.variants.length) delete assistant.variants;
      else assistant.variantIndex = assistant.variants.length - 1;
    }

    if (stopped) {
      if (!assistant.content) {
        convo.messages.splice(index, 1);
      }
      showToast('已停止生成');
    } else {
      // 把失败的那条助手消息换成错误提示，并留一个「重试」按钮
      convo.messages.splice(index, 1);
      convo.messages.push({ role: 'error', content: message, at: now(), retryable: true });
    }
  } finally {
    streamPainter.stop();
    setStreaming(false);
    state.requestId = null;
    convo.updatedAt = now();
    // 回复写完了，从里面抽出状态栏存到会话上 —— 下一轮由程序权威注入，
    // 不再依赖模型去抄历史（历史会被 maxTurns 截断）。
    syncConvoPanel(convo);
    syncConvoOptions(convo);
    // 剧情要是把你的名字改了，消息标签和 {{user}} 也得跟着改
    syncPlayerNameFromPanel(convo);
    renderAll({ forceScroll: true });
    persistConversations();
    el.input.focus();

    // 攒够未压缩的对话就后台压一段摘要。
    // 放在最后、不 await：压缩要额外调一次模型，不该让你等它。
    maybeSummarize(convo).catch((err) => console.error('后台摘要失败', err));
  }
}

/**
 * 重新生成：删掉这条之后的全部内容，再问一次。
 *
 * 和以前不同的是**老的那条不扔** —— 它作为一个候选留着，生成完可以用
 * 「‹ 2/3 ›」翻回去。写了一大段舍不得删、只想再抽一次的时候很有用。
 */
export function regenerateFrom(index) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  // 这一轮已有的候选。第一次重新生成时，当前正文就是第一个候选。
  const target = convo.messages[index];
  let existing = null;
  if (target && target.role === 'assistant' && String(target.content || '').trim()) {
    existing = Array.isArray(target.variants) ? target.variants.slice() : [String(target.content)];
  }

  let cut = Math.min(index, convo.messages.length - 1);
  while (cut >= 0 && convo.messages[cut].role !== 'user') cut -= 1;

  if (cut < 0) {
    showToast('找不到对应的提问，无法重新生成', 'error');
    return;
  }

  convo.messages = convo.messages.slice(0, cut + 1);
  state.usage = null;
  persistConversations(0);
  requestCompletion(convo, existing ? { variants: existing } : undefined);
}

/**
 * 换一条候选（swipe）。
 * content 是「当前显示的那条」，改它就等于换了一条 —— 历史、复制、导出
 * 读的都是 content，所以其它地方一行都不用动。
 */
export function switchVariant(index, delta) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  const message = convo.messages[index];
  const list = message && Array.isArray(message.variants) ? message.variants : null;
  if (!list || list.length < 2) return;

  const current = Number.isFinite(message.variantIndex) ? message.variantIndex : 0;
  const next = (current + delta + list.length) % list.length;
  if (next === current) return;

  message.variantIndex = next;
  message.content = list[next];
  convo.updatedAt = now();

  // 不同候选里写的状态栏可能不一样，换完重新扫一遍
  syncConvoPanel(convo);
  syncConvoOptions(convo);
  renderAll({ forceScroll: false });
  persistConversations(0);
}

export async function stopGenerating() {
  await api.stopChat();
}
