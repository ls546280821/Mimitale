'use strict';

// ============================================================================
//  ui/build.js —— 建 DOM 的小工具
//
//  这个项目没有框架，也不打算引：界面就这些（9 个弹窗 + 3 个页面），
//  引一套组件库要付出构建步骤的代价，而「零构建」是这个项目写在 README 里的卖点。
//  真正缺的只是把 createElement 的样板收掉 —— 渲染层原来有 94 处 createElement，
//  光是「建一个按钮」那个五连击就重复了 20 遍。
//
//  两条约定（别破坏）：
//    · 文本一律走 textContent，**这里不提供 innerHTML 入口** ——
//      渲染层里很多内容来自模型，绝不能让它们有机会变成 HTML
//    · children 里的 null / false / undefined 直接跳过，方便写「有才渲染」
// ============================================================================

const CLASS_JOIN = ' ';
// 这几个得设 property 而不是 attribute：attribute 只算「初始值」，
// 之后用户改了 DOM，两者就对不上了
const PROPS = new Set(['value', 'checked']);

/** 把子节点接上去：数组摊平，假值跳过，字符串变文本节点 */
export function append(node, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else if (typeof child === 'object') node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

/** 清空一个节点 */
export function clear(node) {
  node.innerHTML = '';
  return node;
}

/**
 * 建一个元素。
 *
 *   h('div', { class: ['row', isActive && 'on'], title: '提示' },
 *     h('span', { text: '名字' }),
 *     '纯文本')
 *
 * 特殊字段：class（可给数组，假的会滤掉）、text、dataset、on*（事件）
 * 其余一律走 setAttribute；值为 false / null 的字段直接跳过。
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  const map = props || {};

  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value == null || value === false) continue;

    if (key === 'class') {
      const list = Array.isArray(value) ? value.filter(Boolean) : [value];
      node.className = list.join(CLASS_JOIN);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPS.has(key)) {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, children);
  return node;
}

/**
 * 按钮。渲染层里最常见的一段样板：
 * 以前是「createElement + type + className + textContent + addEventListener」五连击。
 */
export function button({ class: className, text, title, ariaLabel, disabled, onClick, ...rest }) {
  return h(
    'button',
    {
      type: 'button',
      class: className,
      text,
      title,
      'aria-label': ariaLabel,
      disabled,
      onclick: onClick,
      ...rest
    }
  );
}

/**
 * 列表页骨架。角色库页和世界书页原来各抄了一份，结构一模一样：
 * 清空网格 → 切空状态 → 更新副标题 → 铺卡片。
 */
export function renderListPage({ grid, empty, sub, subText, items, card }) {
  clear(grid);
  if (empty) empty.classList.toggle('hidden', !!items.length);
  if (sub) sub.textContent = subText || '';
  for (const item of items) grid.appendChild(card(item));
}

/**
 * 列表页的卡片外壳：头像 + 名字 + 一行小字 + 操作区。
 * 角色卡和世界书卡长得一样，只是内容不同；`extra` 用来塞角色卡右上角那个删除按钮。
 */
export function card({ title, sub, subTitle, avatar, avatarText, avatarClass, actions, extra }) {
  return h(
    'div',
    { class: 'char-card', role: 'listitem', title },
    extra,
    h(
      'div',
      { class: ['char-card-avatar', avatarClass] },
      avatar ? h('img', { src: avatar, alt: '' }) : avatarText
    ),
    h('div', { class: 'char-card-name', text: title }),
    h('div', { class: 'char-card-sub', text: sub, title: subTitle || sub }),
    h('div', { class: 'char-card-actions' }, actions)
  );
}
