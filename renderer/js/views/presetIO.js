'use strict';

// ============================================================================
//  views/presetIO.js —— 预设的导入 / 导出
//
//  导入：主进程弹文件框、读 JSON、过归一化（presets:import），**不落盘** ——
//  收不收、收哪几条由这一层决定。导进来的 id 一律重发，否则两条同 id
//  的预设会互相顶掉。
//
//  导出：直接把内容交给 util:saveFile 写盘。导出的形状是「一整份数组」，
//  正好是我们自己 import 认得的三种形态之一（单条 / 数组 / {presets:[]}），
//  所以导出的文件能被自己的导入原样吃回来。
//
//  落盘之后要重绘预设页 —— 但那一页归 presetList.js 管，本模块不向上 import，
//  由入口层通过 initPresetIo 注入 rerender。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { dialoguePresets, dialoguePresetById } from '../data/library.js';
import { persistPresets } from '../data/persist.js';
import { renderPresetPage } from './presetList.js';

/** 入口层注入的动作 */
let rerender = () => {};

/** 导入时重发 id 用的自增序号：同一毫秒里连导几次也不会撞车 */
let importSeq = 0;

/**
 * 给导进来的一批预设重新发 id。
 *
 * 主进程那边已经把 id 清空了（导入时有意不带 id），所以这里不涉及
 * 「改写绑定」——预设不像角色那样被别的东西按 id 引用。
 * 但会话里可能会绑着**同名**的旧预设，这里不去动它：用户导进来的
 * 是「新的一条」，要不要替换是用户自己的事。
 */
function reissuePresetIds(list) {
  importSeq += 1;
  const stamp = `${Date.now().toString(36)}-${importSeq}`;
  return list.map((p, i) => ({ ...p, id: `pr${stamp}-${i}` }));
}

/**
 * 一份预设导出成文件时该长什么样。
 *
 * 导出**不带运行期字段**（id 是对内的、时间戳没意义），
 * 留 name / note / tags / content / entries / 采样参数 / enabled / global ——
 * 这些正是 normalizePreset 认的字段，导回来能完整还原。
 */
function exportShape(preset) {
  const out = {
    name: preset.name,
    note: preset.note || '',
    content: preset.content || '',
    tags: Array.isArray(preset.tags) ? preset.tags : [],
    enabled: preset.enabled !== false,
    global: preset.global === true
  };
  if (Array.isArray(preset.entries) && preset.entries.length) {
    out.entries = preset.entries.map((e) => ({
      title: e.title,
      keys: e.keys || [],
      content: e.content || '',
      constant: e.constant === true,
      enabled: e.enabled !== false
    }));
  }
  // 采样参数只在设过的时候写出去，免得导回来一堆 null
  for (const key of ['temperature', 'maxTokens', 'topP']) {
    if (Number.isFinite(preset[key])) out[key] = preset[key];
  }
  return out;
}

/** 文件名里不能有的字符统统换成下划线（Windows 上还禁冒号、星号这些） */
function safeFileName(name) {
  return String(name || '预设')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '预设';
}

/** 按默认文件名导出，返回是否真的写了（用户取消 = false） */
async function savePresetsToFile(presets, fileName, title) {
  const text = JSON.stringify(
    presets.length === 1 ? presets[0] : { presets },
    null,
    2
  );

  let result = null;
  try {
    result = await api.saveFile({
      title,
      fileName,
      filters: [{ name: '预设文件（JSON）', extensions: ['json'] }],
      text
    });
  } catch (err) {
    showToast((err && err.message) || '导出失败', 'error');
    return false;
  }

  if (!result || result.canceled) return false;
  if (result.error) {
    showToast(result.error, 'error');
    return false;
  }
  return true;
}

/** 导出单条预设（列表页卡片上的「导出」） */
export async function exportPreset(id) {
  const preset = dialoguePresetById(id);
  if (!preset) {
    showToast('这个预设已经不在了', 'error');
    return;
  }
  const ok = await savePresetsToFile(
    [exportShape(preset)],
    `${safeFileName(preset.name)}.json`,
    '导出预设'
  );
  if (ok) showToast(`已导出「${preset.name}」`, 'ok');
}

/** 导出全部预设（页面右上角的「导出全部」） */
export async function exportAllPresets() {
  const list = dialoguePresets();
  if (!list.length) {
    showToast('还没有预设可以导出', 'error');
    return;
  }
  const ok = await savePresetsToFile(
    list.map(exportShape),
    'presets.json',
    '导出全部预设'
  );
  if (ok) showToast(`已导出 ${list.length} 个预设`, 'ok');
}

/** 导入：弹文件框 → 重发 id → 追加到库里 → 落盘 → 重绘 */
async function importPresets() {
  let result = null;
  try {
    result = await api.importPresets();
  } catch (err) {
    showToast((err && err.message) || '导入失败', 'error');
    return;
  }

  if (!result || result.canceled) return;

  const incoming = Array.isArray(result.presets) ? result.presets : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  if (!incoming.length) {
    showToast(errors.length ? errors[0] : '没有导入任何预设', 'error');
    return;
  }

  const fresh = reissuePresetIds(incoming);
  state.dialoguePresets = [...dialoguePresets(), ...fresh];

  renderPresetPage();
  rerender();
  const ok = await persistPresets();

  if (ok) {
    const names = fresh.map((p) => p.name).join('、');
    showToast(
      fresh.length === 1 ? `已导入「${names}」` : `已导入 ${fresh.length} 个预设：${names}`,
      'ok'
    );
  }

  if (errors.length) {
    console.warn('部分预设导入失败：', errors);
    setTimeout(() => showToast(errors[0], 'error'), 1600);
  }
}

/** 绑「导入 / 导出全部」两个按钮。rerender 由入口层注入。 */
export function initPresetIo(injected) {
  rerender = (injected && injected.rerender) || (() => {});

  if (el.btnImportPreset) el.btnImportPreset.addEventListener('click', importPresets);
  if (el.btnExportPresets) el.btnExportPresets.addEventListener('click', exportAllPresets);
}
