'use strict';

// ============================================================================
//  tools/test-request-isolation.js —— 2026-10-10 一轮审查修掉的几处「接线」问题
//
//  这几处都是**渲染层 / IPC 编排**，在裸 node 里跑不起来（要 DOM / Electron），
//  所以和 tools/test-pet-window.js 一个路子：读源码做静态断言，把「修过的那一行」钉住。
//  断言「不该出现 X」一律先剥注释（理由见 test-pet-window.js 的 stripComments）。
//
//  ① 停止生成按 requestId 各管各的（以前单个 activeController，谁发请求谁掐别人）
//  ② AI 生成角色：中止只停自己；作废的回执不再开编辑器；Esc 只关这一层
//  ③ 手动「压一段」不再拆掉并发闸；重新生成某段会挂 summaryBusy
//  ④ 世界书编辑器「放弃改动」后收起表单（否则下次打开把放弃的内容又存回草稿）
//  ⑤ 桌宠散步的 16ms 步进里不再读盘
//  ⑥ 退出桌宠后，「让桌宠说出这句」不再把窗口拉起来
//
//  跑法： node tools/test-request-isolation.js
// ============================================================================
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let passed = 0;
const failures = [];
function ok(condition, label) {
  if (condition) passed += 1;
  else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function section(title) {
  console.log(`\n── ${title}`);
}

/**
 * 从 `function name(` 开始，按花括号配平抠出整个函数体（够用：这几个函数里没有含花括号的字符串）。
 * ⚠️ 先跳过参数表再找 `{` —— `openAiGenModal(options = {})` 的默认值里就有一个 `{}`。
 */
function fnBody(src, name) {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return '';
  let paren = 0;
  let i = src.indexOf('(', at);
  for (; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')' && --paren === 0) break;
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return '';
}

/** 从某个 ipcMain.handle('<channel>' 开始抠到配平的那个右括号 */
function handlerBody(src, channel) {
  const at = src.indexOf(`ipcMain.handle('${channel}'`);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return '';
}

// ---------------------------------------------------------------------------
section('① 停止生成按 requestId 隔离');
{
  const ipc = stripComments(read('main/ipc.js'));
  ok(!/\bactiveController\b/.test(ipc), 'ipc.js 里不再有单例 activeController');
  ok(/activeControllers\s*=\s*new Map\(\)/.test(ipc), 'ipc.js 用 Map<requestId, AbortController>');

  const send = handlerBody(ipc, 'chat:send');
  ok(send.length > 0, '找得到 chat:send');
  ok(/activeControllers\.get\(requestId\)/.test(send), 'chat:send 只顶掉**同一个** requestId 的旧请求');
  ok(!/for\s*\([^)]*activeControllers/.test(send) && !/activeControllers\.(forEach|clear)/.test(send),
    'chat:send 不会遍历 / 清空别的请求');
  ok(/activeControllers\.get\(requestId\)\s*===\s*controller/.test(send),
    'finally 只删自己那一个（别把同 id 新请求的 controller 删了）');

  const stop = handlerBody(ipc, 'chat:stop');
  ok(/\(_event,\s*requestId\)/.test(stop), 'chat:stop 接收 requestId');

  const preload = read('preload.js');
  ok(/stopChat:\s*\(requestId\)\s*=>\s*ipcRenderer\.invoke\('chat:stop',\s*requestId\)/.test(preload),
    'preload 把 requestId 透传给 chat:stop');

  const composer = stripComments(read('renderer/js/views/composer.js'));
  const stopGenerating = fnBody(composer, 'stopGenerating');
  ok(/api\.stopChat\(state\.requestId\)/.test(stopGenerating), '「停止」按钮只停聊天这一路（带 state.requestId）');
  ok(!/api\.stopChat\(\s*\)/.test(composer), 'composer 里没有不带 id 的 stopChat()');
}

// ---------------------------------------------------------------------------
section('② AI 生成角色');
{
  const src = stripComments(read('renderer/js/views/aiGen.js'));
  ok(!/api\.stopChat\(\s*\)/.test(src), 'aiGen 里没有不带 id 的 stopChat()（那会掐掉正在流的聊天）');
  ok(/api\.stopChat\(currentGenId\)/.test(fnBody(src, 'stopGen')), 'stopGen 只停自己这次的 requestId');

  const gen = fnBody(src, 'generate');
  const awaitAt = gen.indexOf('await api.sendChat');
  const guardAt = gen.search(/if\s*\(\s*currentGenId\s*!==\s*requestId\s*\)\s*return/);
  const acceptAt = gen.indexOf('acceptDraft(');
  ok(awaitAt > 0 && guardAt > awaitAt && guardAt < acceptAt,
    '回执回来后、开编辑器之前，先判「这轮是否已作废」');

  const close = fnBody(src, 'closeLayer');
  ok(/removeEventListener\('keydown',\s*escHandler,\s*true\)/.test(close), '关弹窗时摘掉 Esc 监听');
  const open = fnBody(src, 'openAiGenModal');
  ok(/addEventListener\('keydown',\s*escHandler,\s*true\)/.test(open), '开弹窗时在捕获阶段挂 Esc');
  ok(/stopPropagation\(\)/.test(open), 'Esc 不再冒到底下那层（世界书编辑器 / 角色库）');
}

// ---------------------------------------------------------------------------
section('③ 摘要的并发闸');
{
  const sum = stripComments(read('renderer/js/views/summarize.js'));
  const now = fnBody(sum, 'summarizeNow');
  ok(!/summarizingConvos\.delete\(convo\.id\)\s*;\s*\n\s*const \{ start/.test(now) &&
    now.indexOf('summarizingConvos.delete') > now.indexOf('finally'),
    'summarizeNow 只在 finally 里放闸，开头不再拆掉它');
  ok(/if\s*\(\s*summarizingConvos\.has\(convo\.id\)\s*\)/.test(now), 'summarizeNow 遇到正在压缩就退');

  const mem = stripComments(read('renderer/js/views/memoryUi.js'));
  const regen = fnBody(mem, 'regenerateSummary');
  ok(/convo\.summaryBusy\s*=\s*true/.test(regen), 'regenerateSummary 挂 summaryBusy');
  ok(/finally\s*\{[^}]*convo\.summaryBusy\s*=\s*false/.test(regen), 'regenerateSummary 在 finally 里复位 summaryBusy');
}

// ---------------------------------------------------------------------------
section('④ 世界书编辑器：放弃改动后收起表单');
{
  const src = stripComments(read('renderer/js/views/worldbook.js'));
  const close = fnBody(src, 'closeWorldbooksModal');
  const discardAt = close.indexOf('discardDrafts()');
  const hideWrapAt = close.search(/entriesWrap\.classList\.add\('hidden'\)/);
  const hideFormAt = close.indexOf('showEntryForm(false)');
  ok(discardAt > 0 && hideWrapAt > discardAt, '放弃草稿之后收起书名表单（stashWorldbookName 才会早退）');
  ok(hideFormAt > discardAt, '放弃草稿之后收起条目表单（stashEntryForm 才会早退）');
  // 早退条件本身也钉住：要是哪天 stash 不再看「隐藏」，上面那两行就白收了
  ok(/entriesWrap\.classList\.contains\('hidden'\)/.test(fnBody(src, 'stashWorldbookName')),
    'stashWorldbookName 仍以「表单隐藏」为早退条件');
  ok(/form\.classList\.contains\('hidden'\)/.test(fnBody(src, 'stashEntryForm')),
    'stashEntryForm 仍以「表单隐藏」为早退条件');
}

// ---------------------------------------------------------------------------
section('⑤ 桌宠散步：步进里不读盘');
{
  const src = stripComments(read('main/pet-walk.js'));
  const start = fnBody(src, 'startTrip');
  const intervalAt = start.indexOf('setInterval(');
  const tick = intervalAt >= 0 ? start.slice(intervalAt) : '';
  ok(tick.length > 0, '找得到散步的步进循环');
  ok(!/walkAllowed\(\)|loadPetConfig\(/.test(tick), '16ms 步进里不调 walkAllowed / loadPetConfig');
  ok(/isVisible\(\)/.test(tick), '步进里仍会在窗口被藏起来时停下');
}

// ---------------------------------------------------------------------------
section('⑥ 退出桌宠后「让桌宠说出这句」不复活窗口');
{
  const src = stripComments(read('main/pet-ipc.js'));
  const h = handlerBody(src, 'pet:say-now');
  const guardAt = h.search(/if\s*\(\s*!config\.enabled\s*\)\s*return/);
  const showAt = h.indexOf('setPetVisible(true)');
  ok(guardAt > 0 && showAt > guardAt, 'pet:say-now 先判 enabled，再决定要不要把窗口显示出来');
}

// ---------------------------------------------------------------------------
section('⑦ 语义检索不把已经在上下文里的消息再捞回来');
{
  const rag = stripComments(read('renderer/js/data/rag.js'));
  const msg = stripComments(read('renderer/js/data/messages.js'));
  // buildApiMessages 发出去的是最后 maxTurns * 2 条（口径以它为准）
  ok(/const turns = Math\.max\(1,\s*Number\(settings\.maxTurns\)\s*\|\|\s*20\)/.test(msg) &&
    /slice\(-turns \* 2\)/.test(msg),
    'messages.js 的上下文轮数口径没变（maxTurns * 2）');
  ok(/recentCount:\s*Math\.max\(1,\s*Number\(settings\.maxTurns\)\s*\|\|\s*20\)\s*\*\s*2/.test(rag),
    'rag.js 的 recentCount 和 messages.js 用同一个口径（以前只排除 6 条）');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
process.exit(failures.length ? 1 : 0);
