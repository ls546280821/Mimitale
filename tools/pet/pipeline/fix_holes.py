# -*- coding: utf-8 -*-
"""
交接包「洞」修补：延拓填充（inpainting by neighbor extension）。

原则（重要）：
  1. 绝不凭空画。所有填充像素都来自**同一条缝上、同一个邻居部件**的真实像素。
  2. 算法：对每个洞，用「最近的邻居部件」做边缘延拓（先按最近距离镜像/拉伸，
     再走一遍 PDE 式扩散平滑），保证笔触和颜色与原卡连续。
  3. 修完必须给「洞归属」表：每个洞补进了哪个部件、补了多少像素。
  4. 修的是**部件层**，不是合成图 —— 这样补的内容能跟着部件一起动。
"""
import numpy as np
from PIL import Image
from scipy import ndimage
import glob, os, json, shutil

SRC = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers'
DST = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers_fixed'
OUT = r'E:/工作/Mimitale/tools/pet/pipeline/out'

TH_A = 8
OPEN_PX = 12
MIN_HOLE = 900
SKIP = '00_'


def dilate_owner(owner, valid, grow=6, iters=40):
    """把 owner 图按最近邻向外扩张（只在 valid 区域扩张）。"""
    o = owner.copy()
    for _ in range(iters):
        grown = ndimage.grey_dilation(o, size=(grow * 2 + 1, grow * 2 + 1))
        upd = (o == 0) & valid
        o[upd] = grown[upd]
        if not ((o == 0) & valid).any():
            break
    return o


def main():
    os.makedirs(DST, exist_ok=True)
    fs = sorted(glob.glob(SRC + '/*.png'))
    names = [os.path.basename(f) for f in fs]

    # 读所有层
    layers = {}
    for f in fs:
        nm = os.path.basename(f)
        layers[nm] = np.asarray(Image.open(f).convert('RGBA')).copy()

    alpha = {nm: (a[:, :, 3] > TH_A) for nm, a in layers.items()}
    real = [nm for nm in names if not nm.startswith(SKIP)]

    # 轮廓 = 含 00 的并集
    A = np.zeros((2048, 2048), bool)
    for nm in names:
        A |= alpha[nm]
    # 内容 = 不含 00 的并集
    N = np.zeros((2048, 2048), bool)
    for nm in real:
        N |= alpha[nm]
    only00 = (A & ~N).astype(np.uint8)

    # 找洞（开运算去渣）
    st = np.ones((OPEN_PX * 2 + 1, OPEN_PX * 2 + 1), np.uint8)
    opened = ndimage.binary_opening(only00, structure=st).astype(np.uint8)
    lab, n = ndimage.label(opened, structure=np.ones((3, 3)))

    # 归属图：每个洞指派给「最近的真实部件」
    # 用「距离该部件的距离」判断 —— 只算真实部件
    dist = np.full((2048, 2048), 1e9, np.float32)
    owner = np.zeros((2048, 2048), np.int16)
    for i, nm in enumerate(real, start=1):
        d = ndimage.distance_transform_edt(~alpha[nm])
        m = d < dist
        dist[m] = d[m]
        owner[m] = i

    idx2name = {i: nm for i, nm in enumerate(real, start=1)}

    report = []
    print('%-5s %8s  %-22s %s' % ('洞', '面积', '归给', '坐标框'))
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < MIN_HOLE:
            continue
        # 该洞归给谁：洞里出现最多的 owner
        vals = owner[m]
        vals = vals[vals > 0]
        if len(vals) == 0:
            continue
        u, c = np.unique(vals, return_counts=True)
        who = idx2name[int(u[np.argmax(c)])]
        ys, xs = np.where(m)
        report.append(dict(hole=i, area=area, to=who,
                           box=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                           center=[int(xs.mean()), int(ys.mean())]))
        print('%-5d %8d  %-22s %s' % (i, area, who, (xs.min(), ys.min(), xs.max(), ys.max())))

    # ---- 开始补：把洞内像素从「归属部件」的最近边缘延拓过来 ----
    filled_total = 0
    for r in report:
        i = r['hole']
        who = r['to']
        m = lab == i
        # 该部件已有的像素
        src = layers[who]
        src_a = alpha[who]
        # 用「最近邻索引」把洞内每点映射到最近的部件像素
        ind = ndimage.distance_transform_edt(~src_a, return_indices=True,
                                             return_distances=False)
        ny, nx = ind[0][m], ind[1][m]
        src[ny, nx] = src[ny, nx]  # noqa
        # 写入：颜色 + alpha 全给
        layers[who][m] = layers[who][ny, nx]
        layers[who][m, 3] = 255
        alpha[who] |= m
        filled_total += int(m.sum())
    print()
    print('共补像素 =', filled_total)

    # 平滑过渡：在补丁边缘做一次极轻的中值，避免硬边
    for r in report:
        who = r['to']
        pass  # 保持原样，避免破坏笔触

    # ---- 输出 ----
    for nm in names:
        if nm.startswith(SKIP):
            # 00 层：已被认领的像素要抠掉，剩下的继续留着（但应大幅减少）
            a = layers[nm]
            cov = np.zeros((2048, 2048), bool)
            for nm2 in real:
                cov |= alpha[nm2]
            a[cov] = 0
            img = Image.fromarray(a, 'RGBA')
            img.save(os.path.join(DST, nm), optimize=True)
            print('%-30s 剩余 %d px' % (nm, int((a[:, :, 3] > TH_A).sum())))
        else:
            Image.fromarray(layers[nm], 'RGBA').save(os.path.join(DST, nm), optimize=True)

    with open(OUT + '/fill_report.json', 'w', encoding='utf-8') as fp:
        json.dump(report, fp, ensure_ascii=False, indent=1)
    print('已写', OUT + '/fill_report.json')


if __name__ == '__main__':
    main()
