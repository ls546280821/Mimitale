'use strict';

// ============================================================================
//  views/panelUi.js —— 状态面板
//
//  状态面板是「谁来维护当前局面」的答案：字段、当前值、范围、分组全由程序
//  权威注入（见 data/panel.js 的 formatPanelForPrompt），模型每轮照抄更新。
//  本模块只管把那份状态画出来、以及让人能手动改 / 删 / 清空。
//
//  本模块负责：
//    · 展开 / 收起 —— 状态属于会话，切到别的会话一律默认收起
//    · 字段行：单行输入框（边打字边存、防抖）、数值进度条、列表项数
//    · 删单个字段 / 清空整个面板
//
//  不在这里的：
//    · 解析、归一化、范围夹取、注入提示词 —— 都在 data/panel.js，本模块只向下取
//    · appendPanelFields / seedPanelFromCharacters / seedIdentity /
//      syncPlayerNameFromPanel —— 「面板怎么长出来」的写入口，入口层和聊天
//      流程两头都要用，所以属于 data 层（也在 data/panel.js）
//    · 剧情选项 —— 画在聊天区最新一条 AI 回复的气泡下面（chatMessages.js），
//      点选项 / 换一批 / 收起的动作在 suggestionsUi.js
//
//  renderHeader 是**单向**依赖：header.js 只依赖数据层、不认识任何视图，
//  所以视图 import 它不构成循环 —— 那条「视图之间不互相 import」的铁律
//  防的是循环，不是一切跨视图调用。面板字段值改完要刷头部，同理。
// ============================================================================

import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import {
  fieldProgress,
  groupPanelFields,
  parseNumericValue,
  trimNumber
} from '../core/panel-fields.js';
import { persistConversations } from '../data/persist.js';
import {
  convoPanel,
  convoPanelDef,
  convoPanelFields,
  panelFieldGroup,
  setPanelField
} from '../data/panel.js';
import { onRefresh, refreshAll } from './refresh.js';
import { renderHeader } from './header.js';

let panelVisible = false; // 面板展开状态（当前会话）
let panelVisibilityConvoId = null; // 上面这个状态属于哪个会话

/**
 * 面板展开状态的同步规则：
 *   · 切到别的会话 —— **一律默认收起**。面板挺占地方，想看的时候自己点开
 *     （收起时留着一条细条，随时能点）
 *   · 同一会话里 —— 什么都不做，尊重用户手动收起/展开
 *
 * 不能每次重绘都按「有没有面板」重算：流式输出期间刷新会被频繁调用，
 * 那样会把用户手动收起的面板又弹开。
 */
function syncPanelVisibilityForConvo(convo) {
  const id = convo ? convo.id : null;
  if (id === panelVisibilityConvoId) return;

  panelVisibilityConvoId = id;
  panelVisible = false;
}

function currentPanelTextarea() {
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains('panel-value')) {
    return { name: active.dataset.field, node: active };
  }
  return null;
}

/** 面板行的值改成单行输入框，边打字边存（防抖） */
function attachPanelEditor(convo, name, input) {
  input.addEventListener('input', () => {
    clearTimeout(input._panelTimer);
    input._panelTimer = setTimeout(() => {
      setPanelField(convo, name, input.value);
      renderHeader();
    }, 400);
  });
  // 失焦立即落盘，避免切换会话时丢掉最后几个字
  input.addEventListener('blur', () => {
    clearTimeout(input._panelTimer);
    setPanelField(convo, name, input.value);
  });
}

export function renderPanel() {
  const convo = activeConvo();
  const fields = convo ? convoPanelFields(convo) : [];
  // 面板只管状态字段 —— 剧情选项挂在聊天区最新一条 AI 回复的气泡下面
  // （chatMessages.js 画，suggestionsUi.js 接动作），这里不再重复一份。
  const hasPanel = fields.length > 0;

  // 收起后不整块藏起来，只留标题那一条 —— 否则「能点开」这件事就没人看得见了
  el.panelBox.classList.toggle('hidden', !hasPanel);
  el.panelBox.classList.toggle('collapsed', !panelVisible);

  if (!hasPanel) {
    el.panelFields.innerHTML = '';
    return;
  }

  el.btnPanelCollapse.setAttribute('aria-expanded', panelVisible ? 'true' : 'false');

  const panel = convoPanel(convo);
  const filled = fields.filter((n) => String(panel[n] || '').trim()).length;
  el.panelHint.textContent = `${filled}/${fields.length} 项已填`;

  // 面板里某个输入框正在编辑时不要重建 DOM，否则光标和输入内容会被打断
  const editing = currentPanelTextarea();
  if (editing && el.panelFields.querySelector(`[data-field="${CSS.escape(editing.name)}"]`)) return;

  clear(el.panelFields);

  // 按分组铺：每个分组自己一块（标题 + 该组的字段），没分组的字段直接铺在
  // 顶层、不额外加标题 —— 老会话没有分组，看到的和以前一模一样。
  // 身份四项例外：不管新老会话都归「身份」组（panelFieldGroup 按字段名兜底）。
  const buckets = groupPanelFields(fields.map((name) => ({ name, group: panelFieldGroup(convo, name) })));

  for (const bucket of buckets) {
    const host = bucket.id
      ? h(
          'div',
          { class: 'panel-group' },
          h('div', { class: 'panel-group-title', text: bucket.id, title: bucket.id })
        )
      : el.panelFields;

    for (const { name } of bucket.fields) appendPanelRow(convo, name, panel[name], host);
    if (bucket.id) el.panelFields.appendChild(host);
  }
}

/** 列表型字段里有几项（按「、」和「,」切；空值算 0 项） */
function listItemCount(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return 0;
  return text
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** 铺一行「字段名 + 值输入框 + 删除」 */
function appendPanelRow(convo, name, value, container) {
  const input = h('input', {
    type: 'text',
    class: 'panel-value',
    dataset: { field: name },
    value: value || '',
    spellcheck: 'false',
    'aria-label': name
  });
  attachPanelEditor(convo, name, input);

  // 数值字段的值是「60/100」这种，末尾那个 /100 是满值、不是可编辑内容，
  // 所以拆出来单独显示成一个小标记，让输入框里只剩要改的数字。
  const def = convoPanelDef(convo, name);
  const parsed = def && def.type === 'meter' ? parseNumericValue(String(value == null ? '' : value)) : null;
  const unit = parsed && parsed.total !== null ? `/${trimNumber(parsed.total)}` : '';
  if (unit) input.value = trimNumber(parsed.n);

  const row = h(
    'div',
    { class: 'panel-row' },
    h('span', { class: 'panel-name', text: name, title: name }),
    input,
    unit ? h('span', { class: 'panel-unit', text: unit }) : null,
    // 列表类型：显示有几项，提醒它是「多项用、隔开」而不是一句话
    def && def.type === 'list'
      ? h('span', {
          class: 'panel-list-count',
          text: listItemCount(value) > 0 ? `${listItemCount(value)} 项` : '空',
          title: '多项用「、」隔开'
        })
      : null,
    button({
      class: 'panel-del',
      text: '✕',
      title: '从面板里移除这个字段',
      onClick: () => removePanelField(convo, name)
    })
  );

  // 数值字段补一条进度条 —— 光看「60/100」不知道离满还有多远。
  const progress = fieldProgress(String(value == null ? '' : value), def);
  if (progress) {
    // 带条的行要占满整行，见 style.css 里的 .panel-row.has-bar
    row.classList.add('has-bar');
    const bar = h(
      'div',
      { class: 'panel-bar', role: 'progressbar' },
      h('div', { class: 'panel-bar-fill' })
    );
    bar.setAttribute('aria-valuenow', String(progress.n));
    bar.setAttribute('aria-valuemin', String(typeof def.min === 'number' ? def.min : 0));
    bar.setAttribute('aria-valuemax', String(progress.total));
    bar.querySelector('.panel-bar-fill').style.width = `${progress.percent}%`;
    row.appendChild(bar);
  }

  container.appendChild(row);
}

function removePanelField(convo, name) {
  if (!convo) return;
  convo.panelFields = convoPanelFields(convo).filter((n) => n !== name);
  const panel = { ...convoPanel(convo) };
  delete panel[name];
  convo.panel = panel;
  convo.updatedAt = now();
  refreshAll();
  persistConversations(0);
}

function togglePanel() {
  panelVisible = !panelVisible;
  renderPanel();
}

function resetPanel() {
  const convo = activeConvo();
  if (!convo) return;

  convo.panel = {};
  convo.panelFields = [];
  // 字段定义也一起清掉 —— 留着它，字段重新出现时会带着旧范围，容易莫名其妙
  convo.panelDefs = {};
  // 这一轮攒的选项同样作废（面板都清了，留着几个按钮没有对应状态）
  convo.options = [];
  convo.updatedAt = now();
  refreshAll();
  persistConversations(0);
  showToast('面板已清空，下一条带状态栏的回复会重新建立');
}

/**
 * 事件绑定 + 向刷新总线登记自己的重绘。
 *
 * 由 main.js 的 registerRefreshListeners() 在原位调用 —— 登记必须早于第一次
 * 广播，而且登记顺序要和以前的绘制顺序一致（先可见性、再面板）。
 */
export function initPanelUi() {
  el.btnPanelCollapse.addEventListener('click', togglePanel);
  // 整条标题栏都能点（「重置」那种按钮除外，它们自己处理点击）
  el.panelHead.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    togglePanel();
  });
  el.btnPanelReset.addEventListener('click', resetPanel);

  onRefresh(() => syncPanelVisibilityForConvo(activeConvo()));
  onRefresh(renderPanel);
}
