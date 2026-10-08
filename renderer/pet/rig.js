'use strict';

// ============================================================================
//  renderer/pet/rig.js —— 部件贴图的网格变形渲染器（桌宠「动态形象」的画笔）
//
//  移植自 Coopanion 的 web/kit/rig.js（Pal-AI-Lab，AGPL-3.0，2026-10-10 取自
//  main 分支 v0.1.19），渲染逻辑一行未改 —— 只换了宿主注释。
//  ⚠️ 许可提醒：这个文件的原始版权是 AGPL-3.0。Mimitale 目前是个人自用软件
//     没有触发分发义务；**将来若要开源 / 分发 Mimitale**，要么摘掉这套 rig
//     换自研实现，要么整个项目转 AGPL —— 到时候先想清楚再动手。
//
//  它是什么：一个「小型 Live2D」——
//    · 一个 part = 一张贴图铺在 rig 空间的一个 box 上，切成 quad 网格；
//    · 每帧网格的静止点穿过这个 part 的**变形器链**（内层先动、父层后动）：
//        rot  —— 绕 pivot 转 / 缩放 / 平移
//        warp —— 一个矩形上的位移场 fn(u, v, x, y)，矩形外取最近边缘的值
//    · 所有坐标都在同一套 rig 空间（逻辑坐标：x=128 在身体正下方，脚底 y=256）。
//
//  两个保命的工程细节（都是 Coopanion 踩过的坑，别删）：
//    · preserveDrawingBuffer —— 猫的轮廓要用 canvas 像素做**鼠标穿透掩码**
//      （pet.js 里 drawImage(this) 读 alpha），丢了 drawing buffer 就读出全 0。
//    · WebGL1 降级 —— GLSL ES 1.00 且不用 VAO，老机器 WebGL2 被拒时照样跑。
// ============================================================================

const VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform vec4 uView; // x0, y0, 1/w, 1/h
varying vec2 vUv;
void main() {
  vec2 n = (aPos - uView.xy) * uView.zw;
  gl_Position = vec4(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
  vUv = aUv;
}`;
const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform float uMix;
uniform float uAlpha;
uniform vec4 uTint; // rgb multiply, a = mix toward it
void main() {
  vec4 c = mix(texture2D(uTex, vUv), texture2D(uTex2, vUv), uMix);
  c.rgb = mix(c.rgb, c.rgb * uTint.rgb, uTint.a);
  gl_FragColor = c * uAlpha;
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function createRig(canvas, model) {
  const attrs = { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true };
  const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
  if (!gl) throw new Error('webgl unavailable');
  // WebGL 1 builds mipmaps only for power-of-two sizes, and the textures are not
  const pot = (n) => (n & (n - 1)) === 0;
  const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const canMip = (src) => gl2 || (pot(src.width) && pot(src.height));
  const defs = model.deformers;
  let view = model.view; // [x0, y0, x1, y1]

  // the source each texture was uploaded from: a lost context takes the GL textures with it,
  // so restoring means uploading them all again from what they came from
  const textures = new Map(), sources = new Map();
  function upload(key, src) {
    if (disposed) return null;
    sources.set(key, src);
    let t = textures.get(key);
    if (!t) { t = gl.createTexture(); textures.set(key, t); }
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const mip = canMip(src);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // deformer chain per part, innermost first
  const chainOf = id => { const c = []; for (let d = id; d; d = defs[d].parent) c.push(d); return c; };

  let prog, loc, meshes = [];
  let shaders = [];
  /** Builds every GL resource; called again on `webglcontextrestored`, where the old ones died with the context. */
  function buildGL() {
    shaders = [shader(gl, gl.VERTEX_SHADER, VS), shader(gl, gl.FRAGMENT_SHADER, FS)];
    prog = gl.createProgram();
    for (const s of shaders) gl.attachShader(prog, s);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'), aUv: gl.getAttribLocation(prog, 'aUv'),
      uView: gl.getUniformLocation(prog, 'uView'), uTex: gl.getUniformLocation(prog, 'uTex'),
      uAlpha: gl.getUniformLocation(prog, 'uAlpha'), uTint: gl.getUniformLocation(prog, 'uTint'),
      uTex2: gl.getUniformLocation(prog, 'uTex2'), uMix: gl.getUniformLocation(prog, 'uMix'),
    };
    // parts: rest grid, uv, index buffer; `uvBox` picks a sub-rect of the texture (atlas), default whole
    meshes = model.parts.map(p => {
      const [nx, ny] = p.grid || [6, 6];
      const [x, y, w, h] = p.box;
      const [u0, v0, u1, v1] = p.uvBox || [0, 0, 1, 1];
      const rest = new Float32Array((nx + 1) * (ny + 1) * 2), uv = new Float32Array(rest.length);
      let k = 0;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        rest[k] = x + w * i / nx; rest[k + 1] = y + h * j / ny;
        uv[k] = u0 + (u1 - u0) * i / nx; uv[k + 1] = v0 + (v1 - v0) * j / ny;
        k += 2;
      }
      const idx = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
      const pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, rest.byteLength, gl.DYNAMIC_DRAW);
      const uvb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvb);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
      return { part: p, rest, out: new Float32Array(rest.length), pos, uvb, ib, count: idx.length };
    });
    meshes.forEach(m => { m.chain = chainOf(m.part.parent); });
    gl.enableVertexAttribArray(loc.aPos);
    gl.enableVertexAttribArray(loc.aUv);
  }

  // a lost context blanks the canvas; unless the loss is preventDefault-ed the browser never
  // restores it, and it stays blank for good. On restoration every GL resource must be rebuilt
  // and the textures uploaded again from their sources.
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    if (disposed) return;
    lost = false;
    textures.clear();
    buildGL();
    for (const [key, src] of sources) upload(key, src);
  });
  buildGL();

  /**
   * Frees every GL resource and kills the context. Without this the browser keeps the context
   * alive until GC collects the canvas, and Chromium caps live contexts per page (~16): swapping
   * figures back and forth could exhaust them and leave later mounts rendering nothing.
   */
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    lost = true;
    try {
      for (const t of textures.values()) gl.deleteTexture(t);
      for (const m of meshes) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uvb); gl.deleteBuffer(m.ib); }
      if (prog) gl.deleteProgram(prog);
      for (const s of shaders) gl.deleteShader(s);
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  /** Moves a rest point through deformer `id` and its ancestors, with this frame's states. */
  function applyChain(chain, st, x, y) {
    for (const id of chain) {
      const d = defs[id], s = st[id];
      if (!s) continue;
      if (d.kind === 'rot') {
        const [px, py] = d.pivot, a = (s.a || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
        const sx = s.sx ?? s.s ?? 1, sy = s.sy ?? s.s ?? 1;
        const lx = (x - px) * sx, ly = (y - py) * sy;
        x = px + (s.tx || 0) + lx * c - ly * sn;
        y = py + (s.ty || 0) + lx * sn + ly * c;
      } else if (d.kind === 'warp' && s.fn) {
        const [x0, y0, x1, y1] = d.rect;
        const u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))), v = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
        const r = s.fn(u, v, x, y);
        x += r[0]; y += r[1];
      }
    }
    return [x, y];
  }

  function render(st, opts = {}) {
    if (lost || gl.isContextLost()) return;
    const W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(loc.uView, view[0], view[1], 1 / (view[2] - view[0]), 1 / (view[3] - view[1]));
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uTex2, 1);
    const mixK = Math.min(1, Math.max(0, st.mix || 0));
    const order = meshes.filter(m => !(opts.hidden && opts.hidden[m.part.id]))
      .map(m => ({ m, z: st.z?.[m.part.id] ?? m.part.z })).sort((a, b) => a.z - b.z);
    for (const { m } of order) {
      const p = m.part, alpha = st.alpha?.[p.id] ?? p.alpha ?? 1;
      const tex = textures.get(p.tex);
      if (!tex || alpha <= 0.001) continue;
      for (let i = 0; i < m.rest.length; i += 2) {
        const q = applyChain(m.chain, st, m.rest[i], m.rest[i + 1]);
        m.out[i] = q[0]; m.out[i + 1] = q[1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.out);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uvb);
      gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      const tex2 = mixK > 0 ? textures.get(p.tex + '@mix') : null;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex2 || tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1f(loc.uMix, tex2 ? mixK : 0);
      gl.uniform1f(loc.uAlpha, alpha);
      const tint = st.tint?.[p.id];
      gl.uniform4f(loc.uTint, ...(tint || [1, 1, 1, 0]));
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  return {
    gl, upload, render, dispose,
    /** Where a rest point lands this frame (for overlays and hit tests). */
    point(deformer, st, x, y) { return applyChain(chainOf(deformer), st, x, y); },
    setView(v) { view = v; },
    get view() { return view; },
  };
}
