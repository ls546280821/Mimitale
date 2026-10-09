# -*- coding: utf-8 -*-
"""
交接包「洞」诊断：找出角色轮廓内、但成块无内容的区域。

思路：
  1. 角色轮廓 = 所有层（含 00 未分配层）并集
  2. 内容并集 = 所有层（不含 00）并集
  3. 两者相减 = 「只有 00 层在撑」的像素
  4. 对差值做形态学开运算，滤掉细碎渣，剩下的成块区域 = 「真洞」
  5. 每个洞输出：位置、大小、周围是谁（谁最近）
"""
import numpy as np
from PIL import Image
from scipy import ndimage
import glob, os, sys, json

LAYERS = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers'
UNASSIGNED = '00_'
OUT = r'E:/工作/Mimitale/tools/pet/pipeline/out'

TH_A = 8          # alpha 阈值
OPEN_PX = 12      # 开运算半径：小于该尺度的差值算渣
MIN_HOLE = 900    # 洞最小面积


def load():
    fs = sorted(glob.glob(LAYERS + '/*.png'))
    return fs


def main():
    fs = load()
    allc = Image.new('RGBA', (2048, 2048), (0, 0, 0, 0))
    noc = Image.new('RGBA', (2048, 2048), (0, 0, 0, 0))
    for f in fs:
        im = Image.open(f).convert('RGBA')
        allc = Image.alpha_composite(allc, im)
        if not os.path.basename(f).startswith(UNASSIGNED):
            noc = Image.alpha_composite(noc, im)

    A = np.asarray(allc)[:, :, 3] > TH_A
    N = np.asarray(noc)[:, :, 3] > TH_A

    print('轮廓像素 =', A.sum())
    print('内容像素 =', N.sum())
    print('仅靠00撑着 =', (A & ~N).sum())

    # 只保留 00 层撑的区域
    only00 = (A & ~N).astype(np.uint8)

    # 开运算去掉细渣
    st = np.ones((OPEN_PX * 2 + 1, OPEN_PX * 2 + 1), np.uint8)
    opened = ndimage.binary_opening(only00, structure=st).astype(np.uint8)
    print('开运算后（真洞候选）像素 =', opened.sum())

    lab, n = ndimage.label(opened, structure=np.ones((3, 3)))
    print('连通块数 =', n)

    # 各部件位置（用于判断洞挨着谁）
    parts = {}
    for f in fs:
        nm = os.path.basename(f)[:-4]
        if nm.startswith(UNASSIGNED):
            continue
        al = np.asarray(Image.open(f).convert('RGBA'))[:, :, 3] > TH_A
        if al.sum() == 0:
            continue
        ys, xs = np.where(al)
        parts[nm] = (xs.min(), ys.min(), xs.max(), ys.max(), al)

    holes = []
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < MIN_HOLE:
            continue
        ys, xs = np.where(m)
        box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        cy, cx = int(ys.mean()), int(xs.mean())
        # 谁最近：用洞的质心找覆盖到的部件
        near = []
        for nm, (x0, y0, x1, y1, al) in parts.items():
            if x0 <= cx <= x1 and y0 <= cy <= y1 and al[cy, cx]:
                near.append((nm, 'contain'))
        # 邻域 40px 内出现最多的部件
        y0 = max(0, cy - 40); y1 = min(2048, cy + 41)
        x0 = max(0, cx - 40); x1 = min(2048, cx + 41)
        cnt = {}
        for nm, (_, _, _, _, al) in parts.items():
            c = int(al[y0:y1, x0:x1].sum())
            if c > 0:
                cnt[nm] = c
        top = sorted(cnt.items(), key=lambda kv: -kv[1])[:3]
        holes.append(dict(area=area, box=box, center=(cx, cy), near=top,
                          contain=[t[0] for t in near]))
        print('洞#%d 面积%6d  box=%s  质心=%s' % (i, area, box, (cx, cy)))
        print('      附近部件:', ', '.join('%s(%d)' % (k, v) for k, v in top))

    holes.sort(key=lambda h: -h['area'])
    print()
    print('=== 按面积排序，前 12 ===')
    for h in holes[:12]:
        print('  %7d px  质心%s  贴:%s' % (h['area'], h['center'],
              ','.join(k for k, _ in h['near'])))

    with open(OUT + '/holes.json', 'w', encoding='utf-8') as fp:
        json.dump(holes, fp, ensure_ascii=False, indent=1)
    print()
    print('已写', OUT + '/holes.json', '共', len(holes), '个洞')

    # 可视化：轮廓=浅灰，内容=中灰，洞=红
    vis = np.zeros((2048, 2048, 3), np.uint8); vis[:] = 255
    vis[A] = (225, 225, 225)
    vis[N] = (170, 170, 170)
    vis[opened > 0] = (230, 40, 40)
    Image.fromarray(vis).crop((400, 60, 1680, 2040)).resize((640, 990), Image.LANCZOS) \
        .save(OUT + '/洞_分布图.png')
    print('已写', OUT + '/洞_分布图.png')


if __name__ == '__main__':
    main()
