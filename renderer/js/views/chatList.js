'use strict';

// ============================================================================
//  views/chatList.js —— 左侧会话列表 + 右上角的模型切换
//
//  两样「会话级别的选择器」放在一起：
//    · 左侧列一个会话一行（点了切过去，悬停浮出 × 删除）
//    · 右上角下拉框选这个会话用哪个服务商/模型
//  另外「绑定角色」也在这儿 —— 它本质上和切模型是同一类事（改当前会话用谁），
//  以前顶部还有个角色下拉框，后来改到角色列表页用卡片上的「聊天」触发，
//  留下 applyCharacterChoice 这个入口（含自动插开场白、自动起标题）。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { providers, providerById, currentEndpoint } from '../data/providers.js';
import { characterById } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters } from '../data/panel.js';
import { applyMacros } from '../data/messages.js';
import { userName } from '../data/cast.js';
import { persistConversations } from '../data/persist.js';
import { renderHeader } from './header.js';
import { renderAll } from './redraw.js';
import { switchConvo, removeConvo } from './convoActions.js';

export function renderConvoList() {
  clear(el.convoList);

  if (!state.conversations.length) {
    // 这两条内联样式是「空状态」专属的，没有别的用处（真要认真做该进样式表）
    const empty = h('div', { class: 'convo-title', text: '（还没有会话）' });
    empty.style.padding = '8px 9px';
    empty.style.color = 'var(--text-faint)';
    el.convoList.appendChild(empty);
    return;
  }

  for (const convo of state.conversations) {
    const label = convo.title || '新对话';

    el.convoList.appendChild(
      h(
        'div',
        {
          class: ['convo-item', convo.id === state.activeId && 'active'],
          role: 'listitem',
          onclick: () => switchConvo(convo.id)
        },
        h('span', { class: 'convo-title', text: label, title: label }),
        button({
          class: 'convo-del',
          text: '×',
          title: '删除这个会话',
          ariaLabel: `删除会话：${label}`,
          onClick: (event) => {
            event.stopPropagation();
            removeConvo(convo.id);
          }
        })
      )
    );
  }
}

/** 右上角的模型下拉框：按服务商分组，列出所有可用模型 */
export function renderModelSwitch() {
  const select = el.modelSwitch;
  if (!select) return;

  const list = providers();
  const endpoint = currentEndpoint();

  select.innerHTML = '';

  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未配置模型';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  for (const p of list) {
    const group = document.createElement('optgroup');
    group.label = p.apiKey ? p.name : `${p.name}（未填 Key）`;

    if (!p.models || !p.models.length) {
      const opt = document.createElement('option');
      opt.value = `${p.id}::`;
      opt.textContent = '（还没有模型）';
      opt.disabled = true;
      group.appendChild(opt);
    } else {
      for (const m of p.models) {
        const opt = document.createElement('option');
        opt.value = `${p.id}::${m}`;
        opt.textContent = m;
        group.appendChild(opt);
      }
    }
    select.appendChild(group);
  }

  if (endpoint && endpoint.provider && endpoint.model) {
    select.value = `${endpoint.provider.id}::${endpoint.model}`;
  }
  select.disabled = false;
}

/** 顶部的角色下拉框已经去掉：角色改成在角色列表页用卡片上的「聊天」按钮选 */
export async function applyCharacterChoice(characterId) {
  const convo = activeConvo();
  if (!convo) return;

  const next = characterId ? characterById(characterId) : null;
  if (!next) return;

  const previous = characterById(convo.characterId); // 用来判断标题是不是自动生成的

  // 自动插入的开场白会带 greeting 标记。
  // 只有「会话里一条消息都没有」时才插 —— 调用方（角色列表页的「聊天」）
  // 给的都是刚建好的空会话，所以这里不用担心覆盖掉真实对话。
  const untouched = !convo.messages.length;

  convo.characterId = next.id;
  convo.updatedAt = now();

  // 角色卡上声明过「属性」和「身份四项」就种进状态面板 —— AI 第一轮就知道
  // 这个角色是谁、要维护哪些字段，不用等它自己碰巧输出一个「【金币】：100」
  // （漏了身份那四项时，模型不知道年龄，会把 16 岁写成 21 岁）
  seedIdentity(convo, next.name, next);
  seedPanelFromCharacters(convo, [next]);

  // 剧情选项：角色卡上开了就跟着这个会话生效。用的是**复制**而不是引用 ——
  // 之后改角色卡不该悄悄改掉正在进行的这一局。
  convo.optionsSpec = next.optionsSpec ? { ...next.optionsSpec } : null;
  if (!convo.optionsSpec) convo.options = [];

  if (next.firstMes && untouched) {
    // 空对话绑上带开场白的角色时，自动把开场白放进去，省得每次手动开个头
    convo.messages = [
      {
        role: 'assistant',
        content: applyMacros(next.firstMes, next, userName()),
        at: now(),
        greeting: true
      }
    ];
  }

  // 标题是跟着角色自动起的话，换角色时一起换掉
  const autoTitle = !convo.title || convo.title === '新对话' || (previous && convo.title === previous.name);
  if (autoTitle) convo.title = next.name;

  renderAll({ forceScroll: true });
  persistConversations(0);
}

/** 切换当前会话用的模型，同时记成「新会话」的默认模型 */
export function applyModelChoice(value) {
  const raw = String(value || '');
  const sep = raw.indexOf('::');
  if (sep < 0) return;

  const providerId = raw.slice(0, sep);
  const model = raw.slice(sep + 2);
  const provider = providerById(providerId);

  if (!provider || !model) {
    renderModelSwitch();
    return;
  }

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再切换模型');
    renderModelSwitch();
    return;
  }

  const convo = activeConvo();
  if (convo) {
    convo.providerId = providerId;
    convo.model = model;
    convo.updatedAt = now();
  }

  // 顺便设为新会话的默认值
  state.settings.activeProviderId = providerId;
  state.settings.activeModel = model;

  renderHeader();
  persistConversations(0);

  api
    .saveSettings({
      // 连 providers 一起存：这样刚添加、还没点「保存」的服务商不会被丢掉
      providers: providers(),
      activeProviderId: providerId,
      activeModel: model
    })
    .catch((err) => {
      console.error('保存模型选择失败', err);
      showToast('模型选择没能写入配置，重启后会回到默认值', 'error');
    });

  showToast(`已切换为 ${provider.name} · ${model}`, 'ok');
}
