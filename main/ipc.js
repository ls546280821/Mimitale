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

// ⚠️ 这里不再需要 app：数据目录已经不走 app.getPath('userData') 了（见 main/data-dir.js）。
const { ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const {
  dataFile,
  writeJson,
  loadJsonWithFallback,
  loadConversations,
  saveConversations,
  loadCharacters,
  saveCharacters,
  newWorldbookId,
  loadWorldbooks,
  saveWorldbooks,
  worldbookEntriesByIds,
  loadPresets,
  savePresets,
  loadVectors,
  saveVectors
} = require('./store.js');
const {
  COMMON_MODELS,
  PROVIDER_PRESETS,
  normalizeProvider,
  resolveProvider,
  endpointFor,
  isBridgeProvider,
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
  streamChat,
  bridgeChat,
  bridgeDraw,
  bridgeDrawProgress,
  bridgeHealth
} = require('./http.js');
const { getMainWindow, sendToRenderer } = require('./window.js');
// 数据目录在哪、能不能写 —— 都归 main/data-dir.js 管（默认是程序旁边的 data\）
const { dataDir, dataDirInfo, probeDirWritable } = require('./data-dir.js');

// 关键词命中判定、递归扫描这些纯逻辑都在 main/worldbook-match.js 里。
const { matchWorldbookEntries, formatWorldbookSection } = require('./worldbook-match.js');
const { parseImportFile } = require('./card-import.js');
const { importFiles, MAX_IMPORT_BYTES } = require('./import-files.js');
// 外部世界书里那份 `characters`（世界书自带的 NPC）要过一遍角色归一化器 ——
// 不注入的话它会被静默丢掉，见 main/import-files.js 的注释。
const { normalizeCharacter } = require('./characters.js');
// 预设导入时要过一遍**落盘用的**那个归一化器 —— 导进来的东西当场就是内部形状，
// 界面不用再认一遍「别人分享的格式」。
const { normalizePreset } = require('./presets.js');
// 角色卡要能导出成「酒馆 PNG 卡」—— 卡数据 base64 后塞进 PNG 的 tEXt 块。
const { pngWithTextChunk } = require('./png.js');
// 记忆检索的向量与排序，纯函数，同样为了可测而独立成模块。
const { encodeVector, decodeVector, rankBySimilarity, collectCandidates } = require('./vectors.js');
// 「这一轮到底发出去了什么」—— 只存内存的环形缓冲，见 main/request-log.js
const { recordRequest, listRequests, clearRequests, MAX_ENTRIES: MAX_LOGGED_REQUESTS } = require('./request-log.js');
// 桌宠：通道注册在这里，实现都在 main/pet-*.js（窗口 / 数据 / 发言）
const { registerPetIpc } = require('./pet-ipc.js');

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

// ---------------------------------------------------------------------------
//  文件选择框的「上次位置」
//
//  系统弹框不带 defaultPath 时，每次都会回到默认目录，用户得反复点进文件夹。
//  这里把上一次选中的目录记下来，下次弹框作为 defaultPath 传进去。目录存在
//  userData\dialog-state.json，重开 App 也还在。
//  导入 / 选图 / 保存共用同一份记忆 —— 「上次在哪，这次就从哪开」最符合直觉。
// ---------------------------------------------------------------------------

let lastDialogDir = '';
let lastDialogDirLoaded = false;

function dialogStateFile() {
  return dataFile('dialog-state.json');
}

/** 目录还存在吗？被删/被移走后不能再拿来当默认位置 */
function isUsableDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
}

/** 取上次用过的目录（懒加载一次，读到的目录要还在才用） */
function lastDirForDialog() {
  if (!lastDialogDirLoaded) {
    lastDialogDirLoaded = true;
    try {
      const data = loadJsonWithFallback(dialogStateFile());
      const dir = data && typeof data.lastDir === 'string' ? data.lastDir : '';
      if (dir && isUsableDir(dir)) lastDialogDir = dir;
    } catch (err) {
      // 记不住位置不是致命问题：静默退回系统默认目录
    }
  }
  return lastDialogDir;
}

/** 记住这次选中的路径所在目录（给下一次弹框用） */
function rememberDialogDir(chosenPath) {
  const dir = chosenPath ? path.dirname(chosenPath) : '';
  if (!dir || dir === lastDialogDir || !isUsableDir(dir)) return;
  lastDialogDir = dir;
  lastDialogDirLoaded = true;
  try {
    writeJson(dialogStateFile(), { lastDir: dir });
  } catch (err) {
    // 落盘失败只影响「下次记不住」，不影响本次结果
  }
}

/** 弹框的默认目录（没记录过就返回 undefined，交给系统默认） */
function dialogDefaultDir() {
  return lastDirForDialog() || undefined;
}

/** 保存框的默认路径：上次目录 + 文件名（fileName 已是绝对路径就直接用） */
function dialogDefaultSavePath(fileName) {
  const base = String(fileName || 'export');
  if (path.isAbsolute(base)) return base;
  const dir = dialogDefaultDir();
  return dir ? path.join(dir, base) : base;
}

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

/**
 * 注册「关窗口前的最后一次保存」通道。
 *
 * 走同步写入（immediate）：程序马上要退出了，排队等微任务可能来不及。
 * 因为不需要回执，走的是 ipcMain.on 而不是 handle —— 代价是**回调里抛出去的异常
 * 没有调用方能接**，会直接变成主进程的 uncaughtException，Electron 于是弹一个
 * 原生「A JavaScript error occurred in the main process」框，把 JS 堆栈糊在用户脸上，
 * 还得点「确定」。关个窗口弹出这个，看着像程序崩了。
 *
 * 所以这里必须自己兜住：写不进去就写不进去，控制台留一行日志就够。
 * 真正的失败原因（比如杀软瞬时锁住文件）已经在 store.js 里 warn 过一遍了。
 */
function registerSyncSave(channel, save) {
  ipcMain.on(channel, (_event, payload) => {
    try {
      save(payload, { immediate: true });
    } catch (err) {
      console.error(`[ipc] ${channel} 写入失败（关窗口路径，静默降级）:`, err.message);
    }
  });
}

/**
 * 用资源管理器打开一个目录。返回 null = 成功，返回字符串 = 错误原因。
 *
 * ⚠️ **别改回 shell.openPath。** 它在这台机器上时成时败 —— 实测同一个进程里：
 *    打开 `C:\Users\...\AppData\Roaming\Electron` 返回 ""（成功）、
 *    打开同级的 `...\Roaming\Mimitale` 返回 "Failed to open path"；
 *    两个目录的 ACL / 属性 / 重解析点查下来**完全一样**，连单独调一次
 *    `...\Roaming` 自己都会失败。也就是说不稳定在系统层（ShellExecuteEx
 *    到 shell 关联那一段），不是路径或权限的问题。
 *    更要命的是：它失败时会**弹一个 Windows 系统错误框**
 *    （「Windows 无法访问指定设备、路径或文件」，标题是 electron.exe），
 *    用户看着像程序崩了，而我们连成没成都拿不到（返回值被丢掉了）。
 *
 * 直接 CreateProcess 起 explorer.exe 是可靠的（实测能打开），
 * 而且完全在我们自己手里：失败有 error 事件，也不会弹系统框。
 */
function openFolderInExplorer(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      resolve(err || null);
    };

    let child;
    try {
      child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
    } catch (err) {
      finish((err && err.message) || '无法启动资源管理器');
      return;
    }

    child.once('error', (err) => finish((err && err.message) || '无法启动资源管理器'));
    child.once('spawn', () => {
      child.unref();
      finish(null);
    });
    // explorer 有时候不把 spawn 事件回给调用方（复用了已有窗口），
    // 别把调用方吊死在那里
    setTimeout(() => finish(null), 1500);
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

    // 本机桥接走 /health，不要求 API Key
    if (isBridgeProvider(provider)) {
      const health = await bridgeHealth(provider.baseUrl);
      const textOk = health.text_engine === true;
      const imageOk = health.image_engine === true;
      const model = String(health.text_model || '');
      return {
        ok: true,
        count: model ? 1 : 0,
        models: model ? [model] : [],
        message: `桥接服务在线（文字引擎${textOk ? '在线' : '离线'}、图像引擎${imageOk ? '在线' : '离线'}${model ? `，模型 ${model}` : ''}）。`
      };
    }

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

    // 本机桥接没有 /models 接口，从 /health 拿当前文字模型名
    if (isBridgeProvider(provider)) {
      try {
        const health = await bridgeHealth(provider.baseUrl);
        const model = String(health.text_model || '').trim();
        return model ? [model] : [];
      } catch (err) {
        throw new Error((err && err.message) || '桥接服务未启动');
      }
    }

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

  // 关窗口时的「最后存一次」，不需要回执（失败只记日志，见 registerSyncSave）
  registerSyncSave('conversations:save-sync', saveConversations);

  // --- 角色库 ---

  ipcMain.handle('characters:get', () => loadCharacters());

  ipcMain.handle('characters:save', (_event, payload) => saveCharacters(payload));

  registerSyncSave('characters:save-sync', saveCharacters);

  // --- 世界书 ---

  ipcMain.handle('worldbooks:get', () => loadWorldbooks());

  ipcMain.handle('worldbooks:save', (_event, payload) => saveWorldbooks(payload));

  registerSyncSave('worldbooks:save-sync', saveWorldbooks);

  // --- 预设 ---
  // 对话层面叠上去的一层指令。和角色库、世界书同级：各自一个文件，
  // 靠「会话绑定了哪几条」决定生效（convo.dialoguePresetIds，可多条）。

  ipcMain.handle('presets:get', () => loadPresets());

  ipcMain.handle('presets:save', (_event, payload) => savePresets(payload));

  registerSyncSave('presets:save-sync', savePresets);

  /**
   * 导入预设：弹文件框、读 JSON、过归一化后返回，**不落盘**。
   * 收不收、收哪几条由界面决定 —— 用户取消时盘上一点都不会变。
   *
   * 一个文件里可能是**一条**预设，也可能是**一整个数组**（导出的就是这种）。
   * 两种都认，所以先探形状再归一化。归一化器是落盘时用的同一份，
   * 这样「别人分享的预设」在导进来的时候就已经被整理成内部形状了。
   */
  ipcMain.handle('presets:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择预设文件',
      buttonLabel: '导入',
      defaultPath: dialogDefaultDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '预设文件（JSON）', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, presets: [], errors: [] };
    }
    rememberDialogDir(result.filePaths[0]);

    const out = [];
    const errors = [];

    for (const file of result.filePaths) {
      try {
        const stat = fs.statSync(file);
        // 和角色卡导入同一个上限（12MB）—— 预设是纯文本，正常远小于这个数
        if (stat.size > MAX_IMPORT_BYTES) {
          errors.push(`${path.basename(file)}：文件太大了（${Math.round(stat.size / 1024 / 1024)}MB）`);
          continue;
        }

        const text = fs.readFileSync(file, 'utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          errors.push(`${path.basename(file)}：不是合法的 JSON`);
          continue;
        }

        // 三种常见形态：单条对象 / 数组 / { presets: [...] }
        let items = [];
        if (Array.isArray(data)) items = data;
        else if (data && Array.isArray(data.presets)) items = data.presets;
        else if (data && typeof data === 'object') items = [data];

        if (!items.length) {
          errors.push(`${path.basename(file)}：里面没有预设`);
          continue;
        }

        for (const item of items) {
          // ⚠️ 导入时**不带 id**：id 是对内唯一的，撞了会把已有的预设顶掉。
          //    由界面那边重新发一批（和角色卡导入同一套做法）。
          const preset = normalizePreset(item);
          if (!preset) continue;
          preset.id = undefined;
          out.push(preset);
        }
      } catch (err) {
        errors.push(`${path.basename(file)}：${(err && err.message) || '读取失败'}`);
      }
    }

    return { canceled: false, presets: out, errors };
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
      defaultPath: dialogDefaultDir(),
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
    rememberDialogDir(result.filePaths[0]);

    const imported = importFiles({
      paths: result.filePaths,
      readFile: (file) => fs.readFileSync(file),
      parseImportFile,
      makeWorldbookId: newWorldbookId,
      // 书里带的 NPC 也要收进来（导出的世界书再导回来是一个闭环）
      normalizeCharacters: (raw) => normalizeCharacter(raw, 'json'),
      // 和主进程别处保持一致：单文件 12MB
      maxBytes: MAX_IMPORT_BYTES
    });

    return { canceled: false, ...imported };
  });

  // 最近一次批量选图选中的路径。images:read 只认这一批 ——
  // 不让渲染层借这条通道去读盘上任意文件。
  let pickedImagePaths = new Set();

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
      defaultPath: dialogDefaultDir(),
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: Object.keys(IMAGE_MIME).map((e) => e.slice(1)) }]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dataUrl: '', error: '' };
    }
    rememberDialogDir(result.filePaths[0]);

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

  /**
   * 一次选多张图（或者整个文件夹），只回路径、不回内容 ——
   * 一套情绪差分动辄二十几张，一次把内容全塞回来会顶爆 IPC。
   * 界面拿到路径后逐张走 images:read 读，读完一张压一张。
   */
  ipcMain.handle('images:pick-many', async (_event, options) => {
    const opts = options || {};
    const useDirectory = opts.directory === true;
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: opts.title || (useDirectory ? '选择图片文件夹' : '选择图片（可多选）'),
      buttonLabel: '导入',
      defaultPath: dialogDefaultDir(),
      properties: useDirectory ? ['openDirectory'] : ['openFile', 'multiSelections'],
      ...(useDirectory
        ? {}
        : {
            filters: [
              { name: '图片', extensions: Object.keys(IMAGE_MIME).map((e) => e.slice(1)) }
            ]
          })
    });

    if (result.canceled || !result.filePaths.length) return { canceled: true, files: [] };
    rememberDialogDir(result.filePaths[0]);

    let paths = [];
    if (useDirectory) {
      for (const dir of result.filePaths) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch (err) {
          continue;
        }
        // 按文件名自然序（A1 < A2 < A10），差分的顺序才不会乱
        for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
          const full = path.join(dir, name);
          if (!IMAGE_MIME[path.extname(name).toLowerCase()]) continue;
          let isFile = false;
          try {
            isFile = fs.statSync(full).isFile();
          } catch (err) {
            isFile = false;
          }
          if (isFile) paths.push(full);
        }
      }
    } else {
      paths = result.filePaths.slice();
    }

    // 记下来：images:read 只认这批路径，防止渲染层拿着这个通道读任意文件
    pickedImagePaths = new Set(paths);
    return { canceled: false, files: paths.map((p) => ({ path: p, name: path.basename(p) })) };
  });

  /** 读一张刚选进来的图，转成 dataURL（页面被 CSP 挡着，读不了本地文件） */
  ipcMain.handle('images:read', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!pickedImagePaths.has(target)) {
      return { dataUrl: '', error: '这张图不在本次选中的文件里，请重新选择' };
    }

    const ext = path.extname(target).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return { dataUrl: '', error: `不支持的图片格式：${ext || '未知'}` };

    try {
      const buffer = fs.readFileSync(target);
      if (buffer.length > MAX_IMPORT_BYTES) {
        return {
          dataUrl: '',
          error: `图片太大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${MAX_IMPORT_BYTES / 1048576}MB）`
        };
      }
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, error: '' };
    } catch (err) {
      return { dataUrl: '', error: `读取失败：${(err && err.message) || '未知错误'}` };
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

    // 预设（会话级）里填过的采样参数覆盖全局设置。没填的项保持原样 ——
    // 渲染层只把「确实设过」的那几项传上来，所以这里是白名单式的逐项覆盖。
    const sampling = request.sampling && typeof request.sampling === 'object' ? request.sampling : null;
    if (sampling) {
      if (Number.isFinite(sampling.temperature)) endpoint.temperature = sampling.temperature;
      if (Number.isFinite(sampling.maxTokens)) endpoint.maxTokens = Math.round(sampling.maxTokens);
      if (Number.isFinite(sampling.topP)) endpoint.topP = sampling.topP;
    }

    // 本机桥接服务免 Key；其余 OpenAI 兼容服务商照旧要求
    const isBridge = isBridgeProvider(resolveProvider(settings, request.providerId));
    if (!isBridge && !endpoint.apiKey) {
      return { ok: false, requestId, error: `还没有填写「${endpoint.providerName}」的 API Key。` };
    }

    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();
    const { signal } = activeController;

    try {
      if (isBridge) {
        const result = await bridgeChat({
          settings: endpoint,
          messages,
          characterContext: request.characterContext,
          // 生成角色这类「只要文字」的场景传 noImage：桥接默认会按正文语义
          // 判断该不该配图，命中就要卸文字模型、出图、再把模型热回来 ——
          // 白等几十秒还占显存。字段缺省时照旧。
          noImage: request.noImage === true,
          signal
        });
        return {
          ok: true,
          requestId,
          providerId: endpoint.providerId,
          providerName: endpoint.providerName,
          model: endpoint.model,
          ...result
        };
      }

      const result = await streamChat({
        settings: endpoint,
        messages,
        signal,
        // 留一份「发出去的原文」（顶栏「⋯」→ 请求记录）。
        // 回调由 http.js 在拼好 body 之后触发，所以这份就是服务端收到的原样内容。
        onRequest: (body, url) =>
          recordRequest({
            requestId,
            providerName: endpoint.providerName,
            url,
            body
          }),
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

  /**
   * 请求记录：把最近几次**实际发出去**的请求读给界面看。
   *
   * 只读内存（main/request-log.js），所以随时可清、也不涉及任何落盘。
   * 它不是配置项，不进 settings；重启就空 —— 界面上的文案也如实这么写。
   */
  ipcMain.handle('chat:requests', () => ({
    entries: listRequests(),
    max: MAX_LOGGED_REQUESTS
  }));

  ipcMain.handle('chat:requests:clear', () => {
    clearRequests();
    return true;
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
      defaultPath: dialogDefaultSavePath(request.fileName),
      filters: Array.isArray(request.filters) ? request.filters : []
    });

    if (result.canceled || !result.filePath) return { canceled: true };
    rememberDialogDir(result.filePath);

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
   * 用系统浏览器打开一个链接（搜索结果里的来源点进去就走这里）。
   *
   * 只放行 http / https：别的协议（file:、javascript: 之类）一律不开，
   * 否则这条通道就成了任意启动器 —— 页面里塞什么就能拉起什么。
   */
  ipcMain.handle('util:openExternal', async (_event, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持打开 http / https 链接' };
    try {
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '打开链接失败' };
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
   * 本机桥接的「配图」：输入一段文字，直接调 /draw 出图。
   *
   * 和 images:generate 不同 —— 它走本机桥接（本地 ComfyUI），不是云生图。
   * 给「配图」按钮在本机桥接会话下用：平时聊天纯文字，点按钮才出图。
   */
  ipcMain.handle('bridge:draw', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const provider = resolveProvider(settings, request.providerId);
    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint || !isBridgeProvider(provider)) {
      return { ok: false, error: '生图服务商不是本机桥接，无法用本地模型配图。' };
    }

    const text = String(request.text || '').trim();
    if (!text) return { ok: false, error: '没有可用来配图的文字。' };

    try {
      const result = await bridgeDraw({
        baseUrl: endpoint.baseUrl,
        text,
        characterContext: request.characterContext,
        // 和聊天保持一致：画风预设关掉，长相完全由角色卡决定
        preset: 'none'
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '出图失败' };
    }
  });

  /**
   * 本机桥接的出图进度查询：GET /draw/progress。
   * 酒馆配图时轮询它，显示「采样到第几步」。
   */
  ipcMain.handle('bridge:drawProgress', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();
    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) return { ok: false, error: '还没有配置生图服务商。' };
    try {
      const result = await bridgeDrawProgress(endpoint.baseUrl);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '查询进度失败' };
    }
  });

  ipcMain.handle('util:openPath', async (_event, which) => {
    // 打开**真正的**数据目录（默认是程序旁边的 data\，见 main/data-dir.js）。
    // ⚠️ 别改回 app.getPath('userData')：那是 Chromium 的 profile 目录
    //    （缓存 / Local State / Preferences），用户的数据文件已经不在那儿了 ——
    //    照着它打开，用户会看到一个没有自己角色卡的文件夹。
    const dir = dataDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      return { ok: false, path: dir, error: `数据文件夹不存在，也建不出来：${err.message}` };
    }

    // 先探这个进程能不能往数据目录里写字。
    //
    // ⚠️ 「explorer.exe 起来了」**不等于**「文件夹真的打开了」：2026-10-08 实测，
    //    被沙箱 / 权限限制住的进程照样能 spawn 出 explorer.exe（'spawn' 事件照常触发），
    //    但那个 explorer 继承的是同一个受限令牌，请求递不到已经开着的资源管理器，
    //    用户看到的就是「点了没反应」，而这边一路返回 ok —— 界面连句话都不会说。
    //    所以顺手探一次写权限：探不通就把「打不开」和**为什么**一起说清楚。
    const writable = probeDirWritable(dir);
    const info = dataDirInfo();

    // 返回值带上成败：以前只把路径递回去、也不看 openPath 的结果，
    // 于是失败时用户只看到 Windows 自己弹的框，应用这边一句解释都没有。
    if (process.platform === 'win32') {
      const error = await openFolderInExplorer(dir);
      if (error) {
        return {
          ok: false,
          path: dir,
          info,
          error: writable.ok ? error : `${error}（另外，这个进程也写不进这个目录：${writable.error}）`
        };
      }
      if (!writable.ok) {
        return {
          ok: false,
          path: dir,
          info,
          writable: false,
          error:
            `资源管理器已启动，但这个进程写不进数据目录（${writable.error}）—— 保存会全部失败。` +
            '常见原因：程序所在的文件夹被安全软件或沙箱限制住了，只允许它写自己那个目录；' +
            '或者那个目录本身没有写权限。把整个 Mimitale 文件夹复制到别处再启动，通常就好了。'
        };
      }
      return { ok: true, path: dir, info, writable: true };
    }

    // 非 Windows：shell.openPath 是常规做法，它的返回值就是错误信息
    const error = await shell.openPath(dir);
    return error ? { ok: false, path: dir, info, error } : { ok: true, path: dir, info, writable: writable.ok };
  });

  // 桌宠的通道单独一个模块（main/pet-ipc.js）：它是**一块独立的功能**，
  // 有自己的窗口、自己的模型调用、自己的控制器，塞进来只会让这个文件更难读。
  // 但它仍然是「在这里注册」，这条约定没变 —— 找 IPC 通道永远只有一个地方。
  registerPetIpc();
}

module.exports = { registerIpc };
