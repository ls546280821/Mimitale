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

const { app, BrowserWindow } = require('electron');

const { createWindow, getMainWindow } = require('./main/window.js');
const { registerIpc } = require('./main/ipc.js');

// 只允许开一个实例，第二次双击时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

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
