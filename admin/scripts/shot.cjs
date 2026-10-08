/**
 * 后台页面截图 —— 用 Electron 自带的 Chromium 跑，不用另装浏览器。
 *
 * 跑法（注意是 Electron 脚本，用 node 跑会报 require('electron') 失败）：
 *   cd E:/工作/Mimitale/admin
 *   export MSYS_NO_PATHCONV=1 && unset ELECTRON_RUN_AS_NODE
 *   ../node_modules/electron/dist/electron.exe --no-sandbox scripts/shot.cjs
 *
 * 前提：先起预览服务
 *   npx vite preview --port 4319 --strictPort
 *
 * ⚠️ 页面之间用改 location.hash 切换，**不能 loadURL 重载** ——
 *    mock 后端的状态（登录 session、内存数据）是**每次页面加载重新初始化**的，
 *    一重载 token 就失效，会被弹回登录页。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:4319'
const OUT = path.resolve(__dirname, '..', 'shots')
const W = 1440
const H = 900

const PAGES = [
  { name: '1-login', hash: '#/login' },
  { name: '2-customers', hash: '#/customers' },
  { name: '3-customer-detail', hash: '#/customers/2' },
  { name: '4-cards', hash: '#/cards' },
  { name: '5-logs', hash: '#/logs' },
  { name: '6-dicts', hash: '#/dicts' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })

  // 把页面里的 console 全部转出来 —— 排查时最有用的一手
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`  [page:${level}] ${message}  (${String(source).split('/').pop()}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('  渲染进程挂了：', details)
  })

  // 1) 登录页
  await win.loadURL(`${BASE}/#/login`)
  // ⚠️ 隐藏窗口（show:false）在 Windows 上拿到的是**第一帧的合成结果**：
  //    数据到了、DOM 也更新了，但 capturePage 还是返回旧画面。
  //    必须让窗口真的显示出来（showInactive 不抢焦点），合成器才会继续出帧。
  win.showInactive()
  await sleep(2000)
  await snap(win, PAGES[0].name)

  // 2) 用真实表单登录（mock 的 session 是内存态，绕不过去）
  const filled = await win.webContents.executeJavaScript(`(() => {
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      d.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = document.querySelectorAll('input')
    if (inputs.length < 2) return 'inputs=' + inputs.length
    setVal(inputs[0], 'admin')
    setVal(inputs[1], 'admin123')
    const btn = [...document.querySelectorAll('button')].find(b => /登录/.test(b.textContent))
    if (!btn) return 'no login button'
    btn.click()
    return 'ok'
  })()`)
  console.log('登录表单:', filled)
  await sleep(3000)

  const hash = await win.webContents.executeJavaScript('location.hash')
  console.log('登录后落在:', hash)

  // 3) 其余页面：改 hash 切换，不重载
  for (const p of PAGES.slice(1)) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(p.hash)}`)
    await sleep(1600)
    const probe = await win.webContents.executeJavaScript(`(() => {
      const on = document.querySelector('.el-menu-item.is-active')
      const main = document.querySelector('.main')
      return {
        hash: location.hash,
        active: on ? on.textContent.trim() : '(无)',
        scrollTop: main ? main.scrollTop : -1,
        title: (document.querySelector('.page-title') || {}).textContent
      }
    })()`)
    console.log(`  → ${probe.hash} | 标题:${probe.title} | 菜单高亮:${probe.active} | scrollTop:${probe.scrollTop}`)
    await snap(win, p.name)
  }

  win.destroy()
}

async function snap(win, name) {
  // ① 真实鼠标可能正好停在侧边栏某一项上，截图里就多出一块 hover 底色 ——
  //    看起来像「菜单高亮错了」。截图期间先把 hover 效果压掉。
  // ② capturePage 在这个环境里会返回上一次合成的帧，所以连拍两张、丢第一张。
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement('style')
    s.id = '__shot_no_hover'
    s.textContent = '.el-menu-item:hover{background:transparent !important}'
    document.head.appendChild(s)
  })()`)
  win.webContents.invalidate()
  await sleep(500)
  await win.capturePage()
  await sleep(250)
  const img = await win.capturePage()
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, img.toPNG())
  await win.webContents.executeJavaScript(`document.getElementById('__shot_no_hover')?.remove()`)
  const size = img.getSize()
  console.log(`  ${name}.png  ${size.width}x${size.height}  ${Math.round(fs.statSync(file).size / 1024)} KB`)
}

app.whenReady().then(async () => {
  try {
    await main()
    console.log('\n截图完成 →', OUT)
  } catch (err) {
    console.error('截图失败：', err)
    process.exitCode = 1
  }
  app.quit()
})
