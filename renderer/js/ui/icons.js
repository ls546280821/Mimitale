'use strict';

// ============================================================================
//  ui/icons.js —— 字段图标的集中登记处
//
//  把「一个图标名 → 一段 SVG path」收在一张表里，任何地方要用字段图标，
//  只要在标签元素上写 `data-icon="名字"`，启动时 applyFieldIcons 就会把
//  对应图标插到标签最前面 —— 不用再手写一坨 SVG。
//
//  图标是 24×24 线性图标（stroke 当前色），尺寸/颜色由 CSS 管
//  （.field-label > .field-icon），这里只管形状。颜色用 var(--accent)，
//  换主题 / 换配色自动跟着走，不用动这张表。
//
//  加新图标：在 ICONS 里添一行即可；其余页面复用同一个名字。
// ============================================================================

const ICONS = {
  // 角色描述 —— 一个人
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  // 性格 —— 一张笑脸
  smile:
    '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  // 场景 —— 地图定位针
  'map-pin':
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  // 开场白 —— 单气泡
  'message-circle':
    '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  // 示例对话 —— 双气泡
  'messages-square':
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  // 年龄 —— 沙漏（时间流逝）
  hourglass:
    '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  // 性别 —— 圆 + 下方十字（♀），左右对称、重心居中
  venus:
    '<path d="M12 15v7"/><path d="M9 19h6"/><circle cx="12" cy="8" r="5"/>',
  // 种族 —— 一群人（族群）
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  // 属性（状态面板）—— 一排可调的滑块
  sliders:
    '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  // 自带世界书 —— 一本书
  book:
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>'
};

/**
 * 把一个图标名变成完整的 SVG 字符串。
 * @param {string} name ICONS 里的键
 * @returns {string} 找不到时返回空串（调用方自行决定要不要插）
 */
export function iconSvg(name) {
  const body = ICONS[name];
  if (!body) return '';
  return (
    '<svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body +
    '</svg>'
  );
}

/**
 * 扫描 root 里所有带 `data-icon` 的元素，把图标插到它的最前面。
 * 幂等：同一个元素只处理一次（靠 dataset.iconDone 标记），重复调用不会插两遍。
 *
 * 静态 HTML 由入口层在启动时对整个 document 调一次；动态渲染出来的标签
 * （以后别的视图要复用的话）在渲染完成后自己再对那一段调一次即可。
 *
 * @param {ParentNode} [root] 扫描范围，默认整个 document
 */
export function applyFieldIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone === '1') continue;
    el.dataset.iconDone = '1';
    const svg = iconSvg(el.getAttribute('data-icon'));
    if (svg) el.insertAdjacentHTML('afterbegin', svg);
  }
}
