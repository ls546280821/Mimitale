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
//  主进程兜底：别把 JS 异常弹成系统对话框
//
//  Electron 对主进程的未捕获异常有默认行为 —— 直接弹一个原生对话框
//  「A JavaScript error occurred in the main process」，把 JS 堆栈糊在用户脸上，
//  必须点「确定」才能继续。对用户这是纯噪音（看不懂，而且往往出现在关窗口那种
//  最不该被打断的时刻），对排查也没帮助 —— 日志里的堆栈更全。
//
//  2026-10-08 报的就是这个框：关窗口时写 conversations.json 撞上杀软的瞬时文件锁
//  （那个坑本体在 main/store.js 的 tryBackup + main/ipc.js 的 registerSyncSave，
//  这里只是最后一道拦网）。
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常:', (err && err.stack) || err);
});

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

/**
 * 自己退出时把这个标记删掉。
 *
 * 不删的话它会一直躺在 userData 里，直到 INSTANCE_STALE_MS（6 小时）过期。
 * 万一 Windows 把这 6 小时里的那个 PID 复用给了别的进程，`process.kill(pid, 0)`
 * 就会成功 —— 下次启动读到「实例还活着」，直接 app.quit()：没有窗口、没有提示、
 * 退出码 0，用户只看到应用「闪一下就不见了」，只能自己去 %APPDATA% 删文件。
 * markInstance 的注释本来就写着「失败也要开」，不删标记正好破坏了这条。
 *
 * 只删自己写的那份（比对 pid）：先启动的那个实例退出时，不能把后启动实例的标记抹掉。
 */
function clearInstanceMarker() {
  try {
    const info = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
    if (info && info.pid === process.pid) fs.unlinkSync(markerPath());
  } catch (err) {
    // 文件不在 / 读不动 / 不是我们写的 —— 都没关系，本来就是个尽力而为的清理
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

  // 正常退出 / before-quit 两条路都挂上：Windows 上 app.quit() 触发 before-quit，
  // 而 'quit' 在部分异常退出路径里不一定到得了，所以以 before-quit 为准。
  app.on('before-quit', clearInstanceMarker);

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
