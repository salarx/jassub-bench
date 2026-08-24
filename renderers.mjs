// Compare renderer backends in Chrome on identical frames: per-frame cost plus a pixel hash, so a
// difference in speed can never be a difference in output going unnoticed.
//
//   node renderers.mjs
//   RENDERERS=webgl2,webgpu-buffer node renderers.mjs
//
// Run it several times. The spread between runs is comparable to the spread between renderers, and a
// single run has picked the wrong winner here before.
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage()
page.on('pageerror', e => console.error('PAGEERROR', String(e).slice(0, 200)))
page.on('console', m => { const t = m.text(); if (/error|Error|WebGPU|validation/.test(t)) console.error('  console:', t.slice(0, 200)) })
await page.goto('http://localhost:5199/pages/smoke.html')

const run = async renderer => await page.evaluate(async ({ renderer }) => {
  const A = new URL('../assets', location.href).href
  const F = f => `${A}/fonts/${encodeURIComponent(f)}`
  const W = 1920; const H = 1080

  document.querySelectorAll('canvas.ab').forEach(c => c.remove())
  const canvas = document.createElement('canvas')
  canvas.className = 'ab'
  canvas.width = W; canvas.height = H
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
  document.body.style.margin = '0'
  document.body.appendChild(canvas)

  const { default: JASSUB } = await import('../dist/patched/jassub.js')
  const instance = new JASSUB({
    canvas,
    subUrl: `${A}/subtitles/beastars.ass`,
    fonts: ['architext.regular.ttf', 'FRABK.TTF', 'Lato-Regular.ttf', 'arial.ttf', 'chawp.otf', 'SlatePro-Medium.otf', 'allison-script.regular.otf'].map(F),
    queryFonts: false, packed: true, renderer
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
  const ms = (performance.now() - t0) / N

  // hash one settled frame so the two renderers can be compared pixel for pixel
  await instance.manualRender({ mediaTime: 248, width: W, height: H }, true)
  await new Promise(r => setTimeout(r, 300))
  const bmp = await createImageBitmap(canvas)
  const off = new OffscreenCanvas(bmp.width, bmp.height)
  const g = off.getContext('2d', { willReadFrequently: true })
  g.drawImage(bmp, 0, 0)
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data
  let lit = 0; let hash = 2166136261
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) lit++
  for (let i = 0; i < d.length; i++) { hash ^= d[i]; hash = Math.imul(hash, 16777619) }

  await instance.destroy()
  return { ms: +ms.toFixed(2), lit, hash: (hash >>> 0).toString(16), backing: `${canvas.width}x${canvas.height}` }
}, { renderer })

const out = {}
for (const r of (process.env.RENDERERS || 'webgpu,webgpu-buffer,webgl2').split(',')) {
  out[r] = await run(r)
  console.log(`${r.padEnd(14)} ${String(out[r].ms).padStart(6)}ms  lit=${out[r].lit}  hash=${out[r].hash}  ${out[r].backing}`)
}
const hashes = new Set(Object.values(out).map(o => o.hash))
console.log(hashes.size === 1 ? '\nall renderers pixel-identical' : `\nDIFFER: ${hashes.size} distinct hashes`)
await browser.close()
