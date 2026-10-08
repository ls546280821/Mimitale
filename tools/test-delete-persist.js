'use strict';

// ============================================================================
//  mp-e2e-delete.js —— 临时端到端探针（诊断用，不参与打包）
//
//  跑的是**真实主进程**（main/ipc.js + main/store.js + main/window.js），
//  只把 userData 指到一个临时目录，绝不碰真实的 %APPDATA%\Mimitale。
//
//  验的是六条：
//    A 卡片 × 删角色            B 编辑弹窗里「删除角色」
//    C 世界书编辑器里「删除本书」 D 关窗口（beforeunload）之后重新开窗读回来
//    E characters.json 设成只读 → 两次都失败 → 界面必须回滚、报错、磁盘不动
//    F 只读 1 秒后自动放开 → 渲染层的延迟重试应该救回来（用户无感）
// ============================================================================

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-e2e-'));
app.setPath('userData', TMP);
app.disableHardwareAcceleration();
// 关窗口之后还要继续跑（真实应用里是 window-all-closed → quit，这里得挡住）
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
// 整套的墙钟上限：正常跑完约 25 秒，给足余量（E/F 两段各要等一次 1.2 秒的自动重试）
const WATCHDOG_MS = 150000;
const log = (...a) => console.log(`[+${String(((Date.now() - T0) / 1000).toFixed(1)).padStart(5)}s]`, ...a);

// 渲染层的 console 默认不进主进程 stdout —— 而「自动重试」这类逻辑的中间过程
// 全在页面那边，不看它就只剩「卡住了」三个字。这里原样转发出来。
function pipeRendererConsole(win) {
  win.webContents.on('console-message', (...args) => {
    const e = args[0];
    const hasObj = e && typeof e === 'object' && 'message' in e;
    const msg = hasObj ? e.message : args[2];
    const lvl = hasObj ? e.level : args[1];
    console.log(`  [renderer:${lvl}] ${msg}`);
  });
}

function seed() {
  fs.writeFileSync(
    path.join(TMP, 'characters.json'),
    JSON.stringify({
      characters: [
        { id: 'c1', name: '甲角色', description: '第一个' },
        { id: 'c2', name: '乙角色', description: '第二个' },
        { id: 'c3', name: '丙角色', description: '第三个' }
      ]
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(TMP, 'worldbooks.json'),
    JSON.stringify({
      worldbooks: [
        { id: 'w1', name: '书一', entries: [{ id: 'e1', title: '条一', keys: ['k1'], content: '内容一' }] },
        { id: 'w2', name: '书二', entries: [{ id: 'e2', title: '条二', keys: ['k2'], content: '内容二' }] }
      ]
    }, null, 2)
  );
  fs.writeFileSync(path.join(TMP, 'conversations.json'), JSON.stringify({ conversations: [], activeId: null }, null, 2));
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8'));
const diskChars = () => read('characters.json').characters.map((c) => c.id).join(',');
const diskBooks = () => read('worldbooks.json').worldbooks.map((w) => w.id).join(',');

let ipcReady = false;
async function openWindow() {
  if (!ipcReady) {
    const { registerIpc } = require('../main/ipc.js');
    registerIpc();
    ipcReady = true;
  }
  const { createWindow } = require('../main/window.js');
  createWindow();
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  pipeRendererConsole(win);
  await sleep(1200);
  return win;
}

app.whenReady().then(async () => {
  // 看门狗：万一某个窗口/交互卡住，别让这个工具「没声了」——打印跑到哪儿了再退出。
  setTimeout(() => {
    console.error(`\n[warn] 超过 ${WATCHDOG_MS / 1000} 秒还没跑完，强制退出。上面最后一行就是卡住的位置。`);
    app.exit(2);
  }, WATCHDOG_MS);

  seed();
  const win = await openWindow();
  log('[启动] 磁盘 characters =', diskChars(), '| worldbooks =', diskBooks());

  // --- A. 编辑弹窗里「删除角色」------------------------------------------
  const A = await win.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('#btn-chars').click(); await nap(400);
    const card = document.querySelector('#char-page-grid .char-card');
    const edit = Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
    edit.click(); await nap(500);
    if (document.querySelector('#chars-modal').classList.contains('hidden')) return { ok:false, why:'编辑器没打开' };
    const del = document.querySelector('#btn-del-char');
    if (!del || del.disabled) return { ok:false, why:'删除按钮不可用' };
    del.click(); await nap(400);
    const m = document.querySelector('#confirm-modal');
    if (!m || m.classList.contains('hidden')) return { ok:false, why:'确认框没出现' };
    document.querySelector('#confirm-ok').click(); await nap(900);
    return { ok:true, modalHidden: document.querySelector('#chars-modal').classList.contains('hidden'),
             cards: document.querySelectorAll('#char-page-grid .char-card').length };
  })()`);
  log('[A 编辑弹窗删角色]', JSON.stringify(A), '→ 磁盘 =', diskChars());

  // --- B. 世界书编辑器里「删除本书」--------------------------------------
  const B = await win.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms) => { for (let i = 0; i < ms / 100; i += 1) { if (fn()) return true; await nap(100); } return false; };
    document.querySelector('#btn-worldbooks').click();
    await until(() => document.querySelector('#wb-page-grid .char-card'), 3000);
    await nap(300);
    const card = document.querySelector('#wb-page-grid .char-card');
    const edit = Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
    edit.click();
    await until(() => !document.querySelector('#worldbooks-modal').classList.contains('hidden'), 3000);
    if (document.querySelector('#worldbooks-modal').classList.contains('hidden')) return { ok:false, why:'编辑器没打开' };
    const btn = document.querySelector('#btn-del-worldbook');
    if (!btn) return { ok:false, why:'找不到删除本书按钮' };
    btn.click(); await nap(400);
    const m = document.querySelector('#confirm-modal');
    if (!m || m.classList.contains('hidden')) return { ok:false, why:'确认框没出现' };
    document.querySelector('#confirm-ok').click(); await nap(1200);
    return { ok:true, left: document.querySelectorAll('#wb-page-grid .char-card').length };
  })()`);
  log('[B 世界书编辑器删本书]', JSON.stringify(B), '→ 磁盘 =', diskBooks());

  // --- C. 关弹窗之后再确认一次磁盘 ---------------------------------------
  await win.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const x = document.querySelector('#btn-close-worldbooks'); if (x) x.click();
    await nap(500);
    document.querySelector('#btn-worldbooks').click(); await nap(400);
  })()`);
  log('[C 关弹窗后] 磁盘 characters =', diskChars(), '| worldbooks =', diskBooks());

  // --- D. 关窗口 → 重新开一个窗口，看读回来的是什么 ----------------------
  await win.webContents.executeJavaScript('window.close()');
  await sleep(1200);
  log('[D 关窗口后] 磁盘 characters =', diskChars(), '| worldbooks =', diskBooks());

  const win2 = await openWindow();
  const D = await win2.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('#btn-chars').click(); await nap(400);
    const chars = document.querySelectorAll('#char-page-grid .char-card').length;
    document.querySelector('#btn-worldbooks').click(); await nap(400);
    const books = document.querySelectorAll('#wb-page-grid .char-card').length;
    return { chars, books };
  })()`);
  log('[D 重开窗口看到]', JSON.stringify(D));

  // --- E. 模拟「杀软一直占着」：characters.json 设成只读，删了就该失败 ---
  const cf = path.join(TMP, 'characters.json');
  fs.chmodSync(cf, 0o444);
  const E = await win2.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('#btn-chars').click(); await nap(400);
    const before = document.querySelectorAll('#char-page-grid .char-card').length;
    const del = document.querySelector('#char-page-grid .char-card .char-card-del');
    del.click(); await nap(400);
    document.querySelector('#confirm-ok').click(); await nap(3000);
    const toast = document.querySelector('#toast');
    return { before, after: document.querySelectorAll('#char-page-grid .char-card').length,
             toastVisible: toast && !toast.classList.contains('hidden'),
             toastText: toast ? toast.textContent : '' };
  })()`);
  log('[E 一直只读（两次都失败）]', JSON.stringify(E));
  log('[E 之后] 磁盘 characters =', diskChars());
  try { fs.chmodSync(cf, 0o666); } catch (e) {}

  // --- F. 模拟「杀软扫完就放开」：只读 1 秒后自动恢复 → 自动重试应该救回来 ---
  // 渲染层那次延迟重试等 1.2 秒，所以这次第二次尝试落在 ~2.1 秒，文件 1 秒时已可写。
  fs.chmodSync(cf, 0o444);
  setTimeout(() => {
    try { fs.chmodSync(cf, 0o666); } catch (e) {}
  }, 1000);
  const F = await win2.webContents.executeJavaScript(`(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('#btn-chars').click(); await nap(400);
    const before = document.querySelectorAll('#char-page-grid .char-card').length;
    const del = document.querySelector('#char-page-grid .char-card .char-card-del');
    del.click(); await nap(400);
    document.querySelector('#confirm-ok').click(); await nap(3200);
    const toast = document.querySelector('#toast');
    return { before, after: document.querySelectorAll('#char-page-grid .char-card').length,
             toastVisible: toast && !toast.classList.contains('hidden'),
             toastText: toast ? toast.textContent : '' };
  })()`);
  log('[F 只读 1 秒后放开（自动重试救回）]', JSON.stringify(F));
  log('[F 之后] 磁盘 characters =', diskChars());

  console.log('临时目录：', TMP);
  app.exit(0);
});
