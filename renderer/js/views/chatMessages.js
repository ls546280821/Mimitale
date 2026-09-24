'use strict';

// ============================================================================
//  views/chatMessages.js —— 对话区（消息列表 + 空状态）
//
//  一条消息画成什么样子：头像、说话人、思考过程、正文（Markdown）、配图、
//  以及悬停浮出的那一排操作（复制/编辑/重新生成/继续/配图/帮我想想/删除/分支）。
//
//  操作按下去之后干什么，都不归这里 —— 编辑与重新生成在 views/composer.js，
//  删除与分支在 views/convoActions.js，配图在 views/chatImages.js，
//  建议在 views/suggestionsUi.js。这里只负责「画」和「把按钮接到谁身上」。
//
//  「正在生成开局」那一句要读 openingBusyId（世界会话开局的进度），
//  它由 views/worldPlay.js 在生成前后设置 —— 所以开了 setOpeningBusy() 这个口子。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { esc, renderMarkdown } from '../ui/markdown.js';
import { h, button } from '../ui/build.js';
import { characterForConvo, convoWorldbookIds, worldbookById } from '../data/library.js';
import { convoPlayer, convoUserName, userName, speakerName } from '../data/cast.js';
import { cleanAssistantText, convoPanelFields, panelGroupNames } from '../data/panel.js';
import { scrollToBottom } from './stream.js';
import { buildMessageImages, illustrateMessage } from './chatImages.js';
import { suggestNextActions, pickOption, rerollOptions, closeOptions } from './suggestionsUi.js';
import { switchVariant, editMessage, regenerateFrom, continueLastMessage } from './composer.js';
import { removeMessage, branchFromMessage } from './convoActions.js';

/** 正在生成开局的那个会话 id；同一时间只允许一个 */
let openingBusyId = null;

/** 由 views/worldPlay.js 在「按世界设定生成开局」前后设置 */
export function setOpeningBusy(id) {
  openingBusyId = id;
}

/**
 * 剧情选项块：每行一个选项（点一下当作玩家说了这句话），底下一条小工具行 ——
 * 「换一批」（这批没有想要的，重新让模型给一批）和「✕」（收起这一批）。
 *
 * 按钮接到谁身上：点选项 / 点换一批 / 点收起 都是 suggestionsUi.js 里的动作 ——
 * 它要动输入框、走发送流程、调模型，那些都是入口层的编排，这里只管接线。
 */
function buildOptionsBlock(options) {
  const box = h('div', { class: 'msg-options' });

  // 选项按钮包一层容器：点「换一批」时把里面换成骨架屏，等模型返回再换回来
  const list = h('div', { class: 'msg-options-list' });
  box.appendChild(list);

  function renderButtons() {
    list.textContent = '';
    options.forEach((text, i) => {
      list.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'msg-option-btn',
            title: '点一下，就当你说这句话发出去',
            onClick: () => pickOption(activeConvo(), text)
          },
          // 数字序号：输入框里按 1~9 也能选，序号印在按钮上对上号
          h('span', { class: 'opt-index', text: String(i + 1), 'aria-hidden': 'true' }),
          // h('span', { class: 'opt-arrow', text: '↩', 'aria-hidden': 'true' }),
          h('span', { class: 'opt-text', text })
        )
      );
    });
  }

  // 骨架屏：几条闪烁的灰条，占住选项的位置，等模型返回再换成真按钮。
  // 条数跟着这批选项的个数走，高度也用「一行」的样式，过渡才不跳。
  function renderSkeleton() {
    list.textContent = '';
    const n = Math.max(2, Math.min(options.length || 3, 4));
    for (let i = 0; i < n; i += 1) {
      const bar = h('div', { class: 'msg-option-skeleton', 'aria-hidden': 'true' });
      bar.style.width = `${[52, 68, 76, 61][i % 4]}%`;
      list.appendChild(bar);
    }
  }

  renderButtons();

  // 「换一批」：点下去先把选项换成骨架屏，再禁用按钮、等模型返回。
  // 成功时 refreshAll 会把整块重绘成新选项（骨架屏自然被换掉）；失败则原地
  // 把旧选项画回来。
  const reroll = h(
    'button',
    {
      type: 'button',
      class: 'msg-options-reroll',
      text: '⟳ 换一批',
      title: '这批没有想要的？让 AI 再给一批',
      onClick: async (event) => {
        const btn = event.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '换一批中…';
        renderSkeleton();
        try {
          const ok = await rerollOptions(activeConvo());
          // 失败（含「没生成出可用选项」）时 rerollOptions 已把旧选项写回，
          // 这里把骨架屏换成旧按钮；成功时 refreshAll 已整块重绘，无需处理。
          if (!ok) renderButtons();
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      }
    }
  );

  const close = h('button', {
    type: 'button',
    class: 'msg-options-close',
    text: '✕',
    title: '收起这一批选项（下一轮回复会带新的）',
    onClick: () => closeOptions(activeConvo())
  });

  box.appendChild(h('div', { class: 'msg-options-foot' }, reroll, close));
  return box;
}

function messageNode(message, index, character, labels, ctx) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  // 角色只用来标识助手那一侧。用户消息和错误提示绝不能套角色的头像和名字，
  // 否则你自己的气泡上会顶着角色的脸。
  const speaker = isUser || isError ? null : character;

  // 说话人显示名：助手那侧，绑了角色卡就是角色名，进了世界就是世界名，
  // 通用助手用全局人设那个名字；你自己那侧用玩家角色名（世界会话里填的那个）。
  const userLabel = (labels && labels.user) || userName();
  const assistantLabel = speaker ? speaker.name : (labels && labels.assistant) || 'AI';

  const wrap = document.createElement('div');
  wrap.className = `msg ${isError ? 'error' : isUser ? 'user' : 'assistant'}`;
  wrap.dataset.index = String(index);

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';

  if (speaker && speaker.avatar) {
    const img = document.createElement('img');
    img.src = speaker.avatar;
    img.alt = speaker.name;
    avatar.appendChild(img);
    avatar.classList.add('has-image');
    avatar.title = speaker.name;
  } else {
    avatar.textContent = isError ? '!' : isUser ? '我' : assistantLabel.slice(0, 1);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = isError ? '出错了' : isUser ? userLabel : assistantLabel;

  // 助手消息上标出是哪个模型答的，方便对比多个模型
  if (!isUser && !isError && message.model) {
    const tag = document.createElement('span');
    tag.className = 'msg-model';
    tag.textContent = message.model;
    role.appendChild(tag);
  }

  // 候选切换（重新生成过才会有多个版本）。
  // 放在角色行而不是操作栏：操作栏是悬停才浮出的，那样就**看不出这条有几个版本**了。
  const variants = Array.isArray(message.variants) ? message.variants : null;
  if (!isUser && !isError && variants && variants.length > 1) {
    const at = Number.isFinite(message.variantIndex) ? message.variantIndex : 0;
    role.appendChild(
      h(
        'span',
        { class: 'variant-nav' },
        button({
          class: 'variant-btn',
          text: '‹',
          title: '上一条候选',
          ariaLabel: '上一条候选',
          onClick: () => switchVariant(index, -1)
        }),
        h('span', { class: 'variant-count', text: `${at + 1}/${variants.length}` }),
        button({
          class: 'variant-btn',
          text: '›',
          title: '下一条候选',
          ariaLabel: '下一条候选',
          onClick: () => switchVariant(index, 1)
        })
      )
    );
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (message.reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    const pre = document.createElement('div');
    pre.className = 'reasoning-text';
    pre.textContent = message.reasoning;
    details.appendChild(summary);
    details.appendChild(pre);
    bubble.appendChild(details);
  }

  const content = document.createElement('div');
  content.className = 'msg-content';
  if (isUser || isError) {
    content.textContent = message.content;
  } else {
    // 气泡里也要剥掉「状态栏行」和「剧情选项行」：
    //   · 状态值已经由面板权威持有并在顶部常驻显示，正文里再来一份是重复的；
    //   · 选项已经变成可点的按钮了，原文留着只会吵。
    // （换候选时靠面板里的输入框看当前值，不靠正文。）
    content.innerHTML = renderMarkdown(
      cleanAssistantText(message.content, ctx.panelFields, ctx.panelGroups)
    );
  }

  // 图片放在文字上面 —— 先看图再看说话，跟聊天软件的习惯一致
  const imageBlock = buildMessageImages(message);
  if (imageBlock) bubble.appendChild(imageBlock);
  // 只带图没打字的，就不要留一个空段落了
  if (String(message.content || '').trim() || !imageBlock) bubble.appendChild(content);

  body.appendChild(role);
  body.appendChild(bubble);

  // 剧情选项：跟在**最新一条** AI 回复的气泡下面（对齐官方互动模板的位置 ——
  // 模型每轮给几个可点选项，点一下就当玩家说了这句话）。
  // 只在「最后一条是 AI 回复 + 没在生成下一轮」时出现：你自己刚发完话、
  // 或正在流式生成时，上一轮的旧选项挂在下面只会碍事。
  if (!isUser && !isError && index === ctx.lastIndex && ctx.options && ctx.options.length) {
    body.appendChild(buildOptionsBlock(ctx.options));
  }

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (!isError && message.content) {
    const copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.textContent = '复制';
    copy.title = '复制这条消息';
    copy.setAttribute('aria-label', '复制这条消息');
    copy.addEventListener('click', () => {
      api.copyText(message.content);
      showToast('已复制到剪贴板', 'ok');
    });
    actions.appendChild(copy);

    const edit = document.createElement('button');
    edit.className = 'mini-btn';
    edit.textContent = '编辑';
    edit.title = '直接改这条消息的内容';
    edit.setAttribute('aria-label', '编辑这条消息');
    edit.addEventListener('click', () => editMessage(index));
    actions.appendChild(edit);
  }

  if (!isUser) {
    const regen = document.createElement('button');
    regen.className = 'mini-btn';
    regen.textContent = isError ? '重试' : '重新生成';
    regen.title = isError ? '重新发送上一条消息' : '重新生成这条回复';
    regen.setAttribute('aria-label', isError ? '重新发送上一条消息' : '重新生成这条回复');
    regen.addEventListener('click', () => regenerateFrom(index));
    actions.appendChild(regen);

    // 「继续」只对最后一条有意义 —— 中间的回复后面早就接上别的话了
    const isLast = index === ctx.lastIndex;
    if (isLast && String(message.content || '').trim()) {
      const cont = document.createElement('button');
      cont.className = 'mini-btn';
      cont.textContent = '继续';
      cont.title = '让 AI 接着这条往下写（回复被截断时用）';
      cont.setAttribute('aria-label', '继续生成');
      cont.addEventListener('click', continueLastMessage);
      actions.appendChild(cont);
    }

    // 配图：只有配了生图才显示，免得点了才知道没配
    if (String(message.content || '').trim() && (state.settings || {}).imageProviderId) {
      const draw = document.createElement('button');
      draw.className = 'mini-btn';
      draw.textContent = '配图';
      draw.title = '用生图模型给这段配一张插画';
      draw.setAttribute('aria-label', '给这条回复配图');
      draw.addEventListener('click', () => illustrateMessage(index));
      actions.appendChild(draw);
    }

    // 帮我想想：卡住不知道说什么时，让 AI 给几个下一步让你挑
    if (isLast && String(message.content || '').trim()) {
      const suggest = document.createElement('button');
      suggest.className = 'mini-btn';
      suggest.textContent = '帮我想想';
      suggest.title = '让 AI 给几个下一步，点一下就直接发出去';
      suggest.setAttribute('aria-label', '让 AI 帮我想下一步');
      suggest.addEventListener('click', () => suggestNextActions(suggest));
      actions.appendChild(suggest);
    }
  }

  // 删除这一条消息（会先弹确认框）
  const del = document.createElement('button');
  del.className = 'mini-btn danger';
  del.textContent = '删除';
  del.title = '删除这条消息';
  del.setAttribute('aria-label', '删除这条消息');
  del.addEventListener('click', () => removeMessage(index));
  actions.appendChild(del);

  // 从这条分出一条新线：不动当前会话，另外复制一个出来
  if (!isError) {
    const branch = document.createElement('button');
    branch.className = 'mini-btn';
    branch.textContent = '分支';
    branch.title = '从这条起另开一个会话（当前这条线原样保留）';
    branch.setAttribute('aria-label', '从这条消息分支');
    branch.addEventListener('click', () => branchFromMessage(index));
    actions.appendChild(branch);
  }

  body.appendChild(actions);

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

export function renderMessages(options) {
  const opts = options || {};
  const convo = activeConvo();
  const character = characterForConvo(convo);
  el.messages.innerHTML = '';

  if (!convo || !convo.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';

    const book = convo
      ? convoWorldbookIds(convo).map((id) => worldbookById(id)).find(Boolean)
      : null;
    const player = convoPlayer(convo);

    if (book) {
      // 进了世界的空会话：主角是你自己，AI 是这个世界
      const busy = convo && openingBusyId === convo.id;
      empty.innerHTML = busy
        ? `
      <h2>正在生成开局…</h2>
      <p class="hint">AI 正在按「${esc(book.name)}」的设定写开场场景，稍等一下。</p>
    `
        : `
      <h2>进入「${esc(book.name)}」</h2>
      <p>你是「${esc((player && player.name) || '旅行者')}」。在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">这个世界由 GM 叙述：环境、NPC、剧情走向都归它写。</p>
      <p class="hint">想调整叙述方式，点右上角「视角」。</p>
    `;
    } else if (character) {
      empty.innerHTML = `
      <h2>开始和${esc(character.name)}聊天吧～</h2>
      <p>在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">当前扮演的是「${esc(character.name)}」。想换角色，去左下角「角色库」点另一张卡上的「聊天」。</p>
    `;
    } else {
      empty.innerHTML = `
      <h2>开始和昔涟聊天吧～</h2>
      <p>在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">第一次使用请先点左下角「设置」，填入接口地址和 API Key。</p>
      <p class="hint">想玩角色扮演？点左下角「角色库」导入角色卡，再点卡片上的「聊天」。</p>
    `;
    }

    el.messages.appendChild(empty);
    scrollToBottom(true);
    return;
  }

  // 每条消息都要用的几样东西，在循环外算一次 —— 以前是每条各算一遍
  const labels = {
    user: convoUserName(convo),
    assistant: speakerName(convo)
  };
  const lastMsg = convo.messages[convo.messages.length - 1];
  // 剧情选项挂在最新一条 AI 回复下面：你刚发了话、或正在流式生成就先不挂
  const showOptions =
    !state.streaming &&
    !!lastMsg &&
    lastMsg.role === 'assistant' &&
    Array.isArray(convo.options) &&
    convo.options.length > 0;
  const ctx = {
    panelFields: convoPanelFields(convo),
    panelGroups: [...panelGroupNames(convo)],
    lastIndex: convo.messages.length - 1,
    options: showOptions ? convo.options : null
  };

  convo.messages.forEach((message, index) => {
    el.messages.appendChild(messageNode(message, index, character, labels, ctx));
  });

  scrollToBottom(!!opts.forceScroll);
}
