'use strict';

// 运行：node --test tools/test-worldbook-match.js（无需启动 Electron）
const assert = require('node:assert/strict');
const test = require('node:test');
const { keywordHit, entryMatches, matchWorldbookEntries } = require('../main/worldbook-match.js');

function entry(id, overrides = {}) {
  return {
    id, title: id, keys: ['alpha'], secondaryKeys: [],
    selectiveLogic: 'AND_ANY', content: 'setting',
    probability: 100, order: 100, enabled: true,
    ...overrides
  };
}

test('缓存的全局和粘连正则在重复匹配及失败后结果一致', () => {
  for (const keyword of ['/alpha/g', '/alpha/y', '/alpha/gy']) {
    for (let i = 0; i < 4; i += 1) {
      assert.equal(keywordHit('alpha', keyword, {}), true, keyword);
    }
    assert.equal(keywordHit('beta', keyword, {}), false, keyword);
    assert.equal(keywordHit('alpha', keyword, {}), true, keyword);
  }
  assert.equal(keywordHit('beta alpha', '/alpha/g', {}), true);
  assert.equal(keywordHit('beta alpha', '/alpha/y', {}), false);
});

test('副关键词的四种逻辑保持各自的真值规则', () => {
  const cases = [
    ['AND_ANY', [false, true, true]],
    ['AND_ALL', [false, false, true]],
    ['NOT_ANY', [true, false, false]],
    ['NOT_ALL', [true, true, false]]
  ];
  const texts = ['alpha', 'alpha beta', 'alpha beta gamma'];
  for (const [logic, expected] of cases) {
    const item = entry(logic, { secondaryKeys: ['/beta/g', 'gamma'], selectiveLogic: logic });
    for (let repeat = 0; repeat < 3; repeat += 1) {
      texts.forEach((text, i) => assert.equal(entryMatches(item, text), expected[i], `${logic}: ${text}`));
    }
  }
});

test('共享同一个正则关键词的条目都能命中', () => {
  const entries = [entry('a', { keys: ['/alpha/g'] }), entry('b', { keys: ['/alpha/g'] })];
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(matchWorldbookEntries(entries, 'alpha').hits.map((item) => item.id), ['a', 'b']);
  }
});

test('递归深度、排序和统计保持一致', () => {
  const entries = [
    entry('root', { content: 'beta', recursive: true, order: 30 }),
    entry('child', { keys: ['beta'], content: 'gamma', recursive: true, order: 20 }),
    entry('leaf', { keys: ['gamma'], order: 10 })
  ];
  for (const [depth, ids, rounds, recursiveCount] of [
    [0, ['root'], 1, 0],
    [1, ['child', 'root'], 2, 1],
    [2, ['leaf', 'child', 'root'], 3, 2],
    [5, ['leaf', 'child', 'root'], 3, 2]
  ]) {
    const result = matchWorldbookEntries(entries, 'alpha', { recursiveDepth: depth });
    assert.deepEqual(result.hits.map((item) => item.id), ids);
    assert.equal(result.rounds, rounds);
    assert.equal(result.recursiveCount, recursiveCount);
  }
  assert.deepEqual(matchWorldbookEntries(entries, 'nothing', { recursiveDepth: 5 }), {
    hits: [], rounds: 0, recursiveCount: 0
  });
});

test('常驻条目绕过关键词但同样遵守概率', () => {
  // 蓝圈（constant）不该被副关键词拦下，但概率不是关键词过滤，必须照样生效。
  assert.equal(entryMatches(entry('c0', { constant: true, probability: 0 }), ''), false);
  assert.equal(entryMatches(entry('c100', { constant: true, probability: 100 }), ''), true);
  assert.equal(
    entryMatches(entry('c2', { constant: true, probability: 100, secondaryKeys: ['missing'] }), ''),
    true,
    'constant 不参与副关键词过滤'
  );
  assert.equal(entryMatches(entry('off', { constant: true, useProbability: false }), ''), true);
});

test('递归扫描中概率失败的条目不会在后续轮次重新抽签', () => {
  // root 第一轮就命中，正文把 target 需要的词带进扫描文本；
  // target 在**每一轮**都是关键词候选，所以旧实现会一轮抽一次签，
  // 实际命中率被无声抬高（50% → 75% → 87.5%…）。
  const root = entry('root', { keys: ['alpha'], content: 'alpha beta', recursive: true });
  const target = entry('target', { keys: ['alpha'], probability: 50 });

  const oldRandom = Math.random;
  let draws = 0;
  Math.random = () => { draws += 1; return 0.9; }; // 恒定落在 50% 之外 → 必定失败
  try {
    const result = matchWorldbookEntries([root, target], 'alpha', { recursiveDepth: 3 });
    assert.deepEqual(result.hits.map((item) => item.id), ['root']);
    assert.equal(draws, 1, '同一个条目在一次扫描里只应抽一次签');
  } finally {
    Math.random = oldRandom;
  }
});

test('排除递归目标的条目仍可被首轮命中，但不会被递归带出', () => {
  const root = entry('root', { keys: ['alpha'], content: 'beta', recursive: true });
  const excluded = entry('excluded', { keys: ['beta'], excludeRecursion: true });
  const normal = entry('normal', { keys: ['beta'] });
  const result = matchWorldbookEntries([root, excluded, normal], 'alpha', { recursiveDepth: 1 });
  assert.deepEqual(result.hits.map((item) => item.id), ['normal', 'root']);

  // 首轮直接命中时 excludeRecursion 不该拦它（它只禁止「被递归阶段命中」）
  const direct = matchWorldbookEntries([excluded], 'beta', { recursiveDepth: 1 });
  assert.deepEqual(direct.hits.map((item) => item.id), ['excluded']);
});

test('大量命中不因统计时展开数组而超出参数数量上限', () => {
  const entries = Array.from({ length: 150000 }, (_, i) => entry(String(i), { constant: true }));
  const result = matchWorldbookEntries(entries, '');
  assert.equal(result.hits.length, entries.length);
  assert.equal(result.rounds, 1);
  assert.equal(result.recursiveCount, 0);
});
