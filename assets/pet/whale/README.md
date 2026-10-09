# whale 形象包（DeepSeek 大肥鱼）

**来源**：`Pal-AI-Lab/Coopanion` → `packages/cortico-world-desktop-pet/web/whale/`
（AGPL-3.0-or-later，与本项目 rig.js 同源：本项目 rig.js 本就移植自 Coopanion 的 kit）

**它是什么**：一只二头身的蓝发鲸鱼娘（社区给 DeepSeek 蓝鲸 logo 的拟人二创）。
带完整骨骼：走路步态、尾巴摆动、鱼鳍扇动、眨眼、腮红、多种表情。

---

## 为什么能直接搬过来

两边的 `model.json` **是同一套 schema**（`units/pivots/parts/view`），
连 `S/X0/FEET/DS/featDS` 五个单位字段的**含义都相同**。实测核对：

| 对照项 | Coopanion | Mimitale | 结论 |
|---|---|---|---|
| `units` 字段 | `S/X0/FEET/DS/featDS` | 同 | ✅ 一致 |
| `parts[].box` 公式 | `px_w / S * DS` | 同 | ✅ 逐条验过（25 张全中） |
| `view` | `[-12,-8,268,272]` | `[52,-12,240,276]` | ⚠️ 数值不同、语义相同 |
| deformer 名 | `finNear/finFar` | `earNear/earFar` | 需改名 |
| part id | `arm_near/arm_far/leg_back/leg_front` | `arm_left/arm_right/leg_left/leg_right` | 需改名 |
| `feat` 结构 | `{eyes, sprites, blush, skin}` + 程序化绘制 | `{eye_open, eye_closed, mouth}` 静态件 | **需转换** |

---

## 转换脚本

```bash
python tools/pet/pipeline/convert_whale.py
```

做五件事（幂等，可反复跑 —— 每次都从 `source/model-original.json` 重新来，不叠在成品上）：

1. **pivots**：从 `finNear/finFar` 复制出 `earNear/earFar`（原 `fin*` 保留）。
2. **parts[].parent**：`finNear→earNear`、`finFar→earFar`、`hairSway→headBack`、
   `skirtSit→skirt`（后两者是 Mimitale 没有的变形器，就近挂到已有的）。
3. **parts[].id 改名**：`arm_near→arm_left`、`arm_far→arm_right`、
   `leg_back→leg_left`、`leg_front→leg_right`。
   ⚠️ **只改 id，不改 `tex`** —— 贴图文件名保持原样，所以 tex/*.png 可以直接拷。
4. **feat 转换**：
   - 把 `eyeL/eyeR` 的 `ball + iris + lash` **预合成为一张** `feat/eye_open.png`；
   - 用 `sleep_eyeL/sleep_eyeR` 合成 `feat/eye_closed.png`；
   - `neutral_mouth` 存为 `feat/mouth.png`；
   - 坐标按 **feat 公式** `rig_w = px_w * S` 换算（**不是** parts 的 `/S*DS`）。
5. **丢掉 Coopanion 里「靠运行时 alpha 才不显示」的部件**（见下节）。

### ⚠️ feat 与 parts 的坐标公式**不一样**（踩过的坑）

```
parts:  box.w = px_w / S * DS      # 贴图按 DS 烘焙过
feat :  box.w = px_w * S           # 母图像素 1:1，没有 DS
```

写错会让 box 宽出十几倍 —— 实测 `eye_open` 算出宽 1143 rig，而整个 view 只有 280 宽。
出处：Coopanion `figure.js:136` 的 `box: [U(FACE.x), V(FACE.y), FACE.w * S, FACE.h * S]`。

### ⚠️ box 的 y 取**上边** V(y_top)，不是下边（「眼睛位置不对」的根因）

`V()` **向下增长**（母图 y 越大 → V 越大 → 越靠下），而 box 是
`(x, y, w, h)` 左上角原点 —— 所以 y 要取母图 bbox 的**上边**（较小的 y）。

写反会让整组五官**向下偏移整整一个自身高度**。
星宝 2026-10-09 报的「**眼睛位置不对**」就是这个：

```
eye_open 母图 bbox [549, 609, 911, 748]
  ✗ 错：V(748 下边) = 139.15  → 眼睛飘到下巴/发际线（139.15 ~ 165.56，脸只到 156.06）
  ✓ 对：V(609 上边) = 112.74  → 正常落在脸内（112.74 ~ 139.15）
  差 = 26.41 = 眼睛自身高度
```

**参照物**：本项目自己产的猫娘包用的就是这个口径 —— `step3_pack.py:83`：

```python
box = [round(U(x), 2), round(V(y), 2), round(w * S, 3), round(h * S, 3)]
#                                   ^ x,y 取的是 box_px 的左上角
```

`test-pet-window.js` 加了几何断言兜底：**五官的竖直范围必须被脸包住**，
且眼睛的 V 必须**小于**嘴的 V（V 越小越靠上）。

### ⚠️ 为什么必须删掉 3 个部件（「形象重叠」的根因）

星宝 2026-10-09 报「**deepseek 的形象不对 重叠了**」—— 看到的是**裙摆画了两层**、
腿被埋在裙子里、眼睛上多挂两道褶。

根因：**Coopanion 靠每部件 alpha 决定「这一刻画不画」，而 Mimitale 没有驱动它的那个状态**，
于是那些部件全部常驻、和正主重叠。Coopanion `figure.js:558-560`：

```js
st.alpha.skirt               = 1 - sitIn    // 站姿裙：站着 1，坐下 0
st.alpha.waist_bow_front     = 1 - sitIn
st.alpha.skirt_sit           = sitIn        // 坐姿裙：站着 0，坐下 1   ← 罪魁
st.alpha.waist_bow_sit_front = sitIn        //                                  ← 罪魁
st.alpha.eye_creases = creaseA;             // 跟着「眼睛睁开程度」淡出（:596）
```

Mimitale 的 rig **支持** `st.alpha`（`rig.js:208` 读 `st.alpha?.[p.id] ?? p.alpha ?? 1`）,
猫的眨眼对就是这么做的 —— 但**猫没有坐姿**，所以 `cat-figure.js` 从不给这些 id 设 alpha。

Mimitale 的桌宠**没有「坐下」这个状态**，也没有「眼睛睁到什么程度」这个连续量，
所以最干净的做法是**转换时直接删掉**，而不是给 renderer 加一套永远算不出值的逻辑：

| 删掉的部件 | 为什么 |
|---|---|
| `skirt_sit` | 坐姿裙。宽 151.8 vs 站姿裙 98.0（宽 1.5 倍），同时画 = 裙摆两层 |
| `waist_bow_sit_front` | 坐姿蝴蝶结，同上 |
| `eye_creases` | 眼睑褶。没有「睁眼程度」，常驻就是**正常睁眼也挂两道褶** |

**推论（换别的 Coopanion 形象包时要照着查一遍）**：
凡是 Coopanion 里出现 `st.alpha.X = <某个状态量>` 的部件，都要问一句
**「Mimitale 有没有那个状态？」** —— 没有就必须删，否则它会常驻并和正主重叠。

---

## 怎么用

`pet-store.js` 认 **任何** 带 `model.json` 的目录，所以只要把 `look.skin` 指到 `whale` 即可：

```json
"look": { "kind": "rig", "source": "assets", "skin": "whale" }
```

配置落在 `%APPDATA%/Mimitale/pet/config.json`。

**验证**（真起窗口 + 真 rig）：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
  tools/pet/capture-pet-window.js --skin=whale --frames=6 --idle --no-sandbox
```

实测：**页面零报错**，走路/眨眼/尾巴摆动全部正常。

---

## 换回自己的角色

目录约定就是换肤的接口 —— 自己的角色弄好后：

1. 给它一个 `assets/pet/<名字>/`，放 `model.json` + `tex/*.png` + `feat/*.png`；
2. 把 `look.skin` 改成那个名字；
3. 想保留 whale 就两套并存（互相不干扰）。

**部件命名要对齐**（`cat-figure.js` 按 id 找 rect）：

- 部件必须含：`skirt`、`tail`、`arm_left`、`arm_right`、`leg_left`、`leg_right`、`bangs`
- pivots 必须含：`body/waist/neck/armNear/armFar/legBack/legFront/tail/earNear/earFar/ahoge`
- feat 三件套：`eye_open` / `eye_closed` / `mouth`

---

## 保留文件

- `source/model-original.json` —— Coopanion 原始 model.json（未转换，供回溯）
- `source/figure.js`、`source/figure.json` —— Coopanion 的 figure 实现与清单
  （**参考价值高**：它的眼睛是程序化绘制的 —— ball+iris+lash 按眼睑开合动态合成，
  比本项目「两张静态贴图切换」先进。将来想升级眨眼/视线可以抄它。）
- `thumbs/` 之类没拷（缩略图，本项目不用）。
