'use strict';

// ============================================================================
//  main/pet-window.js —— 桌宠自己那个窗口
//
//  为什么必须是**独立窗口**、而不是主界面里的一块：
//  桌宠要能待在桌面上（主窗口最小化时它还在）、要能压在别的窗口上面、
//  要能是**不规则形状**（图片外面那圈是透明的）。这三件事主窗口都给不了。
//
//  这个窗口有五个参数是不能改的，每个都对应一个「改了就坏」的症状：
//
//    transparent: true      关掉 → 图片外面是一块白底方板，看着像个 bug
//    frame: false           关掉 → 顶上多一条标题栏
//    alwaysOnTop 'screen-saver'
//                           只写 alwaysOnTop: true 的话别的窗口一激活就把它盖住，
//                           表现是「宠物老是莫名其妙消失」
//    skipTaskbar: true      关掉 → 任务栏多一个「如我所书」条目，点它不知道该干嘛
//    hasShadow: false       关掉 → 透明窗口照样投出一圈方形阴影
//
//  还有两处「不做就会翻车」的：
//
//   ① **鼠标穿透**。窗口是矩形的，宠物不是。窗口那一整块如果一直收鼠标，
//      桌面上就多出一片**点击死区** —— 用户点不到下面的图标，而且完全不知道为什么。
//      做法是「默认穿透 + 把鼠标移动事件转发给页面」（setIgnoreMouseEvents(true, { forward: true })），
//      页面用 elementFromPoint 判断指针有没有落在宠物/气泡上，落在上面才关掉穿透。
//      判断在 renderer/pet/pet.js 里，这里只提供开关。
//
//   ② **位置按屏幕记**。存的是「在哪块屏 + 屏内坐标」，不是绝对坐标 ——
//      拔掉副屏之后绝对坐标会落到屏幕外面，宠物就再也找不到了。
//
//  拖动不用渲染层发增量坐标（那样会抖、还会跟系统缩放打架），
//  而是拖拽开始记下「光标离窗口左上角多远」，之后按光标真实位置摆窗口。
// ============================================================================

const path = require('node:path');
const { BrowserWindow, screen, shell } = require('electron');

const { loadPetConfig, findPet, petImageDataUrl } = require('./pet-store.js');

/** 1 倍缩放下的窗口尺寸（内容区）。缩放直接乘在这个上面 —— 见 applyScale */
const BASE_WIDTH = 300;
const BASE_HEIGHT = 380;

/** 默认摆位：主屏工作区右下角留这么多边距 */
const DEFAULT_MARGIN = 24;

let petWindow = null;
let dragTimer = null;
let dragOffset = null;
let dragStartBounds = null;
let moveSaveTimer = null;
// 当前窗口尺寸对应的缩放，避免每次都重建窗口
let currentScale = 1;

function petPagePath() {
  return path.join(__dirname, '..', 'renderer', 'pet', 'pet.html');
}

function petPreloadPath() {
  return path.join(__dirname, '..', 'preload-pet.js');
}

function getPetWindow() {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null;
}

/** 往宠物窗口推消息；窗口不在就当没这回事（宠物是可选功能，不能拖垮主流程） */
function sendToPet(channel, payload) {
  const win = getPetWindow();
  if (win) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
//  摆位
// ---------------------------------------------------------------------------

/** 尺寸按缩放算出来（四舍五入到整数，否则 Windows 上可能出现一像素白边） */
function sizeFor(scale) {
  const s = Math.max(0.4, Math.min(2, Number(scale) || 1));
  return {
    width: Math.round(BASE_WIDTH * s),
    height: Math.round(BASE_HEIGHT * s)
  };
}

/**
 * 算出窗口该摆在哪。
 *
 * 有记住的位置 → 尽量用它，但如果那块屏幕**不在了**（拔了副屏 / 改了分辨率），
 * 或者坐标已经掉到所有屏幕之外，就退回主屏右下角 —— 宁可位置变了，
 * 也不能让宠物「存在但看不见」。
 */
function resolveBounds(pet) {
  const { width, height } = sizeFor(pet && pet.scale);
  const saved = pet && pet.bounds;

  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const area = { x: saved.x, y: saved.y, width, height };
    const display = screen.getDisplayMatching(area);
    const work = display.workArea;
    // 至少要有四分之一露在工作区里，否则等于看不见了
    const visible =
      saved.x + width > work.x + 20 &&
      saved.x < work.x + work.width - 20 &&
      saved.y + height > work.y + 20 &&
      saved.y < work.y + work.height - 20;
    if (visible) return { x: saved.x, y: saved.y, width, height };
  }

  const work = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(work.x + work.width - width - DEFAULT_MARGIN),
    y: Math.round(work.y + work.height - height - DEFAULT_MARGIN),
    width,
    height
  };
}

/** 窗口尺寸变了（用户调缩放）时重新摆 —— 保持右下角不动，视觉上更像「变大了」 */
function applyScale(pet) {
  const win = getPetWindow();
  if (!win) return;
  const next = Math.max(0.4, Math.min(2, Number(pet && pet.scale) || 1));
  if (Math.abs(next - currentScale) < 0.001) return;

  const before = win.getBounds();
  const { width, height } = sizeFor(next);
  const x = before.x + (before.width - width);
  const y = before.y + (before.height - height);
  currentScale = next;
  win.setBounds({ x, y, width, height });
}

/** 记下当前位置（防抖）—— 拖动时 moved 会连发几十次，不能每次都写盘 */
function scheduleSaveBounds() {
  clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(() => {
    const win = getPetWindow();
    if (!win) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    // 位置只有主进程知道，所以这里直接写配置（渲染层那份是同一份文件的读者）
    require('./pet-ipc.js').rememberBounds({
      x: bounds.x,
      y: bounds.y,
      displayId: display.id
    });
  }, 500);
}

// ---------------------------------------------------------------------------
//  拖动
// ---------------------------------------------------------------------------

/**
 * 开始拖。
 *
 * offset = 「按下时光标离窗口左上角多远」。之后每次移动都让窗口摆到
 * 「当前光标位置 - offset」，光标就始终咬在宠物身上同一个点 —— 手感才跟拖窗口一致。
 * 轮询光标而不是用渲染层的 mousemove 增量：增量在多屏 / 缩放下会累积误差，
 * 宠物会越拖越偏，而且拖过屏幕边界时会跳。
 */
function startDrag() {
  const win = getPetWindow();
  if (!win || dragTimer) return;

  const winBounds = win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  dragOffset = { x: cursor.x - winBounds.x, y: cursor.y - winBounds.y };
  dragStartBounds = winBounds;

  dragTimer = setInterval(() => {
    const w = getPetWindow();
    if (!w) return stopDrag();
    const point = screen.getCursorScreenPoint();
    w.setPosition(Math.round(point.x - dragOffset.x), Math.round(point.y - dragOffset.y));
  }, 16);
}

/**
 * 结束拖动。**返回窗口有没有真的被挪动过**。
 *
 * 这个返回值是给「点一下宠物」用的：判断「点」和「拖」不能看渲染层的
 * clientX/clientY —— 窗口是**跟着光标跑**的，拖动过程中光标相对窗口的位置
 * 几乎不变，那对坐标一直是常量，永远判不出「拖过」。
 * 所以由主进程拿「按下时的窗口位置」和「松手时的窗口位置」比一下，最准。
 */
function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;

  const win = getPetWindow();
  let moved = false;
  if (win && dragStartBounds) {
    const now = win.getBounds();
    moved =
      Math.abs(now.x - dragStartBounds.x) > 3 || Math.abs(now.y - dragStartBounds.y) > 3;
  }
  dragStartBounds = null;
  if (win) scheduleSaveBounds();
  return moved;
}

// ---------------------------------------------------------------------------
//  创建 / 销毁
// ---------------------------------------------------------------------------

function createPetWindow() {
  const existing = getPetWindow();
  if (existing) return existing;

  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  const bounds = resolveBounds(pet);
  currentScale = Math.max(0.4, Math.min(2, Number(pet && pet.scale) || 1));

  petWindow = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 允许拿焦点：右键菜单和拖动都靠它，没有焦点时窗口被点一下会先「激活」
    // 再处理事件，菜单会闪一下。代价只是点宠物会把焦点从主窗口拿过来，
    // 而那是用户主动点的。
    focusable: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    // ⚠️ `show: false` 必须留着。BrowserWindow 默认是「建出来就显示」，
    //    而显示往往伴随一次激活 —— 宠物会在**启动的一瞬间把光标从输入框里挤走**。
    //    三次显示都走 showInactive（见 setPetVisible / startPet）：
    //    冒出来可以，抢焦点不行。
    show: false,
    title: '桌宠',
    // 一上来就穿透 + 转发移动事件，页面会自己判断该不该关掉穿透（见文件头 ①）
    webPreferences: {
      preload: petPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  // 置顶级别用 'screen-saver'：普通 alwaysOnTop 会被别的置顶窗口盖住
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });

  petWindow.loadFile(petPagePath());

  // 跟主窗口同一套守卫：宠物窗口也**绝不能**导航到别的文档 ——
  // preload 是每个文档都会注入的，拖一个 html 进去就等于把接口递出去了。
  // （这里暴露的接口比主窗口收窄得多，但道理一样：别开口子。）
  const ownPath = path.resolve(petPagePath());
  const isOwnDocument = (url) => {
    try {
      const target = new URL(String(url || ''));
      if (target.protocol !== 'file:') return false;
      const decoded = decodeURIComponent(target.pathname).replace(/^\//, '');
      return path.resolve(decoded) === ownPath;
    } catch (err) {
      return false;
    }
  };
  const blockForeignNavigation = (event, url) => {
    if (isOwnDocument(url)) return;
    event.preventDefault();
    console.warn('[pet] 拦下了一次宠物窗口导航:', url);
  };
  petWindow.webContents.on('will-navigate', blockForeignNavigation);
  petWindow.webContents.on('will-redirect', blockForeignNavigation);
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 宠物窗口里出现外链一律丢给系统浏览器，不在应用内开新窗
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  petWindow.on('moved', scheduleSaveBounds);
  petWindow.on('closed', () => {
    stopDrag();
    clearTimeout(moveSaveTimer);
    petWindow = null;
  });

  return petWindow;
}

/** 关掉宠物窗口（退出桌宠 / 关软件时用） */
function destroyPetWindow() {
  stopDrag();
  clearTimeout(moveSaveTimer);
  const win = getPetWindow();
  petWindow = null;
  if (win) win.destroy();
}

/** 显示 / 隐藏，返回最终是不是可见 */
function setPetVisible(visible) {
  if (!visible) {
    const win = getPetWindow();
    if (win) win.hide();
    return false;
  }
  const win = createPetWindow();
  win.showInactive(); // 别抢焦点：宠物冒出来不该打断正在打字的手
  return true;
}

/**
 * 宠物页面加载好了 —— 把当前该渲染的东西一次推给它。
 * 页面每次刷新（比如开发模式热重载）都会重新来一遍，所以这里必须是**幂等**的。
 */
function pushPetState() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  sendToPet('pet:state', {
    config,
    pet: pet ? { ...pet, image: petImageDataUrl(pet.look) } : null
  });
}

module.exports = {
  BASE_WIDTH,
  BASE_HEIGHT,
  petPagePath,
  createPetWindow,
  destroyPetWindow,
  getPetWindow,
  sendToPet,
  setPetVisible,
  pushPetState,
  applyScale,
  startDrag,
  stopDrag,
  scheduleSaveBounds
};
