'use strict';

// ============================================================================
//  tools/fix-static-modes.js —— 一次性数据修复
//
//  把「本该每轮维护、却被误标 static」的字段清掉（删 mode = 退回默认 dynamic），
//  只保留 KEEP_STATIC 里那批（身高/体重/胸围/性经历/上次接客）。
//
//  注意：属性在顶层 character.attributes（不是 extensions.mimitale.attributes）；
//  运行前确认 App 已退出，否则内存旧数据会覆盖本次修改。
//
//  用法：node tools/fix-static-modes.js --dry   # 空跑
//        node tools/fix-static-modes.js         # 真改（先备份）
// ============================================================================

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'Mimitale') : '';

// 「变了才说」只该留给真的几乎不动的设定。别的 static 一律清掉。
const KEEP_STATIC = new Set(['身高', '体重', '胸围', '性经历', '上次接客']);

const SEP = '\u0000';

/** 属性可能躺在两处：顶层 `attributes`，或 `data.extensions.mimitale.attributes`。 */
function attrsOf(card) {
  if (Array.isArray(card && card.attributes)) return card.attributes;
  const ext =
    card && card.data && card.data.extensions && card.data.extensions.mimitale;
  return Array.isArray(ext && ext.attributes) ? ext.attributes : [];
}

/** 就地清掉「标错的 static」，返回被改的字段名。 */
function stripWrongStatic(attrs) {
  const fixed = [];
  for (const a of attrs) {
    if (!a || a.mode !== 'static') continue;
    if (KEEP_STATIC.has(String(a.name || '').trim())) continue;
    delete a.mode;
    fixed.push(a.name);
  }
  return fixed;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

function backup(file, tag) {
  if (DRY) return '';
  const dst = `${file}.bak-${tag}`;
  fs.copyFileSync(file, dst);
  console.log(`   备份 → ${path.basename(dst)}`);
  return dst;
}

function writeJson(file, data) {
  if (DRY) return;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// -- 1) 角色库 -----------------------------------------------------------------

function fixCharacters(file) {
  const raw = readJson(file);
  const list = Array.isArray(raw) ? raw : raw.characters || [];
  let changed = 0;
  const log = [];

  for (const c of list) {
    const fixed = stripWrongStatic(attrsOf(c));
    if (fixed.length) {
      log.push(`  角色卡「${c.name}」：${fixed.join('、')}`);
      changed += fixed.length;
    }
  }

  if (changed) backup(file, `${stamp()}-fixmode`);
  writeJson(file, raw);
  return { changed, log };
}

// -- 2) 世界书副本卡 ------------------------------------------------------------

function fixWorldbooks(file) {
  const raw = readJson(file);
  const bookList = Array.isArray(raw) ? raw : raw.worldbooks || [];
  let changed = 0;
  let unflagged = 0;
  const log = [];

  for (const book of bookList) {
    for (const copy of book.characters || []) {
      const fixed = stripWrongStatic(attrsOf(copy));
      if (fixed.length) {
        log.push(`  ${book.name} / 副本「${copy.name}」：${fixed.join('、')}`);
        changed += fixed.length;
      }
      // 0 属性却勾了「在状态栏显示」= 入口条上多一个点开白板的头像
      if (copy.showInPanel === true && !attrsOf(copy).length) {
        delete copy.showInPanel;
        unflagged++;
        log.push(`  ${book.name} / 副本「${copy.name}」：0 属性，取消「在状态栏显示」`);
      }
    }
  }

  if (changed || unflagged) backup(file, `${stamp()}-fixmode`);
  writeJson(file, raw);
  return { changed, unflagged, log };
}

// -- 3) 会话面板 panelDefs（复合键 → { mode }） ----------------------------------

function fixConversations(file) {
  const raw = readJson(file);
  const list = Array.isArray(raw) ? raw : raw.conversations || [];
  let changed = 0;
  const log = [];

  for (const convo of list) {
    const defs = convo.panelDefs;
    if (!defs || typeof defs !== 'object') continue;
    const fixed = [];
    for (const [key, def] of Object.entries(defs)) {
      if (!def || def.mode !== 'static') continue;
      const name = String(key.split(SEP)[0] || '').trim();
      if (KEEP_STATIC.has(name)) continue;
      delete def.mode;
      // 整个 def 空了（只剩 mode 一个字段）就顺手删掉，别留空对象
      if (!Object.keys(def).length) delete defs[key];
      fixed.push(name);
      changed++;
    }
    if (fixed.length) log.push(`  「${convo.title || convo.id}」：${fixed.join('、')}`);
  }

  if (changed) backup(file, `${stamp()}-fixmode`);
  writeJson(file, raw);
  return { changed, log };
}

// -- main --------------------------------------------------------------------

function main() {
  if (!DATA_DIR || !fs.existsSync(DATA_DIR)) {
    console.error('❌ 找不到数据目录：', DATA_DIR || '(APPDATA 未设置)');
    process.exit(1);
  }
  console.log(`📂 数据目录：${DATA_DIR}`);
  console.log(DRY ? '🔍 只检查不写盘（--dry）\n' : '✏️  开始修复（会先备份）\n');

  const chFile = path.join(DATA_DIR, 'characters.json');
  const wbFile = path.join(DATA_DIR, 'worldbooks.json');
  const cvFile = path.join(DATA_DIR, 'conversations.json');

  let total = 0;

  console.log('【1】角色库卡上的 mode（模板 —— 影响以后新开的局）');
  const ch = fixCharacters(chFile);
  console.log(ch.changed ? ch.log.join('\n') : '   (无需修改)');
  console.log(`   → ${ch.changed} 个字段\n`);
  total += ch.changed;

  console.log('【2】世界书副本卡上的 mode + 空壳副本的显示勾选');
  const wb = fixWorldbooks(wbFile);
  console.log(wb.log.length ? wb.log.join('\n') : '   (无需修改)');
  console.log(`   → ${wb.changed} 个字段，${wb.unflagged} 处取消勾选\n`);
  total += wb.changed + wb.unflagged;

  console.log('【3】会话面板 panelDefs 里的 mode（快照 —— 影响正在玩的局）');
  const cv = fixConversations(cvFile);
  console.log(cv.changed ? cv.log.join('\n') : '   (无需修改)');
  console.log(`   → ${cv.changed} 个字段\n`);
  total += cv.changed;

  console.log('─'.repeat(50));
  console.log(`合计 ${total} 处修改`);
  console.log(DRY ? '（--dry 模式，没有写盘）' : '✅ 修复完成，可以启动 App 了');
}

main();
