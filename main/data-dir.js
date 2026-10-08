'use strict';

// ============================================================================
//  main/data-dir.js —— 「用户数据放哪」只在这里决定一次
//
//  2026-10-08 之前，会话 / 角色 / 世界书 / 预设 / 配置全都写在
//  `%APPDATA%\Mimitale`（也就是 C 盘）。对「拷给别人用」这个场景不合适：
//  数据散在系统盘、换机器就丢，用户也找不到自己的角色卡在哪。
//
//  现在的默认位置是**程序旁边的 `data\`**：
//     · 打包后   → exe 同级的 data\
//     · 免安装   → package.json 所在的那个文件夹（`electron .` 跑的就是它）
//  整个文件夹拷走 = 数据跟着走，卸载删文件夹即可。
//
//  ⚠️ 只搬「用户的数据文件」（见 DATA_FILES）。**Chromium 自己的 profile
//     （Cache / GPUCache / Local Storage / Preferences / Local State …）不搬** ——
//     那些是缓存，不是用户内容，留在系统默认位置最稳：程序被装在
//     `C:\Program Files` 这类只读目录里时，Chromium 照样起得来。
//
//  解析顺序（先命中先用）：
//    ① `app.getPath('userData')` 被**显式改过** → 用它
//       （测试工具的 `app.setPath('userData', 临时目录)`、命令行的 --user-data-dir
//        都属于这一类：调用方已经明确指定了位置，别自作聪明覆盖它）
//    ② 环境变量 `MIMITALE_DATA_DIR` → 用它（绿色版 / U 盘 / 放到别的盘）
//    ③ 程序旁边的 `data\` → 默认
//    ④ 兜底：系统默认的 `%APPDATA%\Mimitale`
//       ③ 建不出来或写不进去时（只读介质、装在 Program Files 下、权限策略…）
//       自动退到这儿 —— **宁可数据回 C 盘，也不能让程序因为搬数据而起不来**。
//
//  从老位置搬到新位置时会**拷贝**一次（只拷不删，老文件留着当保险）；
//  而且只在新位置一个数据文件都没有时才做，免得盖掉用户后来的改动。
// ============================================================================

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** 程序旁边那个数据目录的名字 */
const DATA_DIR_NAME = 'data';

/**
 * 哪些才算「用户的数据」。
 *
 * 这张表同时被三处用：搬家、判断新位置是不是空的、诊断工具。
 * 加新的数据文件时记得同步加一行（`xxx.json.backup` 由后缀循环自动带上）。
 */
const DATA_FILES = [
  'config.json',
  'conversations.json',
  'characters.json',
  'worldbooks.json',
  'presets.json',
  'vectors.json'
];

let cachedDir = null;
let cachedInfo = null;

/** Electron 自己算出来的默认 userData（`%APPDATA%\<应用名>`） */
function defaultUserDataDir() {
  return path.join(app.getPath('appData'), app.getName());
}

/**
 * userData 被显式改过吗？
 * 改过就说明调用方（测试 / --user-data-dir）已经指定了位置，一切以它为准。
 */
function userDataWasOverridden() {
  try {
    return path.resolve(app.getPath('userData')) !== path.resolve(defaultUserDataDir());
  } catch (err) {
    return false;
  }
}

/** 程序所在的文件夹：打包后 = exe 同级；免安装 = 项目根目录 */
function appFolder() {
  try {
    if (app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch (err) {
    /* 读不到就退回下面那条 */
  }
  return app.getAppPath();
}

/** 程序旁边的 data 目录（默认位置） */
function portableDataDir() {
  return path.join(appFolder(), DATA_DIR_NAME);
}

/**
 * 探一下「这个进程到底能不能往这个目录里写字」。
 *
 * 为什么要真写一个文件：`existsSync` 只能证明**读**得通。有一类环境
 * （沙箱 / 权限策略）是「目录存在、能列、能读，但一个文件都建不出来」——
 * 那时所有保存都会失败，而只看 `existsSync` 会以为一切正常。
 *
 * 只建一个随机名的空文件再删掉，不留痕迹。返回 { ok, error }。
 */
function probeDirWritable(dir) {
  const probe = path.join(dir, `.mimitale-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, error: '' };
  } catch (err) {
    try {
      fs.unlinkSync(probe);
    } catch (cleanupErr) {
      /* 没建出来 / 删不掉都无所谓 */
    }
    return { ok: false, error: err.message };
  }
}

/** 新目录里有没有数据文件（有一个就算「不是空的」） */
function hasAnyDataFile(dir) {
  return DATA_FILES.some((name) => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch (err) {
      return false;
    }
  });
}

/**
 * 把老位置的数据搬到新位置。**只拷不删**，而且只在新位置为空时动手。
 *
 * 只拷不删的理由：用户的数据没有「搬完就安全」这回事 —— 万一新位置那张盘
 * 后来坏了/被清了，C 盘还留着一份可以捞。代价只是几 KB 到几 MB 的重复。
 */
function migrateFromLegacy(toDir) {
  const legacy = defaultUserDataDir();
  if (path.resolve(legacy) === path.resolve(toDir)) return 0;
  if (!fs.existsSync(legacy)) return 0;
  // 新位置已经有数据 → 用户在那边用过了，别拿老的盖上去
  if (hasAnyDataFile(toDir)) return 0;

  let copied = 0;
  for (const name of DATA_FILES) {
    for (const suffix of ['', '.backup']) {
      const src = path.join(legacy, name + suffix);
      const dst = path.join(toDir, name + suffix);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.copyFileSync(src, dst);
        copied += 1;
      } catch (err) {
        console.warn('[data] 老数据拷贝失败（跳过这一份）:', path.basename(src), err.message);
      }
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------
//  数据目录里那份「使用说明.txt」
//
//  这个文件夹里只有几个 .json，用户点开只会一脸茫然（「这些是什么？能删吗？」）。
//  所以每次启动顺手放一份人话说明进去。
//
//  ⚠️ 必须是程序自己生成，不能只在仓库里放一个文件：`data/` 整个在 .gitignore 里
//     （那是用户的数据），clone / 拷贝代码的时候不会带上它 —— 靠人工放的话，
//     别人拿到手的 data\ 里就什么都没有。
//
//  ⚠️ 编码：**UTF-8 带 BOM**。Windows 记事本对不带 BOM 的 UTF-8 中文识别得时好时坏
//     （老版本会按 ANSI/GBK 解，中文全成乱码）。这个项目在 Start-Mimitale.ps1 上
//     已经踩过一次同类坑，这里直接用 BOM 换确定性。
// ---------------------------------------------------------------------------

const README_FILE_NAME = '使用说明.txt';

/** 说明正文（开头那个 \uFEFF 就是 BOM） */
function dataDirReadmeText() {
  return (
    '\uFEFF' +
    [
      'Mimitale 数据文件夹 —— 说明',
      '================================',
      '',
      '这里放的是你自己的东西：角色卡、聊天记录、世界书、预设和设置。',
      '程序把数据放在这里（而不是 C 盘），所以：',
      '',
      '  · 整个 Mimitale 文件夹拷走 = 数据跟着走，换电脑、换目录都不用重新配',
      '  · 想备份：把整个 data 文件夹复制一份就行',
      '  · 想清空重来：先关掉程序，再删掉这个文件夹，下次启动会重建一个空的',
      '',
      '各文件是什么',
      '--------------------------------',
      '  characters.json     角色库：导入或新建的角色卡都在这（含头像和立绘）',
      '  worldbooks.json     世界书（含从角色卡里抽出来的内嵌世界书）',
      '  conversations.json  所有聊天记录',
      '  presets.json        预设：叠在对话上的那层指令',
      '  config.json         设置。⚠️ 里面有 API Key（已加密），别把这个文件发人',
      '  vectors.json        语义检索的向量缓存。删了不影响聊天，会自己重建',
      '  dialog-state.json   文件选择框「上次打开的目录」。删了没影响',
      '',
      '  *.backup            每个文件上一次保存前的自动备份。',
      '                      主文件万一损坏，程序会自动从它恢复，所以别删。',
      '  *.tmp               写入过程中的临时文件，正常情况下看不到。',
      '                      如果看到了、而且程序没在运行，那它是残留，可以删。',
      '',
      '几条注意',
      '--------------------------------',
      '  · 程序运行的时候别手改这些 .json —— 退出时会被内存里的内容覆盖回去。',
      '  · 想换个位置放（比如 D 盘、U 盘），启动前设一个环境变量：',
      '        set MIMITALE_DATA_DIR=D:\\我的人设库',
      '  · Chromium 的缓存（Cache / GPUCache / Local Storage 等）不在这里，',
      '    仍留在系统盘。那些是缓存不是你的内容，删掉只会让下次启动稍慢一点。',
      '  · 别把这个文件夹设成只读，也别长期放在网盘/同步目录里用。',
      '',
      '本文件由程序自动生成：内容有变化会在下次启动时更新，删掉也会自动重建。',
      ''
    ].join('\r\n')
  );
}

/**
 * 确保数据目录里有一份说明。**失败只记日志** —— 它只是给人看的，
 * 绝不能因为它写不进去就影响程序启动或保存。
 * 内容没变就不动文件（免得每次启动都刷新 mtime）。
 */
function ensureDataDirReadme(dir) {
  const file = path.join(dir, README_FILE_NAME);
  const text = dataDirReadmeText();
  try {
    // 兜底那条路（退回 %APPDATA%）此时目录可能还不存在 —— 自己建出来，
    // 不然说明写不进去，而这个目录后面本来也要被数据写入用到。
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        if (fs.readFileSync(file, 'utf8') === text) return false;
      } catch (readErr) {
        /* 读不动就照写一遍 */
      }
    }
    fs.writeFileSync(file, text, 'utf8');
    return true;
  } catch (err) {
    console.warn('[data] 写数据目录说明失败（不影响使用）:', err.message);
    return false;
  }
}

/**
 * 决定数据目录放哪。不缓存、不写说明 —— 缓存和说明都由 dataDir() 负责。
 * 返回 { dir, info }。
 */
function resolveDataDir() {
  // ① 调用方显式改过 userData（测试 / --user-data-dir）
  if (userDataWasOverridden()) {
    return { dir: app.getPath('userData'), info: { source: 'userData-override', fallback: false } };
  }

  // ② 环境变量指定
  const envDir = String(process.env.MIMITALE_DATA_DIR || '').trim();
  if (envDir) {
    const probe = probeDirWritable(envDir);
    if (probe.ok) {
      return { dir: path.resolve(envDir), info: { source: 'env', fallback: false } };
    }
    console.warn('[data] MIMITALE_DATA_DIR 写不进去，忽略它并改用默认位置:', envDir, probe.error);
  }

  // ③ 程序旁边的 data\（默认）
  const portable = portableDataDir();
  const probe = probeDirWritable(portable);
  if (probe.ok) {
    const copied = migrateFromLegacy(portable);
    if (copied) {
      console.log(
        `[data] 数据目录已迁到程序旁边：${portable}` +
          `（从 ${defaultUserDataDir()} 拷了 ${copied} 个文件，老文件保留没删）`
      );
    }
    return { dir: portable, info: { source: 'portable', fallback: false, migrated: copied } };
  }

  // ④ 兜底：老位置
  console.warn(
    '[data] 程序旁边的 data 目录写不进去，退回系统默认数据目录:',
    portable,
    probe.error
  );
  return {
    dir: app.getPath('userData'),
    info: { source: 'fallback', fallback: true, error: probe.error }
  };
}

/**
 * 当前生效的数据目录（懒加载 + 缓存；第一次调用时决定、搬一次家、放一份说明）。
 *
 * ⚠️ 必须在**任何读写数据文件之前**调用才算数。store.js 的 dataFile() 是
 *    每次调用时才取目录，所以模块加载顺序不影响正确性。
 */
function dataDir() {
  if (cachedDir) return cachedDir;

  const { dir, info } = resolveDataDir();
  cachedDir = dir;
  cachedInfo = { dir, ...info };

  // 顺手放一份人话说明（失败不影响任何功能）
  ensureDataDirReadme(dir);

  return cachedDir;
}

/** 给界面 / 诊断用的一句话：数据在哪、为什么在那儿 */
function dataDirInfo() {
  if (!cachedInfo) dataDir();
  return {
    ...cachedInfo,
    portable: portableDataDir(),
    legacy: defaultUserDataDir()
  };
}

/** 只在测试里用：忘掉缓存，下次重新解析（改了环境变量后想立刻生效时） */
function resetDataDirCache() {
  cachedDir = null;
  cachedInfo = null;
}

module.exports = {
  dataDir,
  dataDirInfo,
  probeDirWritable,
  portableDataDir,
  defaultUserDataDir,
  resetDataDirCache,
  DATA_DIR_NAME,
  DATA_FILES,
  README_FILE_NAME
};
