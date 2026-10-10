'use strict';

// ============================================================================
//  views/petSettings.js —— 设置弹窗里的「桌宠」区块
//
//  这个区块和普通设置项有个根本区别：**它改的是另一个窗口里的东西**。
//  所以这里的改动是**即时生效**的，不走「点保存才落盘」——原因是
//  需求里那条「设置页和右键菜单两边同步」：
//
//    用户在宠物身上右键点了「暂停主动发言」→ 主进程改配置 → 推 pet:changed
//      → 这个区块重画；
//    反方向也一样：这里改了 → 主进程改配置 → 广播 → 右键菜单下次打开就是新的。
//
//  如果这里攒着等「保存」，两边就会**同时存在两个真相**：菜单里显示"已暂停"、
//  设置页里那个勾还在 —— 用户会以为设置没生效。
//
//  另外「预览」是这个区块里最要紧的功能：它是唯一**不用等轮数**就能试人格的入口，
//  所以它按 reason='preview' 走，主进程那边**不写记忆、不写对话记录**。
// ============================================================================

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { saveExport } from '../data/export.js';
import {
  refreshPetCache,
  petState,
  loadPetMemory,
  muteRemainMs,
  turnsUntilNextSpeak,
  previewSpeak,
  sayThisNow
} from '../data/petContext.js';

/** 预览框里当前那句话（「让桌宠说出这句」推的就是它） */
let previewText = '';

/**
 * 数字输入防抖：边打字边落盘会把每一步中间值都写进去（比如 1→12 中间的 "1"）。
 *
 * ⚠️ 三个数字框**共用一份待提交表**，而不是各留一个定时器。
 * 各留一个的话，先改「轮数」再改「句数」会这样翻车：
 *   轮数的定时器先到 → patchPet → 重画 → 用缓存里的旧值把「句数」输入框冲掉；
 *   句数的定时器随后读到那个被冲掉的旧值，用户这次修改就丢了。
 * 合并成一次 patch 之后，重画只发生在两个字段都已经写进去之后。
 */
let numberTimer = null;
const pendingNumbers = new Map();

/** 「大小」滑块的落盘防抖（拖动中只本地预览，停手才写盘） */
let scaleTimer = null;

/** 取出并清空待提交的数字字段；没有待提交的返回 null */
function flushPendingNumbers() {
  clearTimeout(numberTimer);
  numberTimer = null;
  if (!pendingNumbers.size) return null;
  const patch = Object.fromEntries(pendingNumbers);
  pendingNumbers.clear();
  return patch;
}

function currentPet() {
  const cache = petState();
  return cache && cache.pet ? cache.pet : null;
}

function currentConfig() {
  return (petState() && petState().config) || null;
}

/** 改某一只桌宠的字段 → 主进程 → 刷缓存 → 重画 */
async function patchPet(patch) {
  const pet = currentPet();
  if (!pet) return;
  // 把还没提交的数字改动并进来：紧随其后的重画会按缓存重填输入框，
  // 漏掉任何一项都等于把用户刚敲的值抹掉。
  const pending = flushPendingNumbers();
  const merged = { ...(pending || {}), ...(patch || {}) };
  await api.petUpdate({ petId: pet.id, patch: merged });
  await refreshPetCache();
  renderPetSettings();
}

// ---------------------------------------------------------------------------
//  画
// ---------------------------------------------------------------------------

function renderStatusLine() {
  const config = currentConfig();
  const pet = currentPet();
  const node = el.pet.status;
  if (!node) return;

  if (!config || !pet) {
    node.textContent = '还没有可用的桌宠配置';
    return;
  }
  if (!config.enabled) {
    node.textContent = '已关闭 —— 打开上面的开关它才会回到桌面';
    return;
  }

  const bits = [pet.visible ? '在桌面上' : '已隐藏'];
  if (!pet.speakEnabled) bits.push('主动发言已暂停');
  const remain = muteRemainMs();
  if (remain > 0) {
    bits.push(`静音中，还剩 ${Math.ceil(remain / 60000)} 分钟`);
  } else {
    bits.push(`每 ${pet.speakEveryTurns} 轮说 ${pet.speakLines} 句`);
    // 再攒几轮才开口。没有会话时 turnsUntilNextSpeak 返回 null —— 那时不显示这一项，
    // 而不是显示「还差 0 轮」（那会像是它马上就要说话了）。
    const wait = turnsUntilNextSpeak();
    if (Number.isFinite(wait)) bits.push(wait > 0 ? `还差 ${wait} 轮开口` : '下一轮就开口');
  }
  bits.push(`记忆 ${(petState() && petState().memoryCount) || 0} 条`);

  node.textContent = bits.join(' · ');
}

function renderModelSelect() {
  const cache = petState();
  const pet = currentPet();
  const select = el.pet.model;
  if (!select || !pet) return;

  const useMain = pet.useMainModel !== false;
  el.pet.useMainModel.checked = useMain;
  el.pet.modelField.classList.toggle('hidden', useMain);

  const mainHint = `当前主模型：${(cache && cache.mainModel) || '未配置'}`;
  el.pet.mainHint.textContent = mainHint;

  clear(select);
  for (const item of (cache && cache.models) || []) {
    select.appendChild(h('option', { value: `${item.providerId}\u0000${item.model}`, text: item.label }));
  }
  if (!select.options.length) {
    select.appendChild(h('option', { value: '', text: '（先去上面配置服务商）' }));
  }
  select.value = `${pet.providerId || ''}\u0000${pet.model || ''}`;
  if (!select.value || select.selectedIndex < 0) select.selectedIndex = 0;
}

// 形象下拉里那些候选（assets/pet/<名字>/ + 用户导入的 skins/<名字>/）
// 只在设置弹窗打开时拉一次就够，没必要每次重画都读盘
let skinCache = null;

/**
 * 铺「形象」下拉。
 *
 * ⚠️ 这个下拉的 value 用 `source\0skin` 两段拼：`assets\0whale`、`user\0mygirl`。
 *    只存 skin 名不够 —— assets 和 user 下可能重名，那样切了会切到另一张卡。
 */
async function renderSkinSelect(force) {
  const select = el.pet.skin;
  const pet = currentPet();
  if (!select || !pet) return;

  if (!skinCache || force) {
    try {
      skinCache = await api.petSkins();
    } catch (err) {
      skinCache = [];
    }
  }

  const items = Array.isArray(skinCache) ? skinCache : [];
  clear(select);
  for (const item of items) {
    const where = item.source === 'user' ? '（自己导入的）' : '';
    select.appendChild(
      h('option', { value: `${item.source}\u0000${item.id}`, text: `${item.label}${where}` })
    );
  }
  if (!select.options.length) {
    select.appendChild(h('option', { value: '', text: '（没找到任何形象）' }));
  }

  const look = pet.look || {};
  select.value = `${look.source || 'assets'}\u0000${look.skin || 'whale'}`;
  if (select.selectedIndex < 0) select.selectedIndex = 0;

  // 提示里把「当前这张卡在哪」讲清楚 —— 用户要往里放自己的角色时最需要这句
  if (el.pet.skinHint) {
    const found = items.some((i) => i.id === look.skin && i.source === (look.source || 'assets'));
    el.pet.skinHint.textContent = found
      ? `当前形象：${look.skin}（${look.source === 'user' ? 'data/pet/skins' : 'assets/pet'}）—— 切换后桌宠窗口会立刻换`
      : `形象「${look.skin}」没找到，桌宠会显示占位框。放好自己的角色后在 assets/pet/<名字>/ 里加 model.json 就能在这里选它`;
  }
}

function renderMemory(items, digest) {
  const box = el.pet.memory;
  if (!box) return;
  clear(box);

  if (digest) {
    box.appendChild(
      h('div', { class: 'pet-memory-digest' }, h('b', { text: '更早以前的折叠摘要：' }), digest)
    );
  }

  if (!items.length) {
    box.appendChild(
      h('div', { class: 'field-help', text: '还没有记忆。它说过的话、记下的事都会出现在这儿。' })
    );
    return;
  }

  for (const item of items) {
    const when = item.at ? new Date(item.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const kind = item.kind === 'say' ? '说过' : item.kind === 'user' ? '偏好' : '记事';
    box.appendChild(
      h(
        'div',
        { class: ['pet-memory-item', `kind-${item.kind || 'event'}`] },
        h('span', { class: 'pet-memory-meta', text: `${kind} · ${when}` }),
        h('span', { class: 'pet-memory-text', text: item.text })
      )
    );
  }
}

/**
 * 铺「大小」滑块。
 *
 * 滑块不是 0~100 的百分比，而是直接绑 `scale * 100`（60~160，step 5）——
 * 这样范围正好落在「看得见但不离谱」那段：再小到 40% 猫就一个点、再大到 200%
 * 窗口铺满半屏。极端值仍可以从右键菜单的「大小」选到（那里有 200%）。
 *
 * --range-fill 是滑块轨道的填充比例（样式在 style.css 的 `.field input[type=range]`），
 * 不给它的话轨道会永远是半黑半主题色，跟当前值对不上。
 */
function renderScale() {
  const pet = currentPet();
  const input = el.pet.scale;
  const badge = el.pet.scaleValue;
  if (!input || !pet) return;

  const pct = Math.round(Math.max(0.6, Math.min(1.6, Number(pet.scale) || 1)) * 100);
  // 拖动中不回填 value —— 否则鼠标还按着的时候会被缓存值拽回去
  if (document.activeElement !== input) input.value = String(pct);
  input.style.setProperty('--range-fill', `${((pct - 60) / (160 - 60)) * 100}%`);
  if (badge) badge.textContent = `${Math.round((Number(pet.scale) || 1) * 100)}%`;
}

/**
 * 铺「空闲小动作」那三个勾。
 *
 * ⚠️ 这里和「大小」滑块有个共同的坑：用户正在操作时不能回填。
 *    勾选是即时生效的（点一下 → patchPet → 重画），重画时如果无条件把
 *    `checked` 按缓存值重写，用户快速连点两下就会被中间那次重画冲掉一次。
 *    所以只跳过「当前正在编辑的那一个」。
 *
 * ⚠️ 「三个全不勾」是**合法状态**（= 让它安静待着），不要在这里做
 *    「至少留一个」的兜底 —— 那会让用户取消最后一个勾时看着没反应。
 */
const GESTURE_FIELDS = [
  ['nod', 'gestureNod'],
  ['shake', 'gestureShake'],
  ['wave', 'gestureWave']
];

function renderGestures() {
  const pet = currentPet();
  if (!pet || !el.pet.gestureField) return;
  // 字段缺失（老配置还没写过）时按「全开」显示 —— 和主进程 defaultPet 一个口径
  const enabled = Array.isArray(pet.gestureEnabled) ? pet.gestureEnabled : GESTURE_FIELDS.map((g) => g[0]);
  for (const [kind, key] of GESTURE_FIELDS) {
    const input = el.pet[key];
    if (!input) continue;
    if (document.activeElement === input) continue;
    input.checked = enabled.includes(kind);
  }
}


export function renderPetSettings() {
  const config = currentConfig();
  const pet = currentPet();
  if (!el.pet.section) return;

  if (!config || !pet) {
    el.pet.section.classList.add('pet-missing');
    renderStatusLine();
    return;
  }
  el.pet.section.classList.remove('pet-missing');

  el.pet.enabled.checked = config.enabled !== false;
  el.pet.speakEnabled.checked = pet.speakEnabled !== false;
  // 还没提交的数字改动不要用缓存值冲掉（其他操作也会触发重画）
  const setNumber = (input, key, value) => {
    if (pendingNumbers.has(key)) return;
    input.value = String(value);
  };
  setNumber(el.pet.every, 'speakEveryTurns', pet.speakEveryTurns);
  setNumber(el.pet.lines, 'speakLines', pet.speakLines);
  // temperature 为 null 表示「跟随全局」，输入框留空
  if (!pendingNumbers.has('temperature')) {
    el.pet.temp.value = Number.isFinite(pet.temperature) ? String(pet.temperature) : '';
  }
  setNumber(el.pet.memoryMax, 'memoryMaxItems', pet.memoryMaxItems);
  el.pet.style.value = pet.style || '';

  // 人格是有可能要重读文件的，所以只在框里还是空的时候才覆盖，
  // 免得把用户正在编辑的内容冲掉（右键菜单改配置也会走到这里）
  if (!el.pet.persona.value && petState().persona) {
    el.pet.persona.value = petState().persona;
  }

  el.pet.btnVisible.textContent = pet.visible ? '隐藏桌宠' : '显示桌宠';
  const remain = muteRemainMs();
  el.pet.btnMute.textContent = remain > 0 ? `取消静音（剩 ${Math.ceil(remain / 60000)} 分）` : '静音 1 小时';

  renderModelSelect();
  renderSkinSelect();
  renderScale();
  renderGestures();
  renderStatusLine();
}

// ---------------------------------------------------------------------------
//  预览
// ---------------------------------------------------------------------------

function setPreview(text, isError) {
  if (!el.pet.preview) return;
  el.pet.preview.textContent = text || '';
  el.pet.preview.classList.toggle('is-error', !!isError);
  el.pet.btnSay.disabled = !text || !!isError;
}

async function doPreview() {
  el.pet.btnPreview.disabled = true;
  setPreview('它正在想…');
  try {
    const result = await previewSpeak();
    if (!result.ok) {
      setPreview(`没能生成：${result.error || '未知原因'}`, true);
      return;
    }
    previewText = result.text || '';
    const via = result.fellBack ? `（宠物自己那个模型没成，用了主模型：${result.model}）` : '';
    setPreview(result.lines.join('\n') + (via ? `\n${via}` : ''));
    el.pet.btnSay.disabled = false;
  } finally {
    el.pet.btnPreview.disabled = false;
    renderStatusLine();
  }
}

// ---------------------------------------------------------------------------
//  记忆
// ---------------------------------------------------------------------------

async function refreshMemory() {
  const pet = currentPet();
  if (!pet || !el.pet.memory) return;
  try {
    const { items, digest } = await loadPetMemory(pet.id);
    renderMemory(items, digest);
    el.pet.memoryHint.textContent =
      `保留上限 ${pet.memoryMaxItems} 条，现在 ${items.length} 条` +
      (digest ? '（更早的已经折进摘要）' : '') +
      '。记忆存在 data/pet/memory/ 里，和主对话的记忆完全分开。';
  } catch (err) {
    el.pet.memoryHint.textContent = `读取记忆失败：${(err && err.message) || '未知错误'}`;
  }
}

async function exportMemory() {
  const result = await api.petMemoryExport({}).catch((err) => ({ ok: false, error: err && err.message }));
  if (!result || !result.ok) {
    showToast(`导出失败：${(result && result.error) || '未知原因'}`, 'error');
    return;
  }
  await saveExport({
    fileName: result.fileName,
    text: result.text,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
}

// ---------------------------------------------------------------------------
//  绑定
// ---------------------------------------------------------------------------

export function initPetSettings(opts) {
  const options = opts || {};
  if (!el.pet.section) return;

  // ---- 开关 / 数字 ----

  el.pet.enabled.addEventListener('change', async () => {
    await api.petUpdate({ patch: { enabled: el.pet.enabled.checked } });
    await refreshPetCache();
    renderPetSettings();
  });

  el.pet.speakEnabled.addEventListener('change', () => patchPet({ speakEnabled: el.pet.speakEnabled.checked }));

  const bindNumber = (input, key, min, max) => {
    input.addEventListener('input', () => {
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      const clamped = Math.max(min, Math.min(max, Math.round(n)));
      if (clamped !== n) input.value = String(clamped);

      pendingNumbers.set(key, clamped);
      clearTimeout(numberTimer);
      numberTimer = setTimeout(() => {
        const patch = flushPendingNumbers();
        if (patch) patchPet(patch);
      }, 600);
    });
  };
  bindNumber(el.pet.every, 'speakEveryTurns', 1, 50);
  bindNumber(el.pet.lines, 'speakLines', 1, 5);
  bindNumber(el.pet.memoryMax, 'memoryMaxItems', 0, 200);

  // 温度允许留空 = 跟随全局，所以不能走上面那套「必须是数字」
  el.pet.temp.addEventListener('change', () => {
    const raw = el.pet.temp.value.trim();
    patchPet({ temperature: raw === '' ? null : Math.max(0, Math.min(2, Number(raw))) });
  });

  el.pet.style.addEventListener('change', () => patchPet({ style: el.pet.style.value.trim() }));

  // ---- 形象 ----
  //
  //  ⚠️ 下拉一换就要**重建整张卡**：主进程那边 rigSkinDir() 会因为 look.skin 变了
  //     而指向新目录，推送的 rig key 也跟着变，宠物窗口才会真的重载贴图。
  //     所以这里不用做「先看看目录有没有 model.json」的预检 —— 主进程读不到会
  //     自己退回空包，宠物窗口显示占位框，比在这里静默拒绝更好排查。
  if (el.pet.skin) {
    el.pet.skin.addEventListener('change', () => {
      const [source, skin] = String(el.pet.skin.value || '').split('\u0000');
      if (!skin) return;
      patchPet({ look: { kind: 'rig', source: source || 'assets', skin } });
      showToast('形象已切换', 'ok');
    });
  }

  // ---- 大小 ----

  // 拖动中即时更新标签和轨道填充（本地、不发 IPC），停手 250ms 才落盘。
  // 不防抖的话一次拖动会发几十条 pet:update，每条都让窗口 setContentBounds 一次 ——
  // 窗口会一顿一顿地跳。
  if (el.pet.scale) {
    el.pet.scale.addEventListener('input', () => {
      const pct = Number(el.pet.scale.value) || 100;
      el.pet.scale.style.setProperty('--range-fill', `${((pct - 60) / (160 - 60)) * 100}%`);
      if (el.pet.scaleValue) el.pet.scaleValue.textContent = `${pct}%`;
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => patchPet({ scale: pct / 100 }), 250);
    });
    // 松手（或键盘调完）立刻补一次，免得最后那一下还在防抖里就被别的重画冲掉
    el.pet.scale.addEventListener('change', () => {
      clearTimeout(scaleTimer);
      scaleTimer = null;
      patchPet({ scale: (Number(el.pet.scale.value) || 100) / 100 });
    });
  }

  // ---- 空闲小动作 ----
  //
  //  三个勾共用一段逻辑：每次都把「当前三个框的勾选状态」整理成数组整个写回去。
  //  好处是不需要区分「刚勾上的是哪一个」—— 状态以 DOM 为准，写完就是完整的真相，
  //  不会出现「A 勾了、B 忘了同步」这种半截状态。
  const onGestureToggle = () => {
    const enabled = GESTURE_FIELDS
      .filter(([, key]) => el.pet[key] && el.pet[key].checked)
      .map(([kind]) => kind);
    patchPet({ gestureEnabled: enabled });
  };
  for (const [, key] of GESTURE_FIELDS) {
    if (el.pet[key]) el.pet[key].addEventListener('change', onGestureToggle);
  }

  // ---- 模型 ----

  el.pet.useMainModel.addEventListener('change', () => {
    if (el.pet.useMainModel.checked) patchPet({ useMainModel: true });
    else {
      // 取消「跟随主模型」时，如果还没指定过模型，就把下拉里第一个填进去，
      // 否则会出现「取消了跟随、但没有模型」的空档
      const value = String(el.pet.model.value || '');
      const [providerId, model] = value.split('\u0000');
      patchPet({ useMainModel: false, providerId: providerId || '', model: model || '' });
    }
  });

  el.pet.model.addEventListener('change', () => {
    const [providerId, model] = String(el.pet.model.value || '').split('\u0000');
    patchPet({ useMainModel: false, providerId: providerId || '', model: model || '' });
  });

  // ---- 人格 ----

  el.pet.persona.addEventListener('change', async () => {
    const pet = currentPet();
    if (!pet) return;
    await api.petPersonaSave({ petId: pet.id, text: el.pet.persona.value });
    showToast('人格设定已保存', 'ok');
  });

  el.pet.btnPersonaReset.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '还原人格设定',
      message: '把桌宠的人格还原成内置的那一份？你改过的内容会丢掉。',
      confirmText: '还原',
      danger: true
    });
    if (!ok) return;
    const pet = currentPet();
    if (!pet) return;
    // 传空文本 = 让主进程把内置那份重新写出来（主进程那边把空当「还原」处理）
    const result = await api.petPersonaSave({ petId: pet.id, text: '' });
    el.pet.persona.value = (result && result.persona) || '';
    await refreshPetCache();
    el.pet.persona.value = (result && result.persona) || petState().persona || '';
    renderPetSettings();
    showToast('已还原成内置人格', 'ok');
  });

  // ---- 状态按钮 ----

  el.pet.btnSpeak.addEventListener('click', async () => {
    el.pet.btnSpeak.disabled = true;
    try {
      // 走 options.requestSpeak（入口层注入）—— 它和「右键菜单点现在说话」
      // 是同一条路：组上下文 → 生成 → 推给宠物窗口
      await options.speakNow?.('manual');
    } finally {
      el.pet.btnSpeak.disabled = false;
      await refreshPetCache();
      renderPetSettings();
    }
  });

  el.pet.btnMute.addEventListener('click', () => {
    const remain = muteRemainMs();
    patchPet({ mutedUntil: remain > 0 ? 0 : Date.now() + 60 * 60 * 1000 });
  });

  el.pet.btnVisible.addEventListener('click', async () => {
    const pet = currentPet();
    if (!pet) return;
    await api.petSetVisible({ visible: !pet.visible });
    await refreshPetCache();
    renderPetSettings();
  });

  // ---- 预览 ----

  el.pet.btnPreview.addEventListener('click', () => doPreview());

  el.pet.btnSay.addEventListener('click', async () => {
    if (!previewText) return;
    const result = await sayThisNow(previewText);
    if (result && result.ok) showToast('让它说出来了', 'ok');
    else showToast(`没能说出来：${(result && result.error) || '未知原因'}`, 'error');
  });

  // ---- 记忆 ----

  el.pet.btnMemoryRefresh.addEventListener('click', () => refreshMemory());

  el.pet.btnMemoryExport.addEventListener('click', () => exportMemory());

  el.pet.btnMemoryReset.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重置桌宠记忆',
      message: '清掉它记得的每一条，但保留更早以前折叠成的摘要。',
      confirmText: '重置',
      danger: true
    });
    if (!ok) return;
    await api.petMemoryClear({ keepDigest: true });
    await refreshPetCache();
    renderPetSettings();
    await refreshMemory();
    showToast('桌宠记忆已重置', 'ok');
  });

  el.pet.btnMemoryClear.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空桌宠记忆',
      message: '连折叠摘要一起清掉，等于让它把你忘干净。这个操作没法撤销。',
      confirmText: '清空',
      danger: true
    });
    if (!ok) return;
    await api.petMemoryClear({ keepDigest: false });
    await refreshPetCache();
    renderPetSettings();
    await refreshMemory();
    showToast('桌宠记忆已清空', 'ok');
  });

  // 「设置页和右键菜单两边同步」这条需求的两个方向之一：
  // 右键菜单（在宠物窗口上）改了配置 → 主进程广播 pet:changed → 这里重画。
  //
  // 人不在设置页时不画：表单在 DOM 里一直存在，没必要为一个看不见的界面
  // 反复重排，而且那还会在用户下次打开前把正在编辑的内容冲掉一次。
  api.onPetChanged(async () => {
    // 缓存**永远**要刷：右键菜单（在宠物窗口上）改的就是这份配置，而
    // maybePetAutoSpeak 的几个闸门（总开关 / 主动发言 / 隐藏 / 静音 / 轮数）
    // 读的正是 petCache。弹窗关着就不刷的话，「隐藏桌宠」「暂停主动发言」
    // 这些刚落盘的设置要等到下一次成功说话才生效 —— 表现就是
    // 「我明明点了隐藏，过几轮它又自己冒出来」。
    await refreshPetCache();
    // 2026-10-09 设置从弹窗改成页面：这条判据从「弹窗显不显示」换成「在不在这一屏」。
    if (el.viewSettings && el.viewSettings.classList.contains('hidden')) return;
    onPetStateChanged();
  });
}

/** 设置弹窗打开时调：拉最新状态 + 铺表单 + 顺便把记忆也拉出来 */
export async function openPetSection(focus) {
  await refreshPetCache();
  renderPetSettings();
  await refreshMemory();
  if (focus === 'memory' && el.pet.section) {
    el.pet.section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/** 设置页那边收到 pet:changed 就调它（键盘菜单改的东西要反映到表单上） */
export function onPetStateChanged() {
  renderPetSettings();
  refreshMemory();
}
