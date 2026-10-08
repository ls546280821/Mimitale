'use strict';
// 只读诊断：查数据文件现在能不能写。除了最后那一步探针，不往里写任何东西。
//
// 2026-10-08 起数据默认放在「程序旁边的 data\」（main/data-dir.js），
// 不再是 C 盘的 %APPDATA%\Mimitale。所以这里两个位置都报，
// 并指出当前生效的是哪一个 —— 老工具盯着 C 盘看，会得出「文件不存在」的假结论。
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PORTABLE = path.join(REPO, 'data');
const LEGACY = 'C:\\Users\\Administrator\\AppData\\Roaming\\Mimitale';
const files = ['characters.json', 'characters.json.backup', 'worldbooks.json', 'worldbooks.json.backup',
               'conversations.json', 'config.json', 'presets.json'];

function hasData(dir) {
  return files.some((f) => fs.existsSync(path.join(dir, f)));
}

let DIR = PORTABLE;
let why = '（程序旁边的 data\\）';
if (!hasData(PORTABLE) && hasData(LEGACY)) {
  DIR = LEGACY;
  why = '（老位置 %APPDATA%\\Mimitale）';
}

console.log('项目目录      :', REPO);
console.log('旁边 data\\    :', PORTABLE, fs.existsSync(PORTABLE) ? '(存在)' : '(不存在)');
console.log('老位置        :', LEGACY, fs.existsSync(LEGACY) ? '(存在)' : '(不存在)');
console.log('当前生效      :', DIR, why);
console.log('');

console.log('目录:', DIR);
try {
  const ds = fs.statSync(DIR);
  console.log('目录 mtime:', ds.mtime.toISOString(), '| 属性只读?', (ds.mode & 0o200) === 0);
} catch (e) {
  console.log('目录 stat 失败:', e.message);
}
console.log('');

for (const f of files) {
  const p = path.join(DIR, f);
  let line = f.padEnd(28);
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    console.log(line + '不存在 (' + e.code + ')');
    continue;
  }
  const readonly = (st.mode & 0o200) === 0;
  line += (st.size + ' B').padEnd(12);
  line += 'mtime=' + st.mtime.toISOString().slice(0, 19) + '  ';
  line += '只读属性=' + (readonly ? '是 ⚠' : '否');
  line += '  ';
  // 探锁：r+ = 读写模式打开（不写内容）。被别的进程独占 / 只读时会失败。
  try {
    const fd = fs.openSync(p, 'r+');
    fs.closeSync(fd);
    line += '可写=是';
  } catch (e) {
    line += '可写=否 [' + e.code + '] ' + e.message;
  }
  console.log(line);
}

// 还能不能在目录里新建 + rename？这正是落盘用的那两步。
// ⚠️ 这一步**会真的建一个文件再删掉** —— 这是唯一能回答「能读能列、但一个文件都
//    建不出来」的办法（2026-10-08 那次就是栽在这上面，工具却一个字都没写所以看不出来）。
console.log('');
console.log('（下面这一步会临时建一个文件再删掉）');
const probe = path.join(DIR, `__diag-probe-${process.pid}.tmp`);
try {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(probe, 'probe', 'utf8');
  fs.renameSync(probe, path.join(DIR, '__diag-probe.json'));
  console.log('目录内「写 + rename」：成功');
} catch (e) {
  console.log('目录内「写 + rename」：失败 [' + e.code + '] ' + e.message);
  console.log('  ⚠️ 这就是所有保存都会失败的原因（是权限判定，不是杀软瞬时锁，别去关杀软）');
} finally {
  for (const f of [probe, path.join(DIR, '__diag-probe.json')]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}
