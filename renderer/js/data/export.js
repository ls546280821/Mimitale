'use strict';

// ============================================================================
//  data/export.js —— 统一的导出收尾
//
//  只管「调保存框、报结果」这一步，具体导出什么内容由调用方组装。
//  放在 data 层而不是 core：它要用 showToast（ui 层），而 core 不能再往上依赖 ui。
//
//  入口层的角色卡 / 对话导出、世界书编辑器里的「导出本书」都走这里 ——
//  两头都要用，所以不能跟着任何一头走。
// ============================================================================

import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';

/** 统一的导出收尾：调保存框、报结果 */
export async function saveExport(payload) {
  let result;
  try {
    result = await api.saveFile(payload);
  } catch (err) {
    showToast((err && err.message) || '导出失败', 'error');
    return;
  }

  if (!result || result.canceled) return;
  if (result.error) {
    showToast(`没能写出文件：${result.error}`, 'error');
    return;
  }
  showToast('已导出到磁盘', 'ok');
}
