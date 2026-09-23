'use strict';

// ============================================================================
//  data/providers.js —— 多模型：服务商（provider）+ 模型（model）
//
//  一个服务商 = 一套「接口地址 + API Key + 模型列表」。
//  每个会话会记住自己用的是哪个服务商的哪个模型。
//
//  纯逻辑，不碰 DOM。注意 ensureConvoEndpoint() 会**就地补全会话对象**
//  （这是有意的：老会话没有这两个字段，读到就得补上，不然下拉框里是空的）。
// ============================================================================

import { state } from '../core/state.js';
import { activeConvo } from '../core/util.js';

export function providers() {
  const s = state.settings || {};
  return Array.isArray(s.providers) ? s.providers : [];
}

export function providerById(id) {
  return providers().find((p) => p.id === id) || null;
}

/** 把会话绑定的服务商/模型补全（老会话没有这两个字段） */
export function ensureConvoEndpoint(convo) {
  if (!convo) return null;
  const list = providers();
  if (!list.length) return null;

  const s = state.settings || {};
  let provider = providerById(convo.providerId);

  if (!provider) {
    provider = providerById(s.activeProviderId) || list[0];
    convo.providerId = provider.id;
    convo.model = s.activeModel || provider.models[0] || '';
  }
  if (!convo.model) {
    convo.model = provider.models[0] || s.activeModel || '';
  }
  // 模型可能被用户从列表里删掉了，临时补回去，免得下拉框里找不到当前值
  if (convo.model && !provider.models.includes(convo.model)) {
    provider.models = [convo.model, ...provider.models];
  }

  return { provider, model: convo.model };
}

/** 当前会话实际会用的服务商 + 模型 */
export function currentEndpoint() {
  const convo = activeConvo();
  if (convo) return ensureConvoEndpoint(convo);

  const s = state.settings || {};
  const provider = providerById(s.activeProviderId) || providers()[0] || null;
  return provider ? { provider, model: s.activeModel || provider.models[0] || '' } : null;
}
