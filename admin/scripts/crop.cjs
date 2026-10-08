/**
 * 从截图里裁一块放大看细节。
 *
 * 用法（是 Electron 脚本，别用 node 跑）：
 *   ../node_modules/electron/dist/electron.exe --no-sandbox scripts/crop.cjs \
 *     --in=shots/2-customers.png --x=0 --y=80 --w=216 --h=180 --scale=2
 *
 * 不传 --in 就处理 shots/ 下所有 png（裁同样一块）。
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...rest] = a.slice(2).split('=')
      return [k, rest.join('=')]
    })
)

const OUT = path.resolve(__dirname, '..', 'shots')
const x = Number(args.x ?? 0)
const y = Number(args.y ?? 0)
const w = Number(args.w ?? 300)
const h = Number(args.h ?? 200)
const scale = Number(args.scale ?? 2)

function cropOne(file) {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    console.log('  跳过（读不出来）：', file)
    return
  }
  const size = img.getSize()
  const box = {
    x: Math.max(0, Math.min(x, size.width - 1)),
    y: Math.max(0, Math.min(y, size.height - 1)),
    width: Math.min(w, size.width - x),
    height: Math.min(h, size.height - y)
  }
  const out = img.crop(box).resize({ width: Math.round(box.width * scale) })
  const target = file.replace(/\.png$/, `.crop-${x}-${y}.png`)
  fs.writeFileSync(target, out.toPNG())
  console.log(`  ${path.basename(file)} → ${path.basename(target)}  ${out.getSize().width}x${out.getSize().height}`)
}

app.whenReady().then(() => {
  const inputs = args.in
    ? [path.resolve(process.cwd(), args.in)]
    : fs.readdirSync(OUT).filter((f) => f.endsWith('.png') && !f.includes('.crop-')).map((f) => path.join(OUT, f))

  inputs.forEach(cropOne)
  app.quit()
})
