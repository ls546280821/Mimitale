'use strict';

// ============================================================================
//  views/charAttributes.js —— 角色属性（状态面板的字段模板）编辑器
//
//  玩法：在角色卡上先声明「这个角色有哪些属性」（金币/上衣/好感度…），
//  绑定时把它们种进会话的状态面板 —— 于是 AI 第一轮就知道该维护哪些字段，
//  不用等它自己碰巧输出一个【金币】：100。
//
//  ★ 分组只是**视图键**：属性在数据上仍是一维数组，分组记在每个字段自己的
//    `group` 上。标签栏点哪个，下面就只铺哪一组的字段。
//    这么切的原因：数据形状一个字都不用改，于是导出 / 导入 / 面板注入 /
//    既有的存盘断言全都不受影响，改动被关在「属性编辑器」这一块里。
//    面板注入那边的分组小标题（—— 关系 ——）走的是同一批 group 值。
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
import { confirmDialog } from '../ui/confirm.js';
import { h, button, clear, append } from '../ui/build.js';
import { MAX_PANEL_FIELDS, panelFieldAllowed } from '../data/panel.js';

/** 编辑器里的字段类型选择框（文本 / 数值 / 列表） */
const ATTR_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'meter', label: '数值' },
  { value: 'list', label: '列表' }
];

/** 「没有归到任何分组」那一桶在界面上的标题；数据上它对应 group === ''。 */
const UNGROUPED_TITLE = '未分组';

/**
 * 「更多」里的分组下拉，末尾那个「＋ 新建分组…」用的哨兵值。
 * 组名是使用者自己打的，理论上可能真叫这个名字 —— 所以铺选项时会把
 * 同名的分组过滤掉（代价是那个组选不到，实际不可能撞上，但别留暗坑）。
 */
const NEW_GROUP_VALUE = '__new_group__';

/**
 * 视图状态（当前选中的分组 / 手工新建但还空着的分组）挂在**草稿数组**上，
 * 而不是模块级变量。两个原因：
 *   · 换角色、重开编辑器时草稿是新建的数组，视图状态自然跟着重置，
 *     不用再写一遍清理逻辑；
 *   · 数组上的自定义属性不会被 JSON.stringify 带走，所以它绝不会混进角色卡。
 *
 * ⚠️ 千万别把这类状态挂到**字段对象**上：保存时字段是整体展开写盘的
 * （见 characterEditor.js 保存属性那一段），挂上去就真写进盘里了 ——
 * `_moreOpen` 得手动 delete 就是因为这个。
 */
function activeGroupOf(list) {
  return typeof list._activeGroup === 'string' ? list._activeGroup.trim() : '';
}

/**
 * 分组的**创建顺序**（视图状态，挂在草稿数组上，和 _activeGroup 一样）。
 *
 * 为什么不直接按字段在数组里的先后排：那样分组的位置会跟着**字段的增删**
 * 上下浮动 —— 建了一个空分组，它排在最后；一旦别的组先有了字段，
 * 这个空组就被挤到更后面；等它自己有了字段又跳回前面。
 * 表现出来就像是「按字段多少排队」，标签栏每次动一下都换个样子。
 *
 * 所以这里显式记一份顺序：新建分组时追加，改名时原位替换，解散时删掉。
 * 标签栏永远按这份表铺，字段怎么增删都不影响。
 *
 * ⚠️ 它挂在**数组**上而不是字段对象上：数组的自定义属性不会被
 * JSON.stringify 带走，所以绝不会混进角色卡（字段上就不行了，
 * 保存时字段是整体展开写盘的）。
 */
function groupOrderOf(list) {
  if (!Array.isArray(list._groupOrder)) {
    // 第一次渲染（刚打开一张卡）：用「字段里第一次出现的顺序」当初值 ——
    // 这是老数据里唯一能还原出来的顺序。空组跟在后面。
    const seed = [];
    const seen = new Set();
    const push = (raw) => {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      seed.push(id);
    };
    for (const attr of list) if (attr) push(attr.group);
    for (const raw of list._extraGroups || []) push(raw);
    list._groupOrder = seed;
  }
  return list._groupOrder;
}

/**
 * 把草稿按分组分桶，**按创建顺序**铺。
 *
 * 和 main/panel-fields.js 的 groupPanelFields 是同一套语义（那边没有视图状态，
 * 只能按字段先后），两边组次序基本一致，不至于出现
 * 「编辑器里一个顺序、面板上另一个顺序」的错觉。
 */
function bucketsOf(list) {
  const order = groupOrderOf(list);
  const map = new Map();

  for (const attr of list) {
    if (!attr) continue;
    const id = String(attr.group || '').trim();
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(attr);
    // 在「更多」里手打出来的新分组名：补到创建顺序的末尾
    if (id && !order.includes(id)) order.push(id);
  }

  // 「＋ 新建分组」建出来、但还没填字段的分组：数据上它还不存在
  // （没有任何字段引用它），只活在视图里。不兜这一手的话，
  // 刚点完新建就被下一次重画吃掉了。
  for (const raw of list._extraGroups || []) {
    const id = String(raw || '').trim();
    if (id && !map.has(id)) map.set(id, []);
  }

  // 顺序表里已经没有的分组（被解散了）直接跳过
  const named = order.filter((id) => id !== '' && map.has(id));
  // 「未分组」只在两种情况下出现：真的有零散字段，或者一个分组都还没有
  // （新建角色就是这种 —— 总得有个地方落笔）。它永远排最后。
  if (map.has('') || !named.length) named.push('');

  return named.map((id) => ({ id, title: id || UNGROUPED_TITLE, fields: map.get(id) || [] }));
}

/**
 * 重画属性区：分组标签栏 + 当前这一组的字段 + 加字段的输入行。
 *
 * 只铺**当前分组**的字段。切标签、加字段、删字段、改类型都会重画一次 ——
 * 都是一次性动作，重画不会打断正在打字的手。
 * （例外：「更多」里的输入框只更新草稿、不重画，否则光标会跳走。）
 */
export function renderCharAttrs(list) {
  if (!el.c.attrList) return;
  const draft = Array.isArray(list) ? list : [];

  const buckets = bucketsOf(draft);
  // 选中的分组可能已经不存在了（这一组被删空 / 刚换了角色），
  // 这时退回第一个桶；否则会看到一条空列表，还找不到自己站在哪一组。
  let active = activeGroupOf(draft);
  if (!buckets.some((bucket) => bucket.id === active)) active = buckets[0].id;
  draft._activeGroup = active;

  const current = buckets.find((bucket) => bucket.id === active) || buckets[0];

  renderAttrTabs(draft, buckets, active);
  renderAttrGroupEdit(draft, current);
  renderAttrRows(draft, current);
  renderAttrAddRow(current);
  renderAttrQuick(draft);
}

/** 切到某个分组。点的是当前组就什么都不做 —— 白重画一次会清掉输入框里没提交的字 */
function selectGroup(list, id) {
  if (activeGroupOf(list) === id) return;
  list._activeGroup = id;
  // 换组了，上一组留着的「改名 / 删除」操作条和「新建分组」输入框都收起来 ——
  // 不收的话它们会挂在新标签下面，看着像在操作新这一组。
  list._groupEditOpen = false;
  list._movingName = '';
  renderCharAttrs(list);
}

/**
 * 新建一个分组并切过去。
 * 建出来的是**空组** —— 没有任何字段引用它，所以只记在 _extraGroups 里；
 * 用户在里面加进第一个字段时，字段自然就带上了这个分组名。
 */
function createGroup(list, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  if (!name) return;

  // 组名就叫「未分组」的话等同于切回那个桶（它的 id 是空串）
  if (name === UNGROUPED_TITLE) {
    selectGroup(list, '');
    return;
  }

  // 创建顺序表里记一笔。已经有的名字不重复追加 ——
  // 否则改回旧名字会让这一组在标签栏里再冒一个位置出来。
  const order = groupOrderOf(list);
  if (!order.includes(name)) order.push(name);

  if (!bucketsOf(list).some((bucket) => bucket.id === name)) {
    list._extraGroups = [...(list._extraGroups || []), name];
  }
  selectGroup(list, name);
}

/**
 * 把分组改名：改的是**这一组下面所有字段**的 group。
 *
 * 三种情况都走这一条路：
 *   · 改成新名字   → 原地改名，标签栏里的位置不动（否改名会让标签跳到末尾）
 *   · 改成已有的名字 → 两组并成一组（提示一声，免得以为字段弄丢了）
 *   · 改成「未分组」 → 等于解散，字段的 group 清掉、退回兜底桶
 */
function renameGroup(list, from, to) {
  const name = String(to || '').trim().slice(0, 24);
  if (!name || name === from) return;

  const target = name === UNGROUPED_TITLE ? '' : name;
  const merging = !!target && bucketsOf(list).some((bucket) => bucket.id === target);

  let moved = 0;
  for (const attr of list) {
    if (String(attr.group || '').trim() !== from) continue;
    if (target) attr.group = target;
    else delete attr.group;
    moved += 1;
  }

  const order = groupOrderOf(list);
  const at = order.indexOf(from);
  if (at >= 0) {
    // 并组时被并掉的那个位置要消失，让目标组保留它自己的位置；
    // 改成新名字则原地替换。
    if (target && !merging) order[at] = target;
    else order.splice(at, 1);
  }

  // 空组（还没有任何字段引用它，数据上它还不存在）也得跟着换名字，
  // 否则改完名它就消失了 —— 明明什么都没改丢。
  const extras = (list._extraGroups || []).filter((g) => String(g || '').trim() !== from);
  if (target && !merging && !moved && !extras.includes(target)) extras.push(target);
  list._extraGroups = extras;

  list._activeGroup = target;
  list._groupEditOpen = false;
  renderCharAttrs(list);

  if (merging) showToast(`已并入「${target}」`, 'ok');
  else if (target) showToast(`分组已改名为「${target}」`, 'ok');
  else showToast(`「${from}」已解散，${moved} 个属性退回「未分组」`, 'ok');
}

/**
 * 解散 / 删除一个分组。
 *
 * 字段**不跟着删** —— 退回「未分组」这个兜底桶。理由：分组是给人看的
 * 组织方式，删组的人想清掉的多半是「这个分类」，而不是辛苦填的字段；
 * 真要字段消失，在那一行右边点 ✕，那是明确得多的动作。
 * 组里还有字段时先问一句，把「字段会退回未分组」说清楚。
 */
async function deleteGroup(list, id) {
  const group = String(id || '').trim();
  if (!group) return; // 「未分组」不能删 —— 字段总得有地方落

  const bucket = bucketsOf(list).find((b) => b.id === group);
  const count = bucket ? bucket.fields.length : 0;

  if (count) {
    const ok = await confirmDialog({
      title: '解散分组',
      message: `「${group}」下面的 ${count} 个属性会退回「未分组」，属性本身不会被删掉。`,
      confirmText: '解散这一组',
      danger: true
    });
    if (!ok) return;
  }

  for (const attr of list) {
    if (String(attr.group || '').trim() !== group) continue;
    delete attr.group;
  }
  list._extraGroups = (list._extraGroups || []).filter((g) => String(g || '').trim() !== group);
  const order = groupOrderOf(list);
  const at = order.indexOf(group);
  if (at >= 0) order.splice(at, 1);

  list._activeGroup = '';
  list._groupEditOpen = false;
  renderCharAttrs(list);

  showToast(count ? `已解散「${group}」，${count} 个属性退回「未分组」` : `已删除空分组「${group}」`);
}

/** 分组标签栏：每个标签是「组名 + 字段数」，数字是判断有没有填漏的依据 */
function renderAttrTabs(list, buckets, active) {
  if (!el.c.attrTabs) return;
  clear(el.c.attrTabs);

  for (const bucket of buckets) {
    const tab = button({
      class: ['attr-tab', bucket.id === active && 'active'],
      title: bucket.id ? `分组：${bucket.id}` : '还没有归到任何分组的属性',
      onClick: () => selectGroup(list, bucket.id)
    });

    // 组名和数字拆成两个节点，是为了把数字做成一个小徽标 ——
    // 拼成一整串文字的话，它和组名同字号同颜色，看着像一个名字的一部分。
    //
    // ⚠️ 中间那个空格（' '）不能省，也不能换成 CSS gap 就完事：
    //    标签是 display:inline-flex，纯空白的文本节点在 flex 布局里会被
    //    丢掉不参与排版，但它**仍然算在 textContent 里** —— 冒烟测试就按
    //    「关系 3」这个整串在比对。删了空格断言会集体红，而界面上完全看不出来。
    append(tab, [
      h('span', { class: 'attr-tab-name', text: bucket.title }),
      ' ',
      h('span', { class: 'attr-tab-count', text: String(bucket.fields.length) })
    ]);

    el.c.attrTabs.appendChild(tab);
  }

  // 「＋ 新建分组」：长得像一个标签，但它是个输入框，回车确认。
  // 不做成「点按钮弹输入框」，是因为那要多点一次，而组名本来就是随手打的。
  el.c.attrTabs.appendChild(
    h('input', {
      type: 'text',
      class: 'attr-tab-new',
      spellcheck: 'false',
      placeholder: '＋ 新建分组',
      'aria-label': '新建分组，回车确认',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        createGroup(list, event.currentTarget.value);
      }
    })
  );

  // 「⋯ 管理这一组」：改名 / 删除。
  //
  // 只在停在**命名分组**上时才出现 ——「未分组」是兜底桶，没有名字可改，
  // 也不能删（删了零散字段就没地方落了）。
  //
  // 做成一个独立入口而不是「双击标签改名」之类的手势：手势没人猜得到，
  // 而这两个操作以前**根本没有入口**（分组是在「更多」里靠改字段上的 group
  // 一次性建出来的，建完就没法整组改名或删除了）。
  // 靠 margin-left:auto 推到卡头最右边，和标签拉开距离，免得被看成一个特殊标签。
  if (active) {
    el.c.attrTabs.appendChild(
      button({
        class: ['attr-tab-edit', list._groupEditOpen === true && 'on'],
        text: '⋯',
        title: `重命名或删除「${active}」`,
        ariaLabel: '重命名或删除当前分组',
        onClick: () => {
          list._groupEditOpen = list._groupEditOpen !== true;
          renderCharAttrs(list);
        }
      })
    );
  }
}

/**
 * 分组操作条：改名 + 解散。铺在卡身最上面（字段列表之上）。
 *
 * 它管的是**标签栏里当前选中的那一组**，所以只在这一组有名字时才铺。
 */
function renderAttrGroupEdit(list, bucket) {
  if (!el.c.attrGroupEdit) return;
  clear(el.c.attrGroupEdit);

  const open = list._groupEditOpen === true && !!bucket.id;
  el.c.attrGroupEdit.classList.toggle('hidden', !open);
  if (!open) return;

  const nameInput = h('input', {
    type: 'text',
    class: 'attr-group-name',
    value: bucket.id,
    spellcheck: 'false',
    maxlength: '24',
    placeholder: '分组名',
    'aria-label': '分组名',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur(); // 失焦触发下面的 change，提交走同一条路
      } else if (event.key === 'Escape') {
        event.preventDefault();
        list._groupEditOpen = false;
        renderCharAttrs(list);
      }
    },
    // 用 change（回车 / 失焦）而不是 input：边打字边改名会每敲一个字
    // 就重画一次列表，光标被踢出去，整页都在跳。
    onchange: () => {
      const next = nameInput.value.trim().slice(0, 24);
      if (!next || next === bucket.id) {
        nameInput.value = bucket.id; // 空名字退回原名，不提交
        return;
      }
      renameGroup(list, bucket.id, next);
    }
  });

  append(el.c.attrGroupEdit, [
    h('span', { class: 'attr-group-edit-label', text: '分组名' }),
    nameInput,
    button({
      class: 'btn btn-danger btn-sm',
      text: '解散这一组',
      title: bucket.fields.length
        ? `把这 ${bucket.fields.length} 个属性退回「未分组」`
        : '删掉这个空分组',
      onClick: () => deleteGroup(list, bucket.id)
    })
  ]);
}

/**
 * 铺当前分组的字段行。
 *
 * 每行是「名字 + 初始值 + 类型 + 更多」。范围/变化规则/分组收在「更多」里，
 * 平时只露出名字和值 —— 大多数属性就是个文本，不该被一排输入框淹掉。
 */
function renderAttrRows(list, bucket) {
  clear(el.c.attrList);

  // 空组给句话。刚建的分组点进去本来是一片空白，既看不出坏了没有，
  // 也不知道下一步该干嘛 —— 尤其「新建分组」是新加的入口，最容易撞上。
  if (!bucket.fields.length) {
    el.c.attrList.appendChild(
      h('div', {
        class: 'attr-empty',
        text: bucket.id
          ? `「${bucket.title}」这一组还是空的 —— 在下面加一个属性`
          : '还没有属性 —— 在下面加一个，比如「金币」'
      })
    );
    return;
  }

  for (const attr of bucket.fields) {
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

    // 「更多」：默认展开条件是「已经有范围或变化规则」，但用户手动收起/展开过
    // 就以手动状态为准（_moreOpen 是 true/false/undefined 三态）——
    // 只看 hasMore 的话，一旦设过范围就再也收不起来了。
    //
    // 「有没有分组」**不再**算进默认展开条件：分组现在由上面的标签栏表达，
    // 而且在这一版里新增的字段都自带分组 —— 再让每行都自动展开，
    // 列表会被「变化规则 / 分组」两行输入框淹没，一屏看不到几个字段。
    // 分组照样能从「更多」里改，只是默认收着了。
    const hasMore = typeof attr.min === 'number' || typeof attr.max === 'number' || !!attr.hint;
    const moreOpen = attr._moreOpen === undefined ? hasMore : attr._moreOpen === true;

    const row = h(
      'div',
      { class: 'attr-row' },
      h('span', { class: 'attr-name', text: attr.name, title: attr.name }),
      valueInput,
      typeSelect,
      button({
        class: ['attr-more-btn', moreOpen && 'on'],
        text: moreOpen ? '收起' : '更多',
        title: '范围与变化规则',
        onClick: () => {
          attr._moreOpen = !moreOpen;
          renderCharAttrs(list);
        }
      }),
      button({
        class: 'panel-del',
        text: '✕',
        title: bucket.id ? `从「${bucket.title}」里删掉这个属性` : '删掉这个属性',
        onClick: () => {
          // 按字段本身定位，不用下标 —— 列表已经按分组过滤过，
          // 视图里的第 N 行不等于草稿数组里的第 N 项。
          const at = list.indexOf(attr);
          if (at >= 0) list.splice(at, 1);
          renderCharAttrs(list);
        }
      })
    );

    const wrap = h('div', { class: 'attr-item' }, row);
    if (moreOpen) wrap.appendChild(buildMoreBox(list, attr));

    el.c.attrList.appendChild(wrap);
  }
}

/** 「更多」展开区：数值范围 + 变化规则 + 分组 */
function buildMoreBox(list, attr) {
  const more = h('div', { class: 'attr-more' });

  // 范围只在「数值」类型下有意义，别的类型不显示 —— 露出来只会让人以为
  // 填了就有用（实际 clampFieldValue 只对 meter 动作）
  if ((attr.type || 'text') === 'meter') {
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

    more.appendChild(
      h(
        'div',
        { class: 'attr-range' },
        h('span', { class: 'attr-range-label', text: '数值范围' }),
        numInput('min', '下限', '最小值'),
        h('span', { class: 'attr-range-sep', text: '~' }),
        numInput('max', '上限', '最大值')
      )
    );
  }

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
  more.appendChild(hintInput);

  more.appendChild(buildGroupRow(list, attr));

  return more;
}

/**
 * 「更多」里的分组行：把这个属性搬到别的分组。
 *
 * 做成**下拉**而不是输入框：这里能做的事本质上就是「从这几组里挑一个」，
 * 输入框得先知道组名、还容易打错，而且当初那句提示
 * （「填了分组之后，这个字段会归到标签栏里同名的那一组」）其实是在解释
 * 一个看不见的机制 —— 现在选项直接列出来，就不用解释了。
 *
 * 但**只给下拉会卡住第一个分组**：卡里一个命名分组都还没有的时候，
 * 选项里只有「未分组」，根本无从选起（真实场景：一张老卡里有五个零散属性，
 * 想分组，第一步就死在这儿）。所以末尾挂一个「＋ 新建分组…」，
 * 选中它这一行就临时变成输入框，打完回车 —— 建组 + 搬过去一步完成。
 */
function buildGroupRow(list, attr) {
  const row = h('div', { class: 'attr-group-row' }, h('span', { class: 'attr-range-label', text: '分组' }));

  // 「＋ 新建分组…」的输入框模式。等这一行铺完再聚焦 —— 节点这会儿还没进文档。
  if (list._movingName === attr.name) {
    const nameInput = h('input', {
      type: 'text',
      class: 'attr-group-new',
      spellcheck: 'false',
      maxlength: '24',
      placeholder: '新分组名，回车确认',
      'aria-label': '新建分组，并把这个属性搬过去',
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          createGroupAndMove(list, attr, nameInput.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          list._movingName = '';
          renderCharAttrs(list);
        }
      }
    });
    row.appendChild(nameInput);
    queueMicrotask(() => nameInput.focus());
    return row;
  }

  const current = String(attr.group || '').trim();
  // ⚠️ 「未分组」必须**永远**在选项里：bucketsOf 只在「真的有零散字段、
  //    或者一个命名分组都没有」时才铺出这一桶，光靠它会漏 ——
  //    一旦所有属性都归了组，就再也没法把某个属性拿出来了。
  const named = bucketsOf(list)
    .filter((bucket) => bucket.id && bucket.id !== NEW_GROUP_VALUE)
    .map((bucket) => bucket.id);

  const groupSelect = h(
    'select',
    {
      class: 'attr-group',
      'aria-label': `${attr.name} 的分组`,
      title: `${attr.name} 现在在「${current || UNGROUPED_TITLE}」，在这里把它搬到别的组`,
      onchange: () => {
        const next = groupSelect.value;
        if (next === NEW_GROUP_VALUE) {
          waitForNewGroupName(list, attr);
          return;
        }
        if (next) attr.group = next;
        else delete attr.group;
        list._movingName = '';
        renderCharAttrs(list);
      }
    },
    [
      ...named.map((id) => h('option', { value: id, text: id })),
      h('option', { value: '', text: UNGROUPED_TITLE }),
      h('option', { value: NEW_GROUP_VALUE, text: '＋ 新建分组…' })
    ]
  );
  groupSelect.value = current;

  row.appendChild(groupSelect);
  return row;
}

/** 选中「＋ 新建分组…」：把这一行换成输入框，等用户打名字 */
function waitForNewGroupName(list, attr) {
  list._movingName = attr.name;
  renderCharAttrs(list);
}

/**
 * 建一个新分组，并把这个属性搬进去。
 * **不切到新组** —— 搬完还停在原来那一页，方便接着搬下一个
 * （「把未分组里五个零散属性归类」是一串连续动作，每搬一个就跳走很烦）。
 * 新标签会出现在标签栏里，加上一条提示，去向是看得见的。
 */
function createGroupAndMove(list, attr, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  list._movingName = '';
  if (!name || name === UNGROUPED_TITLE) {
    renderCharAttrs(list);
    return;
  }

  const order = groupOrderOf(list);
  if (!order.includes(name)) order.push(name);
  attr.group = name;

  // 组名撞上了？那就是并进去，说清楚点，别让人以为建了个新组
  const merging = bucketsOf(list).some((bucket) => bucket.id === name && bucket.fields.some((f) => f !== attr));
  renderCharAttrs(list);
  showToast(merging ? `已搬进「${name}」` : `已新建「${name}」并搬了进去`, 'ok');
}

/**
 * 加字段那一行的占位文案要跟着当前分组走 ——
 * 否则用户不知道「添加」到底加进了哪一组
 * （以前得先加了、再点开「更多」补分组，多两步还容易漏）。
 */
function renderAttrAddRow(bucket) {
  if (!el.c.attrNew) return;
  el.c.attrNew.placeholder = bucket.id ? `往「${bucket.title}」里加一个属性` : '属性名，比如 金币';
}

/** 快捷候选词：来自「设置 → 状态属性」，点一下就加进**当前分组** */
function renderAttrQuick(list) {
  if (!el.c.attrQuick) return;

  // 已经在属性里的就不再显示，免得点了个寂寞
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

/**
 * 把解析出来的属性并进草稿：新的追加，同名的覆盖值。
 *
 * 新增的字段归到**当前分组** —— 在「背包」那一页粘贴一串东西，
 * 意图显然就是往背包里放，让它们掉进「未分组」反而要再搬一次。
 */
function applyParsedAttributes(list, pairs) {
  let added = 0;
  let updated = 0;
  const group = activeGroupOf(list);

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

    const attr = { name: item.name, value: item.value };
    if (group) attr.group = group;
    list.push(attr);
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

/** 加一个属性：保留字拦下，重名跳过，新字段归到当前分组 */
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

  const attr = { name, value: '' };
  // 未分组就不写 group —— 数据形状和以前完全一样（老存盘里没有 group 这个键）
  const group = activeGroupOf(list);
  if (group) attr.group = group;

  list.push(attr);
  renderCharAttrs(list);
}

// 草稿数组的所有者是角色编辑器（保存时要跟表单一起写回角色卡），
// 所以这里不存它，只在需要的时候问一声。
let getDraft = () => [];

/** 绑属性区的按钮（标签栏和快捷候选词是渲染时就带的，不用绑） */
export function initCharAttrsUi({ getList } = {}) {
  if (typeof getList === 'function') getDraft = getList;

  // 加点属性：按钮和回车都能加。加进当前选中的那一组。
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
