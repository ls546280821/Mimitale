'use strict';

// ============================================================================
//  main/ipc.js —— IPC 通道注册：界面通过这里调用主进程能力
//
//  每个 handler 只做参数转发 + 一点点编排，真正的实现分别在：
//    main/store.js      数据落盘与读取
//    main/providers.js  设置与服务商
//    main/http.js       大模型请求
//    main/window.js     窗口
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const {
  loadConversations,
  saveConversations,
  loadCharacters,
  saveCharacters,
  newWorldbookId,
  loadWorldbooks,
  saveWorldbooks,
  worldbookEntriesByIds,
  loadVectors,
  saveVectors
} = require('./store.js');
const {
  COMMON_MODELS,
  PROVIDER_PRESETS,
  normalizeProvider,
  resolveProvider,
  endpointFor,
  loadSettings,
  saveSettings
} = require('./providers.js');
const {
  buildHeaders,
  modelsUrl,
  imagesUrl,
  embeddingsUrl,
  downloadBinary,
  requestJson,
  streamChat
} = require('./http.js');
const { getMainWindow, sendToRenderer } = require('./window.js');

// 关键词命中判定、递归扫描这些纯逻辑都在 main/worldbook-match.js 里。
const { matchWorldbookEntries, formatWorldbookSection } = require('./worldbook-match.js');
const { parseImportFile } = require('./card-import.js');
const { importFiles, MAX_IMPORT_BYTES } = require('./import-files.js');
// 角色卡要能导出成「酒馆 PNG 卡」—— 卡数据 base64 后塞进 PNG 的 tEXt 块。
const { pngWithTextChunk } = require('./png.js');
// 记忆检索的向量与排序，纯函数，同样为了可测而独立成模块。
const { encodeVector, decodeVector, rankBySimilarity, collectCandidates } = require('./vectors.js');

let activeController = null; // 用于「停止生成」

// 允许当头像的图片格式（扩展名 → MIME）
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

// 一次最多补多少条向量。第一次开语义检索时长对话可能有几百条要索引，
// 一次全塞进一个请求既慢又容易被接口限流 —— 分几轮补齐就行
const MAX_EMBED_PER_CALL = 32;
// 一次请求最多多少条文本（查询 + 补索引共用）
const MAX_EMBED_INPUTS = 64;

/** 调一次 /embeddings，返回向量数组（顺序和输入一一对应） */
async function embedTexts(endpoint, texts) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || '').slice(0, 8000));
  if (!list.length) return [];

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const json = await requestJson({
    url: embeddingsUrl(endpoint.baseUrl),
    method: 'POST',
    headers,
    body: { model: endpoint.model, input: list },
    timeoutMs: 60000
  });

  const data = Array.isArray(json && json.data) ? json.data : null;
  if (!data || data.length !== list.length) {
    throw new Error('向量接口返回的条数和请求对不上。');
  }

  // 有的服务商不保证顺序，按 index 排一下更稳
  const sorted = data.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  return sorted.map((d) => d.embedding);
}

/** 世界书 / 会话里所有够格的候选文本（收集逻辑在 main/vectors.js，那边是纯函数） */
function ragCandidates(request) {
  const { conversations } = loadConversations();
  const convo = conversations.find((c) => c.id === request.convoId);
  const { worldbooks } = loadWorldbooks();

  return collectCandidates({
    messages: convo ? convo.messages : [],
    recentCount: request.recentCount,
    books: worldbooks,
    worldbookIds: request.worldbookIds
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => {
    const settings = loadSettings();
    return { settings, models: COMMON_MODELS, presets: PROVIDER_PRESETS };
  });

  ipcMain.handle('settings:save', (_event, patch) => saveSettings(patch));

  /**
   * 「测试连接」和「拉取模型」都可能拿界面上还没保存的内容来试，
   * 所以这里优先用传进来的 provider 对象，其次才用已保存的设置。
   */
  function providerFromPayload(payload) {
    const p = payload || {};
    if (p.provider && typeof p.provider === 'object') {
      return normalizeProvider(p.provider, p.provider.id);
    }
    return resolveProvider(loadSettings(), p.providerId);
  }

  ipcMain.handle('settings:test', async (_event, payload) => {
    const provider = providerFromPayload(payload);
    if (!provider) throw new Error('还没有配置任何服务商。');
    if (!provider.apiKey) throw new Error(`请先填写「${provider.name}」的 API Key。`);

    const data = await requestJson({
      url: modelsUrl(provider.baseUrl),
      headers: buildHeaders(provider),
      timeoutMs: 20000
    });
    const models = Array.isArray(data && data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];

    return {
      ok: true,
      count: models.length,
      models: models.slice(0, 200),
      message: models.length
        ? `连接成功，${provider.name} 提供 ${models.length} 个模型。`
        : `连接成功（${provider.name} 未返回模型列表，可以直接对话试试）。`
    };
  });

  ipcMain.handle('models:list', async (_event, payload) => {
    const provider = providerFromPayload(payload);
    if (!provider) throw new Error('还没有配置任何服务商。');
    if (!provider.apiKey) throw new Error(`请先填写「${provider.name}」的 API Key。`);

    const data = await requestJson({
      url: modelsUrl(provider.baseUrl),
      headers: buildHeaders(provider),
      timeoutMs: 20000
    });
    const models = Array.isArray(data && data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    return models.sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle('conversations:get', () => loadConversations());

  ipcMain.handle('conversations:save', (_event, payload) => saveConversations(payload));

  // 关窗口时的「最后存一次」，不需要回执。
  // 这里走同步写入：程序马上要退出了，排队等微任务可能来不及。
  ipcMain.on('conversations:save-sync', (_event, payload) => {
    saveConversations(payload, { immediate: true });
  });

  // --- 角色库 ---

  ipcMain.handle('characters:get', () => loadCharacters());

  ipcMain.handle('characters:save', (_event, payload) => saveCharacters(payload));

  ipcMain.on('characters:save-sync', (_event, payload) => {
    saveCharacters(payload, { immediate: true });
  });

  // --- 世界书 ---

  ipcMain.handle('worldbooks:get', () => loadWorldbooks());

  ipcMain.handle('worldbooks:save', (_event, payload) => saveWorldbooks(payload));

  ipcMain.on('worldbooks:save-sync', (_event, payload) => {
    saveWorldbooks(payload, { immediate: true });
  });

  /**
   * 世界书预览：按当前会话的近期消息跑一遍匹配，返回命中的条目。
   * 作用域是「会话绑定的 + 角色绑定的」两批合起来 —— 会话级在前，
   * 和酒馆的 Chat Lore 一个思路：会话自己选的设定优先于角色自带的。
   * 界面用它显示「这一轮会注入哪些设定」，也方便排查关键词写没写对。
   */
  ipcMain.handle('worldbooks:preview', (_event, payload) => {
    const request = payload || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];

    // 只取 role/content 参与匹配，和真实请求时的扫描范围保持一致
    let scanDepth = Number(request.scanDepth);
    if (!isFinite(scanDepth) || scanDepth <= 0) scanDepth = 6;
    scanDepth = Math.min(50, Math.floor(scanDepth));

    const usable = messages.filter(
      (m) => m && typeof m.content === 'string' && String(m.content).trim()
    );
    const scanText = usable
      .slice(-scanDepth)
      .map((m) => String(m.content))
      .join('\n');

    // 要注入哪些书，完全由渲染层传进来的 id 决定 —— 这里不做任何「按角色自动带上」的判断。
    // 渲染层的 effectiveWorldbookIds 负责算出这批 id：
    //   · 会话绑了世界书（含「进入世界」）→ 只用会话的
    //   · 会话没绑 → 才用角色自带的那几本（前提是那张卡的开关是开的）
    // 换句话说，角色库里的角色单独聊天**是会**注入设定的；
    // 早前那句「不会注入任何世界书」是旧设计，已经不成立。
    const convoIds = Array.isArray(request.worldbookIds) ? request.worldbookIds : [];
    const entries = worldbookEntriesByIds(convoIds);

    const result = matchWorldbookEntries(entries, scanText, {
      recursiveDepth: request.recursiveDepth
    });
    const hits = result.hits;

    return {
      total: entries.length,
      scanDepth,
      rounds: result.rounds,
      recursiveCount: result.recursiveCount,
      hits: hits.map((e) => ({
        id: e.id,
        title: e.title,
        worldbookName: e.worldbookName,
        order: e.order,
        recursive: e.recursive === true,
        length: String(e.content).length
      })),
      section: formatWorldbookSection(hits)
    };
  });

  /**
   * 导入角色卡 / 世界书：弹出文件选择框，把选中的 PNG / JSON 解析出来返回。
   * 这里只解析不落盘 —— 由界面决定要不要收下，用户取消时什么都不会变。
   *
   * 「一个文件是什么」的判断和归一化都在 main/card-import.js 里，
   * 抽出去是为了能单独测（这段以前夹在闭包和文件对话框之间，测不到，
   * 导致「卡里内嵌的世界书被丢掉」长期没被发现）。
   */
  ipcMain.handle('characters:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择角色卡或世界书',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '角色卡 / 世界书（PNG / JSON）', extensions: ['png', 'json'] },
        { name: '酒馆 PNG 角色卡', extensions: ['png'] },
        { name: 'JSON 角色卡 / 世界书', extensions: ['json'] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, characters: [], worldbooks: [], errors: [] };
    }

    const imported = importFiles({
      paths: result.filePaths,
      readFile: (file) => fs.readFileSync(file),
      parseImportFile,
      makeWorldbookId: newWorldbookId,
      // 和主进程别处保持一致：单文件 12MB
      maxBytes: MAX_IMPORT_BYTES
    });

    return { canceled: false, ...imported };
  });

  /**
   * 选一张本地图片当头像。
   * 页面被 CSP 挡着读不了文件，所以由主进程弹系统文件框、读文件、
   * 转成 dataURL 再交给界面 —— CSP 里 img-src 已经放行了 data:。
   */
  ipcMain.handle('images:pick', async (_event, options) => {
    const opts = options || {};
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: opts.title || '选择图片',
      buttonLabel: '使用这张',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: Object.keys(IMAGE_MIME).map((e) => e.slice(1)) }]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dataUrl: '', error: '' };
    }

    const file = result.filePaths[0];
    const ext = path.extname(file).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      return { canceled: false, dataUrl: '', error: `不支持的图片格式：${ext || '未知'}` };
    }

    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > MAX_IMPORT_BYTES) {
        return {
          canceled: false,
          dataUrl: '',
          error: `图片太大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${MAX_IMPORT_BYTES / 1048576}MB）`
        };
      }
      return { canceled: false, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, error: '' };
    } catch (err) {
      return { canceled: false, dataUrl: '', error: `读取失败：${(err && err.message) || '未知错误'}` };
    }
  });

  ipcMain.handle('chat:stop', () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
      return true;
    }
    return false;
  });

  ipcMain.handle('chat:send', async (event, payload) => {
    const request = payload || {};
    const settings = loadSettings();
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const requestId = request.requestId || `req-${Date.now()}`;

    // 界面指定了服务商，但磁盘上没有 —— 说明还没保存，宁可报错也不要发错服务商
    const requestedId = String(request.providerId || '').trim();
    if (requestedId && !settings.providers.some((p) => p.id === requestedId)) {
      return { ok: false, requestId, error: '这个服务商还没有保存，请到设置里点一下「保存」。' };
    }

    const endpoint = endpointFor(settings, request.providerId, request.model);

    if (!endpoint) {
      return { ok: false, requestId, error: '还没有配置模型服务，请点左下角「设置」添加。' };
    }
    if (!endpoint.apiKey) {
      return { ok: false, requestId, error: `还没有填写「${endpoint.providerName}」的 API Key。` };
    }

    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();
    const { signal } = activeController;

    try {
      const result = await streamChat({
        settings: endpoint,
        messages,
        signal,
        onDelta: (text) => sendToRenderer('chat:chunk', { requestId, text }),
        onReasoning: (text) => sendToRenderer('chat:reasoning', { requestId, text })
      });
      return {
        ok: true,
        requestId,
        providerId: endpoint.providerId,
        providerName: endpoint.providerName,
        model: endpoint.model,
        ...result
      };
    } catch (err) {
      return { ok: false, requestId, error: (err && err.message) || '未知错误' };
    } finally {
      if (activeController && activeController.signal === signal) {
        activeController = null;
      }
    }
  });

  ipcMain.handle('util:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  /**
   * 导出文件。渲染层把两种形态都准备好，**由用户选的后缀决定写哪一种**：
   *   · text              文本（.json / .md 用，按 utf8 写）
   *   · base64 + pngText  二进制（.png 用；pngText 会先作为 tEXt 块插进去）
   * 这样「导出角色卡」只需要一个按钮。
   */
  ipcMain.handle('util:saveFile', async (_event, payload) => {
    const request = payload || {};
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: request.title || '保存',
      defaultPath: request.fileName || 'export',
      filters: Array.isArray(request.filters) ? request.filters : []
    });

    if (result.canceled || !result.filePath) return { canceled: true };

    const ext = path.extname(result.filePath).toLowerCase();
    try {
      if (ext === '.png' && request.base64) {
        let buffer = Buffer.from(String(request.base64), 'base64');
        if (request.pngText && request.pngText.keyword) {
          buffer = pngWithTextChunk(buffer, request.pngText.keyword, request.pngText.text || '');
        }
        fs.writeFileSync(result.filePath, buffer);
      } else {
        fs.writeFileSync(result.filePath, String(request.text == null ? '' : request.text), 'utf8');
      }
    } catch (err) {
      return { canceled: false, error: (err && err.message) || '写文件失败' };
    }

    return { canceled: false, filePath: result.filePath };
  });

  /**
   * 语义检索（RAG）。
   *
   * 流程：收集候选（较早的消息 + 绑定的世界书条目）→ 补齐缺的向量（增量、每次最多
   * MAX_EMBED_PER_CALL 条）→ 给查询算向量 → 余弦排序取前 K 个 → 返回文本给渲染层注入。
   *
   * 只做「捞出来」，注入格式交给渲染层 —— 那边才知道该怎么措辞。
   */
  ipcMain.handle('rag:recall', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) return { ok: false, error: '还没有配置向量模型，请到「设置 → 语义检索」里选一个。' };
    if (!endpoint.apiKey) return { ok: false, error: `还没有填写「${endpoint.providerName}」的 API Key。` };

    const query = String(request.query || '').trim();
    if (!query) return { ok: false, error: '没有可用来检索的内容。' };

    const candidates = ragCandidates(request);
    if (!candidates.length) return { ok: true, items: [], embedded: 0, indexed: 0, total: 0 };

    const store = loadVectors();
    const keyOf = (c) => `${endpoint.model}::${c.key}`;

    try {
      // ---- 补齐缺的向量（增量）----
      const missing = candidates.filter((c) => !store.items[keyOf(c)]);
      const pending = missing.slice(0, Math.min(MAX_EMBED_PER_CALL, MAX_EMBED_INPUTS - 1));

      if (pending.length) {
        const vectors = await embedTexts(endpoint, pending.map((c) => c.text));
        pending.forEach((c, i) => {
          if (vectors[i]) store.items[keyOf(c)] = encodeVector(vectors[i]);
        });
        saveVectors(store);
      }

      // ---- 查询向量 ----
      const queryVector = (await embedTexts(endpoint, [query]))[0];
      if (!queryVector) return { ok: false, error: '向量接口没有返回查询向量。' };

      // ---- 排序 ----
      const ready = [];
      for (const c of candidates) {
        const raw = store.items[keyOf(c)];
        const vector = raw ? decodeVector(raw) : null;
        if (vector) ready.push({ ...c, vector });
      }

      const ranked = rankBySimilarity(Float32Array.from(queryVector), ready, {
        topK: request.topK,
        minScore: request.minScore
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
        embedded: pending.length,
        indexed: ready.length,
        total: candidates.length
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '语义检索失败' };
    }
  });

  /**
   * 生图。走 OpenAI 那套 /images/generations：
   *   { model, prompt, n: 1, size, response_format: 'b64_json' } → { data: [{ b64_json }] }
   *
   * 它和聊天**既不是同一个端点、通常也不是同一个模型**，所以设置里单独指一组。
   * 各家差异很大（通义万相那类是异步任务），这里只支持「同步返回图片」的这一套。
   */
  ipcMain.handle('images:generate', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) {
      return { ok: false, error: '还没有配置生图服务商，请到「设置 → 生图」里选一个。' };
    }
    if (!endpoint.apiKey) {
      return { ok: false, error: `还没有填写「${endpoint.providerName}」的 API Key。` };
    }

    const prompt = String(request.prompt || '').trim().slice(0, 2000);
    if (!prompt) return { ok: false, error: '没有可用的提示词。' };

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

    // 少数服务商（智谱）的图片接口不认 OpenAI 的 response_format / n，
    // 反而要求 quality。参数给错了它只回一句「API 调用参数有误」（错误码 1210），
    // 所以这里按服务商裁剪参数，别把不认识的字段一起发过去。
    const isZhipuImage = /bigmodel\.cn/i.test(String(endpoint.baseUrl || ''));
    const imageBody = {
      model: endpoint.model,
      prompt,
      size: String(request.size || settings.imageSize || '1024x1024')
    };
    if (isZhipuImage) {
      // glm-image 只支持 hd；cogview 系列默认 standard，不传就是默认值
      if (/^glm-image$/i.test(String(endpoint.model || ''))) imageBody.quality = 'hd';
    } else {
      imageBody.n = 1;
      imageBody.response_format = 'b64_json';
    }

    try {
      const json = await requestJson({
        url: imagesUrl(endpoint.baseUrl),
        method: 'POST',
        headers,
        body: imageBody,
        // 生图比聊天慢得多，给两分钟
        timeoutMs: 120000
      });

      const item = Array.isArray(json && json.data) ? json.data[0] : null;
      if (!item) return { ok: false, error: '接口没有返回图片（data 是空的）。' };

      if (item.b64_json) {
        return { ok: true, dataUrl: `data:image/png;base64,${item.b64_json}`, model: endpoint.model };
      }
      if (item.url) {
        // 有的服务商会无视 response_format 直接给链接。
        // 渲染层 CSP 是 img-src 'self' data:，外链加载不了 —— 所以在主进程下载回来。
        const buffer = await downloadBinary(String(item.url));
        const mime = /\.jpe?g($|\?)/i.test(String(item.url)) ? 'image/jpeg' : 'image/png';
        return {
          ok: true,
          dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
          model: endpoint.model
        };
      }
      return { ok: false, error: '接口返回里既没有 b64_json 也没有 url。' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '生图失败' };
    }
  });

  /**
   * 点开看大图。渲染层的 CSP 是 img-src 'self' data:，直接 window.open 会被拦，
   * 所以在这里落一个临时文件、开一个只显示这张图的窗口，关掉时把文件删了。
   */
  ipcMain.handle('images:open', (_event, dataUrl) => {
    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!match) return false;

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const file = path.join(app.getPath('temp'), `mimitale-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);

    try {
      fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
    } catch (err) {
      return false;
    }

    const viewer = new BrowserWindow({
      width: 960,
      height: 720,
      title: '图片',
      autoHideMenuBar: true,
      backgroundColor: '#1b1f27'
    });
    viewer.loadFile(file);
    viewer.once('closed', () => {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        /* 删不掉就算了，系统临时目录迟早会清 */
      }
    });

    return true;
  });

  ipcMain.handle('util:openPath', async (_event, which) => {
    // 直接打开数据文件夹，而不是高亮特定文件
    const dataDir = app.getPath('userData');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    shell.openPath(dataDir);
    return dataDir;
  });
}

module.exports = { registerIpc };
