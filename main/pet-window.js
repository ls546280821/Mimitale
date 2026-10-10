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
//   ② **位置能自我救回**。存的其实是**绝对坐标**（外加一个 displayId 作为记录），
//      还原时不做「按屏内坐标换算」，而是拿这块矩形问系统它落在哪块屏
//      （screen.getDisplayMatching），再检查它是否还和那块屏的工作区相交。
//      副屏拔掉后坐标会落在屏幕外 → 相交检查不过 → 退回主屏右下角，
//      所以「宠物存在但再也看不见」这条同样不会发生（displayId 只留作记录）。
//
//  拖动不用渲染层发增量坐标（那样会抖、还会跟系统缩放打架），
//  而是拖拽开始记下「光标离窗口左上角多远」，之后按光标真实位置摆窗口。
// ============================================================================

const path = require('node:path');
const { BrowserWindow, screen, shell } = require('electron');

const { loadPetConfig, findPet, petRigPack } = require('./pet-store.js');

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
// == 下面这两个用于「尺寸自愈」：
//    尺寸纠正本身会再送一次 'resize'，直接同步调就是递归、连着调就是事件风暴，
//    所以 resize 那条路一律先攒一下（sizeFixTimer）再纠。
let sizeFixTimer = null;
// 上一次**真正**纠尺寸的时刻（节流用，见 throttledEnsureSize）
let sizeFixAt = 0;
// 当前窗口**内容区**尺寸对应的缩放。所有尺寸判断都以它为准 ——
// 注意它不是从 getBounds 反推的，而是我们自己维护的「应该多大」
let currentScale = 1;
// 拖动期间收到的新缩放，拖完再应用（拖动中改尺寸会让锚点错位）
let pendingScale = null;

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
 * 窗口**内容区**的矩形（含校验后的 x / y）。
 *
 * ⚠️ 一律走 getContentBounds / setContentBounds，**别用 getBounds / setBounds**。
 *    这个窗口是 useContentSize: true，而 Windows 上「含边框尺寸 ↔ 内容尺寸」的
 *    换算是按 **DPI 比例**做的、且会四舍五入。跨屏拖动（两块不同 DPI 的显示器）
 *    时，一次 getBounds → setBounds 往返就可能把内容区悄悄改掉几像素；
 *    反复往返就会**越变越大** —— 这正是「在别的电脑上按住宠物会慢慢变大」的形态。
 *    getContentBounds 直接返回内容区尺寸，不参与那套边框换算，往返恒等。
 */
function contentBoundsOf(win) {
  try {
    return win.getContentBounds();
  } catch (err) {
    // 极老的 Electron 才没有这个 API；退化成 getBounds（本项目 electron ^44，正常走不到）
    return win.getBounds();
  }
}

/** 内容区尺寸是否是当前缩放该有的样子（允许 1px 的取整误差） */
function sizeMatchesScale(win, scale) {
  const want = sizeFor(scale);
  const now = contentBoundsOf(win);
  return Math.abs(now.width - want.width) <= 1 && Math.abs(now.height - want.height) <= 1;
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
    // 至少要有 20px 和这块屏的工作区相交，否则等于看不见了
    // （比「四分之一可见」宽：猫本体的命中区小于窗口，压到边角也还能拖回来）
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

  // 拖动 / 散步期间改尺寸会让「窗口跟着光标跑」的锚点错位（宠物会在手底下跳一下），
  // 所以拖完再应用 —— 记下待应用的缩放，stopDrag 收尾时补上。
  if (dragTimer) {
    pendingScale = next;
    return;
  }
  commitScale(win, next);
}

/** 真正把缩放落到窗口上（applyScale 与 stopDrag 共用） */
function commitScale(win, next) {
  if (!win || win.isDestroyed()) return;
  const before = contentBoundsOf(win);
  const { width, height } = sizeFor(next);
  // 保持右下角不动：左上角跟着尺寸差平移
  const x = before.x + (before.width - width);
  const y = before.y + (before.height - height);
  currentScale = next;
  win.setContentBounds({ x, y, width, height });
}

/**
 * 尺寸自愈：内容区如果**不是**当前缩放该有的尺寸，就纠回来。
 *
 * 为什么要这一步 —— 「按住宠物会慢慢变大」「散步时越来越大」这两条，代码里
 * 没有任何一处会去放大窗口（全仓只有 applyScale 这一个 setContentBounds）。
 * 会变的只有**系统那边**：transparent + useContentSize 的窗口被拖动 / 跨 DPI 移动
 * 时，Chromium 会重算一次 content 尺寸，而重算用的基准可能与我们的不一致，
 * 于是每次移动都长一点 —— 表现正好是「慢慢变大」。
 * 与其去猜系统那套换算，不如**每次移动后校验并纠偏**：不管它怎么改，
 * 都按 sizeFor(currentScale) 拉回原样。这样「变大」在下一帧就被抹掉。
 *
 * 只在窗口可见时纠（隐藏时改了没意义，还可能和 show 时的摆位打架）。
 */
function ensureSize() {
  const win = getPetWindow();
  if (!win || !win.isVisible()) return;
  if (sizeMatchesScale(win, currentScale)) return;
  const now = contentBoundsOf(win);
  const { width, height } = sizeFor(currentScale);
  win.setContentBounds({
    x: now.x + (now.width - width),
    y: now.y + (now.height - height),
    width,
    height
  });
}

/**
 * 挪动宠物窗口（拖动 / 散步共用的那个 16ms 步进全走它）。
 *
 * ⚠️⚠️ 必须用 setContentBounds **带上尺寸**，绝不能用 setPosition：
 *    setPosition 只挪位置、尺寸沿用当前值 —— 而系统在窗口每次移动后会重算一次
 *    内容区尺寸（useContentSize 的窗口按 DPI 换算，一次漂一点），挪一次涨一点，
 *    拖久了就越来越大。
 *    每一步都把「位置 + 正确尺寸」一起写下去，系统**连漂移的机会都没有** ——
 *    也就不需要事后纠；不用「先挪再纠」，窗口就不会在两个值之间每帧振荡
 *    （2026-10-10 第四轮：先 setPosition 再 ensureSize 纠回去 = 宠物抖个不停）。
 *
 * 为什么尺寸取的是 currentScale 而不是读回来的：读回来的那个可能刚被系统改过，
 * 写回去等于把脏值固化；写「应该的值」才是把窗口当**我们**的。
 */
function movePetWindow(x, y) {
  const win = getPetWindow();
  if (!win || win.isDestroyed()) return;
  const { width, height } = sizeFor(currentScale);
  win.setContentBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

/**
 * resize 那条路的尺寸纠正（**节流**，不是防抖）。
 *
 * ⚠️ 这里用防抖会饿死：拖动 / 散步时系统连着重算尺寸、resize 事件源源不断，
 *    「停下 60ms 才执行」等于永远不执行 —— 表现就是「长按拖动时一直变大、
 *    松手才变回去」（2026-10-10 实际踩过这个坑）。节流保证持续事件里也至少
 *    每 SIZE_FIX_MS 纠一次。
 */
const SIZE_FIX_MS = 80;
function throttledEnsureSize() {
  const now = Date.now();
  const wait = SIZE_FIX_MS - (now - sizeFixAt);
  if (wait <= 0) {
    clearTimeout(sizeFixTimer);
    sizeFixTimer = null;
    sizeFixAt = now;
    ensureSize();
    return;
  }
  if (sizeFixTimer) return; // 已经排了一个在等，别插队
  sizeFixTimer = setTimeout(() => {
    sizeFixTimer = null;
    sizeFixAt = Date.now();
    ensureSize();
  }, wait);
}

/** 记下当前位置（防抖）—— 拖动时 moved 会连发几十次，不能每次都写盘 */
function scheduleSaveBounds() {
  clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(() => {
    const win = getPetWindow();
    if (!win) return;
    const bounds = contentBoundsOf(win);
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

  const winBounds = contentBoundsOf(win);
  const cursor = screen.getCursorScreenPoint();
  dragOffset = { x: cursor.x - winBounds.x, y: cursor.y - winBounds.y };
  dragStartBounds = winBounds;

  dragTimer = setInterval(() => {
    const w = getPetWindow();
    if (!w) return stopDrag();
    const point = screen.getCursorScreenPoint();
    // 走 movePetWindow（setContentBounds 带尺寸）而不是 setPosition：
    // 让系统每一步都拿到「位置 + 正确尺寸」，它没有机会漂，我们也就不用纠 ——
    // 不「挪完再纠」就没有两个值之间的振荡 = 不抖。
    movePetWindow(point.x - dragOffset.x, point.y - dragOffset.y);
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
    const now = contentBoundsOf(win);
    moved =
      Math.abs(now.x - dragStartBounds.x) > 3 || Math.abs(now.y - dragStartBounds.y) > 3;
  }
  dragStartBounds = null;
  if (win) {
    // 拖完先纠一次尺寸（拖动期间系统可能把它改过），再应用拖动中攒下的缩放
    ensureSize();
    if (pendingScale !== null) {
      const next = pendingScale;
      pendingScale = null;
      commitScale(win, next);
    }
    scheduleSaveBounds();
  }
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
      // 设计记录 + CHANGELOG 写的就是「contextIsolation:true + sandbox:true 全开」，
      // 而主窗口 main/window.js 没写这行（= Electron 默认 true）。宠物窗口拿到的
      // 权限本来就比主界面窄，别让它反而比主窗口宽松。
      sandbox: true,
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

  // 移动之后同时做两件事：
  //   ① 防抖记位置（拖动 / 散步结束才落盘一次）
  //   ② **纠尺寸** —— 透明窗口移动时系统可能悄悄改了内容区尺寸，
  //      不纠的话就是「拖着拖着 / 溜达着溜达着越来越大」（见 ensureSize 注释）
  petWindow.on('moved', () => {
    scheduleSaveBounds();
    ensureSize();
  });
  // ⚠️ 只挂 'moved' 挡不住全部：Windows 重算内容区尺寸时**位置可能一点都不变**
  //    （只把尺寸改大），那种情况 'moved' 根本不送 —— 窗口就停在「变大」的样子上，
  //    再也缩不回来。用户报的「长按拖动时宠物放大」正对上这个：
  //    变大的那一侧不自愈，而尺寸一变又会走渲染层的 resize（那里重建命中掩码，
  //    见 renderer/pet/pet.js）。'resize' 兜住另一半，两条合起来才是
  //    「位置和尺寸都不漂」。
  //
  // ⚠️⚠️ 但**不能在事件里同步调 ensureSize**：ensureSize 自己就是 setContentBounds，
  //    它又会再送一次 'resize' —— 同步就是递归，连着调就是事件风暴（一轮拖动里
  //    系统每几毫秒重算一次尺寸，每次都纠就是每秒几十次窗口缩放 = 肉眼看是「闪」）。
  //    所以走**节流**（不是防抖！防抖会被持续到来的 resize 饿死，见 throttledEnsureSize）。
  petWindow.on('resize', () => throttledEnsureSize());
  petWindow.on('closed', () => {
    stopDrag();
    clearTimeout(moveSaveTimer);
    clearTimeout(sizeFixTimer);
    petWindow = null;
  });

  return petWindow;
}

/** 关掉宠物窗口（退出桌宠 / 关软件时用） */
function destroyPetWindow() {
  stopDrag();
  clearTimeout(moveSaveTimer);
  clearTimeout(sizeFixTimer);
  pendingScale = null;
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
  // 隐藏期间配置可能被改过（缩放 / 换形象），显示后按当前缩放纠一次尺寸，
  // 否则会以「上次显示时的旧尺寸」露出来
  ensureSize();
  return true;
}

/**
 * 构造给宠物窗口的那份状态。
 * 两个入口（页面 ready 时的主动推送、页面主动拉取 pet:state:get）都走这里，
 * 保证数据形状一致 —— 尤其 rig 字段两边必须一样，否则先到的「无 rig」那份
 * 会让渲染层把刚挂好的动态猫拆掉（只剩占位框）。
 *
 * rig 形象（蓝白猫）：model + 贴图转 dataUrl 一起推。宠物页面 CSP 是
 * default-src 'none'，fetch 一律被拦，只能由主进程读盘转好递过去。
 * 页面每次刷新（开发模式热重载等）都会重新来一遍，所以这里必须是**幂等**的。
 */
function buildPetStatePayload() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  const rig = pet ? petRigPack(pet.look) : null;
  return {
    config: { enabled: config.enabled, activeId: config.activeId },
    pet: pet ? { ...pet, rig } : null
  };
}

function pushPetState() {
  sendToPet('pet:state', buildPetStatePayload());
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
  // ⚠️ 必须导出：main/pet-ipc.js 的 `pet:state:get` 通道直接调它。
  //    漏掉的话那个 handler 每次抛 TypeError，宠物页面 pullState() 永远拿不到状态
  //    （只剩 pet:ready 的推送那条路，拉取那条是哑的）。
  buildPetStatePayload,
  applyScale,
  // 让散步循环在每趟走完时也纠一次尺寸（它移动窗口会触发 moved，但
  // 有些平台 moved 不送，兜底手动调一次更稳）
  ensureSize,
  // 拖动 / 散步的 16ms 步进用它挪窗口（setContentBounds 带尺寸，防漂）
  movePetWindow,
  sizeFor,
  startDrag,
  stopDrag,
  scheduleSaveBounds
};
