'use strict';

// ============================================================================
//  main/worldbook-store.js —— 世界书落盘时的那一层归一化
//
//  归一化本身在 main/worldbook-parse.js。这里只负责「落盘时怎么调它」，
//  把主进程特有的两样东西注进去：
//    · makeId              —— 怎么发世界书 id
//    · normalizeCharacter  —— 书里「角色副本」的归一化器（characters.js 那个）
//
//  为什么要单独一层：以前这段直接写在 main.js 里，而 main.js 是 Electron 入口
//  （顶部就 require('electron')），冒烟测试的假后端没法 require 它 ——
//  于是「世界书存盘再读回来字段会不会丢」在自动化里完全没有覆盖，
//  假后端只是把数组 clone 一下就存了。抽出来之后两边跑的是同一份白名单。
//
//  ⚠️ normalizeWorldbook 是白名单式的：加字段时记得同步 worldbook-parse.js，
//  否则就是静默丢失（recursive / opening / characters 都踩过这个坑）。
// ============================================================================

const { normalizeWorldbook } = require('./worldbook-parse.js');

/**
 * 造一个归一化器。
 * @param {object} deps
 * @param {function} deps.makeId             生成世界书 id
 * @param {function} deps.normalizeCharacter 归一化书里的角色副本
 */
function createWorldbookNormalizer(deps) {
  const d = deps || {};
  const makeId = typeof d.makeId === 'function' ? d.makeId : undefined;
  const normalizeCharacter = typeof d.normalizeCharacter === 'function' ? d.normalizeCharacter : undefined;

  return function normalizeStoredWorldbook(raw, fallbackName) {
    return normalizeWorldbook(raw, fallbackName, makeId, normalizeCharacter);
  };
}

module.exports = { createWorldbookNormalizer };
