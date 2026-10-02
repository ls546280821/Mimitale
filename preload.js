'use strict';

// ============================================================================
//  preload.js —— 界面（网页）与主程序之间的「安全桥」
//  界面不能直接读文件或发网络请求，只能通过这里暴露的几个方法。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
//  主题：主进程通过启动参数把当前主题传进来。
//  在这里（而不是 renderer.js 里）打标记，是为了在首屏渲染前就生效，
//  否则深色模式下启动会先闪一下浅色。
// ---------------------------------------------------------------------------
const themeArg = (process.argv || []).find((arg) => arg.startsWith('--mimitale-theme='));
const initialTheme = themeArg && themeArg.endsWith('dark') ? 'dark' : 'light';

const accentArg = (process.argv || []).find((arg) => arg.startsWith('--mimitale-accent='));
// 和 main/providers.js 的 ACCENTS 保持同步。preload 跑在渲染进程里、
// 拿不到主进程模块，所以这份小列表只能单独列一遍。
const INITIAL_ACCENTS = ['pink', 'blue', 'matcha'];
const accentValue = accentArg ? accentArg.slice('--mimitale-accent='.length) : '';
const initialAccent = INITIAL_ACCENTS.includes(accentValue) ? accentValue : 'pink';

function applyInitialTheme() {
  if (document && document.documentElement) {
    document.documentElement.setAttribute('data-theme', initialTheme);
    document.documentElement.setAttribute('data-accent', initialAccent);
  }
}

applyInitialTheme();
window.addEventListener('DOMContentLoaded', applyInitialTheme);

contextBridge.exposeInMainWorld('mimitale', {
  // --- 设置 ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testConnection: (patch) => ipcRenderer.invoke('settings:test', patch),
  listModels: (patch) => ipcRenderer.invoke('models:list', patch),

  // --- 历史会话 ---
  getConversations: () => ipcRenderer.invoke('conversations:get'),
  saveConversations: (payload) => ipcRenderer.invoke('conversations:save', payload),
  saveConversationsNow: (payload) => ipcRenderer.send('conversations:save-sync', payload),

  // --- 角色库 ---
  getCharacters: () => ipcRenderer.invoke('characters:get'),
  saveCharacters: (payload) => ipcRenderer.invoke('characters:save', payload),
  saveCharactersNow: (payload) => ipcRenderer.send('characters:save-sync', payload),
  importCard: () => ipcRenderer.invoke('characters:import'),

  // --- 世界书 ---
  getWorldbooks: () => ipcRenderer.invoke('worldbooks:get'),
  saveWorldbooks: (payload) => ipcRenderer.invoke('worldbooks:save', payload),
  saveWorldbooksNow: (payload) => ipcRenderer.send('worldbooks:save-sync', payload),
  previewWorldbook: (payload) => ipcRenderer.invoke('worldbooks:preview', payload),

  // --- 预设（叠在对话上的一层指令） ---
  getPresets: () => ipcRenderer.invoke('presets:get'),
  savePresets: (payload) => ipcRenderer.invoke('presets:save', payload),
  savePresetsNow: (payload) => ipcRenderer.send('presets:save-sync', payload),
  // 导入预设文件（弹框 + 解析，不落盘）；导出走通用的 saveFile
  importPresets: () => ipcRenderer.invoke('presets:import'),
  // --- 图片 ---
  pickImage: (options) => ipcRenderer.invoke('images:pick', options),
  // 批量导入用：一次选多张（或选文件夹）拿到路径，再逐张读内容
  pickImages: (options) => ipcRenderer.invoke('images:pick-many', options),
  readImage: (filePath) => ipcRenderer.invoke('images:read', filePath),
  generateImage: (payload) => ipcRenderer.invoke('images:generate', payload),
  drawBridgeImage: (payload) => ipcRenderer.invoke('bridge:draw', payload),
  drawBridgeProgress: (payload) => ipcRenderer.invoke('bridge:drawProgress', payload),
  ragRecall: (payload) => ipcRenderer.invoke('rag:recall', payload),

  // --- 对话 ---
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopChat: () => ipcRenderer.invoke('chat:stop'),

  // --- 流式增量（打字机效果） ---
  onChunk: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  onReasoning: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('chat:reasoning', listener);
    return () => ipcRenderer.removeListener('chat:reasoning', listener);
  },

  // --- 杂项 ---
  copyText: (text) => ipcRenderer.invoke('util:copy', text),
  saveFile: (payload) => ipcRenderer.invoke('util:saveFile', payload),
  openDataFolder: (which) => ipcRenderer.invoke('util:openPath', which)
});
