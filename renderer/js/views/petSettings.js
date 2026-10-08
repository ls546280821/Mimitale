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
  previewSpeak,
  sayThisNow
} from '../data/petContext.js';

/** 预览框里当前那句话（「让桌宠说出这句」推的就是它） */
let previewText = '';

/** 数字输入防抖：边打字边落盘会把每一步中间值都写进去（比如 1→12 中间的 "1"） */
let numberTimer = null;

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
  await api.petUpdate({ petId: pet.id, patch });
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
  if (remain > 0) bits.push(`静音中，还剩 ${Math.ceil(remain / 60000)} 分钟`);
  else bits.push(`每 ${pet.speakEveryTurns} 轮说 ${pet.speakLines} 句`);
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

function renderSkins() {
  const cache = petState();
  const pet = currentPet();
  const box = el.pet.skins;
  if (!box || !pet) return;

  clear(box);
  const skins = (cache && cache.skins) || [];
  if (!skins.length) {
    box.appendChild(h('div', { class: 'field-help', text: '没找到形象文件（assets/pet/default 里应该是空的）' }));
    return;
  }

  for (const item of skins) {
    const active =
      pet.look &&
      pet.look.source === item.source &&
      pet.look.skin === item.skin &&
      pet.look.file === item.file;

    box.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: ['pet-skin', active && 'active'],
          title: item.label,
          onclick: async () => {
            await api.petSkinSet({ petId: pet.id, source: item.source, skin: item.skin, file: item.file });
            await refreshPetCache();
            renderPetSettings();
          }
        },
        h('img', { src: petImageUrlFor(cache, item), alt: '' }),
        h('span', { class: 'pet-skin-name', text: item.file })
      )
    );
  }
}

/**
 * 皮肤小图。
 * ⚠️ 只有**当前正在用的那张**能拿到 data URL（主进程只在状态里带了宠物的形象），
 *    其余的用一个中性占位方块 —— 为了画一排缩略图把每张图都读成 base64
 *    递过来，代价比收益大得多（形象是几百 KB 的图，一排就是几 MB）。
 */
function petImageUrlFor(cache, item) {
  const pet = currentPet();
  if (
    pet &&
    pet.look &&
    pet.look.source === item.source &&
    pet.look.skin === item.skin &&
    pet.look.file === item.file &&
    pet.image
  ) {
    return pet.image;
  }
  return '';
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

/** 把主进程那份状态铺进表单。设置弹窗每次打开、以及收到 pet:changed 时都会调。 */
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
  el.pet.every.value = String(pet.speakEveryTurns);
  el.pet.lines.value = String(pet.speakLines);
  // temperature 为 null 表示「跟随全局」，输入框留空
  el.pet.temp.value = Number.isFinite(pet.temperature) ? String(pet.temperature) : '';
  el.pet.memoryMax.value = String(pet.memoryMaxItems);
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
  renderSkins();
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
      clearTimeout(numberTimer);
      numberTimer = setTimeout(() => {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return;
        const clamped = Math.max(min, Math.min(max, Math.round(n)));
        if (clamped !== n) input.value = String(clamped);
        patchPet({ [key]: clamped });
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

  // ---- 形象 ----

  el.pet.btnSkinPick.addEventListener('click', async () => {
    const result = await api.petSkinPick({}).catch((err) => ({ ok: false, error: err && err.message }));
    if (result && result.ok) {
      await refreshPetCache();
      renderPetSettings();
      showToast('形象换好了', 'ok');
    } else if (result && result.error) {
      showToast(`换形象失败：${result.error}`, 'error');
    }
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
  // 弹窗关着的时候不画：表单在 DOM 里一直存在，没必要为一个看不见的界面
  // 反复重排，而且那还会在用户下次打开前把正在编辑的内容冲掉一次。
  api.onPetChanged(() => {
    if (el.modal && el.modal.classList.contains('hidden')) return;
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
