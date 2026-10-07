'use strict';

// ============================================================================
//  tools/mock/directions-shots.js —— mock 稿通用出图脚本
//
//  和 shots.js 同一套做法（一页一个 frame、截整个视口），只是换了源文件。
//  额外多两条自检：
//    1) 打印每页实际生效的底色 / 正文字族 / 字号 / 强调色 / ink 系列对比度
//       —— 免得出现「看着像主题 A 其实 token 没生效」的假图
//    2) 逐元素检查有没有被「最近的裁剪祖先」切掉（只看 frame 边界会漏）
//
//  用法（默认出 directions.html）：
//    cd <项目根目录>（有 package.json 的那一层）
//    export MSYS_NO_PATHCONV=1 && unset ELECTRON_RUN_AS_NODE
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/mock/directions-shots.js
//
//  换源文件加 --src（注意 frame 尺寸要跟着源文件走）：
//    ... tools/mock/directions-shots.js --src=cute.html
//
//  产物：tools/shots/mock/*.png（tools/shots/ 已 gitignore）
// ============================================================================

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const argSrc = process.argv.slice(1).find((a) => a.startsWith('--src='));
const SRC = argSrc ? argSrc.slice(6) : 'directions.html';
const FILE = path.join(__dirname, SRC);
const OUT = path.join(__dirname, '..', 'shots', 'mock');

// frame 尺寸跟着源文件走：--size=1440x900
const sizeArg = (process.argv.slice(1).find((a) => a.startsWith('--size=')) || '').slice(7);
const [W, H] = sizeArg.includes('x') ? sizeArg.split('x').map(Number) : [1180, 800];

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

  // 自检：token 是不是真的生效了（三方向必须打出三组不同值），
  // 顺便算一遍 ink-dim / ink-faint 在承载面上的对比度（WCAG AA 要 4.5:1）
  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const hex2rgb = (h) => {
        h = String(h).trim();
        if (h.charAt(0) === '#') {
          if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
          return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        }
        const m = h.match(/\\d+/g);
        return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
      };
      const lum = (c) => {
        const [r, g, b] = c.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const x = lum(hex2rgb(a)), y = lum(hex2rgb(b));
        return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
      };
      return Array.from(document.querySelectorAll('[data-shot]')).map((el) => {
        const cs = getComputedStyle(el);
        const read = el.querySelector('.prose, .bubble, .a-prose, .b-prose, .c-prose');
        const accent = el.querySelector(
          '.send, .new-btn, .btn-primary, .b-send, .c-send, .btn-a, .btn-b, .btn-c'
        );
        const sheet = cs.getPropertyValue('--sheet');
        const main = ratio(cs.getPropertyValue('--ink'), sheet);
        const dim = ratio(cs.getPropertyValue('--ink-dim'), sheet);
        const faint = ratio(cs.getPropertyValue('--ink-faint'), sheet);
        return [
          el.dataset.shot,
          el.dataset.dir || '-',
          cs.backgroundColor,
          read ? getComputedStyle(read).fontFamily.split(',')[0] : '-',
          read ? getComputedStyle(read).fontSize : '-',
          accent ? getComputedStyle(accent).backgroundColor : '-',
          main + (Number(main) >= 4.5 ? ' ok' : ' LOW'),
          dim + (Number(dim) >= 4.5 ? ' ok' : ' LOW'),
          faint + (Number(faint) >= 4.5 ? ' ok' : ' LOW')
        ].join(' | ');
      });
    })()
  `);
  console.log('[probe] 图 | 方向 | 底色 | 正文字族 | 字号 | 强调色 | ink | ink-dim | ink-faint');
  probe.forEach((line) => console.log(`[probe] ${line}`));

  for (let i = 0; i < frames.length; i += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-shot]')[${i}].scrollIntoView({ block: 'start' }); true`
    );
    await new Promise((r) => setTimeout(r, 220));

    // 裁切检查：找出被「最近的 overflow:hidden 祖先」裁掉的元素。
    // 只看 frame 边界是不够的 —— 弹窗内容是被 .b-mbody 这种中间容器裁掉的，
    // 元素 bottom 根本没超出 frame，但肉眼看得见半行被切。用 JSON 字符串往返，
    // 避免把 DOM 对象丢回主进程（SVG 的 className 不是字符串，会序列化失败）。
    let note = '';
    try {
      const raw = await win.webContents.executeJavaScript(
        `JSON.stringify((() => {
          const f = document.querySelectorAll('[data-shot]')[${i}];
          let worst = 0, sel = '', clip = '', ta = '';
          for (const el of f.querySelectorAll('*')) {
            let a = el.parentElement, holder = f;
            while (a && a !== document.body) {
              const oy = getComputedStyle(a).overflowY;
              if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') { holder = a; break; }
              a = a.parentElement;
            }
            const over = Math.round(
              el.getBoundingClientRect().bottom - holder.getBoundingClientRect().bottom
            );
            if (over > worst) {
              worst = over;
              sel = typeof el.className === 'string' ? el.className : el.tagName;
              clip = holder.className || holder.tagName;
            }
          }
          for (const t of f.querySelectorAll('textarea')) {
            if (t.scrollHeight > t.clientHeight + 2) {
              ta = String(t.value || '').replace(/\\s+/g, ' ').trim();
              break;
            }
          }
          return { worst, sel: String(sel).slice(0, 34), clip: String(clip).slice(0, 28), ta: ta.slice(0, 22) };
        })())`
      );
      const o = JSON.parse(raw);
      const bits = [];
      if (o.worst > 2) bits.push(`⚠ 被裁 ${o.worst}px @ ${o.sel}  ← ${o.clip}`);
      // textarea 里文字比框高 → rows 给少了，最后一行被静默切掉（元素盒子本身不超标，查不出来）
      if (o.ta) bits.push(`⚠ 文本框装不下: "${o.ta}…"`);
      note = bits.length ? bits.join('  |  ') : 'ok';
    } catch (e) {
      note = 'check-skip';
    }

    const img = await win.webContents.capturePage();
    const size = img.getSize();
    fs.writeFileSync(path.join(OUT, `${frames[i]}.png`), img.toPNG());
    console.log(`[shot] ${frames[i]}  ${size.width}x${size.height}  ${note}`);
  }

  console.log(`[done] ${frames.length} 张 → ${OUT}`);
  app.quit();
}).catch((err) => {
  console.error('[fail]', err);
  app.quit();
});
