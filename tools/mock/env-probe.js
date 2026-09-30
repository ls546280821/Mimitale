'use strict';

// ============================================================================
//  tools/mock/env-probe.js —— 一次性环境探测，出图前用来定 frame 尺寸。
//  打印主显示器的分辨率 / 可用工作区 / 缩放比，以及系统里能用的中文字体名。
//
//  用法：export MSYS_NO_PATHCONV=1 && unset ELECTRON_RUN_AS_NODE
//        ./node_modules/electron/dist/electron.exe --no-sandbox tools/mock/env-probe.js
// ============================================================================

const { app, screen } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay();
  console.log('[display] size       =', d.size.width + 'x' + d.size.height);
  console.log('[display] workArea   =', d.workAreaSize.width + 'x' + d.workAreaSize.height);
  console.log('[display] scaleFactor=', d.scaleFactor);

  // 有哪些中文字体真的存在（字名要和 CSS 里写的一致才生效）
  const wants = [
    'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI',
    'DengXian', '等线', 'SimHei', '黑体', 'SimSun', '宋体',
    'KaiTi', '楷体', 'FangSong', '仿宋',
    'YouYuan', '幼圆', 'Microsoft JhengHei',
    'SimYou', '圆体'
  ];
  const probeWin = new (require('electron').BrowserWindow)({
    width: 200, height: 200, show: false,
    webPreferences: { backgroundThrottling: false }
  });
  probeWin.loadURL('data:text/html,<html><body></body></html>');
  probeWin.webContents.once('did-finish-load', async () => {
    // canvas measureText 才是可靠的字体存在性判定：
    // 指定字体 + monospace 兜底，宽度和纯 monospace 一样 → 这个字体不存在
    const out = await probeWin.webContents.executeJavaScript(`
      (() => {
        const names = ${JSON.stringify(wants)};
        const ctx = document.createElement('canvas').getContext('2d');
        const sample = 'WgqQy123aa';
        ctx.font = '72px monospace';
        const base = ctx.measureText(sample).width;
        return names.map((n) => {
          ctx.font = '72px "' + n + '", monospace';
          const w = ctx.measureText(sample).width;
          return n + ' → ' + (Math.abs(w - base) > 0.5 ? '有 (' + w.toFixed(0) + ')' : '无');
        }).join('\\n');
      })()
    `);
    console.log('[fonts]\n' + out);
    app.quit();
  });
}).catch((e) => {
  console.error('[fail]', e);
  app.quit();
});
