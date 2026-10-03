'use strict';

// ============================================================================
//  views/charExpressions.js —— 表情图编辑器（独立弹窗）
//
//  一张卡可以带几十张表情图，按回复正文里的名称 / 触发词 / <emo>键</emo> 自动切
//  （匹配规则在 data/expressions.js）。几十行塞进角色编辑表单会把下面的文字字段
//  整个挤没，所以单独开一个弹窗 —— 角色编辑器里只留一行「表情图 · 已设 N 条 · 管理」。
//
//  ★ 和其他视图模块一样：它**不持有**草稿，而是接收一份（`getList()` 拿）。
//    那份草稿的所有者是角色编辑器（保存时要跟表单一起写回角色卡），
//    让它自己存一份就得来回同步 —— 传引用、就地改，两边看到的永远是同一份。
//    草稿一变就调 `onChange`，由角色编辑器刷新入口那行摘要。
// ============================================================================

import { el } from '../core/dom.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { pickAndCrop, cropTopToDataUrl } from '../ui/imageCrop.js';
import { MAX_EXPRESSIONS } from '../data/expressions.js';

// 表情图输出 640×640（1:1）。状态卡上那张图铺满是 320px 宽，2 倍屏正好 640 ——
// 再大就只是把同一份信息摊得更糊、文件更大（一套差分二十几张，体积是实打实的成本：
// 640 比 720 省掉四分之一，22 张差 0.4M 字符）。
// ⚠️ 改比例要同时改 style.css 的 .sc-photo（两处不一致图就会被拉扁）。
const EXPRESSION_WIDTH = 640;
const EXPRESSION_RATIO = 1;

/**
 * 情绪词典：文件名里的英文键 → 中文名。
 *
 * 批量导入时从文件名认情绪（`Char_A3_shy_transparent.png` → shy → 害羞），
 * 认出来的词同时当**情绪键**存进 expression.key（<emo>shy</emo> 就是按它对）。
 * 词典之外的词不硬猜，退回用文件名当名字，让人自己改。
 *
 * ⚠️ 一套立绘差分的划分比基础词细得多（坏笑 / 脸红别脸 / 隐忍 / 事后…）。
 *    这里少一个键，那张图导进来就叫「Char_C1_flustered_transparent」——
 *    看着像「没识别出情绪」。加词的成本很低，别省。
 */
const EMOTION_LABELS = {
  neutral: '平静',
  smile: '微笑',
  happy: '开心',
  shy: '害羞',
  blush: '脸红',
  embarrassed: '尴尬',
  confused: '困惑',
  surprised: '惊讶',
  shocked: '震惊',
  scared: '害怕',
  panicked: '慌张',
  sad: '难过',
  cry: '哭泣',
  teary: '委屈',
  angry: '生气',
  annoyed: '烦躁',
  disgusted: '厌恶',
  helpless: '无奈',
  serious: '认真',
  determined: '坚定',
  proud: '得意',
  smug: '骄傲',
  blank: '发呆',
  dazed: '迷离',
  trance: '出神',
  sleepy: '犯困',
  tipsy: '微醺',
  hopeful: '期待',
  excited: '兴奋',
  aching: '心疼',
  curious: '好奇',
  worried: '担忧',
  relaxed: '放松',
  calm: '平静',
  love: '爱慕',
  wink: '眨眼',

  // 差分集细化下来的词。基础那版没有这些，批量导入时整批退回文件名当名字。
  disgust: '嫌弃',
  smirk: '坏笑',
  cold: '冷漠',
  tired: '疲惫',
  relieved: '安心',
  flustered: '脸红别脸',
  panting: '喘气',
  resist: '抗拒',
  defiant: '挑衅',
  pleading: '求饶',
  enduring: '隐忍',
  afterglow: '事后',
  clingy: '撒娇',
  sulky: '赌气',
  moved: '感动',
  jealous: '嫉妒',
  apologetic: '道歉',
  thankful: '感谢',
  peeking: '偷看',
  uneasy: '不安'
};

/**
 * 中文情绪词 → 情绪键：给中文文件名的图用（`Char_害羞_透明.png`）。
 *
 * 上面那张表里的中文名会自动反查进来（害羞 → shy），这里只补常见同义词。
 * 只收两个字以上的词 —— 单字太容易在无关文件名里误伤。
 */
const EMOTION_CN_ALIASES = {
  冷静: 'calm',
  镇定: 'calm',
  平和: 'calm',
  浅笑: 'smile',
  高兴: 'happy',
  快乐: 'happy',
  愉快: 'happy',
  喜悦: 'happy',
  羞怯: 'shy',
  羞涩: 'shy',
  腼腆: 'shy',
  娇羞: 'shy',
  潮红: 'blush',
  绯红: 'blush',
  窘迫: 'embarrassed',
  难为情: 'embarrassed',
  疑惑: 'confused',
  不解: 'confused',
  迷惑: 'confused',
  吃惊: 'surprised',
  诧异: 'surprised',
  惊奇: 'surprised',
  骇然: 'shocked',
  恐惧: 'scared',
  畏惧: 'scared',
  慌乱: 'panicked',
  惊惶: 'panicked',
  伤心: 'sad',
  悲伤: 'sad',
  低落: 'sad',
  失落: 'sad',
  流泪: 'cry',
  痛哭: 'cry',
  落泪: 'cry',
  含泪: 'teary',
  泛泪: 'teary',
  眼红: 'teary',
  愤怒: 'angry',
  恼怒: 'angry',
  气愤: 'angry',
  不耐烦: 'annoyed',
  厌烦: 'annoyed',
  厌恶: 'disgusted',
  鄙夷: 'disgusted',
  无语: 'helpless',
  苦笑: 'helpless',
  严肃: 'serious',
  正经: 'serious',
  坚毅: 'determined',
  决然: 'determined',
  自豪: 'proud',
  自满: 'smug',
  放空: 'blank',
  呆滞: 'blank',
  恍惚: 'dazed',
  茫然: 'dazed',
  失神: 'trance',
  出神: 'trance',
  困倦: 'sleepy',
  瞌睡: 'sleepy',
  醉意: 'tipsy',
  微醉: 'tipsy',
  期盼: 'hopeful',
  盼望: 'hopeful',
  激动: 'excited',
  雀跃: 'excited',
  心痛: 'aching',
  心酸: 'aching',
  担忧: 'worried',
  忧虑: 'worried',
  焦虑: 'worried',
  松弛: 'relaxed',
  惬意: 'relaxed',
  喜欢: 'love',
  心动: 'love',
  迷恋: 'love',

  // 细化那批词的同义说法（正名在上面的表里，这里补中文文件名的常见写法）
  担心: 'worried',
  乏力: 'tired',
  疲乏: 'tired',
  倦怠: 'tired',
  冷淡: 'cold',
  冰冷: 'cold',
  漠然: 'cold',
  放心: 'relieved',
  释然: 'relieved',
  喘息: 'panting',
  气促: 'panting',
  抵触: 'resist',
  反抗: 'resist',
  哀求: 'pleading',
  恳求: 'pleading',
  忍耐: 'enduring',
  强忍: 'enduring',
  余韵: 'afterglow',
  黏人: 'clingy',
  缠人: 'clingy',
  别扭: 'sulky',
  闹别扭: 'sulky',
  触动: 'moved',
  吃醋: 'jealous',
  醋意: 'jealous',
  抱歉: 'apologetic',
  愧疚: 'apologetic',
  歉意: 'apologetic',
  感激: 'thankful',
  致谢: 'thankful',
  偷瞄: 'peeking',
  窥视: 'peeking',
  忐忑: 'uneasy',
  心慌: 'uneasy',
  奸笑: 'smirk',
  嫌恶: 'disgust',
  局促: 'flustered'
};

/** 中文词 → 情绪键的查表。正名先注册（'平静' 归 neutral），别名补空位，别名词不许指向没见过的键 */
const EMOTION_CN_LOOKUP = (() => {
  const map = new Map();
  const put = (word, key) => {
    if (word.length < 2 || map.has(word) || !EMOTION_LABELS[key]) return;
    map.set(word, key);
  };
  for (const [key, name] of Object.entries(EMOTION_LABELS)) put(name, key);
  for (const [word, key] of Object.entries(EMOTION_CN_ALIASES)) put(word, key);
  return map;
})();

/**
 * 文件名里的「情绪键」。
 *
 * 英文按非字母数字切段逐段比词典，取最长的一段（'blush' 比 'sh' 靠谱）；
 * 中文没空格可切，直接在整串里找词典里的中文词，同样取最长的。
 * 两种都认不出返回 null —— 调用方会退回「拿文件名当名字」。
 *
 * 导出是给冒烟用的：词典漏一个键，导入时就有一张图变成「文件名当名字」，
 * 而那正是最容易被忽略的坏结果 —— 图进来了，名字却是乱码一样的原文件名。
 */
export function emotionFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();

  let best = '';
  for (const token of base.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (!EMOTION_LABELS[token]) continue;
    if (token.length > best.length) best = token;
  }
  if (best) return { key: best, name: EMOTION_LABELS[best] };

  let bestCn = '';
  let cnKey = '';
  for (const [word, key] of EMOTION_CN_LOOKUP) {
    if (word.length > bestCn.length && base.includes(word)) {
      bestCn = word;
      cnKey = key;
    }
  }
  return cnKey ? { key: cnKey, name: EMOTION_LABELS[cnKey] } : null;
}

/** 文件名去掉扩展名，当认不出情绪时的兜底名字 */
function nameFromFileName(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '').trim().slice(0, 24);
}

/** 触发词框里的一行文本 → 词表（逗号分隔，中英文逗号都认） */
function parseKeywords(text) {
  return String(text || '')
    .split(/[,，]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** 表情草稿的深拷贝。直接引用卡上那份的话，改到一半关掉编辑器也会留下改动 */
export function draftExpressionsOf(character) {
  const list = character && Array.isArray(character.expressions) ? character.expressions : [];
  return list.map((item) => ({
    name: String((item && item.name) || ''),
    keywords: Array.isArray(item && item.keywords) ? item.keywords.map(String) : [],
    key: String((item && item.key) || ''),
    default: item && item.default === true,
    image: String((item && item.image) || '')
  }));
}

// ---------------------------------------------------------------------------
//  草稿的持有者是角色编辑器 —— 这里只通过 getDraft() 拿，改完通知它刷摘要
// ---------------------------------------------------------------------------

let getDraft = () => [];
let notifyChange = () => {};

const draft = () => {
  const list = getDraft();
  return Array.isArray(list) ? list : [];
};

/** 角色编辑器入口那行的摘要文案 */
export function expressionsSummaryText(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '还没有表情图';
  return `已设 ${items.length} 条`;
}

/** 一条表情 = 缩略图（点击换图）+ 名称 + 触发词 + 删除 */
function buildExpressionRow(expr, index) {
  const thumb = h('button', {
    type: 'button',
    class: 'char-expr-thumb art-edge',
    title: '点击上传这张表情的图',
    ariaLabel: `上传「${expr.name || '这条表情'}」的图`,
    onClick: () => pickExpressionImage(index)
  });
  if (expr.image) thumb.appendChild(h('img', { src: expr.image, alt: '' }));
  else thumb.appendChild(h('span', { class: 'char-avatar-empty', text: '点击上传' }));

  // 打字时**不重绘**（重绘会重建输入框、光标就跑了），直接写进草稿那一项。
  const nameInput = h('input', {
    type: 'text',
    class: 'char-expr-name',
    value: expr.name,
    spellcheck: 'false',
    placeholder: '名称（如 害羞）',
    ariaLabel: '表情名'
  });
  nameInput.addEventListener('input', () => {
    const item = draft()[index];
    if (item) item.name = nameInput.value;
  });

  const keysInput = h('input', {
    type: 'text',
    class: 'char-expr-keys',
    value: expr.keywords.join(', '),
    spellcheck: 'false',
    placeholder: '触发词，逗号分隔（可不填）',
    ariaLabel: '触发词'
  });
  keysInput.addEventListener('input', () => {
    const item = draft()[index];
    if (item) item.keywords = parseKeywords(keysInput.value);
  });

  // 默认脸：没命中任何情绪时显示这张。整张卡只能有一个，所以是单选按钮
  // 而不是复选框 —— 点一下自动把别的清掉，不会出现两个「兜底脸」。
  const defaultBtn = button({
    type: 'button',
    class: `char-expr-default${expr.default ? ' is-on' : ''}`,
    text: expr.default ? '★' : '☆',
    title: expr.default
      ? '这是默认脸：没命中任何情绪时显示这张。再点一下取消'
      : '设为默认脸：没命中任何情绪时显示这张',
    onClick: () => toggleDefaultExpression(index)
  });

  return h(
    'div',
    { class: 'char-expr-row' },
    thumb,
    h('div', { class: 'char-expr-fields' }, nameInput, keysInput),
    defaultBtn,
    button({
      class: 'char-expr-del',
      text: '✕',
      title: '删掉这条表情',
      onClick: () => removeExpression(index)
    })
  );
}

function updateExprCount(items) {
  if (!el.exprCount) return;
  el.exprCount.textContent = `${items.length} / ${MAX_EXPRESSIONS}`;
}

/** 铺表情列表（列表行 + 计数 + 按钮可用性）。列表不需要滚动定位，直接整片重建 */
export function renderCharExpressions(list) {
  const host = el.charExprList;
  if (!host) return;
  clear(host);

  const items = Array.isArray(list) ? list : [];

  if (!items.length) {
    host.appendChild(
      h('div', {
        class: 'char-expr-empty',
        text: '还没有表情图。加一条，名称写「害羞」、触发词写「脸红」试试。'
      })
    );
  } else {
    items.forEach((expr, index) => host.appendChild(buildExpressionRow(expr, index)));
  }

  const full = items.length >= MAX_EXPRESSIONS;
  if (el.btnAddExpr) el.btnAddExpr.disabled = full;
  if (el.btnBatchExpr) el.btnBatchExpr.disabled = full;
  updateExprCount(items);
}

/** 草稿变过之后：重铺列表 + 通知角色编辑器刷新入口摘要 */
function refresh() {
  renderCharExpressions(draft());
  notifyChange();
}

function addExpression() {
  const list = draft();
  if (list.length >= MAX_EXPRESSIONS) return;
  list.push({ name: '', keywords: [], image: '' });
  refresh();
  // 加完直接落在名称框上，省得再点一下
  const input = el.charExprList && el.charExprList.querySelector('.char-expr-row:last-child .char-expr-name');
  if (input) input.focus();
}

function removeExpression(index) {
  const list = draft();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  // 删掉之后所有行都要重建（下标全变了）
  refresh();
}

/** 把某一条设成「默认脸」，其余全清（再点一下取消） */
function toggleDefaultExpression(index) {
  const list = draft();
  const target = list[index];
  if (!target) return;
  const wasOn = target.default === true;
  for (const expr of list) delete expr.default;
  if (!wasOn) target.default = true;
  refresh();
}

/**
 * 批量导入一整个文件夹的表情差分。
 *
 * 一次导入二十几张，所以不做「逐张开裁剪浮层」——直接按状态卡那块画幅
 * **顶部对齐自动裁**（cropTopToDataUrl）。情绪从文件名认（shy → 害羞，中英文都认），
 * 认出来的一并当情绪键存下，模型的 <emo>shy</emo> 就是按它对。
 */
async function batchImportExpressions() {
  const btn = el.btnBatchExpr;
  if (!btn) return;

  const list = draft();
  const room = MAX_EXPRESSIONS - list.length;
  if (room <= 0) {
    showToast(`表情图最多 ${MAX_EXPRESSIONS} 张，先删几条再导`, 'error');
    return;
  }

  let picked;
  try {
    picked = await api.pickImages({ directory: true, title: '选择放着表情图的文件夹' });
  } catch (err) {
    showToast((err && err.message) || '选择文件夹失败', 'error');
    return;
  }
  if (!picked || picked.canceled || !picked.files.length) return;

  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.disabled = true;

  // 已经有的情绪键不重复导（同一个文件夹导第二遍时整批跳过，不会存两套）
  const existingKeys = new Set(
    list.map((expr) => String(expr.key || '').toLowerCase()).filter(Boolean)
  );

  let added = 0;
  let failed = 0;
  let dupe = 0;
  let overflow = 0;

  for (let i = 0; i < picked.files.length; i += 1) {
    const file = picked.files[i];
    btn.textContent = `导入中 ${i + 1}/${picked.files.length}…`;

    const emotion = emotionFromFileName(file.name);
    if (emotion && existingKeys.has(emotion.key)) {
      dupe += 1;
      continue;
    }
    if (added >= room) {
      overflow += 1;
      continue;
    }

    try {
      const read = await api.readImage(file.path);
      if (!read || !read.dataUrl) throw new Error((read && read.error) || '读不出来');

      const image = await cropTopToDataUrl(read.dataUrl, {
        aspect: EXPRESSION_RATIO,
        outWidth: EXPRESSION_WIDTH
      });

      list.push({
        name: emotion ? emotion.name : nameFromFileName(file.name),
        key: emotion ? emotion.key : '',
        keywords: [],
        default: false,
        image
      });
      if (emotion) existingKeys.add(emotion.key);
      added += 1;
    } catch (err) {
      failed += 1;
    }
  }

  btn.disabled = false;
  btn.textContent = label;
  refresh();

  const bits = [`导入 ${added} 张`];
  if (dupe) bits.push(`跳过 ${dupe} 张已有的`);
  if (failed) bits.push(`${failed} 张读不出来`);
  if (overflow) bits.push(`超出上限 ${overflow} 张没导`);
  showToast(added ? `${bits.join('，')}。记得点「保存角色」` : bits.join('，'), added ? 'ok' : 'error');
}

async function pickExpressionImage(index) {
  const item = draft()[index];
  if (!item) return;

  // 没有名字的条目匹配不上任何东西，存下去等于白存 —— 先让他起个名再传图
  if (!String(item.name || '').trim()) {
    showToast('先给这条表情起个名字（名字本身就是触发词）', 'error');
    return;
  }

  const cropped = await pickAndCrop({
    aspect: EXPRESSION_RATIO,
    outWidth: EXPRESSION_WIDTH,
    title: '裁剪表情图',
    hint: '状态卡上铺的就是这一块',
    pickTitle: '选一张表情图'
  });
  if (!cropped) return;

  const target = draft()[index];
  if (!target) return;
  target.image = cropped;
  refresh();
  showToast('表情图已换上，记得点「保存角色」', 'ok');
}

// ---------------------------------------------------------------------------
//  弹窗开关
// ---------------------------------------------------------------------------

// Esc 监听只在弹窗开着时挂着；用捕获阶段 + stopPropagation，
// 免得入口层那条 Esc 链顺手把底下的角色编辑器也一起关了。
let escHandler = null;

export function openCharExpressionsEditor() {
  if (!el.exprModal) return;
  renderCharExpressions(draft());
  el.exprModal.classList.remove('hidden');

  escHandler = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeCharExpressionsEditor();
  };
  document.addEventListener('keydown', escHandler, true);
}

export function closeCharExpressionsEditor() {
  if (el.exprModal) el.exprModal.classList.add('hidden');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }
}

/**
 * 绑弹窗上的按钮。草稿是角色编辑器的，所以通过 getList 拿；
 * 草稿一变就调 onChange，让编辑器刷新入口那行摘要。
 */
export function initCharExpressionsUi({ getList, onChange } = {}) {
  if (typeof getList === 'function') getDraft = getList;
  if (typeof onChange === 'function') notifyChange = onChange;

  if (el.btnAddExpr) el.btnAddExpr.addEventListener('click', addExpression);
  if (el.btnBatchExpr) el.btnBatchExpr.addEventListener('click', batchImportExpressions);
  if (el.btnCloseExpr) el.btnCloseExpr.addEventListener('click', closeCharExpressionsEditor);
  if (el.btnExprDone) el.btnExprDone.addEventListener('click', closeCharExpressionsEditor);
  if (el.exprModal) {
    el.exprModal.addEventListener('click', (event) => {
      if (event.target === el.exprModal) closeCharExpressionsEditor();
    });
  }
}
