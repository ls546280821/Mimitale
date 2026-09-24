'use strict';

// ============================================================================
//  views/stateCard.js —— 「状态卡」：点头像打开的浮动卡片
//
//  一张卡 = 某个人（owner）的状态字段。owner 的取值见 data/panel.js：
//    · 'player'   —— 我自己（玩世界书时种的就是这个）
//    · 角色卡 id  —— 某个角色（单角色聊天 / 世界书里的本书角色）
//  场景（owner 为空）不属于「某个人」，不在这里展示 —— 它留在顶部面板里。
//
//  卡片默认**只读**（纯文本展示，方便看）—— 用户的原话是「主要是用来查看」，
//  点「编辑」才把值切成输入框。可以拖动，位置按 owner 各记各的（视图状态，不落盘）。
//
//  写入复用 data/panel.js 的 setPanelField / appendPanelFields，
//  所以卡片里改的值和顶部面板改的值走的是**同一条**落盘路径，不会两边打架。
//
//  谁打开它：views/panelUi.js 的头像行、views/chatMessages.js 里「我」的头像。
// ============================================================================

import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { fieldProgress, groupPanelFields } from '../core/panel-fields.js';
import {
  convoPanel,
  convoPanelDef,
  convoPanelDefs,
  convoPanelFields,
  panelFieldAllowed,
  panelFieldGroup,
  panelFieldOwner,
  setPanelField,
  appendPanelFields
} from '../data/panel.js';
import { panelEntities } from '../data/cast.js';
import { persistConversations } from '../data/persist.js';
import { onRefresh, refreshAll } from './refresh.js';

// owner -> { x, y, editing, z }。位置/编辑态是「此刻怎么摆」，挂在模块里，不落盘。
const openCards = new Map();
// 上面这批卡属于哪个会话 —— 换会话一律清掉（卡里的字段是那一局的）
let cardsConvoId = null;
// 拖动/点击时把卡片提到最前面
let topZ = 1;

function entityFor(convo, owner) {
  return panelEntities(convo).find((e) => e.owner === owner) || null;
}

/** 某个人拥有的字段（按面板里的先后顺序） */
function ownerFields(convo, owner) {
  return convoPanelFields(convo).filter((n) => panelFieldOwner(convo, n) === owner);
}

/** 换会话就把开着的卡收掉 —— 卡里是上一局的字段 */
function syncCardsForConvo(convo) {
  const id = convo ? convo.id : null;
  if (id === cardsConvoId) return;
  cardsConvoId = id;
  openCards.clear();
}

/** 打开某个人的状态卡（已经开着就提到最前面） */
export function openStateCard(owner) {
  const convo = activeConvo();
  if (!convo || !owner) return;
  if (!openCards.has(owner)) {
    const n = openCards.size;
    const host = el.stateCards;
    const w = host ? host.clientWidth : 900;
    const h = host ? host.clientHeight : 640;
    // 默认落在对话区**右侧**的空白（气泡居中，右边通常是空的），多个之间错开一点。
    // 落在别处也没关系 —— 位置可以拖。
    openCards.set(owner, {
      x: Math.max(16, w - 274 - (n % 3) * 26),
      y: Math.max(84, Math.round(h * 0.3) + (n % 4) * 26),
      editing: false,
      z: ++topZ
    });
  } else {
    openCards.get(owner).z = ++topZ;
  }
  cardsConvoId = convo.id;
  renderStateCards();
}

export function closeStateCard(owner) {
  if (!openCards.has(owner)) return;
  openCards.delete(owner);
  renderStateCards();
}

/** 点卡片自身时提到最前 */
function bringToFront(owner) {
  const state = openCards.get(owner);
  if (state) state.z = ++topZ;
}

// ---------------------------------------------------------------------------
//  画三种行
// ---------------------------------------------------------------------------

/** 只读行：字段名 + 值（数值补进度条）。这是卡片的默认样子。 */
function viewRow(convo, name) {
  const value = String(convoPanel(convo)[name] == null ? '' : convoPanel(convo)[name]);
  const row = h(
    'div',
    { class: 'sc-row' },
    h('span', { class: 'sc-name', text: name, title: name }),
    h('span', { class: 'sc-value', text: value || '—', title: value })
  );

  const progress = fieldProgress(value, convoPanelDef(convo, name));
  if (progress) {
    row.classList.add('has-bar');
    const bar = h('div', { class: 'sc-bar' }, h('div', { class: 'sc-bar-fill' }));
    bar.querySelector('.sc-bar-fill').style.width = `${progress.percent}%`;
    row.appendChild(bar);
  }
  return row;
}

/** 编辑行：值变成输入框，右边一个删除。改完走 setPanelField（和面板同一条路）。 */
function editRow(convo, name) {
  const input = h('input', {
    type: 'text',
    class: 'sc-input',
    value: String(convoPanel(convo)[name] == null ? '' : convoPanel(convo)[name]),
    spellcheck: 'false',
    'aria-label': name
  });
  input.addEventListener('input', () => {
    clearTimeout(input._scTimer);
    input._scTimer = setTimeout(() => setPanelField(convo, name, input.value), 400);
  });
  input.addEventListener('blur', () => {
    clearTimeout(input._scTimer);
    setPanelField(convo, name, input.value);
  });

  return h(
    'div',
    { class: 'sc-row editing' },
    h('span', { class: 'sc-name', text: name, title: name }),
    input,
    button({
      class: 'sc-del',
      text: '✕',
      title: '从状态里删掉这个字段',
      onClick: () => removeField(convo, name)
    })
  );
}

/** 编辑态底部：加一个新字段 */
function addRow(convo, owner) {
  const input = h('input', {
    type: 'text',
    class: 'sc-input sc-new',
    placeholder: '新字段名',
    spellcheck: 'false',
    'aria-label': '新字段名'
  });

  const tryAdd = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }

    if (!panelFieldAllowed(name)) {
      showToast(`「${name}」是状态栏的保留字段名，换一个吧`, 'error');
      input.focus();
      return;
    }

    // 字段名在**整个会话里只能有一个**：面板注入给模型的是「【名字】：值」，
    // 同名的话模型分不出是谁的。所以要分两种情况说清楚 ——
    //   · 这张卡自己已经有了 → 提示重复；
    //   · 这张卡没有、但**别人**（角色）占了 → 别说「已经有了」（用户会懵：
    //     我这张卡明明没有啊），得说清是谁占的、并给个可用的替代名。
    const holders = convoPanelFields(convo).filter((n) => n === name);
    if (holders.some((n) => panelFieldOwner(convo, n) === owner)) {
      showToast(`这张卡里已经有「${name}」了`, 'error');
      input.focus();
      return;
    }
    if (holders.length) {
      const whose = panelFieldOwner(convo, holders[0]) === 'player' ? '你自己那边' : '角色那边';
      showToast(`「${name}」已经被${whose}占了（同名只能有一个）—— 换个名字，比如「我的${name}」`, 'error');
      input.focus();
      return;
    }

    appendPanelFields(convo, [{ name, value: '', owner }]);
    // 加完把这个输入框清掉、并让它失焦 —— 免得「卡片重绘保护」把这次刷新挡掉
    // （见 renderStateCards 里那条：值输入框有焦点时不重建），
    // 也方便接着加下一个。
    input.value = '';
    input.blur();
    persistConversations(0);
    renderStateCards();
    refreshAll();
  };

  const add = button({
    class: 'sc-add-btn',
    text: '＋ 添加',
    title: '加一个状态字段',
    onClick: tryAdd
  });

  // 回车即添加
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      tryAdd();
    }
  });

  return h('div', { class: 'sc-add' }, input, add);
}

function removeField(convo, name) {
  convo.panelFields = convoPanelFields(convo).filter((n) => n !== name);
  const panel = { ...convoPanel(convo) };
  delete panel[name];
  convo.panel = panel;
  const defs = { ...convoPanelDefs(convo) };
  delete defs[name];
  convo.panelDefs = defs;
  convo.updatedAt = now();
  persistConversations(0);
  renderStateCards();
  refreshAll();
}

// ---------------------------------------------------------------------------
//  拖动
// ---------------------------------------------------------------------------

function wireDrag(card, head, state) {
  head.addEventListener('pointerdown', (event) => {
    // 卡片头部里的按钮（编辑 / ✕）不参与拖动
    if (event.target.closest('button')) return;
    event.preventDefault();
    bringToFront(card.dataset.owner);

    const startX = event.clientX;
    const startY = event.clientY;
    const originX = state.x;
    const originY = state.y;

    head.setPointerCapture(event.pointerId);

    const move = (e) => {
      const host = el.stateCards;
      const maxX = Math.max(0, (host ? host.clientWidth : 0) - 60);
      const maxY = Math.max(0, (host ? host.clientHeight : 0) - 40);
      state.x = Math.max(-card.offsetWidth + 60, Math.min(maxX, originX + (e.clientX - startX)));
      state.y = Math.max(0, Math.min(maxY, originY + (e.clientY - startY)));
      card.style.left = `${state.x}px`;
      card.style.top = `${state.y}px`;
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };

    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}

// ---------------------------------------------------------------------------
//  画卡片
// ---------------------------------------------------------------------------

function buildCard(convo, owner, state) {
  const entity = entityFor(convo, owner);
  const name = (entity && entity.name) || owner;

  const card = h('div', { class: 'state-card' });
  card.dataset.owner = owner;
  card.style.left = `${state.x}px`;
  card.style.top = `${state.y}px`;
  card.style.zIndex = String(state.z || 1);
  card.addEventListener('pointerdown', () => bringToFront(owner));

  const avatar = h('span', { class: 'sc-avatar' });
  if (entity && entity.avatar) {
    avatar.appendChild(h('img', { src: entity.avatar, alt: '' }));
  } else {
    avatar.textContent = owner === 'player' ? '我' : name.slice(0, 1);
  }

  const head = h(
    'div',
    { class: 'sc-head' },
    avatar,
    h('span', { class: 'sc-title', text: name, title: name }),
    button({
      class: 'sc-edit',
      text: state.editing ? '完成' : '编辑',
      title: state.editing ? '退出编辑（回到只读展示）' : '编辑这张卡（默认只读）',
      onClick: () => {
        state.editing = !state.editing;
        renderStateCards();
      }
    }),
    button({
      class: 'sc-close',
      text: '✕',
      title: '关闭这张状态卡',
      onClick: () => closeStateCard(owner)
    })
  );
  card.appendChild(head);

  const body = h('div', { class: 'sc-body' });
  const fields = ownerFields(convo, owner);
  if (!fields.length) {
    body.appendChild(
      h('div', {
        class: 'sc-empty',
        text: state.editing ? '还没有字段，在下面加一个' : '还没有状态字段 —— 点「编辑」可以加'
      })
    );
  } else {
    // 按分组铺（和面板同一套分组键，见 panel-fields.js 的 groupPanelFields）：
    // 有分组的先给个小标题，没分组的直接铺 —— 角色字段搬过来之后，
    // 「状态栏 / 关系 / 背包 / 身份」这层结构得跟着一起过来，不能丢。
    const buckets = groupPanelFields(fields.map((name) => ({ name, group: panelFieldGroup(convo, name) })));
    for (const bucket of buckets) {
      if (bucket.id) {
        body.appendChild(h('div', { class: 'sc-group-title', text: bucket.id, title: bucket.id }));
      }
      for (const { name } of bucket.fields) {
        body.appendChild(state.editing ? editRow(convo, name) : viewRow(convo, name));
      }
    }
  }
  if (state.editing) body.appendChild(addRow(convo, owner));
  card.appendChild(body);

  wireDrag(card, head, state);
  return card;
}

/**
 * 重画所有开着的卡。登记在刷新总线上（面板值变了、换会话了都要跟着更新）。
 *
 * 卡片里正有**值输入框**在编辑时不重建 DOM —— 否则每敲一个字都重建，
 * 光标和内容会被打断（和 panelUi 里那条规矩一样）。
 * ⚠️ 只挡「值输入框」：底部那个「新字段名」框不算 —— 加完字段就得重绘把它显示出来，
 * 挡了会出现「点了添加、卡片没反应」。
 */
export function renderStateCards() {
  const host = el.stateCards;
  if (!host) return;

  const convo = activeConvo();
  syncCardsForConvo(convo);

  const active = document.activeElement;
  const typingValue =
    active &&
    active.tagName === 'INPUT' &&
    active.classList.contains('sc-input') &&
    !active.classList.contains('sc-new') &&
    host.contains(active);
  if (typingValue) return;

  clear(host);
  if (!convo || !openCards.size) return;

  // 已经不在场的人（面板被重置 / 换绑角色）→ 收掉那张卡
  const live = new Set(panelEntities(convo).map((e) => e.owner));
  for (const owner of [...openCards.keys()]) {
    if (!live.has(owner)) openCards.delete(owner);
  }
  if (!openCards.size) return;

  for (const [owner, state] of openCards) {
    host.appendChild(buildCard(convo, owner, state));
  }
}

/** 登记重绘。由 main.js 的 registerRefreshListeners() 调用。 */
export function initStateCards() {
  onRefresh(renderStateCards);
}
