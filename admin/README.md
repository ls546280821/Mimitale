# Mimitale 客户管理后台

给自己用的后台，用来管理**在 Mimitale 客户端里注册使用的客户**。

**前端独立项目**，跟根目录的 Electron 应用没有任何构建上的关系（两套 `node_modules`，互不干扰）。

技术栈：Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router

---

## ⚠️ 先搞清楚：这里有两个「用户」，别混

| | 客户（customer） | 管理员（admin） |
| --- | --- | --- |
| 是谁 | 在 Mimitale 客户端里注册使用软件的人 | **你自己** |
| 从哪来 | 客户端里自助注册（登录即注册） | 预置的，由部署时初始化写入 |
| 怎么登录 | 邮箱验证码，客户端调 `/api/client/auth/*` | 账号 + 密码，本后台调 `/api/admin/auth/*` |
| 本后台管不管 | **管**（这是本后台存在的意义） | 不管（就一个账号） |

**客户不能登录本后台，管理员也不是客户。** 两套账号、两套接口、两套 token。

后台这边**故意没有注册入口** —— 客户能自助注册是设计，管理员能自助注册是漏洞。

---

## 跑起来

```bash
cd admin
npm install
npm run dev          # 打开 http://localhost:5173
```

**默认是 Mock 模式**，不需要后端：

> 试玩账号 **admin** ／ 密码 **admin123**

其他命令：

```bash
npm run build        # 产出 dist/
npm run preview      # 预览构建结果
npm run typecheck    # 类型检查
npm run smoke        # 接口自测（98 条断言，几秒钟，不需要后端和浏览器）
```

改完 `src/mock` 或 `src/types` 之后跑一下 `npm run smoke`，能立刻知道你刚才有没有把接口改坏。

### 本机装依赖的坑

这台机器上 esbuild 的 postinstall 会失败（EBUSY，360 或沙箱拦新建 exe），
导致 `npm install` 整体失败、且不写 lock 文件。解法：

```bash
npm install --ignore-scripts
npm install --no-save --ignore-scripts @esbuild/win32-x64
```

第二条不能省 —— 它是 esbuild 的可选依赖，第一条失败时被一起回滚了。

## 连真实后端

复制 `.env.example` 成 `.env`，把开关关掉：

```
VITE_USE_MOCK=false
VITE_API_BASE=/api
```

开发时 `/api` 会由 vite 代理到 `http://127.0.0.1:8080`（在 `vite.config.ts` 里改 `target`）。

## 目录

```
src/
├── types/
│   ├── index.ts      公共：ApiResult、全部错误码
│   ├── admin.ts      ⭐ 后台侧契约（本后台用，16 个接口）
│   └── client.ts     客户侧契约（客户端用，本后台不调，给后端参考）
├── mock/index.ts     ⭐ Mock 后端 —— 同时也是各接口的行为说明
├── config/
│   ├── menu.ts       侧边菜单配置（数组驱动，加页面改这里）
│   └── labels.ts     ⚠️ 写死在代码里的那些枚举（**故意不放字典**，见下）
├── api/              axios 封装 + admin / customer / log / card / dict
├── stores/
│   ├── auth.ts       管理员登录态
│   └── dict.ts       字典缓存（界面上所有下拉都从它取值）
├── router/index.ts   路由与登录守卫（hash 模式）
├── layouts/          侧边栏 + 顶栏骨架
├── components/
│   └── CustomerDialogs.vue  改额度 / 封禁弹层（列表页与详情页共用）
├── views/            登录、客户列表、客户详情、卡密、操作日志、字典
└── scripts/smoke.mjs 接口自测
```

## 接口一览（本后台实际调用的 16 个）

响应统一是 `{ code, message, data }`，`code === 0` 为成功。
认证走 `Authorization: Bearer <token>`；认证失败返回 HTTP 401。

### 管理员认证（1~4）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/auth/login` | 管理员登录（账号 + 密码，**无注册**） |
| POST | `/api/admin/auth/refresh` | 用 refreshToken 换新 token |
| GET | `/api/admin/auth/me` | 拿当前管理员，顺便校验 token |
| POST | `/api/admin/auth/logout` | 登出 |

### 客户（5~7）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/customers` | 客户列表（分页 / 关键词 / 状态） |
| GET | `/api/admin/customers/{id}` | 客户详情（+ 来源卡密 + 操作记录） |
| PATCH | `/api/admin/customers/{id}` | 封禁 / 解封 / 改额度（**每个动作落一条日志**） |

### 操作日志（8）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/logs` | 分页 + 动作 / 关键词 / 时间范围。**只有查，没有写** |

### 卡密（9~11）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/cards` | 卡密列表（分页 / 状态 / 关键词） |
| POST | `/api/admin/cards` | 批量生成（一次最多 100 张） |
| PATCH | `/api/admin/cards/{id}` | 作废（已使用的卡不能作废） |

### 字典（12~16）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dicts` | 一次拿全部（类型 + 数据项） |
| POST | `/api/admin/dicts` | 新建字典类型 |
| POST | `/api/admin/dicts/{code}/items` | 新增数据项 |
| PATCH | `/api/admin/dicts/items/{id}` | 改标签 / 值 / 排序 / 启用停用 |
| DELETE | `/api/admin/dicts/items/{id}` | 删除数据项 |

**客户侧那 5 个接口**（发验证码 / 登录即注册 / 刷新 / me / 登出）在 `src/types/client.ts`，
那是 Mimitale 客户端调的，后端也要实现，但本后台不碰。

细节见 `src/types/`，那里有每个字段的说明和全部错误码。

---

## ⚠️ 字典的边界：什么该放，什么不该放

**判断标准只有一条：加一个新值，需不需要改代码？**

| 放（真字典） | 不放（假旋钮） |
| --- | --- |
| 封禁原因 `ban_reason` | 客户状态 `active` / `banned` |
| 客户来源 `customer_source` | 卡密状态 `unused` / `used` / `void` |
| 额度预设 `quota_preset` | 管理员角色 `super` / `normal` |
| 卡密备注分类 `card_note` | 操作日志的动作类型 |

**为什么不能都塞进去**：后端写着 `if (status === 'banned')`，你在字典里加个第三态，
界面上会多出一个**选得动、但点了什么都不会发生**的选项。假旋钮比没旋钮更糟 ——
它让人以为系统很灵活，实际每次都得回来改代码。

而封禁原因不一样：运营明天想加一个「刷屏广告」，在字典页加一条就完事，
封禁弹层的下拉立刻多出来，不用重新部署。

这些「参与逻辑判断」的枚举写在 `src/config/labels.ts`，那里有同样的说明。

**字典不只是摆设**：界面上这几个地方真的在读字典 ——

- 封禁弹层的「封禁原因」下拉 → `ban_reason`
- 客户列表的「来源」列、客户详情的「来源」 → `customer_source`
- 改额度弹层里的快捷按钮 → `quota_preset`
- 生成卡密弹层的「备注分类」 → `card_note`

---

## 操作日志怎么来的

**只由后端写入。** 封禁、解封、改额度、生成卡密、作废卡密、改动字典，
都在同一个 handler 里顺手 `pushLog(...)` 一条。

这不是「顺便加的功能」—— 日志如果靠前端上报，那它记录的就只是
**前端愿意上报的那部分**，出事时一文不值。所以后台**没有**新增日志的接口。

还有一条细节：**值没变就不写日志**。重复提交同一个额度不会刷出一堆噪音
（`npm run smoke` 里有断言盯着这条）。

## 加新页面

1. 在 `src/views/` 建 `.vue`
2. 在 `src/router/index.ts` 的 `children` 里加一条路由
3. 在 `src/config/menu.ts` 的数组里加一项

菜单是数组驱动的，第 3 步改一处即可（以前要在 `DefaultLayout.vue` 的模板里插标签）。
将来若要做「后端下发菜单树」，只需把这个数组的数据源换成接口，渲染部分不用动。

## 部署

`npm run build` 出来的 `dist/` 是纯静态文件，丢给 nginx 即可。
因为路由用的是 **hash 模式**，nginx 不需要配 `try_files`：

```nginx
location /admin/ {
    alias /var/www/mimitale-admin/;
    index index.html;
}
```

同时把 `/api` 反向代理到后端：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8080/api/;
}
```
