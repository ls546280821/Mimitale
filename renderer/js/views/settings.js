// ---------------------------------------------------------------------------
//  设置弹窗（含服务商编辑 / 生图 / 语义检索 / 联网搜索）
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
//
//  内置目录兜底（模型清单 / 生图尺寸规则）在 views/settingsCatalog.js ——
//  本模块只 import 它导出的查询和「铺进界面」的动作。往「服务商表单」里写字的
//  applyCatalogModels 留在本地：它要用这里的 stashProviderForm()。
// ---------------------------------------------------------------------------

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { activeConvo, asArray } from '../core/util.js';
import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { providers, providerById, isBridgeProvider } from '../data/providers.js';
import { renderHeader } from './header.js';
import {
  catalogForBaseUrl,
  imageCatalogModels,
  looksLikeUnsupportedModelList,
  preferImageModel,
  fillImageSizeOptions
} from './settingsCatalog.js';

/** 设置弹窗里当前正在编辑的服务商 */
let editingProviderId = null;

/** 默认人设弹窗里，字段中那份草稿属于哪个模型（换编辑对象时的脏检查要靠它） */
let personaShownModel = '';

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
  el.btnTestSearch.addEventListener('click', testSearch);

  // 默认人设：设置页里只有一行入口，正文放在弹窗里编辑
  el.btnAssistantPersona.addEventListener('click', openPersonaDialog);
  el.btnClosePersona.addEventListener('click', closePersonaDialog);
  el.btnCancelPersona.addEventListener('click', closePersonaDialog);
  el.btnSavePersona.addEventListener('click', savePersonaDialog);
  el.btnPersonaTemplate.addEventListener('click', applyPersonaTemplate);
  // 换「给哪个模型」= 换编辑对象，字段整个重灌一遍
  el.persona.model.addEventListener('change', switchPersonaModel);
  el.personaModal.addEventListener('click', (event) => {
    if (event.target === el.personaModal) closePersonaDialog();
  });

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

// ------------------------------ 默认人设 ------------------------------

/**
 * 「默认人设」是按**模型名**存的，所以必须回答两个不同的问题：
 *
 *   1. 这份人设生效时会取哪一条？ → defaultAssistantModel()
 *      口径和 data/cast.js 完全一致：会话自己的模型优先（每个会话都记着自己的），
 *      没有会话（比如空状态页）才退回设置里的当前模型。
 *   2. 弹窗现在编辑的是哪一条？ → editingAssistantModel()
 *      = 弹窗顶部那个下拉框选中的模型。
 *
 * 这两个**刻意分开**。以前只取了 1 就拿它当编辑对象，界面上又没有任何地方能改，
 * 于是「想给另一个模型配人设」完全无从下手 —— 弹窗永远只有会话那一个模型的一份。
 */
function defaultAssistantModel() {
  const convo = activeConvo();
  const own = convo && String(convo.model || '').trim();
  if (own) return own;
  return String((state.settings || {}).activeModel || '').trim();
}

/** 设置里的默认人设表（形状不对就当空的） */
function assistantPersonaMap(settings) {
  const map = (settings || {}).assistantPersonas;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/**
 * 弹窗顶部那个「给哪个模型」下拉框的可选项 = 顶栏切换模型时能选到的那些，
 * 一个不多一个不少（同样按服务商分组），这样两处说的是同一件事。
 *
 * 另外把 want 塞进去：会话用着一个「已经在服务商列表里删掉、但历史会话还记着」的
 * 模型时，它也必须能选中 —— 否则下拉框会静默落到别的模型上，等于编辑错了对象。
 */
function fillPersonaModelOptions(want) {
  const select = el.persona.model;
  if (!select) return;

  const groups = [];
  const seen = new Set();
  let hasWant = false;

  for (const provider of providers()) {
    const models = [];
    for (const raw of asArray(provider.models)) {
      const model = String(raw || '').trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      if (model === want) hasWant = true;
      models.push(model);
    }
    if (models.length) groups.push({ name: provider.name || '未命名服务商', models });
  }

  clear(select);
  // 选不中的那个模型单独放最前面，别让它藏进某个服务商的分组里
  if (want && !hasWant) select.appendChild(h('option', { value: want, text: want }));

  for (const group of groups) {
    const box = document.createElement('optgroup');
    box.label = group.name;
    for (const model of group.models) {
      box.appendChild(h('option', { value: model, text: model }));
    }
    select.appendChild(box);
  }

  if (select.options.length) {
    const hasOption = [...select.options].some((o) => o.value === want);
    select.value = hasOption ? want : select.options[0].value;
  }
}

/** 弹窗现在编辑的是哪个模型（下拉框说了算；下拉框还没铺出来时才退回默认口径） */
function editingAssistantModel() {
  const select = el.persona.model;
  const picked = select && String(select.value || '').trim();
  return picked || defaultAssistantModel();
}

/**
 * 把「下拉框选中那个模型的人设」灌进弹窗字段，并刷新设置页里那行入口的摘要。
 *
 * 弹窗字段和设置表单其实是同一份草稿，所以打开设置、打开弹窗、关弹窗、换编辑对象
 * 这几处都要调它 —— 保证 settings / 弹窗字段 / 入口摘要三方说的是同一件事。
 * 关弹窗时调它 = 把没保存的改动丢掉，免得设置那边点「保存」时把它一起带走。
 *
 * target 传值 = 强制把编辑对象换成它（打开设置时用，让下拉框每次都回到当前在用的模型，
 * 而不是留着上次翻过的那个）。不传 = 沿用下拉框里已经选好的那个。
 */
function syncPersonaFields(settings, target) {
  const source = settings || state.settings || {};
  fillPersonaModelOptions(target === undefined ? editingAssistantModel() : target);

  const model = editingAssistantModel();
  const entry = model ? assistantPersonaMap(source)[model] || {} : {};

  el.persona.name.value = entry.name || '';
  el.persona.text.value = entry.persona || '';
  // 记下字段里这份草稿属于谁：change 事件里下拉框已经是新值了，那时候再问
  // 「编辑的是哪个模型」会问到新模型头上，脏检查就成了假阳性。
  personaShownModel = model;

  updatePersonaHint(source);
}

/** 「模型服务」里那行入口右侧的状态说明：**当前在用的**那个模型到底配没配 */
function updatePersonaHint(settings) {
  const source = settings || state.settings || {};
  const model = defaultAssistantModel();

  if (!model) {
    el.assistantHint.textContent = '还没选模型 —— 先在顶栏选一个';
    return;
  }

  const entry = assistantPersonaMap(source)[model] || {};
  const name = String(entry.name || '').trim();
  const hasText = !!String(entry.persona || '').trim();

  // 顺手说一句「还存着别的模型的人设」：不然用户看着这一行，
  // 会以为人设只跟当前这个模型绑死、别的地方没法配（就是这么以为才报的 bug）。
  const configured = Object.keys(assistantPersonaMap(source)).length;
  const others = configured - (name || hasText ? 1 : 0);
  const tail = others > 0 ? ` · 另有 ${others} 个模型配过` : '';

  el.assistantHint.textContent =
    (name || hasText
      ? `「${model}」已设置：${name || '（没写名字）'}`
      : `「${model}」未设置，是通用助手`) + tail;
}

/** 弹窗字段里这份草稿跟已保存的那份有没有差别（换编辑对象前要据此问一句） */
function personaDraftDirty() {
  if (!personaShownModel) return false;

  const entry = assistantPersonaMap(state.settings)[personaShownModel] || {};
  return (
    el.persona.name.value.trim() !== String(entry.name || '').trim() ||
    el.persona.text.value.trim() !== String(entry.persona || '').trim()
  );
}

/** 换编辑对象：把另一个模型那一份重新灌进字段 */
async function switchPersonaModel() {
  if (!personaDraftDirty()) {
    syncPersonaFields();
    return;
  }

  // 草稿只活在字段里（没有按模型分别暂存），所以换对象前先把话说清楚
  const from = personaShownModel;
  const ok = await confirmDialog({
    title: '换一个模型编辑',
    message: `「${from}」这份还没保存，切走就丢了。继续吗？`,
    confirmText: '丢掉并切换'
  });

  if (ok) {
    syncPersonaFields();
    return;
  }

  // 不切了：下拉框退回原来那个，字段里还是刚才那份草稿（本来就没动过）
  el.persona.model.value = from;
}

function openPersonaDialog() {
  // 先把服务商表单收进内存：用户可能刚在「可用模型」里敲了一个新模型名，
  // 还没点保存就想给它配人设 —— 不收的话下拉框里根本没有它。
  stashProviderForm();
  syncPersonaFields();
  el.personaModal.classList.remove('hidden');
  el.persona.text.focus();
}

export function closePersonaDialog() {
  // 从 settings 重新回填 = 丢掉没保存的改动
  syncPersonaFields();
  el.personaModal.classList.add('hidden');
}

async function savePersonaDialog() {
  if (!editingAssistantModel()) {
    showToast('先在顶栏选一个模型，人设才知道该存给谁', 'error');
    return;
  }

  // 走和设置弹窗同一条保存链路（白名单 / 归一化 / 重绘都在里面）。
  // silent=true：不关设置弹窗、不弹「设置已保存」，提示由这里给得更准。
  const savedModel = personaShownModel || editingAssistantModel();
  const prev = state.settings;
  await saveSettings(true);
  closePersonaDialog();

  // 保存成功才会换成一个新对象（见 saveSettings 里的赋值）；失败时原样返回，别再报「已保存」
  if (state.settings !== prev) showToast(`已保存「${savedModel}」的默认人设`, 'ok');
}

/**
 * 「套用聊天风格模板」要填进去的那段。
 *
 * 为什么需要它：默认对话这一侧，system 提示词**只有用户自己写的这一段**。
 * chat.deepseek.com 那种「友好、自然、有温度」的聊天感，来自官方预置的提示词 ——
 * 走 API 拿不到。用户不写清楚，模型就退回最原始的「完成模式」：
 * 只求信息直达、不做任何修饰，读起来像在填表格。
 *
 * 所以这段刻意只讲**说话方式**、不设定具体人格 —— 人格留给用户自己写（第一行那个空位），
 * 填进去之后随便改。「留空 = 通用助手」的原则不变，它只是个起点。
 */
const PERSONA_TEMPLATE = [
  '（在这里写「你是谁」：名字、性格、说话习惯 —— 想怎么设定都行。写完可以把这一行删掉。）',
  '',
  '【说话方式】',
  '- 像跟朋友聊天那样自然：可以不完整、可以插话，不要写成一份分点的报告。',
  '- 不要动不动就列 1. 2. 3.，也别堆标题和小标题 —— 除非我明确要一份清单。',
  '- 长短按内容来：一句话能说清就一句话，不用硬凑字数。',
  '- 可以用语气词，但别每句都加。',
  '- 有不同意见就直说，不必一味附和；不确定就说不确定，别编。'
].join('\n');

/**
 * 一键填入聊天风格模板。
 *
 * 已有内容时先问一句：直接盖掉用户写的字是**撤不回来**的
 * （程序改 textarea.value 会清掉浏览器自己的撤销栈，Ctrl+Z 也救不回）。
 */
async function applyPersonaTemplate() {
  if (String(el.persona.text.value || '').trim()) {
    const ok = await confirmDialog({
      title: '覆盖现在的人设？',
      message: '这个框里已经有内容了。套用模板会把它整段换掉，而且撤不回来。',
      confirmText: '覆盖',
      danger: true
    });
    if (!ok) return;
  }

  el.persona.text.value = PERSONA_TEMPLATE;
  el.persona.text.focus();
  // 选中第一行那个空位：用户直接打字就把「在这里写你是谁」替换掉了，
  // 不用先自己删一遍。选中范围在程序改 value 之后设，所以一定生效。
  el.persona.text.setSelectionRange(0, PERSONA_TEMPLATE.indexOf('\n'));
  showToast('模板已填入 —— 改完记得点「保存」', 'ok');
}

// ------------------------------ 填表单 ------------------------------

function fillSettingsForm(settings) {
  el.s.temp.value = settings.temperature ?? 0.7;
  el.s.maxTokens.value = settings.maxTokens ?? 8192;
  el.s.sendOnEnter.checked = settings.sendOnEnter !== false;
  el.s.showDate.checked = settings.showDate !== false;
  el.s.showUsage.checked = settings.showUsage !== false;
  el.s.autoContinue.checked = settings.autoContinue !== false;
  el.s.wbDepth.value = String(
    Number.isFinite(Number(settings.worldbookRecursiveDepth)) ? Number(settings.worldbookRecursiveDepth) : 3
  );
  el.s.maxTurns.value = String(
    Number.isFinite(Number(settings.maxTurns)) && Number(settings.maxTurns) >= 1 ? Math.floor(Number(settings.maxTurns)) : 20
  );
  el.s.commonAttrs.value = (Array.isArray(settings.commonAttributes) ? settings.commonAttributes : []).join(', ');

  // 默认人设：弹窗字段跟着设置表单一起刷新，这样「设置里点保存」读到的
  // 永远是当前这一份 —— 用户从头到尾没开过弹窗，也不会把它清空。
  // 名字留空是合法的（= 不提名字），所以原样回填、不替用户补。
  // 每次都强制把编辑对象拨回「当前在用的那个模型」：上次翻看过的不算数。
  syncPersonaFields(settings, defaultAssistantModel());

  // 生图：下拉里放一个「不启用」+ 所有服务商
  clear(el.s.imageProvider);
  el.s.imageProvider.appendChild(h('option', { value: '', text: '（不启用生图）' }));
  for (const provider of providers()) {
    // 本机桥接现在有独立的 /draw 接口（走本地 ComfyUI），可以选进生图；
    // 配图时 renderer 会按「生图服务商是不是桥接」分流到 /draw 或 /images/generations
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
    // 本机桥接没有 /embeddings 接口，不能选进语义检索
    if (isBridgeProvider(provider)) continue;
    el.s.embeddingProvider.appendChild(h('option', { value: provider.id, text: provider.name }));
  }
  el.s.embeddingProvider.value = providers().some((p) => p.id === settings.embeddingProviderId)
    ? settings.embeddingProviderId
    : '';
  fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, settings.embeddingModel, '（先在上面选一个服务商）');

  // 联网搜索：总闸 + Key + 条数 + 时间范围。
  // Key 和其它 Key 一样是明文进内存的（主进程解密后给过来），所以这里原样回填，
  // 「保存」时再交回去重新加密。
  el.s.searchEnabled.checked = settings.searchEnabled === true;
  el.s.searchKey.value = settings.searchApiKey || '';
  fillSearchCountOptions(settings.searchCount);
  fillSearchFreshnessOptions(settings.searchFreshness);
}

// ------------------------------ 联网搜索 ------------------------------

// 「每次带回几条」的可选值。上限和 main/search.js 的 MAX_COUNT 对齐。
const SEARCH_COUNTS = [3, 5, 6, 8, 10];

// 时间范围的可选值。value 要和 main/search.js 的 freshness 一致，
// 那边不认识的会落回 noLimit。加值要两边一起加。
const SEARCH_FRESHNESS = [
  ['noLimit', '不限时间'],
  ['oneDay', '一天内'],
  ['oneWeek', '一周内'],
  ['oneMonth', '一月内'],
  ['oneYear', '一年内']
];

function fillSearchCountOptions(current) {
  const wanted = String(Number(current) || '');
  clear(el.s.searchCount);
  for (const n of SEARCH_COUNTS) {
    el.s.searchCount.appendChild(h('option', { value: String(n), text: `${n} 条` }));
  }
  // 存过的值不在候选里（比如老配置写了 7）也摆出来，别静默改掉用户的选择
  if (wanted && !SEARCH_COUNTS.includes(Number(wanted))) {
    el.s.searchCount.appendChild(h('option', { value: wanted, text: `${wanted} 条` }));
  }
  el.s.searchCount.value = wanted || '6';
}

function fillSearchFreshnessOptions(current) {
  const wanted = String(current || 'noLimit');
  clear(el.s.searchFreshness);
  for (const [value, label] of SEARCH_FRESHNESS) {
    el.s.searchFreshness.appendChild(h('option', { value, text: label }));
  }
  el.s.searchFreshness.value = SEARCH_FRESHNESS.some(([v]) => v === wanted) ? wanted : 'noLimit';
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
    btn.title = isBridgeProvider(p)
      ? `${p.name}（本地桥接，免 Key）`
      : p.apiKey
        ? `${p.name}（已填 Key）`
        : `${p.name}（还没有填 API Key）`;
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
    models: [...(preset.models || [])],
    type: preset.type || 'openai'
  };

  state.settings.providers = [...providers(), provider];
  editingProviderId = provider.id;

  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  renderProviderTabs();
  fillProviderForm();

  showToast(
    provider.type === 'tavern-bridge'
      ? `已添加「${provider.name}」，本地桥接免 Key，点保存即可用`
      : `已添加「${provider.name}」，填入 API Key 后点保存`,
    'ok'
  );
  if (provider.type === 'tavern-bridge') {
    el.p.baseUrl.focus();
  } else {
    el.p.apiKey.focus();
  }
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

  return {
    providers: providers(),
    activeProviderId: (state.settings || {}).activeProviderId,
    activeModel: (state.settings || {}).activeModel,
    temperature: isNaN(temp) ? 0.7 : Math.max(0, Math.min(2, temp)),
    maxTokens: isNaN(maxTokens) ? 8192 : Math.max(64, Math.min(32000, maxTokens)),
    sendOnEnter: el.s.sendOnEnter.checked,
    showDate: el.s.showDate.checked,
    showUsage: el.s.showUsage.checked,
    autoContinue: el.s.autoContinue.checked,
    worldbookRecursiveDepth: (() => {
      const depth = Number(el.s.wbDepth.value);
      return Number.isFinite(depth) ? Math.max(0, Math.min(5, Math.floor(depth))) : 3;
    })(),
    maxTurns: (() => {
      const t = Number(el.s.maxTurns.value);
      return Number.isFinite(t) ? Math.max(1, Math.min(200, Math.floor(t))) : 20;
    })(),
    imageProviderId: el.s.imageProvider.value || '',
    imageModel: el.s.imageModel.value.trim(),
    imageSize: el.s.imageSize.value || '',
    ragEnabled: el.s.ragEnabled.checked,
    embeddingProviderId: el.s.embeddingProvider.value || '',
    embeddingModel: el.s.embeddingModel.value.trim(),
    // 和「服务商模型列表」一样是「分隔符拆开的字符串列表」，直接复用那个解析
    commonAttributes: parseModels(el.s.commonAttrs.value).slice(0, 40),
    // 联网搜索。Key 留空就是「不要了」—— 照原样交回去（不偷偷把旧值填回来）
    searchEnabled: el.s.searchEnabled.checked,
    searchApiKey: el.s.searchKey.value.trim(),
    searchCount: (() => {
      const n = Number(el.s.searchCount.value);
      return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : 6;
    })(),
    searchFreshness: el.s.searchFreshness.value || 'noLimit',
    // 默认人设：只动**当前模型**那一条，别的模型的条目原样带回去。
    // 名字和人设都清空 = 这个模型不要人设了，把那条删掉（别在 config.json 里留空壳）。
    assistantPersonas: (() => {
      const map = { ...assistantPersonaMap(state.settings) };
      const model = editingAssistantModel();
      // 还没选模型（一个服务商都没配）时没地方存，原样带回
      if (!model) return map;
      const name = el.persona.name.value.trim();
      const persona = el.persona.text.value.trim();
      if (!name && !persona) delete map[model];
      else map[model] = { name, persona };
      return map;
    })()
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

// ------------------------------ 内置目录兜底导入 ------------------------------
// 目录数据和生图尺寸规则都在 views/settingsCatalog.js。这里只留**往服务商表单里
// 写字**的那一步 —— 「拉取模型」失败、且失败原因像是「这家压根没有模型列表接口」
// （常见 406）时，把已知模型填进来，别让用户卡在一个看不懂的错误码上。

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

// ------------------------------ 网络动作 ------------------------------

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

/**
 * 「测试搜索」：拿框里**当前填的** Key 试搜一次。
 * 和「测试当前服务商」一个思路 —— 用户还没点保存就想先确认能不能用，
 * 没必要逼他先存一遍再试。
 */
async function testSearch() {
  el.btnTestSearch.disabled = true;
  el.btnTestSearch.textContent = '测试中…';
  try {
    const result = await api.testSearch({
      apiKey: el.s.searchKey.value.trim(),
      freshness: el.s.searchFreshness.value || 'noLimit'
    });
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || '测试失败');
    }
    const first = (result.items && result.items[0]) || null;
    showToast(
      `搜索可用，拿到 ${result.count} 条${first ? `（第一条：${first.title}）` : ''}`,
      'ok'
    );
  } catch (err) {
    showToast((err && err.message) || '测试失败', 'error');
  } finally {
    el.btnTestSearch.disabled = false;
    el.btnTestSearch.textContent = '测试搜索';
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


