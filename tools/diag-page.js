'use strict';

// ============================================================================
//  tools/diag-page.js —— 只验「页面能不能加载、模块图有没有跑起来」
//
//  为什么需要它：ES module 里 import 一个不存在的导出时，**整个模块图不执行** ——
//  页面 HTML 照常显示、控制台只有一行 SyntaxError，而冒烟测试的表现是
//  「90 秒超时」而不是失败断言，日志里什么都没有，很难定位。
//  这个脚本 3 秒就能把那条 console 报错直接打出来。
//
//  用法：
//    unset ELECTRON_RUN_AS_NODE      # 本机默认带这个变量，electron 会退化成纯 node
//    npm run diag                    # 脚本里带了 --no-sandbox（见下）
//
//  正常输出：[loaded] + [probe] 一段页面状态；
//  其中 `settings:get` 那条报错是**正常**的（脚本不装假后端，拿不到响应）。
// ============================================================================

const { app, BrowserWindow } = require('electron');
const path = require('path');

// 诊断只读页面状态，用不到 GPU；关掉可以避开「GPU 进程崩溃把主进程带走」
// 这类环境噪声（表现是页面加载失败 ERR_FAILED，和代码无关）。
// 配套的 --no-sandbox 写在 package.json 的 `diag` 脚本里 —— 这台机器上两个都要。
app.disableHardwareAcceleration();

const APP_DIR = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const level = typeof args[1] === 'number' ? args[1] : first && first.level;
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    const line = typeof args[3] === 'number' ? args[3] : first && first.lineNumber;
    const src = typeof args[4] === 'string' ? args[4] : first && first.sourceId;
    console.log(`[console:${level}] ${message}  <${src}:${line}>`);
  });
  win.webContents.on('render-process-gone', (e, d) => console.log('[gone]', JSON.stringify(d)));
  win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err && err.message));
  win.webContents.on('did-fail-load', (e, c, d, u) => console.log('[fail-load]', c, d, u));

  await win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  console.log('[loaded]');

  try {
    const probe = await win.webContents.executeJavaScript(`({
      ready: document.readyState,
      panelFields: typeof window.PanelFields,
      mimitale: typeof window.mimitale,
      hasMessages: !!document.getElementById('messages'),
      bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)
    })`);
    console.log('[probe]', JSON.stringify(probe, null, 2));
  } catch (e) {
    console.log('[probe-fail]', e.message);
  }

  app.quit();
});
