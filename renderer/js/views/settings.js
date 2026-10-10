// ---------------------------------------------------------------------------
//  设置页（含服务商编辑 / 生图 / 语义检索 / 桌宠）
//
//  ⚠️ 2026-10-09：它从**弹窗**改成了**页面**（视图六 `#view-settings`）。理由和
//  迁移口径见 index.html 那段注释 + CHANGELOG。对外的接口只变了两处：
//   · openSettings() 现在切屏（showView('settings')）并记下来处；
//   · closeSettings() 改名 leaveSettings()：回到进来之前那一屏
//     （保存 / 返回 / Esc 都走它，等于以前「关掉弹窗」的语义）。
//
//  两处刻意的边界：
//
//   · 「保存设置后重绘消息」和「右上角的模型切换器」都留在入口层 ——
//     前者是聊天区的活、后者读的是会话状态，本模块不认识它们，所以通过
//     initSettings 注入（refreshModelSwitch / afterSettingsSave）。
//     「对话头部」不在此列：views/header.js 只依赖 core / data，可以直接单向 import。
//
//   · openSettings 必须导出：发消息前发现没配模型、点「配图」发现没配生图时，
//     那两个流程（发送在 views/composer.js、配图在 views/chatImages.js）
//     要把用户带到这一屏。
//
//   · leaveSettings 也要导出：入口层的 Esc 判断链里有固定顺序
//     （确认框 → 玩家弹窗 → 角色选择 → 角色编辑器 → 设置 → 外观），
//     那一条留在入口层，拆成两个监听器会让顺序失效。
//
//   · expandSettingsSection 也要导出：桌宠右键菜单的「查看记忆」是入口层接的
//     （renderer/js/main.js），它得先把「桌宠」那一组**切到前台**再滚过去。
//
//  2026-10-10：大版块从「一列折叠卡片」改成**左侧导航 + 右侧内容**。
//  逻辑在本文件下半段（分组导航那一段），样式在 style.css 的 .settings-nav /
//  .settings-shell。对外接口没变：id 还是那六个，expandSettingsSection 照用
//  —— 只是它现在的语义从「拆开那张卡」变成了「切到那一组」。
//
//  内容只在「进这一屏」时刷新，不参与整体重绘，所以不向刷新总线登记
//  （和 views/perspectiveUi.js 一样，只做事件绑定）。
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
// 桌宠区块（它自己不依赖本模块，单向 import，不成环）
import { openPetSection } from './petSettings.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { providers, providerById, isBridgeProvider } from '../data/providers.js';
import { renderHeader } from './header.js';
// 视图切换（单向：它只登记显隐/高亮，不认识本模块）
import { showView, currentViewName } from './viewSwitch.js';
import {
  catalogForBaseUrl,
  imageCatalogModels,
  looksLikeUnsupportedModelList,
  preferImageModel,
  fillImageSizeOptions
} from './settingsCatalog.js';

/** 设置页里当前正在编辑的服务商 */
let editingProviderId = null;

/** 默认人设弹窗里，字段中那份草稿属于哪个模型（换编辑对象时的脏检查要靠它） */
let personaShownModel = '';

/**
 * 进设置页之前停在哪一屏。保存 / 返回 / Esc 都回到它 ——
 * 这就是「弹窗时代关掉弹窗」的效果，别让它变成永远回聊天。
 */
let returnView = 'chat';

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
  // 「返回」= 不保存直接走（就是以前那颗 × 的位置）
  el.btnBackSettings.addEventListener('click', leaveSettings);
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

  // 分组导航：点左栏就切到那一组。
  // 监听挂在**设置这一屏**上（不是 document）—— 这一屏是页面，事件不会跑到别处去。
  el.viewSettings.addEventListener('click', (event) => {
    const nav = event.target.closest ? event.target.closest('.settings-nav-item') : null;
    if (!nav) return;
    const target = nav.getAttribute('data-target');
    if (target) showSettingsSection(target);
  });

  // 勾选框一动就重算头部那颗统计（「已开 3 / 8 项」）。
  // 挂 change 而不是 click —— 用键盘空格切换同样要跟着更新。
  // 只认设置这一屏里的勾选框，别去关心别处的。
  el.viewSettings.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches && target.matches('input[type="checkbox"]')) renderSectionStats();
  });
}

/** 启动时把「当前服务商」带进设置弹窗（入口层拿到配置之后调） */
export function setEditingProvider(id) {
  editingProviderId = id || null;
}

// ---------------------------------------------------------------------------
//  分组导航：大版块 = 一个分组，点左栏切到哪一组就只显示哪一组
//
//  为什么要有它：设置项越加越多（模型服务 / 生成参数 / 行为 / 生图 / 语义检索 /
//  桌宠），一列铺下来要滚很久，还容易一扫而过找不到目标区块。改成「左导航 +
//  右内容」之后，打开设置先看到的是一条目录，一屏就装完，跳转不用滚。
//
//  当前选中的是哪一组**不落盘**：那只是「刚才翻到哪了」，不值得为它动 config.json。
//  但同一次运行里离开再进来会回到原样（currentSectionId）。
// ---------------------------------------------------------------------------

/** 这次运行里选中哪一组（存 section 的 id）。默认第一组「模型服务」 */
let currentSectionId = 'sec-models';

/** 左栏导航里某个 data-target 对应的按钮 */
function navItemFor(id) {
  return el.viewSettings.querySelector(`.settings-nav-item[data-target="${id}"]`);
}

/**
 * 切到某一组：左栏高亮那个按钮，右栏只显示对应的那张卡，其余隐藏，内容滚回顶部。
 *
 * 给「在桌宠右键菜单里点『查看记忆』→ 直接跳进设置页」用：那条路在入口层
 * （renderer/js/main.js）触发，它拿不到这里的 currentSectionId，只能反过来喊一声。
 * id 不认识（null / 拼错）就什么都不做，别把界面切到「一组都不显示」。
 */
export function showSettingsSection(id) {
  if (!id) return;
  const section = el.viewSettings.querySelector(`#${id}`);
  if (!section) return;

  currentSectionId = id;

  for (const item of el.viewSettings.querySelectorAll('.settings-nav-item')) {
    const on = item.getAttribute('data-target') === id;
    item.classList.toggle('active', on);
    // aria-current 的合法值里没有「false」—— 不选中就是**没有**这个状态，
    // 写 false 等于把无效值喂给读屏器。选中 = 'true'，未选中 = 移除。
    if (on) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }

  for (const box of el.viewSettings.querySelectorAll('.settings-content > .panel-section')) {
    box.classList.toggle('hidden', box.id !== id);
  }

  // 换了一组 = 换了一页内容，滚动条回到顶部（否则会保留上一组的滚动位置）
  const content = el.viewSettings.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
}

/** 旧名保留：外部（入口层）一直按这个名字喊，语义已从「展开折叠卡」变成「切到那一组」 */
export function expandSettingsSection(id) {
  showSettingsSection(id);
}

/** 切到设置页时按记下的那一组铺一遍（内容是进屏时刷的，这里只管选中态 / 显隐） */
function syncSettingsSection() {
  showSettingsSection(currentSectionId || 'sec-models');
  // 头部统计也一起算：这几个数字读的是**刚填好的**表单 / 服务商列表，
  // 所以必须排在 fillSettingsForm 之后、切屏之后（见 openSettings 里的顺序）。
  renderSectionStats();
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

  // 再说一句生效范围：这份人设**只管**没绑角色卡、也没进世界的通用对话。
  // 不写清楚的话，用户会以为它是对所有对话都生效的全局设定（进世界时看到
  // 模型拿人设跟世界书打架，就是这么来的）。
  el.assistantHint.textContent =
    (name || hasText
      ? `「${model}」已设置：${name || '（没写名字）'}`
      : `「${model}」未设置，是通用助手`) +
    ' · 只用于没绑角色卡的对话' +
    tail;
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
    Number.isFinite(Number(settings.worldbookRecursiveDepth)) ? Number(settings.worldbookRecursiveDepth) : 1
  );
  el.s.maxTurns.value = String(
    Number.isFinite(Number(settings.maxTurns)) && Number(settings.maxTurns) >= 1 ? Math.floor(Number(settings.maxTurns)) : 20
  );

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

/**
 * 一个服务商在卡片里显示的那行状态。
 *
 * 挑服务商时真正要判断的就是这三件事，所以直接写进卡片，
 * 别再塞进 title 里（触屏和键盘都读不到）。
 */
function providerMeta(p) {
  if (isBridgeProvider(p)) return '本地桥接 · 免 Key';
  const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
  const first = models[0] ? models[0] : '';
  if (!p.apiKey) return first ? `${first} · 还没有填 Key` : '还没有填 API Key';
  return first ? `${first} · 已连接` : '已连接';
}

/** 徽标里放一个字：优先取名字首字母，中文名就取第一个字 */
function providerBadgeText(p) {
  const name = String(p.name || '').trim();
  if (!name) return '＋';
  const first = name[0];
  return /[a-zA-Z0-9]/.test(first) ? first.toUpperCase() : first;
}

function renderProviderTabs() {
  el.providerTabs.innerHTML = '';

  for (const p of providers()) {
    const active = p.id === editingProviderId;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = `provider-card${active ? ' active' : ''}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', active ? 'true' : 'false');

    const badge = document.createElement('span');
    badge.className = 'provider-card-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = providerBadgeText(p);

    const body = document.createElement('span');
    body.className = 'provider-card-body';

    const name = document.createElement('span');
    name.className = 'provider-card-name';
    name.textContent = p.name || '未命名';

    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    meta.textContent = providerMeta(p);

    body.appendChild(name);
    body.appendChild(meta);

    const radio = document.createElement('span');
    radio.className = 'provider-card-radio';
    radio.setAttribute('aria-hidden', 'true');

    card.appendChild(badge);
    card.appendChild(body);
    card.appendChild(radio);

    card.addEventListener('click', () => {
      if (p.id === editingProviderId) return;
      stashProviderForm();
      editingProviderId = p.id;
      renderProviderTabs();
      fillProviderForm();
    });

    el.providerTabs.appendChild(card);
  }

  renderSectionStats();
}

/**
 * 分组头部那颗统计小胶囊。
 *
 * 只给「一眼能数出来」的几组填，填不出确切数字的就留空
 * （.section-stat:empty 会自己隐藏，不会留一道空缝）。
 * 数字的准头以「用户自己勾了几个 / 加了几家」为准，不做额外推断。
 */
function renderSectionStats() {
  const set = (node, text) => {
    if (!node) return;
    node.textContent = text || '';
  };

  const list = providers();
  set(el.statModels, `${list.length} 家服务商`);

  const behavior = el.viewSettings.querySelectorAll('#sec-behavior input[type="checkbox"]:checked');
  const behaviorTotal = el.viewSettings.querySelectorAll('#sec-behavior input[type="checkbox"]');
  set(el.statBehavior, `已开 ${behavior.length} / ${behaviorTotal.length} 项`);

  const ragOn = el.viewSettings.querySelector('#s-rag-enabled');
  set(el.statRag, ragOn && ragOn.checked ? '已启用' : '未启用');

  const petOn = el.viewSettings.querySelector('#s-pet-enabled');
  set(el.statPet, petOn && petOn.checked ? '已开启' : '已关闭');
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

/**
 * 把数字输入框读成一个数。
 *
 * ⚠️ 不能只用 `Number(v)` + `isNaN` 兜底：**空输入框的 `Number('')` 是 0，不是 NaN**，
 *    于是所有 `isNaN(...) ? 默认值 : ...` 的分支全是死代码，清空输入框会静默变成：
 *    回复上限 → 被夹到 64（每条回复都被截断）、对话轮数 → 1（历史等于没了）、
 *    递归深度 → 0（递归关掉）、温度 → 0。界面重开还显示那个被夹过的值，
 *    用户根本不知道是自己手滑清空的。
 *
 * 空 / 写不出数 → 退回**原来存着的那个值**（比"悄悄改成默认值"更贴近直觉：
 * 「我没填」就当我没改），再没有才用 fallback 兜底。
 */
function numberFrom(input, fallback, min, max, integer) {
  const rawText = String((input && input.value) || '').trim();
  const raw = Number(rawText);
  if (!rawText || !Number.isFinite(raw)) return fallback;
  const clamped = Math.max(min, Math.min(max, raw));
  return integer ? Math.floor(clamped) : clamped;
}

function readSettingsForm() {
  stashProviderForm();

  const saved = state.settings || {};

  return {
    providers: providers(),
    activeProviderId: saved.activeProviderId,
    activeModel: saved.activeModel,
    // 兜底用**原来存着的值**，不是硬编码的 8192：清空输入框 = 没改，
    // 用常量兜底会把「磁盘上明明是 512」悄悄改成 8192。
    temperature: numberFrom(
      el.s.temp,
      Number.isFinite(Number(saved.temperature)) ? Number(saved.temperature) : 0.7,
      0,
      2,
      false
    ),
    maxTokens: numberFrom(
      el.s.maxTokens,
      Number.isFinite(Number(saved.maxTokens)) ? Number(saved.maxTokens) : 8192,
      64,
      32000,
      true
    ),
    sendOnEnter: el.s.sendOnEnter.checked,
    showDate: el.s.showDate.checked,
    showUsage: el.s.showUsage.checked,
    autoContinue: el.s.autoContinue.checked,
    worldbookRecursiveDepth: numberFrom(
      el.s.wbDepth,
      Number.isFinite(Number(saved.worldbookRecursiveDepth))
        ? Number(saved.worldbookRecursiveDepth)
        : 1,
      0,
      5,
      true
    ),
    maxTurns: numberFrom(
      el.s.maxTurns,
      Number.isFinite(Number(saved.maxTurns)) ? Number(saved.maxTurns) : 20,
      1,
      200,
      true
    ),
    imageProviderId: el.s.imageProvider.value || '',
    imageModel: el.s.imageModel.value.trim(),
    imageSize: el.s.imageSize.value || '',
    ragEnabled: el.s.ragEnabled.checked,
    embeddingProviderId: el.s.embeddingProvider.value || '',
    embeddingModel: el.s.embeddingModel.value.trim(),
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
  // 已经在这一屏了（比如又点了一下侧栏那颗「设置」）：**别重灌表单** ——
  // 那会把没保存的改动当场冲掉。什么都不做即可。
  if (currentViewName() === 'settings') return;

  // 记下来处：保存 / 返回 / Esc 都回到它（弹窗时代是「关掉弹窗」，语义没变）
  returnView = currentViewName();

  if (!editingProviderId || !providerById(editingProviderId)) {
    editingProviderId = (state.settings || {}).activeProviderId || (providers()[0] || {}).id;
  }

  fillSettingsForm(state.settings || {});
  renderProviderTabs();
  fillProviderForm();
  renderPresets();
  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  // 先把内容填好再切屏（反了的话，切过去那一瞬间显示的是上一次的旧值）
  showView('settings');

  // 分组选中态要在这一屏可见之后再铺：非当前的组靠 CSS（display:none）收起来，
  // 顺序反了会让「该显示的那一组」先按旧状态闪一下。
  syncSettingsSection();

  // 桌宠区块要现拉一次状态（它改的是另一个窗口里的东西，不能拿旧快照画）。
  // 不 await：切屏不该等一个 IPC 往返才完成，区块自己会随后填上。
  openPetSection().catch((err) => console.error('桌宠区块加载失败', err));

  // 焦点落在页头那颗「返回」上：键盘（Esc / Tab）有个明确的落点。
  //
  // ⚠️ **不要**去聚焦任何输入框：以前这里是「服务商填过 Key 就把光标放进温度框」，
  // 而 <input type="number"> 一获得焦点就**整段选中** —— 每次进设置，第一眼都是
  // 「温度 0.7」被高亮成一块蓝，像是自己不小心改了什么；分组之后那个框还可能在
  // 没选中那一组里（display:none），更不该往里丢焦点。
  if (el.btnBackSettings) el.btnBackSettings.focus();
}

/**
 * 离开设置页：回到进来之前那一屏。
 *
 * 保存 / 返回 / Esc 三条路都走它 —— 在弹窗时代这三件事都是「关掉弹窗」。
 * 只保证回到**视图**：进来之前要是正开着一个弹窗（比如从桌宠右键菜单跳进来时
 * 旁边还开着记忆弹窗），那个不管，它自己那套 Esc / 关闭按钮照旧。
 */
export function leaveSettings() {
  showView(returnView === 'settings' ? 'chat' : returnView);
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
    leaveSettings();
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
    //
    // ⚠️ 但要把**原始的报错**一起带上：404 既可能是「这家没有 /models」，
    //    也可能是「接口地址写错了」。只报「不支持拉取模型列表」会把人往错误方向带，
    //    不如让 HTTP 那句话一起露出来，地址到底对不对一眼能判断。
    const catalog = catalogForBaseUrl(provider.baseUrl);
    if (catalog && looksLikeUnsupportedModelList(message)) {
      const hasExisting = String(el.p.models.value || '').trim().length > 0;
      const count = applyCatalogModels(catalog, !hasExisting);
      showToast(
        `${catalog.name}可能没有「模型列表」接口，已${hasExisting ? '补充' : '填入'} ${count} 个已知模型。` +
          `若地址填错请先改地址 —— 服务端原话：${message}`,
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


