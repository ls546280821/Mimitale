#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
step2_parts.py —— 拆件（**显式分区**，不是自动连通分割）

⚠️ **为什么不用「描边当分割线 → 连通区域」**：实测不成立。见 README 的表 ——
描边阈值从 150 扫到 225，最大连通块始终占角色 20.8%~48.8%，头/身体/头发总能连成一片。
（这也正是星宝说的「乱选抠图顺序，一些部位连在一起」的根因。）

**办法：种子点 + 分水岭（watershed）**

- 我只放**种子点**（每个部件一/几个），标出「这块是什么」；
- 算法沿图上**本来就有的边界**自动长区域。地形用 **梯度幅值**（不是暗度）——
  第一版用暗度当地形，结果浅色描边看不见，`mouth` 一口气吃了 13 万像素、
  `apron` 吃了 22 万，全串味。梯度幅值能把**任何可见边界**都变成山脊。

两块靠种子切不开的，另外用明确规则处理：

1. **后发 / 侧发** —— 两者之间没有描边（是设计分工不是图像边界）。规则：
   **压在身体轮廓上的头发 = 侧发，身体轮廓之外的 = 后发**。
   视觉上正好对应「盖在裙子上的发绺」与「背后那一片」。
2. **五官（眼 / 嘴）** —— 太小、描边太弱，分水岭切不出来。改成
   **在脸的范围内按颜色取**：非肤色的暗/蓝像素就是眼睛，眼睛下方那块小红是嘴。

跑法：
    python tools/pet/pipeline/step2_parts.py assets/pet/cat/build/master-keyed.png \
           assets/pet/cat/build
产物：
    build/parts/<id>.png        每个部件（RGBA）
    build/parts/_parts.json     部件 bbox（下一步算 rig box 用）
    build/_seg_overlay.png      分区覆盖图（**先看这个，别急着装机**）
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.segmentation import watershed

# ---------------------------------------------------------------------------
# 种子点表：**全是母版像素坐标**，对着 build/_master_grid.png 标。
# 角色 bbox 是 x 429..1645 / y 92..2002（1217×1911），二头身，头占上半。
# ---------------------------------------------------------------------------
SEEDS = {
    # 头发整体先长成一块，再由 split_hair() 按「是否压在身体轮廓上」切成
    # 后发 / 侧发（左、右）。两者之间没有描边，让分水岭去猜是错的。
    'hair':            [(470, 1000), (1620, 950), (520, 1200), (1560, 1150),
                        (600, 1400), (1500, 1350)],
    'tail':            [(1400, 1420), (1520, 1470), (1590, 1560), (1500, 1660),
                        (1400, 1710), (1600, 1620), (1360, 1520), (1450, 1560)],
    'leg_left':        [(770, 1806)],
    'leg_right':       [(1040, 1826)],
    'torso_up':        [(944, 1233)],
    'collar':          [(918, 1115)],
    'skirt':           [(945, 1549)],
    'apron':           [(881, 1447)],
    'arm_right':       [(1214, 1441), (1230, 1350), (1245, 1280), (1300, 1490)],
    'arm_left':        [(594, 1380), (610, 1300), (625, 1220), (560, 1460)],
    'ear_right':       [(1352, 319)],
    'ear_left':        [(562, 270)],
    'face':            [(891, 877), (960, 1020)],
    'bangs':           [(878, 571)],
    'ahoge':           [(910, 166)],
}
# 五官不靠种子，靠颜色（见 pick_face_features）
FACE_FEATURES = ['eye_open', 'mouth']

PART_META = {
    'hair_back':       dict(z=0.5,  parent='headBack'),
    'tail':            dict(z=1.5,  parent='tailBend'),
    'leg_right':       dict(z=3.0,  parent='legFront'),
    'leg_left':        dict(z=4.0,  parent='legBack'),
    'arm_right':       dict(z=4.5,  parent='armFar'),
    'torso_up':        dict(z=5.0,  parent='waist'),
    'collar':          dict(z=5.1,  parent='waist'),
    'skirt':           dict(z=5.2,  parent='skirt'),
    'apron':           dict(z=5.4,  parent='skirt'),
    'arm_left':        dict(z=6.0,  parent='armNear'),
    'ear_right':       dict(z=7.0,  parent='earFar'),
    'face':            dict(z=8.0,  parent='headMid'),
    'eye_open':        dict(z=8.5,  parent='headFeat', sub='feat'),
    'eye_closed':      dict(z=8.5,  parent='headFeat', sub='feat'),
    'mouth':           dict(z=8.6,  parent='headFeat', sub='feat'),
    'ear_left':        dict(z=11.0, parent='earNear'),
    'hair_side_right': dict(z=12.0, parent='headFront'),
    'hair_side_left':  dict(z=12.1, parent='headFront'),
    'bangs':           dict(z=13.0, parent='bangsSway'),
    'ahoge':           dict(z=14.0, parent='ahoge'),
}
# 几何夹取：这些部件必须落在指定盒子里（母版像素），漫出去的部分还给最近的邻居。
# **为什么不用分水岭自己找边界**：耳朵与头发之间、腿与裙子之间没有可用的描边
# （或者太浅），分水岭找不到墙就会一路漫下去 —— 实测 `ear_right` 因此把整条右侧头发
# 都吞了（bbox 605×660、124143 px，内容占比只有 31%），
# 后果是「耳朵一转，头发跟着转」+ 贴图里 70% 是空白。
CLIP_BOX_PX = {
    'ear_left':  (440, 100, 800, 610),
    'ear_right': (1120, 100, 1560, 640),
    'leg_left':  (770, 1450, 1025, 2012),
    'leg_right': (990, 1450, 1255, 2012),
}
# 算「身体轮廓」用哪几块（后发/侧发的分界依据）
BODY_PARTS = ['torso_up', 'collar', 'skirt', 'apron', 'arm_left', 'arm_right',
              'leg_left', 'leg_right']


def build_markers(shape, seeds, ok):
    """种子点 -> 标记图。

    ⚠️ **种子必须落在角色实心像素上，而且不能落在描边上**：
      - 落在背景上 -> watershed(mask=char) 会把这个标号整个丢掉、部件直接 0 像素
        （2026-10-09：从旧包按比例映射来的 7 个种子飞到背景上，`tail`/`arm_left`/`ahoge` 全变 0）；
      - 落在描边**线上** -> 种子贴着「墙」，那块只长得出几十像素
        （同一轮的第二遍：`tail` 只剩 1304 px、`arm_left` 只剩 38 px）。
    所以这里**自动吸附到最近的、非描边的实心像素**，找歪了也不会静默失败。
    """
    markers = np.zeros(shape, np.int32)
    _, idx = ndimage.distance_transform_edt(~ok, return_indices=True)
    yy, xx = np.mgrid[-7:8, -7:8]
    disk = (yy ** 2 + xx ** 2) <= 49
    for i, pts in enumerate(seeds.values(), start=1):
        for (x, y) in pts:
            if not (0 <= y < shape[0] and 0 <= x < shape[1]):
                print('  ⚠️ 种子 (%d,%d) 出界，跳过' % (x, y))
                continue
            if not ok[y, x]:
                ny, nx = int(idx[0][y, x]), int(idx[1][y, x])
                print('  · 种子 (%d,%d) 不在实心区，吸附到 (%d,%d)' % (x, y, nx, ny))
                x, y = nx, ny
            y0, x0 = y - 7, x - 7
            if y0 < 0 or x0 < 0 or y0 + 15 > shape[0] or x0 + 15 > shape[1]:
                continue
            sub = markers[y0:y0 + 15, x0:x0 + 15]
            sub[disk & (sub == 0)] = i
    return markers


def line_mask(rgb, char):
    """细描边 = 黑帽变换（闭运算 − 原图）的响应。

    **为什么不能用「亮度 < 某个阈值」**：这个母版的内部描边是**中灰蓝**（不是深黑），
    按绝对亮度卡阈值要么漏掉内部描边、要么把整片蓝裙子吃掉。黑帽只看「比周围暗」，
    细线特征天然突出，与线的绝对深浅无关。
    """
    g = rgb.astype(np.float32).mean(axis=2)
    bh = ndimage.grey_closing(g, size=(9, 9)) - g
    return char & (bh > 10)


def edge_elevation(rgb, char, lines):
    """地形 = 细描边处一道**硬墙** + 其余地方很低的坡度。

    第一版拿「亮度」当地形：浅描边看不见，`bangs` 一口气吃了 56 万像素。
    第二版拿梯度当地形：梯度只让穿越「变贵」而不是「不可通行」，大块照样互相吞并
    （`arm_right` 22 万、`leg_right` 21 万）。现在改成**描边处地形直接拉到 10000**
    —— 洪水会先把所有非描边区域填满，描边本身最后由先碰到的邻居分掉，
    等价于「描边是墙」，这才是拆件真正需要的语义。
    """
    g = rgb.astype(np.float32).mean(axis=2)
    mag = np.hypot(ndimage.sobel(g, 1), ndimage.sobel(g, 0))
    mag = ndimage.gaussian_filter(mag, 1.0)
    if mag.max() > 0:
        mag = mag / mag.max() * 60.0
    elev = mag + np.where(lines, 10000.0, 0.0)
    elev[~char] = 1e7
    return elev


def skin_mask(rgb, char):
    """肤色：亮、偏暖（R 明显大于 B）。用来在脸里挑出五官。"""
    r, g, b = (rgb[:, :, i].astype(np.int16) for i in range(3))
    return char & (r > 225) & ((r - b) > 12) & ((r - b) < 90)


def box(x0, y0, x1, y1, shape):
    m = np.zeros(shape, bool)
    m[max(0, y0):y1, max(0, x0):x1] = True
    return m


def make_eye_closed(rgb, eye_open, char):
    """程序化生成闭眼贴图。返回 (mask, 线色)。

    母图上只有睁眼，`eye_closed` 得自己画 —— 这和旧管线一样。
    做法尽量少假设：**每只眼的「上缘轮廓」本来就是一条上凸弧**，
    沿它描一条带就是闭眼的形状；线色取母版睫毛线（眼睛里最暗那批像素）的中位色，
    这样闭眼和睁眼的线色是同一个调子，眨眼时不会跳色。

    为什么要它：`renderer/pet/cat-figure.js` 的眨眼靠 `st.alpha` 在
    `eye_open` / `eye_closed` 之间交叉切换（`hasBlink` 要求两张都在）。
    脸贴图那边已经把眼区**用肤色填平**了，所以闭眼时不会露出母图的眼珠。
    """
    lum = rgb.astype(np.float32).mean(axis=2)
    dark = eye_open & (lum < np.percentile(lum[eye_open], 12))
    if dark.sum() < 20:
        dark = eye_open
    color = np.median(rgb[dark].reshape(-1, 3), axis=0)

    out = np.zeros_like(char)
    lab, n = ndimage.label(eye_open, np.ones((3, 3), int))
    if not n:
        return out, color
    sz = ndimage.sum(eye_open, lab, range(1, n + 1))
    for k in np.argsort(-sz)[:2]:
        m = lab == (k + 1)
        ys, xs = np.where(m)
        if not len(ys):
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        top = np.full(x1 - x0 + 1, np.nan)
        for i, x in enumerate(range(x0, x1 + 1)):
            col = np.where(m[:, x])[0]
            if len(col) and len(col) < (ys.max() - ys.min() + 1) * 0.85:
                top[i] = col.min()
        # 只保留有轮廓的列，并按 x 顺序插值补缺（中间可能被高光打断）
        ok = ~np.isnan(top)
        if ok.sum() < 5:
            continue
        top = np.interp(np.arange(len(top)), np.where(ok)[0], top[ok])
        # 平滑掉锯齿，免得弧线一抖一抖
        kk = np.ones(9) / 9.0
        top = np.convolve(np.pad(top, 4, mode='edge'), kk, mode='valid')
        # 两端的开口收窄一点，像一条闭合的眼缝
        span = x1 - x0
        t = np.linspace(-1, 1, len(top))
        thick = np.clip((2.2 - 1.3 * t ** 4), 0.7, 2.2) * 5.0
        for i, x in enumerate(range(x0, x1 + 1)):
            cy = int(round(top[i]))
            r = int(round(thick[i]))
            lo, hi = max(0, cy - r), min(char.shape[0], cy + r + 1)
            out[lo:hi, x] = True
    return out & char, color


def arm_regions(rgb, char, shape):
    """双臂：返回 {id: (窄矩形, 手的肤色块)} —— 位置靠**手**锚定。

    为什么双臂不交给分水岭：这个母版的袖子贴着衣身，两者之间那条线太浅，
    分水岭找不到墙 —— `arm_right` 一口气吃了 14.5 万像素（把裙子都吞了）。

    矩形按手宽而不是全身宽来收（±35% 手宽），并且**调用方还要再减掉别人已占的地盘**。
    ⚠️ 但「别人」里**不能包含尾巴**：实测右手 (1184~1396, 1341~1535) 与尾巴
    (1089~1642, 1367~1873) **在空间上重叠**，尾巴的种子会把手吃成绿色。
    所以调用方要用「手的肤色块」把它抢回来，并且限制手臂只能拿
    「第一遍本来就判给手臂、且不属于尾巴」的像素。
    """
    skin = skin_mask(rgb, char)
    lab, n = ndimage.label(skin, np.ones((3, 3), int))
    if not n:
        return {}
    sz = ndimage.sum(skin, lab, range(1, n + 1))
    comps = []
    for k in np.argsort(-sz)[:6]:
        ys, xs = np.where(lab == k + 1)
        comps.append((int(sz[k]), int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), k + 1))
    hands = [c for c in comps[1:] if c[2] > shape[0] * 0.5][:2]
    if len(hands) < 2:
        return {}
    out = {}
    for (_, x0, y0, x1, y1, k), pid in zip(sorted(hands, key=lambda c: c[1]),
                                            ('arm_left', 'arm_right')):
        w = x1 - x0
        # 矩形按**手**锚定：x 只比手宽 ±12%（袖子不会比手宽太多），
        # y 从「袖口往上 135px」（实测袖顶在母版 y≈1200）到手块底。
        # 早先写死 y0=1115 的时候，手臂会往上漫到脖子/胸口那片没人认领的地方，
        # `arm_left` 直接 14.3 万像素。
        out[pid] = (box(int(x0 - w * 0.12), int(y0 - 135), int(x1 + w * 0.12), int(y1 + 25), shape) & char,
                    lab == k)
    return out


def face_region(rgb, char):
    """脸用**肤色**定，返回 mask（不从分水岭来）。

    脸本来就是肤色，按颜色找比按描边找稳得多（这个母版刘海压在额头上，
    脸与刘海之间那条线并不闭合）。取最大的肤色连通块，向外放 4px 把脸自己的描边圈进来。
    """
    skin = skin_mask(rgb, char)
    lab, n = ndimage.label(skin, np.ones((3, 3), int))
    if not n:
        return None
    sz = ndimage.sum(skin, lab, range(1, n + 1))
    core = lab == (int(np.argmax(sz)) + 1)
    return ndimage.binary_dilation(core, np.ones((9, 9), bool)) & char


def pick_face_features(rgb, char, face_mask, not_hair):
    """在脸的范围内按颜色抠五官。返回 (feats, face_holes)。

    ⚠️ **搜索区不能用「腐蚀脸掩码」**（试过 `fill_holes`、试过 `binary_closing`，
    都不行）：这一版的**右眼几乎贴着脸的右边缘**，那一圈皮肤被刘海和后发压得很窄，
    一腐蚀整块眼区就被挖掉了 —— 采样证实右眼区全是「不在 inner 内」，
    但 RGB 完全正常。表现就是星宝看到的「**右眼变蓝了**」（被 bangs 占着）。
    正确做法：搜索区 = **脸的椭圆内 ∩ 排除头发**。头发的位置我们已经从标号图知道了，
    排除掉它，剩下的非肤色块就只剩眼睛和嘴。

    ⚠️ **不要按「宽 > 高」筛眼睛**：这版母版的眼睛接近方形（约 115×130），
    按横长条筛会把眼睛整对筛掉。

    第二个返回值 `face_holes` 是「眼 + 嘴」占的那块：调用方要用**肤色把它填平**
    再当脸贴图 —— 否则闭眼时（`eye_closed` 只画一条弧）会把母图里睁着的眼珠露出来。
    """
    out = {}
    skin = skin_mask(rgb, char)
    fy, fx = np.where(face_mask)
    if not len(fy):
        return out, np.zeros_like(char)
    cx = (fx.min() + fx.max()) / 2.0
    cy = (fy.min() + fy.max()) / 2.0
    rx = (fx.max() - fx.min()) / 2.0 * 0.95
    ry = (fy.max() - fy.min()) / 2.0 * 0.95
    Y, X = np.mgrid[0:char.shape[0], 0:char.shape[1]]
    inner = (((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2) <= 1.0
    # ⚠️ 这里**不要排除头发**：前发的标号正好压在右眼上，排除头发会把右虹膜一起排掉
    #    （失败记录：`feats` 又变空）。虹膜是脸上唯一的高饱和蓝，本身已经够特异，
    #    头发的蓝挑染在这条阈值下不会形成大块。
    region = inner & char
    # ---- 眼睛：先找虹膜，再从虹膜长成整只眼 ----
    # 为什么用「虹膜蓝」而不是「非肤色」：这一版母版的刘海 / 后发标号会**渗进眼窝**，
    # 排除头发会把眼睛一起排掉（试过的结果：左眼没抓到、抓成了「刘海 + 右眼」一大片）。
    # 而**虹膜是脸上唯一的高饱和蓝**，`B−R > 40` 下干净地就是两大块
    # （实测 10485 / 8448 px，中心 x=1121 / 826，脸中线 962，基本对称）。
    br = rgb[:, :, 2].astype(np.int16) - rgb[:, :, 0]
    iris = region & (br > 40)
    lab, n = ndimage.label(iris, structure=np.ones((3, 3), int))
    if not n:
        return out, np.zeros_like(char)
    sz = ndimage.sum(iris, lab, range(1, n + 1))
    seeds = [k + 1 for k in np.argsort(-sz)[:2] if sz[k] > 2000]
    if len(seeds) != 2:
        return out, np.zeros_like(char)
    eyes = []
    for s in seeds:
        blob = ndimage.binary_dilation(lab == s, np.ones((43, 43), bool)) & ~skin & region
        l2, n2 = ndimage.label(blob, np.ones((3, 3), int))
        if not n2:
            continue
        # 只保留与这枚虹膜相连的那一块（虹膜 + 眼白 + 睫毛）
        hit = np.unique(l2[(lab == s)])
        hit = hit[hit > 0]
        if not len(hit):
            continue
        pick = hit[np.argmax([(l2 == h).sum() for h in hit])]
        eyes.append(l2 == pick)
    if len(eyes) != 2:
        return out, np.zeros_like(char)
    eye = eyes[0] | eyes[1]
    out['eye_open'] = eye
    ys, xs = np.where(eye)
    eye_bottom = int(ys.max())
    # 嘴 = **脸下半部中轴上的暗块**。「偏红」会把腮红圈进来；「最大暗块」会挑到下巴线，
    # 所以搜索区上界卡在脸底之上。
    lum = rgb.astype(np.float32).mean(axis=2)
    half = max(40.0, (fx.max() - fx.min()) * 0.10)
    mbox = box(int(cx - half), eye_bottom, int(cx + half),
               int(eye_bottom + (fy.max() - eye_bottom) * 0.62), char.shape)
    cand2 = mbox & region & (lum < 150)
    if cand2.sum() > 30:
        lab2, n2 = ndimage.label(cand2, np.ones((3, 3), int))
        if n2:
            sz2 = ndimage.sum(cand2, lab2, range(1, n2 + 1))
            out['mouth'] = ndimage.binary_dilation(
                lab2 == (int(np.argmax(sz2)) + 1), np.ones((3, 3), bool), 2)
    holes = np.zeros_like(char)
    for m in out.values():
        holes |= ndimage.binary_dilation(m, np.ones((5, 5), bool), 2)
    return out, holes & region


def split_hair(labels, ids, char):
    """按「是否压在身体轮廓上」把整块头发拆成 侧发(左/右) 与 后发。

    这是整条管线里**唯一一处不适合交给分水岭**的地方：侧发与后发之间没有描边
    （是设计分工，不是图像边界）。规则：
      - 压在身体轮廓（躯干/裙/围裙/双臂/腿，膨胀一圈）上的发绺 -> 侧发（按左右分）
      - 轮廓之外的头发（头顶两侧那一大圈、背后的发）        -> 后发
    视觉上正好对应「盖在裙子上的发绺」与「背后那一片」。
    """
    body = np.zeros_like(char)
    for pid in BODY_PARTS:
        if pid in ids:
            body |= labels == ids[pid]
    body = ndimage.binary_dilation(body, np.ones((21, 21), bool))
    hair = labels == ids['hair']
    # 头/脸那一块也是"身体"的一部分：脸、耳、前发盖着的地方不算后发
    core = np.zeros_like(char)
    for pid in ('face', 'ear_left', 'ear_right', 'bangs', 'ahoge'):
        if pid in ids:
            core |= labels == ids[pid]
    core = ndimage.binary_dilation(core, np.ones((9, 9), bool))
    ys, xs = np.where(char)
    cx = (xs.min() + xs.max()) / 2.0
    Y, X = np.mgrid[0:char.shape[0], 0:char.shape[1]]
    # 后发 = 不压身体的那部分（但脸/耳/前发正下方那圈仍算后发，这是对的）
    labels[hair & ~(body | core)] = ids['hair_back']
    left = hair & (body | core) & (X < cx)
    right = hair & (body | core) & (X >= cx)
    labels[left] = ids['hair_side_left']
    labels[right] = ids['hair_side_right']


def main():
    keyed_path, build = sys.argv[1], sys.argv[2]
    parts_dir = os.path.join(build, 'parts')
    os.makedirs(parts_dir, exist_ok=True)

    a = np.asarray(Image.open(keyed_path)).astype(np.uint8)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    char = alpha > 100
    print('角色像素 %d' % char.sum())

    lines = line_mask(rgb, char)
    print('描边像素占角色 %.1f%%' % (100.0 * lines.sum() / max(1, char.sum())))
    elev = edge_elevation(rgb, char, lines)
    ids = {pid: i for i, pid in enumerate(SEEDS.keys(), start=1)}
    # 头发的三个去向由 split_hair 切出来，没有自己的种子，手动占保留标号
    ids['hair_back'] = 101
    ids['hair_side_left'] = 102
    ids['hair_side_right'] = 103

    # ---- 第一遍：纯按种子长 ----
    labels = watershed(elev, build_markers(char.shape, SEEDS, char & ~lines), mask=char)

    # ---- 用规则算出「脸 / 双臂」的显式区域，**腾出旧的错误标号**再跑第二遍 ----
    # 只往后加像素是不够的（第一版 `pick_arms` 就只加不减，`arm_right` 依然 14.5 万）。
    # 把这两类标号清零、换成规则区域当标记后重跑，被腾出来的像素才会重新有归属。
    arms = arm_regions(rgb, char, char.shape)
    face_m = face_region(rgb, char)
    # 「别人已占的地盘」。⚠️ 这里**必须排除尾巴**：实测右手与尾巴在空间上重叠，
    # 尾巴的种子会把手吃成绿色（星宝就是看到「右手有一部分变绿了」）。
    # 把尾巴算进保护区，等于把「手被尾巴霸占」当成正确结果固化下来。
    owned = np.zeros_like(char)
    for pid, k in ids.items():
        if pid not in ('arm_left', 'arm_right', 'face', 'tail'):
            owned |= labels == k
    tail_lab = labels == ids['tail'] if 'tail' in ids else np.zeros_like(char)
    mk = labels.copy()
    for pid in ('arm_left', 'arm_right', 'face'):
        if pid in ids:
            mk[labels == ids[pid]] = 0
    for pid, (reg, hand) in arms.items():
        kid = ids[pid]
        # ⚠️ **标记里绝对不能带上整个矩形**：标记内的像素永远是标记的，分水岭不会去动它们 ——
        #    早先写成 `(dilate(hand) | reg) & ~owned`，结果手臂的遮罩就等于那个矩形
        #    （实测 arm_left 填充率 81%），把旁边的头发、裙角全圈了进去，
        #    渲染出来就是「一块贴上去的方块、边界是直边」（星宝报的「一块一块的」）。
        #    正确做法：**只用手的肤色块当种子**（它在手臂内部），让分水岭沿描边自己长；
        #    矩形只留作事后夹取（下面 clip），不参与标记。
        m = ndimage.binary_dilation(hand, np.ones((13, 13), bool)) & ~owned & ~tail_lab
        m |= hand
        if m.sum() > 500:
            mk[m] = kid
    if face_m is not None:
        mk[face_m] = ids['face']
    labels = watershed(elev, mk, mask=char)

    # 把「漫出盒子」的像素还给最近的**同类之外**的邻居。
    # 为什么要这一步：盒子是标记，分水岭会从标记往外长 ——
    #   · 脖子/胸口那片没有自己的部件（无主地），手臂就漫进去；
    #   · 耳朵与头发之间没有描边，耳朵就沿头发漫下去。
    # 硬切回盒子、再让邻居接管，比放宽盒子靠运气稳得多。
    clip = dict(CLIP_BOX_PX)
    for pid, (reg, _hand) in arms.items():
        clip[pid] = reg
    stray = np.zeros_like(char)
    for pid, spec in clip.items():
        if pid not in ids:
            continue
        reg = spec if isinstance(spec, np.ndarray) else box(*spec, char.shape)
        stray |= (labels == ids[pid]) & ~reg
    if stray.any():
        no_target = labels.copy()
        for pid in clip:
            if pid in ids:
                no_target[no_target == ids[pid]] = 0
        _, idx = ndimage.distance_transform_edt(no_target == 0, return_indices=True)
        labels[stray] = no_target[idx[0][stray], idx[1][stray]]
        print('几何夹取：还给邻居 %d px' % int(stray.sum()))

    # 去岛屿：每个部件只保留「够大的」连通块，其余交还给邻居。
    # 为什么要它：分水岭会随手把一些**散片**分给各部件（典型是耳/头发/尾巴的边边角角），
    # 散片本身可能几千像素，却会把部件的 **bbox 撑到半个画布** —— 实测 `ear_left`
    # 的 bbox 有 744×628 px 但内容只占 18%（耳朵本身才 200 px 宽），
    # 整包贴图从 0.8MB 涨到 7.7MB，VRAM 也白占。
    # 阈值用**相对值**（相对该部件最大的那一块）：绝对阈值 300px 只清掉 14 px，没用。
    drop = np.zeros_like(char)
    for pid in ids:
        m = labels == ids[pid]
        if not m.any():
            continue
        l3, n3 = ndimage.label(m, np.ones((3, 3), int))
        if n3 <= 1:
            continue
        sz3 = ndimage.sum(m, l3, range(1, n3 + 1))
        thr = max(300.0, float(sz3.max()) * 0.08)
        keep = np.isin(l3, (np.where(sz3 >= thr)[0] + 1))
        drop |= m & ~keep
    if drop.any():
        labels[drop] = 0
        print('去岛屿：清掉 %d px 的散片，交还给邻居' % int(drop.sum()))

    # 填掉未分配像素（label 0）。watershed 在标记之间可能留下细缝，
    # 不补的话合成回角色时**会露出洞**（2026-10-09：左手旁 (660,1380) 就是 0）。
    un = char & (labels == 0)
    if un.any():
        _, idx = ndimage.distance_transform_edt(labels == 0, return_indices=True)
        labels[un] = labels[idx[0][un], idx[1][un]]
        print('补上未分配像素 %d 个' % int(un.sum()))

    split_hair(labels, ids, char)

    # 五官：在「脸的椭圆内、且排除头发」的区域里按颜色挑（**不能用 labels==face**，
    # 也不能用腐蚀脸掩码，见函数注释）。**不挖洞** —— 脸贴图会把眼/嘴那块用肤色填平，
    # 否则闭眼时（eye_closed 只画一条弧）会把母图里睁着的眼珠露出来。
    hair_ids = [ids[p] for p in ('bangs', 'hair_back', 'hair_side_left',
                                 'hair_side_right', 'ahoge') if p in ids]
    feats, face_holes = pick_face_features(rgb, char, face_m, ~np.isin(labels, hair_ids))
    # 闭眼：母图上没有，程序化画（每只眼的上缘轮廓本来就是上凸弧）
    eye_closed_tex = None
    if 'eye_open' in feats:
        ec, ecolor = make_eye_closed(rgb, feats['eye_open'], char)
        if ec.sum() > 50:
            feats['eye_closed'] = ec
            eye_closed_tex = np.zeros_like(rgb)
            eye_closed_tex[:, :] = ecolor.astype(np.uint8)
            print('eye_closed：程序化生成 %d px，线色 rgb%s'
                  % (int(ec.sum()), tuple(int(v) for v in ecolor)))
    # 五官的像素统一划归「脸」：否则前发/侧发的标号会漏几个像素进眼窝，
    # 那些碎点会跟着头发贴图一起被抠走（纯色分区图上能看见几个青点）。
    for m in feats.values():
        labels[m] = ids['face']
    # 允许的最终部件 = 种子部件（去掉 'hair' 这个中间态）+ 头发三块 + 五官
    order = [p for p in SEEDS.keys() if p != 'hair']
    order = (['hair_back'] + order + ['hair_side_right', 'hair_side_left']
             + ['eye_open', 'eye_closed', 'mouth'])

    meta = {}
    overlay = np.zeros_like(rgb)
    rng = np.random.default_rng(20261009)
    palette = {pid: tuple(int(v) for v in rng.integers(60, 255, 3)) for pid in order}

    def emit(pid, mask, tex=None):
        if mask.sum() < 80:
            print('  ⚠️ %-18s 只有 %d px' % (pid, int(mask.sum())))
        ys, xs = np.where(mask)
        if not len(ys):
            return
        x0, y0 = max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2)
        x1, y1 = min(char.shape[1], int(xs.max()) + 3), min(char.shape[0], int(ys.max()) + 3)
        mm = mask
        if pid != 'face':
            mm = ndimage.binary_dilation(mask, np.ones((3, 3), bool), 1)
        src = rgb if tex is None else tex
        cut = np.dstack([src, (mm * 255).astype(np.uint8)])[y0:y1, x0:x1]
        fn = pid + '.png'
        Image.fromarray(cut).save(os.path.join(parts_dir, fn))
        meta[pid] = dict(file=fn, box_px=[x0, y0, int(x1 - x0), int(y1 - y0)],
                         px=int(mask.sum()), **PART_META.get(pid, {}))
        overlay[mask] = palette[pid]
        print('  %-18s px=%-8d bbox_px=(%4d,%4d) %4dx%-4d' % (
            pid, mask.sum(), x0, y0, x1 - x0, y1 - y0))

    # 脸贴图：把「眼 + 嘴」那块**用肤色填平**（迭代扩散，不是一块死平的色斑）。
    # 为什么必须填：闭眼时 eye_closed 只画一条弧，底下若还是母图睁着的眼珠就穿帮了。
    face_tex = None
    if face_holes is not None and face_holes.any():
        face_tex = rgb.copy()
        skin_px = rgb[skin_mask(rgb, char) & ~face_holes]
        med = np.median(skin_px.reshape(-1, 3), axis=0) if len(skin_px) else np.array([249, 233, 225])
        face_tex[face_holes] = med
        k3 = np.ones((3, 3), np.float32) / 9.0
        for _ in range(14):                      # 向周围肤色扩散，边界不留硬边
            blur = np.dstack([ndimage.convolve(face_tex[:, :, c], k3, mode='nearest')
                              for c in range(3)])
            face_tex[face_holes] = blur[face_holes]
        print('脸贴图：眼/嘴区用肤色填平 %d px' % int(face_holes.sum()))

    for pid in order:
        if pid == 'eye_closed' and eye_closed_tex is not None:
            emit(pid, feats['eye_closed'], tex=eye_closed_tex)
        elif pid in feats:
            emit(pid, feats[pid])
        elif pid == 'face' and pid in ids:
            m = (labels == ids['face'])
            if face_holes is not None:
                m = m | face_holes
            emit(pid, m, tex=face_tex)
        elif pid in ids:
            emit(pid, labels == ids[pid])

    with open(os.path.join(parts_dir, '_parts.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    # 缓存标号图：调后处理规则时不用重跑分水岭（跑一次几十秒）
    np.save(os.path.join(parts_dir, '_labels.npy'), labels)
    COLORS = {
        'hair_back': (150, 150, 150), 'tail': (0, 200, 0), 'leg_left': (255, 140, 0),
        'leg_right': (255, 0, 255), 'torso_up': (255, 0, 0), 'collar': (0, 0, 255),
        'skirt': (0, 180, 180), 'apron': (255, 255, 0), 'arm_right': (140, 60, 0),
        'arm_left': (0, 90, 0), 'ear_right': (255, 0, 128), 'ear_left': (128, 255, 0),
        'face': (255, 220, 180), 'bangs': (0, 255, 255), 'ahoge': (90, 0, 160),
        'eye_open': (255, 255, 255), 'mouth': (0, 0, 0),
        'hair_side_left': (200, 200, 255), 'hair_side_right': (255, 200, 200),
    }
    pure = np.zeros_like(rgb)
    for pid in order:
        if pid in feats:
            pure[feats[pid]] = COLORS.get(pid, (120, 120, 120))
        elif pid in ids:
            pure[labels == ids[pid]] = COLORS.get(pid, (120, 120, 120))
    Image.fromarray(pure).save(os.path.join(build, '_segmap.png'))

    out = Image.blend(Image.fromarray(rgb).convert('RGB'),
                      Image.fromarray(overlay).convert('RGB'), 0.55)
    d = ImageDraw.Draw(out)
    for pid in order:
        if pid in meta:
            bx, by, bw, bh = meta[pid]['box_px']
            d.text((bx + bw // 2, by + bh // 2), pid, fill=(0, 0, 0))
    out.save(os.path.join(build, '_seg_overlay.png'))
    print('✅ 分区覆盖图 -> %s' % os.path.join(build, '_seg_overlay.png'))


if __name__ == '__main__':
    main()
