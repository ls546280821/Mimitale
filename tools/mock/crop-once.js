'use strict';

// 一次性工具：把出好的 png 裁一块出来放大，用来肉眼看细节（右栏 / 分组 / 间距）。
// 用法：electron crop-once.js --in=berry-2-world.png --x=1140 --y=0 --w=300 --h=900 --scale=2.2
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const arg = (k, d) => {
  const hit = process.argv.slice(1).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const OUT = path.join(__dirname, '..', 'shots', 'mock');
// --in 可以给文件名（先在 shots/mock 里找，再在 shots 里找），也可以给绝对路径
const inArg = arg('in', 'berry-2-world.png');
const IN = path.isAbsolute(inArg)
  ? inArg
  : [path.join(OUT, inArg), path.join(__dirname, '..', 'shots', inArg)].find((p) => fs.existsSync(p)) ||
    path.join(OUT, inArg);
// 裁出来的临时图统一放回 mock 目录（已 gitignore）
const OUTDIR = path.isAbsolute(inArg) ? path.dirname(IN) : path.dirname(IN);
const X = Number(arg('x', 0));
const Y = Number(arg('y', 0));
const W = Number(arg('w', 300));
const H = Number(arg('h', 900));
const SCALE = Number(arg('scale', 2));

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(IN);
  const cropped = img.crop({ x: X, y: Y, width: W, height: H });
  const big = cropped.resize({ width: Math.round(W * SCALE), quality: 'best' });
  const out = path.join(OUTDIR, `_zoom-${path.basename(IN, '.png')}-${X}-${Y}-${W}x${H}.png`);
  fs.writeFileSync(out, big.toPNG());
  console.log('[crop]', out, big.getSize().width + 'x' + big.getSize().height);
  app.quit();
});
