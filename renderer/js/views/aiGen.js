'use strict';

// ============================================================================
//  views/aiGen.js —— 「让 AI 生成一个角色」
//
//  两个入口共用这一个弹窗，差别只在喂给模型的上下文：
//    · 角色库入口（scope='library'）—— 只给用户写的那段描述，通用型角色
//    · 世界书入口（scope='worldbook'）—— 额外给这本书的名称、开场白、
//      按描述筛出来的条目、以及已有的副本名单。生成的是这个世界里的 NPC
//      （酒馆的小二、咖啡店的老板娘这种），名字和用词要跟世界观对得上。
//
//  生成完**不落盘**：把字段交给角色编辑器，让它开一份新草稿（和点「新建角色」
//  是同一条路）。用户看过、改过、点「保存角色」之后才真正进角色库 / 这本书。
//
//  调用模型走 window.mimitale.sendChat —— 和聊天共用一条通道，所以设置里配的
//  任意服务商都能用。**不要用 data/messages.js 的 buildApiMessages**：那条路会
//  带上对话历史、世界书命中、状态栏规则，那是给「继续聊天」用的，拿来写生成
//  任务是错的。
//
//  本机桥接（type='tavern-bridge'）要走它自己的解包：桥接的 /chat_with_image
//  返回的是 { text, image }，文字在 text 里，不在 OpenAI 那种 choices[].message 上。
//  桥接还会按正文里的关键词和语义判断该不该配图 —— 生成角色时那是纯浪费
//  （出图要 30~40 秒、还要占显存），所以生成期间 force_image 一律关掉。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid } from '../core/util.js';
import { h } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { currentEndpoint, isBridgeProvider } from '../data/providers.js';
import { worldbookCharacters } from '../data/library.js';

// ---------------------------------------------------------------------------
//  提示词
// ---------------------------------------------------------------------------

// 属性表的变化规则。措辞和产品里那条约定保持一致：
// 「平时不变，但一旦发生变化就必须输出」—— 写成「只在变化时输出」，模型会自己
// 判断「这轮没变」然后把整行省掉，状态栏就再也不更新了。
const MODE_RULE = 'mode 用 static 表示平时几乎不动的（身高、体重、身份这类），' +
  '用 dynamic 表示会随剧情变动的（好感度、金钱、穿着这类）——' +
  'dynamic 的字段一旦这一轮发生了跟它有关的事就必须输出。拿不准就写 dynamic。';

// 生成结果的字段契约。字段名必须和 main/characters.js 的 normalizeCharacter
// 白名单对得上 —— 多写的字段存盘时会被静默丢掉，等于白生成。
// attributes 里那几个键也和 main/panel-fields.js 的词表对齐（见 parseAttrs）。
const FIELDS_SPEC = `严格按照下面的 JSON 结构输出，不要输出任何多余的文字、解释或 Markdown 代码块标记：

{
  "name": "角色名",
  "description": "角色描述，交代身份、外貌、年龄、处境。第三人称",
  "personality": "性格、说话方式、立场、与玩家的关系",
  "tags": ["标签", "标签"],
  "attributes": [
    { "name": "字段名", "type": "text", "value": "初始值", "mode": "dynamic" }
  ]
}

attributes 给 3~8 条，每条包含 name / type / value / mode 四个键。
type 只能是 text（文字）、meter（数值，可另带 min / max）、list（多项用「、」隔开）三种。
${MODE_RULE}
字段名要贴合这个角色的身份，别用泛泛的「属性1」。`;

const LIBRARY_SYSTEM = `你是一位角色设定师，负责把一个简短的描述扩写成一张完整的角色卡。

${FIELDS_SPEC}

要求：
· 描述和性格要具体、有细节，能让人一眼记住这个角色；不要写空泛的赞美词
· 先想清楚这个角色**处在什么世界、什么基调里**，再动笔 —— 描写用词要和那个基调一致
  （日常治愈、黑暗奇幻、现代都市的写法完全不同）
· 只输出 JSON 本身`;

/**
 * 用户手填的「背景 / 基调」（角色库那侧的可选输入）。
 *
 * 为什么给角色库加、不给世界书加：世界书那侧**本身就有大纲** ——
 * 书的条目 + 开场白会一起喂进去（见 buildBookContext），再让用户手写一份
 * 只会和条目内容打架。而角色库那侧没有这层上下文，模型只能靠一句描述
 * 自己脑补世界观，写出来容易飘 —— 这个框补的就是那层缺口。
 *
 * 做成可选：不填就整段不注入，提示词和以前一字不差。
 */
function briefSection(brief) {
  const text = String(brief || '').trim();
  if (!text) return '';
  return `\n\n【背景 / 基调】\n${text.slice(0, 1000)}\n\n角色的设定必须贴合上面这个背景，不要另起一套世界观。`;
}

/**
 * 世界书模式下额外要遵守的规则。
 *
 * 「前 160 字」不是随便定的：副本进 GM 名单时，description + personality
 * 合计只取前 160 字（见 data/cast.js 的 worldbookCast），写满了才不会被截掉。
 */
const BOOK_SYSTEM_TAIL = `这是一位要在「世界」里出场的配角（NPC），不是主角。

要求：
· 先写**已有的角色名单**和世界设定，新角色要和它们区分开，不要重复或改写已有的人，
  也不要生成「玩家自己」
· **description 和 personality 加起来的前 160 字必须写全最重要的信息**
  （身份、立场、说话方式、和玩家的关系）—— 超出部分在注入时会被截掉
· attributes 写这个角色身上会变的东西（好感度、钱、状态这类），3~8 条就够
· 只输出 JSON 本身`;

// 条目总量上限：世界书单本最多 5000 条，全喂进去光输入就爆了。
// 按用户描述里的字命中哪些条目，命中不了就取排在前面的常驻条。
const MAX_ENTRY_CHARS = 2400;
const MAX_ENTRY_COUNT = 12;

/** 一段文字里能用来匹配的关键词：按标点和空白切开，去掉太短的碎片 */
function keywordsOf(text) {
  return String(text || '')
    .split(/[\s,，、。.；;：:！!？?（）()【】\[\]"'“”‘’]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 30);
}

/**
 * 挑出跟这段描述相关的条目。
 *
 * 刻意不 import main/worldbook-match.js —— 那是主进程的模块，渲染层读不到。
 * 这里只要「大致相关」，精确度不重要：命不中就退化成取前几条，反正用户还会自己改。
 */
function pickEntries(book, prompt, budget) {
  const entries = (Array.isArray(book.entries) ? book.entries : []).filter(
    (e) => e && e.enabled !== false && String(e.content || '').trim()
  );
  if (!entries.length) return [];

  const words = keywordsOf(prompt);
  const score = (entry) => {
    const title = String(entry.title || '');
    const content = String(entry.content || '');
    let hits = entry.constant === true ? 1 : 0;
    for (const w of words) {
      if (title.includes(w)) hits += 3;
      if (content.includes(w)) hits += 1;
    }
    return hits;
  };

  const ranked = entries
    .map((entry, index) => ({ entry, index, hits: score(entry) }))
    .sort((a, b) => (b.hits - a.hits) || (a.index - b.index));

  const out = [];
  for (const item of ranked) {
    if (item.hits <= 0 && out.length) break;
    out.push(item.entry);
    if (out.length >= MAX_ENTRY_COUNT) break;
  }

  // 按预算截断：从头累积，放不下最后一条就整体不要 —— 半条正文比没有更糟
  const picked = [];
  let used = 0;
  for (const entry of out) {
    const text = `【${entry.title}】\n${String(entry.content).trim()}`;
    if (used + text.length > budget) break;
    picked.push(text);
    used += text.length;
  }
  return picked;
}

/** 世界书模式下的设定块：书名 + 开场白 + 相关条目 + 已有角色 */
function buildBookContext(book, prompt) {
  const parts = [`【世界：${book.name}】`];

  const opening = String(book.opening || '').trim();
  if (opening) parts.push(`【开场白】\n${opening.slice(0, 800)}`);

  const copies = worldbookCharacters(book);
  if (copies.length) {
    const names = copies.map((c) => c.name).filter(Boolean).join('、');
    parts.push(`【这个世界已有的角色】\n${names}\n请生成一个和上面这些人都不同的新角色。`);
  }

  const entries = pickEntries(book, prompt, MAX_ENTRY_CHARS);
  if (entries.length) parts.push(`【世界设定】\n${entries.join('\n\n')}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
//  取模型返回的正文
// ---------------------------------------------------------------------------

/**
 * 从响应里取出模型写的正文。
 *
 * ⚠️ 两种形状不一样，别写成一回事：
 *   · OpenAI 兼容：主进程的 streamChat 已经把 choices[].message.content 收成
 *     平铺的 `content` 了（见 main/http.js 的 resolve）。
 *   · 本机桥接：桥接的 /chat 与 /chat_with_image 都返回 `{ text, image }`，
 *     正文在 `text` 上。
 * 以前这里是照着原始 OpenAI 响应写的（去读 choices 数组），而 IPC 根本不会
 * 把那一层递过来 —— 结果正文永远是空串，生成出来永远是「未命名角色」。
 */
function responseText(response, bridge) {
  if (!response) return '';
  if (bridge) return String(response.text || '');
  return typeof response.content === 'string' ? response.content : '';
}

// ---------------------------------------------------------------------------
//  解析模型输出
// ---------------------------------------------------------------------------

/** 去掉 ```json 围栏和正文前后的解释文字，只留下最外面那个花括号块 */
function extractJsonBlock(raw) {
  let text = String(raw || '').trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  return text;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 标签：字符串数组，逗号串也收（模型偶尔会写成 "治愈, 日常"） */
function parseTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、]/)
      : [];
  return list
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim().slice(0, 40))
    .slice(0, 20);
}

/**
 * 属性：只留 normalizePanelField 认得的键，形状不对的整条丢掉。
 *
 * ⚠️ 类型和 change 频率的词表**必须**和 main/panel-fields.js 对齐：
 *   · type 只有 text / meter / list —— 没有 'number'。数值字段是 'meter'，
 *     写成 number 会被归一化器退回 'text'，数字就变成字符串了。
 *   · mode 只有 dynamic / static，而且 **dynamic 是默认值** ——
 *     存储时会被省掉那个键（见 normalizePanelField 的 `mode !== DEFAULT`）。
 *     所以这里也不用写出来，让它走默认即可。
 * 模型有时候会把 type 写成 number，所以两种写法都收，统一映射到 meter。
 */
function parseAttrs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = str(item.name, 40).trim();
    if (!name) continue;
    if (out.some((a) => a.name === name)) continue;

    const rawType = String(item.type || '').toLowerCase();
    const type = rawType === 'number' || rawType === 'meter' ? 'meter' : rawType === 'list' ? 'list' : 'text';
    const value0 = item.value;
    const fieldValue =
      type === 'text' && typeof value0 !== 'string' ? String(value0 == null ? '' : value0) : value0;

    const field = { name, type, value: fieldValue == null ? '' : fieldValue };
    // 数字字段的范围：模型给了就带上，没给就算了（归一化器两种都收）
    if (type === 'meter') {
      if (Number.isFinite(Number(item.max))) field.max = Number(item.max);
      if (Number.isFinite(Number(item.min))) field.min = Number(item.min);
    }
    // 「几乎不动」才值得标出来；dynamic 是默认，不写
    if (item.mode === 'static') field.mode = 'static';

    out.push(field);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * 把模型输出解析成角色字段。
 *
 * @returns {{ok: true, fields: object} | {ok: false, error: string, raw: string}}
 *          解析失败时把原文一起带出去，让调用方决定怎么兜底 ——
 *          生成一次要几十秒，不能因为多了一行解释就整块丢掉。
 */
export function parseGeneratedCharacter(raw) {
  const text = extractJsonBlock(raw);
  if (!text) return { ok: false, error: '模型没有返回内容', raw: String(raw || '') };

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: '模型返回的不是合法 JSON', raw: String(raw || '') };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: '模型返回的结构不对', raw: String(raw || '') };
  }

  const name = str(json.name, 120).trim();
  const description = str(json.description, 20000);
  const personality = str(json.personality, 10000);
  // 名字和描述都空 = 这次生成没有可用内容，让调用方按失败处理
  if (!name && !description.trim()) {
    return { ok: false, error: '模型没有给出可用的角色内容', raw: String(raw || '') };
  }

  return {
    ok: true,
    fields: {
      name: name || '未命名角色',
      description,
      personality,
      tags: parseTags(json.tags),
      attributes: parseAttrs(json.attributes)
    }
  };
}

// ---------------------------------------------------------------------------
//  弹窗
// ---------------------------------------------------------------------------

let layerEl = null;  // 整个浮层
let nodes = null;    // 里面要反复用到的节点
let busy = false;    // 正在生成（防重复点、控制按钮状态）
let scope = 'library';
let targetBook = null;

/** 由 main.js 注入：把生成出来的字段开成一份新草稿。
 *  兜底那版只是防「还没接线就被调用」—— 真走到那里等于白生成，所以会报错提示。 */
let startDraft = () => {
  console.error('[aiGen] startDraft 还没接线，生成的内容没法交出去');
  return false;
};

export function initAiGen(opts = {}) {
  if (typeof opts.startDraft === 'function') startDraft = opts.startDraft;
}


function bookFor(id) {
  const list = Array.isArray(state.worldbooks) ? state.worldbooks : [];
  return list.find((w) => w.id === id) || null;
}

/**
 * 打开生成弹窗。
 * @param {object} options
 * @param {'library'|'worldbook'} options.scope
 * @param {string} [options.bookId] 世界书模式下要依据哪本书
 */
export function openAiGenModal(options = {}) {
  scope = options.scope === 'worldbook' ? 'worldbook' : 'library';
  targetBook = scope === 'worldbook' ? bookFor(options.bookId) : null;

  if (scope === 'worldbook' && !targetBook) {
    showToast('找不到这本书，先在世界书列表里打开它', 'error');
    return;
  }

  buildLayer();
  document.body.appendChild(layerEl);

  if (nodes.prompt) nodes.prompt.value = '';
  if (nodes.brief) nodes.brief.value = '';
  if (nodes.status) {
    nodes.status.textContent =
      scope === 'worldbook' ? `将依据《${targetBook.name}》的设定生成 NPC` : '把你想做的角色大致描述一下就行';
  }
  updateButtons();

  nodes.prompt.focus();
}

function updateButtons() {
  if (!nodes) return;
  if (nodes.go) {
    nodes.go.disabled = busy;
    nodes.go.textContent = busy ? '生成中…' : '开始生成';
  }
  // 中止按钮只在生成期间出现
  if (nodes.stop) nodes.stop.classList.toggle('hidden', !busy);
}

function closeLayer() {
  // 生成期间关掉等于放弃这次结果，先中止请求
  if (busy) stopGen();
  if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
  layerEl = null;
  nodes = null;
}

function buildLayer() {
  layerEl = h('div', { class: 'modal ai-gen-modal' });

  const prompt = h('textarea', {
    id: 'ai-gen-prompt',
    rows: '5',
    spellcheck: 'false',
    placeholder:
      scope === 'worldbook'
        ? '例如：酒馆里跑堂的小二，嘴碎爱偷听客人讲话；或者咖啡店的老板娘，性子冷淡但记得每个熟客的口味'
        : '例如：一只在图书馆值夜班的猫，说话爱绕弯子，喜欢用比喻'
  });

  // 「背景 / 基调」：只有角色库那侧才有（世界书那侧已经有条目 + 开场白当大纲了）
  const brief = scope === 'library'
    ? h('textarea', {
        id: 'ai-gen-brief',
        rows: '2',
        spellcheck: 'false',
        placeholder: '可选。例如：现代都市的深夜便利店；或者中世纪魔法学院。不填就由 AI 自己定'
      })
    : null;

  const status = h('p', { class: 'ai-gen-status' });

  const stopBtn = h('button', { class: 'btn btn-ghost', text: '中止', type: 'button' });
  stopBtn.addEventListener('click', stopGen);
  stopBtn.classList.add('hidden');

  const goBtn = h('button', { class: 'btn btn-primary', text: '开始生成', type: 'button' });
  goBtn.addEventListener('click', generate);

  const card = h(
    'div',
    { class: 'modal-card ai-gen-card' },
    h(
      'header',
      { class: 'modal-head' },
      h(
        'div',
        { class: 'modal-heading' },
        h('h2', { text: scope === 'worldbook' ? 'AI 生成 NPC' : 'AI 生成角色' }),
        h('p', {
          class: 'modal-sub',
          text:
            scope === 'worldbook'
              ? '按这本书的设定生成一个配角，生成完还可以自己改'
              : '描述一下你想要的角色，AI 补全成一张角色卡'
        })
      ),
      (() => {
        const btn = h('button', { class: 'icon-btn', type: 'button', title: '关闭（Esc）', 'aria-label': '关闭' });
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>';
        btn.addEventListener('click', closeLayer);
        return btn;
      })()
    ),
    h(
      'div',
      { class: 'modal-body ai-gen-body' },
      brief
        ? h(
            'label',
            { class: 'field field-stack' },
            h('span', { class: 'field-label', text: '背景 / 基调（可选）' }),
            brief
          )
        : null,
      h(
        'label',
        { class: 'field field-stack' },
        h('span', { class: 'field-label', text: '角色描述' }),
        prompt
      ),
      status
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('span', { class: 'foot-hint', text: '生成结果会填进角色编辑器，点「保存角色」才真正创建' }),
      h('div', { class: 'foot-actions' }, stopBtn, goBtn)
    )
  );

  card.addEventListener('click', (event) => event.stopPropagation());
  layerEl.appendChild(card);
  layerEl.addEventListener('click', closeLayer);

  nodes = { prompt, brief, status, go: goBtn, stop: stopBtn };
}

/** 中止这次生成：和聊天共用一个中止接口 */
function stopGen() {
  if (!busy) return;
  api.stopChat();
  busy = false;
  updateButtons();
  if (nodes && nodes.status) nodes.status.textContent = '已中止';
}

async function generate() {
  if (busy) return;

  const prompt = String((nodes.prompt && nodes.prompt.value) || '').trim();
  if (!prompt) {
    showToast('先写一句角色描述吧', 'error');
    if (nodes.prompt) nodes.prompt.focus();
    return;
  }

  const endpoint = currentEndpoint();
  if (!endpoint || !endpoint.provider) {
    showToast('还没有配置模型服务，请先在设置里添加', 'error');
    return;
  }

  const bridge = isBridgeProvider(endpoint.provider);
  if (!bridge && !endpoint.provider.apiKey) {
    showToast(`还没有填写「${endpoint.provider.name}」的 API Key`, 'error');
    return;
  }

  const system =
    scope === 'worldbook' && targetBook
      ? `${LIBRARY_SYSTEM}\n\n${BOOK_SYSTEM_TAIL}\n\n以下是这本书的设定：\n\n${buildBookContext(targetBook, prompt)}`
      : LIBRARY_SYSTEM + briefSection(nodes.brief && nodes.brief.value);

  const requestId = uid();
  busy = true;
  updateButtons();
  if (nodes.status) nodes.status.textContent = bridge ? '本地模型正在生成…可能要等一会儿（约 30~60 秒）' : '正在生成…';

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `角色描述：${prompt}\n\n请直接输出那张角色卡的 JSON。` }
      ],
      // 本机桥接：只要文字，别让它顺手配一张图（那一趟要几十秒）
      noImage: true
    });

    if (!response || response.ok !== true) {
      const message = (response && response.error) || '调用失败';
      // 被中止时不该报错，安静收场
      if (/abort|中止|cancel/i.test(message)) {
        if (nodes && nodes.status) nodes.status.textContent = '已中止';
        return;
      }
      showToast(message, 'error');
      if (nodes && nodes.status) nodes.status.textContent = message;
      return;
    }

    const parsed = parseGeneratedCharacter(responseText(response, bridge));
    if (!parsed.ok) {
      showToast(`${parsed.error}，已把原文放进描述里，你自己整理一下`, 'error');
      // 兜底：原文整段塞进描述，别让这几十秒白等
      acceptDraft({
        name: '未命名角色',
        description: parsed.raw,
        personality: '',
        tags: [],
        attributes: []
      });
      return;
    }

    acceptDraft(parsed.fields);
  } catch (err) {
    showToast((err && err.message) || '生成失败', 'error');
  } finally {
    busy = false;
    updateButtons();
  }
}

/** 把生成结果交给角色编辑器草稿，并收掉浮层 */
function acceptDraft(fields) {
  const opened = startDraft(fields, scope, targetBook ? targetBook.id : null);
  if (!opened) {
    showToast('没能打开角色编辑器，生成的内容没保存', 'error');
    return;
  }
  closeLayer();
}
