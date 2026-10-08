'use strict';

// ============================================================================
//  data/petContext.js —— 「该不该说话、说什么给谁听」这一层
//
//  判断放在主界面而不是主进程，理由见 main/pet-ipc.js 顶部那段：
//  会话、最近几条、摘要、状态面板都在渲染层的内存里，主进程只有一个磁盘上的
//  conversations.json，让它还原「现在聊到哪了」等于把一份逻辑抄两遍。
//
//  这个模块干三件事：
//    1. 缓存一份桌宠配置（设置页和右键菜单改完会推 pet:changed 过来刷新）
//    2. 按「每隔 N 轮」计数，决定这一轮要不要说
//    3. 把上下文打包成一小份交给主进程（**不是完整历史**，见下面 buildPetContext）
//
//  ⚠️ 宠物说的话**永远不写进 convo.messages**。
//     写进去角色下一轮就会「听见」宠物说话，扮演当场崩 —— 这是硬红线，
//     记忆走的是主进程那边的 data/pet/memory（见 main/pet-store.js）。
// ============================================================================

import { api } from '../core/api.js';
import { activeConvo, asArray } from '../core/util.js';
import { assistantName, convoUserName } from './cast.js';
import {
  cleanAssistantText,
  convoPanel,
  convoPanelFields,
  panelGroupNames,
  panelKeyParts
} from './panel.js';
import { convoContextMessages, formatSummaryForPrompt } from './memory.js';

/** 给宠物看「刚刚发生了什么」时带几条。它不是要复盘，只是要听懂在演哪一出。 */
const RECENT_COUNT = 6;
/** 单条消息截断，免得一条长回复把上下文撑满 */
const MAX_MESSAGE_CHARS = 500;
/** 状态面板最多带几个字段 */
const MAX_PANEL_FIELDS = 8;

// ---------------------------------------------------------------------------
//  配置缓存
// ---------------------------------------------------------------------------

let petCache = null;

/** 从主进程拉一份最新的桌宠状态（设置页打开、配置变化时都会调） */
export async function refreshPetCache() {
  try {
    petCache = await api.petGet();
  } catch (err) {
    console.error('读取桌宠状态失败', err);
    petCache = null;
  }
  return petCache;
}

export function petState() {
  return petCache;
}

export function petEnabled() {
  const config = petCache && petCache.config;
  return !!(config && config.enabled);
}

// ---------------------------------------------------------------------------
//  上下文
// ---------------------------------------------------------------------------

/** 状态面板快照：宠物靠它就能看出「刚才好感涨了」这类事，不用去啃正文 */
function panelSnapshot(convo) {
  const panel = convoPanel(convo);
  const keys = Object.keys(panel || {});
  if (!keys.length) return '';

  const out = [];
  for (const key of keys.slice(0, MAX_PANEL_FIELDS)) {
    const value = panel[key];
    if (value == null || value === '') continue;
    const parts = panelKeyParts(key);
    const name = parts && parts.name ? parts.name : key;
    out.push(`${name}：${String(value).slice(0, 40)}`);
  }
  return out.join(' / ');
}

/**
 * 打包给宠物看的上下文。
 *
 * **这里刻意不发完整历史** —— 那是 O(n²) 的烧钱法，而且没必要：
 * 宠物只要知道「刚才发生什么」就能插一句嘴。所以给的是
 * 「最近 6 条 + 主对话摘要 + 状态面板」，三样都是现成的，几乎零新增成本：
 *   · convoContextMessages 已经按 maxTurns 裁好了
 *   · formatSummaryForPrompt 是早就算好的剧情摘要
 *   · 面板本来就是结构化数据，比读正文准得多
 *
 * 返回的形状要和 main/pet-brain.js 的 buildUserPrompt 对得上。
 */
export function buildPetContext() {
  const convo = activeConvo();
  if (!convo) return { convoTitle: '', characters: '', recent: [], summary: '', panel: '' };

  const charName = assistantName(convo) || '';
  const userName = convoUserName(convo) || '我';
  const panelFields = convoPanelFields(convo);
  const groups = panelGroupNames(convo);

  const messages = convoContextMessages(convo);
  const recent = messages.slice(-RECENT_COUNT).map((m) => {
    const raw = String(m.content || '');
    // 助手那条里带着状态栏和【剧情选项】，宠物不需要看这些格式垃圾
    const text =
      m.role === 'assistant' ? cleanAssistantText(raw, panelFields, groups) : raw;
    return {
      role: m.role,
      name: m.role === 'user' ? userName : charName || '角色',
      text: String(text || '').trim().slice(0, MAX_MESSAGE_CHARS)
    };
  });

  return {
    convoTitle: String(convo.title || '未命名对话'),
    characters: [userName, charName].filter(Boolean).join('、'),
    recent: recent.filter((m) => m.text),
    summary: formatSummaryForPrompt(convo),
    panel: panelSnapshot(convo)
  };
}

// ---------------------------------------------------------------------------
//  触发
// ---------------------------------------------------------------------------

/**
 * 「已经过去几轮」按会话分开数。
 *
 * 只在内存里，不落盘：重启之后从头数起，代价顶多是「刚开软件那一轮不说」，
 * 而落盘要多维护一个文件、还要处理读失败 —— 不值得。
 */
const turnCounters = new Map();

/** 换会话/删会话时清一下计数，免得计数器越积越多 */
export function resetPetTurns(convoId) {
  if (convoId) turnCounters.delete(convoId);
  else turnCounters.clear();
}

/** 距离下一次开口还差几轮（设置页拿它显示状态） */
export function turnsUntilNextSpeak() {
  const convo = activeConvo();
  const pet = petCache && petCache.pet;
  if (!convo || !pet) return null;
  const every = Math.max(1, Number(pet.speakEveryTurns) || 1);
  const done = turnCounters.get(convo.id) || 0;
  return Math.max(0, every - done);
}

/**
 * 一轮角色回复刚结束时调一次。
 *
 * 四道检查，全过了才真的开口：
 *   ① 桌宠功能开着 ② 主动发言没暂停 ③ 没在静音期 ④ 攒够轮数了
 * 任何一条挡下都只是「这次不说」，不报错 —— 用户不该看到宠物相关的报错。
 */
export async function maybePetAutoSpeak() {
  const config = petCache && petCache.config;
  const pet = petCache && petCache.pet;

  if (!config || !config.enabled || !pet) return { ok: false, skipped: true, why: 'off' };
  if (!pet.speakEnabled) return { ok: false, skipped: true, why: 'paused' };
  // 「隐藏桌宠」= 用户不想看见它，那也不该听见它。和上面几个闸门同一个口径：
  // 返回在**计数之前**，所以隐藏期间不攒轮数，重新显示后要重新攒够 N 轮才开口
  // （否则一显示出来就立刻蹦一句，像是「隐藏根本没用」）。
  if (!pet.visible) return { ok: false, skipped: true, why: 'hidden' };
  if (pet.mutedUntil > Date.now()) return { ok: false, skipped: true, why: 'muted' };

  const convo = activeConvo();
  if (!convo) return { ok: false, skipped: true, why: 'no-convo' };

  const every = Math.max(1, Number(pet.speakEveryTurns) || 1);
  const done = (turnCounters.get(convo.id) || 0) + 1;
  if (done < every) {
    turnCounters.set(convo.id, done);
    return { ok: false, skipped: true, why: 'waiting', wait: every - done };
  }

  turnCounters.set(convo.id, 0);
  return speakNow('auto');
}

/**
 * 立刻说一次（用户在右键菜单点「让桌宠现在说话」、或设置页点预览走的是另一条路）。
 * reason 决定要不要写记忆：'preview' 永远不写。
 */
export async function speakNow(reason) {
  const context = buildPetContext();
  try {
    const result = await api.petSpeak({ reason, context });
    // 说完记忆条数会变，顺手刷新一下缓存（设置页的状态行要跟着动）
    if (result && result.ok) await refreshPetCache();
    return result || { ok: false, error: '没有返回结果' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '生成失败' };
  }
}

/**
 * 设置页的「预览」。
 *
 * 和 speakNow 的区别只有一个：**reason 是 preview，主进程那边不会写记忆**，
 * 也不会写主对话记录。预览是用来试人格和温度的，点十次也不该在宠物脑子里
 * 留下十句话。
 */
export function previewSpeak() {
  return speakNow('preview');
}

/** 「让桌宠说出这句」：把预览框里那句话直接推给宠物窗口，不重新生成 */
export function sayThisNow(text) {
  return api.petSayNow({ text: String(text || '') }).catch((err) => ({
    ok: false,
    error: (err && err.message) || '推送失败'
  }));
}

/** 当前宠物的展示名（状态行 / 标题用） */
export function petName() {
  return (petCache && petCache.pet && petCache.pet.name) || '桌宠';
}

/** 静音剩余毫秒（不在静音期就是 0） */
export function muteRemainMs() {
  const pet = petCache && petCache.pet;
  if (!pet || !pet.mutedUntil) return 0;
  return Math.max(0, pet.mutedUntil - Date.now());
}

/** 最近几条记忆（设置页打开时才拉，平时不占内存） */
export async function loadPetMemory(petId) {
  const data = await api.petMemoryGet({ petId });
  return { items: asArray(data && data.items), digest: (data && data.digest) || '' };
}
