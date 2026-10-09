'use strict';

// node --test tools/test-tavern-compat.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeWorldbook } = require('../main/worldbook-parse.js');
const { entryMatches } = require('../main/worldbook-match.js');

const rawBook = {
  id: 'book', name: '测试书', opening: '欢迎来到城堡',
  characters: [{ name: '守卫' }], createdAt: 1, updatedAt: 1,
  entries: [{
    id: 'entry', title: '守卫规则', keys: ['门'], secondaryKeys: ['警报', '夜晚'],
    selectiveLogic: 'NOT_ANY', content: '{{char}}为{{user}}开门', order: 42,
    probability: 65, enabled: true, recursive: true, caseSensitive: true, matchWholeWords: true
  }]
};
const { normalizeCharacter } = require('../main/characters.js');
const normalize = (book) => normalizeWorldbook(book, '', () => 'book', normalizeCharacter);

// 前端数据模块只需同一份状态和共享字段工具，无需启动 DOM 或 IPC。
global.window = { PanelFields: require('../main/panel-fields.js'), mimitale: {} };
const renderer = Promise.all([
  import('../renderer/js/data/library.js'),
  import('../renderer/js/core/state.js')
]);

test('世界书重复归一化保留副关键词及所有已支持设置', () => {
  const once = normalize(rawBook);
  assert.deepEqual(normalize(once), once);
  for (const field of ['secondary_keys', 'keysecondary']) {
    const imported = normalize({ entries: [{ key: ['门'], [field]: ['警报'], content: '正文' }] });
    assert.deepEqual(imported.entries[0].secondaryKeys, ['警报']);
    assert.deepEqual(normalize(imported).entries[0].secondaryKeys, ['警报']);
  }
});

test('ST 数值枚举的四种过滤行为保持准确', () => {
  const expected = [[false, true, true], [true, true, false], [true, false, false], [false, false, true]];
  for (let logic = 0; logic < 4; logic += 1) {
    const item = normalize({ entries: [{ key: ['门'], keysecondary: ['警报', '夜晚'], selectiveLogic: logic, content: '正文' }] }).entries[0];
    ['门', '门 警报', '门 警报 夜晚'].forEach((text, i) => {
      assert.equal(entryMatches(item, text), expected[logic][i], `${logic}: ${text}`);
    });
  }
});

test('关闭 ST 概率开关时不误用旧概率值', () => {
  assert.equal(normalize({ entries: [{ key: ['门'], content: '正文', useProbability: false, probability: 0 }] }).entries[0].probability, 100);
});

test('独立 ST 世界书导出使用数值枚举，往返不丢副条件', async () => {
  const [library] = await renderer;
  const original = normalize(rawBook);
  const payload = library.worldbookPayload(original);
  assert.equal(payload.entries['0'].selectiveLogic, 2);
  const back = normalize(payload);
  for (const field of ['secondaryKeys', 'selectiveLogic', 'order', 'probability', 'recursive', 'caseSensitive', 'matchWholeWords']) {
    assert.deepEqual(back.entries[0][field], original.entries[0][field], field);
  }
});

test('标准 ST 递归字段和 selective:false 不被改写', () => {
  const book = normalize({ entries: [
    { key: ['door'], keysecondary: ['alarm'], selective: false, content: 'rule' },
    { key: ['root'], content: 'root', preventRecursion: false, excludeRecursion: true }
  ] });
  assert.equal(book.entries[0].selective, false);
  assert.equal(book.entries[1].recursive, true);
  assert.equal(book.entries[1].excludeRecursion, true);
  assert.equal(entryMatches(book.entries[0], 'door'), true);
});

test('递归开关按 ST 语义导出，不再反向写进 excludeRecursion', async () => {
  const [library] = await renderer;
  const book = normalize({ entries: [
    { key: ['a'], content: 'a', recursive: true },
    { key: ['b'], content: 'b', recursive: false },
    { key: ['c'], content: 'c', recursive: true, excludeRecursion: true }
  ] });
  const payload = library.worldbookPayload(book);

  // preventRecursion 才是「正文能否继续触发」，必须与内部 recursive 相反
  assert.equal(payload.entries['0'].preventRecursion, false);
  assert.equal(payload.entries['1'].preventRecursion, true);
  // excludeRecursion 是独立的「能否作为递归目标」，不能由 recursive 反推
  assert.equal(payload.entries['0'].excludeRecursion, false);
  assert.equal(payload.entries['2'].excludeRecursion, true);

  const back = normalize(payload);
  ['recursive', 'excludeRecursion'].forEach((field) => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(back.entries[i][field], book.entries[i][field], `${field}[${i}]`);
    }
  });
});

test('条目级递归按 ST 语义：两个字段都是「限制项」，缺省=可参与', () => {
  // 官方文档里 Non-recursable / Prevent further recursion 都是**要勾选才生效**的限制，
  // 缺省即「不限制」。所以「书里没写 preventRecursion」= 可参与递归，与 ST 一致。
  const absent = normalize({ entries: [{ key: ['alpha'], content: 'beta' }] });
  assert.equal(absent.entries[0].recursive, true, '缺省即「可参与递归」（ST 的限制项默认关）');

  const allowed = normalize({ entries: [{ key: ['alpha'], content: 'beta', preventRecursion: false }] });
  assert.equal(allowed.entries[0].recursive, true, 'preventRecursion:false = 允许继续触发');

  const blocked = normalize({ entries: [{ key: ['alpha'], content: 'beta', preventRecursion: true }] });
  assert.equal(blocked.entries[0].recursive, false, 'preventRecursion:true = 不再触发别人');

  // 我们自己的字段优先级最高（往返用）
  const own = normalize({ entries: [{ key: ['a'], content: 'b', recursive: false, preventRecursion: false }] });
  assert.equal(own.entries[0].recursive, false, '内部 recursive 显式值优先于 ST 字段');
});

test('递归深度默认是 1（只带一层），而且和迁移目标必须是同一个值', () => {
  // 这个数字是**有意选的**，三层理由（详见 main/providers.js 的 DEFAULT_SETTINGS）：
  //   · 条目级按 ST 语义「缺省即可参与递归」（上面那条测试）—— 导入酒馆书之后
  //     每一条都可递归，所以默认值必须小，不能再是以前的 3；
  //   · 但也不能是 0：0 等于把这功能默认关掉，条目编辑器那颗「递归」框勾了也不生效
  //     （下一轮根本不会发生），用户会以为功能坏了；
  //   · 1 = 功能可用 + 代价最小：只把直接命中那条的正文再扫一遍。
  // 这条断言的作用：谁要动这个值，必须是有意识的改动。
  const fs = require('node:fs');
  const path = require('node:path');
  const providers = fs.readFileSync(path.join(__dirname, '..', 'main', 'providers.js'), 'utf8');
  const hit = providers.match(/worldbookRecursiveDepth:\s*(\d+)/);
  assert.ok(hit, 'DEFAULT_SETTINGS 里应当有 worldbookRecursiveDepth');
  assert.equal(Number(hit[1]), 1, '全局递归深度默认是 1（0 = 用户自己关掉）');

  // 迁移的目标值必须写成 DEFAULT_SETTINGS.worldbookRecursiveDepth 而不是写死数字 ——
  // 它的语义就是「旧默认值 → 新默认值」，写死就会在下一次改默认值时悄悄对不上。
  // （真踩过：目标是 0、默认还是 3 的时候，注释和代码各说各话。）
  const migrateLine = providers.match(/s\.worldbookRecursiveDepth\s*=\s*DEFAULT_SETTINGS\.worldbookRecursiveDepth/);
  assert.ok(migrateLine, '迁移的目标必须引用 DEFAULT_SETTINGS，不要写死数字');
});

test('v2内嵌书满足必需字段类型并保留开场白、NPC及条目设置', async () => {
  const [library] = await renderer;
  const original = normalize(rawBook);
  const payload = library.characterBookPayload(original);
  assert.ok(Array.isArray(payload.entries));
  assert.equal(typeof payload.extensions, 'object');
  const item = payload.entries[0];
  assert.ok(Array.isArray(item.keys));
  assert.equal(typeof item.content, 'string');
  assert.equal(typeof item.enabled, 'boolean');
  assert.equal(typeof item.insertion_order, 'number');
  assert.equal(typeof item.extensions, 'object');
  assert.equal(item.extensions.selectiveLogic, 2);
  const back = normalize(payload);
  assert.equal(back.opening, original.opening);
  const stableChars = (chars) => chars.map(({ id, createdAt, updatedAt, ...char }) => char);
  assert.deepEqual(stableChars(back.characters), stableChars(normalize({ characters: original.characters }).characters));
  for (const field of ['keys', 'secondaryKeys', 'selectiveLogic', 'content', 'order', 'enabled', 'probability', 'recursive', 'caseSensitive', 'matchWholeWords']) {
    assert.deepEqual(back.entries[0][field], original.entries[0][field], field);
  }
});
