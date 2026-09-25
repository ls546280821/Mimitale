// ---------------------------------------------------------------------------
//  设置弹窗（含服务商编辑 / 生图 / 语义检索 / 模型目录兜底）
//
//  两处刻意的边界：
//
//   · 「保存设置后重绘消息」和「右上角的模型切换器」都留在入口层 ——
//     前者是聊天区的活、后者读的是会话状态，本模块不认识它们，所以通过
//     initSettings 注入（refreshModelSwitch / afterSettingsSave）。
//     「对话头部」不在此列：views/header.js 只依赖 core / data，可以直接单向 import。
//
//   · openSettings 必须导出：发消息前发现没配模型、点「配图」发现没配生图时，
//     那两个流程（都在入口层）要弹这个设置窗。
//
//  弹窗只在打开时渲染，不参与整体重绘，所以不向刷新总线登记
//  （和 views/perspectiveUi.js 一样，只做事件绑定）。
//
//  Esc 关弹窗那一条**没搬过来**：它在入口层的 Esc 判断链里有固定顺序
//  （确认框 → 玩家弹窗 → 角色选择 → 角色编辑器 → 设置 → 外观），
//  拆成两个监听器会让这条顺序失效。
// ---------------------------------------------------------------------------

import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { providers, providerById } from '../data/providers.js';
import { renderHeader } from './header.js';

/** 设置弹窗里当前正在编辑的服务商 */
let editingProviderId = null;

// --- 入口层注入的重绘动作 ---
// refreshModelSwitch()：右上角「当前模型」切换器（服务商 / 模型列表改了要重画）
// afterSettingsSave()：保存后除了切换器，还得重绘消息 ——
//   有些东西是**跟着设置走的**：日期分隔（showDate）、以及「配图」按钮要不要出现
//   （配了生图才有）。不重绘的话会出现「配好了生图但消息上没有按钮」，
//   非得切个会话才出来。
let refreshModelSwitch = () => {};
let afterSettingsSave = () => {};

export function initSettings(opts = {}) {
  if (typeof opts.refreshModelSwitch === 'function') refreshModelSwitch = opts.refreshModelSwitch;
  if (typeof opts.afterSettingsSave === 'function') afterSettingsSave = opts.afterSettingsSave;

  el.btnSettings.addEventListener('click', openSettings);
  el.btnCloseSettings.addEventListener('click', closeSettings);
  el.btnSaveSettings.addEventListener('click', () => saveSettings(false));
  el.btnTest.addEventListener('click', testConnection);
  el.btnFetchModels.addEventListener('click', fetchModels);

  // 换服务商 → 模型下拉跟着换（新服务商的列表里没有老模型，所以从第一个开始）
  el.s.imageProvider.addEventListener('change', () => {
    const provider = providerById(el.s.imageProvider.value);
    // 并上内置生图模型：服务商的模型列表里往往只有文本模型，
    // 不并的话用户在下拉里找不到 glm-image 这种能生图的模型
    fillModelSelect(
      el.s.imageModel,
      el.s.imageProvider.value,
      '',
      '（先在左边选一个服务商）',
      false,
      imageCatalogModels(el.s.imageProvider.value)
    );
    preferImageModel(provider);
    // 换了模型，尺寸的可选项也要跟着换
    fillImageSizeOptions(el.s.imageModel.value, el.s.imageSize.value);
  });

  // 换生图模型 → 尺寸可选项跟着换（不同模型支持的尺寸不一样）
  el.s.imageModel.addEventListener('change', () => {
    fillImageSizeOptions(el.s.imageModel.value, el.s.imageSize.value);
  });

  el.s.embeddingProvider.addEventListener('change', () => {
    fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, '', '（先在上面选一个服务商）', false);
  });

  // 「＋ 添加服务商」展开预设列表
  el.btnAddProvider.addEventListener('click', () => {
    const hidden = el.providerPresets.classList.toggle('hidden');
    el.btnAddProvider.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });

  el.btnDelProvider.addEventListener('click', removeProvider);


  el.modal.addEventListener('click', (event) => {
    if (event.target === el.modal) closeSettings();
  });
}

/** 启动时把「当前服务商」带进设置弹窗（入口层拿到配置之后调） */
export function setEditingProvider(id) {
  editingProviderId = id || null;
}

// ---------------------------------------------------------------------------
//  设置弹窗
// ---------------------------------------------------------------------------

/**
 * 填一个「模型」下拉。
 *
 * 模型从哪来？就是对应服务商的「可用模型」那一份列表 —— 所以**选了服务商才知道有哪些能选**，
 * 换服务商得跟着重填。这也是聊天那边模型下拉的同一份数据。
 *
 * keepMissing：保存过的模型不在列表里时怎么办。
 *   · 打开设置时 true —— 补一个选项摆在那儿，免得一打开就被静默改掉
 *     （换了服务商、或者列表被人删过，都会出现这种情况）
 *   · 用户主动换服务商时 false —— 老服务商的模型名在新服务商这儿没有意义，直接选第一个
 */
/**
 * 给模型下拉填选项。
 *
 * catalogModels：可选，把内置目录里的模型也并进来（标注「内置」）。
 * 生图那一组用得上 —— 服务商的模型列表里通常只有文本模型，
 * 不并进来的话用户根本选不到 glm-image 这种生图模型。
 * 只在界面上多给几个选项，不会去改用户的服务商配置。
 */
function fillModelSelect(select, providerId, current, emptyHint, keepMissing = true, catalogModels = null) {
  clear(select);

  const provider = providerById(providerId);
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const extra = (Array.isArray(catalogModels) ? catalogModels : []).filter((m) => m && !models.includes(m));
  const all = [...models, ...extra];
  const value = String(current || '').trim();

  if (!all.length) {
    select.appendChild(h('option', { value: '', text: emptyHint }));
    select.disabled = true;
    return;
  }

  select.disabled = false;

  // 存过的值不在列表里（既不在服务商配置、也不在目录）也保留，别让用户的选择凭空消失
  if (keepMissing && value && !all.includes(value)) {
    select.appendChild(h('option', { value, text: `${value}（不在列表里）` }));
  }

  for (const model of models) {
    select.appendChild(h('option', { value: model, text: model }));
  }
  for (const model of extra) {
    select.appendChild(h('option', { value: model, text: `${model}（内置）` }));
  }

  // 有保存过的就用它；没有就挑第一个，别让下拉是空的
  select.value = value || all[0];
}

function fillSettingsForm(settings) {
  el.s.temp.value = settings.temperature ?? 0.7;
  el.s.maxTokens.value = settings.maxTokens ?? 2048;
  el.s.userName.value = settings.userName || '你';
  el.s.maxTurns.value = settings.maxTurns ?? CONFIG.MAX_TURNS;
  el.s.system.value = settings.systemPrompt || '';
  el.s.sendOnEnter.checked = settings.sendOnEnter !== false;
  el.s.showDate.checked = settings.showDate !== false;
  el.s.showUsage.checked = settings.showUsage !== false;
  el.s.autoContinue.checked = settings.autoContinue !== false;
  el.s.wbDepth.value = String(
    Number.isFinite(Number(settings.worldbookRecursiveDepth)) ? Number(settings.worldbookRecursiveDepth) : 3
  );
  el.s.commonAttrs.value = (Array.isArray(settings.commonAttributes) ? settings.commonAttributes : []).join(', ');

  // 生图：下拉里放一个「不启用」+ 所有服务商
  clear(el.s.imageProvider);
  el.s.imageProvider.appendChild(h('option', { value: '', text: '（不启用生图）' }));
  for (const provider of providers()) {
    el.s.imageProvider.appendChild(h('option', { value: provider.id, text: provider.name }));
  }
  el.s.imageProvider.value = providers().some((p) => p.id === settings.imageProviderId)
    ? settings.imageProviderId
    : '';
  el.s.imageModel.value = settings.imageModel || '';
  // 生图模型下拉要并上内置目录 —— 服务商的模型列表里通常只有文本模型，
  // 不并的话用户根本选不到 glm-image 这种生图模型
  fillModelSelect(
    el.s.imageModel,
    el.s.imageProvider.value,
    settings.imageModel,
    '（先在左边选一个服务商）',
    true,
    imageCatalogModels(el.s.imageProvider.value)
  );
  // 尺寸的可选项跟着生图模型走，且会纠正该模型不支持的旧值
  fillImageSizeOptions(el.s.imageModel.value, settings.imageSize);

  // 语义检索：同样是一个「不启用」+ 全部服务商
  el.s.ragEnabled.checked = settings.ragEnabled === true;
  clear(el.s.embeddingProvider);
  el.s.embeddingProvider.appendChild(h('option', { value: '', text: '（不选）' }));
  for (const provider of providers()) {
    el.s.embeddingProvider.appendChild(h('option', { value: provider.id, text: provider.name }));
  }
  el.s.embeddingProvider.value = providers().some((p) => p.id === settings.embeddingProviderId)
    ? settings.embeddingProviderId
    : '';
  fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, settings.embeddingModel, '（先在上面选一个服务商）');
}

// ------------------------------ 服务商编辑 ------------------------------

function parseModels(text) {
  return [...new Set(String(text || '').split(/[\n,，]/).map((m) => m.trim()).filter(Boolean))];
}

/** 把表单里当前编辑的服务商写回内存（还没落盘） */
function stashProviderForm() {
  const p = providerById(editingProviderId);
  if (!p) return;
  p.name = el.p.name.value.trim() || p.name || '未命名服务商';
  p.baseUrl = el.p.baseUrl.value.trim() || p.baseUrl;
  p.apiKey = el.p.apiKey.value.trim();
  p.models = parseModels(el.p.models.value);
}

/** 把内存里的服务商填进表单 */
function fillProviderForm() {
  const p = providerById(editingProviderId);
  el.p.name.value = p ? p.name || '' : '';
  el.p.baseUrl.value = p ? p.baseUrl || '' : '';
  el.p.apiKey.value = p ? p.apiKey || '' : '';
  el.p.models.value = p ? (p.models || []).join('\n') : '';
  el.btnDelProvider.disabled = providers().length <= 1;
}

function renderProviderTabs() {
  el.providerTabs.innerHTML = '';

  for (const p of providers()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `provider-tab${p.id === editingProviderId ? ' active' : ''}`;
    btn.textContent = p.name || '未命名';
    btn.title = p.apiKey ? `${p.name}（已填 Key）` : `${p.name}（还没有填 API Key）`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', p.id === editingProviderId ? 'true' : 'false');

    btn.addEventListener('click', () => {
      if (p.id === editingProviderId) return;
      stashProviderForm();
      editingProviderId = p.id;
      renderProviderTabs();
      fillProviderForm();
    });

    el.providerTabs.appendChild(btn);
  }
}

function renderPresets() {
  el.providerPresets.innerHTML = '';

  for (const preset of state.presets || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip';
    btn.textContent = preset.name;
    btn.title = preset.baseUrl ? preset.baseUrl : '自己填写接口地址';
    btn.addEventListener('click', () => addProvider(preset));
    el.providerPresets.appendChild(btn);
  }
}

function addProvider(preset) {
  stashProviderForm();

  const provider = {
    id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`,
    name: preset.name || '新服务商',
    baseUrl: preset.baseUrl || '',
    apiKey: '',
    models: [...(preset.models || [])]
  };

  state.settings.providers = [...providers(), provider];
  editingProviderId = provider.id;

  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  renderProviderTabs();
  fillProviderForm();

  showToast(`已添加「${provider.name}」，填入 API Key 后点保存`, 'ok');
  el.p.apiKey.focus();
}

async function removeProvider() {
  const provider = providerById(editingProviderId);
  if (!provider) return;

  if (providers().length <= 1) {
    showToast('至少要保留一个服务商', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: '删除服务商',
    message: `删除「${provider.name}」？它的 API Key 和模型列表会一起删掉。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  state.settings.providers = providers().filter((p) => p.id !== provider.id);
  const next = state.settings.providers[0];
  editingProviderId = next.id;

  // 删掉的正好是当前用的服务商，就切到剩下的第一个
  if (state.settings.activeProviderId === provider.id) {
    state.settings.activeProviderId = next.id;
    state.settings.activeModel = next.models[0] || '';
  }

  // 关键：先把表单切到下一个服务商。
  // 否则紧接着的 saveSettings → stashProviderForm 会拿被删服务商的旧表单值
  // 覆盖掉幸存服务商的名称 / 地址 / API Key。
  renderProviderTabs();
  fillProviderForm();

  await saveSettings(true);
  showToast(`已删除「${provider.name}」`);
}

// ------------------------------ 保存 ------------------------------

function readSettingsForm() {
  stashProviderForm();

  const temp = Number(el.s.temp.value);
  const maxTokens = Number(el.s.maxTokens.value);
  const maxTurns = Number(el.s.maxTurns.value);
  const name = el.s.userName.value.trim();

  return {
    providers: providers(),
    activeProviderId: (state.settings || {}).activeProviderId,
    activeModel: (state.settings || {}).activeModel,
    temperature: isNaN(temp) ? 0.7 : Math.max(0, Math.min(2, temp)),
    maxTokens: isNaN(maxTokens) ? 2048 : Math.max(64, Math.min(32000, maxTokens)),
    userName: name || '你',
    maxTurns: isNaN(maxTurns) ? CONFIG.MAX_TURNS : Math.max(1, Math.min(200, Math.round(maxTurns))),
    systemPrompt: el.s.system.value,
    sendOnEnter: el.s.sendOnEnter.checked,
    showDate: el.s.showDate.checked,
    showUsage: el.s.showUsage.checked,
    autoContinue: el.s.autoContinue.checked,
    worldbookRecursiveDepth: (() => {
      const depth = Number(el.s.wbDepth.value);
      return Number.isFinite(depth) ? Math.max(0, Math.min(5, Math.floor(depth))) : 3;
    })(),
    imageProviderId: el.s.imageProvider.value || '',
    imageModel: el.s.imageModel.value.trim(),
    imageSize: el.s.imageSize.value || '',
    ragEnabled: el.s.ragEnabled.checked,
    embeddingProviderId: el.s.embeddingProvider.value || '',
    embeddingModel: el.s.embeddingModel.value.trim(),
    // 和「服务商模型列表」一样是「分隔符拆开的字符串列表」，直接复用那个解析
    commonAttributes: parseModels(el.s.commonAttrs.value).slice(0, 40)
  };
}

export function openSettings() {
  if (!editingProviderId || !providerById(editingProviderId)) {
    editingProviderId = (state.settings || {}).activeProviderId || (providers()[0] || {}).id;
  }

  fillSettingsForm(state.settings || {});
  renderProviderTabs();
  fillProviderForm();
  renderPresets();
  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  el.modal.classList.remove('hidden');

  const current = providerById(editingProviderId);
  if (current && current.apiKey) {
    el.s.temp.focus();
  } else {
    el.p.baseUrl.focus();
  }
}

export function closeSettings() {
  el.modal.classList.add('hidden');
}

async function saveSettings(silent) {
  const patch = readSettingsForm();

  try {
    state.settings = await api.saveSettings(patch);
  } catch (err) {
    showToast((err && err.message) || '保存失败', 'error');
    return state.settings;
  }

  // 主进程可能重新整理了服务商，这里同步回界面
  if (!providerById(editingProviderId)) {
    editingProviderId = state.settings.activeProviderId;
  } else {
    editingProviderId = providerById(editingProviderId).id;
  }
  renderProviderTabs();
  fillProviderForm();

  if (!silent) {
    showToast('设置已保存', 'ok');
    closeSettings();
  }

  renderHeader();
  // renderModelSwitch + renderMessages 都在入口层，一并交给它（见文件头）
  afterSettingsSave();

  return state.settings;
}

/**
 * 各服务商的已知模型目录。
 *
 * 用途：「拉取可用模型」走的是 OpenAI 那套 GET /models，但不少国内服务商
 * 根本没有这个接口（智谱就是），请求会被网关拒掉（常见 406）。
 * 这种情况下不能让用户卡死在一个看不懂的错误码上，所以给一份内置目录兜底。
 *
 * 按接口地址里的域名匹配，而不是按服务商名字 —— 名字用户可以随便改。
 *
 * imageModels 是「生图」那一组能用的模型。文本模型不能拿来生图，
 * 选错了接口会报 404 —— 这个坑很容易踩，所以单独列出来。
 */
const MODEL_CATALOG = [
  {
    match: /bigmodel\.cn/i,
    name: '智谱 GLM',
    note: '智谱没有「模型列表」接口，请从下面挑一个填进去',
    models: ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-flashx', 'glm-5.2'],
    imageModels: ['glm-image', 'cogview-4-250304', 'cogview-4', 'cogview-3-flash']
  },
  {
    match: /dashscope\.aliyuncs\.com/i,
    name: '通义千问',
    note: '通义的 OpenAI 兼容模式对部分 Key 不返回模型列表，可先手填',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    imageModels: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1']
  },
  {
    match: /moonshot\.cn/i,
    name: 'Kimi',
    note: 'Moonshot 支持模型列表；若拉取失败可从下面挑',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    imageModels: []
  },
  {
    match: /deepseek\.com/i,
    name: 'DeepSeek',
    note: 'DeepSeek 支持模型列表；若拉取失败可从下面挑',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // DeepSeek 目前没有生图模型
    imageModels: []
  },
  {
    match: /openai\.com/i,
    name: 'OpenAI',
    note: 'OpenAI 支持模型列表；若拉取失败可从下面挑',
    models: ['gpt-4o-mini', 'gpt-4o'],
    imageModels: ['gpt-image-1', 'dall-e-3']
  }
];

function catalogForBaseUrl(baseUrl) {
  const url = String(baseUrl || '');
  return MODEL_CATALOG.find((c) => c.match.test(url)) || null;
}

/** 某个服务商的内置生图模型（用来并进生图模型下拉） */
function imageCatalogModels(providerId) {
  const provider = providerById(providerId);
  if (!provider) return [];
  const catalog = catalogForBaseUrl(provider.baseUrl);
  return catalog && Array.isArray(catalog.imageModels) ? catalog.imageModels : [];
}

/**
 * 各生图模型支持的图片尺寸。
 *
 * 这个必须按模型区分：智谱 glm-image 只认固定的 7 个尺寸（默认 1280x1280），
 * 而本应用早期一律发 1024x1024，于是被接口拒掉（智谱错误码 1210「参数有误」）。
 * 参数来自智谱官方 OpenAPI 的 CreateImageRequest.size 说明。
 */
const IMAGE_SIZE_RULES = [
  {
    match: /^glm-image$/i,
    label: 'GLM-Image',
    sizes: ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'],
    custom: { min: 1024, max: 2048, step: 32 },
    note: '默认 1280x1280。自定义需在 1024-2048 之间、且是 32 的整数倍'
  },
  {
    match: /^cogview/i,
    label: 'CogView',
    sizes: ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'],
    custom: { min: 512, max: 2048, step: 16 },
    note: '默认 1024x1024。自定义需在 512-2048 之间、且是 16 的整数倍'
  }
];

const DEFAULT_IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512'];

function imageSizeRule(model) {
  const name = String(model || '').trim();
  return IMAGE_SIZE_RULES.find((r) => r.match.test(name)) || null;
}

/** 某个生图模型可选的尺寸列表 */
function sizesForImageModel(model) {
  const rule = imageSizeRule(model);
  return rule ? rule.sizes : DEFAULT_IMAGE_SIZES;
}

/** 尺寸是否合法：已知模型按规则校验，未知模型只做基本格式检查 */
function isValidImageSize(model, size) {
  const value = String(size || '').trim().toLowerCase();
  if (!/^\d{2,4}x\d{2,4}$/.test(value)) return false;

  const rule = imageSizeRule(model);
  if (!rule) return true;

  if (rule.sizes.includes(value)) return true;

  // 不在推荐列表里也可能合法（自定义尺寸），按规则体检
  if (!rule.custom) return false;
  const [w, h] = value.split('x').map(Number);
  const { min, max, step } = rule.custom;
  const inRange = (n) => n >= min && n <= max && n % step === 0;
  return inRange(w) && inRange(h);
}

/**
 * 生图模型优先选对的。
 *
 * 坑：provider.models 里通常全是文本模型，生图那一组下拉如果直接沿用，
 * 就会把 glm-5.3 这种文本模型发给 /images/generations，接口报 404。
 * 所以有内置生图目录时，主动切过去并说明原因；
 * 用户自己指定了生图模型（模型名看着像生图模型）就不抢。
 */
function preferImageModel(provider) {
  if (!provider) return;

  const imageModels = imageCatalogModels(provider.id);
  if (!imageModels.length) return;

  const available = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const current = String(el.s.imageModel.value || '').trim();

  // 当前已经是这家已知的生图模型 —— 不用动
  if (current && imageModels.includes(current)) return;
  // 用户自己在模型列表里放了生图模型并选中了它 —— 尊重用户
  if (current && current !== available[0] && /image|cogview|dall-e|wanx|flux|sd|stable/i.test(current)) return;

  const target = imageModels[0];
  if (target === current) return;

  const option = Array.from(el.s.imageModel.options || []).find((o) => o.value === target);
  if (option) {
    el.s.imageModel.value = target;
  } else {
    el.s.imageModel.appendChild(h('option', { value: target, text: `${target}（内置）` }));
    el.s.imageModel.value = target;
  }

  showToast(
    `这家服务商的生图模型是 ${imageModels.join(' / ')}，` +
      `已从「${current || '文本模型'}」切到「${target}」——` +
      '文本模型不能用来生图，选错会报 404',
    'ok'
  );
}

/**
 * 按当前生图模型重建尺寸下拉，并尽量保留用户原来的选择。
 * 模型不认识时用通用尺寸，不拦着用户。
 */
function fillImageSizeOptions(model, current) {
  const select = el.s.imageSize;
  if (!select) return;

  const sizes = sizesForImageModel(model);
  const wanted = String(current || '').trim();

  clear(select);
  for (const size of sizes) {
    select.appendChild(h('option', { value: size, text: size }));
  }

  // 已保存的尺寸不在这个模型的列表里：要么直接纠正，要么明确标出来
  if (wanted && !sizes.includes(wanted)) {
    if (isValidImageSize(model, wanted)) {
      // 是合法自定义尺寸，保留
      select.appendChild(h('option', { value: wanted, text: `${wanted}（自定义）` }));
      select.value = wanted;
    } else {
      // 非法（比如 glm-image 配 1024x1024）——直接切到默认值，别让它再撞一次
      const rule = imageSizeRule(model);
      const fallback = sizes[0];
      select.value = fallback;
      if (rule) {
        showToast(
          `${rule.label} 不支持 ${wanted}，已改成 ${fallback}` +
            (rule.note ? `（${rule.note}）` : ''),
          'ok'
        );
      }
    }
    return;
  }

  select.value = wanted && sizes.includes(wanted) ? wanted : sizes[0];
}

/** 拉取失败时，判断是不是「这个服务商压根没有模型列表接口」 */
function looksLikeUnsupportedModelList(message) {
  const text = String(message || '');
  return (
    /\b(406|404|405|501)\b/.test(text) ||
    /不被接受|找不到接口|不支持|Not Acceptable|Method Not Allowed/i.test(text)
  );
}

/**
 * 把内置目录里的模型填进模型输入框。
 * replace=false 时只补空缺，不动用户已经写好的内容。
 */
function applyCatalogModels(catalog, replace) {
  if (!catalog) return 0;

  const existing = String(el.p.models.value || '')
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const next = replace ? [...catalog.models] : [...existing];
  if (!replace) {
    for (const m of catalog.models) {
      if (!next.includes(m)) next.push(m);
    }
  }

  el.p.models.value = next.join('\n');
  stashProviderForm();
  refreshModelSwitch();
  return next.length;
}

async function testConnection() {
  stashProviderForm();
  const provider = providerById(editingProviderId);
  if (!provider) return;

  el.btnTest.disabled = true;
  el.btnTest.textContent = '测试中…';
  try {
    const result = await api.testConnection({ provider });
    showToast(result.message || '连接成功', 'ok');
  } catch (err) {
    showToast((err && err.message) || '连接失败', 'error');
  } finally {
    el.btnTest.disabled = false;
    el.btnTest.textContent = '测试当前服务商';
  }
}

async function fetchModels() {
  stashProviderForm();
  const provider = providerById(editingProviderId);
  if (!provider) return;

  el.btnFetchModels.disabled = true;
  el.btnFetchModels.textContent = '获取中…';
  try {
    const models = await api.listModels({ provider });

    // 模型可能上百个，填太多反而难挑，只取前 120 个
    const capped = models.slice(0, 120);
    el.p.models.value = capped.join('\n');
    stashProviderForm();
    refreshModelSwitch();

    // 模型列表变了，生图 / 向量那两组下拉也要跟着刷新 ——
    // 刚拉到的列表里可能正好有你要的画图模型
    fillModelSelect(
      el.s.imageModel,
      el.s.imageProvider.value,
      el.s.imageModel.value,
      '（先在左边选一个服务商）',
      true,
      imageCatalogModels(el.s.imageProvider.value)
    );
    fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, el.s.embeddingModel.value, '（先在上面选一个服务商）');

    showToast(
      models.length > capped.length
        ? `拿到 ${models.length} 个模型，已填入前 ${capped.length} 个`
        : `拿到 ${models.length} 个模型，已填入列表`,
      'ok'
    );
  } catch (err) {
    const message = (err && err.message) || '获取模型列表失败';

    // 该服务商没有模型列表接口时（智谱就是），不要只丢一个 HTTP 错误码给用户，
    // 直接把已知模型填上，让流程能继续走下去。
    const catalog = catalogForBaseUrl(provider.baseUrl);
    if (catalog && looksLikeUnsupportedModelList(message)) {
      const hasExisting = String(el.p.models.value || '').trim().length > 0;
      const count = applyCatalogModels(catalog, !hasExisting);
      showToast(
        `${catalog.name}不支持「拉取模型列表」，已${hasExisting ? '补充' : '填入'} ${count} 个已知模型，可直接保存`,
        'ok'
      );
    } else {
      showToast(message, 'error');
    }
  } finally {
    el.btnFetchModels.disabled = false;
    el.btnFetchModels.textContent = '拉取可用模型';
  }
}


