'use strict';

// ============================================================================
//  tools/test-persist-queue.js —— 保存不能并发（后发的必须最后落盘）
//
//  真 bug（2026-10-10 审查）：persistConversations 的防抖只管「什么时候**开始**写」。
//  前一次还在飞、又触发一次，两次写就并发 —— 主进程内部还有退避重试（最多再等
//  0.5 秒），于是**先发出的旧快照反而可能后落盘**，刚改的那一下没了。
//  最容易踩的两处：改状态栏（persistConversations(0)）紧接着回复结束保存；
//  以及关窗口那次保存被还在飞的上一次盖掉。
//
//  修法：persist.js 里按文件排队（queueWrite），同一条链上一次只跑一个写。
//
//  跑法： electron --no-sandbox tools/test-persist-queue.js
//  在隐藏空白页里 import 真模块，把 window.mimitale.saveConversations 换成一个
//  「假磁盘」——记录并发数、以及**最后一个写完**的是哪份数据。
// ============================================================================
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-persist-queue-'));
app.setPath('userData', path.join(tmpRoot, 'user-data'));

const PAGE_SCRIPT = (rootUrl, panelUrl) => `(async () => {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = ${JSON.stringify(panelUrl)};
    s.onload = resolve; s.onerror = reject; document.head.append(s);
  });
  window.mimitale = {};

  const { state } = await import(${JSON.stringify(rootUrl)} + 'js/core/state.js');
  const persist = await import(${JSON.stringify(rootUrl)} + 'js/data/persist.js');

  // ---- 假磁盘：记并发数 + 最后落盘的那份 ----
  const disk = { last: null, inFlight: 0, maxInFlight: 0, order: [] };
  const installFakeDisk = (delayFor) => {
    disk.last = null; disk.inFlight = 0; disk.maxInFlight = 0; disk.order = [];
    window.mimitale.saveConversations = (payload) => {
      const id = (payload.conversations[0] || {}).id;
      disk.inFlight += 1;
      if (disk.inFlight > disk.maxInFlight) disk.maxInFlight = disk.inFlight;
      return new Promise((resolve) => setTimeout(() => {
        disk.inFlight -= 1;
        disk.last = id;
        disk.order.push(id);
        resolve({ ok: true });
      }, delayFor(id)));
    };
  };

  // ① 前一次还在飞时又保存一次：不许并发，且最后落盘的必须是最新那份
  installFakeDisk((id) => (id === 'v1' ? 200 : 20)); // 模拟旧那份慢（主进程退避重试）
  state.conversations = [{ id: 'v1' }];
  state.activeId = 'v1';
  persist.persistConversations(0);
  await sleep(50);                       // 第一份已经在飞
  state.conversations = [{ id: 'v2' }];
  state.activeId = 'v2';
  persist.persistConversations(0);
  await sleep(600);
  check('① 同一个文件同时只有一次写在飞', disk.maxInFlight === 1, 'maxInFlight=' + disk.maxInFlight);
  check('① 最后落盘的是最新那份（v2）', disk.last === 'v2', 'disk=' + disk.last + ' order=' + disk.order.join(','));
  check('① 两次写都真的发生了（没有互相吃掉）', disk.order.length === 2, disk.order.join(','));

  // ② 一次写失败不能把整条链钉死：后面的保存照常进行
  //    （writeJson 那边有长注释说过同一个坑：队尾不自己吃掉异常的话，一次失败
  //     之后每次 writeQueue.then 都跳过成功回调，等于「写坏一次，从此所有保存都静默不写」）
  installFakeDisk(() => 10);
  let phase = 'fail';
  window.mimitale.saveConversations = () => {
    if (phase === 'fail') return Promise.reject(new Error('写盘炸了'));
    return new Promise((resolve) => setTimeout(() => { disk.last = 'v3'; resolve({ ok: true }); }, 10));
  };
  state.conversations = [{ id: 'v3' }];
  persist.persistConversations(0);
  await sleep(1500);                     // 失败那次会等 1.2 秒再重试一次 —— 这里两次都失败
  check('② 失败时链尾确实是失败状态（下面这条才测得到东西）', disk.last === null, 'disk=' + disk.last);
  phase = 'ok';
  persist.persistConversations(0);
  await sleep(300);
  check('② 前一次彻底失败后，后面的保存照常写进去', disk.last === 'v3', 'disk=' + disk.last);

  return results;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  let failed = 0;
  try {
    const page = path.join(tmpRoot, 'blank.html');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await win.loadFile(page);
    const rootUrl = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
    const panelUrl = pathToFileURL(path.join(__dirname, '..', 'main', 'panel-fields.js')).href;
    const results = await win.webContents.executeJavaScript(PAGE_SCRIPT(rootUrl, panelUrl));
    for (const r of results) {
      if (!r.pass) failed += 1;
      console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass || !r.detail ? '' : `（${r.detail}）`}`);
    }
    console.log(failed ? `失败 ${failed} 条 / 共 ${results.length} 条` : `全部通过：${results.length} 条`);
  } catch (err) {
    console.error(err && (err.stack || err.message || err));
    failed = failed || 1;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 删不掉不影响结论 */ }
    app.exit(failed ? 1 : 0);
  }
});
