#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
step2_import.py —— 导入外部「拆件交接包」，替代 step2_parts.py 的分水岭拆件

**为什么换成它**：这套拆件包是专门为 Live2D 绑定做的，质量比自动拆件高一个档次：
  · 27 层，全画布 2048×2048、**保留原画布坐标**（位置精确，不用再量）；
  · 图层分工是手工级的：耳朵分内衬/外层、蓝色内发与后发分开、鞋单独、脖颈单独；
  · 还带**画好的**闭眼睫毛线与两种嘴型（比程序生成的弧线细腻）；
  · 有 `00_未分配像素补齐层` 专门收层间的软边。
  排查结论：这套包用的**就是同一张母图**（角色 bbox 与 8 个随机采样点的 RGB+alpha
  逐字节相同），所以坐标能直接对上。

**产物格式与 step2_parts.py 完全一致**（`build/parts/*.png` + `_parts.json`），
所以 step3_pack.py 一行都不用改。

跑法：
    python tools/pet/pipeline/step2_import.py <交接包目录> <build 目录>
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from skimage.segmentation import watershed

# ---------------------------------------------------------------------------
# 交接包图层 -> rig 部件
#   (交接包文件名前缀, 我的部件 id, z, parent)
# parent 必须是 cat-figure.js 里已定义的变形器（已核对齐全：
#   ahoge armFar armNear bangsSway body earFar earNear headBack headFeat
#   headFront headMid legBack legFront neck skirt tail tailBend waist）
# ---------------------------------------------------------------------------
LAYER_MAP = [
    ('06_左侧后发',           'hair_back_left',  0.6,  'headBack'),
    ('07_右侧后发',           'hair_back_right', 0.5,  'headBack'),
    ('08_左侧蓝色内发',       'hair_blue_left',  0.9,  'headBack'),
    ('09_右侧蓝色内发',       'hair_blue_right', 0.8,  'headBack'),
    ('22_蓝白猫尾巴',         'tail',            1.5,  'tailBend'),
    ('24_右腿与白长袜',       'leg_right',       3.0,  'legFront'),
    ('26_右鞋',               'shoe_right',      3.2,  'legFront'),
    ('23_左腿与白长袜',       'leg_left',        4.0,  'legBack'),
    ('25_左鞋',               'shoe_left',       4.2,  'legBack'),
    ('19_右手臂',             'arm_right',       4.5,  'armFar'),
    ('15_脖颈',               'neck',            4.8,  'waist'),
    ('16_上衣与水手领',       'torso_up',        5.0,  'waist'),
    ('17_领口蝴蝶结',         'bow',             5.1,  'waist'),
    ('21_蓝色裙摆与下摆',     'skirt',           5.2,  'skirt'),
    ('20_围裙与荷叶边',       'apron',           5.4,  'skirt'),
    ('18_左手臂',             'arm_left',        6.0,  'armNear'),
    ('05_右猫耳外层',         'ear_right',       7.0,  'earFar'),
    ('03_右耳内衬',           'ear_inner_right', 7.2,  'earFar'),
    ('11_脸部底层_已清理五官', 'face',           8.0,  'headMid'),
    ('04_左猫耳外层',         'ear_left',       11.0,  'earNear'),
    ('02_左耳内衬',           'ear_inner_left', 11.2,  'earNear'),
    ('10_前发刘海',           'bangs',          13.0,  'bangsSway'),
    ('01_呆毛',               'ahoge',          14.0,  'ahoge'),
]
# 五官：渲染器的眨眼按 id 找 `eye_open` / `eye_closed`，所以**左右眼合成一张**
# （两者的 bbox 不相交，合成后各自位置不变）。
FEAT_MERGE = [
    (['12_左眼完整可替换', '13_右眼完整可替换'], 'eye_open', 8.5),
    (['表情_左眼闭合参考', '表情_右眼闭合参考'], 'eye_closed', 8.5),
    (['14_嘴部完整可替换'], 'mouth', 8.6),
]
# 未分配像素补齐层：**不直接当部件**，但它的像素要按距离分给最近的部件（见 main）
FILL_LAYER = '00_未分配像素补齐层'

# ---------------------------------------------------------------------------
# 袖子从「上衣与水手领」切出来并进手臂 —— **不切的话抬手会「断手」**
#
# 交接包是按「衣服 vs 露出的皮肤」分的，所以**袖子留在上衣层里，手臂层只有前臂和手**。
# 这在 Live2D 里没问题（绑定时建模师会把袖子跟着手臂一起变形），
# 但在我们这个 rig 里：`armNear`/`armFar` 只转 parent 指向它的部件 —— 也就是只转前臂。
# 实测 `cat-figure.js` 里招手时 `aN → 108°`，于是**前臂飞上去、袖子留在身上 = 断手**。
#
# 切法（尽量少假设）：
#   1. 在上衣层内部按**描边**（黑帽变换）切成小块 —— 袖子在图上本来就有自己的接缝线；
#   2. 质心落在「袖区」盒子里的块 = 袖子；
#   3. 描边像素按**最近邻**分给两侧（这样袖子的轮廓线会跟着袖子走，不会留在上衣上）。
# 配合 cat-figure.js 里把手臂的变形器换成 `hinge`（绕肩点、按 y 衰减）：
# 袖子**上半截几乎不动**（永远咬在肩上 → 不露肩窝 → **不需要补画**），
# 下半截跟着手臂走 → 既不「断手」也不露洞。
# ---------------------------------------------------------------------------
SLEEVE_BOX = {'arm_left': (764, 1100, 899, 1400), 'arm_right': (1150, 1100, 1306, 1400)}
# 左右分界：取两个袖区盒子相对边的中点（母版 x 899 与 1150 之间）
SLEEVE_SPLIT_X = 1025


def cut_sleeves(rgb, mask_torso, shape):
    """从上衣层里切出左右袖子。返回 (袖子掩码, 剩下的上衣掩码)。"""
    g = rgb.astype(np.float32).mean(axis=2)
    bh = ndimage.grey_closing(g, size=(9, 9)) - g
    lines = (bh > 10) & mask_torso
    body = mask_torso & ~ndimage.binary_dilation(lines, np.ones((3, 3), bool), 1)
    lab, n = ndimage.label(body, np.ones((3, 3), int))
    if not n:
        return None, mask_torso
    # 描边像素按最近邻归属到某个块，避免袖子丢了轮廓、上衣留下一条袖缝
    _, idx = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    filled = lab[idx[0], idx[1]]
    sleeve = np.zeros(shape, bool)
    for key, (x0, y0, x1, y1) in SLEEVE_BOX.items():
        hits = []
        for k in range(1, n + 1):
            ys, xs = np.where(lab == k)
            # ⚠️ 必须卡**最小块面积**：不卡的话，上衣层里那些小的碎片（衣领边、胸口的
            #    零碎块）只要质心落进袖区就会被当成袖子搬走 —— 实测不加这条会抓到
            #    左 37 块 / 右 28 块，把上衣拆得七零八落。
            if len(ys) < 1500:
                continue
            cx, cy = xs.mean(), ys.mean()
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                hits.append(k)
        got = np.isin(filled, hits) & mask_torso
        print('  %s 从「上衣与水手领」切出 %d px（%d 块）' % (key, got.sum(), len(hits)))
        sleeve |= got
    return sleeve, mask_torso & ~sleeve


def find_layer(pkg, key, layers_dir='layers'):
    for sub in (layers_dir, 'face_expression_options'):
        d = os.path.join(pkg, sub)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.startswith(key) and f.lower().endswith('.png'):
                return os.path.join(d, f)
    return None


def load_layer(pkg, keys, layers_dir='layers'):
    """把一组图层合成一份 (rgb, mask)。后一张只补进自己新增的像素，不覆盖前一张颜色。"""
    rgb = mask = None
    for k in (keys if isinstance(keys, list) else [keys]):
        p = find_layer(pkg, k, layers_dir)
        if not p:
            raise SystemExit('❌ 交接包里找不到：%s' % k)
        a = np.asarray(Image.open(p).convert('RGBA'))
        m = a[:, :, 3] > 100
        if rgb is None:
            rgb, mask = a[:, :, :3].copy(), m
        else:
            new = m & ~mask
            rgb[new] = a[:, :, :3][new]
            mask |= m
    return rgb, mask


def assign_orphans(orphan, items, rgb_master, char):
    """把「未分配像素」分给部件 —— **用描边当墙做长区域生长（watershed）**。

    ⚠️ 试过两种更简单的办法，都不行：
      · **按空间距离**分：手和尾巴挨着，**手的可见像素有一半本来就在补齐层里**
        （实测手区肤色 21569px：手臂层 9421、补齐层 9108），按距离分就把手送给了尾巴 ——
        星宝的原话「**尾巴和一部分的右手绑在一起了**」，尾巴里的肤色从 825 涨到 4169。
      · **加颜色项**：也没用 —— **肤色 (249,233,225) 和尾巴的白 (250,250,250) 在 RGB 上
        最多差 25 级**，根本分不开（实测反而涨到 4328）。
    正解是**连通性**：原图在手的边缘画了轮廓线，那条线就是手与尾巴的真实分界。
    于是复用 `step2_parts` 那套 —— 描边当**墙**，部件的掩码当种子，
    在被分配区域里长区域生长：只有不被描边挡住的部分才会归到某个部件。
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from step2_parts import edge_elevation, line_mask      # 同一套「描边当墙」，不重复实现

    area = char | orphan
    lines = line_mask(rgb_master.astype(np.int16), area)
    elev = edge_elevation(rgb_master.astype(np.int16), area, lines)
    markers = np.zeros(orphan.shape, np.int32)
    for i, it in enumerate(items, start=1):
        markers[it[2]] = i
    lab = watershed(elev, markers, mask=area)              # 种子像素保持自己的标号
    return lab


def despeckle(items, min_px=250):
    """把各部件里的**小岛屿**（< min_px）摘下来，返回它们的并集。

    为什么要它：`arm_right` 贴图里有 126px 的孤立小块（实测 @(1311,1553)），
    渲染出来就是「右手多出来一个组件」。这些块多是层间抗锯齿或补齐分配留下的。
    1~7px 的小点无所谓，所以阈值取 250px，避免把眼白/嘴这种真小件误伤。
    摘下来的像素交给 caller 统一按「颜色+距离」重新分配。
    """
    dropped = np.zeros_like(items[0][2])
    for it in items:
        mask = it[2]
        if not mask.any():
            continue
        lab, n = ndimage.label(mask, np.ones((3, 3), int))
        if n <= 1:
            continue
        sz = ndimage.sum(mask, lab, range(1, n + 1))
        keep = np.isin(lab, (np.where(sz >= min_px)[0] + 1))
        small = mask & ~keep
        if small.any():
            it[2] = mask & keep
            dropped |= small
    return dropped


def main():
    pkg, build = sys.argv[1], sys.argv[2]
    layers_dir = 'layers'
    if '--layers' in sys.argv:
        layers_dir = sys.argv[sys.argv.index('--layers') + 1]
    print('用图层目录：%s' % layers_dir)
    parts_dir = os.path.join(build, 'parts')
    os.makedirs(parts_dir, exist_ok=True)
    H = W = 2048
    master_path = os.path.join(build, 'master-keyed.png')
    rgb_master = np.asarray(Image.open(master_path).convert('RGB'))
    char_master = np.asarray(Image.open(master_path))[:, :, 3] > 100

    # ---- 1. 读出所有部件（先留在内存里，最后统一落盘）----
    items = []          # (pid, rgb, mask, z, parent, is_feat)
    for key, pid, z, parent in LAYER_MAP:
        rgb, mask = load_layer(pkg, key, layers_dir)
        items.append([pid, rgb, mask, z, parent, False])
    for keys, pid, z in FEAT_MERGE:
        rgb, mask = load_layer(pkg, keys, layers_dir)
        items.append([pid, rgb, mask, z, 'headFeat', True])

    # ---- 1.5 把袖子从上衣层切进手臂（不切抬手就「断手」，见 cut_sleeves 注释）----
    ti = next((i for i, it in enumerate(items) if it[0] == 'torso_up'), None)
    if ti is not None:
        rgb_t, mask_t = items[ti][1], items[ti][2]
        sleeve, rest = cut_sleeves(rgb_t, mask_t, (H, W))
        if sleeve is not None and sleeve.any():
            items[ti][2] = rest
            # ⚠️ 按 x **切两半**分给左右臂，不能按「落在袖区盒子内」分 ——
            #    有袖子块会伸出盒子，那样两边都不要它，像素就**凭空丢了**
            #    （实测漏掉 7764 px，自检直接报出来）。
            xs_idx = np.arange(W)[None, :]
            for pid, left in (('arm_left', True), ('arm_right', False)):
                part = sleeve & ((xs_idx < SLEEVE_SPLIT_X) if left else (xs_idx >= SLEEVE_SPLIT_X))
                if not part.any():
                    continue
                ai = next((i for i, it in enumerate(items) if it[0] == pid), None)
                if ai is None:
                    continue
                items[ai][2] = items[ai][2] | part
                items[ai][1][part] = rgb_t[part]      # 颜色沿用原图，不改画

    labels = np.zeros((H, W), np.int32)
    for i, (pid, _rgb, mask, *_rest) in enumerate(items, start=1):
        labels[mask] = i
    cover = labels > 0

    # ---- 2. 补齐层的像素按距离分给最近的部件 ----
    # 交接包文档说这层「只用于中性姿态检查、不可单独绑定」，但实测它装了
    # **27 万像素（角色的 17%）** —— 是层与层之间的半透明/抗锯齿软边，不是零星边角，
    # 直接丢掉会让角色的 17% 变透明。而当静态层留着也不行：部件一动就会露出
    # 不跟着动的残影。正解是**按距离把每个像素分给最近的部件**。
    fill_rgb, fill_mask = load_layer(pkg, FILL_LAYER, layers_dir)
    dropped = despeckle(items)            # 先摘掉各部件的小岛屿（块数会因此变干净）
    orphan = (fill_mask & ~cover) | dropped
    if orphan.any():
        print('\n未分配像素：补齐层 + 小岛屿 共 %d px（角色的 %.1f%%）'
              % (int(orphan.sum()), 100 * orphan.sum() / cover.sum()))
        owner = assign_orphans(orphan, items, rgb_master, char_master)
        for i, it in enumerate(items, start=1):
            add = orphan & (owner == i)
            c = int(add.sum())
            if not c:
                continue
            it[2] = it[2] | add
            it[1][add] = fill_rgb[add]        # 软边用补齐层自己的颜色（与母图一致）
        for i, it in enumerate(items, start=1):
            print('  %-16s +%d px' % (it[0], int((orphan & (owner == i)).sum())))
        cover = cover | orphan

    # ---- 4. 尾巴里不该有肤色像素：那是右手被分错了，移交回手臂 ----
    # 为什么还要这一条：描边在手的边缘有缺口，上面的 watershed 挡住了大部分、没挡全
    # （实测尾巴里的肤色从 4169 降到 2899，仍高于包自带的 825）。
    # 这不是通用规则、而是**按语义的定向修正**：这个形象里只有尾巴与右手在空间上重叠，
    # 而尾巴是白/蓝的，出现肤色就一定是从手上漏过来的。
    ti = next((i for i, it in enumerate(items) if it[0] == 'tail'), None)
    ai = next((i for i, it in enumerate(items) if it[0] == 'arm_right'), None)
    if ti is not None and ai is not None:
        # ⚠️ 肤色判据要用**暖色特征（R 明显大于 B）**，不能只用「离肤色近」：
        #    尾巴的白 (250,250,250) 与肤色 (249,233,225) 每个通道都差不到 26，
        #    只用容差会把**整条尾巴的白**当成肤色搬走（实测一次搬了 18588px，把尾巴掏空）。
        rm = rgb_master.astype(int)
        skin = (rm[:, :, 0] > 225) & ((rm[:, :, 0] - rm[:, :, 2]) > 14)
        moved = items[ti][2] & skin
        if moved.any():
            items[ti][2] = items[ti][2] & ~moved
            items[ai][2] = items[ai][2] | moved
            print('尾巴里的肤色像素 %d px 移交回右手' % int(moved.sum()))

    # ---- 3. 落盘 ----
    meta = {}
    print('\n%-18s %-10s %s' % ('部件', 'px', 'box_px'))
    for pid, rgb, mask, z, parent, is_feat in items:
        ys, xs = np.where(mask)
        if not len(ys):
            print('  ⚠️ %-16s 空，跳过' % pid)
            continue
        x0, y0 = max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2)
        x1, y1 = min(W, int(xs.max()) + 3), min(H, int(ys.max()) + 3)
        fn = pid + '.png'
        Image.fromarray(np.dstack([rgb, (mask * 255).astype(np.uint8)])[y0:y1, x0:x1]).save(
            os.path.join(parts_dir, fn))
        ent = dict(file=fn, box_px=[x0, y0, int(x1 - x0), int(y1 - y0)],
                   px=int(mask.sum()), z=z, parent=parent)
        if is_feat:
            ent['sub'] = 'feat'
        meta[pid] = ent
        print('  %-16s %-10d (%4d,%4d) %4dx%-4d' % (pid, mask.sum(), x0, y0, x1 - x0, y1 - y0))

    # ---- 4. 自检：并集必须刚好覆盖角色 ----
    master = os.path.join(build, 'master-keyed.png')
    if os.path.exists(master):
        ch = np.asarray(Image.open(master))[:, :, 3] > 100
        miss, extra = int((ch & ~cover).sum()), int((cover & ~ch).sum())
        print('\n自检：母图角色 %d px；部件并集 %d px' % (ch.sum(), cover.sum()))
        print('      漏掉 %d px（%.4f%%）   多出 %d px' % (miss, 100 * miss / ch.sum(), extra))
        if miss > ch.sum() * 0.005:
            print('      ⚠️ 漏得偏多，检查 LAYER_MAP')

    json.dump(meta, open(os.path.join(parts_dir, '_parts.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('\n✅ %d 个部件 -> %s' % (len(meta), os.path.join(parts_dir, '_parts.json')))


if __name__ == '__main__':
    main()
