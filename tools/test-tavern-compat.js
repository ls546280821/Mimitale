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
