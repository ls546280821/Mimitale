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
import { characters, worldbooks, dialoguePresets } from './library.js';

let saveTimer = null;

/**
 * 写盘失败后**隔一会儿自动再试一次**。
 *
 * 主进程那边已经有一套退避重试（30·70·150·250ms，合计约 0.5 秒），但实测不够：
 * Windows 上安全软件扫一个刚写过的文件，占上几百毫秒到一两秒都算正常。
 * 撞上这种情况原来就是一次失败到底 —— 用户看到「没能写进磁盘」，得自己发现、
 * 自己再点一次，而且多半不知道刚才那下其实没生效。
 *
 * 这里补的是**更晚的那一次**：绝大多数时候用户完全无感，只有两次都失败才会看到
 * 提示、界面才会回滚。调用方拿到的语义不变：
 *   resolve = 真的写进去了；reject = 两次都没成，可以按失败处理了。
 *
 * ⚠️ 传进来的是个**取数据的函数**而不是现成的 payload —— 重试那一下要带上
 *    「重试这一刻」的最新状态，而不是 1.2 秒前那份快照。
 */
const WRITE_RETRY_DELAY_MS = 1200;

async function writeWithOneLateRetry(writeOnce) {
  try {
    return await writeOnce();
  } catch (firstErr) {
    console.warn(`[persist] 写盘失败，${WRITE_RETRY_DELAY_MS} 毫秒后自动再试一次`, firstErr);
    await new Promise((r) => setTimeout(r, WRITE_RETRY_DELAY_MS));
    return writeOnce();
  }
}

/**
 * 同一个文件（key）的写入**串起来**，永远不并发。
 *
 * ⚠️ 为什么非串不可：persistConversations 的防抖只管「什么时候**开始**写」。
 *    前一次还飞在路上时又触发一次，两次写就并发 —— 主进程那边排队，
 *    可**先发出的那次反而可能后落盘**（它在主进程内部还有退避重试，最多再等 0.5 秒）。
 *    结果：磁盘上是旧快照，刚改的那一下没了。
 *    实测最容易踩的两处：改状态栏（persistConversations(0)）紧接着回复结束保存；
 *    以及关窗口那次保存（beforeunload）被还在飞的上一次盖掉。
 *
 * ⚠️ 队尾必须自己把异常吃掉（.then 的两个处理函数都要写）：一次失败会把链
 *    永久钉在 rejected，之后每次保存都直接跳过 —— 和 main/store.js 的
 *    writeQueue 是同一个坑，那边有长注释。
 */
const writeChains = new Map(); // key → 队尾 Promise

function queueWrite(key, call) {
  const previous = writeChains.get(key) || Promise.resolve();
  const result = previous.then(() => writeWithOneLateRetry(call));
  writeChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/**
 * 写盘失败时统一的说法。
 *
 * ⚠️ 2026-10-08 更正：原来这里一口咬定「文件可能被杀软临时占用或带了只读属性」，
 *    实测**两条都不是**。真实的一次（同一台机器）是这样：
 *      EPERM: operation not permitted, open '...\characters.json.tmp'
 *    每次点删除都失败、重试 0.5 秒 + 1.2 秒之后照样失败 —— 那是**权限判定**
 *    （进程被沙箱/ACL 挡住，不让它在那个目录里建文件），根本不是「等一会儿就放开」
 *    的瞬时占用。猜错原因会把人支去关杀软、改只读属性，全是白费功夫。
 *
 *    所以现在把**真正的错误原文**带出来，只对确凿的错误码给提示。
 *    只有真撞上 ENOSPC 才说磁盘满（角色卡头像是内嵌 base64，几十张卡确实吃得掉空间）。
 */
function writeFailedText(what, err) {
  const msg = String((err && err.message) || '');
  if (msg.includes('ENOSPC')) return `${what}没能写进磁盘：磁盘空间不够了`;

  // 主进程包了一层「写入失败（xxx.json）：」，这层对用户没意义，剥掉
  const detail = msg.replace(/^写入失败（[^）]*）：/, '').trim();
  const denied = /\bEPERM\b|\bEACCES\b/.test(msg);
  const hint = denied
    ? '（权限被拒 —— 常见是这个程序被安全软件/沙箱限制在它自己的目录里，或者数据目录本身不可写；' +
      '不是「等一会儿再试」能好的）'
    : '';

  return `${what}没能写进磁盘，这次改动没有生效${hint}${detail ? `：${detail}` : ''}`;
}

export function persistConversations(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    queueWrite('conversations', () =>
      api.saveConversations({ conversations: state.conversations, activeId: state.activeId })
    ).catch((err) => {
      console.error('保存会话失败（已自动重试过）', err);
      showToast(writeFailedText('会话', err), 'error');
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
 * 预设是否成功从磁盘读进来了。
 *
 * 和 worldbooksLoaded 同一个道理：读失败时**必须记住**，
 * 否则之后随便存一次角色/世界书，就会把 presets.json 覆盖成空文件。
 */
let presetsLoaded = false;

/** 启动时读到预设后调用（读失败就别调，见上） */
export function markPresetsLoaded() {
  presetsLoaded = true;
}

/**
 * 把当前预设写回磁盘（单独一个文件，不受角色 / 世界书影响）。
 * immediate = true 时立刻写，不等下一帧。
 */
export function persistPresets(immediate) {
  // 没读进来就什么都别写：写下去等于把文件清空
  if (!presetsLoaded) {
    showToast('预设上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return Promise.resolve(false);
  }

  const buildPayload = () => ({ presets: dialoguePresets() });

  if (immediate) {
    api.savePresetsNow(buildPayload());
    return Promise.resolve(true);
  }

  return queueWrite('presets', () => api.savePresets(buildPayload()))
    .then(() => true)
    .catch((err) => {
      console.error('保存预设失败（已自动重试过）', err);
      showToast(writeFailedText('预设', err), 'error');
      return false;
    });
}

/**
 * 把当前角色库写回磁盘。**返回是否真的写成功了**（调用方靠它决定要不要报「已保存」）。
 *
 * 角色和世界书分开存两个文件，主进程允许一次请求同时带上 worldbooks；
 * 但只在世界书确实读进来了时才带 —— 否则「存一次角色」会把 worldbooks.json 写空。
 *
 * immediate = true 时立刻写、不等下一帧（关闭窗口前那种必须落地的场景）。
 * 那条路走的是 ipcRenderer.send，没有回执，只能尽力而为 ——
 * 反正关窗口时也来不及让用户看提示了。
 */
export function persistCharacters(immediate) {
  const buildPayload = () => {
    const payload = { characters: characters() };
    if (worldbooksLoaded) payload.worldbooks = worldbooks();
    return payload;
  };

  if (immediate) {
    api.saveCharactersNow(buildPayload());
    return Promise.resolve(true);
  }

  return queueWrite('characters', () => api.saveCharacters(buildPayload()))
    .then(() => true)
    .catch((err) => {
      console.error('保存角色失败（已自动重试过）', err);
      showToast(writeFailedText('角色', err), 'error');
      return false;
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
    // 和 persistCharacters 共用一个 key：两者写的都是 characters.json，必须互相排队
    await queueWrite('characters', () =>
      api.saveCharacters({ characters: characters(), worldbooks: worldbooks() })
    );
    return true;
  } catch (err) {
    console.error('保存世界书失败（已自动重试过）', err);
    showToast(writeFailedText('世界书', err), 'error');
    return false;
  }
}
