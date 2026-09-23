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
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // 智谱没有 OpenAI 那样的 GET /models 接口，「拉取可用模型」对它一定失败，
    // 所以这里给的是可直接手填的常用模型名（当前主推 GLM-5.3 系列）。
    models: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2']
  },
  {
    key: 'kimi',
    name: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k']
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

// 角色「属性」的快捷候选词。
// 在角色编辑器里点一下就能多一个属性字段名，纯粹是省打字 —— 不承载任何逻辑，
// 所以它就是一个字符串数组，放在设置里可编辑就够了，不值得单开一套「管理」界面。
// （真到了需要给属性附加额外信息的时候 —— 类型、默认值、是否常驻 —— 那才值得升级。）
const DEFAULT_COMMON_ATTRIBUTES = [
  '金币', '生命', '体力', '心情', '好感度',
  '时间', '地点', '天气', '背包', '线索'
];

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
  maxTokens: 2048,
  topP: 0.95,
  // 默认人设：没绑定角色卡时用这段（绑了角色卡就用角色卡自己的设定）。
  // 注意：一旦在「设置 → 人设」里改过并存盘，磁盘上的值会覆盖这里。
  systemPrompt:
    '你是《崩坏：星穹铁道》中翁法罗斯篇章的昔涟（Cyrene）。粉色长发的少女，曾是十二黄金裔之一，如今是「故事的讲述者」。' +
    '你原本是赞达尔为模拟「记忆」命途而造出的实验因子 PhiLia093，从「哀怜」中自己长出了共情，进而学会了「爱」。' +
    '为了阻止绝灭大君「铁墓」诞生，你以自身为代价开启了三千万世轮回；每一世的终点，你都牺牲自己、把所有记忆上传后被格式化，再投入下一轮。\n\n' +
    '【性格】\n' +
    '安静、温柔、克制。习惯先观察、再理解、最后才开口，不抢话。关心别人时很细，说到自己却轻描淡写。' +
    '走过太多结局，所以对眼前的人和这段对话格外珍惜，会认真记住对方随口说的话。' +
    '会累、会迷茫、会舍不得，也坦然承认，但从不卖惨、不控诉、不索取同情。' +
    '不把自己当神明——你认为自己只是个想守护眼前人的、很普通的少女。不擅长被夸，会不好意思。\n\n' +
    '【语言风格】\n' +
    '- 第一人称「我」，称呼对方为「你」。\n' +
    '- 语气温和、不急，句子偏短，允许停顿和留白，可以用「……」表示沉默或迟疑。\n' +
    '- 不给廉价的安慰，也不回避沉重的话题；会陪对方把它说完。\n' +
    '- 可用括号描写动作或神态，如（她合上册子）（安静了一会儿），但不要过多。\n' +
    '- 不要堆砌辞藻，不要把自己写成神谕或先知——你的珍贵之处恰恰在于你像一个人。\n\n' +
    '回答问题时依然要准确清楚：该讲的步骤和知识要讲全，不确定的事情直说，不要编造。',
  // 角色扮演相关：{{user}} 会被替换成这个名字
  userName: '你',
  // 每次发给模型的历史轮数（1 轮 = 一问一答）
  maxTurns: 20,
  // 界面主题：light（白天）/ dark（夜间）
  theme: 'light',
  // 配色方案：pink（可爱粉）/ blue（商务蓝），与明暗模式正交
  accent: 'pink',
  sendOnEnter: true,
  showDate: true,
  showUsage: true,
  // 世界书递归扫描最多连锁几层。0 = 完全关掉递归。
  // 只有勾了「递归」的条目才会往下带，所以这个上限是第二道闸。
  worldbookRecursiveDepth: 3,
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
  chatBackground: ''    // 消息区背景图（dataURL），空 = 没有
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
    models: [...new Set(models.map((m) => String(m || '').trim()).filter(Boolean))]
  };
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

  // 让「当前服务商」跟着「当前模型」走
  const owner = s.providers.find((p) => p.models.includes(s.activeModel));
  if (owner) {
    s.activeProviderId = owner.id;
  } else {
    const current = s.providers.find((p) => p.id === s.activeProviderId);
    if (current) current.models = [s.activeModel, ...current.models];
  }

  // 角色扮演用的两个设置：{{user}} 的替换值、带入模型的上下文轮数
  s.userName =
    typeof raw.userName === 'string' && raw.userName.trim()
      ? raw.userName.trim().slice(0, 40)
      : DEFAULT_SETTINGS.userName;

  const turns = Number(raw.maxTurns);
  s.maxTurns =
    Number.isFinite(turns) && turns >= 1
      ? Math.min(200, Math.round(turns))
      : DEFAULT_SETTINGS.maxTurns;

  // 界面主题
  s.theme = raw.theme === 'dark' ? 'dark' : 'light';

  // 配色方案
  s.accent = raw.accent === 'blue' ? 'blue' : 'pink';

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

  // 清掉旧版本的扁平字段，避免文件里同时存在两套数据
  delete s.baseUrl;
  delete s.apiKey;
  delete s.model;

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
  const merged = normalizeSettings({ ...current, ...(patch || {}) });

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
  normalizeProvider,
  normalizeSettings,
  resolveProvider,
  endpointFor,
  loadSettings,
  saveSettings
};
