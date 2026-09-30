'use strict';

// ============================================================================
//  Mimitale —— 桌面对话 AI
//  main.js 是「主进程入口」：只剩 app 生命周期 + 装配。
//  实现都拆在 main\ 目录里：
//    store.js      userData 读写（会话 / 角色 / 世界书 / 向量缓存）
//    providers.js  服务商 + 模型列表 + 设置（config.json）的形状
//    http.js       大模型 HTTP 请求（含流式）
//    window.js     窗口 + 开发模式热重载
//    ipc.js        IPC 通道注册（每个 handler 只做参数转发）
//  界面的逻辑在 renderer\ 目录里。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { createWindow, getMainWindow } = require('./main/window.js');
const { registerIpc } = require('./main/ipc.js');

// ---------------------------------------------------------------------------
//  单实例保护
//
//  正常路径是 Electron 自己的锁（Chromium 的 process singleton）。
//  ⚠️ 但有些机器上 Chromium **建不了**那把锁 —— 用户数据目录里写文件被安全软件 /
//  权限策略拒掉，启动日志里是一行：
//      ERROR:chrome\browser\process_singleton_win.cc:318]
//      Lock file can not be created: 拒绝访问。(0x5)
//  这时 requestSingleInstanceLock() 也返回 false —— 和「真的已经开着第二个实例」
//  分不出来，于是应用刚起来就自己退了（退出码 0，看着像闪一下就没）。
//
//  所以拿不到 Chromium 的锁时，再用自己的一个 PID 小文件确认一遍：
//  文件里的进程**还活着**才当成「真的有实例在跑」；其余情况一律照常启动。
//  方向是**失败也要开**（宁可多开一个窗口，也别让应用起不来）。
// ---------------------------------------------------------------------------

const INSTANCE_MARKER = 'instance.json';
const INSTANCE_STALE_MS = 6 * 60 * 60 * 1000; // 超过 6 小时的文件不认（防 PID 复用误判）

function markerPath() {
  return path.join(app.getPath('userData'), INSTANCE_MARKER);
}

/** 自己那个标记说「有实例在跑」吗（进程活着 + 记录不旧） */
function markedInstanceAlive() {
  try {
    const info = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
    if (!info || !Number.isFinite(info.pid) || !Number.isFinite(info.at)) return false;
    if (Date.now() - info.at > INSTANCE_STALE_MS) return false;
    // signal 0 = 只探活，不发信号；进程不在会抛 ESRCH
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function markInstance() {
  try {
    fs.writeFileSync(markerPath(), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch (err) {
    // 写不了就算了 —— 下次顶多多开一个窗口，比让应用起不来强
    console.warn('[warn] 写不了单实例标记：', err.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
// 拿不到 Chromium 的锁时，只有「自己的标记说是真有人开着」才让位
const yieldToOther = !gotLock && markedInstanceAlive();

if (gotLock) {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

if (yieldToOther) {
  app.quit();
} else {
  markInstance();

  app.whenReady().then(() => {
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
