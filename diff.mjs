// Render one frame with two renderers and describe exactly how the pixels differ.
//
//   TIMES=0,3.91,... T=50.836 node diff.mjs
//
// matrix.mjs reports that two renderers disagree; this says by how much, which is the difference between
// a rendering bug and a rounding one. It reproduces the harness's render parameters exactly - 1920x1080
// video dimensions capped by maxRenderHeight, 90ms between frames, the whole timestamp sequence replayed -
// because a standalone repro at the final resolution showed no difference at all and cost an hour.
import { chromium } from 'playwright'

const T = +(process.env.T || 50.836)
const TIMES = (process.env.TIMES || '').split(',').filter(Boolean).map(Number)
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage()
page.on('pageerror', e => console.error('PAGEERROR', String(e).slice(0, 200)))
page.on('console', m => { const t = m.text(); if (/error|fail|validation/i.test(t)) console.error('  console:', t.slice(0, 200)) })
await page.goto('http://localhost:5199/pages/smoke.html')

const grab = async renderer => await page.evaluate(async ({ renderer, T, TIMES }) => {
  const A = new URL('../assets', location.href).href
  const F = f => `${A}/fonts/${encodeURIComponent(f)}`
  const W = 1920; const H = 1080
  document.querySelectorAll('canvas.d').forEach(c => c.remove())
  const canvas = document.createElement('canvas')
  canvas.className = 'd'
  canvas.width = W; canvas.height = H
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
  document.body.style.margin = '0'
  document.body.appendChild(canvas)

  const { default: JASSUB } = await import('../dist/patched/jassub.js')
  const i = new JASSUB({
    canvas,
    subUrl: `${A}/subtitles/${encodeURIComponent('Kusriya S2 OP1v3.ass')}`,
    fonts: ['FOT-TsukuCOldMinPr6NR.OTF', 'RoughFlowers.TTF'].map(F),
    queryFonts: false, packed: true, renderer, maxRenderHeight: 540
  })
  await i.ready
  await new Promise(r => setTimeout(r, 2500))
  // replay the whole sequence the matrix harness does, then keep the frame under test - the difference
  // only shows when this frame follows the others
  for (const t of TIMES) {
    await i.manualRender({ expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: t }, true)
    await new Promise(r => setTimeout(r, 90))
    if (t === T) break
  }
  // no settle wait: the harness hashes as soon as the render call resolves, and that is the condition
  // under which the two renderers disagree

  const bmp = await createImageBitmap(canvas)
  const off = new OffscreenCanvas(bmp.width, bmp.height)
  const g = off.getContext('2d', { willReadFrequently: true })
  g.drawImage(bmp, 0, 0)
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data
  await i.destroy()
  return Array.from(d)
}, { renderer, T, TIMES })

const a = await grab('webgl2')
const b = await grab('webgpu-buffer')

let differing = 0; let maxDelta = 0
const chan = [0, 0, 0, 0]
const hist = new Map()
for (let i = 0; i < a.length; i += 4) {
  let any = false
  for (let c = 0; c < 4; c++) {
    const d = Math.abs(a[i + c] - b[i + c])
    if (d) { any = true; chan[c]++; if (d > maxDelta) maxDelta = d; hist.set(d, (hist.get(d) ?? 0) + 1) }
  }
  if (any) differing++
}
console.log(`pixels differing: ${differing} of ${a.length / 4}`)
console.log(`per channel  R=${chan[0]} G=${chan[1]} B=${chan[2]} A=${chan[3]}`)
console.log(`max delta: ${maxDelta}`)
console.log('delta histogram:', [...hist.entries()].sort((x, y) => x[0] - y[0]).slice(0, 8).map(([d, n]) => `${d}:${n}`).join(' '))
await browser.close()
