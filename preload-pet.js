'use strict';

// ============================================================================
//  preload-pet.js —— 桌宠窗口专用的「安全桥」
//
//  ⚠️ 这个文件**故意**和主界面的 preload.js 分开，两边绝不能合并。
//
//  主界面的 preload 暴露了 `getSettings()`，它会返回**所有服务商的 API Key 明文**。
//  桌宠窗口里跑的是「形象 + 气泡 + 右键菜单」，它没有任何理由需要 Key ——
//  所以这里只暴露桌宠自己能干的那几件事，一个跟设置/密钥有关的接口都没有。
//
//  换句话说：以后往这个文件里加方法之前，先问一句「桌宠真的需要它吗」。
//  加错一个方法，等于把主界面的特权接口从侧门开给了宠物页面。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

/** 把「on + 退订」的样板收一下（和 preload.js 里的写法保持一致） */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('petBridge', {
  /** 页面加载完 → 告诉主进程可以推状态了 */
  ready: () => ipcRenderer.send('pet:ready'),

  // --- 读 ---
  // 拉一份当前状态：设置 + 形象（data URL）+ 可选模型清单 + 记忆条数。
  // 窗口每次刷新都会重新拉一次，所以主进程那边必须能重复调用。
  getState: () => ipcRenderer.invoke('pet:state:get'),

  // --- 窗口 ---
  // 拖动交给主进程按光标位置摆窗口（渲染层发增量坐标会抖、还会累积误差）
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  // 返回「窗口有没有真的被挪动过」—— 用来区分「点一下」和「拖着走」
  // （判断只能主进程做，理由见 main/pet-window.js 的 stopDrag）
  dragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  // 鼠标穿透开关：指针不在宠物身上时开着它，桌面上就不会出现点击死区
  setClickThrough: (ignore) => ipcRenderer.send('pet:set-click-through', ignore === true),

  // --- 动作 ---
  // 右键菜单走**原生菜单**（Menu.popup，在主进程里建）。
  // 为什么不在页面里自绘：宠物窗口只有 300×380，一个带二级菜单的右键菜单
  // 根本铺不下，还得自己处理溢出、勾选态、点到外面关掉 —— 原生菜单这些全是白拿的。
  openMenu: () => ipcRenderer.send('pet:open-menu'),
  // 点一下宠物（不是拖）：在本地拿一句应声，不调模型、不花一分钱
  poke: () => ipcRenderer.invoke('pet:poke'),

  // --- 主进程推过来的 ---
  onState: (handler) => on('pet:state', handler),
  // 一整句（非流式 / 流式结束后的最终文本）
  onSay: (handler) => on('pet:say', handler),
  // 流式增量（走的是 pet:chunk 这个**独立频道**，不是主对话的 chat:chunk）
  onChunk: (handler) => on('pet:chunk', handler),
  // 正在生成 / 生成结束，用来切「思考中」的表情
  onBusy: (handler) => on('pet:busy', handler),
  // 散步状态（主进程的 pet-walk 推来 { walking, facing }）——
  // 渲染层用它切换步态；方向变了猫要转身（镜像）
  onWalk: (handler) => on('pet:walk', handler)
});
