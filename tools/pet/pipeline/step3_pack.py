#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
step3_pack.py —— 把拆好的部件打包成形象包（算 rig box / pivots / view，写 model.json）

**为什么必须重新量**：新母版是**二头身**、姿势与旧形象包不同，旧包的
`S=0.1847 X0=736 FEET=1470` 和它那套 pivots **不能照抄**。

坐标换算（与 `renderer/pet/cat-figure.js` / `rig.js` 一致）：
    U(x) = 128 + (x - X0) * S        母版像素 x -> rig 单位
    V(y) = 256 - (FEET - y) * S      母版像素 y -> rig 单位
    ➜ 母版 x = X0 + (u - 128) / S ；母版 y = FEET - (256 - v) / S

约定（从 rig.js / cat-figure.js 反推，都验证过）：
  · `parts[].box = [x, y, w, h]` 是 **rig 单位**；**y 是 box 的顶边**，
    网格从 y **朝下**铺到 y+h（这个 rig 的 v 是**向下增大**的：旧包 bangs
    box y=32.7 对应母版顶边 y=261，底边 32.7+65.2=97.9 对应母版 y=614 ✓）。
  · 贴图像素数 = box 尺寸 ÷ S（部件贴图是母版原尺度，不用缩放）。
  · `deformers` **不在 model.json 里** —— 变形器定义在 cat-figure.js，
    model.json 只记 `parent`（变形器链的起点）。
  · `grid = [nx, ny]` 是细分网格，约 8 个 rig 单位一格（旧包 bangs 67.78 宽用 8 格）。

跑法：
    python tools/pet/pipeline/step3_pack.py assets/pet/cat/build cat
产物：
    assets/pet/<skin>/{model.json, tex/, feat/}
    assets/pet/<skin>/build/_pack_preview.png    静置合成预览（肉眼比对母图）
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# pivots：**用母版像素写**，方便对着 build/_master_grid.png 核对；脚本自己换算成 rig 单位。
# 每个值都写清楚「这是哪个关节」，将来对不上时一眼知道该调哪一行。
# ---------------------------------------------------------------------------
PIVOTS_PX = {
    'body':     ('双脚之间的身体轴',        (962, 2002)),
    'waist':    ('腰 = 裙腰上沿',           (962, 1350)),
    'neck':     ('脖子 = 领子顶',           (962, 1070)),
    'armNear':  ('左臂肩点（观察者左）',     (812, 1212)),
    'armFar':   ('右臂肩点（观察者右）',     (1172, 1218)),
    'legBack':  ('左髋（观察者左）',         (900, 1620)),
    'legFront': ('右髋（观察者右）',         (1110, 1620)),
    'tail':     ('尾根 = 身体右侧',          (1150, 1450)),
    'earNear':  ('左耳根',                  (660, 540)),
    'earFar':   ('右耳根',                  (1380, 560)),
    'ahoge':    ('呆毛根',                  (975, 330)),
    'head':     ('头 = 脸中心',              (962, 883)),
}
# 部件顺序 = z 序（后 → 前），与 PART_META 一致；这里再写一份是为了让本脚本自洽
def build_model(build_dir, skin, root):
    meta = json.load(open(os.path.join(build_dir, 'parts', '_parts.json'), encoding='utf-8'))
    keyed = os.path.join(build_dir, 'master-keyed.png')
    a = np.asarray(Image.open(keyed))
    char = a[:, :, 3] > 100
    ys, xs = np.where(char)
    # 角色 bbox —— 用它定 S / X0 / FEET
    cx0, cx1, cy0, cy1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    # 身体轴取脸的中心（脸是对称的，比整体 bbox 中心可靠 —— 整体 bbox 被尾巴拉偏）
    fx0 = meta['face']['box_px']
    body_axis = fx0[0] + fx0[2] / 2.0
    # S：让「头顶 -> 脚底」正好占 256 个 rig 单位（脚底 v=256，头顶 v=0）
    S = 256.0 / (cy1 - cy0)
    X0 = body_axis
    FEET = cy1
    print('角色 bbox px: x %d..%d  y %d..%d  (%dx%d)' % (cx0, cx1, cy0, cy1, cx1 - cx0 + 1, cy1 - cy0 + 1))
    print('S=%.5f  X0=%.1f  FEET=%d   (1 rig 单位 = %.2f 母版 px)' % (S, X0, FEET, 1 / S))

    U = lambda x: 128.0 + (x - X0) * S
    V = lambda y: 256.0 - (FEET - y) * S

    def grid_for(w, h):
        return [int(min(12, max(2, round(w / 8.0)))), int(min(12, max(2, round(h / 8.0))))]

    parts, feats = [], {}
    for pid, m in meta.items():
        x, y, w, h = m['box_px']
        box = [round(U(x), 2), round(V(y), 2), round(w * S, 3), round(h * S, 3)]
        ent = dict(id=pid, tex=pid, z=m['z'], parent=m['parent'],
                   grid=grid_for(box[2], box[3]), box=box)
        if m.get('sub') == 'feat':
            feats[pid] = ent
        else:
            parts.append(ent)
    parts.sort(key=lambda p: p['z'])

    pivots = {}
    for k, (desc, (px, py)) in PIVOTS_PX.items():
        pivots[k] = [round(U(px), 2), round(V(py), 2)]
        print('  %-9s %-20s px(%4d,%4d) -> rig(%7.2f, %7.2f)' % (k, desc, px, py, pivots[k][0], pivots[k][1]))

    view = [52.0, -12.0, 240.0, 276.0]
    # 自检：所有部件都得落在 view 里，否则会被裁掉
    bad = []
    for p in parts + list(feats.values()):
        bx, by, bw, bh = p['box']
        if bx < view[0] - 1 or bx + bw > view[2] + 1 or by < view[1] - 1 or by + bh > view[3] + 1:
            bad.append('%s box(%s) 超出 view' % (p['id'], p['box']))
    for b in bad:
        print('  ⚠️ ' + b)

    model = dict(units=dict(S=round(S, 6), X0=round(X0, 3), FEET=int(FEET), DS=0.6, featDS=1),
                 pivots=pivots, parts=parts, feat=feats, view=view,
                 source='assets/pet/%s/source/master-raw.png' % skin,
                 builtBy='tools/pet/pipeline/step3_pack.py')
    return model, S, X0, FEET, meta


def slim_png(path, step=8):
    """贴图瘦身：alpha 量化到 step 阶 + 全透明处 RGB 清零 + PNG optimize。

    **为什么需要**：AI 出的图 alpha 边缘带噪点，PNG 压不动 —— 实测整包 6.63 MB，
    而旧形象包只有 0.83 MB。量化 alpha 后 **省 57%**（→ 2.86 MB），
    8 / 16 / 32 阶结果完全一样（说明这一步省的全是压缩开销，不是画质）。
    视觉上看不出差别：alpha 的 1/255 级别抖动本来就在噪声范围里。
    """
    a = np.asarray(Image.open(path).convert('RGBA'))
    al = a[:, :, 3]
    al2 = (((al.astype(np.int16) + step // 2) // step) * step).clip(0, 255).astype(np.uint8)
    rgb = a[:, :, :3].copy()
    rgb[al2 == 0] = 0
    Image.fromarray(np.dstack([rgb, al2]), 'RGBA').save(path, optimize=True)


def write_pack(model, build_dir, pet_dir, meta, S, X0, FEET):
    os.makedirs(os.path.join(pet_dir, 'tex'), exist_ok=True)
    os.makedirs(os.path.join(pet_dir, 'feat'), exist_ok=True)
    before = after = 0
    for p in model['parts']:
        dst = os.path.join(pet_dir, 'tex', p['tex'] + '.png')
        shutil.copyfile(os.path.join(build_dir, 'parts', p['tex'] + '.png'), dst)
        before += os.path.getsize(dst)
        slim_png(dst)
        after += os.path.getsize(dst)
    for pid in model['feat']:
        dst = os.path.join(pet_dir, 'feat', pid + '.png')
        shutil.copyfile(os.path.join(build_dir, 'parts', pid + '.png'), dst)
        before += os.path.getsize(dst)
        slim_png(dst)
        after += os.path.getsize(dst)
    json.dump(model, open(os.path.join(pet_dir, 'model.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('✅ model.json + tex/ + feat/ -> %s' % pet_dir)
    print('   贴图瘦身：%.2f MB -> %.2f MB（省 %.0f%%）'
          % (before / 1048576.0, after / 1048576.0, 100 * (1 - after / max(1, before))))


def preview(build_dir, pet_dir, model, scale=1.0):
    """静置合成预览：按 z 序把贴图贴到各自的 rig box 上，缩到 view 尺寸。

    这不是给用户看的成品，是**给工程师比对母图用的**：贴出来的东西应该和母图长得一样。
    对不上就说明 box / z 序错了（pivots 是动画用的，静置看不出来）。
    """
    v = model['view']
    vw, vh = int(round((v[2] - v[0]) * scale)), int(round((v[3] - v[1]) * scale))
    U = lambda x: 128.0 + (x - model['units']['X0']) * model['units']['S']
    V = lambda y: 256.0 - (model['units']['FEET'] - y) * model['units']['S']
    # rig -> 预览画布像素。**v 越大在屏幕上越靠下**（rig.js 的顶点着色器：
    # gl_Position.y = 1 - n.y*2，所以 view.y0 在屏幕顶、view.y1 在屏幕底；
    # 脚底 v=256 落在 view 底 276 之上 20 单位，正是 cat-figure.js 的 FEET_PAD）。
    # ⚠️ 这里写反过一次：(v[3]-vv) 得到的是「越大越靠上」，整张预览会压成一条线。
    def to_canvas(u, vv):
        return ((u - v[0]) / (v[2] - v[0]) * vw, (vv - v[1]) / (v[3] - v[1]) * vh)
    canvas = Image.new('RGBA', (vw, vh), (255, 255, 255, 255))
    items = [(m['z'], m, 'tex') for m in model['parts']] + \
            [(m['z'], m, 'feat') for m in model['feat'].values()]
    for z, m, sub in sorted(items, key=lambda t: t[0]):
        src = Image.open(os.path.join(pet_dir, sub, m['tex'] + '.png')).convert('RGBA')
        bx, by, bw, bh = m['box']
        # 顶边是 by，底边是 by + bh（v 向下增大）
        x0c, y0c = to_canvas(bx, by)               # 左上
        x1c, y1c = to_canvas(bx + bw, by + bh)     # 右下
        w = max(1, int(round(x1c - x0c)))
        h = max(1, int(round(y1c - y0c)))
        canvas.alpha_composite(src.resize((w, h), Image.LANCZOS),
                               (int(round(x0c)), int(round(y0c))))
    out = os.path.join(build_dir, '_pack_preview.png')
    canvas.save(out)
    print('✅ 静置合成预览 -> %s  (%dx%d)' % (out, vw, vh))


def main():
    build_dir, skin = sys.argv[1], sys.argv[2]
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    pet_dir = os.path.join(root, 'assets', 'pet', skin)
    print('形象包：%s' % pet_dir)
    model, S, X0, FEET, meta = build_model(build_dir, skin, root)
    write_pack(model, build_dir, pet_dir, meta, S, X0, FEET)
    preview(build_dir, pet_dir, model, scale=2.0)
    print('部件 %d 个 + 五官 %d 张' % (len(model['parts']), len(model['feat'])))


if __name__ == '__main__':
    main()
