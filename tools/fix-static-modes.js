'use strict';

// ============================================================================
//  tools/fix-static-modes.js —— 一次性数据修复（2026-09-29）
//
//  问题：「穿着变了状态栏不更新」在真实存档里还能复现 —— 因为**已开局的面板是快照**，
//  改角色卡/副本上的 mode 不会回流。而且 mode 标错这件事在**角色库**里也有一份。
//
//  实测本机（2026-09-29 20:49）：
//    · 角色库「露西诺」：上衣/下衣/内衣/内裤/随身物  标了 static（穿着不该 static）
//    · 角色库「露西娅」：生命/铜板                    标了 static（每轮都变的数值）
//    · 世界书副本「露西娅」：生命/铜板                同上
//    · 3 个「迷夜酒馆」会话的 panelDefs：姓名/年龄/性别/种族/上衣/下衣/内衣/内裤/
//      随身物/生命/铜板 各 11 个标了 static（会话删掉后已无对象）
//
//  本脚本把那批**本该每轮维护**的静态标记清掉（删 mode = 退回默认 dynamic），
//  保留真的几乎不动的（身高/体重/胸围/性经历/上次接客）。
//
//  ⚠️ 两个「数据在哪」的坑（踩过）：
//    1. 属性在**顶层 `character.attributes`**，不在 `data.extensions.mimitale.attributes`。
//       两处都探一下只是保险，真正生效的是顶层那个。
//    2. 运行前必须确认 App 已完全退出（`tasklist | grep electron` 为空）——
//       否则 App 会用内存里的旧数据把这次修改覆盖掉（踩过两次）。
//
//  用法：
//    node tools/fix-static-modes.js --dry   # 只看会改什么，不写盘
//    node tools/fix-static-modes.js         # 真改（会先备份）
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
