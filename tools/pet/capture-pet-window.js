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
//  产物：
//    tools/pet/pet-window.png            截图（**带 alpha 通道**，用能显示透明度的
//                                        看图工具打开才看得出形状；Windows 照片查看器
//                                        会把它当成白底，别据此判断「抠图坏了」）
//
//  ⚠️ 数据目录指向一个 mkdtemp 出来的临时目录（MIMITALE_DATA_DIR），
//     所以它读写的 config / persona / memory 都落在临时目录里，**不碰你的真实数据**。
//     形象资源仍然从工程里的 assets/pet/ 读（那是 app.getAppPath() 决定的）。
// ============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'pet-window.png');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-pet-window-'));
process.env.MIMITALE_DATA_DIR = tmpRoot;

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
  petWindow.sendToPet('pet:say', {
    lines: ['这也太甜了吧。', '*尾巴摇起来* 我磕了。', '你倒是主动点啊。'],
    text: '这也太甜了吧。\n*尾巴摇起来* 我磕了。\n你倒是主动点啊。',
    reason: 'preview'
  });
  await new Promise((r) => setTimeout(r, 2000));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());

  const bounds = win.getBounds();
  console.log('窗口：%dx%d @ (%d,%d)  可见=%s  置顶=%s',
    bounds.width, bounds.height, bounds.x, bounds.y, win.isVisible(), win.isAlwaysOnTop());
  console.log('截图：%s', OUT);
  console.log('透明通道：%s', image.getSize().width ? '已保留（capturePage 带 alpha）' : '未知');


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
