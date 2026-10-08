'use strict';
// 只读诊断：查 %APPDATA%\Mimitale 里那几个数据文件现在能不能写。
// 一个字都不写进去 —— 只用 r+ 打开探一下锁，然后立刻关掉。
const fs = require('node:fs');
const path = require('node:path');

const DIR = 'C:\\Users\\Administrator\\AppData\\Roaming\\Mimitale';
const files = ['characters.json', 'characters.json.backup', 'worldbooks.json', 'worldbooks.json.backup',
               'conversations.json', 'config.json', 'presets.json'];

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

// 还能不能在目录里新建 + rename？这正是落盘用的那两步
console.log('');
const probe = path.join(DIR, '__diag-probe.tmp');
try {
  fs.writeFileSync(probe, 'probe', 'utf8');
  fs.renameSync(probe + '2', probe); // 故意错的一步，只为看错误码
} catch (e) {
  /* 预期失败，忽略 */
}
try {
  fs.writeFileSync(probe, 'probe', 'utf8');
  fs.renameSync(probe, path.join(DIR, '__diag-probe.json'));
  console.log('目录内「写 + rename」：成功');
} catch (e) {
  console.log('目录内「写 + rename」：失败 [' + e.code + '] ' + e.message);
} finally {
  for (const f of [probe, path.join(DIR, '__diag-probe.json')]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}
