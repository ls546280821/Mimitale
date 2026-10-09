'use strict';

// electron --no-sandbox tools/test-ui-optimization.js
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-ui-'));
app.setPath('userData', path.join(tmpRoot, 'user-data'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  try {
    // 独立临时页面只加载真实样式与共享字段模块；不启动应用，不读取用户数据。
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    const page = path.join(os.tmpdir(), 'mimitale-ui-optimization.html');
    fs.writeFileSync(page, html);
    await win.loadFile(page);
    // 隐藏窗口不一定持有页面焦点，而下面「键盘聚焦要露出操作区」这条依赖它 ——
    // 不显式给一次焦点的话，element.focus() 会被 Blink 忽略，
    // 断言时好时坏（而且它一失败就在断言处抛出，后面的表格检查根本跑不到）。
    win.webContents.focus();
    const rootUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
    const panelUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'main', 'panel-fields.js')).href;
    const checks = await win.webContents.executeJavaScript(`(async () => {
      const results = [];
      const check = (name, pass) => results.push({name, pass: !!pass});
      await new Promise((resolve, reject) => {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(rootUrl)} + 'style.css'; link.onload = resolve; link.onerror = reject; document.head.append(link);
      });
      await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = ${JSON.stringify(panelUrl)}; script.onload = resolve; script.onerror = reject; document.head.append(script);
      });
      window.mimitale = {};
      const {state} = await import(${JSON.stringify(rootUrl)} + 'js/core/state.js');
      const messages = await import(${JSON.stringify(rootUrl)} + 'js/data/messages.js');
      const memory = await import(${JSON.stringify(rootUrl)} + 'js/data/memory.js');
      state.settings = {showDate: false, maxTurns: 20};
      const convo = {messages: [null, {role:'error',content:'错误'}, {role:'user',content:'现在说的话'}, {role:'assistant',content:' '}], summaries:[{end:28,text:'之前的摘要'}]};
      const history = memory.convoContextMessages(convo);
      const out = messages.buildApiMessages(convo, '', '').filter(m => ['user','assistant'].includes(m.role));
      check('上下文和摘要共用过滤且保留当前消息', JSON.stringify(out) === JSON.stringify(history));
      check('缺少消息数组也能构建上下文', Array.isArray(messages.buildApiMessages({}, '', '')));
      state.characters = [{id:'alice',name:'Alice',optionsSpec:false}];
      const role = {characterId:'alice',player:{name:'小明'},messages:[{role:'user',content:'开门'}]};
      check('世界书替换角色和玩家宏', messages.buildApiMessages(role, '{{char}}为{{user}}开门', '').some(m => m.content === 'Alice为小明开门'));
      check('世界模式使用叙述者宏', messages.buildApiMessages({...role,characterId:'',gmMode:true}, '{{char}}为{{user}}开门', '').some(m => m.content === '叙述者为小明开门'));
      document.body.innerHTML = '<div class="msg assistant" style="width:360px"><div class="msg-body"><div class="bubble"><table><tbody><tr>' + '<td>' + 'W'.repeat(80) + '</td><td>second</td>' + '</tr></tbody></table></div><div class="msg-actions"><button class="mini-btn">编辑</button></div></div></div><div class="brand-dot"></div><div class="waiting"></div><div class="msg-option-skeleton"></div><div class="msg illustrating"><div class="bubble"></div></div>';
      const actions = document.querySelector('.msg-actions');
      check('未悬停的操作区保持淡出', getComputedStyle(actions).opacity === '0');
      document.querySelector('.mini-btn').focus();
      // 这条规则带 0.15s 过渡，固定等 180ms 在忙的机器上会踩到边界 ——
      // 改成有界轮询：只要最终变成 1 就算过，超时才算失败（断言口径没放松）。
      const waitOpacity = async (want, ms) => {
        const until = performance.now() + ms;
        while (performance.now() < until) {
          if (getComputedStyle(actions).opacity === want) return true;
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return getComputedStyle(actions).opacity === want;
      };
      check('键盘聚焦显示消息操作', await waitOpacity('1', 1500));
      const table = document.querySelector('table');
      check('宽表格在气泡内部滚动', getComputedStyle(table).overflowX === 'auto' && table.scrollWidth > table.clientWidth && table.getBoundingClientRect().width <= 360);
      return results;
    })()`);
    for (const item of checks) {
      console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}`);
      assert.ok(item.pass, item.name);
    }
    // CDP 模拟系统减少动态效果偏好，检查真实计算样式。
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name: 'prefers-reduced-motion', value: 'reduce'}] });
    const animations = await win.webContents.executeJavaScript(`[
      getComputedStyle(document.querySelector('.brand-dot')).animationName,
      getComputedStyle(document.querySelector('.waiting'), '::after').animationName,
      getComputedStyle(document.querySelector('.msg-option-skeleton')).animationName,
      getComputedStyle(document.querySelector('.msg.illustrating .bubble')).animationName
    ]`);
    assert.deepEqual(animations, ['none', 'none', 'none', 'none']);
    console.log('PASS 减少动态效果停用所有持续加载动画');
    win.webContents.debugger.detach();
    app.exit(0);
  } catch (err) {
    console.error(err.stack || err);
    app.exit(1);
  }
});
