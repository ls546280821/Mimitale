'use strict';

// ============================================================================
//  views/preset.js —— 预设编辑器（弹窗）
//
//  只编辑**一个**预设：名字 + 说明 + 标签 + 指令正文 +（可选）采样参数。
//  「保存后才生效」：改动先落在本地草稿上，点「保存」才写回 state 并落盘，
//  没保存就关要问一句「放弃改动？」—— 和世界书编辑器同一套手感。
//
//  这个模块不向上 import 入口层：保存后要「全量重绘」（预设页、会话视角弹窗
//  都可能要跟着变）属于入口层编排，由 initPreset 注入 rerender。
//
//  弹窗只在打开时渲染，不参与整体重绘，所以不向刷新总线登记。
//
//  草稿（draft）的语义：
//    · null            —— 没在编辑任何预设
//    · { id: null, … } —— 新建，还没写进 state
//    · { id: 'pr…', …} —— 编辑已有的那个（可能是新加的）
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { dialoguePresets, convoDialoguePresetIds } from '../data/library.js';
import { persistPresets, persistConversations } from '../data/persist.js';
import { renderPresetPage } from './presetList.js';

/** 正在编辑的草稿（见文件头说明） */
let draft = null;
/** 打开编辑器时的原始快照，用来判断「有没有未保存的改动」 */
let baseline = '';
/** 入口层注入的重绘动作 */
let rerender = () => {};

export function initPreset(injected) {
  rerender = (injected && injected.rerender) || (() => {});

  el.pr.btnClose.addEventListener('click', () => closePresetEditor());
  el.pr.btnClose2.addEventListener('click', () => closePresetEditor());
  el.pr.btnSave.addEventListener('click', savePreset);
  el.pr.btnDel.addEventListener('click', deletePreset);
  el.pr.modal.addEventListener('click', (event) => {
    if (event.target === el.pr.modal) closePresetEditor();
  });

  // 有改动就提示 —— 和世界书编辑器一样，靠对比快照判断
  const markDirty = () => {
    if (!draft) return;
    const dirty = snapshot() !== baseline;
    el.pr.footHint.textContent = dirty ? '有未保存的改动' : '预设只保存在你自己电脑上';
    el.pr.footHint.classList.toggle('pr-dirty', dirty);
  };
  for (const node of [el.pr.name, el.pr.tags, el.pr.note, el.pr.content, el.pr.temperature, el.pr.maxTokens, el.pr.topP]) {
    if (node) node.addEventListener('input', markDirty);
  }
  el.pr.enabled.addEventListener('change', markDirty);
  el.pr.global.addEventListener('change', markDirty);
}

/** 表单当前值的快照（用来比对有没有改动） */
function snapshot() {
  return JSON.stringify([
    el.pr.name.value,
    el.pr.tags.value,
    el.pr.note.value,
    el.pr.content.value,
    el.pr.enabled.checked,
    el.pr.global.checked,
    el.pr.temperature.value,
    el.pr.maxTokens.value,
    el.pr.topP ? el.pr.topP.value : ''
  ]);
}

const str = (node) => (node ? String(node.value || '') : '');

/** 空的数字输入 = 「用全局」→ null；填了但不是数字就当没填 */
function numberOrNull(node, min, max) {
  const raw = str(node).trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
//  打开 / 关闭
// ---------------------------------------------------------------------------

/** 打开编辑器编辑已有的一个预设 */
export function openPresetEditor(id) {
  const preset = dialoguePresets().find((p) => p.id === id);
  if (!preset) {
    showToast('这个预设已经不在了', 'error');
    return;
  }
  draft = {
    id: preset.id,
    name: preset.name || '',
    note: preset.note || '',
    tags: Array.isArray(preset.tags) ? [...preset.tags] : [],
    content: preset.content || '',
    enabled: preset.enabled !== false,
    global: preset.global === true,
    temperature: preset.temperature,
    maxTokens: preset.maxTokens,
    topP: preset.topP
  };
  fillForm();
  showEditor(`${preset.name || '未命名预设'} · 点「保存」后生效`);
}

/** 新建一个空预设：草稿 id 为 null，保存时才真正进 state */
export function newPreset() {
  draft = {
    id: null,
    name: '',
    note: '',
    tags: [],
    content: '',
    enabled: true,
    global: false,
    temperature: null,
    maxTokens: null,
    topP: null
  };
  fillForm();
  showEditor('新预设 · 点「保存」后才会创建');
  el.pr.name.focus();
}

function fillForm() {
  const d = draft || {};
  el.pr.name.value = d.name || '';
  el.pr.note.value = d.note || '';
  el.pr.tags.value = Array.isArray(d.tags) ? d.tags.join(', ') : '';
  el.pr.content.value = d.content || '';
  el.pr.enabled.checked = d.enabled !== false;
  el.pr.global.checked = d.global === true;
  el.pr.temperature.value = Number.isFinite(d.temperature) ? String(d.temperature) : '';
  el.pr.maxTokens.value = Number.isFinite(d.maxTokens) ? String(d.maxTokens) : '';
  if (el.pr.topP) el.pr.topP.value = Number.isFinite(d.topP) ? String(d.topP) : '';
  baseline = snapshot();
  el.pr.footHint.textContent = '预设只保存在你自己电脑上';
  el.pr.footHint.classList.remove('pr-dirty');
}

function showEditor(subText) {
  el.pr.title.textContent = draft && draft.id ? '编辑预设' : '新建预设';
  el.pr.sub.textContent = subText;
  // 还没保存过的预设没有可删的东西，先别给这个按钮
  el.pr.btnDel.classList.toggle('hidden', !(draft && draft.id));
  el.pr.modal.classList.remove('hidden');
}

/**
 * 关编辑器。有未保存的改动时先问一句。
 * 返回 true = 真的关掉了（调用方据此决定要不要继续别的事）。
 */
export async function closePresetEditor() {
  if (!draft) {
    el.pr.modal.classList.add('hidden');
    return true;
  }
  if (snapshot() !== baseline) {
    const ok = await confirmDialog({
      title: '放弃未保存的改动？',
      message: '这个预设的改动还没有保存，关掉就没了。',
      confirmText: '放弃',
      danger: true
    });
    if (!ok) return false;
  }
  draft = null;
  el.pr.modal.classList.add('hidden');
  el.input.focus();
  return true;
}

// ---------------------------------------------------------------------------
//  保存 / 删除
// ---------------------------------------------------------------------------

/** 把表单写回草稿对象 */
function stashPresetForm() {
  if (!draft) return;
  draft.name = str(el.pr.name).trim();
  draft.note = str(el.pr.note).trim();
  draft.tags = str(el.pr.tags)
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  draft.content = str(el.pr.content);
  draft.enabled = el.pr.enabled.checked;
  draft.global = el.pr.global.checked;
  draft.temperature = numberOrNull(el.pr.temperature, 0, 2);
  const mt = numberOrNull(el.pr.maxTokens, 64, 32000);
  draft.maxTokens = mt === null ? null : Math.round(mt);
  draft.topP = numberOrNull(el.pr.topP, 0, 1);
}

async function savePreset() {
  stashPresetForm();
  if (!draft) return;

  if (!draft.name) {
    showToast('给这个预设起个名字吧', 'error');
    el.pr.name.focus();
    return;
  }
  if (!draft.content.trim()) {
    showToast('指令正文是空的 —— 写上「回复要遵循什么规则」才有用', 'error');
    el.pr.content.focus();
    return;
  }

  const existing = draft.id ? dialoguePresets().find((p) => p.id === draft.id) : null;
  if (existing) {
    Object.assign(existing, {
      name: draft.name,
      note: draft.note,
      tags: draft.tags,
      content: draft.content,
      enabled: draft.enabled,
      global: draft.global,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      topP: draft.topP,
      updatedAt: now()
    });
  } else {
    state.dialoguePresets = [
      ...dialoguePresets(),
      {
        id: `pr${uid()}`,
        name: draft.name,
        note: draft.note,
        tags: draft.tags,
        content: draft.content,
        entries: [],
        enabled: draft.enabled,
        global: draft.global,
        temperature: draft.temperature,
        maxTokens: draft.maxTokens,
        topP: draft.topP,
        createdAt: now(),
        updatedAt: now()
      }
    ];
    // 新建的要记住 id，否则第二次点保存会再建一个
    draft.id = state.dialoguePresets[state.dialoguePresets.length - 1].id;
  }

  const ok = await persistPresets();
  if (!ok) return;

  draft = null;
  el.pr.modal.classList.add('hidden');
  showToast(existing ? '预设已保存' : '预设已创建', 'ok');
  renderPresetPage();
  rerender();
  el.input.focus();
}

/**
 * 删掉一个预设。两个入口共用这一份逻辑：编辑器里的「删除」，
 * 和列表页卡片右上角那个 ×。返回是否真的删了。
 */
export async function deletePresetById(id) {
  const preset = dialoguePresets().find((p) => p.id === id);
  if (!preset) return false;

  // 绑了这个预设的会话有几条？删之前说清楚
  const used = (Array.isArray(state.conversations) ? state.conversations : []).filter(
    (c) => convoDialoguePresetIds(c)?.includes(id)
  ).length;

  const ok = await confirmDialog({
    title: '删除预设',
    message: used
      ? `删除「${preset.name}」？有 ${used} 个会话正用着它，删掉之后那些会话会退回默认规则。`
      : `删除「${preset.name}」？删除后找不回来。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return false;

  state.dialoguePresets = dialoguePresets().filter((p) => p.id !== id);

  // 会话上还绑着它的要一起摘掉，别留下指向空气的 id
  for (const convo of Array.isArray(state.conversations) ? state.conversations : []) {
    const ids = convoDialoguePresetIds(convo);
    if (ids && ids.includes(id)) {
      // 只摘这一个，其余保留；摘完可能是空数组 = 显式「一条都不要」
      convo.dialoguePresetIds = ids.filter((x) => x !== id);
      convo.updatedAt = now();
    }
  }

  // 编辑器正开在这个预设上：收掉草稿，免得关弹窗时又把它写回去
  if (draft && draft.id === id) draft = null;

  const saved = await persistPresets();
  if (saved) showToast('预设已删除', 'ok');

  // 会话解绑了要落盘，否则重启之后又绑回去
  persistConversations(0);

  renderPresetPage();
  rerender();
  return true;
}

function deletePreset() {
  const id = draft && draft.id;
  if (!id) return;
  deletePresetById(id).then((done) => {
    if (done) {
      el.pr.modal.classList.add('hidden');
      el.input.focus();
    }
  });
}
