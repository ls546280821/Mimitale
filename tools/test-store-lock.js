'use strict';
// ============================================================================
//  tools/test-store-lock.js —— main/store.js 落盘时「文件被临时锁住」的容错
//
//  背景（2026-10-08 星宝报的）：
//    关窗口时弹「A JavaScript error occurred in the main process」，堆栈指向
//      writeJsonNow (main/store.js) → EPERM: operation not permitted, copyfile
//        '...\Mimitale\conversations.json' -> '...\Mimitale\conversations.json.backup'
//    也就是**备份**那一步撞上了 Windows 的瞬时文件锁（杀软 / 索引服务在一个文件
//    刚被写过的几十毫秒内短暂独占它），结果把整个保存拖垮、还弹了个崩溃框。
//    手动重试那次 copyFileSync 是成功的 —— 所以这不是权限配置问题，是时序问题。
//
//  这份测试用 monkey-patch fs 的方式把那几毫秒的锁演出来，盯住四条规矩：
//    ① 备份失败**不能**拖垮主写入 —— 数据本身必须先落盘
//    ② 瞬时锁要重试 —— 重试能过就别退化成「保存失败」
//    ③ 备份不留半截文件 —— .backup 要么是旧的完整版，要么是新的完整版
//    ④ 读兜底时「备份回填」失败，也得把已经读到的数据交出去
//    ⑧（顺带）长会话读回来不能被截断
//
//  跑法（本机默认带 ELECTRON_RUN_AS_NODE，先 unset）：
//    unset ELECTRON_RUN_AS_NODE
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/test-store-lock.js
//
//  ⚠️ 全程在临时目录里跑，不碰真实的 %APPDATA%\Mimitale。
// ============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

// 数据目录指到临时目录。⚠️ 必须在它被读之前设好：main/data-dir.js 的解析顺序里
// 「userData 被显式改过」优先级最高，所以这一行就能让整个测试跑在临时目录里，
// 而不是开发机真正的 data\（顺序表见 main/data-dir.js 顶部）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-store-lock-'));
app.setPath('userData', tmpDir);

const store = require('../main/store.js');

const convoFile = path.join(tmpDir, 'conversations.json');
const convoBackup = convoFile + '.backup';
const convoBackupTmp = convoBackup + '.tmp';

// ---------------------------------------------------------------------------
//  断言
// ---------------------------------------------------------------------------
let pass = 0;
const failures = [];

function check(desc, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(desc + (extra ? `（${extra}）` : ''));
    console.log(`  ✗ ${desc}${extra ? `（${extra}）` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
//  工具
// ---------------------------------------------------------------------------

/** 模拟 Windows 上那种瞬时文件锁 */
function eperm() {
  const err = new Error('EPERM: operation not permitted');
  err.code = 'EPERM';
  return err;
}

/**
 * 临时替换 fs 上的某个方法。
 * store.js 里是 `const fs = require('node:fs')`，拿到的是同一个模块对象 ——
 * 所以改 fs 的属性对它立刻生效。返回一个还原函数。
 */
function patchFs(name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  return () => {
    fs[name] = original;
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function save(convo) {
  return store.saveConversations({ conversations: [convo], activeId: convo.id }, { immediate: true });
}

// ---------------------------------------------------------------------------
//  ① 正常写入：主文件写成功
// ---------------------------------------------------------------------------
section('① 正常写入');
save({ id: 'a', title: 'A', messages: [] });
check('主文件写入成功', (readJson(convoFile) || {}).conversations?.[0]?.id === 'a');
check('首次写入（主文件本来不存在）不产生备份', !fs.existsSync(convoBackup));
check('没有留下 .tmp', !fs.existsSync(convoFile + '.tmp'));

// ---------------------------------------------------------------------------
//  ② 备份一直被锁（EPERM 常驻）—— 主写入必须照样成功
//    这就是 2026-10-08 那次崩溃的直接修复点
// ---------------------------------------------------------------------------
section('② 备份失败不拖垮主写入（EPERM 常驻）');
{
  const restore = patchFs('copyFileSync', () => () => {
    throw eperm();
  });
  let threw = null;
  try {
    save({ id: 'b', title: 'B', messages: [] });
  } catch (err) {
    threw = err;
  } finally {
    restore();
  }

  check('保存没有抛异常', !threw, threw && threw.message);
  check('数据仍然落到了主文件', (readJson(convoFile) || {}).conversations?.[0]?.id === 'b');
  check('没有留下半截的 .backup.tmp', !fs.existsSync(convoBackupTmp));
}

// ---------------------------------------------------------------------------
//  ③ 瞬时锁：copy 前两次 EPERM，第三次放行 —— 重试应该救回来
// ---------------------------------------------------------------------------
section('③ 瞬时锁重试（copy 前 2 次失败）');
{
  let calls = 0;
  const restore = patchFs('copyFileSync', (orig) => (...args) => {
    calls += 1;
    if (calls <= 2) throw eperm();
    return orig(...args);
  });
  try {
    save({ id: 'c', title: 'C', messages: [] });
  } finally {
    restore();
  }

  check('copyFileSync 真的重试了（调用 3 次）', calls === 3, `实际 ${calls} 次`);
  check('主文件是新内容', (readJson(convoFile) || {}).conversations?.[0]?.id === 'c');
  // 写 c 之前主文件是 b，所以这次的备份内容应该是 b
  check('备份被更新成上一版（b）', (readJson(convoBackup) || {}).conversations?.[0]?.id === 'b');
}

// ---------------------------------------------------------------------------
//  ④ 主写入的 rename 撞锁也要重试（只对「写到 conversations.json」那次生效，
//     免得误伤 tryBackup 里对 .backup 的 rename）
// ---------------------------------------------------------------------------
section('④ 主写入 rename 撞锁重试');
{
  let locked = 0;
  const restore = patchFs('renameSync', (orig) => (from, to) => {
    if (to === convoFile && locked < 1) {
      locked += 1;
      throw eperm();
    }
    return orig(from, to);
  });
  try {
    save({ id: 'd', title: 'D', messages: [] });
  } finally {
    restore();
  }

  check('rename 撞锁后重试成功', (readJson(convoFile) || {}).conversations?.[0]?.id === 'd');
  check('没有留下 .tmp', !fs.existsSync(convoFile + '.tmp'));
}

// ---------------------------------------------------------------------------
//  ⑤ 备份的 rename 一直失败 —— .backup 必须还是完整的旧版本，不能变半截
// ---------------------------------------------------------------------------
section('⑤ 备份失败时 .backup 不被写坏');
{
  const before = readJson(convoBackup);
  const restore = patchFs('renameSync', (orig) => (from, to) => {
    if (to === convoBackup) throw eperm();
    return orig(from, to);
  });
  try {
    save({ id: 'e', title: 'E', messages: [] });
  } finally {
    restore();
  }

  check('主文件照常写入', (readJson(convoFile) || {}).conversations?.[0]?.id === 'e');
  check('备份仍是可解析的完整 JSON', !!readJson(convoBackup));
  check(
    '备份内容没被这次写入动过',
    JSON.stringify(readJson(convoBackup)) === JSON.stringify(before)
  );
  check('中转的 .backup.tmp 被清理掉', !fs.existsSync(convoBackupTmp));
}

// ---------------------------------------------------------------------------
//  ⑥ 读兜底：备份回填失败，也得把已经读到的数据交出去
// ---------------------------------------------------------------------------
section('⑥ 备份回填失败仍能读出数据');
{
  // 先把备份做成「好数据」，再把主文件写坏
  const good = { conversations: [{ id: 'backup-1', title: '来自备份', messages: [] }], activeId: 'backup-1' };
  fs.writeFileSync(convoBackup, JSON.stringify(good, null, 2), 'utf8');
  fs.writeFileSync(convoFile, '{ 这不是 JSON', 'utf8');

  const restore = patchFs('copyFileSync', () => () => {
    throw eperm();
  });
  let loaded = null;
  try {
    loaded = store.loadConversations();
  } finally {
    restore();
  }

  check('备份里的数据被读出来了', loaded && loaded.conversations.length === 1, JSON.stringify(loaded));
  check('读出来的就是备份那一条', loaded && loaded.conversations[0].id === 'backup-1');
}

// ---------------------------------------------------------------------------
//  ⑦ 真实 EPERM（不靠 monkey-patch）：.backup 带只读属性
//     这条路能把报错原文复刻出来 —— 实测报的就是
//      'EPERM: operation not permitted, copyfile ...'，
//     和 2026-10-08 弹框里那行一字不差。说明「只读属性 / 被别的进程独占」
//     这一类都会走到同一个坑上，而修复对它们一视同仁。
// ---------------------------------------------------------------------------
section('⑦ .backup 带只读属性时的真实 EPERM');
{
  // 先把备份做成一份「健全的旧数据」，再把它锁成只读
  const oldData = { conversations: [{ id: 'old', title: '旧', messages: [] }], activeId: 'old' };
  fs.writeFileSync(convoBackup, JSON.stringify(oldData, null, 2), 'utf8');
  fs.chmodSync(convoBackup, 0o444);

  let threw = null;
  try {
    save({ id: 'f', title: 'F', messages: [] });
  } catch (err) {
    threw = err;
  } finally {
    fs.chmodSync(convoBackup, 0o666); // 先解锁，免得后面清不掉目录
  }

  check('只读的备份没让保存失败', !threw, threw && threw.message);
  check('主文件仍然写到了最新', (readJson(convoFile) || {}).conversations?.[0]?.id === 'f');
  check('只读的备份保持原样（也就没被写坏）', (readJson(convoBackup) || {}).conversations?.[0]?.id === 'old');
}

// ---------------------------------------------------------------------------
//  ⑧ 长会话读回来一条不少（不在这份测试的「锁」主题里，但它测的也是 store.js 落盘）
//     以前 loadConversations 每次读都只留最后 200 条：多出来的下次保存就永久没了，
//     而且摘要的 start/end 是按下标记的，砍掉头部会让覆盖点整体错位。
// ---------------------------------------------------------------------------
section('⑧ 长会话读回不截断');
{
  const messages = Array.from({ length: 450 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `第 ${i} 条`
  }));
  const summaries = [{ id: 's1', title: '第 1 段', text: '前情', start: 0, end: 300 }];
  save({ id: 'long', title: '长会话', messages, summaries });

  const loaded = store.loadConversations();
  const convo = loaded.conversations.find((c) => c.id === 'long');
  // ⚠️ 全用 ?.：截断回归时 messages[300] 是 undefined，直接 .content 会抛异常，
  //    electron 主进程弹错误框卡住不退出 —— 失败要报出来，不能变成「挂起」。
  const msgs = (convo && convo.messages) || [];
  const end = convo?.summaries?.[0]?.end;
  check('450 条消息全部读回', msgs.length === 450, `实际 ${msgs.length} 条`);
  check('第一条还是最早那条', msgs[0]?.content === '第 0 条');
  check('摘要覆盖点对应的消息没变', msgs[end]?.content === '第 300 条');
}

// ---------------------------------------------------------------------------
//  收尾
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`失败 ${failures.length} 条 / 通过 ${pass} 条`);
  for (const f of failures) console.log(`  · ${f}`);
} else {
  console.log(`全部通过：${pass} 条`);
}
console.log('='.repeat(60));

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (err) {
  /* 清不掉就算了 */
}

app.exit(failures.length ? 1 : 0);
