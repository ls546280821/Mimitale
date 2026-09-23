'use strict';

// ============================================================================
//  main/panel-fields.js —— 状态面板字段的「类型 / 范围 / 变化规则」
//
//  以前一个字段就是 {name, value} 两个字符串。问题是模型看不到任何约束：
//  卡里写着「好感度 0~100」，注入过去的也只有「好感度：50」——
//  模型写个 150 也没人拦，写个负数也没人拦。
//
//  这里给字段加上三样东西（都是**可选**的，老数据不受影响）：
//    · type   文本 text / 数值 meter / 列表 list
//    · min,max  数值的范围（只在 type=meter 时有意义）
//    · hint   给模型看的变化规则，原样注入，比如
//             「按本轮剧情在当前值基础上合理增减，单轮变化不超过 10」
//
//  ——这套形状是从一张真实导出的角色卡里学来的（那边的字段叫
//  {type:'meter', min:0, max:100, hint:'…'}），所以导入时能直接映射过来。
//
//  ⚠️ 这个文件必须**同时**能被两种环境加载（写法别乱改）：
//    · 主进程：require('./panel-fields.js') —— 走 CommonJS
//    · 渲染层：<script src="../main/panel-fields.js"> 之后读 window.PanelFields
//      （渲染层不能 import 它：CommonJS 文件在浏览器里没有具名导出，
//        会报 "does not provide an export named …"，实测踩过）
//  两种环境跑的是同一份代码，范围/规则的判断不会两边不一致。
//
//  ⚠️ 主进程（导入）和渲染层（编辑器、注入）必须用**同一份**这里。
//  分开写两份，早晚会漂 —— 角色属性以前就吃过这个亏。
// ============================================================================

const MAX_FIELD_NAME = 24;
const MAX_FIELD_VALUE = 500;
const MAX_FIELD_HINT = 200;
const MAX_FIELDS = 120;
// 分组名（面板标题）的长度上限。它是给人看的标题，不用太长。
const MAX_GROUP_TITLE = 24;

const FIELD_TYPES = ['text', 'meter', 'list'];

/** 一个字段值是不是「数字」或「数字/数字」这种分数写法 */
function parseNumericValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;

  // 50、50.5、-3
  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    return isFinite(n) ? { n, total: null, raw: text } : null;
  }

  // 50/100 —— 面板里最常见的写法，斜杠两边都是数字才算
  const m = text.match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  if (m) {
    const n = Number(m[1]);
    const total = Number(m[2]);
    if (isFinite(n) && isFinite(total)) return { n, total, raw: text };
  }

  return null;
}

/** 去掉多余的小数点：50.0 → 50，50.50 → 50.5 */
function trimNumber(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function clampNumber(n, min, max) {
  let out = n;
  if (typeof min === 'number' && isFinite(min)) out = Math.max(min, out);
  if (typeof max === 'number' && isFinite(max)) out = Math.min(max, out);
  return out;
}

/**
 * 把模型写的一个值夹回范围内，并保留它原来的写法。
 *
 *   clampFieldValue('150/100', {min:0,max:100})  →  { value: '100/100', clamped: true }
 *   clampFieldValue('-5/100',  {min:0,max:100})  →  { value: '0/100',   clamped: true }
 *   clampFieldValue('50/100',  {min:0,max:100})  →  { value: '50/100',  clamped: false }
 *   clampFieldValue('80',      {min:0,max:100})  →  { value: '80',      clamped: false }
 *   clampFieldValue('很累',    {min:0,max:100})  →  { value: '很累',     clamped: false }
 *
 * 解析不出数字就原样返回 —— 宁可不管，也不要因为模型写了个中文就把值抹掉。
 * 分母（/100 那部分）不动：它通常是这个字段的满值，改了反而怪。
 */
function clampFieldValue(value, field) {
  const text = String(value == null ? '' : value).trim();
  const f = field || {};
  if (f.type !== 'meter') return { value: text, clamped: false };

  const parsed = parseNumericValue(text);
  if (!parsed) return { value: text, clamped: false };

  const n = clampNumber(parsed.n, f.min, f.max);
  if (n === parsed.n) return { value: text, clamped: false };

  const out = parsed.total === null ? trimNumber(n) : `${trimNumber(n)}/${trimNumber(parsed.total)}`;
  return { value: out, clamped: true };
}

/**
 * 归一化一个字段定义。类型不认识就退回 text（而不是丢掉这个字段）——
 * 丢字段是静默失效，退类型至少还能用。
 */
function normalizePanelField(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_FIELD_NAME);
  if (!name) return null;

  const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';

  const field = {
    name,
    type,
    value: String(raw.value == null ? '' : raw.value).slice(0, MAX_FIELD_VALUE)
  };

  if (type === 'meter') {
    // 只认真正的数字；给不出范围就当它是个普通数值字段（仍会被夹吗？不会）——
    // 没有范围时 min/max 都不写，clampFieldValue 自然什么都不做。
    const min = Number(raw.min);
    const max = Number(raw.max);
    const hasMin = isFinite(min);
    const hasMax = isFinite(max);
    if (hasMin) field.min = min;
    if (hasMax) field.max = max;
    // 两个都有但写反了：换过来，别让范围变成空集
    if (hasMin && hasMax && field.min > field.max) {
      const t = field.min;
      field.min = field.max;
      field.max = t;
    }
  }

  const hint = String(raw.hint == null ? '' : raw.hint).trim().slice(0, MAX_FIELD_HINT);
  if (hint) field.hint = hint;

  // 分组：字段属于哪个命名面板。空 = 不分组（就是以前那种扁平清单）。
  const group = String(raw.group == null ? '' : raw.group).trim().slice(0, MAX_GROUP_TITLE);
  if (group) field.group = group;

  return field;
}

/**
 * 数值字段的「进度」——给界面画进度条用。
 *
 * 返回 { n, total, percent }，percent 是 0~100 的整数。
 * 算不出来就返回 null（调用方据此不画条）：
 *   · 不是数值字段 / 没有范围
 *   · 值里没有可用的数字
 * 分母的选取：优先用值里写的（60/100 就是 100），
 * 没有就用字段的 max —— 这样裸数字 60 也能画出条来。
 */
function fieldProgress(value, field) {
  const f = field || {};
  if (f.type !== 'meter') return null;

  const parsed = parseNumericValue(value);
  if (!parsed) return null;

  // 分母优先用值里写的（60/100 就是 100），没有就用字段的 max ——
  // 这样面板里存的是裸数字 60 时也能画出条来。
  const total = parsed.total !== null ? parsed.total : typeof f.max === 'number' ? f.max : null;
  if (total === null) return null;

  const base = typeof f.min === 'number' ? f.min : 0;
  const span = total - base;
  // 满值 == 下限（范围是个点）时没有「进度」可言，直接给 0 而不是除零
  if (!isFinite(span) || span === 0) return { n: parsed.n, total, percent: 0 };

  const percent = Math.max(0, Math.min(100, Math.round(((parsed.n - base) / span) * 100)));
  return { n: parsed.n, total, percent };
}

/**
 * 把字段按分组分桶，顺序保留。
 *
 * 返回 [{ id, title, fields }]。`id` 空串那一桶是「没分组的」，永远排在最后 ——
 * 不然零散字段会插在命名面板中间，看着像掉出来了。
 *
 * 分组是按**字段第一次出现的顺序**排的（不是字母序），这样界面上组的次序
 * 跟着你填的顺序走，符合直觉。
 */
function groupPanelFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const order = [];
  const buckets = new Map();

  for (const field of list) {
    if (!field) continue;
    const id = typeof field.group === 'string' ? field.group : '';
    if (!buckets.has(id)) {
      buckets.set(id, []);
      order.push(id);
    }
    buckets.get(id).push(field);
  }

  // 没分组的排到最后
  const named = order.filter((id) => id !== '');
  if (order.includes('')) named.push('');

  return named.map((id) => ({ id, title: id, fields: buckets.get(id) || [] }));
}

/** 归一化一组字段定义 */
function normalizePanelFields(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    const field = normalizePanelField(item);
    if (!field) continue;
    if (seen.has(field.name)) continue; // 重名只留第一个
    seen.add(field.name);
    out.push(field);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/** 字段在提示词里怎么描述自己 —— 范围 + 变化规则都在这 */
function describePanelField(field) {
  const f = field || {};
  const parts = [];

  if (f.type === 'meter') {
    if (typeof f.min === 'number' && typeof f.max === 'number') parts.push(`数值 ${f.min}~${f.max}`);
    else if (typeof f.max === 'number') parts.push(`数值（上限 ${f.max}）`);
    else if (typeof f.min === 'number') parts.push(`数值（下限 ${f.min}）`);
    else parts.push('数值');
  } else if (f.type === 'list') {
    parts.push('列表，多项用「、」隔开');
  }

  if (f.hint) parts.push(f.hint);

  return parts.join('；');
}

const PanelFields = {
  FIELD_TYPES,
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELD_HINT,
  MAX_FIELDS,
  MAX_GROUP_TITLE,
  parseNumericValue,
  clampNumber,
  trimNumber,
  clampFieldValue,
  normalizePanelField,
  normalizePanelFields,
  groupPanelFields,
  fieldProgress,
  describePanelField
};

// 主进程：标准 CommonJS 导出
if (typeof module !== 'undefined' && module.exports) module.exports = PanelFields;
// 渲染层：<script> 加载时挂到 window 上（上面注释里说明了为什么不能 import）
if (typeof window !== 'undefined') window.PanelFields = PanelFields;
