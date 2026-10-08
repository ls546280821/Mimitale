'use strict';

// ============================================================================
//  main/providers.js —— 服务商与模型列表 + 设置（config.json）的读写
//
//  一个服务商 = 一套 地址 + Key + 模型列表。设置的「形状」归这里管：
//  默认值、归一化、旧版扁平配置的自动升级、API Key 的加解密。
//  通用 JSON 读写和加密原语在 main/store.js。
// ============================================================================

const {
  userDataFile,
  loadJsonWithFallback,
  writeJson,
  encryptApiKey,
  decryptApiKey
} = require('./store.js');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

// 内置的常见服务商预设：「添加服务商」时一键填充
const PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    key: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o']
  },
  {
    key: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo']
  },
  {
    key: 'kimi',
    name: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k']
  },
  {
    key: 'tavern-bridge',
    name: '本地 AI 桥接',
    baseUrl: 'http://127.0.0.1:8000',
    // 桥接服务走自己的 /chat_with_image 协议（非 OpenAI 兼容、免 Key），
    // 模型名对它无意义 —— 只是给界面一个看得过去的名字。
    models: ['本地模型'],
    type: 'tavern-bridge'
  },
  {
    key: 'custom',
    name: '自定义服务商',
    baseUrl: '',
    models: []
  }
];

// 所有预设里出现过的模型（去重），仅用于界面提示
const COMMON_MODELS = [...new Set(PROVIDER_PRESETS.flatMap((p) => p.models))];

const DEFAULT_PROVIDER_ID = 'p1';

// 对话窗口背景图的上限。压缩后一般也就几百 KB，这里给足余量，
// 但必须有上限 —— 否则一张大图能把 config.json 撑到几十 MB，
// 而这个文件每次改设置都要整份重写。
const MAX_CHAT_BACKGROUND_CHARS = 4000000;

// 「默认人设」正文的上限。它每轮都会拼进系统提示词，写太长会白白吃掉上下文，
// 所以给个够用又不至于失控的额度。
const MAX_ASSISTANT_PERSONA_CHARS = 20000;

// 角色「属性」的快捷候选词。
// 在角色编辑器里点一下就能多一个属性字段名，纯粹是省打字 —— 不承载任何逻辑，
// 所以它就是一个字符串数组，放在设置里可编辑就够了，不值得单开一套「管理」界面。
// （真到了需要给属性附加额外信息的时候 —— 类型、默认值、是否常驻 —— 那才值得升级。）
const DEFAULT_COMMON_ATTRIBUTES = [
  '金币', '生命', '体力', '心情', '好感度',
  '时间', '地点', '天气', '背包', '线索'
];

// 配色方案的可选值。渲染层 style.css 里每种都有一个 token 块，
// ui/theme.js 按这个顺序循环切换 —— 加新配色要改这里 + style.css + ui/theme.js + preload.js。
const ACCENTS = ['pink', 'blue', 'matcha'];

const DEFAULT_SETTINGS = {
  // 可以配置多个服务商，每个都有自己的地址、Key 和模型列表
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      name: 'DeepSeek',
      baseUrl: DEFAULT_BASE_URL,
      apiKey: '',
      models: ['deepseek-chat', 'deepseek-reasoner']
    }
  ],
  activeProviderId: DEFAULT_PROVIDER_ID,
  activeModel: DEFAULT_MODEL,
  temperature: 0.7,
  // 回复上限。推理模型（如 deepseek-flash/v4-pro）的**思考过程也计入这个额度**，
  // 设小了会出现「思考还没写完、正文一个字没出」的截断，所以默认给得宽一些。
  maxTokens: 8192,
  topP: 0.95,
  // 界面主题：light（白天）/ dark（夜间）
  theme: 'light',
  // 配色方案：pink（草莓奶昔）/ blue（苏打气泡）/ matcha（抹茶奶绿），与明暗模式正交
  accent: 'pink',
  sendOnEnter: true,
  showDate: true,
  showUsage: true,
  // 世界书递归扫描最多连锁几层。0 = 完全关掉递归。
  // 只有勾了「递归」的条目才会往下带，所以这个上限是第二道闸。
  worldbookRecursiveDepth: 3,
  // 最多把多少轮对话带进请求（1 轮 = 一问一答）。
  // 调大 = 记得更牢，但每轮都重发一遍，token 花得更多；再早的内容归「记忆摘要」管。
  // ⚠️ 这个值原来写死在 renderer/js/core/config.js 的 CONFIG.MAX_TURNS 里，
  //    2026-10-07 挪到设置 —— 它是「用户能明显感觉到」的项（记性好不好），不该藏在代码里。
  maxTurns: 20,
  // --- 生图（和聊天是两套：不同端点，通常也是不同模型）---
  imageProviderId: '',
  imageModel: '',
  imageSize: '1024x1024',
  // --- 语义检索（RAG）：又是一组独立配置，走 /embeddings ---
  ragEnabled: false,
  embeddingProviderId: '',
  embeddingModel: '',
  // --- 对话窗口外观（只影响显示，不进提示词）---
  chatFontSize: 14,     // 消息正文字号（px）
  chatBoldColor: '',    // **加粗** 用什么颜色，空 = 跟随主题
  chatBackground: '',   // 消息区背景图（dataURL），空 = 没有
  // --- 下面两个是界面自己写得出来的键，**必须列在这儿** ---
  // saveSettings 的白名单是「默认设置里有 or 磁盘上本来就有」。这两个键当初漏在
  // DEFAULT_SETTINGS 之外，靠的就是「用户磁盘上早写过了」才没被拦 ——
  // 全新装一份（config.json 里还没有它们）时，第一次保存就会被静默丢掉：
  // 快捷候选词和自动续写怎么改都不生效，只在主进程打一行看不见的 warn。
  autoContinue: true,       // 正文被 maxTokens 截断时自动接着写完
  commonAttributes: [],     // 角色编辑器里「属性」的快捷候选词
  // --- 默认人设：**没绑定角色卡**的会话（通用助手）用这一套，而且**按模型各存一份** ---
  // 换模型（推理写手 / 日常闲聊往往不是同一个模型）时人设跟着换，
  // 不用每次切完再回来改文字。
  // 结构：{ [模型名]: { name, persona } }；没有条目的模型 = 通用助手
  // （无人设 = 不扮演任何角色、也不提名字，见 renderer 的 data/cast.js）。
  // 绑了角色卡的会话一律用那张卡自己的设定，这个键完全不参与。
  assistantPersonas: {}
};

function newProviderId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
}

/** 把任意来源的服务商对象整理成统一形状 */
function normalizeProvider(raw, fallbackId) {
  const p = raw && typeof raw === 'object' ? raw : {};

  const models = Array.isArray(p.models)
    ? p.models
    : String(p.models || '').split(/[\n,，]/);

  return {
    id: p.id || fallbackId || newProviderId(),
    name: String(p.name || '').trim() || '未命名服务商',
    baseUrl: String(p.baseUrl || '').trim() || DEFAULT_BASE_URL,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : '',
    models: [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))],
    // 服务商协议类型：'openai' 是默认的 OpenAI 兼容协议；'tavern-bridge'
    // 是本机酒馆桥接服务（/chat_with_image，免 Key、非流式）。
    type: p.type === 'tavern-bridge' ? 'tavern-bridge' : 'openai'
  };
}

/** 是不是本机酒馆桥接服务商（协议与 OpenAI 兼容那套完全不同） */
function isBridgeProvider(provider) {
  return !!(provider && provider.type === 'tavern-bridge');
}

/**
 * 把磁盘上的设置整理成当前版本的结构。
 * 旧版本只有一个扁平的 baseUrl/apiKey/model，这里会自动升级成「一个服务商」。
 */
function normalizeSettings(saved) {
  const raw = saved && typeof saved === 'object' ? saved : {};
  const s = { ...DEFAULT_SETTINGS, ...raw };

  // 注意：判断的是「磁盘上有没有 providers」，不能看合并后的 s ——
  // 因为 DEFAULT_SETTINGS 自带 providers，合并后永远有，旧配置就永远进不了迁移分支。
  const hasProviders = Array.isArray(raw.providers) && raw.providers.length > 0;

  if (!hasProviders) {
    // ---- 旧版扁平配置（或全新安装）：整体搬进 providers[0] ----
    const legacyUrl = String(raw.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const preset = PROVIDER_PRESETS.find(
      (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === legacyUrl
    );
    const legacyModels = [raw.model].filter(Boolean);
    // 自定义地址匹配不到预设时，别硬套「DeepSeek」这个名字
    const fallbackName = raw.baseUrl ? '自定义服务商' : DEFAULT_SETTINGS.providers[0].name;

    s.providers = [
      normalizeProvider(
        {
          id: DEFAULT_PROVIDER_ID,
          name: preset ? preset.name : fallbackName,
          baseUrl: raw.baseUrl || DEFAULT_BASE_URL,
          apiKey: raw.apiKey || '',
          // 旧配置里没写模型就用默认列表，别留下一个空列表
          models: legacyModels.length ? legacyModels : [...DEFAULT_SETTINGS.providers[0].models]
        },
        DEFAULT_PROVIDER_ID
      )
    ];
    s.activeProviderId = DEFAULT_PROVIDER_ID;
    s.activeModel = raw.model || DEFAULT_SETTINGS.activeModel;
  } else {
    s.providers = s.providers.map((p, i) => normalizeProvider(p, `p${i + 1}`));
  }

  // 当前服务商必须真实存在
  if (!s.providers.some((p) => p.id === s.activeProviderId)) {
    s.activeProviderId = s.providers[0].id;
  }

  // 当前模型必须真实存在，否则退回第一个可用模型
  const allModels = s.providers.flatMap((p) => p.models);
  if (!s.activeModel || !allModels.includes(s.activeModel)) {
    const current = s.providers.find((p) => p.id === s.activeProviderId);
    s.activeModel = current.models[0] || allModels[0] || DEFAULT_MODEL;
  }

  // 让「当前服务商」跟着「当前模型」走 —— 但要**先尊重已经选好的那一对**。
  //
  // 模型名在各个服务商之间是会重的（默认列表里 deepseek-chat 到处都是），
  // 原来的写法是 `s.providers.find((p) => p.models.includes(s.activeModel))`，
  // 也就是「谁第一个有这个模型名就是谁」：用户在顶栏显式切到 B 服务商，
  // 只要 A 也列着同一个模型名，保存时就被静默改回 A ——
  // 新会话、以及所有回落到全局默认的地方都用了 B 的地址和 Key，
  // 表现是「刚切过去，新建一条又回去了」，而且不报错。
  const current = s.providers.find((p) => p.id === s.activeProviderId);
  const currentHasModel = !!(current && current.models.includes(s.activeModel));
  if (!currentHasModel) {
    // 当前服务商确实没有这个模型 → 才去找有它的那家
    const owner = s.providers.find((p) => p.models.includes(s.activeModel));
    if (owner) {
      s.activeProviderId = owner.id;
    } else if (current) {
      current.models = [s.activeModel, ...current.models];
    }
  }

  // 界面主题
  s.theme = raw.theme === 'dark' ? 'dark' : 'light';

  // 配色方案（不认识的值退回默认粉）
  s.accent = ACCENTS.includes(raw.accent) ? raw.accent : 'pink';

  // 生图：和聊天完全分开的一组配置，所以这里只做格式清洗，
  // 不存在的服务商 id 就留着 —— 用户可能还没保存那个服务商
  s.imageProviderId = typeof raw.imageProviderId === 'string' ? raw.imageProviderId.trim().slice(0, 60) : '';
  s.imageModel = typeof raw.imageModel === 'string' ? raw.imageModel.trim().slice(0, 120) : '';
  const imgSize = String(raw.imageSize || '').trim();
  // 尺寸各家不一样，不写死白名单，只要求是「数字x数字」
  s.imageSize = /^\d{2,4}x\d{2,4}$/i.test(imgSize) ? imgSize.toLowerCase() : DEFAULT_SETTINGS.imageSize;

  // 语义检索：默认关。开着的时候每一轮都要多调一次向量接口，
  // 而且第一轮还要给历史消息补索引 —— 得让用户明确知道自己在花这份钱
  s.ragEnabled = raw.ragEnabled === true;
  s.embeddingProviderId = typeof raw.embeddingProviderId === 'string' ? raw.embeddingProviderId.trim().slice(0, 60) : '';
  s.embeddingModel = typeof raw.embeddingModel === 'string' ? raw.embeddingModel.trim().slice(0, 120) : '';

  // 世界书递归深度：0 表示关掉递归（就算条目勾了也不连锁）
  const depth = Number(raw.worldbookRecursiveDepth);
  s.worldbookRecursiveDepth =
    Number.isFinite(depth) && depth >= 0 && depth <= 5
      ? Math.floor(depth)
      : DEFAULT_SETTINGS.worldbookRecursiveDepth;

  // 带进请求的对话轮数。上限给得宽（200 轮）：这是用户自己的选择，
  // 拦太死反而像 bug；只管住下限和「不是个数」的情况。
  const turns = Number(raw.maxTurns);
  s.maxTurns =
    Number.isFinite(turns) && turns >= 1 && turns <= 200
      ? Math.floor(turns)
      : DEFAULT_SETTINGS.maxTurns;

  // 对话窗口外观。这三个都只影响显示，所以「值不合法就退回默认」是安全的。
  const fontSize = Number(raw.chatFontSize);
  s.chatFontSize =
    Number.isFinite(fontSize) && fontSize >= 12 && fontSize <= 22
      ? Math.round(fontSize)
      : DEFAULT_SETTINGS.chatFontSize;

  const boldColor = typeof raw.chatBoldColor === 'string' ? raw.chatBoldColor.trim() : '';
  // 只收 #rgb / #rrggbb / #rrggbbaa，别的（比如 'red'）一律当没设过 ——
  // 免得有人往里塞 `red; background:url(...)` 这种东西
  s.chatBoldColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(boldColor) ? boldColor : '';

  const bg = typeof raw.chatBackground === 'string' ? raw.chatBackground : '';
  s.chatBackground =
    bg.startsWith('data:image/') && bg.length <= MAX_CHAT_BACKGROUND_CHARS ? bg : '';

  // 常用属性候选词：去重、去空、限个数。
  // 注意判断的是「磁盘上有没有这个键」—— 用户把清单清空是合法操作，
  // 不能因为合并结果为空就又把默认值塞回去。
  const rawAttrs = Array.isArray(raw.commonAttributes) ? raw.commonAttributes : DEFAULT_COMMON_ATTRIBUTES;
  const seenAttrs = new Set();
  s.commonAttributes = rawAttrs
    .filter((n) => typeof n === 'string')
    .map((n) => n.trim().slice(0, 24))
    .filter((n) => {
      if (!n || seenAttrs.has(n)) return false;
      seenAttrs.add(n);
      return true;
    })
    .slice(0, 40);

  // 默认人设：按模型各存一份（没绑角色卡的会话用）。
  // 逐条过一遍，只留形状对的：
  //   · 键（模型名）为空 / 超长的丢掉；
  //   · 名字和人设**都为空**的条目直接丢弃 —— 那是一条没意义的空壳，
  //     留着只会在 config.json 里越积越多；
  //   · 只有人设没名字是合法的（按「不留假名」的口径处理，见 data/cast.js 的 assistantName）。
  // 「人设留空」本身也是合法状态（= 不扮演角色），所以这里不做「空就填默认」。
  const personas = {};
  const rawPersonas = raw.assistantPersonas;
  if (rawPersonas && typeof rawPersonas === 'object' && !Array.isArray(rawPersonas)) {
    for (const [key, value] of Object.entries(rawPersonas)) {
      const model = String(key || '').trim().slice(0, 120);
      if (!model) continue;
      const entry = value && typeof value === 'object' ? value : {};
      const name = String(entry.name || '').trim().slice(0, 40);
      const persona =
        typeof entry.persona === 'string'
          ? entry.persona.trim().slice(0, MAX_ASSISTANT_PERSONA_CHARS)
          : '';
      if (!name && !persona) continue;
      personas[model] = { name, persona };
    }
  }
  s.assistantPersonas = personas;

  // 清掉旧版本的扁平字段，避免文件里同时存在两套数据
  delete s.baseUrl;
  delete s.apiKey;
  delete s.model;
  // 早期版本在设置里存过一份「全局人设」（键名 systemPrompt / userName），那时的语义是
  // 「所有会话的人设」。现在的人设只走角色卡，没绑卡的会话则由上面的
  // assistantPersonas 兜底 —— 两者不是一回事，留着会在文件里积两套数据。
  //
  // ⚠️ 这里**不能**再 delete s.maxTurns：它以前是上面的扁平字段（那会儿确实是废键），
  //    但 2026-10-07 起 maxTurns 已经变成真正的设置项（见 DEFAULT_SETTINGS 和上面的
  //    归一化）。留着这一行会把刚归一化好的值当场删掉，症状是「设置里改对话轮数
  //    怎么改都不生效、一存就变回 20」—— 而且因为键还在 DEFAULT_SETTINGS 里，
  //    保存白名单也拦不住，整条链路一声不响。
  delete s.systemPrompt;
  delete s.userName;

  return s;
}

/** 取出指定服务商；找不到就退回当前 / 第一个 */
function resolveProvider(settings, providerId) {
  const list = Array.isArray(settings.providers) ? settings.providers : [];
  if (!list.length) return null;
  return (
    list.find((p) => p.id === providerId) ||
    list.find((p) => p.id === settings.activeProviderId) ||
    list[0]
  );
}

/** 把「服务商 + 模型」拼成 streamChat 需要的扁平设置 */
function endpointFor(settings, providerId, model) {
  const provider = resolveProvider(settings, providerId);
  if (!provider) return null;

  const chosen =
    String(model || '').trim() || provider.models[0] || settings.activeModel || DEFAULT_MODEL;

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: chosen,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    topP: settings.topP
  };
}

function loadSettings() {
  const saved = loadJsonWithFallback(userDataFile('config.json')) || {};
  const settings = normalizeSettings(saved);

  // 内存里永远保存明文 Key
  settings.providers = settings.providers.map((p) => ({
    ...p,
    apiKey: p.apiKey ? decryptApiKey(p.apiKey) : ''
  }));

  return settings;
}

function saveSettings(patch) {
  const current = loadSettings();

  // 白名单：只收「默认设置里有」或者「磁盘上本来就有」的键。
  // 没有这道闸的话，渲染层（或者任何能调到这个 IPC 通道的人）随手塞一个键进来，
  // 就会被 normalizeSettings 里的 `{ ...DEFAULT_SETTINGS, ...raw }` 永久写进
  // config.json —— 不影响逻辑，但配置会越存越脏。
  const clean = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (key in DEFAULT_SETTINGS || key in current) clean[key] = value;
    else console.warn(`保存设置时忽略了未知字段「${key}」`);
  }

  const merged = normalizeSettings({ ...current, ...clean });

  // 落盘前把每个服务商的 Key 都加密
  const toSave = {
    ...merged,
    providers: merged.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? encryptApiKey(p.apiKey) : ''
    }))
  };

  writeJson(userDataFile('config.json'), toSave);
  return merged; // 返回明文版本供界面使用
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  PROVIDER_PRESETS,
  COMMON_MODELS,
  DEFAULT_SETTINGS,
  ACCENTS,
  normalizeProvider,
  normalizeSettings,
  resolveProvider,
  endpointFor,
  isBridgeProvider,
  loadSettings,
  saveSettings
};
