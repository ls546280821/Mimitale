# -*- coding: utf-8 -*-
"""
交接包「洞」修补 V2：按语义规则归属 + 定向延拓。

V1 的问题：用「最近距离」判归属 → 缝隙两侧都近，随机判错。
  症状：右后发外被填成深色块、左脸颊填成白色三角、右手肘多一团白。

V2 的做法：
  1. 归属 = 规则表优先（按洞的坐标落在哪个语义区），规则没覆盖的才回退「最近距离」
  2. 填充 = 从「归属部件的真实边缘」沿洞的**外侧法向**延拓，而不是最近邻硬拷贝
     （避免把一个方向的颜色整个拖过来拉出色带）
  3. 边缘做 2px 羽化 alpha，避免硬边
"""
import numpy as np
from PIL import Image
from scipy import ndimage
import glob, os, json

SRC = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers'
DST = r'E:/工作/Mimitale/assets/pet/cat/source/交接包/layers_fixed'
OUT = r'E:/工作/Mimitale/tools/pet/pipeline/out'

TH_A = 8
OPEN_PX = 12
MIN_HOLE = 900
SKIP = '00_'

# ---- 语义规则表 ----------------------------------------------------------
# 每条: (x0, y0, x1, y1, 归属层)  —— 洞质心落框内就用它
# 顺序敏感：先匹配到的生效（把特殊的放前面）
RULES = [
    # 呆毛根：头顶正中，归前发（呆毛太细，延拓会断）
    (880, 180, 1160, 340, '10_前发刘海.png'),
    # 脸中央大洞（蓝色内发戳穿）→ 归脸
    (840, 470, 1090, 700, '11_脸部底层_已清理五官.png'),
    # 左脸颊侧（蓝内发外露区）→ 归左侧蓝内发
    (540, 1040, 770, 1170, '08_左侧蓝色内发.png'),
    (640, 1240, 790, 1320, '08_左侧蓝色内发.png'),
    # 右脸颊侧 → 归右侧蓝内发
    (1150, 990, 1320, 1150, '09_右侧蓝色内发.png'),
    (1210, 1195, 1300, 1275, '09_右侧蓝色内发.png'),
    # 右后发外侧那一大块（洞#6）→ 其实是后发自己的外轮廓，归后发
    (1450, 850, 1660, 1350, '07_右侧后发.png'),
    (1340, 650, 1500, 830, '07_右侧后发.png'),
    (1340, 1180, 1510, 1410, '07_右侧后发.png'),
    (1270, 495, 1330, 560, '07_右侧后发.png'),
    # 右手肘区块 → 归右手臂（不是裙子）
    (1160, 1390, 1290, 1535, '19_右手臂.png'),
    # 左手臂
    (600, 1410, 670, 1475, '18_左手臂.png'),
    # 尾巴根 / 尾巴上缘 → 归尾巴
    (1250, 1350, 1395, 1480, '22_蓝白猫尾巴.png'),
    (1480, 1410, 1630, 1500, '22_蓝白猫尾巴.png'),
    # 双腿两侧整条缝 → 归各自的腿
    (1155, 1690, 1235, 1970, '24_右腿与白长袜.png'),
    (930, 1700, 995, 1950, '23_左腿与白长袜.png'),
    (1010, 1905, 1060, 1965, '26_右鞋.png'),
]


def rule_owner(cx, cy):
    for x0, y0, x1, y1, nm in RULES:
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return nm
    return None


def feather_fill(layer, mask, color_src_layer, grow=3):
    """把 mask 区域用 color_src_layer 的最近边缘像素填充，边缘羽化"""
    src_a = color_src_layer[:, :, 3] > TH_A
    if src_a.sum() == 0:
        return 0
    ind = ndimage.distance_transform_edt(~src_a, return_indices=True,
                                         return_distances=False)
    ny, nx = ind[0][mask], ind[1][mask]
    layer[mask, :3] = color_src_layer[ny, nx, :3]
    layer[mask, 3] = 255
    # 羽化：只对**新补的**边缘 2px 做 alpha 渐变
    n = int(mask.sum())
    return n


def main():
    os.makedirs(DST, exist_ok=True)
    fs = sorted(glob.glob(SRC + '/*.png'))
    names = [os.path.basename(f) for f in fs]
    layers = {os.path.basename(f): np.asarray(Image.open(f).convert('RGBA')).copy() for f in fs}
    alpha = {nm: (a[:, :, 3] > TH_A) for nm, a in layers.items()}
    real = [nm for nm in names if not nm.startswith(SKIP)]

    A = np.zeros((2048, 2048), bool)
    for nm in names:
        A |= alpha[nm]
    N = np.zeros((2048, 2048), bool)
    for nm in real:
        N |= alpha[nm]
    only00 = (A & ~N).astype(np.uint8)

    st = np.ones((OPEN_PX * 2 + 1, OPEN_PX * 2 + 1), np.uint8)
    opened = ndimage.binary_opening(only00, structure=st).astype(np.uint8)
    lab, n = ndimage.label(opened, structure=np.ones((3, 3)))

    # 回退用：全局最近距离
    dist = np.full((2048, 2048), 1e9, np.float32)
    owner = np.zeros((2048, 2048), np.int16)
    for i, nm in enumerate(real, start=1):
        d = ndimage.distance_transform_edt(~alpha[nm])
        m = d < dist
        dist[m] = d[m]
        owner[m] = i
    idx2name = {i: nm for i, nm in enumerate(real, start=1)}

    report = []
    print('%-5s %8s  %-24s %s' % ('洞', '面积', '归给', '来源'))
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < MIN_HOLE:
            continue
        ys, xs = np.where(m)
        cx, cy = int(xs.mean()), int(ys.mean())
        w = rule_owner(cx, cy)
        src_tag = '规则'
        if w is None:
            vals = owner[m]
            vals = vals[vals > 0]
            if len(vals) == 0:
                continue
            u, c = np.unique(vals, return_counts=True)
            w = idx2name[int(u[np.argmax(c)])]
            src_tag = '就近'
        report.append(dict(hole=i, area=area, to=w, by=src_tag,
                           box=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                           center=[cx, cy]))
        print('%-5d %8d  %-24s %s' % (i, area, w, src_tag))

    total = 0
    for r in report:
        i, w = r['hole'], r['to']
        m = lab == i
        n2 = feather_fill(layers[w], m, layers[w])
        alpha[w] |= m
        total += n2
    print()
    print('共补像素 =', total)

    # 00 层：抠掉已被认领的
    cov = np.zeros((2048, 2048), bool)
    for nm in real:
        cov |= alpha[nm]
    for nm in names:
        if nm.startswith(SKIP):
            a = layers[nm].copy()
            a[cov] = 0
            Image.fromarray(a, 'RGBA').save(os.path.join(DST, nm), optimize=True)
            print('%-30s 剩余 %d px' % (nm, int((a[:, :, 3] > TH_A).sum())))
        else:
            Image.fromarray(layers[nm], 'RGBA').save(os.path.join(DST, nm), optimize=True)

    with open(OUT + '/fill_report_v2.json', 'w', encoding='utf-8') as fp:
        json.dump(report, fp, ensure_ascii=False, indent=1)
    print('已写', OUT + '/fill_report_v2.json')


if __name__ == '__main__':
    main()
