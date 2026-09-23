'use strict';

// ============================================================================
//  views/charAttributes.js —— 角色属性（状态面板的字段模板）编辑器
//
//  玩法：在角色卡上先声明「这个角色有哪些属性」（金币/上衣/下衣…），
//  绑定时把它们种进会话的状态面板 —— 于是 AI 第一轮就知道该维护哪些字段，
//  不用等它自己碰巧输出一个【金币】：100。
//
//  这里填的是**初始值（模板）**；进游戏之后在面板里改的是**那一局的当前值**。
//  两者分开存，改角色卡不会影响正在进行的游戏。
//
//  和其他视图模块不同：它不持有草稿，而是**接收**一个数组（渲染时传进来）。
//  因为那份草稿的所有者是角色编辑器（保存时要跟表单一起写回角色卡），
//  让它自己存一份就得来回同步 —— 传引用、就地改，两边看到的永远是同一份。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { MAX_PANEL_FIELDS, panelFieldAllowed } from '../data/panel.js';

/** 编辑器里的字段类型选择框（文本 / 数值 / 列表） */
const ATTR_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'meter', label: '数值' },
  { value: 'list', label: '列表' }
];

/**
 * 重画编辑器的属性区：上面的快捷候选词 + 下面已加的属性行。
 *
 * 每行是「名字 + 初始值 + 类型 + 更多」。范围/变化规则收在「更多」里，
 * 平时只露出名字和值 —— 大多数属性就是个文本，不该被一排输入框淹掉。
 */
export function renderCharAttrs(list) {
  if (!el.c.attrList) return;

  // 快捷候选词：已经在属性里的就不再显示，免得点了个寂寞
  const used = new Set(list.map((a) => a.name));
  const quick = (state.settings && state.settings.commonAttributes) || [];
  clear(el.c.attrQuick);
  for (const name of quick) {
    if (used.has(name)) continue;
    el.c.attrQuick.appendChild(
      button({ class: 'attr-quick-btn', text: `＋ ${name}`, onClick: () => addCharAttr(list, name) })
    );
  }
  el.c.attrQuick.classList.toggle('hidden', !el.c.attrQuick.childElementCount);

  // 已加的属性。输入框里改值只更新草稿，不重画 —— 一重画光标就跳走了。
  clear(el.c.attrList);

  // 分组建议：这张卡里已经用过的分组名。datalist 只是「可下拉选」，
  // 不限制你写新名字（想新建一组直接打字）。
  const groupSuggest = el.c.attrList.parentElement && el.c.attrList.parentElement.querySelector('#attr-group-suggest');
  if (groupSuggest) {
    clear(groupSuggest);
    const names = [...new Set(list.map((a) => (a.group || '').trim()).filter(Boolean))];
    for (const g of names) groupSuggest.appendChild(h('option', { value: g }));
  }

  list.forEach((attr, index) => {
    const valueInput = h('input', {
      type: 'text',
      class: 'attr-value',
      value: attr.value,
      spellcheck: 'false',
      placeholder: '初始值（可以留空）',
      'aria-label': `${attr.name} 的初始值`,
      oninput: () => {
        attr.value = valueInput.value;
      }
    });

    const typeSelect = h(
      'select',
      {
        class: 'attr-type',
        'aria-label': `${attr.name} 的类型`,
        title: '字段类型：数值可以设范围，超出范围时程序会拉回来',
        onchange: () => {
          const next = typeSelect.value;
          // 切到「数值」时自动把「更多」展开 —— 否则用户选了类型还得再点一次
          // 才能看到范围输入框，很容易以为这个功能不存在。
          if (next === 'meter' && attr.type !== 'meter') attr._moreOpen = true;
          attr.type = next;
          renderCharAttrs(list);
        }
      },
      ATTR_TYPES.map((t) => h('option', { value: t.value, text: t.label, selected: (attr.type || 'text') === t.value }))
    );

    // 「更多」：默认展开条件是「已经有范围或规则」，但用户手动收起/展开过
    // 就以手动状态为准（_moreOpen 是 true/false/undefined 三态）——
    // 只看 hasMore 的话，一旦设过范围就再也收不起来了。
    const hasMore = typeof attr.min === 'number' || typeof attr.max === 'number' || !!attr.hint || !!attr.group;
    const moreOpen = attr._moreOpen === undefined ? hasMore : attr._moreOpen === true;

    const moreBtn = button({
      class: 'attr-more-btn',
      text: moreOpen ? '收起' : '更多',
      title: '范围与变化规则',
      onClick: () => {
        attr._moreOpen = !moreOpen;
        renderCharAttrs(list);
      }
    });

    const row = h(
      'div',
      { class: 'attr-row' },
      h('span', { class: 'attr-name', text: attr.name, title: attr.name }),
      valueInput,
      typeSelect,
      moreBtn,
      button({
        class: 'panel-del',
        text: '✕',
        title: '删掉这个属性',
        onClick: () => {
          list.splice(index, 1);
          renderCharAttrs(list);
        }
      })
    );

    const wrap = h('div', { class: 'attr-item' }, row);

    if (moreOpen) {
      // 范围输入框（只在「数值」类型下有意义）
      const numInput = (key, placeholder, label) =>
        h('input', {
          type: 'number',
          class: 'attr-num',
          value: typeof attr[key] === 'number' ? String(attr[key]) : '',
          placeholder,
          spellcheck: 'false',
          'aria-label': `${attr.name} 的${label}`,
          oninput: (event) => {
            const raw = String(event.target.value || '').trim();
            if (raw === '' || !isFinite(Number(raw))) delete attr[key];
            else attr[key] = Number(raw);
          }
        });

      const minInput = numInput('min', '下限', '最小值');
      const maxInput = numInput('max', '上限', '最大值');

      const hintInput = h('input', {
        type: 'text',
        class: 'attr-hint',
        value: attr.hint || '',
        spellcheck: 'false',
        placeholder: '变化规则（给模型看，比如「示好时每轮最多加 10」）',
        'aria-label': `${attr.name} 的变化规则`,
        oninput: () => {
          const text = hintInput.value;
          if (text.trim()) attr.hint = text;
          else delete attr.hint;
        }
      });

      // 分组：填同一个名字的字段在状态面板里归到一组（留空 = 不分组）
      const groupInput = h('input', {
        type: 'text',
        class: 'attr-group',
        value: attr.group || '',
        spellcheck: 'false',
        list: 'attr-group-suggest',
        placeholder: '分组（可留空，比如「关系」）',
        'aria-label': `${attr.name} 的分组`,
        oninput: () => {
          const text = groupInput.value.trim();
          if (text) attr.group = text;
          else delete attr.group;
        }
      });

      const more = h('div', { class: 'attr-more' });
      if ((attr.type || 'text') === 'meter') {
        more.appendChild(
          h('div', { class: 'attr-range' }, h('span', { class: 'attr-range-label', text: '数值范围' }), minInput, h('span', { class: 'attr-range-sep', text: '~' }), maxInput)
        );
      }
      more.appendChild(hintInput);
      more.appendChild(groupInput);
      wrap.appendChild(more);
    }

    el.c.attrList.appendChild(wrap);
  });
}

/**
 * 把粘贴进来的一段文本解析成属性。
 *
 * 一行一项，认这几种写法：
 *   【金币】：9900      金币：9900      金币:9900
 *   金币	9900          金币 9900
 * 冒号后面留空也算（就是「有这个名字、值先空着」）。
 *
 * 认不出来的行**直接跳过**，不报错 —— 粘贴过来的文本经常带标题、空行、说明文字，
 * 为了几行杂音打断整次粘贴不值得。跳过了多少行会告诉用户。
 */
function parseAttributesFromText(text) {
  const pairs = [];
  const seen = new Set();
  let skipped = 0;

  for (const rawLine of String(text || '').split('\n')) {
    // 去掉列表符号（- * + •）和首尾空白
    const line = rawLine.trim().replace(/^[-*+•]\s*/, '').trim();
    if (!line) continue;

    // 【名字】：值 —— 先试这个，否则下面的通用规则会把「【金币】」连括号一起当名字
    let m = line.match(/^【([^】\n]{1,24})】\s*[：:]\s*(.*)$/);
    // 名字：值 / 名字:值
    if (!m) m = line.match(/^([^：:\n]{1,24}?)\s*[：:]\s*(.*)$/);
    // 名字 + 空格/Tab + 值
    if (!m) m = line.match(/^([^\s：:]{1,24})[\s\u3000]+(.+)$/);

    if (!m) {
      skipped++;
      continue;
    }

    const name = m[1].trim();
    const value = String(m[2] || '').trim().slice(0, 200);
    if (!name || seen.has(name)) continue;
    if (!panelFieldAllowed(name)) {
      skipped++;
      continue;
    }

    seen.add(name);
    pairs.push({ name: name.slice(0, 24), value });
  }

  return { pairs, skipped };
}

/** 把解析出来的属性并进草稿：新的追加，同名的覆盖值 */
function applyParsedAttributes(list, pairs) {
  let added = 0;
  let updated = 0;

  for (const item of pairs) {
    const existing = list.find((a) => a.name === item.name);
    if (existing) {
      if (existing.value !== item.value) {
        existing.value = item.value;
        updated++;
      }
      continue;
    }
    if (list.length >= MAX_PANEL_FIELDS) break;
    list.push({ name: item.name, value: item.value });
    added++;
  }

  renderCharAttrs(list);
  return { added, updated };
}

export function toggleAttrPaste(show) {
  const next = typeof show === 'boolean' ? show : el.c.attrPaste.classList.contains('hidden');
  el.c.attrPaste.classList.toggle('hidden', !next);
  if (next) el.c.attrPasteText.focus();
}

/** 点「解析并加入」：解析 + 合并 + 告诉用户结果 */
export function applyAttrPaste(list) {
  const text = el.c.attrPasteText.value;
  if (!String(text).trim()) {
    showToast('先把文本粘进来', 'error');
    el.c.attrPasteText.focus();
    return;
  }

  const { pairs, skipped } = parseAttributesFromText(text);
  if (!pairs.length) {
    showToast('没认出任何属性，检查一下格式（一行一项，比如「金币：9900」）', 'error');
    return;
  }

  const { added, updated } = applyParsedAttributes(list, pairs);
  el.c.attrPasteText.value = '';
  toggleAttrPaste(false);

  const bits = [];
  if (added) bits.push(`新增 ${added} 项`);
  if (updated) bits.push(`更新 ${updated} 项`);
  if (skipped) bits.push(`跳过 ${skipped} 行`);
  showToast(`已解析：${bits.join('，')}`, 'ok');
}

/** 加一个属性：保留字拦下，重名跳过 */
export function addCharAttr(list, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  if (!name) return;

  if (!panelFieldAllowed(name)) {
    showToast(`「${name}」是状态栏的保留字段名，换一个吧`, 'error');
    return;
  }
  if (list.some((a) => a.name === name)) {
    showToast(`已经有「${name}」了`);
    return;
  }
  if (list.length >= MAX_PANEL_FIELDS) return;

  list.push({ name, value: '' });
  renderCharAttrs(list);
}

// 草稿数组的所有者是角色编辑器（保存时要跟表单一起写回角色卡），
// 所以这里不存它，只在需要的时候问一声。
let getDraft = () => [];

/** 绑属性区的按钮（快捷候选词是渲染时就带的，不用绑） */
export function initCharAttrsUi({ getList } = {}) {
  if (typeof getList === 'function') getDraft = getList;

  // 加点属性：按钮和回车都能加
  el.btnAddAttr.addEventListener('click', () => {
    addCharAttr(getDraft(), el.c.attrNew.value);
    el.c.attrNew.value = '';
    el.c.attrNew.focus();
  });

  el.c.attrNew.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCharAttr(getDraft(), el.c.attrNew.value);
    el.c.attrNew.value = '';
  });

  // 批量粘贴：一行一项，省得一条条手打
  el.c.btnAttrPaste.addEventListener('click', () => toggleAttrPaste());
  el.c.btnAttrPasteApply.addEventListener('click', () => applyAttrPaste(getDraft()));
}
