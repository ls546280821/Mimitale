'use strict';

// ============================================================================
//  data/messages.js —— 发给模型的那串消息怎么拼
//
//  这是整个应用最核心的一段「纯逻辑」：把人设、世界书、示例对话、真实历史、
//  面板状态按固定顺序拼成一个数组。不进 DOM，只读 state / library / panel。
//
//  顺序（和酒馆的思路一致）：
//    1. system：人设 + 扮演规则/GM 规则 + 角色设定/性格/场景 + 叙述模式 + 日期
//    2. 世界书命中的设定
//    3. 角色卡里的示例对话（当成已经发生过的对话塞进去）
//    4. 最近 N 轮真实对话（面板行已剥掉）
//    5. 面板状态（当前权威值）
//    6. 角色卡里的「对话后指令」，放最后最管用
//
//  绑定了角色卡时不再使用「设置」里的全局人设 —— 否则你扮演雷电将军，
//  系统提示词却在说「你是昔涟」，模型会精神分裂。
// ============================================================================

import { CONFIG } from '../core/config.js';
import { state } from '../core/state.js';
import { characterForConvo } from './library.js';
import { cleanAssistantText, convoFieldDisplayNames, formatPanelForPrompt, panelGroupNames } from './panel.js';
import { formatSummaryForPrompt, summarizedCount } from './memory.js';
import { gmRuleText, isGmMode, narrationInstruction, roleplayRuleText } from './narration.js';
import { optionsInstruction } from './suggestions.js';
import { convoPlayer, convoUserName, userName, worldbookCast, playerProfileForPrompt } from './cast.js';

/**
 * 替换角色卡里的占位符。
 * {{char}} / <BOT> 是角色自己，{{user}} / <USER> 是你。
 * 只在「发给模型」和「插入开场白」时替换，原始文本保持不动，
 * 这样以后改了名字，旧消息不会莫名其妙跟着变。
 */
export function applyMacros(text, character, name) {
  const charName = (character && character.name) || '昔涟';
  const me = name || userName();

  // 用函数式替换：字符串形式的替换参数会把 $&、$1 之类的序列当特殊写法，
  // 角色名里万一有 $ 就会替换错乱。
  return String(text == null ? '' : text)
    .replace(/\{\{char\}\}/gi, () => charName)
    .replace(/\{\{user\}\}/gi, () => me)
    .replace(/<BOT>/gi, () => charName)
    .replace(/<USER>/gi, () => me);
}

/**
 * 把角色卡的「示例对话」拆成真正的 user / assistant 消息。
 * 格式是每行以 {{user}}: 或 {{char}}: 开头，多组之间用 <START> 分隔。
 * 解析不出来就返回空数组，不会影响正常对话。
 */
export function parseExampleDialogue(text, charName, me) {
  const out = [];
  const raw = String(text || '');
  if (!raw.trim()) return out;

  // 注意：这里的 reEsc 是「正则转义」，和上面转义 HTML 的 esc() 不是一回事，
  // 刻意换个名字，免得以后改错。
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 名字为空时不能把「空字符串」也当成一种匹配，否则任意行都会被吃掉
  const alternatives = (name, kind, extraTags) => {
    const list = [`\\{\\{${kind}\\}\\}`, ...extraTags];
    if (name && String(name).trim()) list.push(reEsc(String(name).trim()));
    return list.join('|');
  };

  const markers = [
    {
      re: new RegExp(`^\\s*(?:${alternatives(me, 'user', ['<USER>'])})\\s*[:：]\\s*(.*)$`, 'i'),
      role: 'user'
    },
    {
      re: new RegExp(
        `^\\s*(?:${alternatives(charName, 'char', ['<CHAR>', '<BOT>', '<BOT_NAME>'])})\\s*[:：]\\s*(.*)$`,
        'i'
      ),
      role: 'assistant'
    }
  ];

  let pending = null;

  const flush = () => {
    if (pending) {
      const content = pending.lines.join('\n').trim();
      if (content) out.push({ role: pending.role, content });
      pending = null;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    // <START> 表示一组新的示例，只是分割线
    if (/^\s*<START>\s*$/i.test(line)) {
      flush();
      continue;
    }

    let matched = false;
    for (const marker of markers) {
      const m = line.match(marker.re);
      if (m) {
        flush();
        pending = { role: marker.role, lines: [m[1]] };
        matched = true;
        break;
      }
    }
    // 没匹配到前缀就当作上一句的续行（角色说了好几行的情况很常见）
    if (!matched && pending) pending.lines.push(line);
  }

  flush();
  return out;
}

/** 这条消息带的图（用户发的 + AI 生成的都存这儿） */
export function messageImages(message) {
  return Array.isArray(message.images) ? message.images.filter((s) => typeof s === 'string' && s) : [];
}

/**
 * 组装真正发给模型的消息数组。
 * 参数里的两段（世界书命中 / 语义检索）是调用方异步取好的 —— 这里保持同步，
 * 方便两边共用同一份拼接逻辑（发送、继续、重新生成都走它）。
 */
export function buildApiMessages(convo, worldbookSection, ragSection) {
  const settings = state.settings || {};
  const character = characterForConvo(convo);
  // 进了世界的会话用玩家自己创建的角色名，其它会话用设置里的名字
  const me = convoUserName(convo);
  const charName = (character && character.name) || '昔涟';
  const gmMode = isGmMode(convo);

  // 注意：调用时对话末尾通常刚 push 了一条空的 assistant 占位消息（用来填空），
  // 必须把它过滤掉，否则会发给接口一条 content 为空的消息，严格的接口会直接报 400。
  // 但**只带图不打字**的用户消息要留下 —— 它没有文字却是有内容的。
  const history = convo.messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      (String(m.content || '').trim() || messageImages(m).length)
  );

  const turns = Math.max(1, Number(settings.maxTurns) || CONFIG.MAX_TURNS);
  // 从摘要覆盖点开始取「最近 N 轮」。
  // 如果还按 slice(-turns*2) 取，会出现「摘要写到第 30 条，原文只发第 70 条起」的断层 ——
  // 中间那段模型两边都看不到。从覆盖点往后、按轮数取，上下文才是连续的。
  const covered = summarizedCount(convo);
  const uncovered = covered > 0 ? history.slice(covered) : history;
  const recent = uncovered.slice(-turns * 2);

  const messages = [];

  // ---- 1. 系统提示词 ----
  const parts = [];

  // 全局人设只在「通用助手」时才用：
  //   · 绑了角色卡 → 用卡自己的 systemPrompt
  //   · GM 模式（从世界书列表页进来的会话）→ 叙述者不该顶着某个人的人设。
  //     以前这里无条件用全局人设，于是提示词里同时有「你是昔涟」和
  //     「你是这个世界的叙述者」，模型会去扮演昔涟 —— 世界就这么被一个人盖住了。
  const globalPersona = !character && !gmMode ? settings.systemPrompt || '' : '';
  const base = character ? character.systemPrompt || '' : globalPersona;
  if (String(base).trim()) parts.push(applyMacros(base, character, me).trim());

  if (character) {
    // 身份：年龄/性别/种族是「这个人是谁」的一部分，一开始就得说清楚。
    // 光靠状态面板不够 —— 面板可能被重置、老会话也没有这些字段，
    // 模型不知道就只能自己编（实测：16 岁的角色被回复成 21 岁）。
    const identity = [];
    if (character.age) identity.push(`年龄 ${character.age}`);
    if (character.gender) identity.push(`性别 ${character.gender}`);
    if (character.race) identity.push(`种族 ${character.race}`);
    if (identity.length) parts.push(`【${charName}的基本信息】\n${identity.join('，')}`);

    if (character.description) parts.push(`【${charName}的设定】\n${applyMacros(character.description, character, me)}`);
    if (character.personality) parts.push(`【${charName}的性格】\n${applyMacros(character.personality, character, me)}`);
    if (character.scenario) parts.push(`【当前场景】\n${applyMacros(character.scenario, character, me)}`);
  }

  // GM 模式换掉那段「不要跳出角色」：世界模型必须能写第三人称、切多个 NPC 视角，
  // 被「始终以第一人称」捆着会一轮缩回单角色腔调。
  // 两种规则里都带上了「推进节奏」—— 否则模型会一口气把整场戏演完，玩家只剩看的份。
  const ruleText = gmMode ? gmRuleText(charName, me, convo) : roleplayRuleText(charName, me, convo);
  if (character || gmMode) parts.push(ruleText);

  // 玩家角色：从世界书列表页「游玩」进来的会话才有这段。
  // 只有名字的话上面那句规则已经交代了，所以这里只在写了设定时才注入。
  const player = convoPlayer(convo);
  const playerProfileText = playerProfileForPrompt(convo);
  if (player && playerProfileText) {
    parts.push(`【玩家角色：${player.name || me}】\n${playerProfileText}`);
  }

  // 这个世界有哪些 NPC：不列出来 GM 就只能现编
  const cast = worldbookCast(convo);
  if (cast) parts.push(cast);

  // 叙述模式：决定要不要写心理 / 旁白，以及用什么标记（标记对上渲染样式）
  const narration = narrationInstruction(convo);
  if (narration) parts.push(narration);

  if (settings.showDate !== false) {
    const today = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    });
    parts.push(`[参考信息] 今天是 ${today}。`);
  }

  if (parts.length) messages.push({ role: 'system', content: parts.join('\n\n') });

  // ---- 2. 世界书：命中的设定紧跟人设之后 ----
  // 放在角色定义后面（酒馆叫 After Char Defs）——比角色本身靠前会稀释人设，
  // 比对话历史靠后又容易被忽略，这里是比较稳的位置。
  if (String(worldbookSection || '').trim()) {
    messages.push({ role: 'system', content: String(worldbookSection).trim() });
  }

  // ---- 2.2 语义检索捞回来的往事 / 设定 ----
  // 紧跟在世界书后面：都是「参考背景」，而且都是可选的（捞不到就什么都不加）
  if (String(ragSection || '').trim()) {
    messages.push({ role: 'system', content: String(ragSection).trim() });
  }

  // ---- 2.5 前面的剧情：较早对话的摘要 ----
  // 放在对话历史之前、示例对话之后的位置，让模型先读背景再读最近对话。
  const summaryText = formatSummaryForPrompt(convo);
  if (summaryText) messages.push({ role: 'system', content: summaryText });

  // ---- 3. 示例对话 ----
  // 注意：parseExampleDialogue 只剥掉了行首的「{{user}}:」前缀，
  // 正文里的宏还得自己替换一遍，否则模型会读到字面的 {{user}}。
  // GM 模式不注入示例对话：那是「某个角色怎么说话」的样本，
  // 而这里要的是主持人腔调，塞进去反而把模型的视角拉回单角色。
  if (character && !gmMode) {
    for (const example of parseExampleDialogue(character.mesExample, charName, me)) {
      messages.push({
        role: example.role,
        content: applyMacros(example.content, character, me)
      });
    }
  }

  // ---- 4. 真实对话历史（剥掉面板行，面板由程序权威注入）----
  // 用本会话的已知字段名（显示名）来剥：正文里提到同名字样不会被误删。
  const panelFields = convoFieldDisplayNames(convo);
  const panelGroups = [...panelGroupNames(convo)];
  for (const m of recent) {
    const raw = applyMacros(m.content, character, me);
    const text = m.role === 'assistant' ? cleanAssistantText(raw, panelFields, panelGroups) : raw;
    const images = messageImages(m);

    // 带图的用户消息要发成多模态数组 —— 这是 OpenAI 那套的通用写法，
    // 别的家（Claude / Gemini 的兼容层）一般也认。
    if (images.length && m.role === 'user') {
      const parts = [];
      // 有的接口不接受空 text 段，所以只有真有字才加
      if (String(text).trim()) parts.push({ type: 'text', text });
      for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
      messages.push({ role: 'user', content: parts });
      continue;
    }

    messages.push({ role: m.role, content: text });
  }

  // ---- 5. 面板状态：紧贴对话历史之后，权重很高 ----
  // 放在这里而不是塞进历史，是因为历史会被 maxTurns 截断 ——
  // 面板一旦被截出去，模型就开始凭感觉编数值。
  const panelText = formatPanelForPrompt(convo);
  if (panelText) messages.push({ role: 'system', content: panelText });

  // ---- 5b. 剧情选项：和面板同一批（都是「这轮要维护的状态」）----
  // 只在这张卡/这个会话开了剧情选项时才注入。
  const optionsText = optionsInstruction(convo);
  if (optionsText) messages.push({ role: 'system', content: optionsText });

  // ---- 6. 对话后指令 ----
  if (character && String(character.postHistoryInstructions || '').trim()) {
    messages.push({
      role: 'system',
      content: applyMacros(character.postHistoryInstructions, character, me).trim()
    });
  }

  return messages;
}
