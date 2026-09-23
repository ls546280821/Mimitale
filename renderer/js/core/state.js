'use strict';

// ============================================================================
//  core/state.js —— 全局状态
//  这是唯一一处「整份数据」的存放点：设置、会话、角色库、世界书。
//  各模块都直接读写它的字段（对象是共享引用，所以能改），
//  但**不要**重新赋值这个绑定本身。
//
//  注：编辑器那些零散的状态（editingCharacterId / charDraft / currentView …）
//  现在还在 main.js 里，等 views 拆出去的时候再一起归置。
// ============================================================================

export const state = {
  settings: null,
  presets: [],
  conversations: [],
  characters: [],
  worldbooks: [],
  activeId: null,
  streaming: false,
  requestId: null,
  usage: null
};
