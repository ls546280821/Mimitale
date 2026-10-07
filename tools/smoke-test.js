'use strict';

// ============================================================================
//  smoke-test.js —— 冒烟测试（不属于应用代码，不参与打包）
//
//  跑法： npm run smoke
//
//  它干什么：
//    开一个「不显示」的 Electron 窗口，加载**真实的** renderer/index.html，
//    但把所有 IPC 都换成内存里的假后端 —— 所以它既跑的是真界面，
//    又**不会碰你的 userData**，随便跑，不会弄坏你的角色和会话。
//
//  为什么要它：
//    界面逻辑还在往 ES module 一层层拆。有了它，每拆一步都能自动验一遍
//    「功能还在不在」—— 光靠手点，拆错了要很久以后才发现。
//
//  断言写在 tools/smoke-renderer.js 里（那部分代码跑在页面里）。
//  想肉眼核对界面（间距 / 对齐 / 配色），加 --shot=<场景>，见 README。
// ============================================================================

const { app, BrowserWindow, ipcMain } = require('electron');

// 测试只做 DOM 断言，用不到 GPU。某些环境（无独显/远程桌面/驱动异常）的 GPU
// 进程会反复崩溃把主进程一起带走，表现为「页面加载失败：ERR_FAILED」。
// 关硬件加速就没有这个噪声；另一半在 package.json 的 --no-sandbox。
// 这两个脚本不加载外部内容、IPC 全是内存假后端，关掉无副作用。
app.disableHardwareAcceleration();

const fs = require('fs');
const path = require('path');

// 关键：用**主进程真正在用的**归一化，而不是自己糊一套。
// 角色「属性」丢过一次，就是因为假后端只做存取、不做归一化 ——
// 主进程白名单漏了字段，测试却全绿。现在这段往返走的是同一份代码。
const { normalizeCharacter } = require('../main/characters.js');
// 导出 PNG 卡要插 tEXt 块、导入要读回来 —— 用同一份实现，才能测真正的往返
const { pngWithTextChunk, parseCharacterCardPng } = require('../main/png.js');
// 世界书匹配（含递归扫描）也用真实现
const { matchWorldbookEntries, formatWorldbookSection } = require('../main/worldbook-match.js');
// 导入链路的编排：读文件 → 解析 → 自动绑定。
// 以前 characters:import 在冒烟测试里是个 `{canceled:true}` 的桩，
// 所以「卡里内嵌的世界书被丢掉」「导入后绑定指到不存在的书」这类 bug 测不出来。
const { importFiles } = require('../main/import-files.js');
// 导入时的形状识别 / 归一化：和主进程 handler 跑的是同一份
const { parseImportFile } = require('../main/card-import.js');
// 世界书落盘归一化：和 main.js 的 worldbooks:save 跑的是同一份
const { createWorldbookNormalizer } = require('../main/worldbook-store.js');
// 预设落盘归一化：和 main.js 的 presets:save 跑的是同一份。
// 「描述是给人看的、正文是给模型看的」这条规则只在归一层，假后端只 clone
// 的话，「导入来的预设正文住在 metadata.systemPromptContent」就测不出来了。
const { normalizePreset } = require('../main/presets.js');
// 「请求记录」用的两样真东西：
//   · request-log.js —— 环形缓冲本身（假后端记进去、页面侧读到、上限也由它管）
//   · http.js 的 streamChat —— onRequest 是不是在请求发出去**之前**就触发了。
//     这条只能在这儿验：页面看不到真正发出去的东西，而假后端根本不发网络请求。
const { recordRequest, listRequests, clearRequests, MAX_ENTRIES: MAX_LOGGED_REQUESTS } = require('../main/request-log.js');
const { streamChat } = require('../main/http.js');
// 面板字段的类型/范围/变化规则/分组：主进程和渲染层共用的那一份
const {
  clampFieldValue,
  normalizePanelField,
  normalizePanelFields,
  groupPanelFields,
  fieldProgress,
  describePanelField
} = require('../main/panel-fields.js');
// 语义检索的向量工具也用真实现（编解码 / 余弦 / topK 都是它）
const {
  hashText,
  encodeVector,
  decodeVector,
  cosineSimilarity,
  rankBySimilarity,
  collectCandidates
} = require('../main/vectors.js');

const APP_DIR = path.join(__dirname, '..');
// 兜底超时。⚠️ 它是**整套**的墙钟上限，不是单个场景的 —— 场景越加越多，
// 2026-09-30 加进「世界书：保存后才生效 / 卡片上删除」之后原来那 90 秒就不够了
// （跑到「剧情选项」正好卡线，看上去像卡死，其实只是还没跑完）。
const OVERALL_TIMEOUT_MS = 150000;

// --shot-only：**只出图，不跑断言**。
//
// 为什么要有它：--shot=<场景> 原来必须等整套断言跑完才轮得到截图 ——
// 改一行 CSS 想看效果，也要先等 1 分半。这不是「测试严谨」，是**工具用错了**：
// 光看样式根本不需要 800 条断言，需要的是几秒钟出一张图。
// 加了它之后：直接灌一份给截图用的种子数据 → 打开场景 → 拍照，几秒钟的事。
//
// ⚠️ 它**不产生任何断言结果**，所以别拿它当验证 —— 出图归出图，验证还得跑整套。
// ⚠️ 依赖场景副作用搭出来的界面（会话 / 面板 / 状态卡那类）在这里是空的：
//    那种场景请老实跑整套。这里够用的是「纯布局」那批：
//    chars / charArt / charEditor / charAttrs / charTextareas / worldbook /
//    worldbookPage / settings / modelMenu / moreMenu。
const SHOT_ONLY = process.argv.includes('--shot-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
//  假后端：所有读写都留在内存里
//  注意每个 get 都要返回深拷贝 —— 真实 IPC 是序列化的，
//  如果直接把 store 里的数组交给渲染层，两边就会共享引用，
//  「保存前不该落盘」这类断言会变成假阳性。
// ---------------------------------------------------------------------------
function makeStore() {
  return {
    settings: {
      providers: [
        {
          id: 'p-test',
          name: '冒烟测试服务商',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['test-model']
        },
        // 第二个服务商专门给生图用 —— 生图和聊天是两套配置，测试也要分开验
        {
          id: 'p-img',
          name: '冒烟测试生图',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['img-model-x']
        },
        // 第三个给语义检索用 —— 向量模型又是一组独立配置
        {
          id: 'p-emb',
          name: '冒烟测试向量',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['emb-model-x']
        }
      ],
      activeProviderId: 'p-test',
      activeModel: 'test-model',
      temperature: 0.7,
      maxTokens: 512,
      topP: 0.95,
      theme: 'light',
      sendOnEnter: true,
      showDate: false,
      // 打开用量显示：头部那行「输入 / 输出（其中思考 N）」才有得测 ——
      // 「思考花了多少」是判断「是不是它在吃额度」的关键数字，值得一直摆在测试里
      showUsage: true,
      autoContinue: true
    },
    characters: [],
    worldbooks: [
      {
        id: 'w-test',
        name: '冒烟测试世界',
        characters: [],
        opening: '',
        // 前三条是给「递归扫描」用的连锁：只提「翁法罗斯」，
        // 靠总览正文里的「十二泰坦」「火种」把另外两条带出来。
        // 第四条谁都不提它，用来验「没命中就是没命中」。
        entries: [
          {
            id: 'e-root',
            title: '世界总览',
            keys: ['翁法罗斯'],
            secondaryKeys: [],
            selectivelogic: 'AND_ANY',
            selectiveLogic: 'AND_ANY',
            // 正文只提「十二泰坦」，不提「火种」—— 这样才是一条严格的链
            content: '翁法罗斯有十二泰坦。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-titan',
            title: '十二泰坦',
            keys: ['十二泰坦'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '十二泰坦守着火种，是这个世界的神。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-flame',
            title: '火种',
            keys: ['火种'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '火种是泰坦留下的力量。',
            constant: false,
            recursive: false,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-unrelated',
            title: '无关条目',
            keys: ['完全没人提的词'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '这条不该被带进来。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          }
        ]
      }
    ],
    conversations: [],
    activeId: null,
    // 预设：叠在对话上的一层指令。第一条故意用「别人分享的导入形态」
    // （正文在 metadata.systemPromptContent、description 是使用说明），
    // 第二条带条目（一条常驻、一条靠关键词命中），用来验两种正文来源都认得。
    // 第三条挂了 global:true —— 「没手动配过的会话自动带上它」。
    presets: [
      {
        id: 'pr-test',
        name: '冒烟测试预设',
        description: '测试用的说明，不会发给模型。',
        metadata: {
          isImported: true,
          systemPromptContent: '每一轮都要推进一个具体事件，不要停在原地。'
        },
        tags: ['测试'],
        lorebookCount: 0,
        entryCount: 0
      },
      {
        id: 'pr-entries',
        name: '带条目的预设',
        description: '',
        content: '最前面的总则。',
        tags: [],
        entries: [
          {
            id: 'pe-const',
            title: '常驻条目',
            keys: [],
            content: '这条每轮都带上。',
            constant: true,
            enabled: true
          },
          {
            id: 'pe-key',
            title: '关键词条目',
            keys: ['暗号'],
            content: '说到「暗号」才带上这条。',
            constant: false,
            enabled: true
          }
        ]
      },
      {
        id: 'pr-global',
        name: '全局通用预设',
        description: '',
        content: '这场对话默认带上这一条。',
        global: true,
        tags: []
      }
    ]
  };
}

const store = makeStore();

// 给截图用的种子角色 / 世界书。**只在 --shot-only 下灌**，结构照着断言场景里
// 那批卡来（属性、分组、标签都有），这样出图看到的就是真实布局该有的样子。
// 这里不做任何断言，所以它跑偏了也不会让测试变绿 —— 但也正因为如此，
// 它**不能**替断言场景里那份真实数据。改字段形状时两边都看一眼。
function seedForShots() {
  const card = (id, name, extra) =>
    Object.assign(
      {
        id,
        name,
        avatar: '',
        description: `${name}的设定文本。`,
        personality: '沉默寡言',
        scenario: '',
        firstMes: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: ['手写'],
        attributes: [],
        source: 'manual',
        createdAt: 1,
        updatedAt: 1
      },
      extra || {}
    );

  // 出图用的占位插画（不写盘、只在 --shot-only 的种子数据里）
  const shotArt = (w, h, hue, label) =>
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="${w}" height="${h}" fill="hsl(${hue},72%,91%)"/>` +
        `<circle cx="${w / 2}" cy="${h * 0.4}" r="${Math.round(h * 0.2)}" fill="hsl(${hue},55%,68%)"/>` +
        `<text x="${w / 2}" y="${h - 16}" font-size="${Math.round(h * 0.08)}" text-anchor="middle" fill="hsl(${hue},50%,36%)">${label}</text>` +
        `</svg>`
    );

  store.characters = [
    // 状态卡上要铺一张角色图，所以这张卡带形象 + 两张表情：
    // 触发词挑假后端每轮回复里都有的那句话，出图时才稳定命中。
    card('c-shot-1', '属性测试角色', {
      description: '属性测试角色的设定文本',
      tags: ['测试分类', '治愈'],
      portrait: shotArt(300, 450, 335, '角色形象'),
      expressions: [
        { name: '表情甲', keywords: ['这是加粗'], image: shotArt(640, 640, 210, '表情甲') },
        { name: '表情乙', keywords: ['这是高亮'], image: shotArt(640, 640, 20, '表情乙') }
      ],
      attributes: [
        { name: '金币', type: 'text', value: '100' },
        { name: '上衣', type: 'text', value: '布衣' },
        { name: '好感度', type: 'meter', value: '20', min: 0, max: 100, group: '关系', hint: '按剧情合理增减' }
      ]
    }),
    card('c-shot-2', '字段往返测试', { tags: ['甲', '乙'] }),
    card('c-shot-3', '粘贴测试角色'),
    card('c-shot-4', '模板测试角色', {
      attributes: [
        { name: '好感度', type: 'meter', value: '0', min: 0, max: 100, group: '关系' },
        { name: '关系阶段', type: 'text', value: '陌生', group: '关系' },
        { name: '物品', type: 'list', value: '钥匙', group: '背包' }
      ]
    }),
    card('c-shot-5', '分组测试角色', { tags: ['原神'] }),
    card('c-shot-6', '分组改名角色'),
    card('c-shot-7', '自带世界书测试', { worldbookIds: ['w-test'], worldbookEnabled: true }),
    card('c-shot-8', '选项测试角色', { optionsSpec: { count: 3, hint: '语气轻松些' } })
  ];

  // 两本书：一本有内容，一本空的 —— 卡片上的「N 条设定 · N 个角色 / N 条设定」两种写法都看得到
  store.worldbooks.push({ id: 'w-shot-2', name: '新世界书', entries: [], characters: [], opening: '' });
}

if (SHOT_ONLY) seedForShots();

const calls = []; // 记录渲染层请求过的写操作，方便排查
let chatPayloads = []; // 每次发给模型的完整消息（按顺序留着，供宿主侧断言用）
// 预设导入的「待发文件」队列：预先塞几批，点一次导入消费一批。
// 真实现里这来自用户选的文件，测试没有文件框，所以改成预先摆好。
// 顺序要对上 smoke-renderer.js 里那两个导入场景的先后。
let presetImportQueue = [
  {
    presets: [
      {
        name: '导入的预设甲',
        description: '这是说明，不该混进正文',
        metadata: { systemPromptContent: '导入的正文甲。' },
        tags: ['导入']
      },
      { name: '导入的预设乙', content: '导入的正文乙。' }
    ],
    errors: []
  },
  {
    presets: [{ name: '导入的预设丙', content: '丙的正文。' }],
    errors: ['坏文件.json：不是合法的 JSON']
  }
];
let lastExport = null; // 最后一次「导出」交给主进程的东西
const exportedPayloads = []; // 按顺序留所有导出，宿主侧断言用
const imageRequests = []; // 生图请求参数
const ragRequests = []; // 语义检索请求参数

function remember(channel, payload) {
  calls.push(channel);
  if (channel === 'characters:save' && payload && Array.isArray(payload.worldbooks)) {
    store.worldbooks = clone(payload.worldbooks);
  }
}

function registerStubs() {
  // --- 设置 ---
  // 语义检索：不调真接口，但**排序用的是真的 rankBySimilarity**。
  // 假的「向量」按关键词落在哪个桶来构造，这样相似度是可控、可预期的：
  //   提到「泰坦 / 那些神」的落第 0 维，提「门 / 钟」的落第 1 维……
  // 于是「问『那些神』→ 捞出写了『十二泰坦』的设定」这件事是真排序算出来的。
  const fakeEmbed = (text) => {
    const t = String(text || '');
    return new Float32Array([
      /泰坦|那些神|神仙/.test(t) ? 1 : 0,
      /门|钟/.test(t) ? 1 : 0,
      /金币|钱/.test(t) ? 1 : 0,
      0.1
    ]);
  };

  ipcMain.handle('rag:recall', (_event, payload) => {
    remember('rag:recall');
    ragRequests.push(clone(payload));

    const req = payload || {};
    const convo = store.conversations.find((c) => c.id === req.convoId);

    // 候选收集用真实现（main/vectors.js 里的纯函数）—— 连「只捞绑定的书」
    // 和「跳过最近几条」这两条规则也一起验了
    const candidates = collectCandidates({
      messages: convo ? convo.messages : [],
      recentCount: req.recentCount,
      books: store.worldbooks,
      worldbookIds: req.worldbookIds
    }).map((c) => ({ ...c, vector: fakeEmbed(c.text) }));

    const ranked = rankBySimilarity(fakeEmbed(req.query), candidates, {
      topK: req.topK,
      minScore: req.minScore
    });

    return {
      ok: true,
      items: ranked.map((r) => ({
        kind: r.kind,
        title: r.title || '',
        role: r.role || '',
        text: r.text,
        score: Number(r.score.toFixed(4))
      })),
      embedded: 0,
      indexed: candidates.length,
      total: candidates.length
    };
  });

  ipcMain.handle('settings:get', () => ({
    settings: clone(store.settings),
    models: [],
    presets: []
  }));
  ipcMain.handle('settings:save', (_event, patch) => {
    remember('settings:save', patch);
    Object.assign(store.settings, patch || {});
    return clone(store.settings);
  });
  ipcMain.handle('settings:test', () => ({ ok: true, models: ['test-model'] }));
  ipcMain.handle('models:list', () => ({ models: ['test-model'] }));

  // --- 会话 ---
  ipcMain.handle('conversations:get', () => clone({ conversations: store.conversations, activeId: store.activeId }));
  ipcMain.handle('conversations:save', (_event, payload) => {
    remember('conversations:save', payload);
    if (payload && Array.isArray(payload.conversations)) store.conversations = clone(payload.conversations);
    if (payload && 'activeId' in payload) store.activeId = payload.activeId;
    return { ok: true };
  });
  ipcMain.on('conversations:save-sync', (_event, payload) => {
    remember('conversations:save-sync', payload);
    if (payload && Array.isArray(payload.conversations)) store.conversations = clone(payload.conversations);
  });

  // --- 角色库（和 main.js 一样：一次调用可能同时带 worldbooks）---
  ipcMain.handle('characters:get', () => clone({ characters: store.characters }));
  ipcMain.handle('characters:save', (_event, payload) => {
    remember('characters:save', payload);
    // 过一遍真正的归一化 —— 白名单漏字段这种事只有跑真代码才测得出来
    if (payload && Array.isArray(payload.characters)) {
      store.characters = clone(payload.characters.map((c) => normalizeCharacter(c)));
    }
    if (payload && Array.isArray(payload.worldbooks)) store.worldbooks = clone(payload.worldbooks);
    return { ok: true };
  });
  ipcMain.on('characters:save-sync', (_event, payload) => {
    remember('characters:save-sync', payload);
    if (payload && Array.isArray(payload.characters)) {
      store.characters = clone(payload.characters.map((c) => normalizeCharacter(c)));
    }
    if (payload && Array.isArray(payload.worldbooks)) store.worldbooks = clone(payload.worldbooks);
  });
  // 导入按钮本身还是桩：界面点「导入」会弹系统文件框，测试里没法点。
  // 但导入链路的**真代码**已经被覆盖到了 ——
  //   · 编排（读文件→解析→自动绑定）：probeImport 用真 PNG 字节喂 main/import-files.js
  //   · 形状识别 / 归一化：main/card-import.js，同一份
  //   · 导出→导入的真往返：probeExports 用渲染层交出来的真实 PNG 字节
  //   · 重发 id 时改写角色→世界书的绑定：smoke-renderer 里动态 import 真模块
  // 这里返回 canceled，是为了让界面那条路径保持「用户取消」的默认行为。
  ipcMain.handle('characters:import', () => ({ canceled: true }));

  // --- 世界书 ---
  // 过一遍**真正的**落盘归一化 —— 和 main.js 的 worldbooks:save 跑同一份。
  // 以前这里只是 clone 一下就存，所以「世界书存盘再读回来字段会不会丢」
  // 在自动化里是空的（recursive / opening / characters 都是白名单字段，
  // 漏一个就会被静默重置）。
  const normalizeStoredWorldbook = createWorldbookNormalizer({
    makeId: (() => {
      let n = 0;
      return () => `w-smoke-${(n += 1)}`;
    })(),
    normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
  });

  ipcMain.handle('worldbooks:get', () => clone({ worldbooks: store.worldbooks }));
  ipcMain.handle('worldbooks:save', (_event, payload) => {
    remember('worldbooks:save', payload);
    if (payload && Array.isArray(payload.worldbooks)) {
      store.worldbooks = clone(payload.worldbooks.map((w) => normalizeStoredWorldbook(w)));
    }
    return { ok: true };
  });
  ipcMain.on('worldbooks:save-sync', (_event, payload) => {
    remember('worldbooks:save-sync', payload);
    if (payload && Array.isArray(payload.worldbooks)) {
      store.worldbooks = clone(payload.worldbooks.map((w) => normalizeStoredWorldbook(w)));
    }
  });
  // 世界书匹配用**真实现**（main/worldbook-match.js），这样递归扫描、
  // 副关键词、概率这些逻辑测的是真代码。这里只补主进程 handler 里那段
  // 「取最近 N 条拼成扫描文本」——它本来就是十来行拼字符串。
  ipcMain.handle('worldbooks:preview', (_event, payload) => {
    const request = payload || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];

    let scanDepth = Number(request.scanDepth);
    if (!isFinite(scanDepth) || scanDepth <= 0) scanDepth = 6;
    scanDepth = Math.min(50, Math.floor(scanDepth));

    const usable = messages.filter((m) => m && typeof m.content === 'string' && String(m.content).trim());
    const scanText = usable
      .slice(-scanDepth)
      .map((m) => String(m.content))
      .join('\n');

    const wanted = Array.isArray(request.worldbookIds) ? request.worldbookIds : [];
    const entries = [];
    for (const book of store.worldbooks) {
      if (!wanted.includes(book.id)) continue;
      for (const entry of book.entries || []) {
        entries.push({ ...entry, worldbookId: book.id, worldbookName: book.name });
      }
    }

    const matched = matchWorldbookEntries(entries, scanText, { recursiveDepth: request.recursiveDepth });

    return {
      total: entries.length,
      scanDepth,
      rounds: matched.rounds,
      recursiveCount: matched.recursiveCount,
      hits: matched.hits.map((e) => ({
        id: e.id,
        title: e.title,
        worldbookName: e.worldbookName,
        order: e.order,
        recursive: e.recursive === true,
        length: String(e.content).length
      })),
      section: formatWorldbookSection(matched.hits)
    };
  });

  // --- 预设 ---
  // 和世界书一样，过一遍**真正的**落盘归一化（main/presets.js）。白名单漏字段、
  // 「正文只认 content / metadata.systemPromptContent 而不回落到 description」
  // 这类规则都在归一层，假后端只 clone 就会漏测。
  //
  // get 也要归一化 —— 真实现是 main/store.js 的 loadPresets() 读盘时过一遍。
  // 只让 save 归一化的话，「别人分享的导入形态」（正文住 metadata.systemPromptContent、
  // description 只是说明）在界面上会明文不认，测试却全绿。
  ipcMain.handle('presets:get', () => clone({ presets: store.presets.map((p) => normalizePreset(p)) }));
  ipcMain.handle('presets:save', (_event, payload) => {
    remember('presets:save', payload);
    if (payload && Array.isArray(payload.presets)) {
      store.presets = clone(payload.presets.map((p) => normalizePreset(p)));
    }
    return { ok: true };
  });
  ipcMain.on('presets:save-sync', (_event, payload) => {
    remember('presets:save-sync', payload);
    if (payload && Array.isArray(payload.presets)) {
      store.presets = clone(payload.presets.map((p) => normalizePreset(p)));
    }
  });

  // 导入：不弹真文件框，改由测试预先塞好一批「文件里读出来的东西」。
  // ⚠️ 这里也要过 normalizePreset —— 真实现就是这么干的（main/ipc.js 的
  //    presets:import），不过一遍就等于放过了「导入别人分享的格式」这条链路。
  ipcMain.handle('presets:import', () => {
    remember('presets:import');
    if (!presetImportQueue.length) return { canceled: true, presets: [], errors: [] };
    const queued = presetImportQueue.shift();
    return clone({
      canceled: false,
      presets: (queued.presets || []).map((p) => normalizePreset(p)),
      errors: queued.errors || []
    });
  });

  // --- 图片 / 杂项 ---
  // 生图桩沿用这张 1×1 PNG（只验链路通不通，尺寸无所谓）
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 「选一张图」返回一张真的 1200×1800 图（2:3，和形象的画幅一致）。裁剪那条链路会按
  // **原图实际像素**决定输出尺寸（原图不够大就不放大），拿 1×1 的图去测等于所有输出都是
  // 1px，尺寸根本验不了。
  // 用 SVG 而不是 PNG：同样是张能解码的真图，但尺寸写在属性里，改起来一行的事。
  const PICK_IMAGE =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">' +
        '<rect width="1200" height="1800" fill="#dfe7f5"/>' +
        '<rect width="600" height="1800" fill="#c3d2ea"/>' +
        '<circle cx="600" cy="560" r="220" fill="#9db4d8"/>' +
        '</svg>'
    );
  ipcMain.handle('images:pick', () => ({ canceled: false, dataUrl: PICK_IMAGE }));

  // 批量导入表情图：六个「文件名里带情绪词」的假文件，读回同一张真图。
  // 前三个用英文、后三个用中文 —— 渲染层认情绪的两种输入都要跑到。
  // 最后一张「羞怯」是 shy 的中文别名，会和第一张撞同一个情绪键，用来验去重。
  const BATCH_EXPR_FILES = [
    { path: 'C:\\smoke\\lucia_a3_shy.png', name: 'Lucia_A3_shy_transparent.png' },
    { path: 'C:\\smoke\\lucia_a2_smile.png', name: 'Lucia_A2_smile_transparent.png' },
    { path: 'C:\\smoke\\lucia_a5_panicked.png', name: 'Lucia_A5_panicked_transparent.png' },
    { path: 'C:\\smoke\\cn_4.png', name: '露西娅_惊讶_透明.png' },
    { path: 'C:\\smoke\\cn_5.png', name: '露西娅_气愤_透明.png' },
    { path: 'C:\\smoke\\cn_6.png', name: '露西娅_羞怯_透明.png' }
  ];
  ipcMain.handle('images:pick-many', (_event, options) => {
    if (options && options.directory) return { canceled: false, files: BATCH_EXPR_FILES };
    return { canceled: true, files: [] };
  });
  ipcMain.handle('images:read', (_event, filePath) => {
    const hit = BATCH_EXPR_FILES.some((f) => f.path === filePath);
    if (!hit) return { dataUrl: '', error: '不在本次选中的文件里' };
    return { dataUrl: PICK_IMAGE, error: '' };
  });

  // 生图：记下请求参数（要验它用的是「生图」那组配置，不是聊天模型），
  // 返回一张真的 1×1 PNG，让渲染层真实的「解码 → 压缩 → 存进会话」链路跑一遍
  ipcMain.handle('images:generate', (_event, payload) => {
    remember('images:generate');
    imageRequests.push(clone(payload));
    return { ok: true, dataUrl: TINY_PNG, model: (payload && payload.model) || '' };
  });
  ipcMain.handle('util:copy', () => true);
  ipcMain.handle('util:openPath', () => true);

  // 「导出」：不弹真的保存框，但把渲染层交上来的东西原样收下 ——
  // 宿主侧再拿它跑一遍真正的「写 PNG → 读 PNG」往返
  ipcMain.handle('util:saveFile', (_event, payload) => {
    remember('util:saveFile');
    lastExport = clone(payload);
    exportedPayloads.push(clone(payload));
    return { canceled: false, filePath: 'C:\\fake\\' + ((payload && payload.fileName) || 'export') };
  });

  // --- 聊天：假装模型回了一句话，并且真的走一遍流式通道 ---
  ipcMain.handle('chat:stop', () => true);
  // 「请求记录」：读/清都走真模块（main/request-log.js），只是没真的发网络请求
  ipcMain.handle('chat:requests', () => ({ entries: listRequests(), max: MAX_LOGGED_REQUESTS }));
  ipcMain.handle('chat:requests:clear', () => {
    clearRequests();
    return true;
  });
  // 每次回复带个序号 —— 不然「重新生成」出来的候选和原来那条一模一样，
  // 测不出「到底是哪一条」
  let replySeq = 0;
  let aiGenSeen = 0; // 认出来的 AI 生成请求数（诊断用）
  ipcMain.handle('chat:send', async (event, payload) => {
    remember('chat:send');
    chatPayloads.push(clone((payload && payload.messages) || []));
    const requestId = (payload && payload.requestId) || 'req-smoke';
    const model = (payload && payload.model) || 'test-model';

    // 真 handler 是在 main/http.js 的 onRequest 里留这一份的（见 probeRequestLog）。
    // 假后端不发网络请求，所以照着那个形状补一条，页面侧的「请求记录」弹窗才有料可看。
    recordRequest({
      requestId,
      providerName: '冒烟假后端',
      url: 'https://example.invalid/v1/chat/completions',
      body: {
        model,
        messages: clone((payload && payload.messages) || []),
        stream: true,
        temperature: 0.7,
        max_tokens: 8192,
        top_p: 0.95
      }
    });

    // ⚠️ 判定必须只看「当前这一轮」，不能扫整段历史 ——
    // 这几个场景共用同一个会话，扫历史的话，前一个场景留下的关键词会污染
    // 后面所有请求（症状：新场景莫名其妙走了「只思考」那条分支）。
    //
    // 当前轮 = 最后一条 user 消息；若它后面还跟着自动重试的引导语（它是重试请求），
    // 再往回带一条原始输入 —— 这样「重试该失败」和「重试该救回」两种情形都能表达。
    // 自动续写同理：它是「在真实输入后面追一轮续写引导」，不回溯就认不出场景。
    const isRetryNudge = (s) => s.includes('直接把这一轮该写的正文完整写出来');
    const isContinueNudge = (s) => s.includes('接着你上一条回复继续往下写');
    // 状态表漏写时的补问语（panel.js 的 PANEL_PROMPT_NUDGE）。它也属于「引导语」，
    // 得回溯到真实输入，否则这一轮的关键词（「漏状态表」）就看不到了。
    // 认的是「只补这一件事」这个特征串 —— 补问语改过措辞（2026-09-30 加强成
    // 「现在只补这一件事…」），别拿开头那句当锚，改文案时就断了。
    const isPanelNudge = (s) => s.includes('只补这一件事');
    const isNudge = (s) => isRetryNudge(s) || isContinueNudge(s) || isPanelNudge(s);
    const allMsgs = (payload && payload.messages) || [];
    let turn = '';
    for (let i = allMsgs.length - 1; i >= 0; i -= 1) {
      const m = allMsgs[i] || {};
      if (m.role !== 'user') continue;
      const text = String(m.content || '');
      turn = `${text}\n${turn}`;
      if (isNudge(text)) continue; // 引导语 → 继续往回找真实的输入
      break;
    }
    const retryNudged = isRetryNudge(turn);
    const continuedNudged = isContinueNudge(turn);
    const panelNudged = isPanelNudge(turn);

    // 「AI 生成角色」：它和聊天共用 chat:send，靠 system 里的特征串认出来。
    // 用 system 而不是 user 是因为那两段的 user 文案由调用方拼，容易改；
    // 而 system 的措辞就在 aiGen.js 的常量里，改的时候一眼能看到这里。
    //
    // ⚠️ 这个桩**必须能返回真东西**，否则「界面没反应」这类问题会伪装成别处失败，
    //    而且返回空和返回垃圾都表现为「生成后字段是空的」，很难分辨。
    const allText = allMsgs.map((m) => String((m && m.content) || '')).join('\n');
    if (allText.includes('你是一位角色设定师')) {
      // 认出来的 AI 生成请求数 —— 只在诊断时打出来（见下面的 TMP 输出），
      // 用来区分「请求没发出来」和「发出来了但没认出来」。
      aiGenSeen += 1;
      // 世界书那条路会把书的设定一起塞进 system —— 用它验证「NPC 描述确实按书生成」
      const knownBook = allText.includes('【世界：');
      // 「烂 JSON」场景：模型多写了一句开场白、还把 JSON 包在 ``` 里。
      // 解析器要能剥掉围栏、切出花括号块，正常生成出角色。
      const messy = allText.includes('冒烟：烂JSON');
      // 角色库那侧的「背景 / 基调」是可选的：填了才会拼进 system。
      // 名字跟着基调变 —— 对不上就说明那段没注入。
      const withBrief = allText.includes('【背景 / 基调】');
      const payloadText = messy
        ? '好的，我按你说的写了一个：\n\n```json\n{"name":"油烟贩子","description":"' +
          '常在酒馆后巷支摊卖炸物的小贩，围裙上全是油渍，嗓门大。",' +
          '"personality":"见谁都自来熟，爱打听闲话换点好处。",' +
          '"tags":["市井","NPC"],"attributes":[{"name":"好感度","type":"number","value":10,"mode":"dynamic"}]}\n```\n\n需要我再调整吗？'
        : JSON.stringify({
            name: knownBook ? '后厨帮工' : withBrief ? '便利店店员' : '守夜人',
            description: knownBook
              ? '酒馆后厨的帮工，负责洗碗和备料，手上常年有烫伤的疤。'
              : withBrief
                ? '深夜便利店的店员，值夜班时总把收音机开得很轻。'
                : '一个总在深夜值班的人，习惯把话咽回去一半。',
            personality: '话少，但记得住每个人点过什么。',
            tags: ['冒烟', '测试'],
            attributes: [
              { name: '好感度', type: 'number', value: 5, mode: 'dynamic' },
              { name: '身份', type: 'text', value: '帮工', mode: 'static' }
            ]
          });
      for (const piece of payloadText.match(/[\s\S]{1,40}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(2);
      }
      return {
        ok: true,
        requestId,
        model,
        content: payloadText,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    const askedToOnlyThink = turn.includes('只思考不回答');
    const askedThinkBurn = turn.includes('思考挤掉正文');
    const askedTruncatedBody = turn.includes('截断正文');
    const askedTruncatedForever = turn.includes('截断到底');
    const askedPanelMiss = turn.includes('漏状态表');
    const askedResumeMiss = turn.includes('续写找状态表');

    // 「漏状态表」：正文写得好好的，但整轮一个状态字段都没提 —— 状态卡"不跟着
    // 剧情走"最常见的形态。上层应当自动补问一次；补问那一次（panelNudged）
    // 才把状态表交出来。两次返回不同内容，才验得出「补问真的发生了」。
    if (askedPanelMiss) {
      const body = panelNudged
        ? '嗯，正文就写到这里。\n\n【金币】：88\n【上衣】：斗篷'
        : '冒烟测试回复：这一段正文写得挺顺，可这一轮我什么状态都没提。';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「续写找状态表」：先「只思考没落笔」（正文一个字都没有），再把正文交给
    // 「继续」补出来 —— 但续写出来的正文照样不提状态表。验证**续写路径**也会补问。
    //
    // 为什么单独测这条：主生成那条路（情形三）本来就会补问，但「只思考没落笔 →
    // 点继续」绕过了它 —— 而「状态卡一整局都不更新」的反馈正是从这条路来的。
    if (askedResumeMiss) {
      // ① 主生成（含自动重试）：只思考、不落笔。
      // 判据要同时排除「继续」和「补问」两种引导语 —— 注意 **CONTINUE_NUDGE 不进历史**，
      // 所以补问那一次请求里看不到它（continuedNudged 会是 false），光靠它区分不开。
      if (!continuedNudged && !panelNudged) {
        const thinking = '我先想想该怎么接，想着想着又扯远了……';
        for (const piece of thinking.match(/[\s\S]{1,8}/g) || []) {
          if (!event.sender.isDestroyed()) event.sender.send('chat:reasoning', { requestId, text: piece });
          await sleep(4);
        }
        return {
          ok: true,
          requestId,
          model,
          content: '',
          reasoning: thinking,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 5 },
          finishReason: 'length'
        };
      }

      // ② 「继续」补出正文（照旧不提状态表）／③ 补问才交出状态表
      const body = panelNudged
        ? '接着往下写。\n\n【金币】：55'
        : '冒烟测试回复：正文被「继续」补出来了，可这一轮照样一个状态都没提。';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「只思考不回答」：模拟推理模型把 max_tokens 全花在思考上、正文被截断的情形。
    // 只发 reasoning 增量、不发正文增量，最终返回 content 为空、reasoning 非空。
    // 连自动重试也一样失败 —— 用来验证「重试也救不回来」时的兜底提示。
    // 「思考挤掉正文」是同一情形的另一种输入，但它带自动重试引导的第二次请求
    // 会正常回复 —— 用来验证「自动重试把正文救回来」。
    if (askedToOnlyThink || (askedThinkBurn && !retryNudged)) {
      const thinking = '我在想这件事到底该怎么办，越想越觉得……';
      for (const piece of thinking.match(/[\s\S]{1,8}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:reasoning', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: '',
        reasoning: thinking,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 5 },
        // 这一路模拟的正是「思考把 max_tokens 花光、正文还没开始就被截断」，
        // 服务商会给 finish_reason='length' —— 上层据此才敢断定是长度截断。
        finishReason: 'length'
      };
    }

    // 「截断正文」：正文写了一半撞上限（真实形态是状态栏写到一半断掉）。
    // 有正文、但 finishReason 是 'length' —— 用来验证两件事：
    //   · 气泡里会挂一行说明，而不是让残缺无声地过去；
    //   · 应用会自动接着写（带续写引导语的第二次请求正常收尾）。
    // 「截断到底」是同一情形的顽固版：续写请求照样撞上限 —— 用来验证
    // 「只续有限次就停下、剩下交给用户按继续」，不会变成一个无底洞。
    if (askedTruncatedBody || askedTruncatedForever) {
      const body = continuedNudged
        ? askedTruncatedForever
          ? '又挤出来一点，还是撞上限'
          : '……自动接着写完的后半段。'
        : '冒烟测试回复：写到这儿就：';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(6);
      }
      // 续写请求里「截断正文」正常收尾（stop），其余一律仍是 length
      const stopped = continuedNudged && !askedTruncatedForever;
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        // 带 reasoning_tokens：界面要把它标在思考折叠标题和用量行上
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19, reasoning_tokens: 6 },
        finishReason: stopped ? 'stop' : 'length'
      };
    }

    // 「帮我想想」会带一条特殊的指令；这时给回几个选项，好让测试能验证解析与渲染。
    // 故意让模型「不听话」带序号和引号，测试要能容忍。
    const askedForSuggestions = ((payload && payload.messages) || []).some((m) =>
      String((m && m.content) || '').includes('替「玩家」想几个')
    );
    if (askedForSuggestions) {
      const suggestions = [
        '1. 「我想先喝一杯，压压惊」',
        '2. 我直接问他叫什么名字',
        '3. 我假装什么都没听见，继续吃',
        '4. 我站起来准备走',
        '5. 这条应该被丢掉（只取前 4 个）'
      ].join('\n');

      for (const piece of suggestions.match(/[\s\S]{1,20}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }

      return {
        ok: true,
        requestId,
        model,
        content: suggestions,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    replySeq += 1;
    let CONTENT = `冒烟测试回复 #${replySeq}：我收到了。**这是加粗**，==这是高亮==。`;
    let pieces = [`冒烟测试回复 #${replySeq}`, '：我收到了。', '**这是加粗**，', '==这是高亮==。'];


    // 开了「剧情选项」的会话：多回一行状态栏 + 一行选项。
    // 顺带故意写几个「不听话」的地方（编号、引号、多余空格、重复项），
    // 测试要能容忍 —— 真模型就是会这么写。
    const askedForOptions = ((payload && payload.messages) || []).some((m) =>
      String((m && m.content) || '').includes('【剧情选项】')
    );    if (askedForOptions) {
      // 故意不带方括号（写成「剧情选项：」而不是「【剧情选项】：」）——
      // 指令是让模型带方括号的，但真模型经常漏，解析要两边都认。
      //
      // ⚠️ 但这两种形态有个关键区别：**带方括号的那行长得和面板字段一模一样**
      // （行首【】），不带方括号的则天然匹配不上 PANEL_LINE_RE。
      // 所以只测不带方括号的形态，是测不到「选项被误收成面板字段」这个 bug 的
      // （见 renders 场景里那两条断言）—— 这里两种都发出来。
      const optionsLine =
        '剧情选项：1.「我想先喝一杯，压压惊」 / 我直接问他叫什么名字 / ' +
        '3） 我假装什么都没听见，继续吃 / 我想先喝一杯，压压惊 / 这条应该被丢掉（只取前几个）';
      const bracketedOptionsLine = '【剧情选项】：我想先喝一杯，压压惊 / 我直接问他叫什么名字 / 我假装什么都没听见';
      CONTENT = `${CONTENT}\n\n【好感度】：63/100\n${optionsLine}\n${bracketedOptionsLine}`;
      pieces = [...pieces, '\n\n【好感度】：63/100\n', optionsLine, '\n', bracketedOptionsLine];
    }

    // 用户发「表情标签」时，回复末尾带一个 <emo> 标签。
    // 顺带验「标签优先于关键词」：正文里同时有「这是加粗」（会命中「表情甲」），
    // 标签说的是 shy，最终该以标签为准。按 role 过滤，别被提示词里的 <emo> 字样误触发。
    const askedEmoTag = ((payload && payload.messages) || []).some(
      (m) => m && m.role === 'user' && String(m.content || '').includes('表情标签')
    );
    if (askedEmoTag) {
      CONTENT = `${CONTENT}\n<emo>shy</emo>`;
      pieces = [...pieces, '\n<emo>shy</emo>'];
    }

    for (const piece of pieces) {
      if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
      await sleep(8);
    }

    return {
      ok: true,
      requestId,
      model,
      content: CONTENT,
      reasoning: '',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        // 带重试引导语的这次请求 = 「思考挤掉正文」的第二次尝试：给它带上
        // reasoning_tokens，好覆盖「思考量跨请求累加、并标在消息标题上」。
        ...(retryNudged ? { reasoning_tokens: 12 } : {})
      },
      finishReason: 'stop'
    };
  });
}

// ---------------------------------------------------------------------------
//  跑测试
// ---------------------------------------------------------------------------
function report(result, consoleErrors, consoleWarnings, crashed) {
  const results = (result && result.results) || [];
  const notes = (result && result.notes) || [];

  const failed = results.filter((r) => !r.pass);
  const width = results.reduce((m, r) => Math.max(m, r.name.length), 0);

  console.log('');
  console.log('────────────── 冒烟测试 ──────────────');

  let current = '';
  for (const r of results) {
    // 场景名是「场景 · 断言」的形式，切一下方便阅读
    const group = r.name.split(' · ')[0];
    if (group !== current) {
      current = group;
      console.log(`\n  【${group}】`);
    }
    const label = r.name.includes(' · ') ? r.name.split(' · ').slice(1).join(' · ') : r.name;
    console.log(`    ${r.pass ? '✓' : '✗'} ${label.padEnd(width)}${r.pass ? '' : '   ← ' + r.detail}`);
  }

  console.log('');
  if (consoleWarnings.length) {
    console.log(`  控制台警告 ${consoleWarnings.length} 条：`);
    consoleWarnings.slice(0, 5).forEach((w) => console.log('    ! ' + w));
    console.log('');
  }
  notes.forEach((n) => console.log('  · ' + n));

  const consoleOk = consoleErrors.length === 0;
  if (!consoleOk) {
    console.log('');
    console.log(`  控制台报错 ${consoleErrors.length} 条：`);
    consoleErrors.slice(0, 10).forEach((e) => console.log('    ! ' + e));
  }

  console.log('');
  const passed = results.length - failed.length;
  console.log(`  断言：${passed}/${results.length} 通过` + (failed.length ? `，${failed.length} 条失败` : ''));
  console.log(`  控制台报错：${consoleErrors.length} 条`);
  console.log(`  写操作记录：${calls.length} 次（${[...new Set(calls)].join(', ')}）`);
  if (crashed) console.log(`  ⚠ ${crashed}`);

  const ok = failed.length === 0 && consoleOk && !crashed;
  console.log('');
  console.log(ok ? '  ✅ 冒烟测试通过' : '  ❌ 冒烟测试失败');
  console.log('──────────────────────────────────────');
  console.log('');
  return ok;
}

/**
 * 悬停验证：卡片上的删除按钮必须「鼠标移上去才浮出来」。
 *
 * 为什么放宿主侧：:hover 只认真实指针，页面里 dispatchEvent 不算；隐藏窗口
 * 也不算 hover，所以走 CDP 的 CSS.forcePseudoState 强制加 :hover。
 * 注意：删除按钮有 transition，隐藏窗口不产生动画帧、过渡永不推进，
 * 所以先临时关掉过渡让计算值直接跳到位（真实窗口里过渡正常播放）。
 */
async function probeHover(win, result) {
  const probe = result && result.hoverProbe;
  if (!probe) return;

  const run = (code) => win.webContents.executeJavaScript(code);
  const readOpacity = () =>
    run("getComputedStyle(document.querySelector('#char-page-grid .char-card .char-card-del')).opacity");

  const before = await readOpacity();

  let after = before;
  let note = '';
  const dbg = win.webContents.debugger;

  try {
    // 关掉过渡：隐藏窗口里过渡不会推进，计算值会永远停在起点
    await run("document.querySelector('#char-page-grid .char-card .char-card-del').style.transition = 'none'");

    dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');

    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#char-page-grid .char-card'
    });
    if (!nodeId) throw new Error('找不到角色卡节点');

    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(150);
    after = await readOpacity();

    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    dbg.detach();

    // 复原，别影响后续（虽然之后也没别的断言了）
    await run("document.querySelector('#char-page-grid .char-card .char-card-del').style.transition = ''");
  } catch (err) {
    note = '（CDP 出错：' + ((err && err.message) || err) + '）';
    try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* 忽略 */ }
  }

  result.results.push({
    name: '角色库：卡片上删除 · 鼠标移上去才会浮出来',
    pass: before === '0' && after === '1',
    detail: `移入前 opacity=${before}，移入后 opacity=${after}${note}`
  });
}

/**
 * 看大图浮层：用**真实鼠标**依次点工具条按钮、点图片、点背景。
 *
 * 为什么非得走真实输入：浮层把 pointerdown 挂在整层上做拖动，顺手对整层调了
 * setPointerCapture。指针一旦被夺走，浏览器算出来的 click 目标就变成「整层」而不是
 * 按钮 —— 按钮的 click 收不到，还会被当成「点了背景」把浮层一并关掉。
 * 这套行为只在真实指针下出现，页面里 dispatchEvent 复现不出来。
 */
async function probeLightboxClick(win, result) {
  const run = (code) => win.webContents.executeJavaScript(code);
  const read = () =>
    run(`(() => {
      const lb = document.getElementById('lightbox');
      const img = lb && lb.querySelector('.lightbox-img');
      return { open: !!lb, transform: (img && img.style.transform) || '' };
    })()`);
  const scaleOf = (t) => {
    const m = /scale\(([\d.]+)\)/.exec(t || '');
    return m ? Number(m[1]) : 0;
  };

  // 打开灯箱，顺手把「＋」按钮和图片的中心坐标量出来
  const spots = await run(`(async () => {
    const $$ = (s) => Array.from(document.querySelectorAll(s));
    const $ = (s) => document.querySelector(s);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const view = $('#view-chars');
    if (!view || view.classList.contains('hidden')) {
      const b = $('#btn-chars');
      if (b) b.click();
      await nap(400);
    }
    const card = $$('#char-page-grid .char-card').find((c) => c.querySelector('.char-card-avatar.clickable'));
    if (!card) return null;
    card.querySelector('.char-card-avatar.clickable').click();
    for (let i = 0; i < 60 && !$('#lightbox'); i++) await nap(50);
    const btn = $('#lightbox-in');
    const img = $('#lightbox .lightbox-img');
    if (!btn || !img) return null;
    const mid = (n) => {
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    return { btn: mid(btn), img: mid(img), fit: mid($('#lightbox-reset')) };
  })()`);

  if (!spots) {
    result.results.push({ name: '看大图：真实鼠标点击', pass: false, detail: '页面里没能打开灯箱' });
    return;
  }

  const dbg = win.webContents.debugger;
  let note = '';
  let afterBtn = null;
  let afterImg = null;
  let afterBackdrop = null;

  try {
    dbg.attach('1.3');
    const clickAt = async (x, y) => {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
      });
      await sleep(40);
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
      });
      await sleep(180);
    };

    const before = await read();
    await clickAt(spots.btn.x, spots.btn.y);
    afterBtn = await read();

    result.results.push({
      name: '看大图：真实鼠标点「＋」能放大，且不会把浮层关掉',
      pass: afterBtn.open && scaleOf(afterBtn.transform) > scaleOf(before.transform),
      detail: `点前 scale=${scaleOf(before.transform)}，点后 scale=${scaleOf(afterBtn.transform)}，浮层${
        afterBtn.open ? '还在' : '被关掉了'
      }${note}`
    });

    // 点图片本身不该关：只有按在图片外那圈上才算「点背景」
    await clickAt(spots.img.x, spots.img.y);
    afterImg = await read();
    result.results.push({
      name: '看大图：真实鼠标点图片本身不会误关',
      pass: afterImg.open,
      detail: `点完浮层${afterImg.open ? '还在' : '被关掉了'}${note}`
    });

    // 「适应 / 实际大小」那个切换按钮也得用真实鼠标点一遍 —— 它和「＋」同处一条
    // 工具条，被指针捕获吞掉的毛病是一样的。
    const readFit = () =>
      run(`(() => {
        const b = document.getElementById('lightbox-reset');
        return b ? { cls: b.className, label: b.getAttribute('aria-label') || '' } : null;
      })()`);
    const fitBefore = await readFit();
    await clickAt(spots.fit.x, spots.fit.y);
    const fitAfter = await readFit();
    const imgAfterFit = await read();
    const toggled = !!fitBefore && !!fitAfter && fitBefore.cls !== fitAfter.cls;
    result.results.push({
      name: '看大图：真实鼠标点「适应/实际大小」能切档，且不会把浮层关掉',
      pass: imgAfterFit.open && toggled,
      detail:
        `切前 ${fitBefore && fitBefore.label}（${fitBefore && fitBefore.cls}）→ ` +
        `切后 ${fitAfter && fitAfter.label}（${fitAfter && fitAfter.cls}），浮层${imgAfterFit.open ? '还在' : '被关掉了'}${note}`
    });
    // 切回适应，好让后面「点背景关闭」那步从 1 倍开始
    await clickAt(spots.fit.x, spots.fit.y);
    await sleep(80);

    // 回到 1 倍再点左上角空白 —— 这才是该关的时候
    await run("document.getElementById('lightbox-reset')?.click(); true");
    await sleep(80);
    await clickAt(6, 6);
    afterBackdrop = await read();
    result.results.push({
      name: '看大图：真实鼠标点背景能关掉',
      pass: !afterBackdrop.open,
      detail: `点完浮层${afterBackdrop.open ? '还开着' : '关掉了'}${note}`
    });
  } catch (err) {
    note = '（CDP 出错：' + ((err && err.message) || err) + '）';
    result.results.push({ name: '看大图：真实鼠标点击', pass: false, detail: note });
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch (e) {
      /* 忽略 */
    }
    // 别把浮层留在页面上，后面还有截图
    try {
      await run("document.getElementById('lightbox-close')?.click(); true");
    } catch (e) {
      /* 忽略 */
    }
  }
}

/**
 * 注入内容验证：看**真正发给模型的消息**里有没有该有的东西。
 *
 * 这是唯一能确认「注入真的生效」的地方 —— 页面上看不出模型收到了什么，
 * 而这条链路（角色卡属性 → 会话面板 → 系统提示词）正是这个功能的全部意义。
 *
 * 注意：不看「最后一条」，而是把每次请求都收进来找。
 * 因为世界里没写开场白时，进世界会立刻多发一次「生成开局」的请求，
 * 那次是不带状态面板的 —— 只认最后一条会误判。
 */
function probeInjection(result) {
  if (!result) return;

  // 状态表注入块那句「归属声明」——用它认面板段在不在，**不用** `[当前状态]`。
  // 那个方括号抬头本身就是要修掉的毛病：实测（真实 API）有安全对齐的模型会把它
  // 读成「外部塞进来的一段指令」并明确拒绝执行（thinking 里写着
  // "…an artifact/injection. I should not execute it"），整轮一个状态字段都不写。
  const PANEL_HEAD = '这是本局的状态表';
  const panelFrom = (b) => {
    const i = b.indexOf(PANEL_HEAD);
    return i >= 0 ? i : 0;
  };

  const blobs = chatPayloads.map((msgs) => msgs.map((m) => String((m && m.content) || '')).join('\n'));

  const panelOk = blobs.some(
    (b) => b.includes(PANEL_HEAD) && b.includes('【金币】：100') && b.includes('【上衣】：布衣')
  );
  result.results.push({
    name: '属性：注入给模型的消息里带上了状态面板',
    pass: panelOk,
    detail: panelOk ? '' : `翻了 ${blobs.length} 次请求都没找到完整面板`
  });

  // 抬头必须是「由你在每轮回复的末尾维护」这种归属声明，而不是 `[当前状态]` 块标记；
  // 同时末尾要有格式承诺（行怎么写、必须落在正文之后）。这两条一起决定模型写不写。
  const promptShapeOk = blobs.some(
    (b) => b.includes(PANEL_HEAD) && b.includes('由你在每轮回复的末尾维护') && b.includes('必须写在正文末尾')
  );
  result.results.push({
    name: '属性：面板段用「你在维护」的口吻，并带末尾格式承诺',
    pass: promptShapeOk,
    detail: promptShapeOk ? '' : '注入里没找到归属声明 / 末尾格式承诺'
  });
  const noMarker = !blobs.some((b) => b.includes('[当前状态]'));
  result.results.push({
    name: '属性：面板段不再带 [当前状态] 这种「外部注入」标记',
    pass: noMarker,
    detail: noMarker ? '' : '注入里又出现了 [当前状态] —— 模型会把它当成外部注入拒掉'
  });

  // 提醒段要落在**整批 system 的最后**（离生成位置最近）。角色卡的
  // post_history_instructions 排在面板段之后时，最容易把状态表的要求挤掉 ——
  // 实测同一输入下「漏写状态表」的主因就是这个位置。
  const reminderLast = chatPayloads.some((msgs) => {
    const sys = msgs.filter((m) => m && m.role === 'system');
    const last = sys.length ? String(sys[sys.length - 1].content || '') : '';
    return last.startsWith('（提醒：这一次回复的最后');
  });
  result.results.push({
    name: '属性：状态表的末尾提醒是最后一条 system',
    pass: reminderLast,
    detail: reminderLast ? '' : '最后一条 system 不是那句提醒'
  });

  // 模型整轮没写状态表时的补问：请求的最后一条 user 必须就是那句补问语。
  // 假后端在「漏状态表」场景里第一次故意不回状态表，靠这条断言确认
  // 「程序真的补问了一次」，而不只是碰巧拿到了值。
  // 认「只补这一件事」这个特征串（panel.js 的 PANEL_PROMPT_NUDGE 同理），
  // 别拿会被改写的句子开头当锚。
  const nudgedPayload = chatPayloads.find((msgs) => {
    const users = msgs.filter((m) => m && m.role === 'user');
    const last = users.length ? String(users[users.length - 1].content || '') : '';
    return last.includes('只补这一件事');
  });
  result.results.push({
    name: '属性：漏写状态表时程序补问了一次',
    pass: !!nudgedPayload,
    detail: nudgedPayload ? '' : '没找到带补问引导语的请求'
  });

  // 带范围的数值字段：注入时要告诉模型范围，并明确「超了会被拉回」。
  // 只说「好感度：20」的话，模型不知道 0~100 这回事，写 150 也没人管。
  const rangeBlob = blobs.find((b) => b.includes('【好感度】：20'));
  const rangeOk = !!rangeBlob && rangeBlob.includes('0~100') && rangeBlob.includes('按剧情合理增减，单轮不超过 10');
  result.results.push({
    name: '属性：数值字段的范围和变化规则被注入给模型',
    pass: rangeOk,
    detail: rangeOk
      ? ''
      : rangeBlob
        ? `找到了面板行但缺范围/规则：${JSON.stringify(rangeBlob.slice(panelFrom(rangeBlob), panelFrom(rangeBlob) + 300))}`
        : `翻了 ${blobs.length} 次请求都没找到「【好感度】：20」`
  });
  const warnOk = !!rangeBlob && rangeBlob.includes('超出范围会被程序拉回');
  result.results.push({
    name: '属性：注入里说明了超范围会被拉回',
    pass: warnOk,
    detail: warnOk ? '' : '没找到那句提醒'
  });

  // 分组：注入给模型的状态栏里要有分组小标题，而且**不能**用【】包，
  // 否则会被自己的面板解析器当成一个名叫「关系」的字段。
  const groupBlob = rangeBlob || '';
  const hasHeader = groupBlob.includes('—— 关系 ——');
  result.results.push({
    name: '属性：分组小标题被注入给模型',
    pass: hasHeader,
    detail: hasHeader ? '' : `没找到「—— 关系 ——」：${JSON.stringify(groupBlob.slice(panelFrom(groupBlob), panelFrom(groupBlob) + 300))}`
  });
  result.results.push({
    name: '属性：分组小标题刻意不用【】（否则会被当成字段）',
    pass: hasHeader && !groupBlob.includes('【关系】'),
    detail: hasHeader && !groupBlob.includes('【关系】') ? '' : '注入里出现了【关系】形状的分组标题'
  });
  const groupNote = groupBlob.includes('不要当成字段输出');
  result.results.push({
    name: '属性：注入里交代了小标题不要当字段输出',
    pass: groupNote,
    detail: groupNote ? '' : '没找到那句交代'
  });

  // 剧情选项：开了选项的会话要收到「给几个、怎么给、额外要求」这条指令
  const optBlob = blobs.find((b) => b.includes('【剧情选项】'));
  const optOk =
    !!optBlob &&
    optBlob.includes('给出 3 个选项') &&
    optBlob.includes('语气轻松些，总有一条冒险的选择') &&
    optBlob.includes('用「 / 」隔开');
  result.results.push({
    name: '剧情选项：数量和额外要求被注入给模型',
    pass: optOk,
    detail: optOk ? '' : optBlob ? JSON.stringify(optBlob.slice(optBlob.indexOf('【剧情选项】'), optBlob.indexOf('【剧情选项】') + 200)) : `翻了 ${blobs.length} 次请求都没有选项指令`
  });

  // 没开选项的会话不该收到这条指令（否则每个会话都白烧 token）
  const suggestOnly = blobs.filter((b) => !b.includes('【剧情选项】'));
  result.results.push({
    name: '剧情选项：没开的会话不会被注入选项指令',
    pass: suggestOnly.length > 0,
    detail: `共 ${blobs.length} 次请求，其中 ${suggestOnly.length} 次没带选项指令`
  });

  const playerOk = blobs.some((b) => b.includes('【玩家角色：改过的名字】'));
  result.results.push({
    name: '进入世界：注入的是你选/改过的玩家角色',
    pass: playerOk,
    detail: playerOk ? '' : `翻了 ${blobs.length} 次请求都没找到「【玩家角色：改过的名字】」`
  });

  // 单角色对话：角色卡上的年龄必须真的进提示词（曾经漏了，AI 就把 16 岁写成 21 岁）
  const ageOk = blobs.some((b) => b.includes('【属性测试角色的基本信息】') && b.includes('年龄 18'));
  result.results.push({
    name: '单角色对话：角色的年龄/性别/种族被注入给模型',
    pass: ageOk,
    detail: ageOk ? '' : `翻了 ${blobs.length} 次请求都没找到「【属性测试角色的基本信息】…年龄 18」`
  });

  // 身份四件套也要跟着面板一起注入 —— 世界里这些是会变的
  const identityOk = blobs.some(
    (b) => b.includes('【姓名】：改过的名字') && b.includes('【年龄】：18') && b.includes('【种族】：精灵')
  );
  result.results.push({
    name: '进入世界：身份四件套被注入给模型',
    pass: identityOk,
    detail: identityOk ? '' : `翻了 ${blobs.length} 次请求都没找齐姓名/年龄/种族`
  });
}

/**
 * 预设验证。
 *
 * 「预设 = 叠在对话上的一层指令」，存下来、选上都不算数，**最后有没有拼进
 * 发给模型的消息**才是这个功能的落点 —— 而 chat:send 记下的真实 messages
 * 只有宿主侧看得到（页面里没有这条数据），所以这几条断言的宿主侧版本在这里。
 *
 * 前两条（正文来源）验证归一层认得「别人分享的导入形态」：正文住在
 * metadata.systemPromptContent 里，description 只是给人看的说明。smoke-renderer
 * 那边读的是经假后端归一化之后落盘的样子，这里读的是它拼进提示词的样子。
 */
function probePresets(result) {
  if (!result) return;

  const blobs = chatPayloads.map((msgs) => msgs.map((m) => String((m && m.content) || '')).join('\n'));

  // 绑了预设的那一轮：整块应该在，正文 + 常驻条目都在
  const presetBlob = blobs.find((b) => b.includes('【预设 · 带条目的预设】'));
  result.results.push({
    name: '预设：绑定的预设正文被拼进了提示词',
    pass: !!presetBlob && presetBlob.includes('最前面的总则。（改过了）'),
    detail: presetBlob ? '没找到正文' : `翻了 ${blobs.length} 次请求都没有【预设 · 带条目的预设】`
  });

  // 每条预设各自成一块（`【预设 · 名称】`），名字要出现在块头 ——
  // 多条一起挂的时候，光看正文分不清哪句是谁说的。
  const hasHeading = !!presetBlob && /【预设 · 带条目的预设】/.test(presetBlob);
  result.results.push({
    name: '预设：每条预设各自成一个带名字的块',
    pass: hasHeading,
    detail: hasHeading ? '' : '找不到【预设 · 带条目的预设】这个块头'
  });

  // 无关键词的条目 = 常驻，每轮都该带上
  const constOk = !!presetBlob && presetBlob.includes('这条每轮都带上。');
  result.results.push({
    name: '预设：常驻条目每轮都进提示词',
    pass: constOk,
    detail: constOk ? '' : '常驻条目的正文没进提示词'
  });

  // 有关键词但这一轮没提到的条目不该带上（否则整份预设每轮全烧一遍 token）
  const keySkipped = !!presetBlob && !presetBlob.includes('说到「暗号」才带上这条。');
  result.results.push({
    name: '预设：没命中的关键词条目不进提示词',
    pass: keySkipped,
    detail: keySkipped ? '' : '没提到的关键词条目还是被带上了'
  });

  // 说明（description / note）是给人看的，绝不能混进正文发给模型 ——
  // 这是「描述与正文分离」这条设计的底线。
  const noteLeaked = blobs.some(
    (b) => b.includes('【预设 ·') && (b.includes('测试用的说明') || b.includes('这个说明只给人看'))
  );
  result.results.push({
    name: '预设：说明不会被发给模型',
    pass: !noteLeaked,
    detail: noteLeaked ? '预设的说明混进了提示词' : ''
  });

  // 导入形态的预设（正文只在 metadata.systemPromptContent）也要能用；
  // 它这一轮没被绑上（绑的是「带条目的预设」），所以不该出现 —— 反过来说，
  // 一旦它出现了就说明绑定逻辑没生效，全场都收到了所有预设。
  const unboundLeaked = blobs.some((b) => b.includes('每一轮都要推进一个具体事件，不要停在原地。'));
  result.results.push({
    name: '预设：没绑的预设不会被带上',
    pass: !unboundLeaked,
    detail: unboundLeaked ? '没绑定到会话的预设也被拼进了提示词' : ''
  });

  // ⭐ 多选的核心断言：会话说的是「手动配成只勾一条」，
  // 那么**勾了「可全局」的那条不能偷偷跟着进来** ——
  // 「没配过就跟随全局」和「配过了就按配的来」是两回事，搞混的话
  // 用户永远关不掉某条全局预设，这正是这套设计要解决的问题。
  //
  // ⚠️ 别扫全部 payload：几十次发送发生在别的会话上，那些会话「没配过」时
  // 带上全局预设是**对的**。也**别只看最后一次** —— 这句话从前写在这里，但
  // 它是靠「预设那一轮正好是最后发的」这个巧合成立的：后来加了「请求记录」
  // 场景，它在末尾新建会话再发一条（那条会带上全局预设，完全正确），
  // 于是这条断言就误报了。**改用内容认领**：凡是被拼进了「带条目的预设」
  // 的那些请求，就是那个手动配过的会话发出去的，一条都不许夹带全局预设。
  const presetBound = blobs.filter((b) => b.includes('【预设 · 带条目的预设】'));
  const globalLeaked = presetBound.some(
    (b) => b.includes('【预设 · 全局通用预设】') || b.includes('这场对话默认带上这一条。')
  );
  result.results.push({
    name: '预设：手动配过的会话不受「可全局」预设影响',
    // 认领不到任何请求也算失败：否则这段变成空跑，等于这条断言被悄悄取消
    pass: presetBound.length > 0 && !globalLeaked,
    detail: globalLeaked
      ? `会话只勾了一条，可全局的预设还是被带上了（查了 ${presetBound.length} 次请求）`
      : presetBound.length
        ? ''
        : '没有任何请求带上「带条目的预设」—— 这条断言没法判断了'
  });

  // 采样参数：预设没设过就不该覆盖全局。这里只在「没设过」的方向断言
  // ——设过的那条要真调 API 才看得出，冒烟里验的是「不设 = 不干预」。
  const fakeEndpointSampling = chatPayloads.some((msgs) =>
    msgs.some((m) => m && m.role === 'system' && /temperature|top_p|采样/.test(String(m.content || '')))
  );
  result.results.push({
    name: '预设：采样参数走请求参数，不往消息里塞',
    pass: !fakeEndpointSampling,
    detail: fakeEndpointSampling ? '采样参数被当成文本塞进了消息' : ''
  });
}

/**
 * 导出验证。放在宿主侧的原因：渲染层把内容交给主进程之后自己就看不见了。
 *
 * 最有价值的一条是**真往返**：拿渲染层生成的 PNG 字节，用主进程真正在用的
 * pngWithTextChunk 把卡数据插进去，再用 parseCharacterCardPng 读回来 ——
 * 这两步都是真代码（main/png.js），所以「导出的卡能不能被导入」是真验过的。
 */
function probeExports(result) {
  // 按内容找，不按下标 —— 以后调整场景顺序时不会连带把断言搞错。
  // ⚠️ 世界书那条要认准「独立导出的 lorebook」：角色卡里也有 entries，
  // 而且导出的卡也可能内嵌 character_book，光看 `"entries"` 会误配到角色卡上。
  // 独立导出的书顶层是 name + entries 对象，且没有 chara_card_v2 那套字段。
  const charExport = exportedPayloads.find((p) => p.text && p.text.includes('chara_card_v2'));
  const wbExport = exportedPayloads.find((p) => {
    if (!p.text || String(p.fileName || '').indexOf('.json') < 0) return false;
    try {
      const parsed = JSON.parse(p.text);
      return !!parsed && typeof parsed.name === 'string' && !!parsed.entries &&
        !Array.isArray(parsed.entries) && !parsed.data && !parsed.spec;
    } catch (err) {
      return false;
    }
  });
  const convoExport = exportedPayloads.find((p) => String(p.fileName || '').endsWith('.md'));

  // --- 角色卡 ---
  let cardOk = false;
  let cardDetail = '没有导出记录';
  if (charExport) {
    try {
      const png = Buffer.from(String(charExport.base64 || ''), 'base64');
      const withText = pngWithTextChunk(png, charExport.pngText.keyword, charExport.pngText.text);
      const card = parseCharacterCardPng(withText);
      const ext = (card && card.data && card.data.extensions && card.data.extensions.mimitale) || {};
      const attrs = Array.isArray(ext.attributes) ? ext.attributes : [];
      const meter = attrs.find((a) => a && a.name === '好感度');
      cardOk =
        !!card &&
        card.spec === 'chara_card_v2' &&
        card.data.name === '属性测试角色' &&
        ext.age === '18' &&
        ext.gender === '女' &&
        attrs.length === 3 &&
        // 范围/规则也要能过一遍 PNG 往返（写进 extensions.mimitale 再读回来）
        !!meter &&
        meter.type === 'meter' &&
        meter.min === 0 &&
        meter.max === 100 &&
        meter.hint === '按剧情合理增减，单轮不超过 10';
      cardDetail = card ? `读回来的是「${card.data.name}」 ext=${JSON.stringify(ext)}` : 'PNG 里没读回卡数据';
    } catch (err) {
      cardDetail = '往返崩了：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：角色卡 PNG 写进去还能读回来（真往返）',
    pass: cardOk,
    detail: cardOk ? '' : cardDetail
  });
  result.results.push({
    name: '导出：角色卡文件名默认 .png',
    pass: !!charExport && String(charExport.fileName).endsWith('.png'),
    detail: String(charExport && charExport.fileName)
  });

  // --- 世界书 ---
  let bookOk = false;
  let bookDetail = '没有导出记录';
  if (wbExport) {
    try {
      const book = JSON.parse(wbExport.text);
      const first = Object.values(book.entries || {})[0];
      bookOk =
        !!book.name &&
        !!first &&
        'key' in first &&
        'keysecondary' in first &&
        'disable' in first &&
        String(wbExport.fileName).endsWith('.json');
      bookDetail = `name=${book.name} 首个条目字段=${first ? Object.keys(first).join(',') : '无'}`;
    } catch (err) {
      bookDetail = 'JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：世界书是酒馆认的 lorebook 形状',
    pass: bookOk,
    detail: bookOk ? '' : bookDetail
  });

  // --- 会话 ---
  const md = String((convoExport && convoExport.text) || '');
  const convoOk =
    !!convoExport &&
    String(convoExport.fileName).endsWith('.md') &&
    md.startsWith('# ') &&
    md.includes('改过的回复内容') &&
    md.includes('## 对话');
  result.results.push({
    name: '导出：会话是能读的 Markdown',
    pass: convoOk,
    detail: convoOk ? '' : md.slice(0, 80)
  });

  // --- 导出的角色卡里得带上「这张卡绑定的世界书」 ---
  // 这条以前写死 null，表现是「导出再导入，背景设定全丢」。
  // 注意：卡里带的是 character_book（v2 规范字段），不是应用内的 worldbookIds ——
  // 后者是我们的内部记录，本来就不该写进卡里。
  let boundOk = false;
  let boundDetail = '没有角色卡导出记录';
  if (charExport) {
    try {
      const card = JSON.parse(String(charExport.text || '{}'));
      const book = card.data && card.data.character_book;
      const own = (card.data && card.data.extensions && card.data.extensions.mimitale) || {};
      boundOk = !!book && !!book.name && own.worldbookEnabled === true;
      boundDetail = `character_book=${book ? `「${book.name}」` : 'null'} worldbookEnabled=${own.worldbookEnabled}`;
    } catch (err) {
      boundDetail = '角色卡 JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：角色卡带上了它绑定的世界书',
    pass: boundOk,
    detail: boundOk ? '' : boundDetail
  });

  // --- 导出 → **真导入**：卡里那本书过一遍真实导入链路还能回来 ---
  // 上面那条只证明「导出的 JSON 里有这个字段」，这条证明「这字段真能被读回来」。
  // 中间隔着 PNG 编码、base64、形状识别、归一化、自动绑定 —— 全是真代码。
  let roundOk = false;
  let roundDetail = '没有角色卡导出记录';
  if (charExport) {
    try {
      const png = Buffer.from(String(charExport.base64 || ''), 'base64');
      const cardPng = pngWithTextChunk(png, charExport.pngText.keyword, charExport.pngText.text);
      const back = importFiles({
        paths: ['D:\\roundtrip\\card.png'],
        readFile: () => cardPng,
        parseImportFile,
        makeWorldbookId: () => 'w-roundtrip'
      });
      const c = (back.characters || [])[0];
      const b = (back.worldbooks || [])[0];
      roundOk =
        !!c &&
        !!b &&
        Array.isArray(c.worldbookIds) &&
        c.worldbookIds[0] === b.id &&
        (b.entries || []).length > 0;
      roundDetail = `角色=${c && c.name} 书=${b && b.name} 条目=${b ? (b.entries || []).length : 0} 绑定=${JSON.stringify(
        c && c.worldbookIds
      )} errors=${JSON.stringify(back.errors)}`;
    } catch (err) {
      roundDetail = '往返崩了：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出 → 导入：卡里自带的世界书真的能读回来（真往返）',
    pass: roundOk,
    detail: roundOk ? '' : roundDetail
  });

  // --- 预设导出 ---
  // 单条导出写的是**对象本身**，全部导出才是 { presets: [...] } ——
  // 这两种形状自己的导入都认，所以「导出去的文件能原样导回来」是真成立的。
  // 另外要认准「不带 id」：带了 id，导回来的那条会在库里跟原来那条打架。
  const oneExport = exportedPayloads.find((p) => {
    if (!p.text || String(p.fileName || '') !== '带条目的预设.json') return false;
    try {
      const parsed = JSON.parse(p.text);
      return !!parsed && !Array.isArray(parsed) && !parsed.presets && typeof parsed.name === 'string';
    } catch (err) {
      return false;
    }
  });
  const allExport = exportedPayloads.find((p) => {
    if (!p.text || String(p.fileName || '') !== 'presets.json') return false;
    try {
      const parsed = JSON.parse(p.text);
      return !!parsed && Array.isArray(parsed.presets);
    } catch (err) {
      return false;
    }
  });

  let oneOk = false;
  let oneDetail = '没有单条预设的导出记录';
  if (oneExport) {
    try {
      const p = JSON.parse(oneExport.text);
      oneOk =
        p.name === '带条目的预设' &&
        typeof p.content === 'string' &&
        p.content.length > 0 &&
        Array.isArray(p.entries) &&
        p.entries.length > 0 &&
        !('id' in p) &&
        !('createdAt' in p) &&
        !('updatedAt' in p);
      oneDetail = `name=${p.name} entries=${(p.entries || []).length} 字段=${Object.keys(p).join(',')}`;
    } catch (err) {
      oneDetail = 'JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：单条预设写的是对象本身，且不带运行期字段',
    pass: oneOk,
    detail: oneOk ? '' : oneDetail
  });

  let allOk = false;
  let allDetail = '没有「导出全部」的记录';
  if (allExport) {
    try {
      const { presets } = JSON.parse(allExport.text);
      const one = presets.find((p) => p.name === '带条目的预设');
      allOk =
        presets.length >= 2 &&
        !!one &&
        presets.every((p) => p && typeof p.name === 'string' && !('id' in p)) &&
        String(allExport.fileName).endsWith('.json');
      allDetail = `条数=${presets.length} 名单=${presets.map((p) => p.name).join(' / ')}`;
    } catch (err) {
      allDetail = 'JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：全部预设写的是 { presets: [...] }，每条都不带 id',
    pass: allOk,
    detail: allOk ? '' : allDetail
  });
}

/**
 * 导入链路的端到端验证 —— 用真 PNG 字节喂**真实的** importFiles。
 *
 * 要跑通的是整条链：文件字节 → 形状识别 → 归一化 → 落库 → **自动绑到角色上**。
 * 最后那步最关键也最隐蔽：绑定断了不会有任何报错，表现只是「书在库里，
 * 但聊起来就是不生效」。以前 characters:import 在测试里是个桩，
 * 这条链路在自动化里完全是空的。
 */
function probeImport(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 一张 1x1 的真 PNG，拿来当角色卡的底图
  const basePng = (() => {
    try {
      const exported = exportedPayloads.find((p) => String(p.fileName || '').endsWith('.png') && p.base64);
      if (exported) return Buffer.from(String(exported.base64), 'base64');
    } catch (err) {
      /* 落到下面的手工 PNG */
    }
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    );
  })();

  const entries = {
    0: {
      uid: 0,
      comment: '导入测试条目',
      key: ['导入关键词'],
      keysecondary: [],
      content: '这条设定是从角色卡里带出来的。',
      constant: false,
      selective: false,
      selectiveLogic: 'AND_ANY',
      order: 100,
      probability: 100,
      disable: false,
      excludeRecursion: true,
      matchWholeWords: false,
      caseSensitive: false
    }
  };

  const cardJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '导入测试角色',
      description: '一个用来验导入链路的角色',
      personality: '安静',
      scenario: '测试场景',
      first_mes: '你好。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: [],
      character_book: { name: '卡里自带的世界书', entries },
      extensions: { mimitale: { age: '18', gender: '女', race: '精灵', attributes: [] } }
    }
  });

  const pngCard = pngWithTextChunk(basePng, 'chara', Buffer.from(cardJson, 'utf8').toString('base64'));
  const lorebookJson = JSON.stringify({ name: '独立世界书', entries });

  const fakeFs = (files) => ({
    readFile: (p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    },
    basename: (p) => String(p).split(/[\\/]/).pop(),
    extname: (p) => {
      const base = String(p).split(/[\\/]/).pop();
      const i = base.lastIndexOf('.');
      return i > 0 ? base.slice(i) : '';
    }
  });

  const idGen = (() => {
    let n = 0;
    return () => `w-import-${(n += 1)}`;
  })();

  const run = (files, paths) =>
    importFiles({
      paths,
      parseImportFile,
      makeWorldbookId: idGen,
      ...fakeFs(files)
    });

  let out = null;
  try {
    out = run(
      {
        'D:\\tmp\\导入测试角色.png': pngCard,
        'D:\\tmp\\独立世界书.json': Buffer.from(lorebookJson, 'utf8'),
        'D:\\tmp\\随便一个文件.txt': Buffer.from('这不是卡也不是书', 'utf8')
      },
      ['D:\\tmp\\导入测试角色.png', 'D:\\tmp\\独立世界书.json', 'D:\\tmp\\随便一个文件.txt']
    );
  } catch (err) {
    push('导入：链路不崩', false, (err && err.stack) || String(err));
  }

  if (out) {
    const char = (out.characters || [])[0];
    const book = (out.worldbooks || []).find((b) => b.name === '卡里自带的世界书');
    const standalone = (out.worldbooks || []).find((b) => b.name === '独立世界书');

    push('导入：PNG 卡读出来了', (out.characters || []).length === 1 && !!char && char.name === '导入测试角色',
      char ? `roles=${out.characters.length} name=${char.name}` : JSON.stringify(out.errors));
    push('导入：v2 的 extensions.mimitale 也读回来了',
      !!char && char.age === '18' && char.gender === '女' && char.race === '精灵',
      char ? `age=${char.age} gender=${char.gender} race=${char.race}` : '没有角色');
    push('导入：卡里内嵌的世界书被存下来了（以前整本丢掉）', !!book,
      book ? `「${book.name}」${(book.entries || []).length} 条` : JSON.stringify((out.worldbooks || []).map((b) => b.name)));
    push('导入：内嵌世界书的条目内容对得上',
      !!book && (book.entries || []).length === 1 && book.entries[0].content === '这条设定是从角色卡里带出来的。' &&
        book.entries[0].keys[0] === '导入关键词',
      book ? JSON.stringify(book.entries && book.entries[0]) : '没有这本书');
    push('导入：内嵌世界书自动绑到了这张卡上',
      !!char && !!book && Array.isArray(char.worldbookIds) && char.worldbookIds.length === 1 &&
        char.worldbookIds[0] === book.id,
      char ? `worldbookIds=${JSON.stringify(char.worldbookIds)} bookId=${book && book.id}` : '没有角色');
    push('导入：自带世界书的开关默认是开的', !!char && char.worldbookEnabled === true,
      char ? `worldbookEnabled=${char.worldbookEnabled}` : '没有角色');
    push('导入：temp 字段 worldbook 没有留在角色上', !!char && !('worldbook' in char),
      char ? Object.keys(char).join(',') : '没有角色');

    push('导入：单独的 lorebook JSON 进的是世界书库、不是角色库',
      !!standalone && (out.characters || []).length === 1,
      `worldbooks=${(out.worldbooks || []).map((b) => b.name).join(',')} roles=${(out.characters || []).length}`);
    push('导入：World Info 的字段映射没丢（key → keys）',
      !!standalone && (standalone.entries || []).length === 1 && standalone.entries[0].keys[0] === '导入关键词',
      standalone ? JSON.stringify(standalone.entries && standalone.entries[0]) : '没有这本书');

    push('导入：认不出来的文件只记一条错误、不影响别的文件',
      (out.errors || []).length === 1 && String(out.errors[0]).includes('随便一个文件.txt'),
      JSON.stringify(out.errors));
    push('导入：整批结果里角色只多了一个', (out.characters || []).length === 1,
      `roles=${(out.characters || []).length}`);
  }

  // 取消 / 一个文件都没有时，不能凭空造出东西来
  let emptyOk = false;
  let emptyDetail = '';
  try {
    const none = run({}, []);
    emptyOk = (none.characters || []).length === 0 && (none.worldbooks || []).length === 0;
    emptyDetail = JSON.stringify(none);
  } catch (err) {
    emptyDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：没选文件时什么都不发生', emptyOk, emptyDetail);

  // --- v3 变体：开场白在 chat_history 里，不在 first_mes ---
  // 这一段是**真卡踩出来的**：某个站点导出的 v3 卡没有 first_mes，
  // 开场白被放进了 chat_history[0].messages。以前只读 first_mes，
  // 结果导入后开场白是**空的**（连带第一条消息里那段状态栏一起丢）。
  // 标准 v3 规范里并没有 chat_history，所以两种形态都得认。
  const v3Card = (extra) =>
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: Object.assign(
        {
          name: 'v3 变体角色',
          description: '描述',
          extensions: {},
          character_book: { entries: [], extensions: {} },
          chat_history: [
            {
              id: 's1',
              name: '开场对话',
              messages: [
                { role: 'assistant', content: '这是 v3 开场白。\n\n---\n好感度：0/100' }
              ]
            },
            {
              id: 's2',
              name: '示例对话',
              messages: [{ role: 'assistant', content: '这段是示例对话，不该被当成开场白。' }]
            }
          ]
        },
        extra || {}
      )
    });

  const v3Only = run({ 'D:\\tmp\\v3.json': Buffer.from(v3Card(), 'utf8') }, ['D:\\tmp\\v3.json']);
  const v3char = (v3Only.characters || [])[0];
  push(
    '导入：v3 变体的开场白从 chat_history 里读出来了（以前是空的）',
    !!v3char && String(v3char.firstMes || '').includes('这是 v3 开场白'),
    v3char ? JSON.stringify(String(v3char.firstMes || '').slice(0, 60)) : JSON.stringify(v3Only.errors)
  );
  push(
    '导入：v3 开场白里的状态栏一起带过来了',
    !!v3char && String(v3char.firstMes || '').includes('好感度：0/100'),
    v3char ? JSON.stringify(String(v3char.firstMes || '').slice(-40)) : '没有角色'
  );
  push(
    '导入：只取第一个 session，第二个（示例对话）不混进来',
    !!v3char && !String(v3char.firstMes || '').includes('这段是示例对话'),    v3char ? JSON.stringify(String(v3char.firstMes || '')) : '没有角色'
  );

  // first_mes 才是权威的：两个都有时必须用它
  const v3Both = run(
    { 'D:\\tmp\\v3b.json': Buffer.from(v3Card({ first_mes: '标准 first_mes 优先' }), 'utf8') },
    ['D:\\tmp\\v3b.json']
  );
  push(
    '导入：first_mes 和 chat_history 都在时，用 first_mes',
    !!v3Both.characters[0] && String(v3Both.characters[0].firstMes).includes('标准 first_mes 优先'),
    JSON.stringify(String((v3Both.characters[0] || {}).firstMes || '').slice(0, 40))
  );

  // 第一条是媒体条目（多模态卡）时要跳过，别把图片当文本
  const v3Media = run(
    {
      'D:\\tmp\\v3c.json': Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v3',
          data: {
            name: '多模态卡',
            description: 'd',
            chat_history: [
              {
                id: 's1',
                messages: [
                  { type: 'image', content: 'https://example.com/a.png' },
                  { role: 'user', content: '用户先说了一句' },
                  { role: 'assistant', content: '真正的开场白在第二条 assistant。' }
                ]
              }
            ]
          }
        }),
        'utf8'
      )
    },
    ['D:\\tmp\\v3c.json']
  );
  push(
    '导入：chat_history 里的媒体条目被跳过，取第一条 assistant 文本',
    !!v3Media.characters[0] && String(v3Media.characters[0].firstMes).includes('真正的开场白在第二条'),
    JSON.stringify(String((v3Media.characters[0] || {}).firstMes || ''))
  );

  // 只有 user 消息时不能瞎编开场白
  const v3NoAssistant = run(
    {
      'D:\\tmp\\v3d.json': Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v3',
          data: {
            name: '没有开场白的卡',
            description: 'd',
            chat_history: [{ id: 's1', messages: [{ role: 'user', content: '只有用户消息' }] }]
          }
        }),
        'utf8'
      )
    },
    ['D:\\tmp\\v3d.json']
  );
  push(
    '导入：chat_history 里没有 assistant 消息时，开场白留空而不是瞎编',
    !!v3NoAssistant.characters[0] && v3NoAssistant.characters[0].firstMes === '',
    JSON.stringify(String((v3NoAssistant.characters[0] || {}).firstMes || ''))
  );

  // chat_history 是脏数据（不是数组 / 里面是空对象）时不能崩
  let v3DirtyOk = true;
  let v3DirtyDetail = '';
  try {
    const dirtyCard = (chat) =>
      JSON.stringify({ spec: 'chara_card_v3', data: { name: '脏卡', description: 'd', chat_history: chat } });
    const cases = [
      run({ 'D:\\tmp\\d1.json': Buffer.from(dirtyCard('不是数组'), 'utf8') }, ['D:\\tmp\\d1.json']),
      run({ 'D:\\tmp\\d2.json': Buffer.from(dirtyCard([]), 'utf8') }, ['D:\\tmp\\d2.json']),
      run({ 'D:\\tmp\\d3.json': Buffer.from(dirtyCard([null, {}, { messages: '不是数组' }]), 'utf8') }, [
        'D:\\tmp\\d3.json'
      ])
    ];
    v3DirtyOk = cases.every((o) => o.characters.length === 1 && o.characters[0].firstMes === '');
    v3DirtyDetail = JSON.stringify(cases.map((o) => (o.characters[0] || {}).firstMes));
  } catch (err) {
    v3DirtyOk = false;
    v3DirtyDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：chat_history 是脏数据时不崩，开场白留空', v3DirtyOk, v3DirtyDetail);

  // --- v3 变体回归样本（没有 first_mes） ---
  // 上面那些是自造卡，这条用的是**仓库里的完整样本字节**，
  // 形状照着真实导出文件构造（含 chat_history、extensions.status_template），
  // 文本内容是中性占位 —— 仓库里不夹带任何剧情文本。
  // 夹具就放在 tools/fixtures/ 下，改坏了会直接红。
  let realOk = false;
  let realDetail = '';
  try {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'v3-card-chat-history.json'));
    const real = run({ 'D:\\tmp\\real.json': fixture }, ['D:\\tmp\\real.json']);
    const rc = (real.characters || [])[0];
    realOk =
      !!rc &&
      rc.name === '图书馆的义工' &&
      String(rc.firstMes || '').includes('图书馆的义工') &&
      String(rc.firstMes || '').includes('好感度：0/100') &&
      String(rc.description || '').includes('数值系统');
    realDetail = rc
      ? `name=${rc.name} firstMes=${(rc.firstMes || '').length}字 含状态栏=${String(rc.firstMes || '').includes('好感度：0/100')}`
      : JSON.stringify(real.errors);
  } catch (err) {
    realDetail = '读夹具失败：' + ((err && err.message) || err);
  }
  push('导入：真 v3 变体卡（仓库里的回归样本）开场白能读出来', realOk, realDetail);

  // 同一张样本卡还要验「互动模板 → 角色属性」的映射。
  // 卡里 extensions.status_template 有 7 个字段（含一个带范围的 meter），
  // 以前整个被忽略，导入后属性是空的。
  let tplOk = false;
  let tplDetail = '';
  try {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'v3-card-chat-history.json'));
    const real = run({ 'D:\\tmp\\real.json': fixture }, ['D:\\tmp\\real.json']);
    const rc = (real.characters || [])[0];
    const attrs = (rc && rc.attributes) || [];
    const favor = attrs.find((a) => a.name === '好感度');
    const stage = attrs.find((a) => a.name === '关系阶段');
    const bag = attrs.find((a) => a.name === '背包');
    // 卡里的 template id 要翻译成分组标题（status_bar → 状态栏）
    const groupOf = (n) => (attrs.find((a) => a.name === n) || {}).group;
    const groups = [...new Set(attrs.map((a) => a.group).filter(Boolean))].sort();
    tplOk =
      attrs.length === 7 &&
      !!favor &&
      favor.type === 'meter' &&
      favor.min === 0 &&
      favor.max === 100 &&
      favor.value === '20' &&
      String(favor.hint || '').includes('单轮变化不超过 10') &&
      // 派生规则那种纯文本 hint 也要留下来（模型要靠它算关系阶段）
      !!stage &&
      String(stage.hint || '').includes('按好感度自动') &&
      // 列表型字段的初始值是个数组，要拍平成字符串
      !!bag &&
      bag.type === 'list' &&
      bag.value === '衣服' &&
      // 分组：官方模板翻译成中文标题，自定义面板用卡里 panels 的 title
      groupOf('时间') === '状态栏' &&
      groupOf('好感度') === '关系' &&
      groupOf('关系阶段') === '关系' &&
      groupOf('背包') === '背包' &&
      groupOf('自定义面板') === '自定义面板' &&
      groups.join(',') === '关系,背包,状态栏,自定义面板'.split(',').sort().join(',');
    tplDetail =
      `属性 ${attrs.length} 个：${JSON.stringify(attrs.map((a) => `${a.name}/${a.type}/${a.group || '无组'}`))}` +
      (favor ? ` 好感度=${JSON.stringify(favor)}` : ' 没有好感度');
  } catch (err) {
    tplDetail = '读夹具失败：' + ((err && err.message) || err);
  }
  push('导入：真卡的「互动模板」被映射成角色属性（类型/范围/规则/初始值）', tplOk, tplDetail);

  // 读文件失败得是「一条错误」，而不是整批炸掉
  let failOk = false;
  let failDetail = '';
  try {
    const bad = run({ 'D:\\tmp\\好的.json': Buffer.from(lorebookJson, 'utf8') }, [
      'D:\\tmp\\不存在的.png',
      'D:\\tmp\\好的.json'
    ]);
    failOk = (bad.errors || []).length === 1 && (bad.worldbooks || []).length === 1;
    failDetail = JSON.stringify(bad.errors);
  } catch (err) {
    failDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：某个文件读不到时，其余文件照样导入', failOk, failDetail);
}

/**
 * 面板字段的「类型 / 范围 / 变化规则」。
 *
 * 三件事要验：
 *   1. 归一化：类型认不出来要退回 text（而不是丢字段），范围写反要换正；
 *   2. 夹取：模型写 150/100、-5/100 要被拉回范围内，但**保留原来的写法**；
 *   3. 描述：范围和变化规则要能拼成给模型看的一句话。
 * 这些都是纯函数，跑的是主进程和渲染层共用的那一份 main/panel-fields.js。
 */
function probePanelFields(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // --- 归一化 ---
  const norm = (raw) => normalizePanelField(raw);

  const textField = norm({ name: ' 心情 ', value: '平静' });
  push('面板字段：名字去空白、缺省类型是文本', !!textField && textField.name === '心情' && textField.type === 'text',
    JSON.stringify(textField));
  push('面板字段：文本字段不带范围键', !!textField && !('min' in textField) && !('max' in textField),
    JSON.stringify(textField));

  const meter = norm({ name: '好感度', type: 'meter', min: 0, max: 100, value: 20, hint: '每轮最多加 10' });
  push('面板字段：数值字段的范围/hint 都留下了',
    !!meter && meter.type === 'meter' && meter.min === 0 && meter.max === 100 && meter.hint === '每轮最多加 10',
    JSON.stringify(meter));
  push('面板字段：初始值被转成字符串（面板值只能是字符串）', !!meter && meter.value === '20', JSON.stringify(meter && meter.value));

  const reversed = norm({ name: '血', type: 'meter', min: 100, max: 0 });
  push('面板字段：范围写反了会被换正', !!reversed && reversed.min === 0 && reversed.max === 100, JSON.stringify(reversed));

  const badType = norm({ name: '怪', type: '进度条', value: 'x' });
  push('面板字段：类型认不出来退回文本，而不是丢掉字段', !!badType && badType.type === 'text', JSON.stringify(badType));

  push('面板字段：没有名字的直接丢掉', norm({ value: 'x' }) === null);
  push('面板字段：脏输入返回 null 而不是崩', norm(null) === null && norm('字符串') === null && norm([]) === null);

  const noName = normalizePanelFields([{ name: 'A', value: '1' }, { value: '2' }, null, { name: 'A', value: '3' }]);
  push('面板字段：整表归一化会丢掉无名项和重名项', noName.length === 1 && noName[0].value === '1',
    JSON.stringify(noName));

  // --- 夹取 ---
  const range = { type: 'meter', min: 0, max: 100 };
  const clamp = (v) => clampFieldValue(v, range);

  push('面板夹取：150/100 → 100/100（保留斜杠写法）', clamp('150/100').value === '100/100', JSON.stringify(clamp('150/100')));
  push('面板夹取：-5/100 → 0/100', clamp('-5/100').value === '0/100', JSON.stringify(clamp('-5/100')));
  push('面板夹取：范围内的原样不动', clamp('50/100').value === '50/100' && clamp('50/100').clamped === false,
    JSON.stringify(clamp('50/100')));
  push('面板夹取：纯数字也认', clamp('150').value === '100', JSON.stringify(clamp('150')));
  push('面板夹取：小数保留（不粗暴取整）', clamp('100.7/100').value === '100/100' && clamp('99.5/100').value === '99.5/100',
    `${JSON.stringify(clamp('100.7/100'))} ${JSON.stringify(clamp('99.5/100'))}`);
  push('面板夹取：不是数字就原样放行（不能把中文值抹掉）', clamp('很累').value === '很累' && clamp('很累').clamped === false,
    JSON.stringify(clamp('很累')));
  push('面板夹取：空值不报错', clamp('').value === '' && clamp(null).value === '');

  const lower = { type: 'meter', min: 10, max: 100 };
  push('面板夹取：只有下限时也夹', clampFieldValue('3', lower).value === '10', JSON.stringify(clampFieldValue('3', lower)));
  push('面板夹取：没有范围的数值字段不夹', clampFieldValue('999', { type: 'meter' }).value === '999',
    JSON.stringify(clampFieldValue('999', { type: 'meter' })));
  push('面板夹取：文本字段不夹（就算值是数字）', clampFieldValue('999', { type: 'text', min: 0, max: 100 }).value === '999');
  push('面板夹取：没有定义就原样返回', clampFieldValue('999', null).value === '999');

  // 分母不动：它是这个字段的满值，改了会更怪
  push('面板夹取：分母原样保留', clampFieldValue('150/999', range).value === '100/999',
    JSON.stringify(clampFieldValue('150/999', range)));

  // --- 描述（注入给模型的那句话）---
  const desc = describePanelField(meter);
  push('面板描述：范围和变化规则都在里面', desc.includes('0~100') && desc.includes('每轮最多加 10'), desc);
  push('面板描述：列表字段说明怎么分隔', describePanelField({ type: 'list' }).includes('、'),
    describePanelField({ type: 'list' }));
  push('面板描述：纯文本字段没有多余说明', describePanelField({ type: 'text' }) === '',
    describePanelField({ type: 'text' }));

  // --- 分组（命名面板）---
  const grouped = normalizePanelFields([
    { name: '时间', group: '状态栏' },
    { name: '好感度', group: '关系', type: 'meter', min: 0, max: 100 },
    { name: '零散' },
    { name: '背包', group: '背包' }
  ]);
  push('面板分组：group 被留下来', !!grouped[0].group && grouped[0].group === '状态栏', JSON.stringify(grouped[0]));
  push('面板分组：没写 group 的字段就是没分组', !('group' in grouped[2]), JSON.stringify(grouped[2]));
  push('面板分组：纯空白的分组名当没有', !('group' in normalizePanelField({ name: 'x', group: '   ' })));

  const buckets = groupPanelFields(grouped);
  push(
    '面板分组：按第一次出现的顺序分组、顺序保留',
    buckets.map((b) => b.id).join(',') === '状态栏,关系,背包,',
    JSON.stringify(buckets.map((b) => b.id))
  );
  push(
    '面板分组：没分组的排最后',
    buckets[buckets.length - 1].id === '' && buckets[buckets.length - 1].fields.length === 1,
    JSON.stringify(buckets.map((b) => ({ id: b.id, n: b.fields.length })))
  );
  push(
    '面板分组：每个桶里的字段对得上',
    buckets[0].fields[0].name === '时间' && buckets[1].fields[0].name === '好感度' && buckets[2].fields[0].name === '背包',
    JSON.stringify(buckets.map((b) => b.fields.map((f) => f.name)))
  );
  push('面板分组：全都没分组时只有一个空桶', groupPanelFields([{ name: 'a' }, { name: 'b' }]).length === 1);
  push('面板分组：脏输入不崩', groupPanelFields(null).length === 0 && groupPanelFields([null, undefined]).length === 0);

  // --- 数值字段的进度（他那边的「带范围的进度条」）---
  const meterDef = { type: 'meter', min: 0, max: 100 };
  push('进度：60/100 → 60%', JSON.stringify(fieldProgress('60/100', meterDef)) === JSON.stringify({ n: 60, total: 100, percent: 60 }),
    JSON.stringify(fieldProgress('60/100', meterDef)));
  push('进度：裸数字也能算（用 max 当满值）', (fieldProgress('20', meterDef) || {}).percent === 20,
    JSON.stringify(fieldProgress('20', meterDef)));
  push('进度：越界会被夹在 0~100', (fieldProgress('150/100', meterDef) || {}).percent === 100 &&
    (fieldProgress('-5/100', meterDef) || {}).percent === 0,
    `${JSON.stringify(fieldProgress('150/100', meterDef))} ${JSON.stringify(fieldProgress('-5/100', meterDef))}`);
  push('进度：有下限时按区间算（20~80 里的 50 → 50%）',
    (fieldProgress('50/80', { type: 'meter', min: 20, max: 80 }) || {}).percent === 50,
    JSON.stringify(fieldProgress('50/80', { type: 'meter', min: 20, max: 80 })));
  push('进度：文本字段没有进度', fieldProgress('60', { type: 'text' }) === null);
  push('进度：算不出数字就没有进度（不瞎画）', fieldProgress('很累', meterDef) === null && fieldProgress('', meterDef) === null);
  push('进度：没有范围也没有分母时不给进度', fieldProgress('60', { type: 'meter' }) === null);
  push('进度：范围是个点（max==min）不除零', (fieldProgress('5/5', { type: 'meter', min: 5, max: 5 }) || {}).percent === 0);
}

/**
 * 世界书存盘归一化的白名单验证。normalizeWorldbook 是白名单式的：没列的字段
 * 直接消失。这里用真的落盘归一化跑一遍往返。
 */
function probeWorldbookStore(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  const normalize = createWorldbookNormalizer({
    makeId: () => 'w-fixed',
    normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
  });

  const original = {
    id: 'w-keep',
    name: '字段保全测试书',
    opening: '进来就会看到的第一句话',
    entries: [
      {
        id: 'e-keep',
        title: '会递归的条目',
        keys: ['关键词'],
        content: '正文',
        recursive: true,
        constant: false,
        enabled: true,
        matchWholeWords: false,
        caseSensitive: false,
        priority: 100
      },
      {
        id: 'e-off',
        title: '被停用的条目',
        keys: ['停用'],
        content: '不该生效',
        recursive: false,
        // 老写法 disable:true = 停用
        disable: true
      }
    ],
    characters: [{ id: 'wc-1', name: '书里的角色副本', description: '副本设定', attributes: [{ name: '体力', value: '10' }] }]
  };

  let back = null;
  try {
    back = normalize(original);
  } catch (err) {
    push('世界书落盘：归一化不崩', false, (err && err.stack) || String(err));
    return;
  }

  const e0 = (back.entries || [])[0] || {};
  const e1 = (back.entries || [])[1] || {};

  push('世界书落盘：书本身的 id / name 保留', back.id === 'w-keep' && back.name === '字段保全测试书',
    `id=${back.id} name=${back.name}`);
  push('世界书落盘：opening 没被丢掉（白名单漏过）', back.opening === '进来就会看到的第一句话', JSON.stringify(back.opening));
  push('世界书落盘：条目数对', (back.entries || []).length === 2, `entries=${(back.entries || []).length}`);
  push('世界书落盘：recursive 没被重置成 false（白名单漏过）', e0.recursive === true, `recursive=${e0.recursive}`);
  push('世界书落盘：disable:true 读成 enabled:false', e1.enabled === false, `enabled=${e1.enabled}`);
  push('世界书落盘：书里的角色副本没被丢掉', (back.characters || []).length === 1 && back.characters[0].name === '书里的角色副本',
    JSON.stringify((back.characters || []).map((c) => c.name)));
  push('世界书落盘：副本的 attributes 也回来了',
    !!back.characters[0] && Array.isArray(back.characters[0].attributes) && back.characters[0].attributes.length === 1,
    JSON.stringify(back.characters[0] && back.characters[0].attributes));

  // 子进程真的读回来过（渲染层存过盘）
  const loaded = store.worldbooks.find((w) => w.id === 'w-test');
  push('世界书落盘：内存里那本种子的 recursive 还在（真存过盘）',
    !!loaded && (loaded.entries || []).some((e) => e.recursive === true),
    loaded ? `recursive=${JSON.stringify((loaded.entries || []).map((e) => e.recursive))}` : '内存里找不到种子书');
}

/**
 * 递归扫描的引擎级验证。直接打 main/worldbook-match.js —— 比隔着界面点
 * 「预览命中」更精确，能把深度 0/1/3 和「哪条允许往下带」分开验。
 */
function probeRecursion(result) {
  const entry = (id, title, keys, content, recursive) => ({
    id,
    title,
    keys,
    secondaryKeys: [],
    selectiveLogic: 'AND_ANY',
    content,
    constant: false,
    recursive,
    probability: 100,
    order: 100,
    enabled: true
  });

  // 严格链：总览 → 十二泰坦 → 火种。每一条的正文只提下一层的关键词，
  // 所以深度几层就该带出几条 —— 如果总览正文里同时写了「火种」，
  // 那就成了扇出（深度 1 就全出来），验不出「逐层接力」。
  const entries = [
    entry('a', '世界总览', ['翁法罗斯'], '翁法罗斯有十二泰坦。', true),
    entry('b', '十二泰坦', ['十二泰坦'], '十二泰坦守着火种。', true),
    entry('c', '火种', ['火种'], '火种是泰坦留下的力量。', false),
    entry('d', '无关条目', ['没人提的词'], '不该出现。', true)
  ];

  const run = (depth) => matchWorldbookEntries(entries, '翁法罗斯是个什么样的地方？', { recursiveDepth: depth });

  const zero = run(0);
  const one = run(1);
  const three = run(3);

  const titles = (r) => r.hits.map((h) => h.title).join('、');
  const ok =
    zero.hits.length === 1 &&
    zero.recursiveCount === 0 &&
    one.hits.length === 2 &&
    one.recursiveCount === 1 &&
    three.hits.length === 3 &&
    three.recursiveCount === 2 &&
    !titles(three).includes('无关条目') &&
    three.rounds === 3;
  result.results.push({
    name: '递归扫描：深度 0 只给直接命中的那一条',
    pass: zero.hits.length === 1 && zero.recursiveCount === 0,
    detail: `${titles(zero)}（${zero.hits.length} 条）`
  });
  result.results.push({
    name: '递归扫描：深度 1 带出第一层',
    pass: one.hits.length === 2 && one.recursiveCount === 1,
    detail: `${titles(one)}（${one.hits.length} 条）`
  });
  result.results.push({
    name: '递归扫描：逐层接力直到没得带（深度 3 → 3 条 3 轮）',
    pass: ok,
    detail: `${titles(three)}（${three.hits.length} 条 / ${three.rounds} 轮 / 递归 ${three.recursiveCount}）`
  });
  result.results.push({
    name: '递归扫描：命中过的条目不会被重复带进来',
    pass: new Set(three.hits.map((h) => h.id)).size === three.hits.length,
    detail: titles(three)
  });

  // 递归关闭的条目：它的正文不该参与下一轮
  const gated = matchWorldbookEntries(
    [entry('a', '总览', ['翁法罗斯'], '里面写了十二泰坦。', false), entry('b', '十二泰坦', ['十二泰坦'], '细节。', false)],
    '翁法罗斯',
    { recursiveDepth: 3 }
  );
  result.results.push({
    name: '递归扫描：没勾「递归」的条目不会往下带',
    pass: gated.hits.length === 1,
    detail: titles(gated)
  });
}

/**
 * 「给 AI 看图」的验证。
 * 关键不是界面上有没有缩略图，而是**真正发出去的那条消息是不是多模态数组** ——
 * 发错格式的话模型只会当你没发图，而界面上一切正常。
 */
function probeImageMessage(result) {
  let found = null;
  for (const messages of chatPayloads) {
    for (const m of messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        found = m;
        break;
      }
    }
    if (found) break;
  }

  const parts = found ? found.content : [];
  const text = parts.find((p) => p.type === 'text');
  const image = parts.find((p) => p.type === 'image_url');

  result.results.push({
    name: '看图：发给模型的是多模态数组',
    pass: !!found,
    detail: found ? `共 ${parts.length} 段` : '翻遍所有请求都没找到数组形态的 user 消息'
  });

  result.results.push({
    name: '看图：数组里同时带上文字和图片',
    pass: !!text && String(text.text).includes('这是我拍的照片') && !!image && String(image.image_url.url).startsWith('data:image/'),
    detail:
      text && image
        ? `text="${String(text.text).slice(0, 14)}" · image=${String(image.image_url.url).slice(0, 24)}`
        : '缺文字段或缺图片段'
  });

  // 没有图的普通消息仍然是纯字符串 —— 别把所有请求都改成数组，
  // 有些便宜的老接口收到数组会直接报错
  const plain = chatPayloads.some((messages) =>
    messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('翁法罗斯'))
  );
  result.results.push({
    name: '看图：没带图的消息仍然是纯文本',
    pass: plain,
    detail: plain ? '' : '没找到一条纯文本的用户消息'
  });
}

/**
 * 生图的验证。关键一条：**它用的是「生图」那一组配置，而不是聊天模型** —— * 用错了的话界面照样出图，但你的对话模型会被当成画图模型去打 /images/generations，
 * 只会得到一个莫名其妙的报错。
 */
function probeImageGen(result) {
  const req = imageRequests[0];

  result.results.push({
    name: '生图：用的是「生图」那一组配置，不是聊天模型',
    pass: !!req && req.providerId === 'p-img' && req.model === 'img-model-x',
    detail: req ? `providerId=${req.providerId} model=${req.model}` : '没收到生图请求'
  });

  result.results.push({
    name: '生图：提示词取自那条回复的正文',
    pass: !!req && String(req.prompt).includes('冒烟测试回复'),
    detail: req ? `"${String(req.prompt).slice(0, 36)}…"` : ''
  });

  result.results.push({
    name: '生图：请求里带上了尺寸',
    pass: !!req && req.size === '1024x1024',
    detail: req ? String(req.size) : ''
  });
}

/**
 * 向量工具的单测。直接打 main/vectors.js —— 相似度算错了，整套语义检索就是
 * 「随机捞几条塞进上下文」，而且界面上完全看不出来。
 */
function probeVectors(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 编解码往返
  const original = new Float32Array([0.125, -0.5, 0.75, 1e-3]);
  const back = decodeVector(encodeVector(original));
  push(
    '向量：编码再解码能原样回来',
    back && back.length === original.length && original.every((v, i) => Math.abs(back[i] - v) < 1e-7),
    back ? `[${Array.from(back).join(', ')}]` : '解码失败'
  );

  // base64 比 JSON 数字省得多
  push(
    '向量：存成 base64 比 JSON 数字省',
    encodeVector(original).length < JSON.stringify(Array.from(original)).length,
    `base64 ${encodeVector(original).length} 字节 vs JSON ${JSON.stringify(Array.from(original)).length} 字节`
  );

  push('向量：坏数据解码返回 null', decodeVector('不是base64!!') === null && decodeVector('') === null);

  // 余弦相似度：同向 1、正交 0、反向 -1
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  const c = new Float32Array([-1, 0]);
  push(
    '向量：余弦相似度对（同向 1 / 正交 0 / 反向 -1）',
    Math.abs(cosineSimilarity(a, a) - 1) < 1e-6 &&
      Math.abs(cosineSimilarity(a, b)) < 1e-6 &&
      Math.abs(cosineSimilarity(a, c) + 1) < 1e-6,
    [cosineSimilarity(a, a), cosineSimilarity(a, b), cosineSimilarity(a, c)].join(' / ')
  );

  // 没归一化的向量也要能比（各家服务商不一样）
  const un = new Float32Array([10, 0]);
  push('向量：没归一化也算得对', Math.abs(cosineSimilarity(a, un) - 1) < 1e-6, String(cosineSimilarity(a, un)));
  push('向量：维度不一样返回 0（不瞎算）', cosineSimilarity(new Float32Array([1, 2, 3]), a) === 0);

  // 排序：topK / 阈值 / 排除
  const candidates = [
    { key: 'high', vector: new Float32Array([1, 0, 0.1]) },
    { key: 'mid', vector: new Float32Array([0.7, 0.7, 0.1]) },
    { key: 'low', vector: new Float32Array([0, 1, 0.1]) },
    { key: 'excluded', vector: new Float32Array([1, 0, 0.1]) }
  ];
  const ranked = rankBySimilarity(new Float32Array([1, 0, 0.1]), candidates, { topK: 2, minScore: 0.9 });
  push(
    '向量：topK 和阈值都生效',
    ranked.length === 2 && ranked[0].key === 'high' && ranked[1].key === 'excluded' && ranked[0].score >= ranked[1].score,
    ranked.map((r) => `${r.key}=${r.score.toFixed(3)}`).join(', ')
  );

  const excluded = rankBySimilarity(new Float32Array([1, 0, 0.1]), candidates, {
    topK: 5,
    minScore: 0,
    exclude: new Set(['excluded'])
  });
  push(
    '向量：exclude 里的不会被捞回来',
    excluded.length === 3 && !excluded.some((r) => r.key === 'excluded'),
    excluded.map((r) => r.key).join(', ')
  );

  push(
    '向量：全都不够像时宁可一条都不给',
    rankBySimilarity(new Float32Array([0, 0, 1]), candidates, { topK: 4, minScore: 0.9 }).length === 0,
    ''
  );

  push('向量：内容指纹随内容变', hashText('甲') !== hashText('乙') && hashText('甲') === hashText('甲'));

  // 候选收集：跳过最近几条、只捞绑定的书、空内容不要
  const collected = collectCandidates({
    messages: [
      { role: 'user', content: '很早以前说过的话' },
      { role: 'assistant', content: '很早以前的回复' },
      { role: 'user', content: '刚说的这句' },
      { role: 'user', content: '   ' },
      { role: 'error', content: '出错了' }
    ],
    recentCount: 2,
    books: [
      { id: 'b1', entries: [{ id: 'e1', title: '甲条', content: '甲的内容' }, { id: 'e2', title: '空条', content: '  ' }] },
      { id: 'b2', entries: [{ id: 'e9', title: '没绑的书', content: '不该被捞' }] }
    ],
    worldbookIds: ['b1']
  });
  const keys = collected.map((c) => c.key).join(' | ');
  push(
    '向量：候选收集跳过最近几条消息',
    !collected.some((c) => c.text === '刚说的这句') && collected.some((c) => c.text === '很早以前说过的话'),
    keys
  );
  push(
    '向量：候选收集只捞绑定了的那本书',
    collected.some((c) => c.text === '甲的内容') && !collected.some((c) => c.text === '不该被捞'),
    keys
  );
  push(
    '向量：空白内容和 error 消息都不收',
    !collected.some((c) => c.text === '出错了') && collected.every((c) => c.text.trim()),
    keys
  );
}

/**
 * 语义检索注入链路的验证（宿主侧，看真正发出去的消息）。
 * 光看界面上「有没有反应」是验不出这个功能的 —— 它本来就没有可见反应。
 */
function probeRag(result) {
  const fromSystem = (messages) =>
    (messages || []).find((m) => m.role === 'system' && String(m.content || '').includes('[可能相关的往事]'));

  const withRag = chatPayloads.map(fromSystem).filter(Boolean);
  const section = withRag.length ? String(withRag[withRag.length - 1].content) : '';

  result.results.push({
    name: 'RAG：把相关的设定捞回来注入了',
    pass: !!section && section.includes('十二泰坦'),
    detail: section ? section.replace(/\s+/g, ' ').slice(0, 70) : '所有请求里都没有 [可能相关的往事] 这一段'
  });

  result.results.push({
    name: 'RAG：不像的没被硬凑进来',
    pass: !!section && !section.includes('这条不该被带进来'),
    detail: section.includes('这条不该被带进来') ? '把不相关的条目也塞进来了' : ''
  });

  result.results.push({
    name: 'RAG：注入的是一段独立的 system 消息',
    pass: !!section && section.trim().startsWith('[可能相关的往事]'),
    detail: section ? section.trim().slice(0, 20) : '没找到这一段'
  });

  // 负向对照：关掉之后不该再出现
  const last = chatPayloads[chatPayloads.length - 1];
  result.results.push({
    name: 'RAG：关掉之后就不再注入了',
    pass: !fromSystem(last),
    detail: fromSystem(last) ? '关了还在注入' : ''
  });

  // 渲染层确实把配置传下去了
  const req = ragRequests[0];
  result.results.push({
    name: 'RAG：检索用的是「向量」那组配置',
    pass: !!req && req.providerId === 'p-emb' && req.model === 'emb-model-x',
    detail: req ? `${req.providerId}/${req.model}` : '没收到检索请求'
  });
}

/**
 * AI 生成的解析体检：把「模型返回的原文」直接喂给 aiGen 的解析函数，
 * 看它到底能不能解析出字段。这条链路（原文 → 剥围栏 → JSON.parse → 字段）
 * 跑在渲染层里、又是纯函数，最适合直接 import 进来单测 ——
 * 真点按钮那条路会掺进「弹窗有没有开、草稿有没有建」等一堆无关变量。
 */
async function probeAiGenParse(win, result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  try {
    const out = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/views/aiGen.js', document.baseURI).href);
      if (typeof mod.parseGeneratedCharacter !== 'function') return { exported: false };

      const clean = JSON.stringify({
        name: '守夜人',
        description: '一个总在深夜值班的人。',
        personality: '话少。',
        tags: ['冒烟'],
        attributes: [{ name: '好感度', type: 'number', value: 5, mode: 'dynamic' }]
      });
      const fenced = '好的，我按你说的写了一个：\\n\\n\\\`\\\`\\\`json\\n' + clean + '\\n\\\`\\\`\\\`\\n\\n需要我再调整吗？';

      const a = mod.parseGeneratedCharacter(clean);
      const b = mod.parseGeneratedCharacter(fenced);
      return {
        exported: true,
        clean: { ok: a.ok, name: a.fields && a.fields.name, attrs: (a.fields && a.fields.attributes || []).length, err: a.error },
        fenced: { ok: b.ok, name: b.fields && b.fields.name, attrs: (b.fields && b.fields.attributes || []).length, err: b.error }
      };
    })()`);

    if (!out || !out.exported) {
      push('AI 生成：解析函数可以从模块里拿到', false, JSON.stringify(out));
      return;
    }
    push(
      'AI 生成：干净的 JSON 能解析出角色',
      out.clean.ok && out.clean.name === '守夜人' && out.clean.attrs === 1,
      JSON.stringify(out.clean)
    );
    push(
      'AI 生成：带围栏和废话的输出也能解析出角色',
      out.fenced.ok && out.fenced.name === '守夜人' && out.fenced.attrs === 1,
      JSON.stringify(out.fenced)
    );
  } catch (err) {
    push('AI 生成：解析体检能跑起来', false, (err && err.message) || String(err));
  }
}

/**
 * 文案体检：属性编辑器的「更新频率」提示不该硬编码具体字段名（字段是用户
 * 卡片/世界书的数据）。放宿主侧用 fs 读源码，是因为渲染层 CSP 拦 fetch file://。
 */
function probeAttrModeWording(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  let src = '';
  try {
    src = fs.readFileSync(path.join(APP_DIR, 'renderer', 'js', 'views', 'charAttributes.js'), 'utf8');
  } catch (err) {
    push('文案体检：能读到 charAttributes.js', false, (err && err.message) || String(err));
    return;
  }

  // 「更新频率」的文案应该是抽象描述：不出现「…这类」的字段举例。
  const badExamples = src.split('\n').filter((line) => /每轮维护|变了才说/.test(line) && /这类/.test(line));
  push(
    '文案体检：「更新频率」文案是抽象描述、不含字段举例',
    badExamples.length === 0,
    badExamples.join(' | ')
  );
}

/**
 * 设置白名单体检：界面能写进 config.json 的每个键，都必须登记在 DEFAULT_SETTINGS 里。
 *
 * 为什么要有这条：main/providers.js 的 saveSettings 只收「DEFAULT_SETTINGS 里有」
 * 或「磁盘上本来就有」的键（挡住往配置里塞垃圾）。**「磁盘上本来就有」这半条会掩盖
 * 漏登记** —— 老用户的 config.json 里早写过了，于是漏了也一直不出事；
 * 直到全新装一份，第一次保存就被静默丢掉，只在主进程打一行看不见的 warn。
 * autoContinue / commonAttributes 就是这么漏的（快捷候选词、自动续写，
 * 界面里怎么改都不生效，而且只在"干净机器"上复现）。
 *
 * ⚠️ 新增设置项时：先把它加进 main/providers.js 的 DEFAULT_SETTINGS，
 *    再来这里补一行 —— 这条断言就是用来逼你想起前一步的。
 */
function probeSettingsWhitelist(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  const UI_WRITABLE_SETTINGS = [
    // settings.js 的表单
    'providers', 'activeProviderId', 'activeModel', 'temperature', 'maxTokens',
    'sendOnEnter', 'showDate', 'showUsage',
    'autoContinue', 'worldbookRecursiveDepth', 'maxTurns',
    'imageProviderId', 'imageModel', 'imageSize',
    'ragEnabled', 'embeddingProviderId', 'embeddingModel',
    'commonAttributes',
    'assistantPersonas',
    'searchEnabled', 'searchApiKey', 'searchCount', 'searchFreshness',
    // ui/plainView.js（顶栏「⋯」里的显示开关）
    'plainChatView',
    // appearance.js / theme.js
    'chatFontSize', 'chatBoldColor', 'chatBackground', 'theme', 'accent'
  ];

  let defaults = null;
  try {
    ({ DEFAULT_SETTINGS: defaults } = require('../main/providers.js'));
  } catch (err) {
    push('设置白名单：能读到 main/providers.js', false, (err && err.message) || String(err));
    return;
  }
  push('设置白名单：能读到 main/providers.js', !!defaults);

  const missing = UI_WRITABLE_SETTINGS.filter((key) => !(key in defaults));
  push(
    '设置白名单：界面能写的键都在 DEFAULT_SETTINGS 里',
    missing.length === 0,
    missing.length ? `漏登记：${missing.join(', ')}` : ''
  );

  // 反向：白名单必须真的拦得住完全没见过的键，别把闸门开成摆设
  const unknown = ['__definitely_not_a_setting__'];
  const leaked = unknown.filter((key) => key in defaults);
  push('设置白名单：没见过的键确实不在默认表里', leaked.length === 0, leaked.join(', '));
}

/**
 * 默认人设（设置 → 默认人设）：管的是**没绑角色卡**的会话，而且按模型各存一份。
 *
 * 页面侧只能验「表单读写得对、标题跟着变」，这里补上真正的效果 ——
 * 那段人设有没有被拼进发给模型的消息。
 *
 * ⚠️ 这里同时守着一条设计：默认对话是「跟 AI 模型聊天」，**不是**扮演酒馆角色，
 * 所以只该带用户自己写的人设，不能再叠一层【扮演规则】—— 那份人设是自足的，
 * 多一层规则只会跟它打架（这条是 2026-10-07 用户明确要求的）。
 */
function probeAssistantPersona(result) {
  if (!result) return;
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 认这句特征串（smoke-renderer 里配的那段人设）
  const MARK = '你是一只叫团子的猫';
  const blobs = chatPayloads.map((msgs) =>
    msgs.map((m) => String((m && m.content) || '')).join('\n')
  );

  const hit = blobs.filter((b) => b.includes(MARK));
  push(
    '默认人设：配了人设的通用对话把它拼进了系统提示词',
    hit.length >= 1,
    hit.length ? '' : `翻了 ${blobs.length} 次请求都没找到那段人设`
  );

  const plain = hit.length > 0 && hit.every((b) => !b.includes('【扮演规则】') && !b.includes('【主持规则】'));
  push(
    '默认对话：只带人设，不再注入酒馆的扮演规则',
    plain,
    plain ? '' : '默认对话里混进了扮演/主持规则 —— 那会和用户自己写的人设打架'
  );

  // 「不是酒馆会话」不止扮演规则那一条。世界 NPC 名单 / 玩家角色 / 叙述模式这三段
  // 是 buildApiMessages **自己从 convo 里读**的（不像世界书那样由参数传进来），
  // 所以最容易被漏掉：漏了不报错，只是悄悄混进提示词。这里一起守着。
  // （叙述模式默认就是「标准」档、文案非空，只要没挡就必定出现。）
  const TAVERN_MARKS = ['【扮演规则】', '【主持规则】', '【叙述要求】', '【这个世界的人】', '【玩家角色'];
  const leaked = hit.length ? TAVERN_MARKS.filter((mark) => hit.some((b) => b.includes(mark))) : [];
  push(
    '默认对话：叙述模式 / 玩家角色 / NPC 名单也没混进来',
    hit.length > 0 && leaked.length === 0,
    leaked.length ? `混进了：${leaked.join('、')}` : `翻了 ${blobs.length} 次请求都没找到那段人设`
  );
}

/**
 * 请求记录（顶栏「⋯」→ 请求记录）。
 *
 * 这个功能的落点是「把真正发出去的那一份留下」，而**留下来的到底对不对**
 * 页面里看不到 —— 所以两条关键断言在宿主侧：
 *
 *   1. main/http.js 是不是在请求**发出去之前**就把定稿的 body 交给 onRequest。
 *      用 127.0.0.1:1（保留端口，必连不上）也够 —— 回调在建立连接之前就触发了，
 *      我们要的是那份 body，不是响应。
 *   2. 环形缓冲是不是真的在转、上限认不认。塞满再塞，看最旧的有没有被挤掉。
 *
 * ⚠️ 这里会清空缓冲。渲染层那边的场景**已经跑完了**（场景全部跑完才轮到宿主侧 probe），
 *    所以不会影响它。
 */
async function probeRequestLog(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  // --- 1) http.js 的 onRequest 接线 ---
  // 关键：streamChat 的函数体是 `return new Promise((resolve,reject)=>{...})`，
  // **executor 是同步跑的** —— 所以 onRequest 在 streamChat() 这一下里就触发了，
  // 不用等 socket。后面那句 race 只是让连接错误走完、别把句柄留着，
  // 顺手给它 2 秒上限，万一这个环境不立刻 ECONNREFUSED 也不会拖住整个测试。
  let seen = null;
  const pending = streamChat({
    settings: {
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke-request-log',
      apiKey: 'smoke-key',
      temperature: 0.31,
      maxTokens: 1234,
      topP: 0.87
    },
    messages: [{ role: 'user', content: '记录我' }],
    onRequest: (body, url) => {
      seen = { body, url };
    }
  }).catch(() => {
    // 连不上正是这条用例的预期：要看的是 seen，不是响应
  });
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 2000))]);

  push(
    '请求记录：发出去之前就把定稿的 body 交了出来',
    !!(seen && seen.body),
    seen ? '' : 'onRequest 没被调用 —— 弹窗里会是空的'
  );
  push(
    '请求记录：交出来的就是最终要发的那份（模型 + 三个采样参数）',
    !!seen &&
      seen.body.model === 'smoke-request-log' &&
      seen.body.temperature === 0.31 &&
      seen.body.max_tokens === 1234 &&
      seen.body.top_p === 0.87 &&
      seen.body.stream === true,
    seen
      ? JSON.stringify({
          model: seen.body.model,
          temperature: seen.body.temperature,
          max_tokens: seen.body.max_tokens,
          top_p: seen.body.top_p
        })
      : '没有拿到 body'
  );

  // --- 2) 环形缓冲 ---
  clearRequests();
  for (let i = 0; i < MAX_LOGGED_REQUESTS + 5; i += 1) {
    recordRequest({
      requestId: `smoke-${i}`,
      providerName: 'smoke',
      url: 'http://x/v1/chat/completions',
      body: { model: `m${i}` }
    });
  }
  const list = listRequests();
  const newest = list[0] && list[0].body && list[0].body.model;
  const oldest = list[list.length - 1] && list[list.length - 1].body && list[list.length - 1].body.model;
  push(
    `请求记录：最多留 ${MAX_LOGGED_REQUESTS} 条，超了挤掉最旧的`,
    list.length === MAX_LOGGED_REQUESTS &&
      newest === `m${MAX_LOGGED_REQUESTS + 4}` &&
      oldest === 'm5',
    `长度 ${list.length}，最新 ${newest}，最旧 ${oldest}`
  );

  clearRequests();
  push('请求记录：能清空', listRequests().length === 0, String(listRequests().length));
}

app.whenReady().then(async () => {
  registerStubs();

  // 窗口尺寸从 main/window.js 读，别在这儿写死 —— 写死过一次（1180×800），
  // 窗口改成 1440×900 之后没人记得改这里，于是截图一直比真机窄两百多像素，
  // 照着截图调的间距全是错的。
  const { WINDOW_SIZE } = require('../main/window.js');
  const win = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    useContentSize: true,
    autoHideMenuBar: true, // 和真实窗口一致：菜单栏不占内容高度
    show: false, // 不弹窗，跑测试不打扰你
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false // 窗口不可见时不要限制定时器/动画帧
    }
  });

  const consoleErrors = [];
  const consoleWarnings = [];
  // --progress 才把页面里「跑到第几个场景」打出来。
  // 没有它的时候，「跑超时了」分不清是**卡死**还是**只是还没跑完** ——
  // 加场景把总时长顶过兜底超时那次，就是靠它一眼看出停在哪个场景（见 OVERALL_TIMEOUT_MS）。
  const showProgress = process.argv.includes('--progress');

  win.webContents.on('console-message', (...args) => {
    // 新旧 Electron 的事件签名不一样，两种都兜住
    const first = args[0];
    const level = typeof args[1] === 'number' ? args[1] : first && first.level;
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    const text = String(message == null ? '' : message);
    if (showProgress && text.startsWith('[progress]')) console.log('    ' + text);
    if (level === 3 || level === 'error') consoleErrors.push(text);
    else if (level === 2 || level === 'warning') consoleWarnings.push(text);
  });

  let crashed = '';
  try {
    await win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  } catch (err) {
    crashed = '页面加载失败：' + ((err && err.message) || err);
  }

  let result = null;
  if (!crashed && !SHOT_ONLY) {
    const domScript = fs.readFileSync(path.join(__dirname, 'smoke-renderer.js'), 'utf8');
    try {
      result = await win.webContents.executeJavaScript(`(async () => {\n${domScript}\n})()`);
    } catch (err) {
      crashed = '页面内脚本执行失败：' + ((err && err.message) || err);
    }
  }

  if (!crashed && result) {
    try {
      probeInjection(result);
      probePresets(result);
      probeExports(result);
      probeImport(result);
      probeWorldbookStore(result);
      probePanelFields(result);
      probeRecursion(result);
      probeImageMessage(result);
      probeImageGen(result);
      probeVectors(result);
      probeRag(result);
      probeAttrModeWording(result);
      probeAssistantPersona(result);
      await probeRequestLog(result);
      probeSettingsWhitelist(result);
      await probeAiGenParse(win, result);
      await probeHover(win, result);
      await probeLightboxClick(win, result);
    } catch (err) {
      crashed = '宿主侧验证失败：' + ((err && err.message) || err);
    }
  }

  // --shot=<场景>：把窗口显示出来、切到指定界面再截图到 tools/shots/。
  // 结构和逻辑测试盖不住的「看着对不对」（间距、对齐、配色）得靠这个看，
  // 不用每次都临时加代码再删。
  // 用法：electron tools/smoke-test.js --no-sandbox --shot=settings
  // 精确匹配 --shot=，别让 --shot-only 也命中（它没有 =，会被误当成截图场景）
  const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1];
  // 再加 --shot-dark 就用夜间模式出图，文件名带 -dark 后缀。
  // 暗色主题是另一套变量，只验白天等于只验了一半 —— 「浅色底 + 浅色字」
  // 这类错误在白天截图里根本不会露头。
  const shotDark = process.argv.includes('--shot-dark');
  if (shotArg) {
    try {
      win.show();
      if (shotDark) {
        // 点真实的主题按钮（只点按钮，不调内部函数）
        await win.webContents.executeJavaScript(`document.querySelector('#btn-theme')?.click(); true`);
        await new Promise((r) => setTimeout(r, 300));
      }
      // --shot-accent=<pink|blue|matcha>：切到指定配色再截图。
      // 配置按钮是「循环」的，所以不写死点几次，一路点到 data-accent 等于目标为止
      // （最多 4 次，认不出的值循环一圈回到原地，不会卡死）。
      const shotAccent = (process.argv.find((a) => a.startsWith('--shot-accent')) || '').split('=')[1];
      if (shotAccent) {
        await win.webContents.executeJavaScript(`
          (async () => {
            for (let i = 0; i < 4; i++) {
              if (document.documentElement.getAttribute('data-accent') === ${JSON.stringify(shotAccent)}) break;
              document.querySelector('#btn-accent')?.click();
              await new Promise((r) => setTimeout(r, 150));
            }
            return document.documentElement.getAttribute('data-accent');
          })()
        `);
        await new Promise((r) => setTimeout(r, 300));
      }
      // 每个场景 = 打开哪个界面。只点真实按钮，不调内部函数。
      const DRIVERS = {
        settings: `
          document.querySelector('#btn-settings')?.click();
          await new Promise(r => setTimeout(r, 700));`,
        panel: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          // 找「状态卡入口条上有多个头像」的会话（多人才看得出这一条的意义）
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await new Promise(r => setTimeout(r, 500));
            if ($$('#panel-cast .panel-avatar').length > 1) break;
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 顶栏「切换模型」弹层展开的样子（自绘列表，不是系统菜单那种直角 + 系统蓝）
        modelMenu: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          document.querySelector('#model-switch')?.click();
          await new Promise(r => setTimeout(r, 350));`,
        // 顶栏「⋯」展开的样子（记忆 / 复制全文 / 导出 / 清空对话 收在里面）
        moreMenu: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          document.querySelector('#btn-more')?.click();
          await new Promise(r => setTimeout(r, 350));`,
        // 顶栏（2026-09-30）：方角「书」头像 + 视角胶囊。
        // 找一条**没绑角色卡、绑了世界书**的会话 —— 也就是世界游玩出来的那条，
        // 它和只绑角色的会话（圆头像 + 数值胶囊）长得不一样。
        topbarBook: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await new Promise(r => setTimeout(r, 450));
            const av = $('#topbar-avatar');
            if (av && av.classList.contains('book')) break;
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        chars: `
          document.querySelector('#btn-chars')?.click();
          await new Promise(r => setTimeout(r, 500));`,
        // 帮助页：一整篇静态长文，「对照框 / 清单 / 尺度条」的排版只靠 DOM
        // 断言看不出来，得截一张。滚回顶部，不然可能停在上次滚到的位置。
        help: `
          document.querySelector('#btn-help')?.click();
          await new Promise(r => setTimeout(r, 500));
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          const body = document.querySelector('#view-help .page-body');
          if (body) body.scrollTop = 0;`,
        // 角色库：卡片上铺的是**角色形象**（2:3 竖版立绘），点开还能看大图。
        // 测试里的角色都没有图（上传那条路被 images:pick 的桩挡着），
        // 所以这里给每张卡塞一个 2:3 的 SVG 占位立绘 —— 只为看清裁切和排版；
        // 上传那条**真路径**在「角色：头像和形象是两张图」场景里（走 ui/imageCrop.js）。
        charArt: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const art = (hue, label) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">' +
            '<rect width="300" height="450" fill="hsl(' + hue + ',70%,90%)"/>' +
            '<circle cx="150" cy="144" r="60" fill="hsl(' + hue + ',55%,68%)"/>' +
            '<path d="M42 450c0-92 48-151 108-151s108 59 108 151z" fill="hsl(' + hue + ',55%,68%)"/>' +
            '<text x="150" y="434" font-size="24" text-anchor="middle" fill="hsl(' + hue + ',50%,36%)">' + label + '</text>' +
            '</svg>');

          $('#btn-chars')?.click();
          await nap(550);
          $$('#char-page-grid .char-card').forEach((card, i) => {
            const face = card.querySelector('.char-card-avatar');
            if (!face || face.querySelector('img')) return;
            const name = card.querySelector('.char-card-name');
            face.innerHTML = '';
            const img = document.createElement('img');
            img.alt = '';
            img.src = art((i * 71 + 335) % 360, (name ? name.textContent : '角色').slice(0, 2));
            face.appendChild(img);
          });
          await nap(250);
          // 删除 × 平时是 opacity:0、悬停才浮出来 —— 截图没有指针，
          // 这里拨上去只为核对它压在人设图上够不够清楚（不动生产样式）。
          const del = $('#char-page-grid .char-card .char-card-del');
          if (del) del.style.opacity = '1';
          await nap(150);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 看大图浮层（ui/lightbox.js）：遮罩 + 底部工具条。
        // 测试里的角色没有形象（上传那条路被 images:pick 的桩挡着），所以这里
        // 直接调浮层模块递一张占位立绘进去 —— 出图只为核对工具条的排版和字号，
        // 真实入口（点卡片上的形象）在「看图：灯箱缩放与关闭」和宿主侧的真实鼠标探针里。
        lightbox: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const art = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">' +
            '<rect width="300" height="450" fill="hsl(335,70%,90%)"/>' +
            '<circle cx="150" cy="144" r="60" fill="hsl(335,55%,68%)"/>' +
            '<path d="M42 450c0-92 48-151 108-151s108 59 108 151z" fill="hsl(335,55%,68%)"/>' +
            '<text x="150" y="434" font-size="24" text-anchor="middle" fill="hsl(335,50%,36%)">示例角色</text>' +
            '</svg>');
          const mod = await import(new URL('js/ui/lightbox.js', document.baseURI).href);
          mod.openLightbox(art, { title: '示例角色' });
          await nap(450);
          // 放大两档：让工具条上的百分比不是 100%，一眼能看出缩放是活的
          $('#lightbox-in')?.click();
          $('#lightbox-in')?.click();
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 世界书编辑器：列表页 → 第一本书的「编辑」。
        // 这个弹窗是「左栏书名 + 本书角色 + 开场白 + 条目列表 / 右栏条目表单」，
        // 栏宽、间距、「内容」框和底部按钮的位置只有截图能核对。
        // 最后在内容框上派一次 input（内容一个字没改）—— 让底部那颗
        // 「有未保存的改动」也进画面，否则那条状态永远没人看过。
        worldbook: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-worldbooks')?.click();
          await nap(450);
          const card = $$('#wb-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(650);
          $('#wb-e-content')?.dispatchEvent(new Event('input', { bubbles: true }));
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 世界书列表页本身（卡片 + 右上角删除 × + 「有未保存的改动」提示同款药丸）。
        // 删除键平时是 opacity:0、悬停才浮出来 —— 截图没有指针，
        // 所以这里直接把透明度拨上去，只为出图（不动生产样式）。
        worldbookPage: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-worldbooks')?.click();
          await nap(500);
          const card = $$('#wb-page-grid .char-card')[0];
          const del = card && card.querySelector('.char-card-del');
          if (del) del.style.opacity = '1';
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 预设列表页（卡片 + 右上角删除 ×）与预设编辑器（字段一列、采样参数折叠区）
        presets: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-presets')?.click();
          await nap(500);
          const card = $$('#preset-page-grid .char-card')[0];
          const del = card && card.querySelector('.char-card-del');
          if (del) del.style.opacity = '1';
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        presetEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-presets')?.click();
          await nap(500);
          const card = $$('#preset-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(650);
          // 把采样参数那块展开：折叠着的话这块样式永远没人看过
          const det = $('#preset-modal details.preset-sampling');
          if (det) det.open = true;
          await nap(200);
          // 在正文框上派一次 input（内容一个字没改）—— 让底部那颗「有未保存的改动」也进画面
          $('#pr-content')?.dispatchEvent(new Event('input', { bubbles: true }));
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 视角弹窗里的预设勾选列表（多选 + 「可全局」徽标 + 底部状态说明）。
        // 这一块是纯排版（行高、勾选框对齐、徽标位置、列表的滚动边界），
        // 断言只能验「勾没勾」，看不出「挤不挤」。
        presetPick: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-perspective')?.click();
          await nap(600);
          // 弹窗没开（比如种子数据里没有会话）就自己造一场，别出一张空白图
          if (!$('#perspective-modal') || $('#perspective-modal').classList.contains('hidden')) {
            const first = $$('#char-page-grid .char-card')[0]
              || (() => { $('#btn-chars')?.click(); return null; })();
            await nap(400);
            const card = $$('#char-page-grid .char-card')[0];
            const chat = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '聊天');
            if (chat) chat.click();
            await nap(600);
            $('#btn-perspective')?.click();
            await nap(500);
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          await nap(150);`,
        // 剧情选项：整条测试跑完正好停在场景 21 的会话里（最新回复带选项），
        // 这里只需要确认在聊天视图、把 toast 收掉，就能截到「气泡下面的选项块」。
        msgOptions: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          await new Promise(r => setTimeout(r, 300));`,
        // 角色编辑器：点左栏上传框会走真实的 shrinkAvatar → 落盘那条路
        // （images:pick 的桩给的是 1×1 PNG，裁完是一片纯色 —— 看不出裁切效果）。
        // 所以出图时直接往两个上传框里各塞一张 SVG 占位图，只为核对框子比例：
        // 头像是 1:1 圆，形象是 2:3 竖版。
        charEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const fill = (sel, w, h) => {
            const box = $(sel);
            if (!box || box.querySelector('img')) return;
            box.innerHTML = '';
            const img = document.createElement('img');
            img.alt = '';
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">' +
              '<rect width="' + w + '" height="' + h + '" fill="hsl(335,70%,90%)"/>' +
              '<circle cx="' + (w / 2) + '" cy="' + (h * 0.32) + '" r="' + (w * 0.2) + '" fill="hsl(335,55%,68%)"/>' +
              '<path d="M' + (w * 0.14) + ' ' + h + 'c0-' + (h * 0.2) + ' ' + (w * 0.16) + '-' + (h * 0.33) + ' ' + (w * 0.36) + '-' + (h * 0.33) +
              's' + (w * 0.36) + ' ' + (h * 0.13) + ' ' + (w * 0.36) + ' ' + (h * 0.33) + 'z" fill="hsl(335,55%,68%)"/>' +
              '</svg>');
            box.appendChild(img);
          };
          fill('#char-avatar', 300, 300);    // 头像：1:1
          fill('#char-portrait', 300, 450);  // 形象：2:3
          // 直接塞图绕过了 renderCharMedia，手动把两颗「清除」也露出来 ——
          // 截图要核对的正是它们的尺寸和间距
          $('#btn-clear-avatar')?.classList.remove('hidden');
          $('#btn-clear-portrait')?.classList.remove('hidden');
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 属性区的分组标签栏：新建一张卡，按真实交互铺出几个分组再截图 ——
        // 空卡只有一个「未分组」标签，看不出分层的样子。
        charAttrs: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组示例'; fire(nameBox, 'input'); }

          const addTo = async (group, label, value) => {
            if (group) {
              const tabNew = $('#c-attr-tabs .attr-tab-new');
              tabNew.value = group;
              tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await nap(120);
            }
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(120);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await addTo('关系', '好感度', '20');
          await addTo('关系', '信任度', '0');
          await addTo('关系', '亲密度', '0');
          await addTo('背包', '金币', '9900');
          await addTo('背包', '道具', '钥匙、手电筒');
          await addTo('状态', '心情', '平静');
          await addTo('状态', '体温', '36.5');

          const rel = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith('关系'));
          if (rel) rel.click();
          await nap(250);
          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 属性展开「更多」面板：更新频率下拉 / 分组 / 变化规则，只有截图能确认
        // 标签文案改长后会不会被截、下拉能不能正常展开。
        charAttrsMore: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '更新频率示例'; fire(nameBox, 'input'); }

          // 加一条属性，再点它的「更多」展开
          const input = $('#c-attr-new');
          input.value = '好感度';
          $('#btn-add-attr').click();
          await nap(150);

          const row = $$('#c-attr-list .attr-row')[0];
          const more = row && Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '更多');
          if (more) more.click();
          await nap(250);

          // 把「更多」面板滚到视野里
          const morePanel = row && row.querySelector('.attr-more');
          if (morePanel) morePanel.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 长文本框：自动增高 + 右下角拖拽把手。
        // 这两件事全是**纯视觉**的 —— DOM 断言只能说「高度变了」，
        // 说不清把手看不看得见、长高之后上下留白对不对。
        // 故意做成两种内容并存好一次看完：
        //   · 「角色描述」留短内容 → 展示短内容不占地方（停在下限）
        //   · 「示例对话」填一长段 → 展示自动增高（应该明显高于其他框）
        charTextareas: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const setVal = (node, v) => { if (!node) return; node.value = v; fire(node, 'input'); };

          // 短内容（自动增高应当停在下限附近）
          setVal($('#c-desc'), '一个爱在图书馆泡到闭馆的中文系女生。');
          // 长内容（应当长高，但不该顶爆表单 —— 有 GROW_MAX 兜着）
          setVal($('#c-example'), [
            '{{user}}：这么晚了还不回去？',
            '{{char}}：……还差两页。你先走吧。',
            '',
            '{{user}}：我看你昨天也没去食堂。',
            '{{char}}：（把书往怀里按了按）不饿。',
            '',
            '{{user}}：这本书你借了三次了吧？',
            '{{char}}：……第四次。图书馆要罚款的。'
          ].join('\\n'));

          // 焦点落到「示例对话」自己身上再滚过去 —— 让长高的那个框连同
          // 右下角的把手一起进画面（不要在别的框上留焦点，
          // 免得让人误以为「其他框被压扁了」）。
          const example = $('#c-example');
          if (example) example.focus();
          await nap(300);

          const desc = $('#c-desc');
          if (desc) desc.scrollIntoView({ block: 'start' });
          await nap(300);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 放大编辑浮层：塞一段够长的描述再点 ↗，看浮层的头/正文/脚排得怎么样。
        // 描述要足够长 —— 浮层里出现滚动才有「这是个长内容编辑器」的样子。
        charExpand: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const desc = $('#c-desc');
          if (desc) {
            desc.value = Array.from({ length: 26 }, (_, i) =>
              '第' + (i + 1) + '段：她总在闭馆前十分钟才把书放回原位，指尖压着书脊，像怕惊动谁。'
            ).join('\\n');
            fire(desc, 'input');
          }
          await nap(200);
          const expandBtn = document.querySelector('.char-expand-btn[data-expand="c-desc"]');
          if (expandBtn) expandBtn.click();
          await nap(400);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 同上，但停在**空分组**上 —— 空态文案、计数徽标上的 0、
        // 以及「卡身只剩一行提示」时的留白，只有截图能看出好不好看。
        charAttrsEmpty: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '空分组示例'; fire(nameBox, 'input'); }

          const addTo = async (group, label, value) => {
            if (group) {
              const tabNew = $('#c-attr-tabs .attr-tab-new');
              tabNew.value = group;
              tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await nap(120);
            }
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(120);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await addTo('关系', '好感度', '20');
          await addTo('关系', '信任度', '0');
          await addTo('关系', '亲密度', '0');
          // 建一个空分组并切过去（不加任何字段）
          const tabNew = $('#c-attr-tabs .attr-tab-new');
          tabNew.value = '背包';
          tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await nap(250);

          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 分组操作条（改名 / 解散）：从「⋯」点开的状态。
        // 这个小面板的间距、按钮配色只有截图能核对。
        charGroupEdit: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组管理示例'; fire(nameBox, 'input'); }

          const newGroup = async (name) => {
            const box = $('#c-attr-tabs .attr-tab-new');
            box.value = name;
            box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await nap(140);
          };
          const addAttr = async (label, value) => {
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(140);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await newGroup('关系');
          await addAttr('好感度', '20');
          await addAttr('信任度', '0');
          await newGroup('背包');
          await addAttr('金币', '9900');
          await newGroup('状态');

          // 停在「状态」上，把操作条点开
          const stateTab = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith('状态'));
          if (stateTab) stateTab.click();
          await nap(200);
          $('#c-attr-tabs .attr-tab-edit')?.click();
          await nap(250);

          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 「更多」里的分组行：下拉态 + 「＋ 新建分组…」的临时输入框态。
        // 两种形态排在一起才看得出高度对不对齐（这一行最容易和上面
        // 「数值范围」那条错位）。
        charGroupMove: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组搬运示例'; fire(nameBox, 'input'); }

          const newGroup = async (name) => {
            const box = $('#c-attr-tabs .attr-tab-new');
            box.value = name;
            box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await nap(140);
          };
          const clickTab = async (prefix) => {
            const tab = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith(prefix));
            if (tab) tab.click();
            await nap(160);
          };
          const addAttr = async (label, value) => {
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(140);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };
          const rowOf = (label) => $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);

          // ⚠️ 顺序有讲究：**先**往「未分组」里加两个（新卡默认就停在那一桶），
          // **再**建「关系」并往里加 —— 反过来的话，建组会切走，
          // 而这时「未分组」还不存在（bucketsOf 只在真有零散字段时才铺它），
          // 于是字段会全掉进「关系」，夹具就和场景名对不上了。
          await addAttr('金币', '9900');
          await addAttr('上衣', '布衣');
          await newGroup('关系');
          await addAttr('好感度', '20');
          await clickTab('未分组');

          // 金币这一行：展开「更多」，露出分组下拉
          const coin = rowOf('金币');
          if (coin && !coin.parentElement.querySelector('.attr-more select.attr-group')) coin.querySelector('.attr-more-btn').click();
          await nap(200);

          // 再加一个字段，把它的那一行切到「＋ 新建分组…」的输入框态
          await addAttr('上衣', '布衣');
          const shirt = rowOf('上衣');
          if (shirt && !shirt.parentElement.querySelector('.attr-more select.attr-group')) shirt.querySelector('.attr-more-btn').click();
          await nap(220);
          const shirt2 = rowOf('上衣');
          const sel = shirt2 && shirt2.parentElement.querySelector('.attr-more select.attr-group');
          if (sel) {
            const newOpt = Array.from(sel.options).find(o => o.textContent.includes('新建分组'));
            if (newOpt) { sel.value = newOpt.value; fire(sel, 'change'); }
          }
          await nap(260);

          const panel = $('.attr-panel');
          if (panel) panel.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡（只读态）：点面板栏「我」的头像打开「我的状态」卡。
        // 卡片位置/层级/进度条/文字排版这些都是纯视觉的，DOM 断言看不出来。
        stateCard: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          // 优先「冒烟测试世界」（那里的玩家状态最全），没有就找第一个有头像的会话
          let chosen = $$('#convo-list .convo-item').find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim() === '冒烟测试世界';
          });
          if (!chosen) {
            for (const it of $$('#convo-list .convo-item')) {
              it.click();
              await nap(400);
              if ($$('#panel-cast .panel-avatar').length) { chosen = it; break; }
            }
          }
          if (chosen) { chosen.click(); await nap(500); }

          const avatars = $$('#panel-cast .panel-avatar');
          const mine = avatars.find(b => b.dataset.owner === 'player') || avatars[0];
          if (mine) { mine.click(); await nap(320); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡（编辑态）：同一张卡点「编辑」之后的样子 —— 值变输入框、
        // 右边出现删除、底部出现「＋ 添加」。输入框的边框/内边距最容易
        // 被通用 input 规则盖掉，必须看真图。
        stateCardEdit: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          let chosen = $$('#convo-list .convo-item').find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim() === '冒烟测试世界';
          });
          if (!chosen) {
            for (const it of $$('#convo-list .convo-item')) {
              it.click();
              await nap(400);
              if ($$('#panel-cast .panel-avatar').length) { chosen = it; break; }
            }
          }
          if (chosen) { chosen.click(); await nap(500); }

          const avatars = $$('#panel-cast .panel-avatar');
          const mine = avatars.find(b => b.dataset.owner === 'player') || avatars[0];
          if (mine) { mine.click(); await nap(320); }

          const eb = $('#state-cards .state-card .sc-edit');
          if (eb) { eb.click(); await nap(360); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡上的角色图：标题下面横铺一张，右下角是命中的表情名小标签。
        // 走的是**真实路径**（角色卡点「聊天」→ 真发一轮 → 点入口条头像），
        // 种子卡的触发词写在假后端每轮回复都带的那句话上，所以必定命中表情甲。
        stateExpr: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const chat = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '聊天');
          if (chat) { chat.click(); await nap(700); }

          const input = $('#input');
          if (input) {
            input.value = '你好';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          $('#btn-send')?.click();
          await nap(2400);

          const av = $$('#panel-cast .panel-avatar').find(b => b.dataset.owner !== 'player');
          if (av) { av.click(); await nap(450); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑器顶部的图片区：头像 / 形象 + 表情图入口行（表情的编辑在独立弹窗里）
        charExpr: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const edit = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (edit) { edit.click(); await nap(700); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 表情图弹窗：一张卡几十条表情，现在单独一个弹窗编
        //（缩略图 + 名称 + 触发词 + 默认脸 + 删除）
        charExprModal: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const edit = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (edit) { edit.click(); await nap(700); }

          $('#btn-manage-expr')?.click();
          await nap(400);

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡入口条：一行头像（我 / 各角色）。旧面板的收起态已经没有了，
        // 「世界」那个入口也去掉了（无主字段要么并回主角、要么丢掉）。
        panelCast: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          const items = $$('#convo-list .convo-item');
          const target = items.find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim().startsWith('选项测试');
          });
          if (target) { target.click(); await nap(550); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 在场角色多开几张：把入口条上的头像**逐个点一遍**，看「同时看多张面板」
        // 到底成不成立（右栏够不够高、展开几张之后会不会把后面的挤没）。
        // 单张卡的形态在 stateCard 场景里已经看过了，这里看的是**多张并存**。
        panelMulti: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          // 挑一个在场人数最多的会话
          let best = null, bestN = 0;
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await nap(420);
            const n = $$('#panel-cast .panel-avatar').length;
            if (n > bestN) { bestN = n; best = it; }
          }
          if (best) { best.click(); await nap(500); }

          // 逐个点头像 = 逐个打开并展开
          for (const b of $$('#panel-cast .panel-avatar')) { b.click(); await nap(260); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`
      };
      const driver = DRIVERS[shotArg];
      if (!driver) {
        console.log(`  未知截图场景「${shotArg}」，可用：${Object.keys(DRIVERS).join(' / ')}`);
      } else {
        await win.webContents.executeJavaScript(`(async () => { ${driver}\n return true; })()`);
        await new Promise((r) => setTimeout(r, 700));
        // 出图前把主题和几个关键底色打出来。截图最容易骗人的地方就是
        // 「看着像暗色、其实没切过去」—— 那是白跑一趟，而且会让人照着
        // 一张错图去调配色。这里直接问浏览器要算完的值，比肉眼看可靠。
        const probe = await win.webContents.executeJavaScript(`(() => {
          const bg = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : '(无)'; };
          const h = (sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().height) : 0; };
          return {
            theme: document.documentElement.getAttribute('data-theme') || 'light',
            card: bg('.modal-card'),
            panel: bg('.attr-panel'),
            tabs: bg('.attr-tabs'),
            value: bg('.attr-row input.attr-value'),
            // 长文本框的实高：光看截图分不清「自动长高了」和「本来就这个高」，
            // 这里把五个框的量出来，一眼能看出收窄/增高有没有真的发生。
            desc: h('#c-desc'),
            personality: h('#c-personality'),
            scenario: h('#c-scenario'),
            first: h('#c-first'),
            example: h('#c-example')
          };
        })()`);
        console.log(`  主题=${probe.theme} 弹窗底=${probe.card} 属性卡=${probe.panel} 标签栏=${probe.tabs} 值框=${probe.value}`);
        if (shotArg === 'charTextareas') {
          console.log(`  长文本框实高(px) 描述=${probe.desc} 性格=${probe.personality} 场景=${probe.scenario} 开场白=${probe.first} 示例对话=${probe.example}`);
        }
        const dir = path.join(__dirname, 'shots');
        fs.mkdirSync(dir, { recursive: true });
        // 配色不是默认粉时把配色名缀进文件名，免得几套配色的图互相覆盖
        const accentTag = shotAccent && shotAccent !== 'pink' ? `-${shotAccent}` : '';
        const shotName = `${shotArg}${accentTag}${shotDark ? '-dark' : ''}.png`;
        fs.writeFileSync(path.join(dir, shotName), (await win.webContents.capturePage()).toPNG());
        console.log(`  截图: tools/shots/${shotName}`);
      }
    } catch (err) {
      console.log('  截图失败:', (err && err.message) || err);
    }
  }

  // --shot-only 没跑断言，别打那份「0/0 通过」的报告 —— 那会让人以为验证过了。
  if (SHOT_ONLY) {
    console.log('');
    console.log('  ℹ --shot-only：只出图，**一条断言都没跑**（验证请去掉这个参数跑整套）');
    if (consoleErrors.length) {
      console.log(`  ⚠ 不过页面里有 ${consoleErrors.length} 条控制台报错：`);
      consoleErrors.slice(0, 5).forEach((e) => console.log('    ! ' + e));
    }
    app.exit(0);
    return;
  }

  const ok = report(result, consoleErrors, consoleWarnings, crashed);
  app.exit(ok ? 0 : 1);
});
// 兜底：万一卡住（窗口没起来 / executeJavaScript 不返回），别让终端一直挂着
setTimeout(() => {
  console.error(`\n  ⏱ 冒烟测试超过 ${Math.round(OVERALL_TIMEOUT_MS / 1000)} 秒没有结束，判定失败\n`);
  app.exit(2);
}, OVERALL_TIMEOUT_MS).unref();
