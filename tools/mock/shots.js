'use strict';

// ============================================================================
//  tools/mock/shots.js —— 把设计稿 tools/mock/redesign.html 逐页截成 PNG
//
//  设计稿里每个页面是一个 1180x800 的 .frame（和真实窗口同尺寸），带
//  data-shot="文件名"。这个脚本把窗口内容区设成同样大小，逐个滚到页首再截
//  整个视口 —— 于是截出来的图就是「这个页面在真窗口里的样子」，不是缩略图。
//
//  用法（本机默认带 ELECTRON_RUN_AS_NODE，必须 unset）：
//    cd E:/工作/Mimitale
//    export MSYS_NO_PATHCONV=1 && unset ELECTRON_RUN_AS_NODE
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/mock/shots.js
//
//  产物：tools/shots/mock/*.png（tools/shots/ 已在 .gitignore 里）
// ============================================================================

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 只做离屏截图，不需要 GPU；关掉可以避开「GPU 进程崩溃带走主进程」的环境噪声
app.disableHardwareAcceleration();

const FILE = path.join(__dirname, 'redesign.html');
const OUT = path.join(__dirname, '..', 'shots', 'mock');
const W = 1180;
const H = 800;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });

  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    console.log(`[console] ${message}`);
  });

  await win.loadFile(FILE);

  // 字体没就绪就截，楷体会退成衬线 —— 等一等
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 400));

  const frames = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[data-shot]')).map((el) => el.dataset.shot)`
  );

  if (!frames.length) {
    console.log('[warn] 一个 [data-shot] 都没找到');
    app.quit();
    return;
  }

  for (let i = 0; i < frames.length; i += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-shot]')[${i}].scrollIntoView({ block: 'start' }); true`
    );
    await new Promise((r) => setTimeout(r, 220));

    const img = await win.webContents.capturePage();
    const size = img.getSize();
    fs.writeFileSync(path.join(OUT, `${frames[i]}.png`), img.toPNG());
    console.log(`[shot] ${frames[i]}  ${size.width}x${size.height}`);
  }

  console.log(`[done] ${frames.length} 张 → ${OUT}`);
  app.quit();
}).catch((err) => {
  console.error('[fail]', err);
  app.quit();
});
