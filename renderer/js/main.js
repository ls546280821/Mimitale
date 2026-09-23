'use strict';

// ============================================================================
//  main.js —— 界面逻辑的入口（跑在窗口里）
//  职责：画对话、把消息发给主进程、接收流式增量做「打字机」效果、存历史。
//
//  已按 ES module 分层拆完（峰值 7902 → 482 行），分层是：
//    core/   底层：常量、状态、DOM 引用、preload 桥、工具函数
//    ui/     通用界面件：提示条、确认框、主题、Markdown
//    data/   纯逻辑：服务商/模型、角色库、面板、叙述规则、摘要、持久化、导入重发 id、导出收尾、
//            「谁在说话」（cast）、提示词组装（messages）、世界书召回（rag）、建议与剧情选项（suggestions）、
//            会话的新建与分叉（conversations）
//    views/  一个功能一块（refresh.js 刷新总线、redraw.js 全量重绘门面、
//            header.js 对话头部、chatList.js 会话列表 + 模型切换、
//            chatMessages.js 消息渲染、composer.js 发送与流式接收、
//            convoActions.js 会话/消息增删改、summarize.js 摘要调度、
//            chatExport.js 导出、stream.js 流式绘制 + 自动跟随、
//            chatImages.js 图片消息、suggestionsUi.js 建议条 + 剧情选项、
//            worldPlay.js 进入世界、player.js 玩家角色弹窗、
//            memoryUi.js 记忆管理 + 存档点、panelUi.js 状态面板、
//            perspectiveUi.js 视角设置、settings.js 设置弹窗、appearance.js 外观弹窗、
//            viewSwitch.js 视图切换、characterList.js 角色列表页、
//            charAttributes.js 角色属性编辑器、characterEditor.js 角色编辑器弹窗、
//            characterImport.js 导入角色卡通道、
//            worldbookList.js 世界书列表页、worldbook.js 世界书编辑器）
//  这个文件只剩入口层的编排：把事件接到各模块身上、把启动流程串起来，
//  以及两处刻意留在这里的跨视图动作（导入世界书、Esc 的关闭顺序）。
//
//  拆的时候有两条约束，别踩：
//    · 依赖方向只能向下：core ← ui ← data ← views ← 入口
//    · 别让两个功能模块互相 import 成**环**（搬完可以跑一遍环检测确认）。
//      刷新总线在 views/refresh.js：谁想被重绘就在 registerRefreshListeners 里
//      登记一次；要「全量重绘」就 import views/redraw.js 的 renderAll()。
//      单向 import 一个不回头依赖你的展示层/动作模块是允许的
//      （例如 worldbookList 借 player 的弹窗、chatMessages 借 composer 的发送）；
//      只有「入口层才知道的编排」才用注入 —— initXxx({ theAction })。
// ============================================================================

import { api } from './core/api.js';
import { state } from './core/state.js';
import { el } from './core/dom.js';
import { activeConvo } from './core/util.js';

import { showToast } from './ui/toast.js';
import { applyTheme, toggleTheme, applyAccent, toggleAccent } from './ui/theme.js';
import { esc } from './ui/markdown.js';

import { persistLibrary, markWorldbooksLoaded } from './data/persist.js';
import { currentEndpoint } from './data/providers.js';
import { convoUserName, speakerName } from './data/cast.js';
import { characters, worldbooks } from './data/library.js';
import { normalizePanelDefs } from './data/panel.js';
import { createConvo } from './data/conversations.js';

import { onRefresh } from './views/refresh.js';
import { initHeader } from './views/header.js';
import { initPerspectiveUi } from './views/perspectiveUi.js';
import { closePlayerModal, applyPlayerCharChoice } from './views/player.js';
import { initMemoryUi } from './views/memoryUi.js';
import { initPanelUi } from './views/panelUi.js';
import { initWorldbookList, renderWorldbookPage } from './views/worldbookList.js';
import { initSettings, setEditingProvider, openSettings, closeSettings } from './views/settings.js';
import { initAppearance, applyChatAppearance, closeAppearanceModal } from './views/appearance.js';
import { streamPainter, initStreamFollow } from './views/stream.js';
import { initChatImages, addImageFiles } from './views/chatImages.js';
import { initSuggestionsUi, pickOption } from './views/suggestionsUi.js';
import { showView, refreshLibraryPage, initViewSwitch } from './views/viewSwitch.js';
import { initCharacterList, renderCharacterPage } from './views/characterList.js';
import {
  initWorldbook,
  editWorldbookFromPage,
  openWorldbookEditor,
  renderWorldbookChars,
  closeWorldbookCharPicker,
  stashWorldbookForm
} from './views/worldbook.js';
import {
  initCharacterEditor,
  openCharacterEditor,
  closeCharsModal,
  startCharacterDraftInBook,
  releaseEditorScope,
  stashCharacterForm,
  deleteCharacterById
} from './views/characterEditor.js';
import { initCharacterImport, pickImportFiles, warnImportErrors } from './views/characterImport.js';
import { renderAll } from './views/redraw.js';
import { renderConvoList, renderModelSwitch, applyModelChoice } from './views/chatList.js';
import { renderMessages } from './views/chatMessages.js';
import { sendMessage, autoGrowInput, stopGenerating } from './views/composer.js';
import { clearConvo } from './views/convoActions.js';
import { summarizeNow } from './views/summarize.js';
import { exportCharacter, exportConversation } from './views/chatExport.js';
import { startWorldPlay, chatWithCharacter } from './views/worldPlay.js';

// 「设置弹窗里当前正在编辑的服务商」随设置弹窗一起搬到了 views/settings.js ——
// 入口层只在启动时把当前服务商带过去（setEditingProvider）。
// 「世界书弹窗里当前选中哪本书 / 哪条条目」随世界书编辑器一起搬到了
// views/worldbook.js —— 那是编辑器自己的状态，别处不需要知道。

/**
 * 登记「谁需要被重绘」。顺序 = 绘制顺序，和以前 renderAll 里的调用顺序一致。
 *
 * 这里是 views/ 拆分的接线板：功能搬进自己的文件之后，登记语句跟着搬过去 ——
 * 由那个模块导出的 initXxx() 在原位登记（下面带 → 注释的两行就是）。
 * 保持原位是为了绘制顺序和以前一致；各视图只写自己的 DOM 区域，
 * 顺序其实不影响结果，但没必要改。
 */
function registerRefreshListeners() {
  onRefresh(renderConvoList);
  initHeader(); // → onRefresh(renderHeader)
  onRefresh(renderModelSwitch);
  // 面板只管状态字段；剧情选项挂在气泡下面，它的动作（点选项/换一批/收起）
  // 由 chatMessages.js 直接接 suggestionsUi.js，不经过这里。
  initPanelUi(); // → onRefresh(syncPanelVisibilityForConvo) + onRefresh(renderPanel)
  initMemoryUi(); // → onRefresh(renderMemoryIndicator)
  onRefresh(renderMessages);
  onRefresh(refreshLibraryPage);
  // 世界书列表页要「点编辑 = 打开世界书编辑器」，而编辑器开关属于入口层的编排
  // （要设 editingWorldbookId，那是编辑器弹窗的状态）。所以注入进去。
  // 它自己不登记重绘 —— 列表页的重绘由上面的 refreshLibraryPage 按当前视图分发。
  initWorldbookList({ openEditor: editWorldbookFromPage });
}

// ---------------------------------------------------------------------------
//  事件绑定
// ---------------------------------------------------------------------------

function bindEvents() {
  // 「＋ 新对话」= 带你去角色列表页挑一个角色，
  // 点那张卡上的「聊天」才算真正把会话建出来。
  el.btnNew.addEventListener('click', () => {
    if (state.streaming) {
      showToast('正在生成回答，先停止再新建会话');
      return;
    }
    showView('chars');
  });

  el.btnSend.addEventListener('click', () => {
    const text = el.input.value;
    el.input.value = '';
    autoGrowInput();
    sendMessage(text);
  });

  // 粘贴：截图之后 Ctrl+V 直接贴进来，比存文件再选快得多
  el.input.addEventListener('paste', (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (!files || !files.length) return;
    event.preventDefault();
    addImageFiles(files).then((took) => {
      if (took) showToast('图片已贴在输入框上方', 'ok');
    });
  });

  // 拖拽：把图片拖到输入区就能加
  const composer = el.input.closest('.composer');
  if (composer) {
    composer.addEventListener('dragover', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
      event.preventDefault();
      composer.classList.add('drop-target');
    });
    composer.addEventListener('dragleave', () => composer.classList.remove('drop-target'));
    composer.addEventListener('drop', (event) => {
      composer.classList.remove('drop-target');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      event.preventDefault();
      addImageFiles(files).then((took) => {
        if (took) showToast('图片已加进待发列表', 'ok');
      });
    });
  }

  el.btnStop.addEventListener('click', stopGenerating);
  el.btnClear.addEventListener('click', clearConvo);

  el.btnCopyAll.addEventListener('click', () => {
    const convo = activeConvo();
    if (!convo || !convo.messages.length) {
      showToast('当前会话是空的');
      return;
    }
    // 导出时用和界面一致的称呼：你 = 玩家角色名，对方 = 角色名 / 世界名
    const assistantLabel = speakerName(convo);
    const meLabel = convoUserName(convo);
    const text = convo.messages
      .map((m) => `${m.role === 'user' ? meLabel : m.role === 'error' ? '错误' : assistantLabel}：${m.content}`)
      .join('\n\n');
    api.copyText(text);
    showToast('已复制整段对话', 'ok');
  });

  // 右上角切换模型
  el.modelSwitch.addEventListener('change', () => applyModelChoice(el.modelSwitch.value));

  el.btnExportChar.addEventListener('click', exportCharacter);
  el.btnExportConvo.addEventListener('click', exportConversation);
  // 状态面板的绑定（展开 / 收起 / 清空）在 views/panelUi.js 的 initPanelUi() 里。

  // 记忆管理：弹窗本体（开关 / 摘要增删改 / 存档点）在 views/memoryUi.js 里绑定。
  // 这里只留「手动压一段」—— 它要改头部的「正在整理记忆…」提示，
  // 等 header 独立成模块之后再让它归位。
  el.btnSummarizeNow.addEventListener('click', summarizeNow);

  // 进入世界前创建玩家角色
  el.btnClosePlayer.addEventListener('click', closePlayerModal);
  el.btnCancelPlayer.addEventListener('click', closePlayerModal);
  el.btnStartPlay.addEventListener('click', startWorldPlay);
  el.playerChar.addEventListener('change', applyPlayerCharChoice);
  el.playerModal.addEventListener('click', (event) => {
    if (event.target === el.playerModal) closePlayerModal();
  });

  // 左上角的昼夜切换
  el.btnTheme.addEventListener('click', toggleTheme);

  // 左上角的配色方案切换（粉 ↔ 蓝）
  if (el.btnAccent) el.btnAccent.addEventListener('click', toggleAccent);

  el.btnFolder.addEventListener('click', () => {
    api.openDataFolder('config').catch(() => {});
  });

  el.input.addEventListener('input', autoGrowInput);

  el.input.addEventListener('keydown', (event) => {
    // 数字键 1~9 快捷选剧情选项：只在输入框为空、且不是组合键时触发，
    // 否则会跟「想输入数字」打架。选项按钮上印着对应序号，一眼对上。
    if (event.key >= '1' && event.key <= '9' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const convo = activeConvo();
      const options = convo && Array.isArray(convo.options) ? convo.options : [];
      const idx = Number(event.key) - 1;
      if (!el.input.value.trim() && options[idx] && !state.streaming) {
        event.preventDefault();
        pickOption(convo, options[idx]);
        return;
      }
    }

    if (event.key !== 'Enter') return;
    const wantSend = state.settings && state.settings.sendOnEnter !== false;
    const withModifier = event.ctrlKey || event.metaKey;

    if (event.shiftKey) return; // Shift+Enter 永远换行

    if (wantSend && !event.altKey) {
      event.preventDefault();
      const text = el.input.value;
      el.input.value = '';
      autoGrowInput();
      sendMessage(text);
      return;
    }

    if (!wantSend && withModifier) {
      event.preventDefault();
      const text = el.input.value;
      el.input.value = '';
      autoGrowInput();
      sendMessage(text);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 确认弹窗开着的时候，Esc 只关确认框，不要把手底下的弹窗一起关掉
    if (!el.confirmModal.classList.contains('hidden')) return;
    if (!el.playerModal.classList.contains('hidden')) {
      closePlayerModal();
      return;
    }
    if (!el.wbPicker.modal.classList.contains('hidden')) {
      closeWorldbookCharPicker();
      return;
    }
    if (!el.charsModal.classList.contains('hidden')) {
      closeCharsModal();
      return;
    }
    if (!el.modal.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!el.appearanceModal.classList.contains('hidden')) {
      closeAppearanceModal();
    }
  });

  // 主进程推来的流式增量
  // chunkTarget 缓存「这次流式输出该往哪个节点里写」，按 requestId 判断是否失效
  let chunkTarget = { requestId: null, node: null };

  api.onChunk(({ requestId, text }) => {
    if (requestId !== state.requestId) return;
    const convo = activeConvo();
    if (!convo) return;
    const assistant = convo.messages[convo.messages.length - 1];
    if (!assistant || assistant.role !== 'assistant') return;

    assistant.content += text;

    // 一次流式过程中目标节点不会变，缓存起来 —— 否则每个 token 都要
    // 在消息列表里查一次 DOM，长对话下这些查询加起来也不少。
    if (chunkTarget.requestId !== requestId) {
      const index = convo.messages.length - 1;
      chunkTarget = {
        requestId,
        node: el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`)
      };
    }

    streamPainter.push(chunkTarget.node, assistant.content);
  });

  api.onReasoning(({ requestId, text }) => {
    if (requestId !== state.requestId) return;
    const convo = activeConvo();
    if (!convo) return;
    const assistant = convo.messages[convo.messages.length - 1];
    if (!assistant || assistant.role !== 'assistant') return;
    assistant.reasoning = (assistant.reasoning || '') + text;
  });

  window.addEventListener('beforeunload', () => {
    api.saveConversationsNow({ conversations: state.conversations, activeId: state.activeId });
    // 世界书必须跟着角色一起写：主进程收到 worldbooks 才会更新那个文件。
    // 漏掉的话，刷新/关闭时角色绑定关系会指向一本已经不在磁盘上的书。
    api.saveCharactersNow({ characters: characters(), worldbooks: worldbooks() });
  });
}

// ---------------------------------------------------------------------------
//  导入世界书（跨视图编排，刻意留在入口层）
// ---------------------------------------------------------------------------

/**
 * 在世界书弹窗里「导入世界书」。
 * 复用角色的导入通道（同一个文件框），只是落点不同：
 * 角色照样进角色库，世界书则挂到当前选中的这本书所在的位置。
 *
 * 刻意留在入口层：它要同时动角色库、世界书列表页、角色列表页 ——
 * 属于跨视图编排。世界书弹窗里的「导入」按钮由 initWorldbook 注入到这个函数。
 */
async function importWorldbooks() {
  const picked = await pickImportFiles({
    before: () => stashWorldbookForm(),
    button: el.wb.btnImport,
    busyText: '导入中…',
    idleText: '导入世界书',
  });
  if (!picked) return;

  const { freshBooks, freshChars, errors } = picked;

  state.worldbooks = [...worldbooks(), ...freshBooks];
  if (freshChars.length) state.characters = [...characters(), ...freshChars];

  if (freshBooks.length) {
    // 直接打开刚导入的那本，方便马上核对设定对不对
    openWorldbookEditor(freshBooks[freshBooks.length - 1].id);
  } else {
    renderWorldbookPage();
  }

  renderCharacterPage();
  renderWorldbookChars();
  await persistLibrary();

  const parts = [];
  if (freshBooks.length) parts.push(`${freshBooks.length} 本世界书`);
  if (freshChars.length) parts.push(`${freshChars.length} 个角色`);
  showToast(`已导入 ${parts.join('，')}`, 'ok');

  warnImportErrors(errors);
}

// ---------------------------------------------------------------------------
//  启动
// ---------------------------------------------------------------------------

async function init() {
  bindEvents();
  // 必须在第一次 renderAll 之前登记 —— 否则首屏一个视图都不会画。
  // 各功能模块的事件绑定也在这一步完成（它们的 init 里带着自己的登记）。
  registerRefreshListeners();
  // 只绑事件、不参与整体重绘的模块
  initPerspectiveUi();
  // 外观弹窗同理：改完即时生效 + 落盘，没有需要整体重绘的 DOM。
  initAppearance();
  // 「用户在看历史就别自动跟随」挂在消息区上，自己绑自己。
  initStreamFollow();
  // 加图按钮自己绑；配图成功后要重绘对话区、没配生图要弹设置 —— 都是入口层的动作。
  initChatImages({
    rerender: (opts) => renderAll(opts),
    openSettings
  });
  // 建议条自己绑关闭按钮；点建议 / 点剧情选项 = 发一条消息，那也是入口层的编排
  // （填输入框、让它长高、走发送流程）。
  initSuggestionsUi({
    send: sendMessage
  });
  // 侧边栏的「角色库 / 世界书」两个入口自己绑（切屏是 viewSwitch 自己的事）。
  initViewSwitch();
  // 角色卡上的三个按钮都跨分区（编辑要开编辑器、聊天要建会话并切屏、删除要解绑会话），
  // 所以由这里把动作交给列表页。
  initCharacterList({
    edit: (id) => openCharacterEditor(id, 'library'),
    chat: chatWithCharacter,
    remove: deleteCharacterById
  });
  // 角色编辑器自己绑弹窗里的按钮；它保存 / 删除之后要全量重绘，那是入口层的编排。
  initCharacterEditor({ rerender: () => renderAll() });
  // 导入通道：导完打开第一个新角色（那是编辑器的事），导入前先收一回编辑器里填的内容。
  initCharacterImport({
    openEditor: (id) => openCharacterEditor(id, 'library'),
    stashForm: () => stashCharacterForm()
  });
  // 世界书编辑器同理。它要切「角色编辑器作用域」再打开角色编辑器弹窗 ——
  // 那是跨视图编排，所以那几个动作由这里注入进去（视图不向上 import）。
  initWorldbook({
    importBooks: importWorldbooks,
    stashDraft: () => stashWorldbookForm(),
    openInBook: (id) => openCharacterEditor(id, 'worldbook'),
    draftInBook: () => startCharacterDraftInBook(),
    releaseScope: () => releaseEditorScope()
  });
  // 设置弹窗同样只绑事件。它保存后要重绘「右上角切换器」和消息列表，
  // 那两样属于入口层（前者读会话状态、后者是聊天区），所以注入进去。
  initSettings({
    refreshModelSwitch: () => renderModelSwitch(),
    afterSettingsSave: () => {
      renderModelSwitch();
      renderMessages({ forceScroll: false });
    }
  });

  const config = await api.getSettings();
  state.settings = config.settings;
  state.presets = Array.isArray(config.presets) ? config.presets : [];
  setEditingProvider(state.settings.activeProviderId);

  // 主题以设置里的值为准（preload 已经按启动参数先打过一次，这里只是对齐）
  applyTheme(state.settings.theme);
  // 配色方案同理（粉色默认，蓝色按设置；preload 已先打标记）
  applyAccent(state.settings.accent);
  applyChatAppearance();

  const storedChars = await api.getCharacters();
  state.characters = Array.isArray(storedChars && storedChars.characters) ? storedChars.characters : [];

  // 世界书读不到不该拦住启动，但**必须记住没读到** ——
  // 否则之后随便存一次角色，就会把 worldbooks.json 覆盖成空文件。
  try {
    const storedBooks = await api.getWorldbooks();
    state.worldbooks = Array.isArray(storedBooks && storedBooks.worldbooks) ? storedBooks.worldbooks : [];
    markWorldbooksLoaded();
  } catch (err) {
    console.error('读取世界书失败', err);
    showToast('世界书没能读出来，本次不会写回它（重启试试）', 'error');
  }

  const stored = await api.getConversations();
  state.conversations = Array.isArray(stored.conversations) ? stored.conversations : [];
  state.activeId = stored.activeId || null;

  // 读盘进来的字段定义不可信（手改过 JSON、老版本写的），过一遍归一化。
  // 只在真有坏数据时才重写这个键，免得给所有老会话平白加上一个空对象。
  for (const convo of state.conversations) {
    if (!convo || typeof convo !== 'object') continue;
    if (convo.panelDefs !== undefined) convo.panelDefs = normalizePanelDefs(convo.panelDefs);
    // 选项是程序写进去的，读盘时只要保证形状对（不是数组就当没有）
    if (!Array.isArray(convo.options)) convo.options = [];
    if (convo.optionsSpec && typeof convo.optionsSpec !== 'object') convo.optionsSpec = null;
  }

  if (!state.conversations.length) {
    createConvo(true);
  } else if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0].id;
  }

  renderAll({ forceScroll: true });
  el.input.focus();

  const endpoint = currentEndpoint();
  if (!endpoint || !endpoint.provider.apiKey) {
    setTimeout(() => showToast('先点左下角「设置」填入 API Key 就能聊了'), 500);
  }
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff9a9a">
    启动失败：${esc((err && err.message) || err)}
  </div>`;
});
