#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
audit_parts.py —— 形象包「部件混色」体检

**检查什么**：每个部件的贴图里，有没有**本不属于它的颜色**——
比如手上粘着裙子、头发里混着袖子、尾巴里带着皮肤色。
这是「拆件边界不干净」的通用检测（星宝报的「手会带上衣服的图片」「尾巴和一部分的
右手绑在一起」都属于这一类）。

**原理**：
  1. 每个部件取**核心区**（掩码腐蚀 2px）—— 边缘那圈是两部件的混合色，不算数；
  2. 统计该部件**自己的特征色**：把颜色量化（每通道 32 级）分桶，取占比 >= 0.3%
     的桶的**均值色** —— 用均值色而不是桶号，这样软阴影的渐变也能被特征色覆盖；
  3. 核心区里「离所有特征色的距离都 > 45」的像素 = 疑似混入
     （阈值 45 ≈ 明显换了一种颜色，软阴影和抗锯齿都在 30 以内）；
  4. 对每一块混入像素，找**哪个别的部件的特征色离它最近** —— 那就是来源。

**判读**：混入 <2% 且分散 → 软边，无害；
混入集中、又指向某个相邻部件 → 真混色，要修。

跑法：
    python tools/pet/pipeline/audit_parts.py <形象包目录> --viz <输出.png>
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

BIN = 32          # 量化步长（每通道）
SIG_MIN = 0.003   # 特征色阈值：占该部件 >= 0.3%
DIST = 45         # 距最近特征色超过这个数 = 混入
ERODE = 2


def signature(px):
    """核心区像素（N,3）的特征色：量化分桶 -> 每桶的均值色。返回 (colors[k,3],)"""
    q = px.astype(np.int16) // BIN
    key = (q[:, 0] * 64 + q[:, 1]) * 64 + q[:, 2]
    uniq, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    keep = cnt >= SIG_MIN * len(px)
    cols = np.zeros((len(uniq), 3), np.float32)
    for i in np.where(keep)[0]:
        cols[i] = px[inv == i].mean(axis=0)
    return cols[keep]


def main():
    pet = sys.argv[1]
    viz = '--viz' in sys.argv
    viz_out = sys.argv[sys.argv.index('--viz') + 1] if viz and len(sys.argv) > sys.argv.index('--viz') + 1 \
        else os.path.join(pet, 'build', '_audit.png')
    model = json.load(open(os.path.join(pet, 'model.json'), encoding='utf-8'))
    parts = list(model['parts']) + list(model['feat'].values())

    data = {}
    for p in parts:
        sub = 'feat' if p['id'] in model['feat'] else 'tex'
        path = os.path.join(pet, sub, p['tex'] + '.png')
        a = np.asarray(Image.open(path).convert('RGBA'))
        mask = a[:, :, 3] > 128
        if not mask.any():
            continue
        core = ndimage.binary_erosion(mask, np.ones((5, 5), bool), 1) & mask
        rgb = a[:, :, :3].astype(np.float32)
        sel = rgb[core]
        if len(sel) < 200:
            continue
        cols = signature(sel)
        data[p['id']] = dict(box=p['box'], core=core, rgb=rgb.astype(np.uint8), cols=cols,
                             w=core.shape[1], h=core.shape[0])

    ids = list(data)
    print('%-18s %8s %s' % ('部件', '混入px', '主要来源'))
    print('-' * 80)
    report = {}
    foreign_map = {}
    for pid in ids:
        d = data[pid]
        ys, xs = np.where(d['core'])
        px = d['rgb'][ys, xs].astype(np.float32)
        # 到自己特征色的最小距离
        dm = np.full(len(px), 1e9, np.float32)
        for c in d['cols']:
            dm = np.minimum(dm, np.linalg.norm(px - c, axis=1))
        f = dm > DIST
        nf = int(f.sum())
        if nf == 0:
            continue
        fpx = px[f]
        # 来源：别的部件的特征色里，离这些混入像素最近的
        best = {}
        for oid in ids:
            if oid == pid:
                continue
            for c in data[oid]['cols']:
                dist = np.linalg.norm(fpx - c, axis=1)
                for j in np.where(dist < 40)[0]:
                    key = (int(ys[f][j]), int(xs[f][j]))
                    if key not in best or dist[j] < best[key][0]:
                        best[key] = (dist[j], oid)
        cnt = {}
        for _, (_, oid) in best.items():
            cnt[oid] = cnt.get(oid, 0) + 1
        src = ', '.join('%s(%d)' % (k, v) for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])[:2])
        share = 100.0 * nf / len(px)
        print('%-18s %8d  %.1f%%  %s' % (pid, nf, share, src or '(认不出来源)'))
        report[pid] = dict(foreign=nf, share=round(share, 2), src=sorted(cnt.items(), key=lambda kv: -kv[1])[:3])
        if foreign_map.get('map') is None:
            foreign_map['map'] = np.zeros(d['core'].shape[:2] + (3,), np.uint8)
        # 混入像素画进整图（按 box 放置）
        foreign_map.setdefault('parts', {})[pid] = (f, ys, xs, d)

    if viz and foreign_map.get('parts'):
        first = next(iter(foreign_map['parts'].values()))[3]
        canvas = np.full((2048, 2048, 3), 255, np.uint8)
        rng = np.random.default_rng(11)
        pal = {pid: tuple(int(v) for v in rng.integers(40, 220, 3)) for pid in foreign_map['parts']}
        for pid, (f, ys, xs, d) in foreign_map['parts'].items():
            bx, by, _bw, _bh = (int(v) for v in d['box'])
            canvas[by + ys[f], bx + xs[f]] = pal[pid]
        Image.fromarray(canvas).save(viz_out)
        print('\n混入像素分布图 -> %s（颜色 = 归属部件）' % viz_out)

    json.dump(report, open(os.path.join(pet, 'build', '_audit.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('报告 -> %s' % os.path.join(pet, 'build', '_audit.json'))


if __name__ == '__main__':
    main()
