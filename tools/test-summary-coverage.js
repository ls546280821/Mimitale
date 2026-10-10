'use strict';

// ============================================================================
//  tools/test-summary-coverage.js —— 摘要「覆盖范围」不能把没压过的消息吞掉
//
//  摘要段的 start/end 是 convoContextMessages 里的下标，buildApiMessages 会把
//  end 之前的原文整段跳过（只留摘要）。所以 end 记多了 = 那几条消息**永久消失**：
//  既不在摘要文字里，也不再进上下文。2026-10-10 审查发现两条路会记多：
//
//    ① 原文超长（24000 字）时 buildTranscript 砍的是最早的几条，调用方却按整段
//       slice.length 记 end。长回复 RP 十几条就撞上。
//       → 改用 buildTranscriptFromStart：从头装、返回实际条数，end 按它记。
//    ② 删一条覆盖范围内的消息，后面整体前移，覆盖点却不动 —— 紧挨着的那条
//       没压过的消息滑进「已覆盖」。
//       → removeMessage 先调 shiftSummariesForRemoval 把 start/end 跟着挪。
//
//  跑法： electron --no-sandbox tools/test-summary-coverage.js
//  memory.js 的依赖链要 DOM（裸 node 里 import 不进来），所以照 tools/test-ui-optimization.js
//  的路子：开一个隐藏的空白页，在里面 import 真模块。不启动应用、不读用户数据。
// ============================================================================
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-summary-cov-'));
app.setPath('userData', path.join(tmpRoot, 'user-data'));

// 在页面里跑的断言。每条：{ name, pass, detail }
const PAGE_SCRIPT = (rootUrl, panelUrl) => `(async () => {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  await new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = ${JSON.stringify(panelUrl)};
    s.onload = resolve; s.onerror = reject; document.head.append(s);
  });
  window.mimitale = {};
  const memory = await import(${JSON.stringify(rootUrl)} + 'js/data/memory.js');
  const msg = (i, len = 10) => ({ role: i % 2 ? 'assistant' : 'user', content: '#' + i + '#' + '字'.repeat(len) });

  // ① 原文超长
  {
    const slice = Array.from({ length: 20 }, (_, i) => msg(i, 2000));
    const { text, count } = memory.buildTranscriptFromStart(slice, '猫');
    check('① 超长时只装下一部分', count > 0 && count < slice.length, count + '/' + slice.length);
    let earliestIn = true;
    for (let i = 0; i < count; i += 1) if (!text.includes('#' + i + '#')) earliestIn = false;
    check('① 装进去的是最早的 count 条', earliestIn);
    check('① 第 count 条没装下，不算进 count', !text.includes('#' + count + '#'));
  }
  {
    const slice = Array.from({ length: 12 }, (_, i) => msg(i, 50));
    const { text, count } = memory.buildTranscriptFromStart(slice, '猫');
    check('① 不超长时整段装下', count === 12 && text.includes('#0#') && text.includes('#11#'), count);
  }
  {
    const { count } = memory.buildTranscriptFromStart([msg(0, 30000), msg(1, 10)], '猫');
    check('① 第一条自己就超长仍算 1 条（不会卡在 0 条反复重压）', count === 1, count);
  }

  // ② 删消息时挪覆盖点
  {
    const convo = {
      messages: Array.from({ length: 30 }, (_, i) => msg(i)),
      summaries: [{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 10, end: 18 }]
    };
    const firstPending = memory.convoContextMessages(convo)[18];
    memory.shiftSummariesForRemoval(convo, 5);
    convo.messages.splice(5, 1);
    const ranges = JSON.stringify(convo.summaries.map((s) => [s.start, s.end]));
    check('② 删覆盖范围里的一条：start/end 前移', ranges === '[[0,9],[9,17]]', ranges);
    check('② 覆盖点之后第一条还是原来那条没压过的',
      memory.convoContextMessages(convo)[memory.summarizedCount(convo)] === firstPending);
  }
  {
    const convo = { messages: Array.from({ length: 30 }, (_, i) => msg(i)), summaries: [{ id: 'a', start: 0, end: 18 }] };
    memory.shiftSummariesForRemoval(convo, 25);
    check('② 删覆盖范围之后的消息：覆盖点不动', convo.summaries[0].end === 18, convo.summaries[0].end);
  }
  {
    const messages = Array.from({ length: 20 }, (_, i) => msg(i));
    messages.splice(3, 0, { role: 'error', content: '网络错误' });
    const convo = { messages, summaries: [{ id: 'a', start: 0, end: 10 }] };
    memory.shiftSummariesForRemoval(convo, 3);
    check('② 删不进上下文的错误提示：覆盖点不动', convo.summaries[0].end === 10, convo.summaries[0].end);
  }
  {
    const convo = {
      messages: Array.from({ length: 10 }, (_, i) => msg(i)),
      summaries: [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 5 }]
    };
    memory.shiftSummariesForRemoval(convo, 0);
    convo.messages.splice(0, 1);
    const got = JSON.stringify(convo.summaries.map((s) => [s.id, s.start, s.end]));
    check('② 一段的原文删光：这段直接丢掉', got === '[["b",0,4]]', got);
  }

  // ③ 等模型期间删了消息：回来时识别出 start 已过期
  {
    const convo = { messages: Array.from({ length: 30 }, (_, i) => msg(i)), summaries: [{ id: 'a', start: 0, end: 6 }] };
    const start = memory.summarizedCount(convo);
    const sent = memory.convoContextMessages(convo).slice(start, start + 12);
    check('③ 没改动：范围仍然完好', memory.summaryRangeIntact(convo, start, sent, 12));
    // 删掉送去压的那段里的一条（removeMessage 会先挪覆盖点，这里照做）
    memory.shiftSummariesForRemoval(convo, 8);
    convo.messages.splice(8, 1);
    check('③ 段内删了一条：识别为已过期', !memory.summaryRangeIntact(convo, start, sent, 12));

    const c2 = { messages: Array.from({ length: 30 }, (_, i) => msg(i)), summaries: [{ id: 'a', start: 0, end: 6 }] };
    const sent2 = memory.convoContextMessages(c2).slice(6, 18);
    memory.shiftSummariesForRemoval(c2, 2);
    c2.messages.splice(2, 1);
    check('③ 覆盖范围之前删了一条（start 变了）：识别为已过期', !memory.summaryRangeIntact(c2, 6, sent2, 12));
  }
  return results;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  let failed = 0;
  try {
    const page = path.join(tmpRoot, 'blank.html');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await win.loadFile(page);
    const rootUrl = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
    const panelUrl = pathToFileURL(path.join(__dirname, '..', 'main', 'panel-fields.js')).href;
    const results = await win.webContents.executeJavaScript(PAGE_SCRIPT(rootUrl, panelUrl));
    for (const r of results) {
      if (!r.pass) failed += 1;
      console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass || !r.detail ? '' : `（实际 ${r.detail}）`}`);
    }

    // 接线（静态）：调用方真的用上了上面这几个函数 —— 函数本身对、没人调也白搭
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const sum = read('renderer/js/views/summarize.js');
    const memUi = read('renderer/js/views/memoryUi.js');
    const wiring = [
      ['summarize.js 不再用会砍最早几条的 buildTranscript', !/\bbuildTranscript\(/.test(sum)],
      ['summarize.js 两处都按实际条数记 end', (sum.match(/end:\s*start\s*\+\s*covered/g) || []).length === 2],
      ['summarize.js 两处记范围前都核对 summaryRangeIntact', (sum.match(/summaryRangeIntact\(convo,\s*start,\s*slice,\s*covered\)/g) || []).length === 2],
      // memoryUi.js 的「重新生成某段」同样用超长时会砍最早几条的 buildTranscript，
      // 只是它写回的是 target.text（不动 start/end）—— 上一轮改到这就断了，特别钉住
      ['memoryUi.js 重新生成也用 buildTranscriptFromStart', !/\bbuildTranscript\(/.test(memUi) && /\bbuildTranscriptFromStart\(/.test(memUi)],
      ['removeMessage 删之前先挪覆盖点', /shiftSummariesForRemoval\(convo,\s*index\);\s*convo\.messages\.splice\(index,\s*1\)/.test(read('renderer/js/views/convoActions.js'))]
    ];
    for (const [name, pass] of wiring) {
      results.push({ name, pass });
      if (!pass) failed += 1;
      console.log(`${pass ? '  ✓' : '  ✗'} ${name}`);
    }
    console.log(failed ? `失败 ${failed} 条 / 共 ${results.length} 条` : `全部通过：${results.length} 条`);
  } catch (err) {
    // 页面里抛错（比如导出不存在）也要明确报失败，别让 electron 弹框挂住
    console.error(err && (err.stack || err.message || err));
    failed = failed || 1;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 删不掉不影响结论 */ }
    app.exit(failed ? 1 : 0);
  }
});
