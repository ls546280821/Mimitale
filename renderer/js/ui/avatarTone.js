'use strict';

// ============================================================================
//  ui/avatarTone.js —— 头像底色（设计稿的 .g1~.g6 / .gme 那一套渐变）
//
//  同一个人**永远同一个颜色**：拿名字（或 owner id）哈希出一个下标，
//  不用 Map 记、也不会因为换会话/刷新而变色。
//
//  为什么按名字哈希而不是按顺序取：会话列表和在场角色栏的遍历顺序会变
//  （列表按更新时间排、卡按出场顺序排），按顺序取色会导致「同一个人今天粉明天绿」。
//
//  色板本身在 style.css（.g1~.g6 / .gme），不在这里 —— 换配色时要一起看。
// ============================================================================

const TONES = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];

/**
 * 取一支底色类名。seed 传名字或 owner id 都行（`'player'` 要传 magic，见下）。
 *
 * @param {string} seed 用来定色的字符串（角色名 / owner / 会话 id）
 * @returns {string} 'g1' ~ 'g6'
 */
export function avatarTone(seed) {
  const s = String(seed == null ? '' : seed);
  if (!s) return TONES[0];
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    // 31 是习惯用的质数基数；>>> 0 保证是 32 位无符号，负号不会跑进取模
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return TONES[hash % TONES.length];
}

/**
 * 拿「这个人/这条会话」该用的底色类名。
 *
 * 玩家（owner === 'player'，或没绑角色的会话）统一走 `gme` 那支蓝 ——
 * 这是设计稿里刻意把「我」和角色的色系分开的地方，别合并进哈希。
 *
 * @param {string} owner owner id / 角色 id / 会话 id
 * @param {string} [name] 显示名（哈希用；不给就用 owner）
 */
export function entityTone(owner, name) {
  if (!owner || owner === 'player') return 'gme';
  return avatarTone(name || owner);
}
