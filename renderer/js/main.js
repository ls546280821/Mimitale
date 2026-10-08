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
//            worldbookList.js 世界书列表页、worldbook.js 世界书编辑器、
//            help.js 帮助页的「复制优化提示词」）
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
import { activeConvo, asArray } from './core/util.js';

import { showToast } from './ui/toast.js';
import { applyTheme, applyAccent } from './ui/theme.js';
import { toggleModalMax, initModalMax } from './ui/modalMax.js';
import { esc } from './ui/markdown.js';
import { applyFieldIcons } from './ui/icons.js';
import { initMoreMenu } from './ui/menu.js';
import { initModelMenu } from './ui/modelMenu.js';

import { persistCharacters, persistLibrary, persistPresets, markWorldbooksLoaded, markPresetsLoaded } from './data/persist.js';
import { currentEndpoint, isBridgeProvider } from './data/providers.js';
import { convoUserName, speakerName } from './data/cast.js';
import { characters, worldbooks, dialoguePresets } from './data/library.js';
import {
  normalizePanelDefs,
  cleanAssistantText,
  convoFieldDisplayNames,
  migrateConvoPanel,
  absorbTopLevelIntoPlayer,
  mergePlayerOwnedFields,
  panelGroupNames,
  cutTrailingStatusBlock
} from './data/panel.js';
import { createConvo } from './data/conversations.js';

import { onRefresh } from './views/refresh.js';
import { initHeader } from './views/header.js';
import { initPerspectiveUi, closePerspectiveModal } from './views/perspectiveUi.js';
import { initRequestLog, closeRequestLog } from './views/requestLog.js';
import { closePlayerModal, applyPlayerCharChoice } from './views/player.js';
import { initMemoryUi, closeMemoryModal } from './views/memoryUi.js';
import { initPanelUi } from './views/panelUi.js';
import { initStateCards } from './views/stateCard.js';
import { initWorldbookList, renderWorldbookPage } from './views/worldbookList.js';
import {
  initPresetList,
  renderPresetPage
} from './views/presetList.js';
import { initPresetIo, exportPreset } from './views/presetIO.js';
import {
  initPreset,
  openPresetEditor,
  newPreset,
  deletePresetById,
  closePresetEditor
} from './views/preset.js';
import { initSettings, setEditingProvider, openSettings, closeSettings, closePersonaDialog } from './views/settings.js';
import { initAppearance, applyChatAppearance, closeAppearanceModal } from './views/appearance.js';
import { streamPainter, initStreamFollow } from './views/stream.js';
import { initChatImages } from './views/chatImages.js';
import { initSuggestionsUi, pickOption } from './views/suggestionsUi.js';
import { showView, refreshLibraryPage, initViewSwitch } from './views/viewSwitch.js';
import { initHelp } from './views/help.js';
import { initCharacterList, renderCharacterPage } from './views/characterList.js';
import {
  initWorldbook,
  editWorldbookFromPage,
  deleteWorldbookById,
  openWorldbookEditor,
  renderWorldbookChars,
  closeWorldbookCharPicker,
  closeWorldbooksModal,
  stashWorldbookForm
} from './views/worldbook.js';
import {
  initCharacterEditor,
  openCharacterEditor,
  closeCharsModal,
  closeWorldbookPicker,
  isWorldbookPickerOpen,
  startCharacterDraftInBook,
  startCharacterDraftFromAi,
  releaseEditorScope,
  stashCharacterForm,
  deleteCharacterById
} from './views/characterEditor.js';
import { initCharacterImport, pickImportFiles, warnImportErrors } from './views/characterImport.js';
import { initAiGen, openAiGenModal } from './views/aiGen.js';
import { renderAll } from './views/redraw.js';
import { renderConvoList, renderModelSwitch, applyModelChoice } from './views/chatList.js';
import { renderMessages } from './views/chatMessages.js';
import {
  sendMessage,
  autoGrowInput,
  sentTextOf,
  clearInputAfterSend,
  stopGenerating
} from './views/composer.js';
import { clearConvo } from './views/convoActions.js';
import { summarizeNow } from './views/summarize.js';
import { exportCharacter, exportConversation } from './views/chatExport.js';
import { startPlayerFlow, chatWithCharacter } from './views/worldPlay.js';

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
  // 状态卡入口条：只列「本局有谁」，点头像开那张状态卡（字段在卡里看/改）。
  // 剧情选项挂在气泡下面，它的动作（点选项/换一批/收起）由 chatMessages.js
  // 直接接 suggestionsUi.js，不经过这里。
  initPanelUi(); // → onRefresh(renderPanel)
  initMemoryUi(); // → onRefresh(renderMemoryIndicator)
  onRefresh(renderMessages);
  // 浮动状态卡（点「我」/角色的头像打开）。登记在消息之后：它读的是同一份面板数据，
  // 顺序不影响结果，跟着消息后面画一遍即可。
  initStateCards(); // → onRefresh(renderStateCards)
  onRefresh(refreshLibraryPage);
  // 世界书列表页要「点编辑 = 打开世界书编辑器」，而编辑器开关属于入口层的编排
  // （要设 editingWorldbookId，那是编辑器弹窗的状态）。所以注入进去。
  // 卡片右上角那个删除 × 同理：它要一起解绑会话、收掉编辑器里的草稿。
  // 它自己不登记重绘 —— 列表页的重绘由上面的 refreshLibraryPage 按当前视图分发。
  initWorldbookList({ openEditor: editWorldbookFromPage, remove: deleteWorldbookById });
  // 预设列表页同理：「编辑」要打开预设编辑器（编辑器状态住在 views/preset.js），
  // 「删除」要收掉那份没保存的草稿，「导出」是另一条通道。都是跨模块编排，由入口层注入。
  initPresetList({ openEditor: openPresetEditor, remove: deletePresetById, exportOne: exportPreset });
  // 预设编辑器自己绑弹窗里的按钮；它保存 / 删除之后要全量重绘（预设页、
  // 会话视角弹窗都可能跟着变），那也是入口层的编排。
  initPreset({ rerender: () => renderAll() });
  // 预设的导入 / 导出：按钮在预设页头部，导入完要重绘整页
  initPresetIo({ rerender: () => renderAll() });
}

// ---------------------------------------------------------------------------
//  事件绑定
// ---------------------------------------------------------------------------

function bindEvents() {
  // 「＋ 新对话」= 直接建一个空白会话并切到聊天屏。
  // 想跟某个角色聊，去角色库点卡片上的「聊天」—— 那条路会自己建会话并绑角色。
  el.btnNew.addEventListener('click', () => {
    if (state.streaming) {
      showToast('正在生成回答，先停止再新建会话');
      return;
    }
    createConvo(true);
    showView('chat');
    renderAll({ forceScroll: true });
  });

  /**
   * 发消息的统一入口：**先发再清**，发不出去就把文字留在框里。
   *
   * 以前三个入口（发送按钮 / 回车 / Ctrl+回车）都是「先把 value 清空、再调
   * sendMessage」，而 sendMessage 有一堆早退路径（没配模型、没填 Key、正在生成中）——
   * 每一条都会把用户刚打的字吃掉，而且不报错、只弹个提示。
   * 现在由 sendMessage 返回「到底发出去没有」，清了才清。
   */
  const submitInput = () => {
    const text = el.input.value;
    const sent = sentTextOf(text);
    return sendMessage(text).then((didSend) => {
      if (didSend) clearInputAfterSend(sent);
      return didSend;
    });
  };

  el.btnSend.addEventListener('click', () => {
    submitInput();
  });

  el.btnStop.addEventListener('click', stopGenerating);
  el.btnClear.addEventListener('click', clearConvo);

  el.btnCopyAll.addEventListener('click', () => {
    const convo = activeConvo();
    if (!convo || !convo.messages.length) {
      showToast('当前会话是空的');
      return;
    }
    // 导出时用和界面一致的称呼：你 = 玩家角色名，对方 = 角色名 / 世界名。
    // 通用助手没填名字时 speakerName 是空串，这里得有个称呼顶着
    const assistantLabel = speakerName(convo) || 'AI';
    const meLabel = convoUserName(convo);
    const text = convo.messages
      .map((m) => `${m.role === 'user' ? meLabel : m.role === 'error' ? '错误' : assistantLabel}：${m.content}`)
      .join('\n\n');
    api.copyText(text);
    showToast('已复制整段对话', 'ok');
  });

  el.btnExportChar.addEventListener('click', exportCharacter);
  el.btnExportConvo.addEventListener('click', exportConversation);
  // 预设页右上角「＋ 新建预设」：打开空草稿（真正建出来要等点保存）
  if (el.btnNewPreset) el.btnNewPreset.addEventListener('click', newPreset);
  // 状态卡入口条不用在这里绑事件 —— 头像的点击由 views/panelUi.js 铺的时候就地挂上。

  // 记忆管理：弹窗本体（开关 / 摘要增删改 / 存档点）在 views/memoryUi.js 里绑定。
  // 这里只留「手动压一段」—— 它要改头部的「正在整理记忆…」提示，
  // 等 header 独立成模块之后再让它归位。
  el.btnSummarizeNow.addEventListener('click', summarizeNow);

  // 进入世界前创建玩家角色
  el.btnClosePlayer.addEventListener('click', closePlayerModal);
  el.btnCancelPlayer.addEventListener('click', closePlayerModal);
  el.btnStartPlay.addEventListener('click', startPlayerFlow);
  el.playerChar.addEventListener('change', applyPlayerCharChoice);
  el.playerModal.addEventListener('click', (event) => {
    if (event.target === el.playerModal) closePlayerModal();
  });

  // 主题配色 / 夜间模式已经不在这里了 —— 2026-10-08 挪进「外观」弹窗，
  // 点击由 views/appearance.js 接（那边才有它们的控件）。

  // 打开数据文件夹。主进程回 { ok, path, error } —— 失败时得说一句人话：
  // 以前这里 .catch(() => {}) 什么都吞，用户只看到 Windows 自己弹的那个框
  // （「Windows 无法访问指定设备、路径或文件」），既不知道哪一步失败，
  // 也拿不到路径。
  //
  // ⚠️ 2026-10-08 补的兜底：**ok:true 只代表 explorer.exe 起来了，不代表文件夹真弹出来了**。
  //    （进程被沙箱/权限限制住时就是这样：explorer 继承同一个受限令牌，请求递不到
  //     已经开着的资源管理器 —— 文件夹不开，而这边的返回值是"成功"。见 main/ipc.js。）
  //    主进程查不出这件事，所以这里把**路径无条件塞进剪贴板**：真没弹出来的话，
  //    用户按 Ctrl+L 往资源管理器地址栏一粘就进去了，不至于"点了没反应"。
  el.btnFolder.addEventListener('click', async () => {
    let result = null;
    try {
      result = await api.openDataFolder('config');
    } catch (err) {
      showToast(`打不开数据文件夹：${(err && err.message) || '未知错误'}`, 'error');
      return;
    }
    const target = (result && result.path) || '';
    if (target) {
      // 剪贴板失败不该影响这条提示，所以单独吞掉
      try {
        await api.copyText(target);
      } catch (err) {
        console.warn('复制数据文件夹路径失败', err);
      }
    }
    if (result && result.ok === false) {
      console.error('打开数据文件夹失败', result.error);
      // 以前这里只弹路径，把主进程好不容易带回来的原因（result.error）丢掉了 ——
      // 用户只看到「打不开数据文件夹：C:\...」，拿不到任何下一步。
      showToast(`打不开数据文件夹：${result.error || result.path}`, 'error');
      return;
    }
    if (target) {
      showToast(`数据文件夹：${target}（路径已复制 —— 窗口没弹出来的话，在资源管理器地址栏 Ctrl+V 回车）`, 'ok');
    }
  });

  // 四个编辑弹窗头上的「放大」：把**那个弹窗**铺满应用窗口，再点还原。
  // 传的是按钮本身（模块靠 closest('.modal') 找到它所属的弹窗），所以各弹窗互不影响。
  // 逐个绑而不是循环数组 —— tools/audit-buttons.js 是按「el.xxx 后面同一行有没有
  // addEventListener」查漏绑的，写成数组它会把这四个全报成没绑。
  el.btnFsChars.addEventListener('click', () => toggleModalMax(el.btnFsChars));
  el.btnFsWorldbooks.addEventListener('click', () => toggleModalMax(el.btnFsWorldbooks));
  el.btnFsSettings.addEventListener('click', () => toggleModalMax(el.btnFsSettings));
  el.btnFsPreset.addEventListener('click', () => toggleModalMax(el.btnFsPreset));

  el.input.addEventListener('input', autoGrowInput);

  el.input.addEventListener('keydown', (event) => {
    // 中文/日文输入法：敲拼音时按回车是**选词**，那一下在 Chromium 里也会报成
    // Enter（keyCode 229，且 isComposing 为 true）。不挡的话会拿半截拼音去发消息
    // （再加上以前「先清空再校验」，连半截都没了）。两个判据都看，各家输入法不一致。
    if (event.isComposing || event.keyCode === 229) return;

    // 数字键 1~9 快捷选剧情选项：只在输入框为空、且不是组合键时触发，
    // 否则会跟「想输入数字」打架。选项按钮上印着对应序号，一眼对上。
    if (event.key >= '1' && event.key <= '9' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const convo = activeConvo();
      const options = asArray(convo && convo.options);
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
      submitInput();
      return;
    }

    if (!wantSend && withModifier) {
      event.preventDefault();
      submitInput();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 确认弹窗开着的时候，Esc 只关确认框，不要把手底下的弹窗一起关掉
    if (!el.confirmModal.classList.contains('hidden')) return;
    if (!el.requestsModal.classList.contains('hidden')) {
      closeRequestLog();
      return;
    }
    if (!el.playerModal.classList.contains('hidden')) {
      closePlayerModal();
      return;
    }
    if (!el.wbPicker.modal.classList.contains('hidden')) {
      closeWorldbookCharPicker();
      return;
    }
    // 角色编辑器里那个「绑定世界书」浮层挂在 body 上、层级还比编辑器高，
    // 所以它是最上面那一层，先关它（别顺手把编辑器一起关了）
    if (isWorldbookPickerOpen()) {
      closeWorldbookPicker();
      return;
    }
    if (!el.charsModal.classList.contains('hidden')) {
      closeCharsModal();
      return;
    }
    // 人设弹窗是从设置里开的、压在设置之上，所以先关它 ——
    // 不然按一下 Esc 会把底下的设置弹窗也一起关掉
    if (!el.personaModal.classList.contains('hidden')) {
      closePersonaDialog();
      return;
    }
    if (!el.modal.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!el.appearanceModal.classList.contains('hidden')) {
      closeAppearanceModal();
      return;
    }
    // 剩下这三个以前漏在链外 —— 只开着它们的时候按 Esc 毫无反应，和别的弹窗行为不一致
    if (!el.wb.modal.classList.contains('hidden')) {
      closeWorldbooksModal();
      return;
    }
    if (!el.pr.modal.classList.contains('hidden')) {
      closePresetEditor();
      return;
    }
    if (!el.memoryModal.classList.contains('hidden')) {
      closeMemoryModal();
      return;
    }
    if (!el.perspectiveModal.classList.contains('hidden')) {
      closePerspectiveModal();
    }
  });

  // 主进程推来的流式增量
  // chunkTarget 缓存「这次流式输出该往哪个节点里写」，按 requestId 判断是否失效。
  // base / delta 用来拼流式阶段的显示文本（见下面的注释）。
  let chunkTarget = { requestId: null, node: null, base: '', delta: '' };

  api.onChunk(({ requestId, text }) => {
    if (requestId !== state.requestId) return;
    const convo = activeConvo();
    if (!convo) return;
    const assistant = convo.messages[convo.messages.length - 1];
    if (!assistant || assistant.role !== 'assistant') return;

    assistant.content += text;

    // 一次流式过程中目标节点一般不变，缓存起来 —— 否则每个 token 都要
    // 在消息列表里查一次 DOM，长对话下这些查询加起来也不少。
    //
    // ⚠️ 但缓存必须认「节点已经脱离文档」这种情况：生成过程中只要发生一次整体重绘
    //    （存设置走 afterSettingsSave、改状态卡字段走 refreshAll 都会调 renderMessages，
    //    而它整片重建 #messages 的 innerHTML），缓存的 .msg-content 就成了文档外的孤儿 ——
    //    之后每个分片都写进那个孤儿里，屏幕上的气泡**看起来卡住了**，
    //    直到 finally 里 renderAll 才把整段正文一次性刷出来。
    //    isConnected 为 false 就地重查一次，代价只有那些被重绘的轮次。
    if (chunkTarget.requestId !== requestId || !chunkTarget.node || !chunkTarget.node.isConnected) {
      const index = convo.messages.length - 1;
      // 本次流式开始前这条消息已有的正文（继续时 = 上一轮的原文，可能带旧状态块）。
      // 它是完整的，用 cleanAssistantText 精确剥掉旧状态块，得到干净正文 base。
      // 重绘之后重查也走同一条路：assistant.content 已经含了本轮全部增量，
      // 减掉这一次的 text 就得到基准，delta 归零再往后拼，不会丢字也不会重复。
      const before = assistant.content.slice(0, assistant.content.length - text.length);
      chunkTarget = {
        requestId,
        node: el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`),
        base: cleanAssistantText(before, convoFieldDisplayNames(convo), [...panelGroupNames(convo)]),
        delta: ''
      };
    }

    // 流式阶段的显示 = 干净的历史正文（base）+ 本轮新文本（delta，砍掉末尾状态块）。
    //
    // 为什么不能直接 cleanAssistantText(assistant.content)：它在流式阶段会**抖动** ——
    // 每 token 重算时，半截的字段行（【时间】还没写到冒号）匹配不上正则，
    // 会闪一两帧再被剥掉，字段多的时候一行闪一次，气泡就上下抖。
    //
    // 为什么砍的是 delta 而不是整段：继续（continue）时 assistant.content 里躺着
    // 上一轮的状态块，直接整段「从第一个状态行砍」会把夹在中间的正文也误砍。
    // 所以 base 用 cleanAssistantText 剥旧状态块（保留夹在中间的正文），
    // 本轮新增的 delta 用 cutTrailingStatusBlock 从第一个状态行起整体截断（不闪）。
    chunkTarget.delta += text;
    // 把这一局的面板字段名带进去：只有「真的是面板字段」的行才砍，
    // 内心描写 / 上帝视角的【心理】【旁白】小标题不能被当成状态块吞掉。
    const display =
      chunkTarget.base +
      cutTrailingStatusBlock(chunkTarget.delta, convoFieldDisplayNames(convo));
    streamPainter.push(chunkTarget.node, display);
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
    // 角色和世界书一起写（主进程收到 worldbooks 才会更新那个文件，漏掉的话
    // 角色绑定关系会指向一本已经不在磁盘上的书）。
    // ⚠️ 必须走 persistCharacters —— 它带着「世界书没读出来就别写」的守卫
    // （data/persist.js 的 worldbooksLoaded）。以前这里直接调
    // api.saveCharactersNow({ ..., worldbooks: worldbooks() }) 把守卫绕过去了：
    // 世界书读失败时 state.worldbooks 是空数组，而主进程 store.js 判断的是
    // 「Array.isArray(payload.worldbooks)」—— 空数组照样算「带了世界书」，
    // 于是「启动读失败 + 关一次窗口」就把 worldbooks.json 清空了。
    persistCharacters(true);
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

  // 写盘失败就别报「已导入」—— 提示由 persistLibrary 弹（导进来的东西留在界面上）
  if (!(await persistLibrary())) return;

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
  // 静态 HTML 里带 data-icon 的字段标签，启动时一次性挂上图标（见 ui/icons.js）。
  // 动态渲染出来的标签要自己在渲染完成后对那一段再调一次。
  applyFieldIcons();
  // 必须在第一次 renderAll 之前登记 —— 否则首屏一个视图都不会画。
  // 各功能模块的事件绑定也在这一步完成（它们的 init 里带着自己的登记）。
  registerRefreshListeners();
  // 只绑事件、不参与整体重绘的模块
  // 顶栏「⋯」下拉菜单：纯开关，菜单里的功能各有各的归属（见 ui/menu.js）
  initMoreMenu();
  // 顶栏「切换模型」弹层：同上，纯开关。列表内容由 renderModelSwitch 铺，
  // 选中之后干什么这边接给 applyModelChoice —— 它俩不互相认识，免得绕出 import 环。
  initModelMenu({ onPick: applyModelChoice });
  initPerspectiveUi();
  // 「请求记录」：只读主进程内存里的最近几次请求，打开时现拉一次。
  // 它不碰 state、不落盘，所以没有要注入的动作。
  initRequestLog();
  // 外观弹窗同理：改完即时生效 + 落盘，没有需要整体重绘的 DOM。
  initAppearance();
  // 弹窗「放大」状态：关弹窗时自动摘掉，下次打开回到正常大小。
  initModalMax();
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
  // 侧边栏的「角色库 / 世界书 / 帮助」几个入口自己绑（切屏是 viewSwitch 自己的事）。
  initViewSwitch();
  // 帮助页只有一颗「复制优化提示词」，内容本身是静态 HTML，不用重绘。
  initHelp();
  // 角色卡上的三个按钮都跨分区（编辑要开编辑器、聊天要建会话并切屏、删除要解绑会话），
  // 所以由这里把动作交给列表页。
  initCharacterList({
    edit: (id) => openCharacterEditor(id, 'library'),
    chat: chatWithCharacter,
    remove: deleteCharacterById
  });
  // 角色编辑器自己绑弹窗里的按钮；它保存 / 删除之后要全量重绘，那是入口层的编排。
  initCharacterEditor({ rerender: () => renderAll() });
  // AI 生成角色 / NPC：生成完把字段交给角色编辑器开一份新草稿。
  // 走的是和「＋ 新建角色」完全同一条路 —— 看过、改过、点保存才真正创建。
  initAiGen({
    startDraft: (fields, scope, bookId) => startCharacterDraftFromAi(fields, scope, bookId)
  });
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
    releaseScope: () => releaseEditorScope(),
    // 「AI 生成 NPC」：带上这本书的 id，生成时拿它的条目和副本名单当上下文
    aiDraftInBook: (bookId) => openAiGenModal({ scope: 'worldbook', bookId })
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

  // ---- 启动数据：五份互不依赖，并行去取 ----
  // 以前是五个 await 排队，每次都要等上一个跨进程往返回来才发下一个；
  // 并行后总耗时从「五次往返相加」压到「最慢那一份」。
  // 世界书 / 预设读失败不该拦住启动（但要记住没读到，各自 catch 里见），
  // 所以这两份单独包一层、失败也 resolve；其余三份失败 = 启动失败，语义同前。
  const soft = (p) => p.then(
    (r) => ({ ok: true, r }),
    (err) => ({ ok: false, err })
  );
  const [config, storedChars, books, presets, stored] = await Promise.all([
    api.getSettings(),
    api.getCharacters(),
    soft(api.getWorldbooks()),
    soft(api.getPresets()),
    api.getConversations()
  ]);

  state.settings = config.settings;
  state.presets = asArray(config.presets);
  setEditingProvider(state.settings.activeProviderId);

  // 主题以设置里的值为准（preload 已经按启动参数先打过一次，这里只是对齐）
  applyTheme(state.settings.theme);
  // 配色方案同理（粉色默认，蓝色按设置；preload 已先打标记）
  applyAccent(state.settings.accent);
  applyChatAppearance();

  state.characters = asArray(storedChars && storedChars.characters);

  // 世界书读不到不该拦住启动，但**必须记住没读到** ——
  // 否则之后随便存一次角色，就会把 worldbooks.json 覆盖成空文件。
  if (books.ok) {
    state.worldbooks = asArray(books.r && books.r.worldbooks);
    markWorldbooksLoaded();
  } else {
    console.error('读取世界书失败', books.err);
    showToast('世界书没能读出来，本次不会写回它（重启试试）', 'error');
  }

  // 预设同理：读失败要记住，否则之后存一次预设就把文件写空了
  if (presets.ok) {
    state.dialoguePresets = asArray(presets.r && presets.r.presets);
    markPresetsLoaded();
  } else {
    console.error('读取预设失败', presets.err);
    showToast('预设没能读出来，本次不会写回它（重启试试）', 'error');
  }

  state.conversations = asArray(stored.conversations);
  state.activeId = stored.activeId || null;

  // 读盘进来的字段定义不可信（手改过 JSON、老版本写的），过一遍归一化。
  // 只在真有坏数据时才重写这个键，免得给所有老会话平白加上一个空对象。
  for (const convo of state.conversations) {
    if (!convo || typeof convo !== 'object') continue;
    // 先迁移（老格式「字段名」→「字段名+owner」复合键），再归一化。
    // 顺序不能反：migrate 要从老格式的 defs[name].owner 读归属，归一化之后
    // 键已经变成复合键，就取不到 owner 了（见 data/panel.js 的 migrateConvoPanel）。
    migrateConvoPanel(convo);
    if (convo.panelDefs !== undefined) convo.panelDefs = normalizePanelDefs(convo.panelDefs);
    // 老会话里 owner 为空的字段当场认领（归角色或并回主角），幂等。
    absorbTopLevelIntoPlayer(convo);
    // 「玩家挑的卡」和世界书里的同名副本撞了 → 副本那份并回「我」，
    // 同一个人只留一张状态卡。幂等，只在真撞上时才动数据。
    mergePlayerOwnedFields(convo);
    // 选项是程序写进去的，读盘时只要保证形状对（不是数组就当没有）
    if (!Array.isArray(convo.options)) convo.options = [];
    if (convo.optionsSpec && typeof convo.optionsSpec !== 'object') convo.optionsSpec = null;
    // 预设绑定：三种形状都要留得住
    //   · 数组         → 手动配过（可能是空数组 = 显式「一条都不要」）
    //   · 非空字符串   → 老数据（单值），迁成一条
    //   · 其它/缺失    → null = 没配过，自动跟随全局预设
    if (Array.isArray(convo.dialoguePresetIds)) {
      convo.dialoguePresetIds = convo.dialoguePresetIds.filter(
        (id) => typeof id === 'string' && id.trim()
      );
    } else if (typeof convo.dialoguePresetId === 'string' && convo.dialoguePresetId.trim()) {
      convo.dialoguePresetIds = [convo.dialoguePresetId];
    } else {
      convo.dialoguePresetIds = null;
    }
    delete convo.dialoguePresetId;
  }

  if (!state.conversations.length) {
    createConvo(true);
  } else if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0].id;
  }

  renderAll({ forceScroll: true });
  el.input.focus();

  const endpoint = currentEndpoint();
  if (!endpoint || (!endpoint.provider.apiKey && !isBridgeProvider(endpoint.provider))) {
    setTimeout(() => showToast('先点左下角「设置」填入 API Key 就能聊了'), 500);
  }
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff9a9a">
    启动失败：${esc((err && err.message) || err)}
  </div>`;
});
