#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
run_all.py —— 按 source/pipeline.json 的配方把整条管线跑一遍。

**为什么要有它**：上一版管线的入口脚本（`run_all.py`）连同其它脚本一起丢在仓库外，
换机器整套蒸发。这一版所有步骤都是仓库里的文件，配方写进 `pipeline.json`，
「母图 + 配方」就能重跑出同样的形象包。

跑法（在仓库根）：
    python tools/pet/pipeline/run_all.py                 # 跑到哪步算哪步
    python tools/pet/pipeline/run_all.py cat             # 指定形象包名

每一步都是独立可跑的脚本，跑挂了单独重跑那一步就行。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PY = sys.executable


def run(title, argv):
    print('\n' + '=' * 72)
    print('▶ %s' % title)
    print('=' * 72)
    r = subprocess.run([PY] + argv, cwd=ROOT)
    if r.returncode != 0:
        print('❌ 这一步失败了（退出码 %d），后面的步骤没跑。' % r.returncode)
        sys.exit(r.returncode)


def main():
    skin = sys.argv[1] if len(sys.argv) > 1 else 'cat'
    src_dir = os.path.join(ROOT, 'assets', 'pet', skin, 'source')
    build = os.path.join(ROOT, 'assets', 'pet', skin, 'build')
    os.makedirs(build, exist_ok=True)

    cfg_path = os.path.join(src_dir, 'pipeline.json')
    cfg = json.load(open(cfg_path, encoding='utf-8')) if os.path.exists(cfg_path) else {}
    raw = os.path.join(src_dir, 'master-raw.png')
    toned = os.path.join(build, 'master-toned.png')
    keyed = os.path.join(build, 'master-keyed.png')

    if not os.path.exists(raw):
        print('❌ 找不到母图真源 %s' % raw)
        sys.exit(1)

    print('形象包：%s' % skin)
    print('配方：%s' % json.dumps(cfg, ensure_ascii=False))

    # step0 蓝色收敛（配方说 1.0 或没写就跳过，省得白白转一遍像素）
    k = float(cfg.get('toneBlue', 1.0))
    if k != 1.0:
        run('step0 蓝色收敛  k=%s' % k,
            [os.path.join(HERE, 'step0_tone.py'), raw, toned, str(k)])
    else:
        toned = raw
        print('\n（配方 toneBlue=1.0，跳过 step0）')

    run('step1 抠底（棋盘格/白底 -> 真 alpha）',
        [os.path.join(HERE, 'step1_key.py'), toned, keyed])

    # 拆件：**优先用交接包**（手工级的图层，比自动拆件干净），没有才退回分水岭。
    # 交接包放在 source/交接包/（layers + face_expression_options + docs），已进版本库 ——
    # 它是手工拆的、管线生不出来，按我们的判据属于「真源」，必须留在仓库里。
    #
    # layers_final 是**修补过的版本**（fix_holes3/4：把 00 未分配层按颜色+双边复制还原给
    # 各部件边缘）。它比 layers 干净 —— layers 里每个部件边缘都缺一圈描边，拼起来处处是缝。
    # 有 layers_final 就用它，没有再退回 layers。
    pkg = os.path.join(ROOT, 'assets', 'pet', skin, 'source', '交接包')
    ldir = 'layers_final' if os.path.isdir(os.path.join(pkg, 'layers_final')) else 'layers'
    imp = os.path.join(HERE, 'step2_import.py')
    if os.path.exists(imp) and os.path.isdir(os.path.join(pkg, ldir)):
        run('step2 导入拆件交接包（优先路径，用 %s）' % ldir,
            [imp, pkg, build, '--layers', ldir])
    else:
        step2 = os.path.join(HERE, 'step2_parts.py')
        if os.path.exists(step2):
            run('step2 拆件（分水岭兜底：显式分区 + 几何夹取）', [step2, keyed, build])
        else:
            print('\n⚠️ step2 两个都没有，拆件跳过。')

    step3 = os.path.join(HERE, 'step3_pack.py')
    if os.path.exists(step3):
        run('step3 算 box/pivots 并写 model.json', [step3, build, skin])
    else:
        print('⚠️ step3_pack.py 还没写，跳过。')

    print('\n✅ 跑完了。产物在 %s' % build)


if __name__ == '__main__':
    main()
