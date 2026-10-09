# -*- coding: utf-8 -*-
"""
交接包修补 V4：剩余 00 层做「双边复制」。

V3 之后剩下的 11 万像素全是**跨部件边界的描边线**。
它们不该「二选一」，而该**两侧部件各留一份** ——
  理由：部件分开动时，每个部件的边缘都必须自带描边，
        否则一旋转就在缝里露出没有描边的秃边（= 用户说的「东一块西一块」）。

做法：
  1. 每一段剩余像素，找它两侧最近的两个部件 (A, B)
  2. 若 A、B 距离都 ≤ DUAL_NEAR，就把这段**同时**追加给 A 和 B
  3. 只给一份的情况：另一侧太远（> DUAL_NEAR）或没有（在角色外轮廓上）——
     外轮廓的描边给内侧那一个部件即可
"""
import numpy as np
from PIL import Image
from scipy import ndimage
import glob, os, json

SRC = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers_fixed'
DST = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers_final'
OUT = r'E:/工作/Mimitale/tools/pet/pipeline/out'

TH_A = 8
SKIP = '00_'
DUAL_NEAR = 22      # 两侧都在这个距离内 → 双边复制
ONE_NEAR = 34       # 只有一侧在这个距离内 → 单边给


def main():
    os.makedirs(DST, exist_ok=True)
    fs = sorted(glob.glob(SRC + '/*.png'))
    names = [os.path.basename(f) for f in fs]
    layers = {os.path.basename(f): np.asarray(Image.open(f).convert('RGBA')).copy() for f in fs}
    real = [nm for nm in names if not nm.startswith(SKIP)]
    am = {nm: (layers[nm][:, :, 3] > TH_A) for nm in real}

    u = layers['00_未分配像素补齐层.png']
    um = u[:, :, 3] > TH_A
    ys, xs = np.where(um)
    print('剩余待处理 =', len(xs))

    if len(xs) == 0:
        print('无需处理')
        return

    # 每个部件到该像素的距离
    D = []
    for nm in real:
        D.append(ndimage.distance_transform_edt(~am[nm])[ys, xs])
    D = np.stack(D, axis=1)          # (N, P)
    order = np.argsort(D, axis=1)    # 最近在前

    d1 = D[np.arange(len(xs)), order[:, 0]]
    d2 = D[np.arange(len(xs)), order[:, 1]]

    give1 = d1 <= ONE_NEAR
    dual = d2 <= DUAL_NEAR

    print('单边给 =', int(give1.sum()), ' 其中双边 =', int((give1 & dual).sum()))

    stat = {}
    # 单边（或外围）
    for i in range(len(real)):
        pass

    # 组装每个部件的追加 mask
    addm = {nm: np.zeros((2048, 2048), bool) for nm in real}
    # 第一近
    sel = give1
    i1 = order[sel, 0]
    for k in np.unique(i1):
        s = sel.copy()
        s[s] = (i1 == k)
        addm[real[k]][ys[s], xs[s]] = True
        stat[real[k]] = stat.get(real[k], [0, 0])
        stat[real[k]][0] += int(s.sum())
    # 第二近（双边复制）
    sel2 = give1 & dual
    i2 = order[sel2, 1]
    for k in np.unique(i2):
        s = sel2.copy()
        s[s] = (i2 == k)
        addm[real[k]][ys[s], xs[s]] = True
        stat[real[k]] = stat.get(real[k], [0, 0])
        stat[real[k]][1] += int(s.sum())

    for nm in real:
        m = addm[nm]
        if not m.any():
            continue
        layers[nm][m] = u[m]
        layers[nm][m, 3] = 255

    # 输出
    for nm in names:
        if nm.startswith(SKIP):
            a = u.copy()
            cov = np.zeros((2048, 2048), bool)
            for nm2 in real:
                cov |= addm[nm2]
            a[cov] = 0
            Image.fromarray(a, 'RGBA').save(os.path.join(DST, nm), optimize=True)
            print('%-30s 剩余 %d px' % (nm, int((a[:, :, 3] > TH_A).sum())))
        else:
            Image.fromarray(layers[nm], 'RGBA').save(os.path.join(DST, nm), optimize=True)

    print()
    print('=== 各部件追加（单边 / 双边）===')
    for nm, (a, b) in sorted(stat.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
        print('  %-30s 单边+%6d  双边+%6d' % (nm, a, b))

    with open(OUT + '/fix4_report.json', 'w', encoding='utf-8') as fp:
        json.dump({k: v for k, v in stat.items()}, fp, ensure_ascii=False, indent=1)
    print('已写', OUT + '/fix4_report.json')


if __name__ == '__main__':
    main()
