'use strict';

// ============================================================================
//  tools/pet/capture-pet-window.js —— 真起一次宠物窗口，截图 + 收集页面报错
//
//  为什么需要它：桌宠的**展示**在一个独立 BrowserWindow 里，而冒烟测试的假后端
//  起不了那个窗口（它只有 IPC 桩）。也就是说冒烟全绿**不代表宠物窗口能开起来** ——
//  窗口参数写错（比如 transparent 忘了、置顶级别不对）、pet.js 一进来就抛异常，
//  冒烟一条都测不到。这个脚本补的就是这一段。
//
//  它做的事：按真实路径注册宠物通道 → 建窗口 → 推一句让它说 → 截图。
//  没有主窗口，所以「点菜单让主窗口跳设置」这类动作不会被触发。
//
//  跑法：
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/pet/capture-pet-window.js
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/pet/capture-pet-window.js --skin=whale
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/pet/capture-pet-window.js --skin=whale --scale=1.6
//  产物：
//    tools/pet/pet-window.png            截图（**带 alpha 通道**，用能显示透明度的
//                                        看图工具打开才看得出形状；Windows 照片查看器
//                                        会把它当成白底，别据此判断「抠图坏了」）
//
//  ⚠️ 数据目录指向一个 mkdtemp 出来的临时目录（MIMITALE_DATA_DIR），
//     所以它读写的 config / persona / memory 都落在临时目录里，**不碰你的真实数据**。
//     形象资源仍然从工程里的 assets/pet/ 读（那是 app.getAppPath() 决定的）。
//
//  `--skin=<名字>` 会在那个临时数据目录里**预写一份 config**，把 look.skin 指到指定形象包。
//  这是验证「新做的形象包」的唯一办法：走的是真 rig + 真 pet-store，model.json 里
//  任何结构错误（box 朝向、parent 名字、view 越界）都会在这里变成空白或错位。
//  不传就用工程默认的那个形象（当前是大肥鱼 whale）。
//
//  `--scale=<倍数>` 同上，用来验缩放：窗口尺寸 = 300×380 × 倍数。
//  ⚠️ **气泡不跟缩放走**（2026-10-10 改）：宠物缩放只改窗口和宠物本体，
//     气泡的字号/内边距/圆角/尾巴都是固定 px。所以别指望「放大截图里气泡也变大」，
//     反过来这才是重点 —— 缩到 0.7× 时字必须还是画面上一样大、一样读得清。
//     气泡只有左右边距造成的可用宽度会跟着窗口变窄。
//
//  `--lines=<句1|句2|句3>` 覆盖默认那三句示例话，用来验「长句在气泡里滚动」：
//  固定字号之后，极小窗口更容易触发 max-height:30vh 的滚动分支，
//  这是**取舍正确**的表现（滚动优于字小到看不清），得能亲眼看到它工作。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'pet-window.png');
const skinArg = process.argv.find((a) => a.startsWith('--skin='));
const SKIN = skinArg ? skinArg.slice('--skin='.length) : null;
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Math.max(0.4, Math.min(2, Number(scaleArg.slice('--scale='.length)) || 1)) : 1;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-pet-window-'));
process.env.MIMITALE_DATA_DIR = tmpRoot;
// 传了 --skin 或 --scale 就要预写一份 config（两个都走这里，别分成两条路，
// 否则「只想改 scale 又不想指定形象」时得先知道默认形象叫什么）
if (SKIN || SCALE !== 1) {
  fs.mkdirSync(path.join(tmpRoot, 'pet'), { recursive: true });
  const config = {
    version: 1, enabled: true, activeId: 'pet1',
    pets: [{
      id: 'pet1', name: '蓝自',
      look: { kind: 'rig', source: 'assets', skin: SKIN || 'whale' },
      visible: true, scale: SCALE, bounds: { x: 900, y: 500, displayId: 0 },
      walkEnabled: true, speakEnabled: true, speakEveryTurns: 3, speakLines: 1,
      mutedUntil: 0, useMainModel: true, providerId: '', model: '',
      temperature: 0, style: '', memoryMaxItems: 30, createdAt: Date.now(),
    }],
  };
  fs.writeFileSync(path.join(tmpRoot, 'pet', 'config.json'), JSON.stringify(config, null, 1));
  console.log('形象：%s  缩放：%s×（临时 config 写在 %s）', SKIN || '(默认 whale)', SCALE, tmpRoot);
}

const pageErrors = [];

app.whenReady().then(async () => {
  const petIpc = require(path.join(ROOT, 'main', 'pet-ipc.js'));
  const petWindow = require(path.join(ROOT, 'main', 'pet-window.js'));

  petIpc.registerPetIpc();

  const win = petWindow.createPetWindow();
  if (!win) {
    console.log('❌ 宠物窗口没建出来');
    app.exit(1);
    return;
  }

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // level 3 = error
    if (level >= 2) pageErrors.push(`[${level}] ${message} (${path.basename(String(sourceId))}:${line})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`渲染进程挂了：${JSON.stringify(details)}`);
  });

  win.showInactive();
  await new Promise((r) => setTimeout(r, 1500));

  // 推一句让它说 —— 顺便验证气泡那条链路（逐句冒字）
  const LINES = (() => {
    const a = process.argv.find((x) => x.startsWith('--lines='));
    if (!a) return ['这也太甜了吧。', '*尾巴摇起来* 我磕了。', '你倒是主动点啊。'];
    return a.slice('--lines='.length).split('|');
  })();
  petWindow.sendToPet('pet:say', {
    lines: LINES,
    text: LINES.join('\n'),
    reason: 'preview'
  });
  await new Promise((r) => setTimeout(r, 2000));

  // `--frames=N` 连拍 N 帧（默认 1）。
  // 为什么要连拍：**pivots 对不对，静置永远看不出来** —— 只有让猫动起来
  // （走路摆臂、头部视差、耳朵转、尾巴摇）才会暴露「某个部件拖着不该拖的东西」
  // 或者「关节位置偏了」。间隔 1.2 秒，够它走几步。
  // `--idle`：长拍「空闲时偶发小手势」的极限姿势。
  // 为什么需要：手势（点头/摇头/招手）是 idle 下**14~34 秒随机**来一次的，
  // 而且鼠标 5 秒不动猫就睡了、睡了就不做手势。所以要**定时轻微晃动鼠标**把它弄醒，
  // 再长时间连拍，最后从所有帧里按「与中位帧的差异」挑出偏离最大的几张 ——
  // 那几张就是各手势的极限姿势，用来检查关节处会不会露出没画的地方。
  const idleArg = process.argv.find((a) => a === '--idle');
  let idleTimer = null;
  if (idleArg) {
    let n = 0;
    idleTimer = setInterval(() => {
      n += 1;
      const b = win.getBounds();
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(b.width / 2 + Math.sin(n / 3) * 30),
        y: Math.round(b.height / 2 + Math.cos(n / 5) * 30),
      });
    }, 900);
    console.log('已开启 --idle：每 0.9 秒轻晃鼠标防睡，抓偶发手势');
  }

  const framesArg = process.argv.find((a) => a.startsWith('--frames='));
  const FRAMES = framesArg ? Math.max(1, parseInt(framesArg.slice('--frames='.length), 10) || 1) : 1;
  // `--gap=<ms>` 覆盖连拍间隔（默认 1200ms —— 那是「走几步看关节」用的）。
  // `--burst` = `--gap=60` 的快捷方式：**密集连拍**，专门看「抖多快」。
  // 为什么需要：默认 1.2 秒一帧对「抖动」这种高频现象是**严重欠采样** ——
  // 1Hz 的摆尾采下来每帧相位都不同、看着像随机乱摆，根本判断不了快慢。
  // 要看清节奏就得按帧率量级采样（60ms ≈ 16fps，够数出一个周期里的相位变化）。
  const burst = process.argv.includes('--burst');
  const gapArg = process.argv.find((a) => a.startsWith('--gap='));
  const GAP = burst ? 60 : (gapArg ? Math.max(16, parseInt(gapArg.slice('--gap='.length), 10) || 1200) : 1200);
  for (let i = 0; i < FRAMES; i++) {
    if (i) await new Promise((r) => setTimeout(r, burst ? GAP : (idleArg ? 1300 : GAP)));
    const img = await win.webContents.capturePage();
    const out = FRAMES > 1 ? OUT.replace(/\.png$/, `-${i + 1}.png`) : OUT;
    fs.writeFileSync(out, img.toPNG());
    if (FRAMES <= 12 || (i + 1) % 10 === 0) console.log('  帧 %d/%d -> %s', i + 1, FRAMES, out);
  }
  if (idleTimer) clearInterval(idleTimer);

  // `--probe-scroll`：把气泡滚动框的真实几何打出来。
  // 为什么需要：气泡"切字/少显示一句"这类问题，**看截图只能猜是哪一行**，
  // 而 scrollTop / clientHeight / 每行 offsetTop+offsetHeight 一摆出来，
  // 「该不该滚、滚到哪、有没有半行」就是算术题了。
  if (process.argv.includes('--probe-scroll')) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('bubble-lines');
      const kids = [...box.children].map((el) => ({
        t: el.offsetTop, h: el.offsetHeight, txt: el.textContent.slice(0, 14)
      }));
      return {
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
        scrollTop: box.scrollTop,
        maxScroll: box.scrollHeight - box.clientHeight,
        lines: kids
      };
    })()`);
    console.log('  气泡滚动框：clientHeight=%d scrollHeight=%d scrollTop=%d maxScroll=%d',
      info.clientHeight, info.scrollHeight, info.scrollTop, info.maxScroll);
    for (const l of info.lines) {
      console.log('    行 @%d 高%d  %s', l.t, l.h, l.txt);
    }
  }

  // `--probe-box`：把「气泡下沿 → 宠物实际站立位置」之间的空隙量出来。
  // 为什么需要：窗口是透明的，「间隔」到底是气泡的 CSS 边距、还是 rig 画布的
  // 空白留白，光看截图分不出来（两处都是透明像素）。这里把每个盒子的 rect 全打出来。
  if (process.argv.includes('--probe-box')) {
    const g = await win.webContents.executeJavaScript(`(() => {
      const r = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { id, x: +b.x.toFixed(1), y: +b.y.toFixed(1),
                 w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                 bottom: +b.bottom.toFixed(1),
                 mb: cs.marginBottom, pos: cs.position };
      };
      const sizer = document.querySelector('.rig-sizer');
      const canvas = document.querySelector('.rig-canvas');
      const s = sizer ? sizer.getBoundingClientRect() : null;
      const c = canvas ? canvas.getBoundingClientRect() : null;
      const tail = getComputedStyle(document.getElementById('bubble'), '::before');
      return {
        win: { w: innerWidth, h: innerHeight },
        bubble: r('bubble'),
        bubbleLines: r('bubble-lines'),
        tail: tail ? { bottom: tail.bottom, borderTopWidth: tail.borderTopWidth } : null,
        spriteWrap: r('sprite-wrap'),
        sizer: s ? { y: +s.y.toFixed(1), h: +s.height.toFixed(1),
                     bottom: +s.bottom.toFixed(1),
                     w: +s.width.toFixed(1),
                     marginBottom: getComputedStyle(sizer).marginBottom } : null,
        canvas: c ? { y: +c.y.toFixed(1), h: +c.height.toFixed(1),
                      bottom: +c.bottom.toFixed(1), w: +c.width.toFixed(1) } : null
      };
    })()`);
    console.log('  窗口内容区: %dx%d', g.win.w, g.win.h);
    console.log('  bubble        :', JSON.stringify(g.bubble));
    console.log('  bubble-lines  :', JSON.stringify(g.bubbleLines));
    console.log('  bubble::before:', JSON.stringify(g.tail));
    console.log('  sprite-wrap   :', JSON.stringify(g.spriteWrap));
    console.log('  rig-sizer     :', JSON.stringify(g.sizer));
    console.log('  rig-canvas    :', JSON.stringify(g.canvas));
    if (g.bubble && g.canvas) {
      console.log('  → 气泡下沿 %s 与 canvas 顶 %s 之间：%s px',
        g.bubble.bottom, g.canvas.y, (g.canvas.y - g.bubble.bottom).toFixed(1));
    }
  }

  const bounds = win.getBounds();
  console.log('窗口：%dx%d @ (%d,%d)  可见=%s  置顶=%s',
    bounds.width, bounds.height, bounds.x, bounds.y, win.isVisible(), win.isAlwaysOnTop());
  console.log('截图：%s', OUT);
  console.log('透明通道：已保留（capturePage 带 alpha）');


  if (pageErrors.length) {
    console.log('\n❌ 宠物页面有 %d 条报错/警告：', pageErrors.length);
    for (const line of pageErrors) console.log('   ! ' + line);
  } else {
    console.log('\n✅ 宠物页面没有报错');
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    /* 临时目录没删掉也无所谓 */
  }

  app.exit(pageErrors.length ? 1 : 0);
});
