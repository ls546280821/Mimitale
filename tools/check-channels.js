'use strict';
// ============================================================================
//  tools/check-channels.js —— 「页面调了这个通道，但主进程没注册」的检查
//
//  为什么需要它：IPC 通道名是**字符串**，写错了不会有任何编译期报错。
//  症状是「点了没反应」或者控制台一行 `No handler registered for 'xxx'`
//  —— 而那行报错很容易被淹没在启动日志里（冒烟测试就是先发现了 pet:skins 的
//  同类问题才补的桩）。
//
//  检查三件事：
//    ① 两个 preload 暴露出去的通道，主进程有没有对应的 handle / on
//    ② 主进程注册的通道，有没有任何 preload 暴露（= 页面根本调不到，死通道）
//    ③ 主进程往页面推的事件（sendToRenderer / webContents.send），
//       有没有 preload 的 on 接收
//
//  跑法： node tools/check-channels.js
//  输出「(无)」就是好的。
//
//  ⚠️ 只做静态字符串比对：动态拼出来的通道名（模板字符串）识别不了，
//     真出现时会在这里报「疑似」，需要人工看一眼。
// ============================================================================
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainDir = path.join(root, 'main');

function readAll(dir, ext = '.js') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readAll(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// --- 主进程注册的通道 -------------------------------------------------------
const handled = new Set(); // ipcMain.handle / ipcMain.on
const sent = new Set();    // 往渲染层推的事件
const mainFiles = [path.join(root, 'main.js'), ...readAll(mainDir)];
for (const f of mainFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)) handled.add(m[1]);
  // 通道名经变量传进来的注册助手（main/ipc.js 的 registerSyncSave 就是这种）：
  // 不认这一条就会把它注册的 4 个 save-sync 通道全报成「没注册」。
  for (const m of src.matchAll(/registerSyncSave\(\s*'([^']+)'/g)) handled.add(m[1]);
  for (const m of src.matchAll(/registerSyncSave\(\s*`([^`]+)`/g)) handled.add(m[1]);
  for (const m of src.matchAll(/(?:sendToRenderer|webContents\.send|\.send)\(\s*'([^']+)'/g)) sent.add(m[1]);
  for (const m of src.matchAll(/sendToPet\(\s*'([^']+)'/g)) sent.add(m[1]);
}

// --- preload 暴露 / 监听的通道 ---------------------------------------------
const preloads = ['preload.js', 'preload-pet.js'].map((f) => path.join(root, f));
const invoked = new Map(); // channel -> preload 文件
const listened = new Set(); // preload 里 on(...) 监听的
for (const f of preloads) {
  const src = fs.readFileSync(f, 'utf8');
  const base = path.basename(f);
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) invoked.set(m[1], base);
  for (const m of src.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) listened.add(m[1]);
}

// --- 宠物窗口那条链走的是 preload-pet 的自定义 on() 包装 --------------------
{
  const src = fs.readFileSync(path.join(root, 'preload-pet.js'), 'utf8');
  for (const m of src.matchAll(/\bon\(\s*'([^']+)'/g)) listened.add(m[1]);
}

const problems = [];

// ① 调用了但没注册
for (const [channel, base] of invoked) {
  if (!handled.has(channel)) {
    problems.push(`${base} 调用了 '${channel}'，但主进程没有 ipcMain.handle/on 注册它`);
  }
}

// ② 注册了但没人调用（拿不到 = 死通道）
for (const channel of handled) {
  if (!invoked.has(channel)) {
    problems.push(`主进程注册了 '${channel}'，但两个 preload 都没暴露它（页面调不到）`);
  }
}

// ③ 主进程推了但没人接
for (const channel of sent) {
  if (!listened.has(channel)) {
    problems.push(`主进程往 '${channel}' 推消息，但 preload 里没有对应的 on 监听`);
  }
}

console.log('=== IPC 通道对不上的地方 ===');
console.log(problems.length ? problems.join('\n') : '(无)');
console.log('');
console.log(`（统计：主进程注册 ${handled.size} 个、preload 调用 ${invoked.size} 个、推送事件 ${sent.size} 个）`);

process.exit(problems.length ? 1 : 0);
