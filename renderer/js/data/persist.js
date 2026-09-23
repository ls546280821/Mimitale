'use strict';

// ============================================================================
//  data/persist.js —— 把内存里的数据写回磁盘
//  会话是防抖保存；角色库 / 世界书是两个文件，但主进程允许一次写入带上两者，
//  所以走 persistLibrary() 一起落盘。
//
//  三个入口都在写角色库（角色编辑器、世界书编辑器里的副本、两条导入链路），
//  所以 persistCharacters / persistLibrary 沉在这儿，谁都不用认识谁。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbooks } from './library.js';

let saveTimer = null;

export function persistConversations(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api
      .saveConversations({ conversations: state.conversations, activeId: state.activeId })
      .then(() => {
        // 保存成功，静默
      })
      .catch((err) => {
        console.error('保存会话失败', err);
        showToast('保存会话失败，请检查磁盘空间', 'error');
      });
  }, typeof delay === 'number' ? delay : 350);
}

/**
 * 世界书是否成功从磁盘读进来了。
 *
 * 读失败时**必须记住** —— 否则之后随便存一次角色，就会把 worldbooks.json
 * 覆盖成空文件。这个标志和 persistLibrary 一起放在这儿，是因为
 * 「读没读到」和「能不能写」是同一个约束的两面，分开就有人会忘了检查。
 */
let worldbooksLoaded = false;

/** 启动时读到世界书后调用（读失败就别调，见上） */
export function markWorldbooksLoaded() {
  worldbooksLoaded = true;
}

/**
 * 把当前角色库写回磁盘。
 *
 * 角色和世界书分开存两个文件，主进程允许一次请求同时带上 worldbooks；
 * 但只在世界书确实读进来了时才带 —— 否则「存一次角色」会把 worldbooks.json 写空。
 *
 * immediate = true 时立刻写、不等下一帧（关闭窗口前那种必须落地的场景）。
 */
export function persistCharacters(immediate) {
  const payload = { characters: characters() };
  if (worldbooksLoaded) payload.worldbooks = worldbooks();

  if (immediate) {
    api.saveCharactersNow(payload);
    return Promise.resolve(payload);
  }

  return api.saveCharacters(payload).catch((err) => {
    console.error('保存角色失败', err);
    showToast('角色没能保存到磁盘，请检查磁盘空间', 'error');
  });
}

/**
 * 把当前角色库 + 世界书写回磁盘。
 * 角色卡和世界书是两个文件，主进程允许一次写入同时带上两者。
 * 返回是否成功 —— 绑定这类操作失败时界面要回滚，不能假装成功。
 *
 * 三头都在用（世界书编辑器、角色编辑器、导入），所以沉在数据层。
 */
export async function persistLibrary() {
  // 世界书没读进来就什么都别写：写下去等于把文件清空
  if (!worldbooksLoaded) {
    showToast('世界书上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return false;
  }

  try {
    await api.saveCharacters({ characters: characters(), worldbooks: worldbooks() });
    return true;
  } catch (err) {
    console.error('保存世界书失败', err);
    showToast('世界书没能保存到磁盘', 'error');
    return false;
  }
}
