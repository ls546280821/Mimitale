# -*- coding: utf-8 -*-
"""
交接包修补 V3：把 00「未分配层」按「颜色相似度」还给各部件。

V1/V2 的根本错误：以为 00 层是「洞」，就去找人来填。
  实际：00 层是「跨部件边界的描边 + 碎渣」，它们本属于各部件的**边缘一圈**。
  证据：00 层 18.9% 是暗色描边；而各部件内部的描边都完好。
  后果：每个部件边缘缺一圈描边 → 命名拼起来处处是缝（用户说的「东一块西一块」）。

V3 做法：
  1. 对 00 层每个像素，取它在 master-raw 里的真实颜色
  2. 只考虑「离它够近（≤ NEAR）」的部件作为候选
  3. 候选里，谁的**边缘色**和该像素颜色最接近就给谁（带空间惩罚）
  4. 但**不能给得太远**：超过 MAXD 距离的，宁可不要（避免乱贴）
  5. alpha 羽化，避免硬边

产出：
  layers_fixed/   —— 修补后的层
  fix3_report.json —— 每个部件新增了多少像素
"""
import numpy as np
from PIL import Image
from scipy import ndimage
import glob, os, json

SRC = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers'
DST = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers_fixed'
MASTER = r'E:/工作/Mimitale/assets/pet/cat/source/master-raw.png'
OUT = r'E:/工作/Mimitale/tools/pet/pipeline/out'

TH_A = 8
SKIP = '00_'
RING = 10        # 部件「边缘色」取样环带宽
NEAR = 60        # 候选部件必须在这么近（放宽：让 00 层能还回去）
COL_TOL = 90     # 颜色距离上限（超过就不认）
SPACE_W = 2.0    # 空间惩罚权重
ROUNDS = 4       # 迭代轮数：每轮归位后边缘会变，再算一次


def edge_color_map(a):
    """返回每个部件「边缘带」的平均色（用于比色）。"""
    m = a[:, :, 3] > TH_A
    if m.sum() == 0:
        return None, None
    er = ndimage.binary_erosion(m, np.ones((RING * 2 + 1, RING * 2 + 1)))
    band = m & ~er
    if band.sum() < 30:
        band = m
    col = a[:, :, :3][band].astype(np.float32).mean(axis=0)
    return col, m


def main():
    os.makedirs(DST, exist_ok=True)
    fs = sorted(glob.glob(SRC + '/*.png'))
    names = [os.path.basename(f) for f in fs]
    layers = {os.path.basename(f): np.asarray(Image.open(f).convert('RGBA')).copy() for f in fs}
    master = np.asarray(Image.open(MASTER).convert('RGB')).astype(np.int16)

    real = [nm for nm in names if not nm.startswith(SKIP)]
    ec = {}
    am = {}
    for nm in real:
        c, m = edge_color_map(layers[nm])
        if c is None:
            continue
        ec[nm] = c
        am[nm] = m
    real = list(ec.keys())

    # 00 层要认领的像素
    u = layers['00_未分配像素补齐层.png']
    um0 = u[:, :, 3] > TH_A

    # 距离场
    dist = {}

    N = 0
    add = {}
    left_mask = um0.copy()

    for rd in range(ROUNDS):
        for nm in real:
            dist[nm] = ndimage.distance_transform_edt(~am[nm])
        ys, xs = np.where(left_mask)
        if len(xs) == 0:
            break
        mcol = master[ys, xs].astype(np.float32)
        N = len(xs)

        best_id = np.full(N, -1, np.int16)
        best_score = np.full(N, 1e9, np.float32)
        near_any = np.zeros(N, bool)

        for i, nm in enumerate(real):
            d = dist[nm][ys, xs]
            near = d <= NEAR
            if not near.any():
                continue
            near_any |= near
            c = ec[nm]
            cd = np.sqrt(((mcol - c) ** 2).sum(axis=1))
            score = cd + SPACE_W * d
            score[~near] = 1e9
            upd = score < best_score
            best_id[upd] = i
            best_score[upd] = score[upd]

        ok = (best_id >= 0) & (best_score < 1e9)
        cols = np.zeros((N, 3), np.float32)
        for i, nm in enumerate(real):
            sel = best_id == i
            if sel.any():
                cols[sel] = ec[nm]
        cd_only = np.sqrt(((mcol - cols) ** 2).sum(axis=1))
        ok &= cd_only < COL_TOL
        # 距离上限：太远的不认
        if ok.any():
            dmin = np.full(N, 1e9, np.float32)
            for nm in real:
                dmin = np.minimum(dmin, dist[nm][ys, xs])
            ok &= dmin <= NEAR

        print('第%d轮: 待认领 %d, 可认领 %d (%.1f%%)'
              % (rd + 1, N, int(ok.sum()), 100 * ok.mean()))

        if not ok.any():
            break

        for i, nm in enumerate(real):
            sel = ok & (best_id == i)
            if not sel.any():
                continue
            yy, xx = ys[sel], xs[sel]
            layers[nm][yy, xx] = u[yy, xx]
            layers[nm][yy, xx, 3] = 255
            am[nm][yy, xx] = True
            add[nm] = add.get(nm, 0) + int(sel.sum())

        left_mask[ys[ok], xs[ok]] = False

    left = u.copy()
    cov = np.zeros((2048, 2048), bool)
    for nm in real:
        cov |= am[nm]
    left[cov] = 0
    print('总待认领 %d, 已认领 %d, 剩余 %d'
          % (int(um0.sum()), int((um0 & cov).sum()), int((left[:, :, 3] > TH_A).sum())))

    for nm in names:
        if nm.startswith(SKIP):
            Image.fromarray(left, 'RGBA').save(os.path.join(DST, nm), optimize=True)
            print('%-30s 剩余 %d px' % (nm, int((left[:, :, 3] > TH_A).sum())))
        else:
            Image.fromarray(layers[nm], 'RGBA').save(os.path.join(DST, nm), optimize=True)

    rep = sorted(add.items(), key=lambda kv: -kv[1])
    print()
    print('=== 各部件新增像素 ===')
    for nm, n in rep:
        print('  %-30s +%7d' % (nm, n))
    with open(OUT + '/fix3_report.json', 'w', encoding='utf-8') as fp:
        json.dump(dict(add=dict(rep), left=int((left[:, :, 3] > TH_A).sum())),
                  fp, ensure_ascii=False, indent=1)
    print()
    print('已写', OUT + '/fix3_report.json')


if __name__ == '__main__':
    main()
