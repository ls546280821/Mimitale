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

const { DEFAULT_SETTINGS, loadSettings, ACCENTS } = require('./providers.js');

let mainWindow = null;

// 窗口底色跟着主题 + 配色方案走，启动时就不会先闪一下别的颜色。
// 这两个值必须和 style.css 里 --bg 保持一致（改配色时两边一起改）——
// 之前是 #1a1d23，但 style.css 的夜间 --bg 是 #17161b，启动会闪一下，这里对齐掉。
const WINDOW_BG = {
  pink: { light: '#fff5f8', dark: '#17161b' },
  blue: { light: '#f4f9ff', dark: '#17161b' },
  matcha: { light: '#f3faf5', dark: '#17161b' }
};

// 窗口尺寸 —— **只有这一处定义**。
//
// 用 useContentSize，所以这几个数就是「画布」的尺寸，和设计稿的 frame 一一对应。
// 冒烟测试的截图窗口也从这里读（tools/smoke-test.js）——
// 那边原来自己写死 1180×800，改完窗口之后就一直照着旧尺寸出图，
// 结果「设计稿 1440、真机截图 1164」两张图对不上，白白照着挤压的顶栏调了半天。
const WINDOW_SIZE = {
  width: 1440,
  height: 900,
  minWidth: 1040,
  minHeight: 680
};

const DEV_MODE =
  process.argv.includes('--dev') || process.env.MIMITALE_OPEN_DEVTOOLS === '1';

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
    accent = ACCENTS.includes(saved.accent) ? saved.accent : 'pink';
  } catch (err) {
    // 读不到设置就用默认主题，不影响启动
  }

  mainWindow = new BrowserWindow({
    // 1440×900 的内容区：三栏（224 对话列表 / 对话 / 300 在场角色）在 1180 宽下太挤，
    // 对话区只剩六百多像素，中文字一行放不下十来个字。
    // 本机屏幕 1920×1080、工作区 1920×1040，边框再吃掉一点也放得下。
    ...WINDOW_SIZE,
    useContentSize: true,
    backgroundColor: (WINDOW_BG[accent] || WINDOW_BG.pink)[theme],
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
    if (input.type !== 'keyDown') return;

    if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  /**
   * 窗口只准停在本地界面这一个文档上。
   *
   * 为什么必须有这条：preload 是**每个文档**都会注入的，而它把 window.mimitale
   * 整个暴露出去（getSettings 会返回所有服务商的 API Key 明文）。没有这道守卫时，
   * 往窗口里拖一个 .html 或一个链接（聊天区、侧栏都行，不只是输入框）就会让窗口
   * **导航到那个文档**，外来页面于是拿到了同一套特权接口 —— 拖放等于把钥匙递出去。
   *
   * 允许的只有「同文档内的锚点跳转」（帮助页目录是 <a href="#xxx">）：
   * 那种情况 url 和应用自己的地址就只差一个 hash，不换文档，也就不会重新注入 preload。
   * 这里按「路径是不是那个 index.html」判断，不去拼 URL 字符串比 ——
   * index.html 的 file URL 里中文/空格会被百分号编码，字符串比较容易出假阴性。
   * 其余一律拦掉：拖进来的文件、外站链接、重定向。
   */
  const appIndexPath = path.join(__dirname, '..', 'renderer', 'index.html');

  const isOwnDocument = (url) => {
    try {
      const target = new URL(String(url || ''));
      if (target.protocol !== 'file:') return false;
      const decoded = decodeURIComponent(target.pathname).replace(/^\//, '');
      return path.resolve(decoded) === path.resolve(appIndexPath);
    } catch (err) {
      return false;
    }
  };

  const blockForeignNavigation = (event, url) => {
    if (isOwnDocument(url)) return;
    event.preventDefault();
    console.warn('[window] 拦下了一次窗口导航（只允许本地界面）:', url);
  };

  mainWindow.webContents.on('will-navigate', blockForeignNavigation);
  mainWindow.webContents.on('will-redirect', blockForeignNavigation);

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
  sendToRenderer,
  // 冒烟测试的截图窗口读它，保证「设计稿 / 真机 / 出图」三边尺寸一致
  WINDOW_SIZE
};
