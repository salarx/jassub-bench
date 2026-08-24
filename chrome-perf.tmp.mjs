import { chromium } from 'playwright'
const ORIGIN = process.env.ORIGIN || 'http://localhost:5199'
const RENDERER = process.env.RENDERER || 'auto'
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage()
page.on('pageerror', e => console.error('PAGEERROR', String(e).slice(0, 160)))
await page.goto(`${ORIGIN}/pages/smoke.html`)
const out = await page.evaluate(async ({ RENDERER }) => {
  const A = new URL('../assets', location.href).href
  const F = f => `${A}/fonts/${encodeURIComponent(f)}`
  const W = 1920, H = 1080
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
  document.body.style.margin = '0'; document.body.appendChild(canvas)
  const { default: JASSUB } = await import('../dist/patched/jassub.js')
  const instance = new JASSUB({
    canvas, subUrl: `${A}/subtitles/beastars.ass`,
    fonts: ['architext.regular.ttf','FRABK.TTF','Lato-Regular.ttf','arial.ttf','chawp.otf','SlatePro-Medium.otf','allison-script.regular.otf'].map(F),
    queryFonts: false, packed: true,
    ...(RENDERER === 'auto' ? {} : { renderer: RENDERER })
  })
  await instance.ready
  await new Promise(r => setTimeout(r, 2500))
  const times = i => 248 + (i % 20) * 0.25
  await instance.manualRender({ mediaTime: 248, width: W, height: H }, true)
  await instance.resize(true, W, H)
  await new Promise(r => setTimeout(r, 500))
  for (let i = 0; i < 5; i++) await instance.manualRender({ mediaTime: times(i), width: W, height: H }, true)
  const N = 30
  const t0 = performance.now()
  for (let i = 0; i < N; i++) await instance.manualRender({ mediaTime: times(i), width: W, height: H }, true)
  return { total: +((performance.now() - t0) / N).toFixed(2), backing: `${canvas.width}x${canvas.height}`, iso: self.crossOriginIsolated }
}, { RENDERER })
console.log(`chrome ${RENDERER.padEnd(7)} total=${out.total}ms  backing=${out.backing}  isolated=${out.iso}`)
await browser.close()
