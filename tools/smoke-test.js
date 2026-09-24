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

// 测试只做 DOM 断言，用不到 GPU。某些环境（无独显 / 远程桌面 / 驱动状态异常）
// 的 GPU 进程会反复崩溃并把主进程一起带走（日志里是
// `FATAL: GPU process isn't usable. Goodbye.`），表现却是
// 「页面加载失败：ERR_FAILED」—— 看着像代码坏了，其实和代码无关。
// 关掉硬件加速就没有这个噪声（软件渲染对测试速度影响可以忽略）。
//
// 另一半在 package.json：`npm run smoke` 带了 `--no-sandbox`。
// 2026-09-23 实测这台机器上光关硬件加速还不够，沙箱也要关，否则一样是 ERR_FAILED。
// 这两个脚本不加载任何外部内容、IPC 全是内存里的假后端，关沙箱的代价可以忽略。
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
const OVERALL_TIMEOUT_MS = 90000;

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
      systemPrompt: '冒烟测试用的全局人设。',
      userName: '测试者',
      maxTurns: 20,
      theme: 'light',
      sendOnEnter: true,
      showDate: false,
      showUsage: false
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
    activeId: null
  };
}

const store = makeStore();
const calls = []; // 记录渲染层请求过的写操作，方便排查
let chatPayloads = []; // 每次发给模型的完整消息（按顺序留着，供宿主侧断言用）
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

  // --- 图片 / 杂项 ---
  // 返回一张真的 1×1 PNG：这样「选背景图」那条链路（解码 → 缩放 → 存 dataURL）
  // 走的是真代码，而不是被 stub 掉
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  ipcMain.handle('images:pick', () => ({ canceled: false, dataUrl: TINY_PNG }));

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
  // 每次回复带个序号 —— 不然「重新生成」出来的候选和原来那条一模一样，
  // 测不出「到底是哪一条」
  let replySeq = 0;
  ipcMain.handle('chat:send', async (event, payload) => {
    remember('chat:send');
    chatPayloads.push(clone((payload && payload.messages) || []));
    const requestId = (payload && payload.requestId) || 'req-smoke';
    const model = (payload && payload.model) || 'test-model';

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
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
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
    );
    if (askedForOptions) {
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
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
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
 * 为什么这条断言不能写在页面里，也不能用模拟指针：
 *   1. `:hover` 只认真实指针，页面里 dispatchEvent('mouseover') 不算数；
 *   2. 用 sendInputEvent 真移指针也不行 —— 窗口是隐藏的（show:false），
 *      Chromium 不会给它算 hover 状态；
 *   3. 所以走 CDP 的 CSS.forcePseudoState 强制加 `:hover`（已验证能用，
 *      拿左侧会话列表那套生产环境正常的 .convo-del 做过对照）。
 *
 * 还有一个坑（踩过，记在这免得下次又查一遍）：
 *   `.char-card-del` 上有 `transition: opacity 0.12s`，而**隐藏窗口不产生动画帧**，
 *   过渡永远不会推进 —— 强制 hover 之后等 1.5 秒 opacity 依然是 0。
 *   所以这里先把过渡临时关掉，让计算值直接跳到位。
 *   真实窗口里过渡正常播放（那就是我们要的淡入效果）。
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

  const blobs = chatPayloads.map((msgs) => msgs.map((m) => String((m && m.content) || '')).join('\n'));

  const panelOk = blobs.some(
    (b) => b.includes('[当前状态]') && b.includes('【金币】：100') && b.includes('【上衣】：布衣')
  );
  result.results.push({
    name: '属性：注入给模型的消息里带上了状态面板',
    pass: panelOk,
    detail: panelOk ? '' : `翻了 ${blobs.length} 次请求都没找到完整面板`
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
        ? `找到了面板行但缺范围/规则：${JSON.stringify(rangeBlob.slice(rangeBlob.indexOf('[当前状态]'), rangeBlob.indexOf('[当前状态]') + 300))}`
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
    detail: hasHeader ? '' : `没找到「—— 关系 ——」：${JSON.stringify(groupBlob.slice(groupBlob.indexOf('[当前状态]'), groupBlob.indexOf('[当前状态]') + 300))}`
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

  // --- 真卡回归样本：某站点导出的 v3 变体（没有 first_mes） ---
  // 上面那些是自造卡，这条用的是**真实导出文件的原始字节**，
  // 形状一模一样（含 chat_history 两个 session、extensions.status_template）。
  // 夹具就放在 tools/fixtures/ 下，改坏了会直接红。
  let realOk = false;
  let realDetail = '';
  try {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'v3-card-chat-history.json'));
    const real = run({ 'D:\\tmp\\real.json': fixture }, ['D:\\tmp\\real.json']);
    const rc = (real.characters || [])[0];
    realOk =
      !!rc &&
      rc.name === '纯爱芭芭拉' &&
      String(rc.firstMes || '').includes('图书馆的义工芭芭拉') &&
      String(rc.firstMes || '').includes('好感度：0/100') &&
      String(rc.description || '').includes('数值系统');
    realDetail = rc
      ? `name=${rc.name} firstMes=${(rc.firstMes || '').length}字 含状态栏=${String(rc.firstMes || '').includes('好感度：0/100')}`
      : JSON.stringify(real.errors);
  } catch (err) {
    realDetail = '读夹具失败：' + ((err && err.message) || err);
  }
  push('导入：真 v3 变体卡（仓库里的回归样本）开场白能读出来', realOk, realDetail);

  // 同一张真卡还要验「互动模板 → 角色属性」的映射。
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
 * 世界书存盘归一化的白名单验证。
 *
 * normalizeWorldbook 是**白名单式**的：没列进返回对象的字段直接消失。
 * recursive / opening / characters 都踩过这个坑 ——
 * 表现是「存一次盘，递归开关全变回关」，不报错、不提示。
 * 这里用真的落盘归一化跑一遍往返。
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
 * 生图的验证。关键一条：**它用的是「生图」那一组配置，而不是聊天模型** ——
 * 用错了的话界面照样出图，但你的对话模型会被当成画图模型去打 /images/generations，
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

  // 没归一化的向量也要能比（各家服务商不一样，这也是当初选余弦的原因）
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

app.whenReady().then(async () => {
  registerStubs();

  const win = new BrowserWindow({
    width: 1180,
    height: 800,
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

  win.webContents.on('console-message', (...args) => {
    // 新旧 Electron 的事件签名不一样，两种都兜住
    const first = args[0];
    const level = typeof args[1] === 'number' ? args[1] : first && first.level;
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    const text = String(message == null ? '' : message);
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
  if (!crashed) {
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
      probeExports(result);
      probeImport(result);
      probeWorldbookStore(result);
      probePanelFields(result);
      probeRecursion(result);
      probeImageMessage(result);
      probeImageGen(result);
      probeVectors(result);
      probeRag(result);
      await probeHover(win, result);
    } catch (err) {
      crashed = '宿主侧验证失败：' + ((err && err.message) || err);
    }
  }

  // --shot=<场景>：把窗口显示出来、切到指定界面再截图到 tools/shots/。
  // 结构和逻辑测试盖不住的「看着对不对」（间距、对齐、配色）得靠这个看，
  // 不用每次都临时加代码再删。
  // 用法：electron tools/smoke-test.js --no-sandbox --shot=settings
  const shotArg = (process.argv.find((a) => a.startsWith('--shot')) || '').split('=')[1];
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
      // --shot-accent=blue：切到商务蓝配色再截图（点真实的配色按钮）
      const shotAccent = (process.argv.find((a) => a.startsWith('--shot-accent')) || '').split('=')[1];
      if (shotAccent === 'blue') {
        await win.webContents.executeJavaScript(`document.querySelector('#btn-accent')?.click(); true`);
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
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await new Promise(r => setTimeout(r, 500));
            if ($$('#panel-fields .panel-row').length) break;
          }
          const box = $('#panel-box');
          if (box && box.classList.contains('collapsed')) { $('#btn-panel-collapse')?.click(); await new Promise(r => setTimeout(r, 300)); }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        chars: `
          document.querySelector('#btn-chars')?.click();
          await new Promise(r => setTimeout(r, 500));`,
        // 剧情选项：整条测试跑完正好停在场景 21 的会话里（最新回复带选项），
        // 这里只需要确认在聊天视图、把 toast 收掉，就能截到「气泡下面的选项块」。
        msgOptions: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          await new Promise(r => setTimeout(r, 300));`,
        charEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          document.querySelector('#btn-chars')?.click();
          await new Promise(r => setTimeout(r, 400));
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await new Promise(r => setTimeout(r, 600));
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
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

          const box = $('#panel-box');
          if (box && box.classList.contains('collapsed')) { $('#btn-panel-collapse')?.click(); await nap(300); }

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

          const box = $('#panel-box');
          if (box && box.classList.contains('collapsed')) { $('#btn-panel-collapse')?.click(); await nap(300); }

          const avatars = $$('#panel-cast .panel-avatar');
          const mine = avatars.find(b => b.dataset.owner === 'player') || avatars[0];
          if (mine) { mine.click(); await nap(320); }

          const eb = $('#state-cards .state-card .sc-edit');
          if (eb) { eb.click(); await nap(360); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 面板**收起态**下的头像行：收起后再把入口藏起来就谁也找不到了，
        // 所以这一行要一直在（并排进细条里，不撑成两行）。
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

          const box = $('#panel-box');
          if (box && !box.classList.contains('collapsed')) { $('#btn-panel-collapse')?.click(); await nap(320); }

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
        const shotName = `${shotArg}${shotAccent === 'blue' ? '-blue' : ''}${shotDark ? '-dark' : ''}.png`;
        fs.writeFileSync(path.join(dir, shotName), (await win.webContents.capturePage()).toPNG());
        console.log(`  截图: tools/shots/${shotName}`);
      }
    } catch (err) {
      console.log('  截图失败:', (err && err.message) || err);
    }
  }

  const ok = report(result, consoleErrors, consoleWarnings, crashed);
  app.exit(ok ? 0 : 1);
});
// 兜底：万一卡住（窗口没起来 / executeJavaScript 不返回），别让终端一直挂着
setTimeout(() => {
  console.error('\n  ⏱ 冒烟测试超过 90 秒没有结束，判定失败\n');
  app.exit(2);
}, OVERALL_TIMEOUT_MS).unref();
