# -*- coding: utf-8 -*-
"""
把「蓝白猫」那张人设图做成桌宠默认形象。

── 为什么要分两步 ──────────────────────────────────────────────────────────
桌宠是**贴在桌面上**的，图片外面那圈必须透明。而人设图是「角色 + 标题 +
属性表 + 右边表情小图 + 底下表情条」的一整张海报，直接用会变成桌面上一块方板。

  第 1 步 `crop`    自动找出主立绘的框，裁出来 → tools/pet/crop-for-matte.png
  第 2 步 抠图      对那张图做**通用抠图**（用 WorkBuddy 的图像处理能力，
                   不是这个脚本干的 —— 见下）
  第 3 步 `install` 把抠好的图裁空白、缩放、装成 assets/pet/default/<默认形象>

为什么抠图不自己写：白头发和白裙子紧挨着几乎同样是白的底，纯颜色法一定会啃穿
（试过，裙子中间被啃出好几块透明）。那是专门的模型活儿。

  ⚠️ 别再写「从四边按颜色生长」那种自研抠图了。踩过的两个坑：
     ① 生长时如果跟**最初的种子**比颜色，误差会顺着一条链累积，渐变底能一路漂进
        人物身上（背景判成 70%、人只剩个轮廓）；
     ② 就算改成只跟相邻像素比、容差压到 8，白裙子照样漏。
  ⚠️ 也别指望「内容里最大的连通块」定位主体：人设图的卡片边框把标题、立绘、
     底下的表情条全串成了一个连通块（实测 54 万像素、外接框几乎等于整张图）。

── 跑法 ────────────────────────────────────────────────────────────────────
  PY=<venv>/python
  $PY tools/pet/make-default-skin.py crop
  # 对 tools/pet/crop-for-matte.png 做一次「通用抠图」，
  # 产物是个透明 PNG（随便存哪，下一步把路径传进去）
  $PY tools/pet/make-default-skin.py install <抠好的.png>

── 输出 ────────────────────────────────────────────────────────────────────
  assets/pet/default/8cb9700671c063df79e4cdcfedd513c1.png   桌宠用的透明形象
  assets/pet/default/source/original-1024.png                 原图留档（只写一次，别删）
  tools/pet/crop-for-matte.png                                抠图用的输入
  tools/pet/preview-checker.png                               棋盘底预览（肉眼检查）
"""
import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DIR = os.path.join(ROOT, 'assets', 'pet', 'default')
SKIN = os.path.join(DEFAULT_DIR, '8cb9700671c063df79e4cdcfedd513c1.png')
SOURCE = os.path.join(DEFAULT_DIR, 'source', 'original-1024.png')
CROP = os.path.join(ROOT, 'tools', 'pet', 'crop-for-matte.png')
CHECKER = os.path.join(ROOT, 'tools', 'pet', 'preview-checker.png')

TOL = 8            # 判「背景」时的局部容差（只用来找主体在哪，不参与最终抠图）
ROW_RATIO = 0.25   # 行剖面阈值（占峰值的比例）
COL_RATIO = 0.35   # 列剖面阈值
MAX_W = 520        # 输出宽度上限（桌宠窗口 1 倍缩放时约 300px）


# ---------------------------------------------------------------------------
#  找背景（只服务于「主体在哪」，不参与最终抠图）
# ---------------------------------------------------------------------------

def background_mask(im):
    w, h = im.size
    px = im.load()
    mask = bytearray(w * h)
    queue = deque()

    def close(a, b):
        return abs(a[0] - b[0]) <= TOL and abs(a[1] - b[1]) <= TOL and abs(a[2] - b[2]) <= TOL

    def push(x, y, ax, ay):
        if x < 0 or y < 0 or x >= w or y >= h:
            return
        i = y * w + x
        if mask[i]:
            return
        # 只跟**相邻的那个已判定像素**比，理由见文件头 ①
        if not close(px[x, y], px[ax, ay]):
            return
        mask[i] = 1
        queue.append((x, y))

    for x in range(w):
        push(x, 0, x, 0)
        push(x, h - 1, x, h - 1)
    for y in range(h):
        push(0, y, 0, y)
        push(w - 1, y, w - 1, y)

    while queue:
        x, y = queue.popleft()
        push(x + 1, y, x, y)
        push(x - 1, y, x, y)
        push(x, y + 1, x, y)
        push(x, y - 1, x, y)

    return mask


def longest_run(flags):
    """最长的一段连续 True → (起, 止)"""
    best = (0, -1)
    best_len = -1
    start = None
    for i, value in enumerate(flags):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if i - 1 - start > best_len:
                best = (start, i - 1)
                best_len = i - 1 - start
            start = None
    if start is not None and len(flags) - 1 - start > best_len:
        best = (start, len(flags) - 1)
    return best


def gaps_below(values, threshold):
    """所有「连续低于阈值」的区间"""
    out = []
    start = None
    for i, value in enumerate(values):
        if value < threshold and start is None:
            start = i
        elif value >= threshold and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(values) - 1))
    return out


def subject_box(im):
    """算出主立绘的框 (左, 上, 右, 下)"""
    w, h = im.size
    bg = background_mask(im)
    fg = [not bg[i] for i in range(w * h)]
    print('背景占比：%.1f%%' % (sum(bg) * 100.0 / (w * h)))

    rows = [sum(fg[y * w:(y + 1) * w]) for y in range(h)]
    row_thr = max(rows) * ROW_RATIO

    # 主立绘的下边界 = 内部最长的那条空档（它下面才是底部表情条）。
    # 只看「下半部分、且不贴着图底」的空档，否则会选到图顶 / 图底的留白。
    interior = [g for g in gaps_below(rows, row_thr) if g[0] > h * 0.5 and g[1] < h - 30]
    if interior:
        cut = max(interior, key=lambda g: g[1] - g[0])
        y_end = cut[0] - 1
        print('内部空档 %d..%d → 主立绘下边界 %d' % (cut[0], cut[1], y_end))
    else:
        y_end = h - 1
        print('没找到内部空档，行区间取到图底')

    y_start = 0
    for y in range(h):
        if rows[y] >= row_thr:
            y_start = y
            break

    cols = []
    for x in range(w):
        count = 0
        for y in range(y_start, y_end + 1):
            if fg[y * w + x]:
                count += 1
        cols.append(count)

    col_thr = max(cols) * COL_RATIO
    x_start, x_end = longest_run([c >= col_thr for c in cols])
    print('行区间 %d..%d，列区间 %d..%d' % (y_start, y_end, x_start, x_end))

    pad = 6
    return (max(0, x_start - pad), max(0, y_start - pad), min(w - 1, x_end + pad), min(h - 1, y_end + pad))


def cmd_crop():
    # ⚠️ **永远从留档原图读**。SKIN 是产物（会被覆盖），拿它当输入的话第二次跑
    #    就是在「上一次的结果」上再裁一次 —— 越裁越小，而且一声不响。
    if not os.path.exists(SOURCE):
        os.makedirs(os.path.dirname(SOURCE), exist_ok=True)
        Image.open(SKIN).save(SOURCE)
        print('已把当前图留档为原图：%s' % SOURCE)

    im = Image.open(SOURCE).convert('RGB')
    print('原图：%dx%d' % im.size)
    box = subject_box(im)
    crop = im.crop((box[0], box[1], box[2] + 1, box[3] + 1))
    crop.save(CROP)
    print('裁出主体：%s  %dx%d' % (CROP, crop.size[0], crop.size[1]))
    print('下一步：对这张图做一次「通用抠图」，再把抠好的图路径传给 install')


def cmd_install(matted_path):
    im = Image.open(matted_path).convert('RGBA')
    print('抠图产物：%dx%d' % im.size)

    alpha = im.split()[3]
    total = im.size[0] * im.size[1]
    # 只做个量级检查：太低说明抠过头（人没了），太高说明没抠干净（底还在）
    opaque = sum(1 for a in alpha.getdata() if a > 8)
    print('不透明像素占比：%.1f%%' % (opaque * 100.0 / total))

    box = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        im = im.crop(box)
        print('裁掉四周空白：%dx%d' % im.size)

    if im.size[0] > MAX_W:
        im = im.resize((MAX_W, max(1, int(im.size[1] * MAX_W / im.size[0]))), Image.LANCZOS)

    im.save(SKIN, 'PNG', optimize=True)
    print('已装到：%s  (%dx%d, %.0f KB)' % (SKIN, im.size[0], im.size[1], os.path.getsize(SKIN) / 1024.0))

    cell = 12
    cw, ch = im.size
    canvas = Image.new('RGB', (cw, ch), (255, 255, 255))
    px = canvas.load()
    for y in range(ch):
        for x in range(cw):
            if ((x // cell) + (y // cell)) % 2:
                px[x, y] = (222, 222, 228)
    canvas.paste(im, (0, 0), im)
    canvas.save(CHECKER)
    print('棋盘预览（对着它看一眼边缘干不干净）：%s' % CHECKER)


def main():
    args = sys.argv[1:]
    if not args or args[0] == 'crop':
        cmd_crop()
    elif args[0] == 'install' and len(args) > 1:
        cmd_install(args[1])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
