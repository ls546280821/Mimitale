'use strict';

// ============================================================================
//  main/import-files.js —— 导入链路的编排（一串文件 → 要落盘的角色 / 世界书）
//
//  从 main.js 的 characters:import 里抽出来的。原来这段夹在
//  「文件对话框 + fs.readFileSync + 闭包」中间，只有人手点一次导入才跑得到，
//  所以整条链路在自动化测试里是空的 —— 冒烟测试里 characters:import
//  一直是个 `{canceled:true}` 的桩。
//
//  最值得测的一条是**自动绑定**：角色卡里内嵌的 character_book 会被存成一本
//  独立世界书，并自动绑到这张卡上。这个绑定是「导入即可用」的关键，
//  断了的话表现是「卡导进来了、书也在库里，但就是不生效」——
//  不报错、不提示，只能靠人发现。
//
//  这里只负责编排：读文件、大小闸门、分派、绑定。
//  真正的形状识别和归一化在 main/card-import.js。
//  fs 由调用方注入，测试能喂内存里的假文件系统。
// ============================================================================

// 单文件大小上限。默认和主进程原来的行为一致（12MB），由调用方覆盖。
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
// 一次导入的文件数上限，防止手滑全选整个目录
const MAX_IMPORT_FILES = 100;

/**
 * 把一批文件解析成「角色 + 世界书」。
 *
 * @param {object}   opts
 * @param {string[]} opts.paths      文件绝对路径
 * @param {function} opts.readFile   (path) => Buffer
 * @param {function} opts.parseImportFile  见 main/card-import.js
 * @param {function} opts.makeWorldbookId  生成世界书 id
 * @param {function} opts.basename   (path) => string；不传就按分隔符切
 * @param {function} opts.extname    (path) => string
 * @param {number}   [opts.maxBytes]
 * @returns {{characters: object[], worldbooks: object[], errors: string[]}}
 */
function importFiles(opts) {
  const o = opts || {};
  const paths = Array.isArray(o.paths) ? o.paths.filter((p) => typeof p === 'string' && p) : [];
  const readFile = o.readFile;
  const parseImportFile = o.parseImportFile;
  const makeWorldbookId = o.makeWorldbookId;
  const basename = typeof o.basename === 'function' ? o.basename : (p) => String(p).split(/[\\/]/).pop();
  const extname =
    typeof o.extname === 'function'
      ? o.extname
      : (p) => {
          const base = basename(p);
          const i = base.lastIndexOf('.');
          return i > 0 ? base.slice(i) : '';
        };
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_IMPORT_BYTES;

  const characters = [];
  const worldbooks = [];
  const errors = [];

  if (typeof readFile !== 'function' || typeof parseImportFile !== 'function') {
    return { characters, worldbooks, errors: ['导入链路没有配好（缺少 readFile / parseImportFile）'] };
  }

  for (const file of paths.slice(0, MAX_IMPORT_FILES)) {
    const base = basename(file);
    let buffer;
    try {
      buffer = readFile(file);
    } catch (err) {
      errors.push(`${base}：${(err && err.message) || '读取失败'}`);
      continue;
    }

    if (!buffer || !buffer.length) {
      errors.push(`${base}：读不到内容`);
      continue;
    }
    if (buffer.length > maxBytes) {
      errors.push(`${base}：文件太大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${maxBytes / 1048576}MB）`);
      continue;
    }

    let parsed;
    try {
      parsed = parseImportFile({
        buffer,
        ext: extname(file).toLowerCase(),
        fallbackName: base.replace(/\.[^.]+$/, ''),
        makeWorldbookId
      });
    } catch (err) {
      errors.push(`${base}：${(err && err.message) || '解析失败'}`);
      continue;
    }

    if (!parsed || parsed.kind === 'error') {
      errors.push(`${base}：${(parsed && parsed.error) || '解析失败'}`);
      continue;
    }

    if (parsed.kind === 'worldbook') {
      worldbooks.push(parsed.worldbook);
      continue;
    }

    // 角色卡。内嵌世界书：给它一个正式 id 存进世界书库，并**自动绑到这个角色**上。
    // 一张卡自带的书就是给这张卡用的，导入即可用；
    // 不想要的话，在角色编辑器里关掉开关或者解绑就行。
    if (parsed.worldbook) {
      worldbooks.push(parsed.worldbook);
      parsed.character.worldbookIds = [parsed.worldbook.id];
      parsed.character.worldbookEnabled = true;
    }
    characters.push(parsed.character);
  }

  if (paths.length > MAX_IMPORT_FILES) {
    errors.push(`一次最多导入 ${MAX_IMPORT_FILES} 个文件，剩下的被跳过了`);
  }

  return { characters, worldbooks, errors };
}

module.exports = { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, importFiles };
