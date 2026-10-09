'use strict';

// ============================================================================
//  tools/test-pet-store.js —— 桌宠数据层 + 发言解析的专项测试
//
//  为什么单独一个文件：桌宠的数据层（main/pet-store.js）和「把回复切成几句」
//  那套解析（main/pet-brain.js）全是**纯逻辑 + 落盘**，不需要开窗口、不需要真模型。
//  这类东西塞进冒烟测试不划算（冒烟要起 Electron + 跑完整套，一分多钟），
//  而这个测试**一秒内**跑完，改完随手就能跑。
//
//  跑法：
//    node tools/test-pet-store.js
//
//  ⚠️ 数据目录指向一个 mkdtemp 出来的临时目录（走 MIMITALE_DATA_DIR），
//     **绝不会碰到真实用户数据** —— 项目里出过一次「拿真实 userData 做实测，
//     把 conversations.json 整个覆盖成 {\"test\":1}」的事故，别再犯。
//
//  ⚠️ 要用 `electron` 模块，但这里没有 Electron 运行时，所以先往 require 缓存里
//     塞一个假的。真实环境里这几个 API 的行为由 Electron 保证，这里只需要它别炸。
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---- 1. 造一个临时数据目录，并把它告诉 main/data-dir.js ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-pet-'));
process.env.MIMITALE_DATA_DIR = tmpRoot;

// ---- 2. 假的 electron ----
const fakeAppData = path.join(tmpRoot, '__appdata');
const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: (name) => {
      if (name === 'appData') return fakeAppData;
      if (name === 'userData') return path.join(fakeAppData, 'Mimitale');
      if (name === 'exe') return path.join(tmpRoot, 'electron.exe');
      return tmpRoot;
    },
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

const petStore = require('../main/pet-store.js');
const petBrain = require('../main/pet-brain.js');

// ---- 3. 一个极简的断言器（照项目里其他专项测试的口径：认失败数） ----
let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures.push(label);
    console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  } else {
    passed += 1;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ---------------------------------------------------------------------------
section('设置归一化');

const blank = petStore.normalizePetConfig(null);
eq(blank.pets.length, 1, '空配置 → 有一只默认桌宠');
eq(blank.activeId, 'pet1', '默认 activeId');
eq(blank.enabled, true, '桌宠默认开启');
eq(blank.pets[0].speakEveryTurns, 3, '默认每隔 3 轮说一次');
eq(blank.pets[0].speakLines, 3, '默认每次 3 句');
eq(blank.pets[0].memoryMaxItems, 30, '默认记忆保留 30 条');
eq(blank.pets[0].visible, true, '默认在桌面上显示');
eq(blank.pets[0].speakEnabled, true, '默认允许主动发言');
eq(blank.pets[0].useMainModel, true, '默认跟随主模型');
eq(blank.pets[0].temperature, null, '默认温度跟随全局');
eq(blank.pets[0].mutedUntil, 0, '默认没有静音');
eq(blank.pets[0].look.kind, 'rig', '默认形象是 rig 动态形象（第一版的 PNG 立绘已移除）');
eq(blank.pets[0].look.skin, 'cat', '默认形象是蓝白猫');

// 第一版的 png 立绘配置会被**迁移**成默认 rig —— 不能留一个指向不存在目录的 skin，
// 那样宠物只会剩一个「形象没加载出来」占位框（老用户升级时会踩到）。
eq(
  petStore.normalizePetConfig({
    pets: [{ look: { kind: 'png', source: 'assets', skin: 'default', file: 'x.png' } }]
  }).pets[0].look,
  { kind: 'rig', source: 'assets', skin: 'cat' },
  '老配置里的 png 形象迁移成默认 rig 猫'
);

const clamped = petStore.normalizePetConfig({
  enabled: false,
  activeId: 'nope',
  pets: [
    {
      id: 'a',
      speakEveryTurns: 999,
      speakLines: 9,
      memoryMaxItems: -5,
      scale: 9,
      temperature: 3,
      bounds: { x: 'x', y: 2 }
    }
  ]
});
eq(clamped.enabled, false, 'enabled:false 被保留');
eq(clamped.activeId, 'a', 'activeId 不存在时退回第一只');
eq(clamped.pets[0].speakEveryTurns, 50, '轮数上限卡到 50');
eq(clamped.pets[0].speakLines, 5, '句数上限卡到 5');
eq(clamped.pets[0].memoryMaxItems, 0, '记忆条数下限卡到 0');
eq(clamped.pets[0].scale, 2, '缩放上限卡到 2');
eq(clamped.pets[0].temperature, 2, '温度上限卡到 2');
eq(clamped.pets[0].bounds, null, '坏掉的 bounds 归零');

const dup = petStore.normalizePetConfig({
  pets: [{ id: 'pet1' }, { id: 'pet1' }]
});
eq(dup.pets[1].id, 'pet1-2', 'id 重复的会被改开（不然两只共用记忆和人格）');
ok(dup.pets[0].id !== dup.pets[1].id, '两只桌宠的 id 不同');

// ---------------------------------------------------------------------------
section('把回复切成「几句」');

const three = petBrain.splitIntoLines('这也太甜了吧。\n*尾巴摇起来* 我磕了。\n你倒是主动点啊。', 3);
eq(three.length, 3, '一行一句：正好 3 句');
eq(three[1], '*尾巴摇起来* 我磕了。', '第二句原样保留（动作标记不能丢）');

const paragraph = petBrain.splitIntoLines('这也太甜了吧。我磕了。你倒是主动点啊。', 3);
eq(paragraph.length, 3, '写成一大段时按句号切出 3 句');

const over = petBrain.splitIntoLines('一。\n二。\n三。\n四。\n五。', 3);
eq(over.length, 3, '给多了只取前 3 句');

const messy = petBrain.splitIntoLines('1. 第一句。\n2. 第二句。\n- 第三句。', 3);
eq(messy, ['第一句。', '第二句。', '第三句。'], '剥掉序号和列表符号');

const quoted = petBrain.splitIntoLines('「这也太甜了吧。」\n“我磕了。”\n*歪头* 你说呢？', 3);
eq(quoted, ['这也太甜了吧。', '我磕了。', '*歪头* 你说呢？'], '剥掉整句外面的引号');

eq(petBrain.splitIntoLines('', 3), [], '空回复 → 空数组');
eq(petBrain.splitIntoLines('只有一句。', 3), ['只有一句。'], '少于请求句数时就给这一句，不硬凑');

// ---------------------------------------------------------------------------
section('「【记住】」那行');

eq(petBrain.extractMemory('说点什么。\n【记住】：用户喜欢被叫主人'), '用户喜欢被叫主人', '抽得出【记住】行');
eq(petBrain.extractMemory('【记住】: 半角冒号也认'), '半角冒号也认', '半角冒号也认');
eq(petBrain.extractMemory('什么都没有'), '', '没有就返回空串');

const withMemory = petBrain.splitIntoLines('第一句。\n【记住】：这一点很重要\n第二句。\n第三句。', 3);
eq(withMemory.length, 3, '【记住】行不会被当成一句宠物话');
ok(!withMemory.some((l) => l.includes('记住')), '切出来的句子里不含【记住】');

// ---------------------------------------------------------------------------
section('端点选择与回退');

const fakeSettings = {
  providers: [
    { id: 'p1', name: '主服务商', baseUrl: 'https://a', apiKey: 'k', models: ['main-model'] },
    { id: 'p2', name: '便宜服务商', baseUrl: 'https://b', apiKey: 'k', models: ['cheap-model'] }
  ],
  activeProviderId: 'p1',
  activeModel: 'main-model',
  temperature: 0.7,
  maxTokens: 8192,
  topP: 0.95
};

const followMain = petBrain.petEndpoints(fakeSettings, { useMainModel: true });
eq(followMain.map((e) => e.model), ['main-model'], '跟随主模型时只有主模型一个端点');

const ownFirst = petBrain.petEndpoints(fakeSettings, {
  useMainModel: false,
  providerId: 'p2',
  model: 'cheap-model'
});
eq(
  ownFirst.map((e) => e.model),
  ['cheap-model', 'main-model'],
  '自己指定时：自己那个在前、主模型垫底（这就是「主模型不可用要有回退」）'
);

const sameAsMain = petBrain.petEndpoints(fakeSettings, {
  useMainModel: false,
  providerId: 'p1',
  model: 'main-model'
});
eq(sameAsMain.length, 1, '自己指定的就是主模型时，不重复同一个端点');

// ---------------------------------------------------------------------------
section('长期记忆：写入 / 读取 / 溢出折叠 / 清空');

const PET = 'pet1';

(async () => {
  for (let i = 1; i <= 5; i += 1) {
    await petStore.appendPetMemory(PET, { kind: 'say', text: `第 ${i} 句`, convoTitle: '测试会话' }, 3);
  }

  const items = petStore.petMemoryItems(PET);
  eq(items.length, 3, '上限 3 条时只留最近 3 条');
  eq(items.map((m) => m.text), ['第 3 句', '第 4 句', '第 5 句'], '留下的是最新的那几条');

  const digest = petStore.petMemoryDigest(PET);
  ok(digest.includes('第 1 句') && digest.includes('第 2 句'), '被挤出去的两条折进了摘要（本地拼接，不再调模型）');

  await petStore.appendPetMemory(PET, { kind: 'say', text: '   ', convoTitle: 'x' }, 3);
  eq(petStore.petMemoryItems(PET).length, 3, '空白内容不会写进记忆');

  const kinds = petStore.petMemoryItems(PET).map((m) => m.kind);
  eq(kinds, ['say', 'say', 'say'], 'kind 原样保留');

  await petStore.appendPetMemory(PET, { kind: 'event', text: '用户喜欢被叫主人' }, 3);
  ok(petStore.petMemoryItems(PET).some((m) => m.kind === 'event'), '「记事」类记忆也能写进去');

  const exported = JSON.parse(petStore.exportPetMemory(PET));
  ok(Array.isArray(exported['长期记忆']), '导出的 JSON 里带着长期记忆');
  ok(typeof exported['折叠摘要'] === 'string', '导出的 JSON 里带着折叠摘要');

  // 保留摘要地重置
  await petStore.clearPetMemory(PET, true);
  eq(petStore.petMemoryItems(PET).length, 0, '重置后条目清零');
  ok(petStore.petMemoryDigest(PET).length > 0, '重置保留折叠摘要');

  // 连摘要一起清
  await petStore.clearPetMemory(PET, false);
  eq(petStore.petMemoryDigest(PET), '', '清空后摘要也没了');

  // -------------------------------------------------------------------------
  section('并发保存：读改写必须整段排队');
  // 「先读再排队写」的写法下，并发调用各自拿旧快照，后写的会把前一次整份盖回去。
  // 桌宠真实会遇到：设置页一次改两个字段、说完话连追两条记忆。

  await Promise.all([
    petStore.patchPet(PET, { speakEveryTurns: 7 }),
    petStore.patchPet(PET, { speakLines: 5 })
  ]);
  const merged = petStore.findPet(petStore.loadPetConfig(), PET);
  eq(merged.speakEveryTurns, 7, '并发改两个字段：轮数这次改动没被覆盖');
  eq(merged.speakLines, 5, '并发改两个字段：句数这次改动也没被覆盖');

  await petStore.clearPetMemory(PET, false);
  await Promise.all([
    petStore.appendPetMemory(PET, { kind: 'say', text: '并发第一条' }, 20),
    petStore.appendPetMemory(PET, { kind: 'say', text: '并发第二条' }, 20)
  ]);
  const texts = petStore.petMemoryItems(PET).map((m) => m.text);
  ok(
    texts.includes('并发第一条') && texts.includes('并发第二条'),
    '并发追加两条记忆都留下来了（不会只剩后一条）'
  );

  // -------------------------------------------------------------------------
  section('温度：留空 = 跟随全局，不能变成 0');
  // Number(null) === 0，所以「空值判断」必须在 Number() 之前做。
  // 漏了这一步，界面上清空温度会变成「显式请求 temperature=0」，
  // 模型会从跟随全局设置变成死板复读。

  eq(petStore.normalizePetConfig({ pets: [{ temperature: null }] }).pets[0].temperature, null, 'null 温度保持跟随全局');
  eq(petStore.normalizePetConfig({ pets: [{ temperature: '' }] }).pets[0].temperature, null, '空字符串温度保持跟随全局');
  eq(petStore.normalizePetConfig({ pets: [{ temperature: 0 }] }).pets[0].temperature, 0, '显式的 0 是合法温度，不能被当成空值');
  eq(petStore.normalizePetConfig({ pets: [{ temperature: '0.5' }] }).pets[0].temperature, 0.5, '数字字符串照常解析');

  // 落盘往返一次：默认配置存回去再读，温度不能被写成 0
  await petStore.patchPet(PET, { temperature: null });
  eq(petStore.findPet(petStore.loadPetConfig(), PET).temperature, null, '清空温度落盘后仍是 null');

  // -------------------------------------------------------------------------
  section('形象名：下拉里显示的必须就是真去读的目录名');
  // 这里原先用 safeId 收（只认 ASCII，非法**直接回落 'pet1'**）再强制小写，
  // 于是「下拉里有蓝猫 / MyCat，选中却去读 assets/pet/pet1 或 mycat」——
  // 界面显示得出来、实际读不到，属于查不出原因的静默错位。
  const skinOf = (look) => petStore.normalizePetConfig({ pets: [{ look }] }).pets[0].look.skin;

  eq(skinOf({ kind: 'rig', skin: '蓝猫' }), '蓝猫', '中文目录名原样保留（不再被换成 pet1）');
  eq(skinOf({ kind: 'rig', skin: 'MyCat' }), 'MyCat', '大小写原样保留（区分大小写的文件系统才找得到）');
  eq(skinOf({ kind: 'rig', skin: '../../etc/passwd' }), '____etc_passwd', '路径分隔符和 .. 仍被清洗掉');
  eq(skinOf({ kind: 'png', skin: 'default' }), 'cat', '老 png 形象照旧迁移成默认 rig 猫');
  eq(skinOf({ kind: 'rig', skin: '' }), 'cat', '空名字退回默认 cat');

  // -------------------------------------------------------------------------
  section('人格文件');

  const seeded = petStore.readPersona(PET);
  ok(seeded.includes('蓝自'), '第一次读会把内置人格写出来');
  ok(fs.existsSync(path.join(tmpRoot, 'pet', 'persona', `${PET}.md`)), '人格文件落在 data/pet/persona/ 下');

  petStore.writePersona(PET, '我是测试用的人格');
  eq(petStore.readPersona(PET), '我是测试用的人格', '写进去的能读回来');

  const restored = petStore.resetPersona(PET);
  ok(restored.includes('蓝自'), '还原会把内置那份重新写出来');
  ok(restored.trim().length > 0, '⚠️ 还原之后人格不能是空的（空人格会让宠物变成没有性格的文字生成器）');

  // -------------------------------------------------------------------------
  section('位置记忆');

  eq(
    petStore.normalizePetConfig({ pets: [{ bounds: { x: 120, y: 340, displayId: 2 } }] }).pets[0].bounds,
    { x: 120, y: 340, displayId: 2 },
    '位置按「屏幕 + 屏内坐标」存'
  );

  // -------------------------------------------------------------------------
  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  } else {
    console.log(`✓ 全部通过：${passed}/${passed}`);
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    console.log(`（临时目录没删掉：${tmpRoot}）`);
  }

  process.exit(failures.length ? 1 : 0);
})();
