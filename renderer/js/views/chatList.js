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
import { closeModelMenu } from '../ui/modelMenu.js';
import { entityTone } from '../ui/avatarTone.js';
import { providers, providerById, currentEndpoint, isBridgeProvider } from '../data/providers.js';
import { characterById, worldbookById, convoWorldbookIds } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters } from '../data/panel.js';
import { applyMacros } from '../data/messages.js';
import { userName } from '../data/cast.js';
import { persistConversations } from '../data/persist.js';
import { renderHeader } from './header.js';
import { renderAll } from './redraw.js';
import { switchConvo, removeConvo } from './convoActions.js';

export function renderConvoList() {
  clear(el.convoList);

  // 分组标题带条数，像设计稿那样写成「最近 · 5」
  if (el.convoCap) {
    el.convoCap.textContent = state.conversations.length
      ? `最近 · ${state.conversations.length}`
      : '最近';
  }

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
        convoAvatar(convo),
        // 两行：名字 + 「谁 · 什么时候」。有了副行，条目才不只是一串标题，
        // 也不用再靠左侧那条竖线标「当前」了。
        h(
          'div',
          { class: 'convo-info' },
          h('span', { class: 'convo-title', text: label, title: label }),
          h('span', { class: 'convo-sub', text: convoSub(convo, label) })
        ),
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

/**
 * 会话条目左边那个小圆头像：一眼看出这一条是跟谁聊的。
 *   绑了角色   → 角色头像，没传头像就取名字首字
 *   世界书会话 → 世界书名首字（浅色底，和角色区分开）
 *   都不是     → 一个中性小点，纯占位，保持每条都对齐
 */
function convoAvatar(convo) {
  const char = convo.characterId ? characterById(convo.characterId) : null;
  if (char) {
    const node = h('span', {
      class: `convo-avatar ${entityTone(char.id, char.name)}`,
      title: char.name
    });
    if (char.avatar) node.appendChild(h('img', { src: char.avatar, alt: '' }));
    else node.textContent = char.name.slice(0, 1);
    return node;
  }

  const wbId = convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  if (wb) {
    // 世界书会话的头像是**方的**（设计稿 .ava.book）—— 形状本身就是分类，
    // 不用再挂标签去区分「跟角色聊」和「在书里玩」。
    return h('span', {
      class: `convo-avatar book ${entityTone(wb.id, wb.name)}`,
      text: wb.name.slice(0, 1),
      title: wb.name
    });
  }

  return h('span', { class: 'convo-avatar plain', text: '·' });
}

/**
 * 会话条目的副标题：「谁 · 什么时候」。
 * 标题已经是那个名字时就不重复（绑了角色的会话，标题默认就是角色名）。
 */
function convoSub(convo, title) {
  const char = convo.characterId ? characterById(convo.characterId) : null;
  const wbId = char ? '' : convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  const who = (char && char.name) || (wb && wb.name) || '';

  const parts = [];
  if (who && who !== title) parts.push(who);
  const when = relativeTime(convo.updatedAt);
  if (when) parts.push(when);
  return parts.join(' · ') || '还没有消息';
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 5 天前 / 2 个月前 */
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = 60e3;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return `${Math.floor(diff / (30 * day))} 个月前`;
}

/** 当前端点的 `服务商id::模型名`，没选就空串（和选项的 value 同一套写法） */
function modelChoiceValue() {
  const endpoint = currentEndpoint();
  if (!endpoint || !endpoint.provider || !endpoint.model) return '';
  return `${endpoint.provider.id}::${endpoint.model}`;
}

/** 选项行右边的勾。没选中的行也占着这块位置（CSS 里 opacity:0），文字不会左右跳。
 *  ⚠️ SVG 得走 createElementNS —— build.js 的 h() 是 createElement，
 *  建出来的只是「名叫 svg 的普通元素」，根本不画。 */
function checkIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'model-menu-check');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'm4 12.5 5.5 5.5L20 6.5');
  svg.appendChild(path);
  return svg;
}

/**
 * 右上角切换模型：按钮上写当前模型，点开是一个按服务商分组的弹层。
 *
 * 以前这里是原生 <select>。原生下拉的**列表**由系统画（直角、系统蓝高亮、
 * 系统字体），CSS 碰不到 —— 跟这套「大圆角 + 柔和阴影」完全不搭，所以换成
 * 和「⋯」共用的 .menu-pop 弹层。开合逻辑在 ui/modelMenu.js，这里只负责铺内容。
 *
 * 顶栏那一行是**每次都重画的**（refreshAll 会喊它），所以铺的时候顺手把
 * 滚动位置记下来还回去，免得正翻着列表被别的重绘弹回顶部。
 */
export function renderModelSwitch() {
  const trigger = el.modelSwitch;
  const menu = el.modelMenu;
  if (!trigger || !menu) return;

  const label = el.modelSwitchLabel;
  const endpoint = currentEndpoint();
  const list = providers();
  const active = modelChoiceValue();
  const scrollTop = menu.scrollTop;

  // 按钮上那行字：选了模型就写模型名，没选就写「选择模型」/「未配置模型」
  if (label) {
    label.textContent = endpoint && endpoint.model
      ? endpoint.model
      : list.length
        ? '选择模型'
        : '未配置模型';
  }
  trigger.title = `切换当前会话使用的模型（当前：${label ? label.textContent : '未选'}）`;

  clear(menu);

  if (!list.length) {
    // 一个服务商都没有：按钮收成一块「提示」，弹层里说清楚去哪儿配
    menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有配置模型服务 —— 点左下角「设置」' }));
    trigger.disabled = true;
    closeModelMenu();
    return;
  }

  for (const p of list) {
    // 本机桥接免 Key，别标「未填 Key」误导用户（和原来 select 的分组标题一致）
    menu.appendChild(h('div', {
      class: 'model-menu-group',
      text: isBridgeProvider(p) || p.apiKey ? p.name : `${p.name}（未填 Key）`
    }));

    if (!p.models || !p.models.length) {
      menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有模型' }));
      continue;
    }

    for (const m of p.models) {
      const value = `${p.id}::${m}`;
      const isActive = value === active;
      menu.appendChild(h('button', {
        type: 'button',
        class: ['model-menu-item', isActive && 'is-active'],
        role: 'menuitemradio',
        'aria-checked': isActive ? 'true' : 'false',
        dataset: { value },
        // 模型名可能很长，截断之后靠 title 兜底看全名
        title: m
      },
        h('span', { class: 'model-menu-name', text: m }),
        checkIcon()
      ));
    }
  }

  trigger.disabled = false;
  menu.scrollTop = scrollTop;
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
  seedIdentity(convo, next.name, next, next.id);
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
  // 以前这里是原生 select，它自己会把选中的那项显出来；现在是自绘的按钮 + 弹层，
  // 按钮上那行字和列表里的勾都得自己重画一遍。
  renderModelSwitch();
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
