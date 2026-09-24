'use strict';

// ============================================================================
//  main/card-import.js —— 导入一个文件时的「形状识别 + 归一化」
//
//  从 main.js 的 registerIpc() 里抽出来的。以前这段夹在 dialog / fs / 闭包中间，
//  只有走真实的文件对话框才能跑到，所以「卡里内嵌的世界书被静默丢掉」
//  「导出时 character_book 写死 null」这两个 bug 长期没有测试能发现。
//
//  抽出来之后，tools/smoke-test.js 可以直接 require 这个模块，
//  用真实的 PNG 字节跑完整的导入链路（而不是自己在测试里糊一套）。
//
//  这里不碰磁盘：给 buffer，返回解析结果。
// ============================================================================

const { parseCharacterCardPng } = require('./png.js');
const { normalizeCharacter } = require('./characters.js');
const {
  worldbookFromCharacterBook,
  worldbookFromLorebook,
  looksLikeLorebook
} = require('./worldbook-parse.js');

/**
 * 把角色卡里的头像字段转成可用的 dataURL。
 * 可能是完整的 dataURL、裸 base64，也可能是表示「没有头像」的字符串 'none'。
 */
function cardAvatarToDataUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value.startsWith('data:image/')) return value;
  // 'none' 是酒馆表示无头像的写法；太短的也不可能是图片
  if (value === 'none' || value.length < 64) return '';
  return `data:image/png;base64,${value}`;
}

/**
 * 官方互动模板 → 我们的分组名。
 * 卡片数据里的 `template` 是个机器用的 id（status_bar），界面上该显示中文标题，
 * 所以这里翻译一道；认不出来的 id（比如自定义面板 `panel_1`）走 panels 里的 title。
 */
const TEMPLATE_GROUP_LABELS = {
  status_bar: '状态栏',
  relationship: '关系',
  inventory: '背包',
  options: '剧情选项'
};

/** 卡片里 template id → 分组标题 */
function statusTemplateGroupTitles(tpl) {
  const map = new Map();
  const panels = tpl && Array.isArray(tpl.panels) ? tpl.panels : [];
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue;
    const id = String(panel.id || '').trim();
    const title = String(panel.title || '').trim();
    if (id && title) map.set(id, title);
  }
  for (const [id, label] of Object.entries(TEMPLATE_GROUP_LABELS)) {
    if (!map.has(id)) map.set(id, label);
  }
  return map;
}

/**
 * 把「互动模板」那种字段定义转成角色属性。
 *
 * 形状对照（左边是某站点导出的卡，右边是我们内部认的）：
 *   { key:'favor', label:'好感度', type:'meter', min:0, max:100,
 *     initial:20, hint:'…', template:'relationship' }
 *     → { name:'好感度', type:'meter', min:0, max:100, value:'20',
 *         hint:'…', group:'关系' }
 *
 * 几处取舍：
 *   · 用 `label` 当字段名（那是给人看的、也是要注入给模型的），
 *     `key` 只是它内部的变量名；
 *   · 重名就加序号跳过 —— 面板字段是按名字认的，两个「自定义面板」
 *     会互相覆盖，不如退成「自定义面板 2」；
 *   · initial 是数组（列表型字段）时用「、」拼起来，因为面板值只能是字符串；
 *   · `template` 翻译成分组标题（status_bar → 状态栏），这样导入后
 *     面板就是分好组的，而不是一长条。
 */
function attributesFromStatusTemplate(tpl) {
  const fields = tpl && Array.isArray(tpl.fields) ? tpl.fields : null;
  if (!fields || !fields.length) return [];

  const groupTitles = statusTemplateGroupTitles(tpl);
  const out = [];
  const used = new Set();

  for (const raw of fields) {
    if (!raw || typeof raw !== 'object') continue;

    let name = String(raw.label || raw.key || '').trim();
    if (!name) continue;

    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name} ${n}`) && n < 50) n += 1;
      name = `${name} ${n}`;
    }
    used.add(name);

    const initial = raw.initial;
    const value = Array.isArray(initial)
      ? initial.filter((v) => typeof v === 'string' && v.trim()).join('、')
      : initial == null
        ? ''
        : String(initial);

    const field = { name, value, type: raw.type };
    if (raw.min !== undefined) field.min = raw.min;
    if (raw.max !== undefined) field.max = raw.max;
    if (raw.hint) field.hint = raw.hint;
    const group = groupTitles.get(String(raw.template || '').trim());
    if (group) field.group = group;

    out.push(field);
  }

  return out;
}

/**
 * 从 v3 卡的 `chat_history` 里取开场白。
 *
 * 背景：**标准 v3 规范里没有 `chat_history`**（v3 只新增 assets / nickname /
 * group_only_greetings / 世界书装饰器这些），开场白仍叫 `first_mes`。
 * 但实际有站点导出的是这种变体：卡里 `first_mes` 不存在，开场白被放进了
 * `chat_history[0].messages` 里那条 assistant 消息。遇到了就得读。
 *
 * 结构（按导出的实际形态）：
 *   chat_history: [
 *     { id, name: '开场对话', messages: [{ role: 'assistant', content: '…' }, …] },
 *     { id, name: '示例对话', messages: [ … ] },   ← 备用 / 示例，这里不用
 *   ]
 *
 * ⚠️ 只读**第一个** session 的第一条 assistant 消息，而且只读纯文本。
 * 为什么不做更多（都是踩坑点）：
 *   · 第二个 session 从名字看像「示例对话」，但那是作者的命名习惯，不是规范约定 ——
 *     拿它去填 mesExample 就是靠猜，猜错会把示例对话塞进提示词。
 *   · 多模态卡里 messages 混着 { type: 'image', … } 这类媒体条目，不能当文本用。
 */
function firstMesFromChatHistory(d) {
  const sessions = d && Array.isArray(d.chat_history) ? d.chat_history : null;
  if (!sessions || !sessions.length) return '';

  const first = sessions[0];
  const messages = first && Array.isArray(first.messages) ? first.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string') continue;
    if (!msg.content.trim()) continue;
    return msg.content;
  }
  return '';
}

/**
 * 把角色卡（v1 扁平 / v2、v3 包一层 data）转成内部格式。
 * 文件名在没写角色名时当兜底。
 * 另外把卡里内嵌的世界书（character_book）一并解析出来 ——
 * 以前它是被整个丢掉的，导致「导入后角色失忆」。
 *
 * 注意：内嵌世界书挂在返回值的临时的 `worldbook` 字段上，
 * **由调用方决定怎么落盘和绑定**（导入链路会给它发 id 并绑到这个角色）。
 */
function characterFromCard(card, avatar, source, fallbackName, makeWorldbookId) {
  if (!card || typeof card !== 'object') return null;

  // v2 / v3 把真正的数据放在 data 里；v1 是直接铺在顶层
  const d = card.data && typeof card.data === 'object' ? card.data : card;

  // 一个角色卡至少得有点东西。随便选一个普通 JSON 文件时，
  // 这里会返回 null，界面就能报「解析失败」而不是收下一个空白角色。
  const recognizable = d.name || d.char_name || d.description || d.first_mes || d.personality;
  if (!recognizable) return null;

  // 自己导出的卡会把年龄/性别/种族/属性放在 extensions.mimitale ——
  // 这是我们自己的私有扩展位（酒馆规范里 extensions 就是留给各家塞自己东西的，
  // 别的软件按规范会原样忽略这段）。
  const ext =
    d.extensions && typeof d.extensions === 'object' && d.extensions.mimitale && typeof d.extensions.mimitale === 'object'
      ? d.extensions.mimitale
      : {};

  // 开场白：先按标准字段取；这一批都没有才去翻 v3 变体的 chat_history。
  // 顺序不能反 —— 标准字段存在时它才是权威的。
  const firstMes =
    d.first_mes || d.first_message || d.greeting || d.char_greeting || firstMesFromChatHistory(d);

  // 属性（状态面板模板）有两个来源，优先级从高到低：
  //   1. extensions.mimitale.attributes —— 我们自己导出去的卡，是权威形状
  //   2. extensions.status_template    —— 别的站点的「互动模板」，映射过来
  // 自己导的卡两者不会同时有；别的站点导的卡只有后者。
  const ownAttrs = Array.isArray(ext.attributes) ? ext.attributes : [];
  const templateAttrs =
    ownAttrs.length || !d.extensions || typeof d.extensions !== 'object'
      ? []
      : attributesFromStatusTemplate(d.extensions.status_template);
  const attributes = ownAttrs.length ? ownAttrs : templateAttrs;

  const character = normalizeCharacter(
    {
      name: d.name || d.char_name || fallbackName,
      avatar,
      // 老版本 TavernAI 用的是 char_* / world_scenario 这一套字段名，一并兼容
      description: d.description || d.char_persona,
      personality: d.personality,
      scenario: d.scenario || d.world_scenario,
      firstMes,
      mesExample: d.mes_example || d.example_dialogue || d.char_example_dialogue,
      systemPrompt: d.system_prompt,
      postHistoryInstructions: d.post_history_instructions,
      creatorNotes: d.creator_notes || d.creatorcomment,
      tags: d.tags,
      // 自己导出去的卡会把年龄/性别/种族放在 extensions.mimitale，
      // 这里读回来，导出再导入才是一个闭环（别的软件按规范会原样忽略这段）
      age: ext.age,
      gender: ext.gender,
      race: ext.race,
      attributes,
      // 自带世界书的开关也跟着一起回来。缺省 true，所以没这个字段的卡不受影响。
      worldbookEnabled: typeof ext.worldbookEnabled === 'boolean' ? ext.worldbookEnabled : true
    },
    source
  );

  // v2 卡把世界书放在 data.character_book；也有工具放在顶层
  character.worldbook = worldbookFromCharacterBook(
    d.character_book || card.character_book,
    character.name,
    makeWorldbookId
  );

  return character;
}

/**
 * 解析一个导入的文件（PNG 或 JSON 文本），返回它到底是什么。
 *
 * 返回值三种情况：
 *   { kind: 'character', character, worldbook }
 *     —— 角色卡；worldbook 是卡里内嵌的那本（可能为 null）
 *   { kind: 'worldbook', worldbook }
 *     —— 独立的世界书文件
 *   { kind: 'error', error }
 *     —— 认不出来 / 解析失败
 *
 * 判断顺序很讲究：**先判世界书**。酒馆导出的世界书同样带 name/description，
 * 先走角色卡那条路会被当成一个空角色收下，整本书的条目全丢。
 */
function parseImportFile({ buffer, ext, fallbackName, makeWorldbookId }) {
  const isPng = ext === '.png';

  let card = null;
  let avatar = '';

  if (isPng) {
    card = parseCharacterCardPng(buffer);
    if (card) avatar = `data:image/png;base64,${buffer.toString('base64')}`;
  } else {
    try {
      card = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      return { kind: 'error', error: '不是合法的 JSON' };
    }
  }

  if (!card) {
    return { kind: 'error', error: isPng ? '这张 PNG 里没有角色卡数据（没有 chara 信息？）' : '解析失败' };
  }

  // 有些 JSON 卡自带头像：可能在顶层，也可能在 data 里，
  // 可能是完整 dataURL，也可能是裸 base64（没有头像时是字符串 'none'）
  if (!avatar) {
    avatar = cardAvatarToDataUrl((card.data && card.data.avatar) || card.avatar);
  }

  // 独立世界书先判（理由见上面）
  if (looksLikeLorebook(card)) {
    const book = worldbookFromLorebook(card, fallbackName, makeWorldbookId);
    if (book) return { kind: 'worldbook', worldbook: book };
  }

  const character = characterFromCard(card, avatar, isPng ? 'png' : 'json', fallbackName, makeWorldbookId);
  if (!character) {
    // 不是角色卡，再试一次世界书（形状松一点的，比如裸数组）
    const book = worldbookFromLorebook(card, fallbackName, makeWorldbookId);
    if (book) return { kind: 'worldbook', worldbook: book };
    return { kind: 'error', error: '既不是角色卡也不是世界书' };
  }

  const worldbook = character.worldbook || null;
  delete character.worldbook;
  return { kind: 'character', character, worldbook };
}

module.exports = {
  cardAvatarToDataUrl,
  characterFromCard,
  parseImportFile
};
