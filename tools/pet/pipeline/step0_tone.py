#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
step0_tone.py —— 蓝色收敛（可复现的调色，不是手搓）

**为什么需要**：图像生成器出的母图蓝色容易过鲜。实测旧母版「蓝色像素的平均 B−R」
是 80.0，而一次成型的新母图是 149.6 —— 星宝的原话是「有点蓝了」。

与其重出一版（那会再引入一轮画风漂移，且不可复现），不如在像素上按**色相**把
蓝色区的饱和度乘一个系数：只动偏蓝的像素，皮肤、腮红、描边、白色一律不碰。

跑法：
    python tools/pet/pipeline/step0_tone.py <输入.png> <输出.png> [系数]

系数是「蓝色饱和度保留比例」，1.0 = 原样。用 `--measure` 只看不改：
    python tools/pet/pipeline/step0_tone.py <图.png> --measure
"""
import sys

import numpy as np
from PIL import Image

HUE_LO, HUE_HI = 185.0, 265.0   # 蓝 / 宝蓝的色相区间（度）


def measure(rgb):
    """印出「蓝色像素的平均 B−R」，作为鲜度的唯一口径（和旧母版可直接比）。"""
    x = rgb.astype(np.float32)
    lum = x.mean(axis=2)
    sel = (lum < 200) & (lum > 60) & ((x[:, :, 2] - x[:, :, 0]) > 25)
    return (x[:, :, 2] - x[:, :, 0])[sel].mean(), 100.0 * sel.mean()


def to_hsv(x):
    """rgb(0~255 float) -> h(0~360), s(0~1), v(0~1)"""
    r, g, b = x[:, :, 0] / 255.0, x[:, :, 1] / 255.0, x[:, :, 2] / 255.0
    mx = np.max(x, axis=2) / 255.0
    mn = np.min(x, axis=2) / 255.0
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    idx = nz & (mx == r)
    h[idx] = (60 * ((g - b) / np.where(nz, d, 1)) % 360)[idx]
    idx = nz & (mx == g)
    h[idx] = (60 * ((b - r) / np.where(nz, d, 1)) + 120)[idx]
    idx = nz & (mx == b)
    h[idx] = (60 * ((r - g) / np.where(nz, d, 1)) + 240)[idx]
    return h, np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0), mx


def from_hsv(h, s, v):
    c = v * s
    hp = (h % 360) / 60.0
    x_ = c * (1 - np.abs(hp % 2 - 1))
    m = v - c
    z = np.zeros_like(h)
    r, g, b = z.copy(), z.copy(), z.copy()
    for i, (rc, gc, bc) in enumerate([(c, x_, z), (x_, c, z), (z, c, x_),
                                      (z, x_, c), (x_, z, c), (c, z, x_)]):
        k = (hp >= i) & (hp < i + 1)
        r[k], g[k], b[k] = rc[k], gc[k], bc[k]
    k = hp >= 6
    r[k], g[k], b[k] = c[k], z[k], x_[k]
    return np.clip(np.dstack([r + m, g + m, b + m]) * 255.0, 0, 255)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src)
    a = np.asarray(im)
    rgb = a[:, :, :3]
    before, share = measure(rgb)
    if dst == '--measure':
        print('蓝色像素占比 %.1f%%   平均 B−R = %.1f' % (share, before))
        return

    k = float(sys.argv[3]) if len(sys.argv) > 3 else 0.62
    h, s, v = to_hsv(rgb.astype(np.float32))
    blue = (h >= HUE_LO) & (h <= HUE_HI) & (s > 0.05)
    s2 = np.where(blue, s * k, s)
    out = from_hsv(h, s2, v)
    alpha = a[:, :, 3:4] if a.shape[2] == 4 else np.full(rgb.shape[:2] + (1,), 255, np.uint8)
    Image.fromarray(np.dstack([out.astype(np.uint8), alpha]).astype(np.uint8)).save(dst)

    after, _ = measure(out.astype(np.uint8))
    print('系数 %.2f：平均 B−R  %.1f -> %.1f   （旧母版参考值 80.0）' % (k, before, after))
    print('✅ 写出', dst)


if __name__ == '__main__':
    main()
