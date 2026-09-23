'use strict';

// ============================================================================
//  data/panel.js —— 状态面板（世界模型的状态栏）：解析 / 归一化 / 夹取 / 注入
//
//  模型每轮输出一段固定格式的状态栏，比如：
//      【金币】：100
//      【时间】：早上
//  把它交给模型自己「抄上一轮」是靠不住的 —— 历史会被 maxTurns 截断，
//  一旦截出去模型就开始编数值。所以这里把它解析出来存到会话上，
//  每轮由程序权威注入，数值就不会漂了。
//
//  纯逻辑，不碰 DOM。字段的类型/范围/变化规则由 main/panel-fields.js 定义，
//  主进程加载的是同一个文件，所以「范围怎么夹」两边跑的是同一份代码。
//
//  剧情选项（【剧情选项】：A / B / C）的解析也在这里：它和状态栏是同一类东西 ——
//  程序读的中间产物，解析出来之后正文里就该剥掉（值已经由面板权威注入、
//  选项已经变成可点的按钮，原文留在气泡里只会吵）。
// ============================================================================

import { now } from '../core/util.js';
import {
  clampFieldValue,
  normalizePanelField,
  groupPanelFields,
  describePanelField,
  trimNumber
} from '../core/panel-fields.js';
// 面板的写入口（setPanelField）改完值要落盘，所以 data 层里有一条
// panel → persist 的单向依赖。方向是单一的，不构成环。
import { persistConversations } from './persist.js';
// 「把角色卡的属性种进面板」要读卡上的 attributes（走共享归一化）。
// library 只依赖 core，不反向依赖这里，所以不成环。
import { characterAttrs } from './library.js';

// 字段行：全角/半角冒号都认。字段名限制在 24 字内，避免把长句子误当成字段。
const PANEL_LINE_RE = /^【([^】\n]{1,24})】[：:]\s*(.*)$/;
// 单行最长长度：面板行都是「字段：短值」，超长的更像正文
const PANEL_LINE_MAX = 200;
// 还没有已知字段时，值超过这个长度就不认为是面板（首次扫描的兜底判断）
const PANEL_GUESS_VALUE_MAX = 60;

// 明确不当面板的字段名：这些是我们自己注入的提示词段落，或消息渲染用的标记
const PANEL_RESERVED = new Set([
  '心理', '内心', '心声', '旁白', '上帝视角', '全知',
  '扮演规则', '主持规则', '当前场景', '世界设定', '参考信息', '叙述要求'
]);

export const MAX_PANEL_FIELDS = 120;

// 身份四项（姓名/年龄/性别/种族）在状态面板里的分组名。它们和「时间/地点/
// 好感度」这类随剧情变化的动态状态不是一回事，单独成块，跟状态栏/关系/背包并列。
export const IDENTITY_GROUP = '身份';

// 身份四项的字段名。老会话种身份时还没有「身份」分组，panelDefs 里没记 group；
// 按字段名兜底归组（见 panelFieldGroup），新旧会话的展示和注入就一致了。
const IDENTITY_FIELD_NAMES = new Set(['姓名', '年龄', '性别', '种族']);

/**
 * 会话面板字段属于哪个分组：优先用 defs 里记的；没记 group 且是身份四项的，
 * 兜底归进「身份」。分组只是视图键，面板上的分组编辑不存在（组的归属在
 * 种进去那一刻就定了），所以这个兜底不会跟任何手工操作打架。
 */
export function panelFieldGroup(convo, name) {
  const group = (convoPanelDef(convo, name) || {}).group || '';
  if (group) return group;
  return IDENTITY_FIELD_NAMES.has(name) ? IDENTITY_GROUP : '';
}

export const OPTIONS_LABEL = '剧情选项';
// 方括号可有可无：指令让模型输出「【剧情选项】：A / B / C」，但模型偶尔会
// 漏掉方括号只写「剧情选项：A / B / C」，两边都要能解析出来才稳。
export const OPTIONS_LINE_RE = /^【?剧情选项】?[：:]\s*(.*)$/;

export function panelFieldAllowed(name) {
  return !PANEL_RESERVED.has(name) && !name.includes('的设定') && !name.includes('的性格');
}

/**
 * 从一段文本里抽出面板字段（保持出现顺序）。
 *
 * knownFields：已经确立的字段名。给了它就以它为准 —— 正文里出现的
 * 「【某某】：……」不会被误收。只有第一次扫（还没有已知字段）时才靠
 * 形态猜测，这时候用「值很短」这个条件兜一下，避免把整段正文当面板。
 */
export function extractPanelFromText(text, knownFields) {
  const known = knownFields && knownFields.length ? new Set(knownFields) : null;
  const found = new Map();

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '');
    if (line.length > PANEL_LINE_MAX) continue;

    const m = line.match(PANEL_LINE_RE);
    if (!m) continue;

    const name = m[1].trim();
    if (!name || !panelFieldAllowed(name)) continue;

    const value = m[2].trim();

    // 已知字段直接收；未知字段只在首次扫描时按形态判断
    if (!known && value.length > PANEL_GUESS_VALUE_MAX) continue;
    if (known && !known.has(name) && value.length > PANEL_GUESS_VALUE_MAX) continue;

    found.set(name, value.slice(0, 500));
    if (found.size >= MAX_PANEL_FIELDS) break;
  }

  return found;
}

/**
 * 从一段文本里剥掉面板行。
 * 面板由程序权威注入，历史里再留一份只会白烧 token，还可能和注入值冲突。
 * 传了 knownFields 就只剥那些字段（正文里提到同名字样不会被误删）。
 */
export function stripPanelLines(text, knownFields) {
  const source = String(text || '');
  if (!source.trim()) return source;

  const known = knownFields && knownFields.length ? new Set(knownFields) : null;

  const out = source
    .split('\n')
    .filter((rawLine) => {
      const line = rawLine.trim().replace(/^[-*+]\s+/, '');
      if (line.length > PANEL_LINE_MAX) return true;

      const m = line.match(PANEL_LINE_RE);
      if (!m) return true;

      const name = m[1].trim();
      if (!name || !panelFieldAllowed(name)) return true;

      if (known) return !known.has(name);

      // 没有已知字段（首轮）时保守一点：只剥「短值」的面板行
      return m[2].trim().length > PANEL_GUESS_VALUE_MAX;
    });

  return collapseBlankLines(out.join('\n')).trim();
}

/**
 * 会话里有哪些「分组名」—— 从 panelDefs 各字段的 group 收集，再加上身份四项
 * 兜底的「身份」。这些组名就是注入时 `—— 组名 ——` 小标题的来源，
 * 剥正文时拿它来认分组标题（只剥已知组名，避免误删正文里「—— 破折号 ——」引语）。
 */
export function panelGroupNames(convo) {
  const names = new Set();
  const defs = convoPanelDefs(convo);
  for (const name of Object.keys(defs)) {
    const g = (defs[name] || {}).group;
    if (g) names.add(g);
  }
  // 身份四项可能没记 group（老会话），但 panelFieldGroup 会兜底成「身份」，
  // 所以只要面板里有身份字段，就把「身份」也算作已知分组。
  for (const name of convoPanelFields(convo)) {
    if (IDENTITY_FIELD_NAMES.has(name)) {
      names.add(IDENTITY_GROUP);
      break;
    }
  }
  return names;
}

/** 分组标题正则：`—— 组名 ——`。中文全角破折号，两边可有空格。 */
const GROUP_HEADER_RE = /^——\s*([^—\n]{1,24})\s*——$/;

/**
 * 从一段文本里剥掉分组小标题（`—— 组名 ——`）。
 * 只剥 knownGroups 里列出的组名 —— 正文里「—— 他顿了顿 ——」这种破折号引语
 * 组名不在列表里，不会被误删。
 */
export function stripPanelGroupHeaders(text, knownGroups) {
  const source = String(text || '');
  if (!source.trim()) return source;
  const known = knownGroups && knownGroups.length ? new Set(knownGroups) : null;
  if (!known || !known.size) return source;

  const out = source.split('\n').filter((rawLine) => {
    const line = rawLine.trim();
    if (!GROUP_HEADER_RE.test(line)) return true;
    const m = line.match(GROUP_HEADER_RE);
    return m ? !known.has(m[1].trim()) : true;
  });

  return collapseBlankLines(out.join('\n')).trim();
}

/** 连续空行压成一个，去掉首尾空白（剥面板后容易留下空格） */
export function collapseBlankLines(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 把「【剧情选项】：…」这一行剥掉。
 * 它和状态栏一样是给程序读的：程序把它解析成按钮之后，正文里再留一份
 * 就是重复（选项已经是可点的按钮了，原文留在气泡里只会吵）。
 */
export function stripOptionsLine(text) {
  const source = String(text || '');
  if (!source.includes(OPTIONS_LABEL)) return source;

  const out = source.split('\n').filter((rawLine) => !OPTIONS_LINE_RE.test(rawLine.trim()));
  return collapseBlankLines(out.join('\n')).trim();
}

/**
 * 助手消息的正文该怎么给模型/界面看：状态栏行、分组小标题、剧情选项行都剥掉。
 * 三者都是程序读的中间产物 —— 值已经由面板权威注入，选项已经变成按钮，
 * 分组标题是给模型看的排版提示，正文里留着只会像漏网之鱼一样突兀地挂在那儿。
 */
export function cleanAssistantText(text, panelFields, knownGroups) {
  return stripOptionsLine(stripPanelGroupHeaders(stripPanelLines(text, panelFields), knownGroups));
}

export function convoPanelFields(convo) {
  return convo && Array.isArray(convo.panelFields) ? convo.panelFields : [];
}

export function convoPanel(convo) {
  return convo && convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
}

/**
 * 字段定义表（名字 → {type, min, max, hint}）。
 *
 * 为什么存在**会话**上、而不是每轮去查角色卡：
 *   · 面板值本来就存在会话上，定义跟着走才不会两边对不上；
 *   · 这一局中途换了角色、或者把角色卡删了，正在进行的局仍然该受原来的约束；
 *   · 老会话没有这张表 → 返回空，一切照旧（范围/hint 是可选增强）。
 */
export function convoPanelDefs(convo) {
  return convo && convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};
}

/**
 * 归一化整张定义表。读盘进来的数据不可信（用户手改过 JSON、版本更老），
 * 所以只留真正能用的条目，其余丢掉 —— 丢一条定义只是少了范围提示，
 * 留一条坏定义却可能让夹取逻辑算出个乱值。
 */
export function normalizePanelDefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out = {};
  let count = 0;
  for (const name of Object.keys(value)) {
    if (count >= MAX_PANEL_FIELDS) break;
    const raw = value[name];
    if (!raw || typeof raw !== 'object') continue;

    const def = normalizePanelField({ ...raw, name, value: '' });
    if (!def) continue;
    // normalizePanelField 对没有意义的定义只回 type:'text' 且没有范围/hint，
    // 这种和「没有定义」等价，不用存
    const hasRange = typeof def.min === 'number' || typeof def.max === 'number';
    if (def.type === 'text' && !def.hint && !hasRange) continue;

    out[name] = {
      type: def.type,
      ...(typeof def.min === 'number' ? { min: def.min } : {}),
      ...(typeof def.max === 'number' ? { max: def.max } : {}),
      ...(def.hint ? { hint: def.hint } : {}),
      ...(def.group ? { group: def.group } : {})
    };
    count += 1;
  }
  return out;
}

/** 某个字段的定义（可能是 undefined —— 表示没有范围/hint） */
export function convoPanelDef(convo, name) {
  const def = convoPanelDefs(convo)[name];
  return def && typeof def === 'object' ? def : null;
}

/**
 * 把一个值按字段范围夹回去。返回夹过之后的字符串。
 * 没有定义 / 不是数值字段 / 解析不出数字，都原样返回。
 * defs 可以不传（默认用会话上的定义表）—— 同步历史时定义表还在构建中，
 * 那时要显式把新的传进来，否则新推断出来的范围当轮不生效。
 */
export function clampPanelValue(convo, name, value, defs) {
  const table = defs && typeof defs === 'object' ? defs : convoPanelDefs(convo);
  const def = table[name];
  if (!def || typeof def !== 'object') return value;
  return clampFieldValue(value, def).value;
}

/**
 * 把会话历史里出现过的面板字段同步到 convo.panel。
 * 取「最近一条提到该字段的助手消息」的值，所以手动改过的旧轮次会被更新的值覆盖。
 * 返回是否发生了变化 —— 调用方据此决定要不要重绘面板。
 *
 * 注意这里是**累积**而不是「从历史重建」：
 * 角色卡带过来的字段、以及用户在面板里手动加的字段，这一轮模型可能压根没提到
 * （小模型经常不听话），从零重建会把它们连值一起抹掉。
 * 所以以现有面板为底，把历史里扫到的值盖上去。
 */
export function syncConvoPanel(convo) {
  if (!convo || !Array.isArray(convo.messages)) return false;

  const beforeFields = convoPanelFields(convo).join('\u0001');
  const beforePanel = JSON.stringify(convoPanel(convo));

  const existingFields = convoPanelFields(convo);
  const existingPanel = convoPanel(convo);

  // 字段顺序：先保留已经有的（角色卡种下的 / 手动加的），新发现的追加在后面。
  const order = [...existingFields];
  const known = new Set(order);
  const latest = new Map();
  const defs = { ...convoPanelDefs(convo) };

  for (const msg of convo.messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const content = String(msg.content || '');
    if (!content.includes('【')) continue;

    const found = extractPanelFromText(content, [...known]);
    for (const [name, value] of found) {
      if (!known.has(name)) {
        if (order.length >= MAX_PANEL_FIELDS) continue;
        order.push(name);
        known.add(name);
        // 模型自己冒出来的字段：从值的形状补个定义（「63/100」= 带范围的数值），
        // 否则它永远没有进度条、也不受范围约束。
        if (!defs[name]) {
          const inferred = inferPanelDef(name, value);
          if (inferred) defs[name] = inferred;
        }
      }
      latest.set(name, value);
    }
  }

  // 值：历史里扫到的优先（最新一轮说了算），没扫到的沿用面板里现有的。
  // 有范围的数值字段在这里夹一下 —— 模型写 150/100、-5/100 都会被拉回范围内，
  // 否则面板上会长期挂着一个越界的数，而且下一轮它还会照抄那个越界值。
  const panel = {};
  for (const name of order) {
    const value = latest.has(name) ? latest.get(name) : existingPanel[name];
    if (value !== undefined) panel[name] = clampPanelValue(convo, name, value, defs);
  }

  convo.panelFields = order;
  convo.panel = panel;
  convo.panelDefs = defs;

  return beforeFields !== order.join('\u0001') || beforePanel !== JSON.stringify(panel);
}

/** 手动改一个字段的值（面板 UI 里直接编辑） */
export function setPanelField(convo, name, value) {
  if (!convo) return;
  const fields = [...convoPanelFields(convo)];
  if (!fields.includes(name)) fields.push(name);
  convo.panelFields = fields.slice(0, MAX_PANEL_FIELDS);

  const prev = String(convoPanel(convo)[name] == null ? '' : convoPanel(convo)[name]);
  const text = String(value == null ? '' : value).trim().slice(0, 500);
  // 界面上「/100」是拆成后缀单独显示的，输入框里只有分子。存的时候把分母拼回去，
  // 否则「60/100」改一下变成「60」，分母就永久丢了。
  const merged = mergeMeterValue(text, prev, convoPanelDef(convo, name));

  convo.panel = { ...convoPanel(convo), [name]: clampPanelValue(convo, name, merged) };
  convo.updatedAt = now();
  persistConversations(0);
}

/**
 * 把「只有分子」的值和分母拼回「60/100」。
 *
 * 为什么需要它：
 *   · 界面上「/100」是拆成后缀单独显示的，输入框里只有分子；
 *   · 卡片里的数值字段 initial 常常是个裸数字（20），而卡的文字和历史里写的是
 *     「20/100」—— 不统一的话，面板里是个光秃秃的 20，夹取也拿不到满值。
 * 所以：有范围上限的数值字段一律存成「分子/满值」这一种格式，两个入口
 * （种初始值、手动编辑）都走这里，格式就不会两样。
 *
 * 只对「数值型 + 有 max」的字段生效，别的字段原样返回。
 */
export function mergeMeterValue(value, prev, def) {
  const text = String(value == null ? '' : value).trim();
  if (!text || !def || def.type !== 'meter' || typeof def.max !== 'number') return text;
  if (text.includes('/')) return text;

  // 分母优先用旧值里的（可能和 max 不同，比如按比例的分数字段），没有就用 max
  const m = String(prev == null ? '' : prev).match(/^[-+]?\d+(?:\.\d+)?\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  const total = m ? m[1] : trimNumber(def.max);
  return `${text}/${total}`;
}

/**
 * 字段说明图例：有范围 / 变化规则的字段才出现。
 *
 * 单独列在图例里，而不是跟在值后面 —— 值本身要**原样回显**给模型看
 * （它就是模型上一轮写的），掺上注解会影响它照着抄。
 */
export function panelFieldLegend(convo, fields) {
  const lines = [];
  for (const name of fields) {
    const def = convoPanelDef(convo, name);
    if (!def) continue;
    const desc = describePanelField(def);
    if (!desc) continue;
    lines.push(`- ${name}：${desc}`);
  }
  return lines;
}

/**
 * 分组标题在注入文本里的写法：**刻意不用【】**。
 *
 * 用「【关系】：」的话会被自己的面板解析器当成一个名叫「关系」的字段
 * （PANEL_LINE_RE 认的就是这个形状），于是模型照着输出、下一轮就多出
 * 一个垃圾字段。用「—— 关系 ——」这种破折号包法就不会误匹配。
 */
export function panelGroupHeader(title) {
  return `—— ${title} ——`;
}

/**
 * 从值的形状推断字段定义 —— 只用于**模型自己冒出来的字段**。
 *
 * 「【好感度】：63/100」这种「数字/数字」的形状本身就说明了它是个带范围的数值：
 * 分子是当前值、分母是满值。不做这一步的话，卡片里没声明过的数值字段永远
 * 拿不到进度条，明明值里已经写着满值是多少。
 *
 * 只认这一个形状（中间一个斜杠、两边都是数字），而且只在字段还没有定义时补。
 * 刻意**不**推断 min：分母只能告诉我们上限，下限猜不出来（写 0 会错，
 * 留空则由夹取逻辑按「只夹上限」处理）。
 */
export function inferPanelDef(name, value) {
  const m = String(value == null ? '' : value).trim().match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const total = Number(m[2]);
  if (!isFinite(total) || total <= 0) return null;

  return { type: 'meter', max: total };
}

/** 面板拼成注入块；没有面板就返回空串 */
export function formatPanelForPrompt(convo) {
  const fields = convoPanelFields(convo);
  if (!fields.length) return '';

  const panel = convoPanel(convo);

  // 按分组拼。分组的字段顺序由 groupPanelFields 保序，没分组的排最后。
  // 老会话的身份四项没有记 group，panelFieldGroup 按字段名兜底归进「身份」。
  const groups = groupPanelFields(fields.map((name) => ({ name, group: panelFieldGroup(convo, name) })));

  const lines = [];
  let groupCount = 0;
  for (const bucket of groups) {
    const filled = bucket.fields.filter((f) => {
      const v = panel[f.name];
      return v !== undefined && v !== '';
    });
    if (!filled.length) continue;

    if (bucket.id) {
      groupCount += 1;
      lines.push(panelGroupHeader(bucket.id));
    }
    for (const f of filled) lines.push(`【${f.name}】：${panel[f.name]}`);
  }

  const grouped = groupCount > 0;
  const legend = panelFieldLegend(convo, fields);
  const legendBlock = legend.length
    ? '\n\n字段的取值范围与变化规则（务必遵守，数值超出范围会被程序拉回）：\n' + legend.join('\n')
    : '';
  // 有分组时交代一句 —— 否则模型看不懂那些破折号标题是干什么的
  const groupNote = grouped
    ? '\n（「—— 组名 ——」是状态分组的小标题，照抄即可，不要当成字段输出。）'
    : '';

  // 一个值都还没有 = 刚用角色卡的属性模板开的局。
  // 这时候也要把字段名告诉模型，否则它不知道要维护哪些状态 ——
  // 而「模型得自己碰巧输出【金币】：100」正是属性模板要解决的冷启动问题。
  if (!lines.length) {
    return (
      '[当前状态]\n' +
      `本局需要维护这些状态字段：${fields.join('、')}\n` +
      '请在每次回复的末尾，用「【字段】：值」的格式把它们完整输出一遍' +
      '（还不知道的写「未知」）；之后每轮照抄并更新，不要凭空改动已有数值。' +
      groupNote +
      legendBlock
    );
  }

  return (
    '[当前状态]\n' +
    '这是本局当前的权威状态，请以它为准，不要自行改动历史数值。\n' +
    '每次回复末尾按同样的格式输出更新后的完整状态栏；没有变化的字段照抄。' +
    groupNote +
    '\n\n' +
    lines.join('\n') +
    legendBlock
  );
}

// ---------------------------------------------------------------------------
//  写入：把字段种进会话面板
//
//  这四个是「面板怎么长出来」的写入口，被入口层和聊天流程两头调用 ——
//  角色卡绑定、进世界开新会话、每轮回复后同步玩家名。
//  所以它们属于数据层，不属于状态面板视图（views/panelUi.js 只管画和点）。
// ---------------------------------------------------------------------------

/**
 * 往状态面板里补字段。已存在的跳过（同名的保留面板里的当前值 ——
 * 半路给会话绑角色，不该把这一局已经跑出来的数值冲掉），
 * 初始值只在「这个字段是刚种进去的」时候落地。
 *
 * pairs 的元素可以是 [name, value]，也可以是完整定义对象
 * {name, value, type, min, max, hint} —— 后者会把范围/hint 一起记到
 * convo.panelDefs 上，之后注入提示词时告诉模型（见 formatPanelForPrompt）。
 */
export function appendPanelFields(convo, pairs) {
  if (!convo || !pairs.length) return false;

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  const known = new Set(fields);
  let changed = false;

  for (const pair of pairs) {
    // 两种形状都收：[name, value] 和完整定义对象
    const raw = Array.isArray(pair) ? { name: pair[0], value: pair[1] } : pair || {};
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name || known.has(name)) continue;
    if (!panelFieldAllowed(name)) continue;
    if (fields.length >= MAX_PANEL_FIELDS) break;

    fields.push(name);
    known.add(name);
    changed = true;

    // 归一化一遍：范围写反了会被换正，类型不认识会退回 text
    const def = normalizePanelField({ ...raw, name });
    if (!def) continue;

    // 范围/hint/分组记到会话上（只有真的有内容才记，免得存一堆空壳）
    if (def.type !== 'text' || def.hint || def.group) {
      defs[name] = {
        type: def.type,
        ...(typeof def.min === 'number' ? { min: def.min } : {}),
        ...(typeof def.max === 'number' ? { max: def.max } : {}),
        ...(def.hint ? { hint: def.hint } : {}),
        ...(def.group ? { group: def.group } : {})
      };
    }

    // 初始值也过一遍范围（卡作者自己写越界了，也一样夹回来），
    // 并统一成「分子/满值」格式（卡里 initial 常是裸数字 20）
    const text = String(def.value == null ? '' : def.value).trim();
    if (text) panel[name] = clampFieldValue(mergeMeterValue(text, '', def), def).value.slice(0, 500);
  }

  if (!changed) return false;

  convo.panelFields = fields;
  convo.panel = panel;
  convo.panelDefs = defs;
  convo.updatedAt = now();
  return true;
}

/** 把角色卡上的「属性」种进会话的状态面板（连类型/范围/hint 一起） */
export function seedPanelFromCharacters(convo, list) {
  if (!convo || !Array.isArray(list)) return false;

  const pairs = [];
  for (const character of list) {
    for (const attr of characterAttrs(character)) pairs.push(attr);
  }
  return appendPanelFields(convo, pairs);
}

/**
 * 把「身份四项」（姓名 / 年龄 / 性别 / 种族）种进状态面板。
 *
 * 两处都用它，但「这是谁的身份」不一样：
 *   · 单角色对话：是你绑的那张卡的身份（姓名 = 角色名）。模型不知道就只能瞎编 ——
 *     实测 16 岁的角色被回复成 21 岁。
 *   · 游玩世界书：是「你自己」的身份（姓名 = 你在弹窗里填的名字，其余来自选的卡）。
 *
 * 为什么身份也要进面板：世界里时间会走、剧情会推 —— 过一年年龄要涨一岁，
 * 被人改了名字也得跟着改。交给「每轮由程序权威注入」的面板维护，
 * 比让模型自己记牢靠得多。
 *
 * 这四项归到同一个「身份」分组里（group 记到 panelDefs），面板上就单独成块，
 * 跟「状态栏 / 关系 / 背包」这些随剧情变化的动态状态分开 —— 身份是角色的
 * 固定属性，不该跟时间地点好感度混在一起。分组只是视图键，数据仍是一维数组。
 */
export function seedIdentity(convo, name, character) {
  const pairs = [];
  const trimmed = String(name || '').trim();
  if (trimmed) pairs.push({ name: '姓名', value: trimmed, group: IDENTITY_GROUP });

  if (character) {
    const age = String(character.age || '').trim();
    const gender = String(character.gender || '').trim();
    const race = String(character.race || '').trim();
    if (age) pairs.push({ name: '年龄', value: age, group: IDENTITY_GROUP });
    if (gender) pairs.push({ name: '性别', value: gender, group: IDENTITY_GROUP });
    if (race) pairs.push({ name: '种族', value: race, group: IDENTITY_GROUP });
  }

  return appendPanelFields(convo, pairs);
}

/**
 * 面板里的「姓名」被剧情改了 → 跟着改会话上的玩家名。
 * 不跟着改就会出现「面板说你叫 A，消息标签和 {{user}} 还叫你 B」的矛盾。
 * 只对进了世界的会话生效（普通角色扮演没有「玩家角色」这一说）。
 */
export function syncPlayerNameFromPanel(convo) {
  const player = convo && convo.player;
  if (!player || typeof player !== 'object') return false;

  const name = String(convoPanel(convo)['姓名'] || '').trim();
  if (!name || name === player.name) return false;

  player.name = name.slice(0, 40);
  convo.updatedAt = now();
  return true;
}
