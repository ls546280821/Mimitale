'use strict';

// ============================================================================
//  tools/test-download-binary.js —— main/http.js 的 downloadBinary（生图结果是链接时用它下载）
//
//  钉住三道闸（2026-10-10 前都没有）：
//    ① 重定向最多跟 5 跳 —— 以前对面给个重定向环就无限递归、每跳漏一条连接
//    ② Location 可以是相对地址 —— 以前 new URL('/x') 直接报「链接格式不对」
//    ③ 响应体有上限 —— 以前无上限往内存里攒，一个超大响应能把主进程吃光
//
//  跑法： node --test tools/test-download-binary.js
//  只起一个 127.0.0.1 上的本地 http 服务，不出网、不碰任何数据。
//
//  ⚠️ http.js 会 require providers.js → store.js → electron，这里没有 Electron
//     运行时，所以塞个假的（口径同 tools/test-settings-migration.js）。
// ============================================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: () => path.join(os.tmpdir(), 'mimitale-dl-test-unused'),
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false }
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { downloadBinary } = require('../main/http.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ok') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    } else if (url.pathname === '/relative') {
      // 相对地址的重定向
      res.writeHead(302, { Location: '/ok' });
      res.end('moved');
    } else if (url.pathname === '/loop') {
      // 永远指回自己
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (url.pathname === '/huge-declared') {
      res.writeHead(200, { 'Content-Length': String(500 * 1024 * 1024) });
      res.write(PNG); // 声明 500MB，实际不发 —— 看 Content-Length 就该拒
    } else if (url.pathname === '/huge-chunked') {
      // 不带 Content-Length，一直发：只能靠「收到多少」来拦
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < 200 && !res.destroyed) {
          sent += 1;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      pump();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('正常下载拿到原样字节', async () => {
  const buf = await downloadBinary(`${base}/ok`);
  assert.deepEqual(buf, PNG);
});

test('相对地址的重定向能跟过去', async () => {
  const buf = await downloadBinary(`${base}/relative`);
  assert.deepEqual(buf, PNG);
});

test('重定向环：有限跳数后报错，而不是无限跟下去', async () => {
  await assert.rejects(downloadBinary(`${base}/loop`, 10000), /重定向次数太多/);
});

test('Content-Length 声明超上限：直接拒', async () => {
  await assert.rejects(downloadBinary(`${base}/huge-declared`, 10000), /文件太大/);
});

test('不声明长度但一直发：收到超过上限就掐断', async () => {
  await assert.rejects(downloadBinary(`${base}/huge-chunked`, 30000), /文件太大/);
});

test('非 http(s) 链接直接拒', async () => {
  await assert.rejects(downloadBinary('file:///C:/Windows/win.ini'), /只支持 http/);
});
