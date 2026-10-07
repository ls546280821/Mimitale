'use strict';

// ============================================================================
//  data/messages.js —— 发给模型的那串消息怎么拼
//
//  这是整个应用最核心的一段「纯逻辑」：把人设、世界书、示例对话、真实历史、
//  面板状态按固定顺序拼成一个数组。不进 DOM，只读 state / library / panel。
//
//  顺序（和酒馆的思路一致）：
//    1. system：人设 + 扮演规则/GM 规则 + 角色设定/性格/场景 + 叙述模式 + 日期
//    2. 世界书命中的设定 → 语义检索 → 联网搜索结果
//    3. 角色卡里的示例对话（当成已经发生过的对话塞进去）
//    4. 最近 N 轮真实对话（面板行已剥掉）
//    5. 面板状态（当前权威值）
//    6. 角色卡里的「对话后指令」，放最后最管用
//
//  人设只有两个来源，而且互斥：绑了角色卡 → 用那张卡的 systemPrompt；
//  没绑卡（默认对话）→ 用设置里的「默认人设」（可编辑，见 main/providers.js）。
//  两者不会同时出现，免得两份设定打架（你扮演雷电将军，提示词却在说另一套人设）。
//
//  ⚠️ 默认对话按「跟 AI 模型聊天」处理，不是扮演酒馆里的角色：它只带人设、
//  聊天记录、日期和联网搜索结果，**不带**扮演规则 / 世界书 / 玩家角色 / NPC 名单 /
//  叙述模式 / 状态面板 / 剧情选项 / 表情标签。理由见 buildApiMessages 里的 plainChat。
//  唯一留着的是「预设」—— 那是用户自己挂在这一局上的指令，属于显式选择。
// ============================================================================

import { state } from '../core/state.js';
import { asArray } from '../core/util.js';
import {
  characterForConvo,
  effectiveDialoguePresets,
  WORLDBOOK_SCAN_DEPTH
} from './library.js';
import { cleanAssistantText, convoFieldDisplayNames, formatPanelForPrompt, panelGroupNames, PANEL_PROMPT_REMINDER } from './panel.js';
import { formatSummaryForPrompt, summarizedCount } from './memory.js';
import {
  gmRuleText,
  isGmMode,
  narrationInstruction,
  playerOwnershipReminder,
  roleplayRuleText
} from './narration.js';
import { optionsInstruction } from './suggestions.js';
import {
  convoPlayer,
  convoUserName,
  userName,
  assistantName,
  assistantPersona,
  worldbookCast,
  playerProfileForPrompt,
  panelEntities
} from './cast.js';

/**
 * 替换角色卡里的占位符。
 * {{char}} / <BOT> 是角色自己，{{user}} / <USER> 是你。
 * 只在「发给模型」和「插入开场白」时替换，原始文本保持不动，
 * 这样以后改了名字，旧消息不会莫名其妙跟着变。
 *
 * 没绑卡时「角色自己」是谁，取决于默认人设 —— 那份是按模型存的，
 * 所以调用方知道是哪个模型的话（buildApiMessages 就知道），把它传进来，
 * 免得这里只能拿设置里的当前模型去猜（会话可以有自己的模型）。
 */
export function applyMacros(text, character, name, assistantFallback) {
  const charName =
    (character && character.name) || String(assistantFallback || '').trim() || assistantName();
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
function parseExampleDialogue(text, charName, me) {
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
  return asArray(message.images).filter((s) => typeof s === 'string' && s);
}

/**
 * 给本机桥接服务传的「角色外貌」上下文。
 *
 * 桥接的图像模型不认识角色名，只认视觉标签，所以要把角色的长相用自然语言
 * 描述出来，由桥接服务翻译成英文 tag。这里取角色卡的身份三项 + 设定（description），
 * 描述里通常就带着发色瞳色服装体型。没绑定角色（进世界 / 通用助手）时返回空串。
 */
export function characterContextForConvo(convo) {
  const character = characterForConvo(convo);
  if (!character) return '';

  const me = convoUserName(convo);
  const identity = [character.age ? `年龄 ${character.age}` : '', character.gender, character.race]
    .filter(Boolean)
    .join('，');
  const description = String(character.description || '').trim();

  const parts = [];
  parts.push(identity ? `${character.name}：${identity}` : character.name);
  if (description) parts.push(applyMacros(description, character, me));
  return parts.join('\n');
}

/**
 * 预设（叠在对话上的一层指令）拼成的注入段。
 *
 * 它是**独立的整块**，不掺进扮演规则里 —— 这样「关掉预设」就是逐字回到
 * 默认规则，不用担心合并出残余。预设本身不承载任何逻辑，只是一段文本。
 *
 * 一个会话**可以挂多条**（比如「禁比喻」+「固定称呼」），按挂的顺序依次拼上，
 * 每条各自成块（`【预设 · 名称】`）。没手动配过的会话带上所有「可全局」的预设。
 *
 * 条目有两种：带关键词的只在近期历史里命中才带上；没关键词的（constant）每轮都带。
 * 关键词扫描范围跟世界书一致（往回看几条消息），但只扫真实对话，不递归。
 */
export function dialoguePresetSection(convo, recentMessages) {
  const presets = effectiveDialoguePresets(convo);
  if (!presets.length) return '';

  // 命中判定只看「最近这几条」的正文；和世界书的扫描深度保持同一个量级。
  // 多条预设共用同一份扫描文本，不必每条各扫一遍。
  const haystack = asArray(recentMessages)
    .slice(-WORLDBOOK_SCAN_DEPTH)
    .map((m) => String((m && m.content) || ''))
    .join('\n')
    .toLowerCase();

  const sections = [];
  for (const preset of presets) {
    const blocks = [];
    // 正文（顶层 content）：常驻
    if (String(preset.content || '').trim()) blocks.push(String(preset.content).trim());

    const entries = asArray(preset.entries);
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      const text = String(entry.content || '').trim();
      if (!text) continue;
      const keys = asArray(entry.keys);
      // 没关键词就是常驻（normalizePresetEntry 已把这种情况标成 constant）
      if (!keys.length || entry.constant === true) {
        blocks.push(text);
        continue;
      }
      const hit = keys.some((k) => haystack.includes(String(k).toLowerCase()));
      if (hit) blocks.push(text);
    }

    const text = blocks.join('\n\n').trim();
    if (text) sections.push(`【预设 · ${preset.name}】\n${text}`);
  }

  return sections.join('\n\n');
}

/** 会话实际生效的预设上的采样参数（多条时取**第一条设过值**的项，没设过的项不覆盖） */
export function dialoguePresetSampling(convo) {
  const presets = effectiveDialoguePresets(convo);
  const out = {};
  for (const preset of presets) {
    if (out.temperature === undefined && Number.isFinite(preset.temperature)) out.temperature = preset.temperature;
    if (out.maxTokens === undefined && Number.isFinite(preset.maxTokens)) out.maxTokens = preset.maxTokens;
    if (out.topP === undefined && Number.isFinite(preset.topP)) out.topP = preset.topP;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 组装真正发给模型的消息数组。
 * 参数里的三段（世界书命中 / 语义检索 / 联网搜索）是调用方异步取好的 ——
 * 这里保持同步，方便两边共用同一份拼接逻辑（发送、继续、重新生成都走它）。
 */
export function buildApiMessages(convo, worldbookSection, ragSection, searchSection) {
  const settings = state.settings || {};
  const character = characterForConvo(convo);
  // 进了世界的会话用玩家自己创建的角色名，其它会话用设置里的名字
  const me = convoUserName(convo);
  const charName = (character && character.name) || assistantName(convo);
  const gmMode = isGmMode(convo);
  // 「默认对话」= 既没绑角色卡、也不是世界模式 —— 那就是**跟 AI 模型聊天**，
  // 不是扮演酒馆里的某个角色。这种会话只带人设和聊天记录，应用不再往里塞
  // 酒馆那一套（扮演规则 / 世界书 / 状态面板 / 剧情选项 / 表情标签）：
  // 人设是自己写的、自足的，多叠一层规则只会跟它打架。
  const plainChat = !character && !gmMode;

  // 注意：调用时对话末尾通常刚 push 了一条空的 assistant 占位消息（用来填空），
  // 必须把它过滤掉，否则会发给接口一条 content 为空的消息，严格的接口会直接报 400。
  // 但**只带图不打字**的用户消息要留下 —— 它没有文字却是有内容的。
  const history = convo.messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      (String(m.content || '').trim() || messageImages(m).length)
  );

  // 带几轮进请求由设置决定（设置 → 行为 → 对话轮数）。
  // 以前写死在 core/config.js 的 CONFIG.MAX_TURNS 里 —— 但它是用户能明显感觉到的项
  // （记性好坏），藏在代码里等于不给改。兜底 20 和 DEFAULT_SETTINGS.maxTurns 一致。
  const turns = Math.max(1, Number(settings.maxTurns) || 20);
  // 从摘要覆盖点开始取「最近 N 轮」。
  // 如果还按 slice(-turns*2) 取，会出现「摘要写到第 30 条，原文只发第 70 条起」的断层 ——
  // 中间那段模型两边都看不到。从覆盖点往后、按轮数取，上下文才是连续的。
  //
  // ⚠️ 两个坑，都踩过：
  //  1. covered 是在 convoContextMessages()（memory.js，只认「正文非空」）上数出来的，
  //     而这里 slice 的是上面那个 history —— 它多留了「只带图不打字」的用户消息。
  //     两个数组不等长时下标就偏了。
  //  2. 更狠的一种：摘要还在、消息已经没了。摘要覆盖点是**按当时的消息条数**记下来的，
  //     而消息随时可能变少 ——「清空对话」只清 messages、不碰 summaries（convoActions），
  //     删消息 / 重新生成也一样。这时 covered 会远大于 history.length，
  //     slice 回来是空数组：整轮请求只剩摘要 + 人设，**用户刚打的那句话都不会发出去**，
  //     模型照着一份过期摘要自说自话，表现得像完全没看见你说了什么。
  //
  //     所以不能只做 Math.min(covered, history.length) ——那刚好把最后几条也切掉。
  //     只要「摘要覆盖点已经够不着这段历史了」（covered >= history.length），
  //     就当摘要没覆盖到原文，老老实实发最近 N 轮。宁可多带一点，
  //     也绝不能把用户当下说的话漏掉。
  const summarized = summarizedCount(convo);
  const covered = summarized >= history.length ? 0 : summarized;
  const uncovered = covered > 0 ? history.slice(covered) : history;
  const recent = uncovered.slice(-turns * 2);

  const messages = [];

  // ---- 1. 系统提示词 ----
  const parts = [];

  // 人设：绑了卡就用卡自己的 systemPrompt；**没绑卡**（通用助手）才用「默认人设」。
  // 两者互斥 —— 一张卡一旦被绑定，默认人设就不参与，免得两份设定打架。
  // 世界模式（GM）没有「某个人」的人设，叙述者由主持规则来立。
  const persona = character ? '' : assistantPersona(convo);
  const base = character ? character.systemPrompt || '' : persona;
  if (String(base).trim()) parts.push(applyMacros(base, character, me, charName).trim());

  if (character) {
    // 身份：年龄/性别/种族是「这个人是谁」的一部分，一开始就说清楚
    // （状态面板可能被重置、老会话没有这些字段，不能只靠面板）。
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
  // 默认对话（plainChat）不要这一段：那段规则是给「扮演某个角色」用的，
  // 而这里要的是普通聊天，规则交给用户写的人设自己交代。
  if (!plainChat) {
    parts.push(gmMode ? gmRuleText(charName, me, convo) : roleplayRuleText(charName, me, convo));
  }

  // 预设：对话层面额外叠上去的一层行为框架，紧跟扮演规则之后。
  // ⚠️ 刻意放在上面那个 if 外面 —— 通用助手（既没绑卡、也不是 GM）一样能用预设，
  //   而那种场景恰恰最需要它。它是一整块独立文本，不并进 ruleText，
  //   这样「不绑预设」就是逐字回到默认规则。
  const presetText = dialoguePresetSection(convo, history);
  if (presetText) parts.push(presetText);

  // 玩家角色：从世界书列表页「游玩」进来的会话才有这段。
  // 只有名字的话上面那句规则已经交代了，所以这里只在写了设定时才注入。
  const player = convoPlayer(convo);
  const playerProfileText = playerProfileForPrompt(convo);
  // 和世界书段一起挡：默认对话不认「我在这个世界里是谁」—— 那是扮演才有的事。
  if (!plainChat && player && playerProfileText) {
    // 抬头里点明口径：这份设定是**玩家自己的角色**，不是给 GM 演的 NPC。
    // 玩家从角色库挑一张卡当自己时，注入的是那张卡的第三人称设定；
    // 紧接着就是【这个世界的人】名单，两者容易被模型混成一类，
    // 于是主角被当成 NPC 描写、替 TA 写起了动作。
    parts.push(
      `【玩家角色：${player.name || me}】\n` +
        `（这是玩家本人操作的主角，由玩家自己驱动 —— 一律用第二人称「你」称呼 TA，` +
        `TA 的动作、台词、心理、感受和决定都不要代写。）\n` +
        playerProfileText
    );
  }

  // 这个世界有哪些 NPC：不列出来 GM 就只能现编（默认对话不带，同世界书段）
  const cast = plainChat ? '' : worldbookCast(convo);
  if (cast) parts.push(cast);

  // 叙述模式：决定要不要写心理 / 旁白，以及用什么标记（标记对上渲染样式）
  // 默认对话不带：它读默认档「标准」，而那一档明确要求「不要写成一份动作 + 台词的
  // 对话记录」「不要把整段动作括在括号里」—— 那是给写小说的，不是给普通聊天的。
  const narration = plainChat ? '' : narrationInstruction(convo);
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
  // 默认对话不带：那是「这个世界有哪些设定」的补充，属于扮演那一套。
  if (!plainChat && String(worldbookSection || '').trim()) {
    messages.push({ role: 'system', content: String(worldbookSection).trim() });
  }

  // ---- 2.2 语义检索捞回来的往事 / 设定 ----
  // 紧跟在世界书后面：都是「参考背景」，而且都是可选的（捞不到就什么都不加）
  if (!plainChat && String(ragSection || '').trim()) {
    messages.push({ role: 'system', content: String(ragSection).trim() });
  }

  // ---- 2.3 联网搜索结果 ----
  // 和世界书同属「参考背景」，所以放在同一个位置。
  // 这一条**默认对话也带** —— 联网是「跟模型聊天」本来的能力，不是扮演那一套。
  if (String(searchSection || '').trim()) {
    messages.push({ role: 'system', content: String(searchSection).trim() });
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
  const panelText = plainChat ? '' : formatPanelForPrompt(convo);
  if (panelText) messages.push({ role: 'system', content: panelText });

  // ---- 5b. 剧情选项：和面板同一批（都是「这轮要维护的状态」）----
  // 只在这张卡/这个会话开了剧情选项时才注入。
  const optionsText = plainChat ? '' : optionsInstruction(convo);
  if (optionsText) messages.push({ role: 'system', content: optionsText });

  // ---- 5c. 表情标签：只在有人配了「带情绪键的表情图」时才注入 ----
  const emoText = plainChat ? '' : expressionInstruction(convo);
  if (emoText) messages.push({ role: 'system', content: emoText });

  // ---- 6. 对话后指令 ----
  if (character && String(character.postHistoryInstructions || '').trim()) {
    messages.push({
      role: 'system',
      content: applyMacros(character.postHistoryInstructions, character, me).trim()
    });
  }

  // ---- 7. 状态表的最后一声提醒 ----
  // 必须是**整批 system 的最后一条**（这时它离生成位置最近）。上面第 5 步的状态表
  // 段已经交代了格式，但第 5b/6 步（剧情选项、角色的对话后指令）排在它后面 ——
  // 角色口吻的提醒最容易把注意力拉回「写正文」，模型就把状态表整段丢了。
  // 实测（真实 API）：同一输入，面板段只在中同时约 1/4 的回合漏写状态表；
  // 末尾补这一句之后命中率明显上去。没有面板字段时不注入。
  // ---- 7b. 世界模式：主角不可代写 ----
  // 世界书里常有**同名角色**的第三人称设定（条目 + GM 名单副本），它们排在
  // 【主持规则】之后，离生成位置更近，会把模型拉回「主角也是 NPC、顺手替 TA 写了」。
  // 所以在这里再压一句 —— 但要让位给下面的状态表提醒，保持它是最后一条。
  if (gmMode) messages.push({ role: 'system', content: playerOwnershipReminder(me) });

  if (panelText) messages.push({ role: 'system', content: PANEL_PROMPT_REMINDER });

  return messages;
}

/**
 * 【表情】说明 —— 只在这个会话里有人配了「带情绪键的表情图」时才注入。
 *
 * 为什么不只给规则、还要把键列出来：光说「用 <emo>键</emo> 指定表情」，
 * 模型只能自己编英文词，键对不上等于没写。所以把现有的键连中文名一起列出来，
 * 它照着挑一个就行。
 *
 * 一张卡都没配（或者配的表情没填 key）时返回空串 —— 那些会话完全不受这条影响。
 */
function expressionInstruction(convo) {
  const rows = [];
  for (const entity of panelEntities(convo)) {
    const all = asArray(entity.card && entity.card.expressions);
    const list = all.filter((e) => e && e.key && e.image);
    if (!list.length) continue;
    rows.push(`- ${entity.name}：${list.map((e) => `${e.key}（${e.name}）`).join('、')}`);
  }
  if (!rows.length) return '';

  const lines = [
    '【表情】',
    '每轮回复的**最后一行**都单独带一个表情标签，格式：<emo>键</emo>（例如 <emo>shy</emo>），' +
      '挑一个最贴近这一轮情绪的。应用据此切换状态卡上的立绘。'
  ];
  if (rows.length > 1) {
    lines.push('场上不止一个人，写成「角色名 <emo>键</emo>」，标清楚是谁的表情。');
  }
  lines.push('可选键：', ...rows);
  lines.push('这个标签是给应用读的，不要写进正文的对白和描写里；键要照抄上面的拼写，别自己造词。');

  return lines.join('\n');
}
