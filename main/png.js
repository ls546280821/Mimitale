'use strict';

// ============================================================================
//  main/png.js —— 酒馆 PNG 角色卡里那点「元数据藏在图片里」的活
//
//  酒馆（SillyTavern）的角色卡其实是一张 PNG：卡数据 base64 之后塞在 PNG 的
//  tEXt 块里，关键字 chara（v2）或 ccv3（v3）。所以导入要会读，导出要会写。
//
//  独立成模块的原因和 main/characters.js 一样：tools/smoke-test.js 要 require 它，
//  这样「导出 → 再导入」的往返能跑**同一份真代码**，而不是测试里自己糊一套。
// ============================================================================

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 每个数据块末尾跟一个 CRC32（对「块类型 + 数据」算）。标准查表实现
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 往 PNG 里插一个 tEXt 块。
 * 位置放在 IHDR 之后 —— 规范允许放在任何块之间，但紧挨头部最不容易踩到别人的解析器。
 * 不是合法 PNG 就原样返回：宁可导出一张没有数据的图，也不要写出个坏文件。
 */
function pngWithTextChunk(png, keyword, text) {
  if (!isPng(png)) return png;

  const ihdrLength = png.readUInt32BE(8);
  const insertAt = 8 + 4 + 4 + ihdrLength + 4;
  if (insertAt > png.length) return png;

  const type = Buffer.from('tEXt', 'latin1');
  // tEXt 规定用 Latin-1：关键字 + \0 + 文本。调用方传的是 base64，纯 ASCII，安全
  const data = Buffer.concat([
    Buffer.from(String(keyword), 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(text), 'latin1')
  ]);

  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);

  return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)]);
}

/** 读一个 tEXt 块的值（找不到就返回 null） */
function readTextChunk(buffer, wantedKeyword) {
  if (!isPng(buffer)) return null;

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // 长度字段不可信，越界就停，避免读到别的数据
    if (length < 0 || dataEnd + 4 > buffer.length) break;

    if (type === 'tEXt') {
      const chunk = buffer.subarray(dataStart, dataEnd);
      const separator = chunk.indexOf(0);
      if (separator > 0) {
        const keyword = chunk.toString('latin1', 0, separator);
        if (keyword === wantedKeyword) return chunk.toString('latin1', separator + 1);
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  return null;
}

/**
 * 从 PNG 里读出角色卡数据。ccv3（v3）优先于老的 chara（v2）。
 * 解析不出对象就返回 null —— 调用方据此报「这张图里没有卡数据」。
 */
function parseCharacterCardPng(buffer) {
  // ccv3 是 v3 卡，优先于老的 chara
  const charaText = readTextChunk(buffer, 'ccv3') || readTextChunk(buffer, 'chara');
  if (!charaText) return null;

  // 正常是 base64；有些工具直接塞了明文 JSON，两种都试
  try {
    return JSON.parse(Buffer.from(charaText, 'base64').toString('utf8'));
  } catch (err) {
    try {
      return JSON.parse(charaText);
    } catch (err2) {
      return null;
    }
  }
}

module.exports = { crc32, pngWithTextChunk, readTextChunk, parseCharacterCardPng, isPng };
