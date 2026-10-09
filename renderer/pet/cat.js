'use strict';

// ============================================================================
//  renderer/pet/cat.js —— 蓝白猫驱动层（「迷你 kit」）
//
//  figure（cat-figure.js）吃的是 Coopanion kit 的身体参数口径：
//    o = { t, mode, face, facing, look, swing, sit, low, legs, gesture, modeT }
//  但 Mimitale 没有「世界引擎」—— 没人告诉猫这一刻在走路还是被拎着。
//  这个模块就是那个缺的引擎：
//
//    · 步态生成：两腿相位差 π 的正弦摆动 + 抬脚 → legs 线段数组
//    · 状态机：idle / walk / sleep / drag + face + 偶发小手势
//    · 事件翻译：pet:busy→想事情、pet:say→开心、点它→点头/摇头、
//      拖拽→被拎扑腾、pet:walk→散步步态
//    · 视线跟鼠标（穿透转发过来的 mousemove 让这成为白捡的）
//
//  它不碰任何 IPC —— 事件由 pet.js 转发进来，保持「宠物页面越笨越不容易出事」。
// ============================================================================

import { createCatFigure } from './cat-figure.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

// 步态参数（rig 单位）：腿长 29 是 figure 里 lift 公式的基准，别单独改
const LEG_LEN = 29;
const WALK_CAD = 2.0;        // 步频（Hz）：桌面上 40px/s 的溜达配这个节奏
const WALK_SWING = 26;       // 腿摆幅度（度）
const WALK_LIFT = 6;         // 抬脚高度（rig 单位）
const SLEEP_AFTER_MS = 90000; // 闲置多久睡着
const IDLE_TRICK_MS = [14000, 34000]; // 偶发小手势的间隔区间

// 手势时长（秒）
const GESTURE_DUR = { nod: .9, shake: .8, wave: 1.4, bow: 1.2 };

// ---------------------------------------------------------------------------
//  状态
// ---------------------------------------------------------------------------

let figure = null;
let texMap = null;
let modelKey = '';          // 当前已加载的 rig 数据指纹（避免重复重建）
let container = null;

// 每帧身体参数的「外部输入」
let mode = 'idle';          // idle | walk | sleep | drag
let face = 'neutral';
let facing = 1;
let gesture = null;         // { kind, k }（k: 0→1 播放进度）
let walking = false;        // 散步开关（主进程 pet:walk）
let mouse = { x: 0, y: 0, at: 0 };
let look = [0, 0];
let legPhase = 0;           // 步态相位（累计弧度）
let lastInteraction = Date.now();
let lastTrickAt = Date.now();
let modeStart = performance.now();
let busy = false;

let rafId = 0;
let lastFrameT = null;

// ---------------------------------------------------------------------------
//  资源
// ---------------------------------------------------------------------------

function loadImage(src) {
  return new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error(`贴图解码失败: ${src.slice(0, 48)}…`));
    im.src = src;
  });
}

let applySeq = 0;
/**
 * 喂主进程推来的 rig 数据（pet.rig = { key, model, tex }）。
 * key 不变就什么都不做 —— pet:state 每次设置变化都会推一遍，
 * 不能每次都重建 figure（GL 上下文重建是有代价的）。
 */
async function applyState(rigData) {
  if (!rigData || !rigData.model || !rigData.tex) return;
  if (rigData.key && rigData.key === modelKey && figure) {
    ++applySeq; // 返回已加载形象时也取消此前尚未完成的换肤。
    return;
  }
  const seq = ++applySeq;
  const nextKey = rigData.key || String(Date.now());

  const entries = Object.entries(rigData.tex);
  let images;
  try {
    images = await Promise.all(entries.map(([, url]) => loadImage(url)));
  } catch (err) {
    // 贴图解码失败。但如果这次**已经被更新的一次换肤顶掉**，就不能把错误抛出去 ——
    // 调用方（pet.js）的 catch 会 dispose 掉整个形象，而它拆的其实是刚成功挂上的新形象。
    // 只有「我还是当前这一次」时才算真失败。
    if (seq !== applySeq) return;
    throw err;
  }
  if (seq !== applySeq) return; // 贴图解码期间又来了新数据：本次作废
  texMap = Object.fromEntries(entries.map(([name], i) => [name, images[i]]));

  figure?.dispose();
  figure = createCatFigure({ model: rigData.model, texMap });
  modelKey = nextKey;
  if (container) figure.mount(container);
  figure.setFacing(facing);
  lastFrameT = null;
  startLoop();
}

// ---------------------------------------------------------------------------
//  帧循环
// ---------------------------------------------------------------------------

function startLoop() {
  if (rafId) return;
  const step = (now) => {
    rafId = requestAnimationFrame(step);
    if (!figure) return;
    const t = now / 1000;
    const dt = lastFrameT == null ? 1 / 60 : clamp((now - lastFrameT) / 1000, 0, 0.05);
    lastFrameT = now;

    /* --- 模式选择（外部输入 → mode） --- */
    const held = dragHeld;
    if (held) mode = 'drag';
    else if (walking) mode = 'walk';
    else if (Date.now() - lastInteraction > SLEEP_AFTER_MS) mode = 'sleep';
    else mode = 'idle';
    if (mode !== prevMode) { modeStart = now; prevMode = mode; }
    if (mode === 'sleep' && face !== 'sleep') face = 'sleep';
    if (mode !== 'sleep' && face === 'sleep') face = 'neutral';

    /* --- 步态相位 --- */
    if (mode === 'walk') legPhase += Math.PI * 2 * WALK_CAD * dt;

    /* --- 手势播放 --- */
    if (gesture) {
      gesture.k += dt / (GESTURE_DUR[gesture.kind] || 1);
      if (gesture.k >= 1) gesture = null;
    }

    /* --- 偶发小手势（醒着、没人理的时候） --- */
    if (mode === 'idle' && !gesture && !busy) {
      const since = Date.now() - lastTrickAt;
      const due = lerp(IDLE_TRICK_MS[0], IDLE_TRICK_MS[1], Math.random());
      if (since > due) {
        lastTrickAt = Date.now();
        gesture = { kind: ['nod', 'shake', 'wave', 'bow'][Math.floor(Math.random() * 4)], k: 0 };
      }
    }

    /* --- 视线：跟鼠标；没人动 / 睡着时慢慢回中。
       注意鼠标移动**不**刷新 lastInteraction —— 不然鼠标划过窗口猫就永远睡不着。 --- */
    const mouseFresh = mode !== 'sleep' && Date.now() - mouse.at < 5000;
    const target = mouseFresh ? [mouse.x, mouse.y] : [0, 0];
    look[0] = lerp(look[0], clamp(target[0], -5, 5), 1 - Math.exp(-6 * dt));
    look[1] = lerp(look[1], clamp(target[1], -5, 5), 1 - Math.exp(-6 * dt));

    /* --- 组装身体参数（kit 口径） --- */
    const o = {
      t,
      mode,
      face,
      facing,
      look,
      swing: 0,
      sit: 0,
      low: 0,
      legs: [[0, 0, 0, 0], [0, 0, 0, 0]],
      gesture,
      modeT: (now - modeStart) / 1000,
    };

    if (mode === 'walk') {
      const hipB = modelPivot('legBack'), hipF = modelPivot('legFront');
      for (let i = 0; i < 2; i++) {
        const ph = legPhase + i * Math.PI;
        const a = WALK_SWING * Math.sin(ph) * Math.PI / 180;
        const lift = Math.max(0, Math.sin(ph + Math.PI / 2)) * WALK_LIFT;
        const hip = i === 0 ? hipB : hipF;
        // 脚 = 髋 + 摆动向量；figure 从线段自己算角度和抬脚
        o.legs[i] = [hip[0], hip[1], hip[0] + LEG_LEN * Math.sin(a), hip[1] + LEG_LEN * Math.cos(a) - lift * 0.4];
      }
      o.swing = 3 * Math.sin(legPhase);           // 身体跟着步子轻微横摆
      o.low = 1.2 * Math.abs(Math.sin(legPhase)); // 髋部颠簸
    } else {
      // 站着 / 睡着：双腿直立（脚在髋正下方）
      const hipB = modelPivot('legBack'), hipF = modelPivot('legFront');
      o.legs[0] = [hipB[0], hipB[1], hipB[0] + 1, hipB[1] + LEG_LEN];
      o.legs[1] = [hipF[0], hipF[1], hipF[0] - 1, hipF[1] + LEG_LEN];
    }

    /* --- 特效开关（fx 层）：思考泡只在「想」的阶段，开口说了就收掉 --- */
    const fc = {};
    if (busy && face === 'thinking') fc.think = true;

    figure.draw(fc, o);
  };
  rafId = requestAnimationFrame(step);
}

let prevMode = 'idle';
let dragHeld = false;

function modelPivot(name) {
  const pv = figure && figure.model && figure.model.pivots;
  return (pv && pv[name]) || [0, 0];
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

// ---------------------------------------------------------------------------
//  事件翻译（pet.js 转发）
// ---------------------------------------------------------------------------

/** 生成中（pet:busy）→ 想事情 */
function setBusy(b) {
  busy = b === true;
  if (busy) { wake('thinking'); }
  else if (face === 'thinking') face = 'neutral';
  lastInteraction = Date.now();
}

/** 话说出来了（pet:say）→ 开心一小会儿 */
function said() {
  wake('happy');
  setTimeout(() => { if (face === 'happy') face = 'neutral'; }, 3500);
}

/** 流式增量（pet:chunk）：第一个字冒出来 = 从「想事情」转「开口说」。
 *  静态脸没有口型，用偶尔的点头示意「在说」。
 *  chunk 每个 token 来一次 —— 必须节流，不然手势被反复重播成抽搐。 */
let lastChunkNodAt = 0;
function chunk() {
  if (!busy) return;
  if (face !== 'happy') wake('happy'); // 从 thinking 切到说话
  const now = performance.now();
  if (gesture || now - lastChunkNodAt < 2600) return;
  lastChunkNodAt = now;
  gesture = { kind: 'nod', k: 0 };
}

/** 被点了一下（poke 应答之后） */
function poked() {
  wake(Math.random() < 0.5 ? 'surprised' : 'shy');
  gesture = { kind: Math.random() < 0.5 ? 'nod' : 'shake', k: 0 };
  setTimeout(() => { if (face === 'surprised' || face === 'shy') face = 'neutral'; }, 2200);
}

/** 被拎起来了 / 放下 */
function dragBegin() { dragHeld = true; wake('dragged'); }
function dragEnd() { dragHeld = false; if (face === 'dragged') face = 'neutral'; lastInteraction = Date.now(); }

/** 散步事件（主进程 pet:walk { walking, facing }） */
function walkEvent(payload) {
  const p = payload || {};
  if (typeof p.walking === 'boolean') walking = p.walking;
  if (p.facing === 1 || p.facing === -1) {
    facing = p.facing;
    figure?.setFacing(facing);
  }
  if (walking) lastInteraction = Date.now();
}

/** 鼠标移动（穿透过来的）—— 视线跟踪的原料。坐标是相对窗口中心的偏移。
 *  只更新视线原料，不算「互动」（划过鼠标不该惊醒午睡）。 */
function mouseMove(x, y) {
  mouse = { x, y, at: Date.now() };
}

function wake(nextFace) {
  lastInteraction = Date.now();
  lastTrickAt = Date.now();
  if (nextFace) face = nextFace;
  if (mode === 'sleep') legPhase = 0;
}

// ---------------------------------------------------------------------------
//  对外（pet.js 用）
// ---------------------------------------------------------------------------

export const catRig = {
  get active() { return !!figure; },
  get canvas() { return figure && figure.canvas; },
  get mirrored() { return facing < 0; },
  get mode() { return mode; },

  mount(el) {
    container = el;
    if (figure) figure.mount(el);
  },

  applyState,

  setBusy, said, chunk, poked,
  dragBegin, dragEnd,
  walk: walkEvent,
  mouseMove,

  dispose() {
    stopLoop();
    // 让还在解码贴图的 applyState 作废：否则它回来时照旧 createCatFigure + mount，
    // 在我们已经「销毁」之后又凭空挂出一只猫（切到空形象包 / 关桌宠时能看到）。
    applySeq += 1;
    figure?.dispose();
    figure = null; texMap = null; modelKey = '';
    mode = 'idle'; face = 'neutral'; walking = false; dragHeld = false;
    gesture = null; legPhase = 0; prevMode = 'idle';
  },
};
