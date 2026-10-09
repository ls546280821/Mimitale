# -*- coding: utf-8 -*-
"""
convert_whale.py —— Coopanion whale 形象包 -> Mimitale rig 形象包。

做三件事：
  A. model.json 改造
     1. pivots: 加 earNear/earFar（从 finNear/finFar 复制），保留 fin* 让旧 figure 也能跑
     2. parts[].parent: finNear->earNear, finFar->earFar（Mimitale 的 figure 只认 ear*）
     3. feat: Coopanion 的坐标表 -> Mimitale 的 {id,tex,z,parent,grid,box} 结构
        并**预先合成** eye_open（ball+iris+lash 叠好，两张眼各占一块）+ eye_closed
  B. 生成五官合成贴图到 feat/：eye_open.png / eye_closed.png / mouth.png
  C. 输出报告

母图像素 -> rig 单位：  U(x) = 128 + (x - X0) * S ;  V(y) = 256 - (FEET - y) * S
box 的 rig 单位宽高 w_rig = w_px / S * DS  （与 parts 同一套，已核对一致）
"""
import os, json, shutil
import numpy as np
from PIL import Image

BASE = r"E:\工作\Mimitale"
DST = os.path.join(BASE, "assets", "pet", "whale")
FEAT = os.path.join(DST, "feat")
TEX = os.path.join(DST, "tex")
SRC = os.path.join(DST, "source")
OUTDIR = os.path.join(BASE, ".workbuddy", "scratch-pet-src")
os.makedirs(OUTDIR, exist_ok=True)

# ⚠️ 一定要从 **source/model-original.json** 读，不能读 DST/model.json。
#    读后者是「在成品上再改一次」：pivots 会重复添加、id 会重复重映射
#    （第二次跑 REMAP_ID 时 arm_left 已经不在表里了，反而侥幸不炸，
#      但 DROP_PARTS 那步的 parts 已经被删过一次 → 输出不可重复）。
#    从 source 读 = 每次都是「原始 → 成品」，这才叫幂等（重跑结果逐字节相同）。
SRC_MODEL = os.path.join(SRC, "model-original.json")
if os.path.exists(SRC_MODEL):
    m = json.load(open(SRC_MODEL, encoding="utf-8"))
    L_SRC = "source/model-original.json（原始，幂等入口）"
else:
    m = json.load(open(os.path.join(DST, "model.json"), encoding="utf-8"))
    L_SRC = "model.json（⚠️ 没找到 source/ 原件，在成品上改 —— 重跑会叠加！）"

# 顶层留一份原始快照的浅拷贝，供后面「首次运行时落盘 source/」用
u = m["units"]
S, X0, FEET, DS = u["S"], u["X0"], u["FEET"], u["DS"]


def U(x): return 128 + (x - X0) * S
def V(y): return 256 - (FEET - y) * S


log = []
def L(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    log.append(s)


L("=== A. model.json 改造 ===")
L("读取:", L_SRC)

# --- 1. pivots：把 fin* 复制成 ear* ---
pv = m["pivots"]
if "finNear" in pv and "earNear" not in pv:
    pv["earNear"] = list(pv["finNear"])
if "finFar" in pv and "earFar" not in pv:
    pv["earFar"] = list(pv["finFar"])
L("pivots:", list(pv.keys()))

# --- 2. parts[].parent 重映射 ---
REMAP_PARENT = {"finNear": "earNear", "finFar": "earFar", "hairSway": "headBack", "skirtSit": "skirt"}
for p in m["parts"]:
    old = p.get("parent")
    if old in REMAP_PARENT:
        p["parent"] = REMAP_PARENT[old]
        L(f'  parent: {p["id"]}: {old} -> {p["parent"]}')

# --- 2b. parts[].id 重映射：Mimitale 的 figure 按 id 找 rect（rectOf('arm_left') 等）---
#      whale 用的是 arm_near/arm_far/leg_back/leg_front，改成 Mimitale 的左手右腿命名。
#      ⚠️ 只改 id，tex **不动**（贴图文件名保持原样，拷贝即可）。
REMAP_ID = {
    "arm_near": "arm_left",     # 近侧手 = 画面左（与 cat 的 arm_left 同义：armNear）
    "arm_far":  "arm_right",
    "leg_back": "leg_left",
    "leg_front": "leg_right",
}
for p in m["parts"]:
    if p["id"] in REMAP_ID:
        L(f'  id: {p["id"]} -> {REMAP_ID[p["id"]]} (tex 仍为 {p["tex"]})')
        p["id"] = REMAP_ID[p["id"]]

# --- 2c. 丢掉「Mimitale 没有对应状态」的部件（**这条是「形象重叠」的根因**）---
#
# Coopanion 的鲸鱼有**站姿 / 坐姿两套下半身**，靠 per-part alpha 二选一
# （figure.js:558-560）：
#
#     st.alpha.skirt            = 1 - sitIn     # 站姿裙：站着 1，坐下 0
#     st.alpha.skirt_sit        = sitIn         # 坐姿裙：站着 0，坐下 1
#     st.alpha.waist_bow_front  = 1 - sitIn
#     st.alpha.waist_bow_sit_front = sitIn
#
# Mimitale 的 rig **支持** st.alpha（rig.js:208 读 st.alpha?.[p.id] ?? p.alpha ?? 1），
# cat 的眨眼对就是这么做的 —— 但**猫没有坐姿**，所以 cat-figure 从不给这些 id 设 alpha。
# 结果：坐姿那两件 alpha 恒为 1，**和站姿的裙 / 蝴蝶结同时画出来 → 重叠**
# （星宝 2026-10-09 报的「deepseek 的形象不对 重叠了」就是这个）。
#
# Mimitale 的桌宠**没有「坐下」这个状态**（不坐椅子、不坐地上），所以最干净的做法是
# **转换时就把这些件删掉** —— 而不是给 renderer 加一套永远算不出值的 alpha 逻辑。
#
# 三个都是同一个成因：**Coopanion 靠运行时 alpha 决定「这一刻画不画」，
# 而 Mimitale 没有驱动它们的那个状态**，于是全部常驻。
DROP_PARTS = {
    # 坐姿下半身（坐姿专用，Mimitale 永远用不到）
    "skirt_sit": "坐姿裙（比站姿裙宽 1.5 倍，和站姿裙同时画 = 重叠）",
    "waist_bow_sit_front": "坐姿蝴蝶结（同上）",
    # 眼睑褶：Coopanion 用 creaseA 跟着「眼睛睁开程度」淡入淡出（figure.js:596），
    # 是「困了/半眯」时的上眼皮褶线。Mimitale 的眨眼是两张贴图交叉切，
    # **没有「睁到什么程度」这个连续量**，所以它只会常驻 → 正常睁眼也挂着两道褶。
    "eye_creases": "眼睑褶（没有驱动它的「睁眼程度」连续量，常驻会一直挂在眼睛上）",
}
before_n = len(m["parts"])
m["parts"] = [p for p in m["parts"] if p["id"] not in DROP_PARTS]
for pid, why in DROP_PARTS.items():
    if pid not in {p["id"] for p in m["parts"]}:
        L(f"  drop: {pid} —— {why}")
L(f"  parts: {before_n} -> {len(m['parts'])}")

# 变形器（deformer）不在这份 model.json 里 —— 它写死在 renderer/pet/cat-figure.js：
#   skirtSit: { kind: 'warp', parent: 'body', rect: rectOf('skirt_sit') }
# 被删的部件名如果在 figure 里有对应变形器，那个 rectOf() 会取到 undefined。
# 目前 cat-figure 的 DEF 里**没有** skirtSit / creases 这两个（那是鲸鱼专有），
# 所以不用动 figure。这里只把这件事记下来，将来往 figure 里加时要留意。

# --- 3. feat：合成 eye_open / eye_closed / mouth ---
feat_src = m["feat"]
eyes = feat_src["eyes"]
sprites = feat_src["sprites"]

def load_feat_img(name):
    p = os.path.join(FEAT, name + ".png")
    if not os.path.exists(p):
        p = os.path.join(TEX, name + ".png")
    return Image.open(p).convert("RGBA")


def union_box(boxes):
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    return [x0, y0, x1, y1]


def make_eye_composite(which_pair):
    """把 ball+iris+lash 合成一张（两眼水平摆放），返回 (图, 母图 bbox)。"""
    parts_imgs = []
    boxes = []
    for k in which_pair:                      # eyeL, eyeR
        e = eyes[k]
        # 画布取该眼的 ball／lash 并集
        bb = union_box([e["ball"], e["lash"]])
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        for nm in ("ball", "iris", "lash"):
            if nm not in e:
                continue
            img = load_feat_img(f"{k}_{nm}")
            r = e[nm]
            canvas.alpha_composite(img, (r[0] - bb[0], r[1] - bb[1]))
        parts_imgs.append((canvas, bb))
        boxes.append(bb)
    # 两眼并排到一张（左右排布保持相对 x）
    allb = union_box(boxes)
    W, H = allb[2] - allb[0], allb[3] - allb[1]
    sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for img, bb in parts_imgs:
        sheet.alpha_composite(img, (bb[0] - allb[0], bb[1] - allb[1]))
    return sheet, allb


def make_closed_from_sleep():
    """闭眼：用 sleep_eyeL / sleep_eyeR 合成。"""
    return make_eye_composite_pair("sleep_eyeL", "sleep_eyeR")


def make_eye_composite_pair(nL, nR):
    imgs, boxes = [], []
    for n in (nL, nR):
        r = sprites[n]
        img = load_feat_img(n)
        boxes.append(list(r)); imgs.append(img)
    allb = union_box(boxes)
    W, H = allb[2] - allb[0], allb[3] - allb[1]
    sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for img, bb in zip(imgs, boxes):
        sheet.alpha_composite(img, (bb[0] - allb[0], bb[1] - allb[1]))
    return sheet, allb


sheet_open, bb_open = make_eye_composite(["eyeL", "eyeR"])
sheet_closed, bb_closed = make_closed_from_sleep()
sheet_open.save(os.path.join(FEAT, "eye_open.png"))
sheet_closed.save(os.path.join(FEAT, "eye_closed.png"))
L("eye_open 合成:", sheet_open.size, "母图bbox", bb_open)
L("eye_closed 合成:", sheet_closed.size, "母图bbox", bb_closed)

# 嘴：neutral_mouth 作为默认嘴
mouth_r = sprites["neutral_mouth"]
mouth_img = load_feat_img("neutral_mouth")
mouth_img.save(os.path.join(FEAT, "mouth.png"))
L("mouth:", mouth_img.size, mouth_r)


def feat_entry(pid, tex, z, parent, pxbox):
    """
    母图像素 bbox -> Mimitale feat 条目（rig 单位）。

    ⚠️ feat 的换算和 parts **不一样**，这是从 Coopanion figure.js:136 反推出来的：
        parts:  box.w = px_w / S * DS     （贴图按 DS 烘焙过）
        feat :  box.w = px_w * S          （直接用母图像素，纹理是 1 master px = 1 texel）
      公式写错会让 box 宽出十几倍（踩过：eye_open 算出 1143 rig，而 view 只有 280 宽）。

    ⚠️⚠️ y 取**顶边** V(y_top)，不是底边 V(y_bottom)。
      Mimitale 的 box 是 (x, y_top, w, h)，而 **V() 是向下增长的**
      （母图 y 越大 → V 越大 → 越靠下）。所以 box 原点取母图的**上边**（较小的 y）。
      写反会让 feat **整体向下偏移整整一个自身高度**。
      踩过（2026-10-09 星宝报「眼睛位置不对」）：eye_open 的 y 写成 V(748 底边)=139.15，
      正确是 V(609 顶边)=112.74 —— 差 26.41 = 眼睛自身高度，于是眼睛被推到下巴/发际线上。
      对参照：cat 的 feat 同口径（`step3_pack.py:83` 就是 `box=[U(x), V(y), w*S, h*S]`，
      x/y 取的是 `box_px` 的左上角）。
    """
    x, y, x1, y1 = pxbox
    rx, ry = U(x), V(y)                   # box 原点 = 母图**左上角**（V 向下增长，取小 y）
    w_rig = (x1 - x) * S
    h_rig = (y1 - y) * S
    gx = max(2, min(12, round(w_rig / 1.8)))    # feat 纹理 1px≈1texel，网格要密一点
    gy = max(2, min(12, round(h_rig / 1.8)))
    return {"id": pid, "tex": tex, "z": z, "parent": parent,
            "grid": [gx, gy], "box": [round(rx, 3), round(ry, 3), round(w_rig, 3), round(h_rig, 3)]}


m["feat"] = {
    "eye_open":   feat_entry("eye_open", "eye_open", 8.5, "headFeat", bb_open),
    "eye_closed": feat_entry("eye_closed", "eye_closed", 8.5, "headFeat", bb_closed),
    "mouth":      feat_entry("mouth", "mouth", 8.6, "headFeat", mouth_r),
}
L("feat 转换完成:")
for k, v in m["feat"].items():
    L(f"  {k}: box={v['box']} grid={v['grid']}")

# --- 3b. 清掉「已不再被引用」的贴图 ---
#
# DROP_PARTS 删了部件，但 tex/*.png 还在盘上（skirt_sit 一张就 104 KB）。
# 留着不只是浪费体积 —— 下次有人照着目录数部件会被误导。
# **只删 tex/ 里没人引用的**：source/ 是原始件（要留），feat/ 里的表情大图
# （happy_/love_/sleep_… 那些 Coopanion 表情精灵）Mimitale 现在没用但**可能以后用**，
# 所以不动它们 —— 只清 tex 这一层。
used_tex = {p["tex"] for p in m["parts"]} | {f["tex"] for f in m["feat"].values()}
for name in sorted(os.listdir(TEX)):
    if not name.endswith(".png"):
        continue
    stem = name[:-4]
    if stem not in used_tex and stem in DROP_PARTS:
        os.remove(os.path.join(TEX, name))
        L(f"  drop: tex/{name}（model 已不引用，清掉）")

# 保留 schemes（配色元数据，Mimitale 目前不用，留着无害）
json.dump(m, open(os.path.join(DST, "model.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
L("\n[out] model.json 已写回", os.path.join(DST, "model.json"))

with open(os.path.join(OUTDIR, "whale_convert_report.txt"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(log))
L("[out] 报告", os.path.join(OUTDIR, "whale_convert_report.txt"))
