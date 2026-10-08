'use strict';

// ============================================================================
//  renderer/pet/cat-figure.js —— 蓝白猫（蓝自）的动画状态机
//
//  从 Coopanion 形象包 figure.js（改编自 Pal-AI-Lab 大肥鲸 whale/figure.js，
//  AGPL-3.0）移植到 Mimitale 的宠物窗口。**动画逻辑一行未动** —— 弹簧、
//  铰链步态、头部四层视差、猫耳情绪表、fx 特效全部照旧；只换了「挂载层」：
//
//    原版（Coopanion）                      移植版（Mimitale pet 窗口）
//    ─────────────────────                  ─────────────────────────
//    SVG 世界里的 <g> + foreignObject        普通 HTML 容器 div
//    getScreenCTM() 算画布分辨率             getBoundingClientRect() + DPR
//    opts.kit.createRig（宿主注入）          import './rig.js'（同目录 module）
//    opts.loadImage(opts.asset(...))        opts.texMap（主进程 IPC 推来的
//    fetch model.json                        dataUrl Image —— pet.html 的 CSP 是
//                                            default-src 'none'，fetch 一律被拦，
//                                            所以 model 和贴图只能走 IPC）
//
//  口径保持和 kit 一致（驱动层 cat.js 按这套喂参数）：
//    draw(fc, o)
//      fc = { orbit, listen, think, sweat, anger, bang, question, streams } —— 特效开关
//      o  = { t, mode, face, facing, look:[x,y], swing, sit, low,
//             legs:[[hx,hy,fx,fy]×2], gesture:{kind,k}, modeT, tilt, lean }
//  rig 空间：x=128 在身体正下方，脚底 y=256（model.units 换算见 pack_cat.py）。
// ============================================================================

import { createRig } from './rig.js';

const f1 = n => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const bump = u => Math.sin(Math.PI * clamp(u, 0, 1));
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const SVGNS = 'http://www.w3.org/2000/svg';

// 头部视差变形器的作用域（rig 单位，[x0, y0, x1, y1]）：盖住两耳、刘海和整张脸。
// 头顶（呆毛根 V≈27）以上不进视差，腰以下（V≈172）不跟头动。
const HEAD = [72, 4, 198, 130];

// 大哭的泪从两眼正下方流到下巴沿线（fx 层 SVG；y 值全是 rig 单位）
const TEAR_END = { eyeL: 130, eyeR: 128 };

/**
 * 一条腿的铰链变形：髋部枢轴以下整段绕枢轴转 `a` 度（同刚体旋转）；枢轴上方
 * `fade` 单位内转角渐出——猫腿短（约 47 单位 vs 大肥鱼 86），fade 从 20 缩到 10，
 * 否则整条腿一半都在渐变区，迈步像果冻。`ty` 抬脚同样只作用于髋以下。
 */
function hinge([px, py], a, ty, fade = 10) {
  const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
  return (u, v, x, y) => {
    const w = smooth(py - fade * .3, py + fade * .7, y), lx = x - px, ly = y - py;
    return [(lx * c - ly * s - lx) * w, ((lx * s + ly * c - ly) + ty) * w];
  };
}

/* ---------- 弹簧 ---------- */
/** 弹簧收到非有限数目标时只记一次日志（NaN 会留在 x 里，读它的 warp 从此什么都画不出来）。 */
let badTargetLogged = false;
function spring(k, c, lim = Infinity) {
  return {
    x: 0, v: 0,
    step(target, dt) {
      if (!Number.isFinite(target) || !Number.isFinite(dt)) {
        if (!badTargetLogged) { badTargetLogged = true; console.warn(`[蓝白猫] 弹簧收到的目标不是有限数,这一帧不动:target=${target} dt=${dt}`); }
        return this.x;
      }
      this.v += ((target - this.x) * k - this.v * c) * dt;
      this.x += this.v * dt;
      if (Math.abs(this.x) > lim) { this.x = Math.sign(this.x) * lim; this.v = 0; }
      return this.x;
    },
  };
}

/**
 * 产出一个可 draw 的蓝白猫 figure。挂载目标是一个普通 HTML 容器（div）。
 *
 * @param {object} opts
 *   model   主进程推来的 model.json（rig 数据：units / pivots / parts / feat / view）—— 必传
 *   texMap  { 贴图名: HTMLImageElement }（dataUrl 已解码）—— 必传，按 parts[].tex / feat[].tex 取
 */
export function createCatFigure(opts = {}) {
  const model = opts.model;
  const texMap = opts.texMap;
  if (!model || !Array.isArray(model.parts) || !model.parts.length) {
    throw new Error('[蓝白猫] model 数据不完整（缺 parts）');
  }
  if (!texMap) throw new Error('[蓝白猫] 缺贴图 texMap');

  const { S, X0, FEET } = model.units;
  const U = x => 128 + (x - X0) * S, V = y => 256 - (FEET - y) * S;
  const PV = model.pivots;

  // ⚠️ 名字别叫 box：这个函数下面还有一个 box（挂载用的 DOM 壳），
  //    同名会造成 `Identifier 'box' has already been declared` 的**语法错误**，
  //    整个模块解析失败 → pet.js 一行都不执行（猫、气泡、穿透全没了）。
  const partBox = Object.fromEntries(model.parts.map(p => [p.id, p.box]));
  const rectOf = id => { const [x, y, w, h] = partBox[id]; return [x, y, x + w, y + h]; };

  /* 变形器：都在静止空间里定义，父级后于子级生效 */
  const deformers = {
    body: { kind: 'rot', pivot: PV.body },
    skirt: { kind: 'warp', parent: 'body', rect: rectOf('skirt') },
    // 上身（衣身、领、双臂、头）鞠躬时绕腰转，裙和腿不动
    waist: { kind: 'rot', parent: 'body', pivot: PV.waist },
    armNear: { kind: 'rot', parent: 'waist', pivot: PV.armNear },
    armFar: { kind: 'rot', parent: 'waist', pivot: PV.armFar },
    // 腿绕髋摆（hinge）：转动和抬脚只从髋往下生效，大腿根不跟着旋出裙腰
    legBack: { kind: 'warp', parent: 'body', rect: rectOf('leg_left') },
    legFront: { kind: 'warp', parent: 'body', rect: rectOf('leg_right') },
    tail: { kind: 'rot', parent: 'body', pivot: PV.tail },
    tailBend: { kind: 'warp', parent: 'tail', rect: rectOf('tail') },
    neck: { kind: 'rot', parent: 'waist', pivot: PV.neck },
    // 头部视差分四层：前发/呆毛 > 五官(feat) > 脸 > 后脑（反向）
    headBack: { kind: 'warp', parent: 'neck', rect: HEAD },
    headMid: { kind: 'warp', parent: 'neck', rect: HEAD },
    headFeat: { kind: 'warp', parent: 'neck', rect: HEAD },
    headFront: { kind: 'warp', parent: 'neck', rect: HEAD },
    bangsSway: { kind: 'warp', parent: 'headFront', rect: rectOf('bangs') },
    earNear: { kind: 'rot', parent: 'headMid', pivot: PV.earNear },
    earFar: { kind: 'rot', parent: 'headBack', pivot: PV.earFar },
    ahoge: { kind: 'rot', parent: 'headFront', pivot: PV.ahoge },
  };
  // 五官叠加层（feat）：和部件一起交给 rig 渲染，只是父变形器是 headFeat（参数与
  // face 的 headMid 相同 → 五官跟脸同步视差）。
  // eye_open / eye_closed 是**眨眼对**（名字约定见 pack_cat.py 的 FEAT_DEF）——
  // 同一时刻只显示一个，靠 st.alpha 在两者间切换（rig.render 支持 st.alpha[id]）。
  // 老形象包 model.feat 为空 → featParts 为空 → hasBlink false，行为与从前完全一致。
  const featParts = model.feat ? Object.values(model.feat) : [];
  const hasBlink = featParts.some(p => p.id === 'eye_open') && featParts.some(p => p.id === 'eye_closed');
  const parts = [...model.parts, ...featParts].map(p => ({ ...p }));

  /* ---------- 挂载（HTML 版） ---------- */
  const VIEW = model.view;
  // box：铺满容器、负责居中的壳；sizer：与 VIEW 等比的那块画布区，镜像（scaleX）
  // 施加在 sizer 上 —— canvas 自己不用 transform，避免和居中定位打架。
  let container = null, box = null, sizer = null, canvas = null, fxSvg = null, rig = null, pxW = 0, frameN = 0;

  /**
   * 把 canvas（猫本体）+ fx svg（头顶特效层）挂进容器。
   * 上一个 rig 的 GL 上下文要等到 GC 才死：不释放的话反复换形象会攒满
   * Chromium 的每页上下文上限（~16），之后的挂载全画空白 —— 所以先 dispose。
   */
  function mount(el) {
    if (box && box.parentNode === el) return; // 已经挂在目标上
    rig?.dispose();
    rig = null;
    if (box && box.parentNode) box.parentNode.removeChild(box);

    box = document.createElement('div');
    box.className = 'rig-box';
    // 贴底居中（窗口底边 = 桌面，猫站着不离地）。
    // pointer-events:none —— 命中判断走 pet.js 的 alpha 掩码，box 自己不接事件。
    box.style.cssText = 'position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;pointer-events:none';
    sizer = document.createElement('div');
    sizer.className = 'rig-sizer';
    sizer.style.cssText = 'position:relative';
    canvas = document.createElement('canvas');
    canvas.className = 'rig-canvas';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
    // fx 层：一个 viewBox=VIEW 的 svg 盖在 canvas 上 —— 原版里特效画在 SVG 世界
    // 坐标系（= rig 单位）里，HTML 版用 viewBox 达到同样的坐标映射，fx 代码零改动。
    // sizer 已和 VIEW 等比，所以 preserveAspectRatio 用 none 也安全（含 visible 兜底）。
    fxSvg = document.createElementNS(SVGNS, 'svg');
    fxSvg.setAttribute('class', 'rig-fx');
    fxSvg.setAttribute('viewBox', `${VIEW[0]} ${VIEW[1]} ${VIEW[2] - VIEW[0]} ${VIEW[3] - VIEW[1]}`);
    fxSvg.setAttribute('preserveAspectRatio', 'none');
    fxSvg.setAttribute('overflow', 'visible');
    fxSvg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none';
    fxSvg.appendChild(document.createElementNS(SVGNS, 'g'));
    sizer.append(canvas, fxSvg);
    box.appendChild(sizer);
    el.appendChild(box);

    rig = createRig(canvas, { deformers, parts, view: VIEW });
    for (const n in texMap) rig.upload(n, texMap[n]);
    container = el; pxW = 0;
  }

  /**
   * 画布尺寸：容器内**双向 contain**（窗口 300×380 ≈ 0.79 vs VIEW 188:288 ≈ 0.65，
   * 按宽 fit 会竖向溢出 —— 必须取 min），再乘 DPR × 1.25 超采样（沿原版）。
   * 每 20 帧查一次 + 变化小于 8% 不动，避免拖拽缩放时反复重建 GL 尺寸。
   *
   * 贴地：VIEW 底部留了 FEET_PAD 单位的余量（尾巴 / 跳跃），猫脚（y=256）在
   * view 底之上 —— 用负 margin 把这段余量沉到窗口底以下，脚底刚好踩在窗口边上。
   */
  const FEET_PAD = 20; // view 底（276）到脚底（256）
  function fitCanvas() {
    if (!container || !sizer) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const vw = VIEW[2] - VIEW[0], vh = VIEW[3] - VIEW[1];
    const cssW = Math.min(rect.width, rect.height * vw / vh);
    const cssH = cssW * vh / vw;
    const k = (window.devicePixelRatio || 1) * 1.25;
    const wantPx = Math.max(16, Math.round(cssW * k));
    if (pxW && Math.abs(wantPx - pxW) / pxW < .08) return;
    pxW = wantPx;
    sizer.style.width = `${f1(cssW)}px`;
    sizer.style.height = `${f1(cssH)}px`;
    sizer.style.marginBottom = `${-(cssH * FEET_PAD / vh).toFixed(1)}px`;
    canvas.width = wantPx;
    canvas.height = Math.max(16, Math.round(cssH * k));
  }

  /* ---------- 每帧状态 ---------- */
  const sp = {
    hairY: spring(50, 8, 1.2), bangs: spring(110, 10, 1.6),
    skirt: spring(100, 9, 1.6), skirtY: spring(90, 10, 1.1), tail: spring(40, 5, 32),
    ears: spring(90, 9, 30), ahoge: spring(140, 6, 38), head: spring(70, 10, 16),
    armN: spring(60, 9, 125), armF: spring(60, 9, 95),
  };
  let lastT = null, prevTilt = 0, prevYaw = 0, prevLow = 0, headTilt = 0, fx = '';
  // kit 为 Coo 的圆身体设计的整组倾斜（倾听、点头、打瞌睡、晕）换成她动头、脚不离地；
  // 只有腾空、被拎、起跳下蹲和落地整组倾斜，跑步保留一半前倾，跳舞六成给整组
  const GROUP = { air: [1, 1], drag: [1, 1], crouch: [1, 1], land: [1, 1], walk: [1, .5], run: [1, .5], dance: [.6, 0] };
  let wTilt = 0, wLean = 0, facing = 1;
  let earMood = 0, tailMood = 0, wagAmp = 0, sitK = 0, walkK = 0, runK = 0;
  const groupTilt = (mode, tilt, lean) => tilt * wTilt + lean * wLean + runK * 14 * facing;
  const st = {};

  // 眨眼（只在形象包带 feat 眨眼对时生效）：blinkU 1=睁、0=闭。
  // 随机隔一会儿眨一次，一次 0.15 秒 —— 用 |cos(πp)| 做「闭上再睁开」的包络，
  // 不用两条弹簧（眨眼太短，弹簧会把它抹平）。
  const BLINK_DUR = 0.15;
  let blinkU = 1, blinkWait = 1.5 + Math.random() * 3, blinkAt = -1;

  // 猫耳和尾巴跟着表情走：耳竖(+)或垂(-)，尾巴摇的幅度
  const MOOD = {
    happy: [.8, 1], love: [.9, 1], wink: [.5, .7], surprised: [1, .2], angry: [.9, .15], sad: [-1, 0], shy: [-.5, .3],
    sleepy: [-.7, 0], sleep: [-.9, 0], dizzy: [-.3, 0], dragged: [.6, .6], content: [-.2, .25], listening: [.6, .2],
    thinking: [.1, .15], run: [.2, .4], waking: [-.4, 0], squeeze: [-.3, 0], neutral: [0, .25],
    smug: [.5, .6], pout: [.3, 0], worried: [-.3, .1], determined: [.9, .3], flustered: [.4, .8], scared: [-1, 0],
    excited: [1, 1], cry: [-1, 0], confused: [.2, .1], bowing: [-.2, .2],
  };
  // 头跟着表情：歪头（度，向前 +）和低头（angleY，向下 +）
  const HEAD_TILT = { shy: 7, thinking: -8, smug: -6, pout: -4, confused: -7, worried: 3, cry: 4 };
  const HEAD_PITCH = { sad: .35, cry: .45, worried: .15 };

  /** 当前朝向（1=右，-1=左）。镜像用 sizer 的 CSS scaleX 实现（canvas + fx 一起翻，rig 内部坐标不翻）。 */
  function setFacing(f) {
    facing = Math.sign(f || 1) || 1;
    if (sizer) sizer.style.transform = facing < 0 ? 'scaleX(-1)' : '';
  }

  function draw(fc, o) {
    if (!box || !box.parentNode) {
      if (!container) return; // 没挂载目标：先 mount(container) 再 draw
      mount(container);
    }
    if (frameN++ % 20 === 0) fitCanvas();
    const t = o.t, dt = lastT == null ? 1 / 60 : clamp(t - lastT, 0, .05);
    lastT = t;
    const mode = o.mode || 'idle', face = o.face || 'neutral';
    facing = Math.sign(o.facing || 1);
    const walking = mode === 'walk' || mode === 'run', held = mode === 'drag', airborne = mode === 'air';

    /* 眨眼（没有 feat 眨眼对就整段跳过，blinkU 保持 1） */
    if (hasBlink) {
      if (blinkAt < 0) {                       // 睁着，倒计时等下一次
        blinkWait -= dt;
        if (blinkWait <= 0) { blinkAt = t; blinkWait = 1.6 + Math.random() * 3.4; }
      }
      if (blinkAt >= 0) {                      // 正在眨：|cos| 从 1 到 0 再回 1
        const p = (t - blinkAt) / BLINK_DUR;
        if (p >= 1) { blinkAt = -1; blinkU = 1; } else blinkU = Math.abs(Math.cos(p * Math.PI));
      }
      if (mode === 'sleep') blinkU = 0;        // 睡着：一直闭着
    }

    /* 身体：kit 的 `low` 是髋部下沉量（坐下、走路颠簸） */
    sitK = lerp(sitK, clamp(o.sit ?? 0, 0, 1), ease(12, dt));
    const low = o.low || 0;
    const lowV = (low - prevLow) / Math.max(dt, 1e-3); prevLow = low;
    const breath = Math.sin(t * (mode === 'sleep' ? 1.7 : 2.4));

    /* 头：朝视线歪，睡觉点头，晕的时候晃 */
    let tiltT = o.look[0] * .7 + Math.sin(t * .9) * 1.2 + o.look[1] * .4;
    if (mode === 'sleep') tiltT += 6;
    tiltT += HEAD_TILT[face] || 0;
    if (face === 'dizzy') tiltT += 3 * Math.sin(t * 4.5);
    if (held) tiltT += o.swing * .25;
    headTilt = sp.head.step(tiltT, dt);
    // kit 想让整组做而整组没接过去的倾斜，转给脖子（向前 +）
    const [gT, gL] = GROUP[mode] || [0, 0];
    const bend = (o.tilt ?? 0) * (1 - wTilt) + (o.lean ?? 0) * Math.sign(o.facing || 1) * (1 - wLean);
    wTilt = lerp(wTilt, gT, ease(10, dt)); wLean = lerp(wLean, gL, ease(10, dt));
    // 短手势由她自己画：点头低头两下、摇头左右转、招手、鞠躬
    const g = o.gesture, gk = g ? g.k : 0;
    const env = (a, b) => smooth(0, a, gk) * (1 - smooth(b, 1, gk));
    const nod = g?.kind === 'nod' ? Math.sin(gk * Math.PI * 2) ** 2 * (1 - .3 * gk) : 0;
    const shake = g?.kind === 'shake' ? Math.sin(gk * Math.PI * 6) * smooth(0, .12, gk) * (1 - gk) : 0;
    const wave = g?.kind === 'wave' ? env(.15, .8) : 0;      // 一只手举到头侧挥
    const bow = g?.kind === 'bow' ? env(.25, .7) : 0;        // 上身绕腰前倾
    const shiver = g?.kind === 'shiver' ? env(.08, .85) : 0; // 抱紧发抖、耳朵压下
    const flap = g?.kind === 'flap' ? env(.05, .75) : 0;     // 耳、尾、呆毛、双臂一起扑腾
    const gNeck = nod * 7 + shake * 2.5 + bow * 10 + wave * 4, gYaw = shake * 1.1;
    const headA = headTilt + gNeck;
    const tiltVel = (headA - prevTilt) / Math.max(dt, 1e-3); prevTilt = headA;
    const yawVel = (gYaw - prevYaw) / Math.max(dt, 1e-3); prevYaw = gYaw;
    const angleX = clamp(clamp(o.look[0] / 5, -1, 1) * .9 + gYaw, -1.4, 1.4);
    // angleY + 低头（脸整体下移、头顶露出更多），往下看、睡觉、难过、大哭都是正
    const angleY = clamp(clamp(o.look[1] / 4, -1, 1) * .7 + (mode === 'sleep' ? .8 : 0) + (HEAD_PITCH[face] || 0) + nod * .9 + bow * .5, -1.4, 1.4);

    /* 弹簧 */
    const sway = clamp(o.swing / 26, -1.6, 1.6);
    const up = airborne || held ? 1 : 0;
    const hairY = sp.hairY.step(up * -1 + lowV * .006, dt);
    const bangs = sp.bangs.step(sway * .7 - tiltVel * .004 - yawVel * .03, dt);
    const skirt = sp.skirt.step(sway * .8 + (walking ? -.2 : 0), dt);
    const flare = sp.skirtY.step(up * .8 + sitK * .6 + clamp(-lowV * .01, -.3, .6), dt);
    const [em, wg] = MOOD[face] || MOOD.neutral;
    earMood = lerp(earMood, lerp(em, -.6, shiver), ease(6, dt));
    wagAmp = lerp(wagAmp, wg, ease(3, dt));
    tailMood = lerp(tailMood, mode === 'sleep' || face === 'sad' || face === 'cry' || face === 'scared' ? -1 : 0, ease(3, dt));
    // 快速扑腾直接加在弹簧后面（弹簧会把它抹平）
    const ears = sp.ears.step(earMood * 14 + sway * 10, dt) + (face === 'angry' ? 2.5 * Math.sin(t * 40) : 0) + flap * 13 * Math.sin(t * 26);
    const ahoge = sp.ahoge.step(-tiltVel * .12 - yawVel * .5 + sway * 18 + (face === 'surprised' ? -16 : 0) + (face === 'confused' ? 20 : 0) + (mode === 'sleep' ? 22 : 0) - hairY * 12, dt)
      + flap * 12 * Math.sin(t * 19);
    const tail = sp.tail.step(sway * 14 + tailMood * 12, dt) + wagAmp * 13 * Math.sin(t * (4 + 5 * wagAmp)) + Math.sin(t * 1.3) * 3
      + flap * 14 * Math.sin(t * 17);

    /* 腿：kit 给的是髋->脚线段（按 Coo 的尺寸），取角度（脚在髋右前方为正） */
    const legA = o.legs.map(l => -Math.atan2(l[2] - l[0], Math.max(4, l[3] - l[1])) * 180 / Math.PI);
    const lift = o.legs.map(l => clamp(29 - Math.hypot(l[2] - l[0], l[3] - l[1]), -8, 20));

    /* 手臂：走路时与腿反向摆，腾空张开，被拎时扑腾 */
    walkK = lerp(walkK, walking ? 1 : 0, ease(8, dt));
    runK = lerp(runK, mode === 'run' ? 1 : 0, ease(7, dt));
    let aN = 4, aF = -2;
    if (walking) { aN = -legA[0] * 1.3 + 4; aF = -legA[1] * 1.3 - 2; }
    if (airborne) { aN = 40; aF = -30; }
    if (held) { aN = 70 + 16 * Math.sin(t * 13); aF = -45 - 12 * Math.sin(t * 13 + 1.3); }
    if (sitK > .5 && !walking) { aN = lerp(aN, -4, sitK); aF = lerp(aF, -6, sitK); }
    if (face === 'happy' || face === 'love') { aN += 12 + 5 * Math.sin(t * 8); aF -= 8 + 4 * Math.sin(t * 8); }
    if (face === 'angry') { aN = 20 + 3 * Math.sin(t * 30); aF = -18 - 3 * Math.sin(t * 30); }
    if (face === 'determined') { aN = 14; aF = -10; }
    if (face === 'excited') { aN += 18; aF -= 12; }
    if (mode === 'dance') { const b = Math.sin((o.modeT || 0) * Math.PI * 2 * 1.1); aN = 16 + 24 * Math.max(0, b); aF = -8 - 22 * Math.max(0, -b); }
    if (runK > .001) { aN = lerp(aN, 38, runK); aF = lerp(aF, 32, runK); }
    if (wave) aN = lerp(aN, 108, wave);
    if (shiver) { aN = lerp(aN, -10, shiver); aF = lerp(aF, 8, shiver); }
    const armN = sp.armN.step(aN, dt) + wave * 13 * Math.sin(t * 15) + shiver * 1.4 * Math.sin(t * 47) + flap * 9 * Math.sin(t * 24);
    const armF = sp.armF.step(aF, dt) - shiver * 1.2 * Math.sin(t * 43 + 1) - flap * 9 * Math.sin(t * 24 + 1);

    /* 变形器状态 */
    // 坐姿近似（没有坐姿贴图）：身体压低 + 裙摆摊开 + 腿大角度前伸，视觉上是「猫坐」
    st.body = { a: -sway * 1.2 + (held ? o.swing * .15 : 0), ty: low - 9.6 * sitK, sx: 1 + .006 * breath, sy: 1 - .012 * breath };
    st.waist = { a: bow * 20 };
    st.skirt = {
      fn: (u, v) => {
        const k = v * v;
        // 坐下时裙摆横向往外摊一点
        return [skirt * 4 * k + flare * (u - .45) * 9 * v + sitK * (u - .45) * 10 * v, -flare * k * 3 - sitK * k * 8];
      },
    };
    st.armNear = { a: armN };
    st.armFar = { a: armF };
    st.legBack = { fn: hinge(PV.legBack, lerp(legA[0], -55, sitK), -lift[0] * .9 * (1 - sitK)) };
    st.legFront = { fn: hinge(PV.legFront, lerp(legA[1], -60, sitK), -lift[1] * .9 * (1 - sitK)) };
    st.tail = { a: tail - 10 * sitK };
    st.tailBend = { fn: u => [0, -tail * .5 * u * u] };
    st.neck = { a: headA + clamp(bend * .8, -10, 12) - runK * 12, ty: (mode === 'sleep' ? 2.5 : 0) + breath * .35 };
    const parallax = (k, ky) => (u, v) => [angleX * k * bump(u) * (.4 + .6 * bump(v)), angleY * ky * bump(v) * (.4 + .6 * bump(u))];
    st.headFront = { fn: parallax(4.2, 2.8) };
    st.headFeat = { fn: parallax(2, 1.4) };
    st.headMid = { fn: parallax(2, 1.4) };
    st.headBack = { fn: parallax(-1.4, -1) };
    st.bangsSway = { fn: (u, v) => [bangs * 3.2 * v * v + Math.sin(t * 1.9 + u * 2) * .5 * v * v, hairY * 3 * v * v] };
    st.ahoge = { a: ahoge * .5 + Math.sin(t * 2.1) * 2 };
    st.earNear = { a: ears + Math.sin(t * 1.4) * 1.5 };
    st.earFar = { a: -ears * .8 - Math.sin(t * 1.4) * 1.2 };
    // 眨眼对：同一位置两张贴图，用 alpha 交叉切换（都是 0~1，加起来恰好 1）
    if (hasBlink) st.alpha = { eye_open: blinkU, eye_closed: 1 - blinkU };

    rig.render(st);
    drawFx(fc, t);
  }

  /* ---------- 身上的小特效（SVG，画在 rig 之上） ---------- */
  const AC = '#5B84E4';  // 睡眠 z / 倾听弧 / 思考泡的强调色：宝蓝
  const at = (x, y) => rig.point('neck', st, x, y);
  function drawFx(fc, t) {
    let s = '';
    const top = at(135, 25), side = at(190, 60);
    if (fc.orbit) {   // 想事情：头顶三点起伏
      for (let i = 0; i < 3; i++) {
        const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
        s += `<path fill="#ffd23f" stroke="#3a2f7a" stroke-width="1.6" stroke-linejoin="round" opacity="${sn < 0 ? .55 : 1}" transform="translate(${f1(top[0] + 56 * Math.cos(a))} ${f1(top[1] - 4 + 10 * sn)}) scale(${sn < 0 ? .7 : 1})" d="M0 -7L2 -2L7 -2L3 1L4.5 6.5L0 3.3L-4.5 6.5L-3 1L-7 -2L-2 -2Z"/>`;
      }
    }
    if (fc.listen) {  // 倾听：右耳旁三条弧
      for (let i = 0; i < 3; i++) {
        const p = (t * .9 + i / 3) % 1, r = 36 - 24 * p, c = at(195, 100);
        s += `<path fill="none" stroke="${AC}" stroke-width="5" stroke-linecap="round" opacity="${f1(Math.sin(Math.PI * p))}" d="M${f1(c[0] + r * Math.cos(-.55))} ${f1(c[1] + r * Math.sin(-.55))}A${f1(r)} ${f1(r)} 0 0 1 ${f1(c[0] + r * Math.cos(.55))} ${f1(c[1] + r * Math.sin(.55))}"/>`;
      }
    }
    if (fc.think) {   // 思考泡：右上三个圆
      for (let i = 0; i < 3; i++) {
        const k = (t * .8 + i / 3) % 1;
        s += `<circle fill="#e8f0ff" stroke="${AC}" stroke-width="3" cx="${f1(side[0] + 10 * i)}" cy="${f1(side[1] - 20 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f1(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
      }
    }
    if (fc.sweat) {   // 冷汗
      const c = at(185, 80 + 3 * Math.sin(t * 7));
      s += `<path fill="#8fd0ff" stroke="#2f5fae" stroke-width="1.4" transform="translate(${f1(c[0])} ${f1(c[1])}) scale(1.4)" d="M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z"/>`;
    }
    if (fc.anger) {   // 怒气符号
      const c = at(180, 55), k = 1 + .12 * Math.sin(t * 10);
      s += `<g transform="translate(${f1(c[0])} ${f1(c[1])}) scale(${f1(k)})" fill="none" stroke="#e5484d" stroke-width="5" stroke-linecap="round"><path d="M-11 -3Q-3 -3 -3 -11M3 -11Q3 -3 11 -3M11 3Q3 3 3 11M-3 11Q-3 3 -11 3"/></g>`;
    }
    if (fc.bang) {    // 感叹号
      const c = at(190, 35);
      s += `<g transform="translate(${f1(c[0])} ${f1(c[1])})"><path fill="none" stroke="#252049" stroke-width="8" stroke-linecap="round" d="M0 -16V3"/><circle fill="#252049" cx="0" cy="14" r="4.5"/></g>`;
    }
    if (fc.question) {  // 问号
      const c = at(190, 35), k = 1 + .06 * Math.sin(t * 3);
      s += `<g transform="translate(${f1(c[0])} ${f1(c[1])}) scale(${f1(k)})"><path fill="none" stroke="#252049" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M-8 -9Q-8 -19 0 -19Q9 -19 9 -11Q9 -4 0 -1V4"/><circle fill="#252049" cx="0" cy="14" r="4.5"/></g>`;
    }
    if (fc.streams) { // 大哭：两眼下面各一道泪（静态脸版画在 fx 层）
      s += tearsSvg(t);
    }
    if (fx !== s) { fxSvg.firstChild.innerHTML = s; fx = s; }
  }
  function tearsSvg(t) {
    let s = '';
    [[U(655), 106, 'eyeL'], [U(805), 104, 'eyeR']].forEach(([x, y0, k]) => {
      const y1 = TEAR_END[k], wob = 3 * Math.sin(t * 6 + (k === 'eyeL' ? 0 : 1));
      const cTop = at(x, y0), cBot = at(x, y1);
      s += `<path fill="rgba(120,195,255,.85)" d="M${f1(cTop[0] - 4)} ${f1(cTop[1])}C${f1(cTop[0] - 6 + wob)} ${f1((cTop[1] + cBot[1]) / 2)} ${f1(cBot[0] - 6 + wob)} ${f1(cBot[1] - 14)} ${f1(cBot[0] - 4)} ${f1(cBot[1])}Q${f1(cBot[0] + 1)} ${f1(cBot[1] + 6)} ${f1(cBot[0] + 4)} ${f1(cBot[1])}C${f1(cBot[0] + 6 + wob)} ${f1(cBot[1] - 14)} ${f1(cTop[0] + 6 + wob)} ${f1((cTop[1] + cBot[1]) / 2)} ${f1(cTop[0] + 4)} ${f1(cTop[1])}Z"/>`;
    });
    return s;
  }

  return {
    draw,
    setFacing,
    groupTilt,
    /** 她自己画的短手势：点头、摇头、招手、鞠躬 */
    gestures: ['nod', 'shake', 'wave', 'bow'],
    /** 忘掉运动状态（弹簧、时钟），给从头重放时间线的调用方 */
    reset() {
      for (const k in sp) { sp[k].x = 0; sp[k].v = 0; }
      lastT = null; prevTilt = 0; prevYaw = 0; prevLow = 0; headTilt = 0;
      wTilt = 0; wLean = 0; earMood = 0; tailMood = 0; wagAmp = 0; sitK = 0; walkK = 0; runK = 0;
      blinkU = 1; blinkWait = 1.5 + Math.random() * 3; blinkAt = -1;
    },
    /** 释放 WebGL 上下文和挂上去的 DOM；figure 对象本身可复用（下次 draw 重挂） */
    dispose() {
      rig?.dispose();
      rig = null; canvas = null; fxSvg = null; sizer = null; box = null; container = null;
    },
    /** 挂载目标（draw 时自动挂上去） */
    mount,
    get canvas() { return canvas; },
    get colors() { return { z: AC }; },
    // 锚点（母版像素换算；供驱动层定位气泡 / 视线参考）
    anchors: {
      gaze: [U(728), V(640)],
      tear: [U(728), V(700)],
      tears: [[U(655), V(700)], [U(805), V(700)]],
      z: [200, 30],
      hearts: [90, 170, 140],
      bubble: [128, 16],
    },
    model,
  };
}
