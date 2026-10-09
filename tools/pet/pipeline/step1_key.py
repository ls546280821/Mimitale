#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
step1_key.py —— 把母图的「假透明底」变成真 alpha。

**为什么需要这一步**：图像生成器给了 `background: transparent`，但返回的 PNG 其实不带
alpha —— 它把「透明」画成了**棋盘格**（两种浅灰交替的小方格子），或者干脆留白底。
棋盘格不像纯色背景那样能用「白色→透明」直接 key（角色的白头发、白围裙、白袜子
全是接近白的像素，一 key 就漏），所以必须用**从四边洪泛填充**：

  1. 统计四边像素，找出背景的几种颜色（棋盘格是两种灰）；
  2. 把这些颜色相近的像素标成「候选背景」；
  3. 从画布四边向内洪泛 —— 只有**和边界连通**的候选背景才算真背景；
  4. 角色内部的白色因为被描边封住，洪泛到不了，不会被误删。

描边一旦有缺口（洪泛会漏进角色内部），本脚本会检测出来并**报错退出**，不静默产出
一张被蛀空的图。

跑法：
    python tools/pet/pipeline/step1_key.py <母图.png> <输出.png>
"""
import sys
from collections import deque

import numpy as np
from PIL import Image


def pick_bg_colors(rgb, band=6):
    """从四条边取像素，聚类出背景色（棋盘格 → 2 种，纯色底 → 1 种）。

    ⚠️ 生成图的底色**带噪点**：同一格灰会散成上百种近似色，每种单独计数都不到阈值。
    所以先按 8 阶量化把近似色并起来再统计，否则浅灰那格会被整格漏掉
    （2026-10-09 踩到：只认出深灰一种，浅灰格全留下，角色 bbox 直接铺满整张画布）。
    """
    h, w, _ = rgb.shape
    edge = np.concatenate([
        rgb[:band].reshape(-1, 3), rgb[-band:].reshape(-1, 3),
        rgb[:, :band].reshape(-1, 3), rgb[:, -band:].reshape(-1, 3)])
    q = (edge // 8) * 8 + 4                      # 量化到格心，把噪声并起来
    uniq, cnt = np.unique(q, axis=0, return_counts=True)
    order = np.argsort(-cnt)
    colors = []
    for i in order:
        c = uniq[i].astype(np.int16)
        if cnt[i] < edge.shape[0] * 0.015:       # 不到 1.5% 的当噪声
            break
        if all(np.abs(c - k).max() > 14 for k in colors):
            colors.append(c)
        if len(colors) >= 4:
            break
    return colors


def bg_candidates(rgb, colors):
    """候选背景 = 「和边界色接近」**或**「浅色且低饱和」。

    第二条是给棋盘格兜底的：浅灰那格即使没被聚类认出来，也满足「亮且不偏色」。
    它会把角色内部的白（头发、围裙、袜子）一起标成候选 —— 但没有关系，
    真正决定是不是背景的是**洪泛能不能从画布四边走到它**，而角色内部的白色
    被深色描边封着，走不进去。
    """
    cand = np.zeros(rgb.shape[:2], bool)
    for c in colors:
        cand |= (np.abs(rgb - c).max(axis=2) <= 18)
    light = (rgb.min(axis=2) > 195) & ((rgb.max(axis=2) - rgb.min(axis=2)) < 24)
    return cand | light


def drop_specks(alpha, min_px=200):
    """扔掉孤立小噪点。

    **为什么需要**：棋盘格的格子线 / 压缩噪点会留下零星几十个「不属于任何东西」的
    小连通块。它们加起来可能只有三五百像素（肉眼几乎看不见），但**足以把角色的 bbox
    撑到整张画布**，后面按 bbox 裁切、定原点就全错；星宝也正是先看到这些点才说
    「没扣干净」。角色本体永远是一整块（十几万像素以上），所以按面积一刀切很安全。
    """
    try:
        from scipy import ndimage
    except ImportError:
        print('  （没装 scipy，跳过去噪点。装上：pip install scipy）')
        return alpha
    fg = alpha > 63
    lab, n = ndimage.label(fg, structure=np.ones((3, 3), int))
    if n <= 1:
        return alpha
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= min_px
    killed = int((~keep[1:]).sum())
    if killed:
        print('去噪点：扔掉 %d 个孤立小块（合计 %d 像素）'
              % (killed, int(sizes[~keep[1:]].sum())))
        alpha = np.where(keep[lab], alpha, 0).astype(np.uint8)
    return alpha


def main():
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert('RGB')
    rgb = np.asarray(im).astype(np.int16)
    h, w, _ = rgb.shape
    print('母图 %dx%d' % (w, h))

    colors = pick_bg_colors(rgb)
    if not colors:
        print('❌ 四条边上没找到稳定的背景色，无法抠底')
        sys.exit(1)
    print('背景色候选:', [tuple(int(v) for v in c) for c in colors])

    # 候选背景：和任一背景色接近，或「浅色低饱和」（棋盘格兜底）
    cand = bg_candidates(rgb, colors)
    print('候选背景像素占比 %.1f%%' % (100.0 * cand.mean()))

    # 从四边洪泛（4 邻接）
    bg = np.zeros((h, w), bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if cand[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if cand[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and cand[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                dq.append((ny, nx))
    print('洪泛填掉的背景占比 %.1f%%' % (100.0 * bg.mean()))

    # 漏检守卫：洪泛区域面积大得离谱，说明描边有缺口、填进角色里了
    if bg.mean() > 0.90:
        print('❌ 洪泛吃掉了 %.0f%% 的画面，描边大概率有缺口 —— 停下来人工看一眼，'
              '不要直接用这张' % (100 * bg.mean()))
        Image.fromarray((bg * 255).astype(np.uint8)).save(dst.replace('.png', '_debug_bg.png'))
        sys.exit(2)

    alpha = np.where(bg, 0, 255).astype(np.uint8)

    # 边缘羽化：只对「紧贴背景」的一圈像素给中间 alpha，线条本身保持硬
    inner = ~bg
    for _ in range(1):
        # 把 alpha 做 3x3 均值再取回内圈，消掉锯齿但不糊线
        a = alpha.astype(np.int16)
        pad = np.pad(a, 1, mode='edge')
        blur = (pad[:-2, :-2] + pad[:-2, 1:-1] + pad[:-2, 2:] +
                pad[1:-1, :-2] + pad[1:-1, 1:-1] + pad[1:-1, 2:] +
                pad[2:, :-2] + pad[2:, 1:-1] + pad[2:, 2:]) // 9
        alpha = np.where(inner, a, blur).astype(np.uint8)

    alpha = drop_specks(alpha)

    out = np.dstack([np.asarray(im), alpha])
    Image.fromarray(out, 'RGBA').save(dst)

    fg = alpha > 8
    ys, xs = np.where(fg)
    print('角色 bbox: x %d..%d  y %d..%d  (%dx%d)'
          % (xs.min(), xs.max(), ys.min(), ys.max(),
             xs.max() - xs.min() + 1, ys.max() - ys.min() + 1))
    print('半透明像素(0<a<250) 占比 %.2f%%' % (100.0 * ((alpha > 0) & (alpha < 250)).mean()))
    print('✅ 写出', dst)


if __name__ == '__main__':
    main()
