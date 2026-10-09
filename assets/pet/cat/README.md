# 蓝白猫娘（内置默认形象）

Mimitale 自带的第一个 rig 形象包，也是**默认形象**（`look.skin = 'cat'`）。

## 目录

```
cat/
  model.json    rig 数据（units / pivots / parts / feat / view）
  tex/*.png     部件贴图，文件名与 parts[].tex 同名
  feat/*.png    五官叠加层：eye_open / eye_closed / mouth
```

## 部件

`face` · `torso_up` · `skirt` · `apron` · `collar` · `arm_left` · `arm_right` ·
`leg_left` · `leg_right` · `tail` · `bangs` · `ahoge` · `ear_left` · `ear_right`

## 说明

- 这一包是**白底 JPEG 母图抠出来的**，所以相邻部件的接缝处会带一点点彼此的描边
  （见 `.workbuddy/memory/2026-10-09.md` 里「袖子与衣身没有可用描边」那条）。
  这是「从成品图上切」的固有代价，不是 bug。
- 想换成自己的角色：另建一个目录（比如 `assets/pet/mygirl/`），按同样的形状放
  `model.json` + `tex/` + `feat/`，然后在设置弹窗的「形象」下拉里选它。
  接口约定见 `assets/pet/whale/README.md` 末尾那节。
