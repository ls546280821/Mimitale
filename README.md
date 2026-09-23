# Mimitale

一个跑在自己电脑上的桌面对话 AI。支持多模型切换、角色扮演和酒馆角色卡导入。

基于 **Electron + OpenAI 兼容接口**，没有任何后台服务器 —— 主进程就是本地的 Node.js 后端，
聊天记录和 API Key 全部只存在本机。

---

## 功能

### 多模型 / 多服务商

- 可以同时配置多个服务商，每个都有自己的**接口地址、API Key 和模型列表**。
- 内置 DeepSeek / OpenAI / 通义千问 / 智谱 GLM / Kimi 预设，也可完全自定义。
- 聊天窗口右上角的下拉框按服务商分组列出所有模型，**选中立刻生效**。
- **每个会话记住自己用的模型**，A 会话用 `gpt-4o`、B 会话用 `deepseek-chat` 互不影响。
- 每条回答上标注是哪个模型答的，方便对比。
- 支持一键「拉取可用模型」和「测试连接」。
- 所有 API Key 用系统级 `safeStorage` 加密后落盘。

### 角色扮演 / 角色卡

- **直接导入酒馆（SillyTavern）的 PNG 角色卡** —— 解析 PNG 里的 `tEXt` 数据块，
  把设定、头像、开场白、示例对话一起读进来；也支持 JSON 卡（v1 / v2 / v3）。
  v3 那种把开场白放进 `chat_history`（没有 `first_mes`）的变体也认。
- 内置角色编辑器，可以完全手写一个角色。
- **每个会话独立绑定角色**，新建对话会继承当前角色。
- 支持 `{{char}}` / `{{user}}` / `<BOT>` / `<USER>` 宏。
- **开场白**：空对话绑定角色时自动插入第一句话。
- **示例对话**：解析成真正的 user/assistant 消息一起发给模型，显著提升扮演质量。
- **头像可以自己上传**，会自动压成 256×256 存起来。
- **角色卡自带的世界书**：卡里内嵌的 `character_book` 会自动存进世界书库并绑到这张卡上。

### 世界书（World Info / Lorebook）

- **关键词命中才注入**，四两拨千斤：一本书几百条设定，只有相关的那几条进上下文。
- **递归扫描**：条目命中后，它的正文能再触发别的条目，一路连锁。
- 支持副关键词、选择性逻辑、概率、常驻条目、扫描深度。
- **命中预览**：用真实对话扫一遍，告诉你这轮会注入哪几条。
- 世界观和角色卡分开：**换个主角重玩同一个世界**。

### 状态面板（数值不漂）

模型每轮输出的状态栏会被**解析出来单独保存**，下一轮由程序权威注入 ——
所以聊再多轮，数值也不会因为历史被截断而开始乱编。

- 字段带**类型**（文本 / 数值 / 列表）
- 数值字段带**范围**，超出自动拉回（模型写 `150/100` → `100/100`）
- 数值字段自动画**进度条**
- 字段可以**分组**（「关系」「背包」各成一块）
- 字段可以带**变化规则**，原样交给模型（比如「示好时每轮最多加 10」）
- **剧情选项**：每轮给几个可点选项，点一下就当玩家回复发出去
- 导入他人卡片时，对方格式的「互动模板」会**自动映射**成这里的属性

### 长对话不丢前文

- **分段记忆摘要**：较早的对话压成摘要常驻，聊多久都不忘开局。
- **语义检索（RAG）**：按「意思」把相关的旧内容和设定捞回来，不靠关键词。
- **分支 / 存档点**：走岔了能整个退回来。

### 其他

- 多服务商 / 多模型切换，**每个会话记住自己用的模型**。
- 流式输出（打字机效果），逐帧渲染，长回答也不卡。
- 显示 `deepseek-reasoner` 这类模型的思考过程（可折叠）。
- **视角设置**：标准 / 内心描写 / 上帝视角；GM 模式让 AI 扮演整个世界和所有 NPC。
- **白天 / 夜间模式**一键切换，选择会记住。
- 单条消息删除、编辑、重新生成候选、复制全文、token 用量统计。
- **给 AI 看图**（模型得支持视觉）、**给剧情配插画**（单独配一组生图服务商）。
- **导出**：角色卡存成 PNG 卡（酒馆能直接导入）/ JSON，世界书存成 lorebook JSON，
  对话存成 Markdown。
- 断点安全的本地存储：每次写入前自动留一份 `.backup`。

---

## 快速开始

### 环境要求

- **Node.js 18 或更高**（[下载 LTS 版](https://nodejs.org)）
- Windows / macOS / Linux

### 运行

```bash
# 1. 装依赖（首次大约要下载 100MB 的 Electron 运行时）
npm install

# 2. 启动
npm start
```

Windows 用户也可以直接**双击 `Start-Mimitale.cmd`**，它会自动检查环境、首次自动
`npm install`，并给出中文的错误提示。

### 配置

启动后点左下角**「设置」**，填入服务商的接口地址和 API Key：

| 服务商 | 接口地址 |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| OpenAI | `https://api.openai.com/v1` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| Kimi | `https://api.moonshot.cn/v1` |

> 接口地址是**原样拼接**的（后面直接接 `/chat/completions`），
> 所以该带 `/v1` 的服务商必须带上，否则会 404。

详细用法见 **[使用说明.md](使用说明.md)**。

---

## 开发

**这个项目没有构建步骤** —— 没有 webpack / vite / babel，`renderer/` 里的文件
是 Chromium 直接从磁盘加载的，改完刷新就是新的。

```bash
npm run dev
```

这条命令会：
- 自动打开 **DevTools**
- 监听 `renderer/` 目录，**文件一保存就自动刷新窗口**

| 改什么 | 怎么生效 |
| --- | --- |
| `renderer/style.css` | 保存即刷新 |
| `renderer/js/` 里的文件 / `index.html` | 保存即刷新（但页面状态会重置） |
| `main.js` / `preload.js` | **必须重启**，这两个只在启动时读一次 |

`F12` 或 `Ctrl + Shift + I` 开关 DevTools，`Ctrl + R` 刷新窗口。

> 没有热更新（HMR）。因为那需要引入打包器，会把「零构建」这个最大的便利丢掉。

---

## 项目结构

```
mimitale/
├── main.js          Node.js 主进程（本地后端）：开窗口 + 注册 IPC
├── main/            主进程的模块（CommonJS，零构建）
│   ├── characters.js      角色卡归一化（哪些字段会被存下来）
│   ├── panel-fields.js    面板字段的类型 / 范围 / 变化规则 / 分组
│   ├── worldbook-*.js     世界书：解析、落盘、关键词匹配
│   ├── card-import.js     导入一个文件的解析
│   ├── import-files.js    导入编排（读文件 → 解析 → 自动绑定）
│   ├── png.js             PNG 角色卡的读写（tEXt / ccv3 块）
│   └── vectors.js         向量 / 余弦相似度 / 排序
├── preload.js       contextBridge 安全桥，把主进程能力暴露给页面
├── package.json
├── renderer/        前端（Chromium 页面）
│   ├── index.html
│   ├── style.css
│   └── js/          界面逻辑（ES module，不需要打包器）
│       ├── main.js      入口层 · 只剩启动流程 + 事件绑定 + 跨视图编排（482 行）
│       ├── core/        常量 / 状态 / DOM 引用 / preload 桥 / 工具 / 面板字段桥
│       ├── ui/          提示条 / 确认框 / 主题 / Markdown / 建 DOM 的小工具
│       ├── data/        纯逻辑地基：服务商模型 / 角色库 / 状态面板 / 叙述规则 /
│       │                记忆摘要 / 持久化 / 导出收尾 / 演出阵容 / 消息 / 语义检索 /
│       │                剧情选项 / 会话骨架
│       └── views/       一个功能一块，共 26 个模块（refresh 总线 / redraw 门面 /
│                        header / perspectiveUi / panelUi / worldbookList / worldbook /
│                        settings / appearance / player / memoryUi / viewSwitch /
│                        characterList / characterEditor / charAttributes /
│                        characterImport / stream / chatImages / suggestionsUi /
│                        convoActions / summarize / composer / chatMessages /
│                        chatList / chatExport / worldPlay）
└── tools/           冒烟测试脚手架（假后端，不动你的真实数据）
```

> **主进程为什么拆成 `main/`**：这些模块是纯逻辑，抽出来以后冒烟测试能
> `require` **同一份代码**去验，而不是在测试里另写一套 —— 「内嵌世界书被丢掉」
> 「导入后绑定指向不存在的书」这两个 bug 就是这么做才被抓住的。
>
> `renderer/js/main.js` 的重构**已经收尾**：从峰值 **7902 行**降到 **482 行**，
> 只剩入口层编排 —— 启动流程（`init()`）、事件绑定（`bindEvents()`，含 Esc 的
> 有序关闭链和 `api.onChunk / onReasoning` 全局监听）、刷新接线板
> （`registerRefreshListeners()`）、以及跨视图编排（`importWorldbooks()`）。
>
> 功能代码按 `core ← ui ← data ← views ← 入口` 单向分层：**data 13 个文件**
> 放纯逻辑，**views 26 个模块**一个功能一块，刷新走 `views/refresh.js` 总线，
> 全量重绘统一走 `views/redraw.js` 门面。视图要用入口层的动作时，由入口层
> `initXxx({ action })` 注入，视图不向上 import —— 这条是防循环依赖的铁律。
>
> 想自己复核分层与规模数字：`node tools/analyze.js`。

**为什么文件操作都在 `main.js`？** 因为页面被 CSP 锁死了：

```
default-src 'none'; script-src 'self'; img-src 'self' data:;
```

页面连网络请求都发不出去，所以所有系统能力都必须走 IPC 交给主进程。
这是刻意设计 —— 即使页面上被塞了恶意脚本，它也没法往外发数据。

---

## 数据存在哪

```
%APPDATA%\Mimitale\           (Windows)
~/Library/Application Support/Mimitale/    (macOS)
~/.config/Mimitale/           (Linux)
├── config.json          设置（API Key 已加密）
├── conversations.json   所有聊天记录
├── characters.json      角色库
└── worldbooks.json      世界书（含从角色卡里抽出的内嵌世界书）
```

窗口里点**「打开数据文件夹」**可以直接跳过去。

> **数据不在仓库里，也不会跟着 git 同步。** 换电脑 clone 代码后需要重新填 API Key，
> 聊天记录也不会带过去 —— 这是「没有服务器」的代价，也是隐私的保证。

---

## 已知限制

- **发图给模型看**：已经支持（输入框左边的图片按钮，也可以直接粘贴 / 拖进来），
  但**模型本身得支持视觉** —— 纯文本模型收到图会报错。这不需要另外接一个服务商，
  只是模型要选对。
- **让模型生图**：已经支持（鼠标悬停在 AI 回复上 → 「配图」）。需要在
  **设置 → 生图**里单独配一组「生图服务商 + 生图模型」—— 它和聊天模型是两个东西，
  通常还在两个端点上（`/images/generations` vs `/chat/completions`）。
  目前只支持同步返回图片的接口（OpenAI 那套）；通义万相那种异步任务还不支持。
- 不同电脑之间无法同步聊天记录。
- **智谱没有 `GET /models` 接口**，所以「拉取可用模型」对它无效 —— 内置的模型清单
  （`glm-5.3-flash` / `glm-5.3` / `glm-5.2`）就是为此准备的，直接用即可。
- 界面里的「导入角色卡」按钮会弹系统文件框，冒烟测试点不了它；
  导入链路的**真代码**已由测试直接喂真卡字节覆盖（见 `tools/`）。

---

## License

MIT
