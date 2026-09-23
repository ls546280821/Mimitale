'use strict';

// ============================================================================
//  core/panel-fields.js —— main/panel-fields.js 的桥
//
//  那个文件是 CommonJS 的（主进程要 require 它），当 ES module 加载会报
//  「does not provide an export named …」，所以 index.html 里用普通 <script>
//  先加载它，它自己挂到 window.PanelFields。
//
//  这里做一次「取 + 检查」并重新导出，别的模块从这里 import 就行 ——
//  否则每个要用它的模块都得再抄一遍那段 window 检查。
//
//  归一化**不能**在渲染层另写一套 —— 那样「范围」会被静默丢掉
//  （角色属性已经吃过一次白名单丢字段的亏）。
// ============================================================================

const panelFieldsApi = typeof window !== 'undefined' ? window.PanelFields : null;

if (!panelFieldsApi) {
  // 说明 index.html 里那个 <script src="../main/panel-fields.js"> 没加载成功。
  // 早点炸出来，好过后面一大片「范围莫名其妙不生效」。
  throw new Error('main/panel-fields.js 没加载 —— 检查 renderer/index.html 里的 script 标签');
}

export const clampFieldValue = panelFieldsApi.clampFieldValue;
export const normalizePanelField = panelFieldsApi.normalizePanelField;
export const normalizePanelFields = panelFieldsApi.normalizePanelFields;
export const groupPanelFields = panelFieldsApi.groupPanelFields;
export const fieldProgress = panelFieldsApi.fieldProgress;
export const describePanelField = panelFieldsApi.describePanelField;
export const parseNumericValue = panelFieldsApi.parseNumericValue;
export const trimNumber = panelFieldsApi.trimNumber;
