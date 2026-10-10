'use strict';

// ============================================================================
//  tools/test-settings-migration.js —— 设置结构迁移（config.json 的 v1 → v2）
//
//  为什么要有这份测试：`DEFAULT_SETTINGS` **只对「磁盘上缺这个键」生效**。
//  而每次 saveSettings 都会把 normalizeSettings 的整份结果落盘 ——
//  也就是说老用户的 config.json 里每个键都是显式写着的，**光改默认值对他们无效**。
//  这个坑真踩过：把 worldbookRecursiveDepth 的默认值改成 0，老配置里那个 3 纹丝不动。
//  所以需要版本号 + 一次性迁移，而迁移这种东西最容易「看着对、其实没生效」——
//  第一版实现就踩了：迁移写在字段归一化**之前**，被后面「从 raw 重算」那段又改回 3。
//  下面的用例把「值真的变了」和「通知真的发出去了」都钉住。
//
//  跑法： node --test tools/test-settings-migration.js
//        （或 node tools/test-settings-migration.js —— 两种都行）
//
//  ⚠️ main/providers.js 会 require ./store.js，而 store.js 需要 electron 的
//     app / safeStorage。这里没有 Electron 运行时，所以先往 require 缓存里塞个假的
//     （口径与 tools/test-pet-store.js 一致）。迁移用例只用 normalizeSettings 这个纯函数；
//     最后两条 saveSettings 用例会写盘，但写的是 tmpRoot 下的假 userData，不碰真实数据。
// ============================================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-settings-mig-'));
const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: (name) => (name === 'appData' ? path.join(tmpRoot, 'a') : path.join(tmpRoot, 'a', 'M')),
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => s,
    decryptString: (s) => s
  }
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { normalizeSettings, takeSettingsNotices, DEFAULT_SETTINGS, saveSettings } = require('../main/providers.js');
// 假 electron 的 userData 指在 tmpRoot 里，data-dir.js 会当成「显式改过」直接用它 —— 不碰真实数据
const { dataFile } = require('../main/store.js');

// 一份「旧结构」的配置：有 providers（不然会走旧版扁平配置分支，那不是这里要测的），
// 深度是当初的默认值 3，且**没有** settingsVersion。
const legacy = (depth) => ({
  providers: [{ id: 'p1', name: '测试', baseUrl: 'https://a', apiKey: '', models: ['m'] }],
  activeProviderId: 'p1',
  activeModel: 'm',
  ...(depth === undefined ? {} : { worldbookRecursiveDepth: depth })
});

test('旧配置（无版本号）+ 深度为旧默认值 3 → 收敛到新的默认值', () => {
  takeSettingsNotices(); // 清空，避免上一条用例的残留
  const out = normalizeSettings(legacy(3));
  // 目标值不写死：迁移的语义就是「旧默认值 → 新默认值」，写死会在下次改默认值时对不上。
  assert.equal(out.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth, '值必须真的被改掉');
  assert.equal(DEFAULT_SETTINGS.worldbookRecursiveDepth, 1, '当前的新默认值是 1（只带一层）');
  assert.equal(out.settingsVersion, 2, '版本号要抬到 2，迁移只做一次');

  const notices = takeSettingsNotices();
  assert.equal(notices.length, 1, '迁移改的是用户的设置，必须产生一条告知');
  assert.match(notices[0], /递归深度/, '告知里要说清改了哪一项');
  assert.deepEqual(takeSettingsNotices(), [], '通知取走即清空，不该反复弹');
});

test('用户自己把深度改成 0/2/4/5 时一律不动', () => {
  takeSettingsNotices();
  for (const depth of [0, 2, 4, 5]) {
    const out = normalizeSettings(legacy(depth));
    assert.equal(out.worldbookRecursiveDepth, depth, `用户选的 ${depth} 不能被迁移覆盖`);
  }
  assert.deepEqual(takeSettingsNotices(), [], '没迁移就不该有通知');
});

test('已固化的配置（version=2）里用户又选回 3 → 必须尊重', () => {
  takeSettingsNotices();
  const saved = { ...legacy(0), settingsVersion: 2, worldbookRecursiveDepth: 3 };
  const out = normalizeSettings(saved);
  assert.equal(out.worldbookRecursiveDepth, 3, '版本号已是 2，迁移不再介入，用户的选择说了算');
  assert.deepEqual(takeSettingsNotices(), []);
});

test('迁移幂等：把迁移结果再归一化一次，值不变、也不再发通知', () => {
  takeSettingsNotices();
  const once = normalizeSettings(legacy(3));
  takeSettingsNotices();
  const twice = normalizeSettings({ ...legacy(3), ...once });
  assert.equal(twice.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth);
  assert.equal(twice.settingsVersion, 2);
  assert.deepEqual(takeSettingsNotices(), [], '第二次不该再通知');
});

test('全新安装（没有任何配置）：用默认值，且不产生迁移通知', () => {
  takeSettingsNotices();
  const out = normalizeSettings({});
  assert.equal(out.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth);
  assert.equal(DEFAULT_SETTINGS.worldbookRecursiveDepth, 1, '新装默认 1 层');
  assert.deepEqual(takeSettingsNotices(), [], '全新安装没什么好告知的');
});

test('saveSettings：内置名（constructor / toString）混不过白名单', async () => {
  const saved = await saveSettings({ constructor: 'x', toString: 'y', theme: 'dark' });
  assert.equal(saved.theme, 'dark', '白名单里的正常键照存');
  const onDisk = JSON.parse(fs.readFileSync(dataFile('config.json'), 'utf8'));
  for (const key of ['constructor', 'toString']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(onDisk, key), `「${key}」不该被写进 config.json`);
  }
});

test('saveSettings：写盘失败要让调用方知道（返回被拒绝的 Promise，而不是假装成功）', async () => {
  const original = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('disk full');
    err.code = 'ENOSPC'; // 非瞬时锁，不重试，直接抛
    throw err;
  };
  try {
    await assert.rejects(Promise.resolve(saveSettings({ theme: 'light' })), /写入失败/);
  } finally {
    fs.renameSync = original;
  }
});

test('API Key 解不开时不再把密文当 Key（换电脑 / 换 Windows 账号）', () => {
  const { decryptApiKey } = require('../main/store.js');
  // 假 safeStorage：真实现只认自己写出来的 blob，别的输入一律抛。
  // 这里用前缀模拟 —— BLOB: 是「本机写出来的」，FAIL 是「本机解不开的」（换账号/换机器），
  // 其余（比如有人拿明文十六进制当 base64 塞进来）真实现也会抛。
  fakeElectron.safeStorage.isEncryptionAvailable = () => true;
  fakeElectron.safeStorage.decryptString = (buf) => {
    const text = buf.toString('utf8');
    if (text.startsWith('FAIL')) throw new Error('bad data');
    if (!text.startsWith('BLOB:')) throw new Error('not a DPAPI blob');
    return text.slice(5);
  };
  // 密文都很长：DPAPI 给短字符串包了 100 多字节的头，base64 之后 100 字符往上
  const unreadable = Buffer.from('FAIL' + 'x'.repeat(200), 'utf8').toString('base64');
  const readable = Buffer.from('BLOB:sk-' + 'y'.repeat(200), 'utf8').toString('base64');
  const hexKey = 'a1b2c3d4'.repeat(8); // 64 位十六进制：全是 base64 字符集，但是真 Key

  try {
    assert.ok(unreadable.length > 80, '前提：这个是「长密文」');
    assert.equal(decryptApiKey(unreadable), '', '解不开的长密文返回空 —— 不能把密文当 Key 发出去');
    assert.equal(decryptApiKey(hexKey), hexKey, '看着像 base64 的短明文 Key 照旧能用（不能误伤）');
    assert.equal(decryptApiKey('sk-abc123def456'), 'sk-abc123def456', '带 - 的正常 Key 原样返回');
    assert.equal(decryptApiKey(''), '', '空的还是空');
    assert.equal(decryptApiKey(readable), 'sk-' + 'y'.repeat(200), '能解开的密文照常还原');  } finally {
    // 还原成这份测试共用的假实现（没有加密能力）
    fakeElectron.safeStorage.isEncryptionAvailable = () => false;
    fakeElectron.safeStorage.decryptString = (s) => s;
  }
});

test('清理临时目录', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    // 删不掉不影响结论
  }
});
