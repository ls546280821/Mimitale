'use strict';

// ============================================================================
//  main/window.js —— 主窗口 + 开发模式热重载
//
//  跑 `npm run dev`（等价于 electron . --dev）时会：
//    · 自动打开 DevTools
//    · 监听 renderer/ 目录，文件一保存就自动刷新窗口
//  改界面（html/css/js）完全不用重启应用。
//  改 main.js / main/* / preload.js 仍然要重启 —— 它们只在启动时读一次。
// ============================================================================

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { DEFAULT_SETTINGS, loadSettings } = require('./providers.js');

let mainWindow = null;

// 窗口底色跟着主题走，深色模式下启动时就不会先闪一下白
const WINDOW_BG = { light: '#f7f9fc', dark: '#1a1d23' };

const DEV_MODE =
  process.argv.includes('--dev') ||
  process.env.MIMITALE_OPEN_DEVTOOLS === '1' ||
  process.env.BARBARA_OPEN_DEVTOOLS === '1' ||
  process.env.CYRENE_OPEN_DEVTOOLS === '1';

let devWatcher = null;
let devReloadTimer = null;

function watchRendererForDev() {
  if (!DEV_MODE || devWatcher) return;

  try {
    devWatcher = fs.watch(path.join(__dirname, '..', 'renderer'), { recursive: true }, () => {
      // 编辑器保存一次往往触发好几个事件，稍微防抖一下
      clearTimeout(devReloadTimer);
      devReloadTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[dev] renderer 有改动，刷新窗口');
          mainWindow.webContents.reload();
        }
      }, 150);
    });
  } catch (err) {
    console.warn('[dev] 无法监听 renderer 目录，自动刷新不可用:', err.message);
  }
}

function stopDevWatcher() {
  clearTimeout(devReloadTimer);
  devReloadTimer = null;
  if (devWatcher) {
    devWatcher.close();
    devWatcher = null;
  }
}

function createWindow() {
  let theme = DEFAULT_SETTINGS.theme;
  let accent = DEFAULT_SETTINGS.accent;
  try {
    const saved = loadSettings();
    theme = saved.theme === 'dark' ? 'dark' : 'light';
    accent = saved.accent === 'blue' ? 'blue' : 'pink';
  } catch (err) {
    // 读不到设置就用默认主题，不影响启动
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: WINDOW_BG[theme],
    title: '如我所书',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 把主题提前告诉 preload，让它在首屏渲染前就打好标记
      additionalArguments: [`--mimitale-theme=${theme}`, `--mimitale-accent=${accent}`]
    }
  });

  if (DEV_MODE) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    watchRendererForDev();
  }

  // F12 开/关 DevTools。
  // Electron 默认只绑了 Ctrl+Shift+I，从浏览器过来的人会习惯性按 F12，
  // 那一下在 Electron 里是没反应的，所以这里补上。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外部链接用系统浏览器打开，不在应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopDevWatcher();
  });
}

function getMainWindow() {
  return mainWindow;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

module.exports = {
  createWindow,
  getMainWindow,
  sendToRenderer
};
