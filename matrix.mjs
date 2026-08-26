import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachine } from './machine.mjs'

// Pixel-identity across every benchmark track, not just beastars.
// Each case renders the same evenly-spaced timestamps of each track at a fixed size and hashes the canvas;
// any hash difference against the reference case is a rendering change. Screenshots are captured at a few
// intervals per track so a difference can actually be looked at rather than just counted.
const TRACKS = (process.env.TRACKS || 'variable,high,simple,fate,beastars,kusriya').split(',')
const CASES = [
  { label: 'upstream', build: 'baseline', renderer: 'auto', packed: '1' },
  // the default path, which is what nearly everyone actually gets - it was untested here until the
  // default changed from webgl2 to the storage-buffer WebGPU renderer
  { label: 'branch-auto', build: 'patched', renderer: 'auto', packed: '1' },
  { label: 'branch-webgl2', build: 'patched', renderer: 'webgl2', packed: '1' },
  { label: 'branch-unpacked', build: 'patched', renderer: 'webgl2', packed: '0' },
  // the fallback for anything without WebGL at all, and the only backend that composites on the 2D context
  // rather than in a shader. Coverage-only: see coverageOnly below.
  { label: 'branch-canvas2d', build: 'patched', renderer: 'canvas2d', packed: '1', coverageOnly: true }
  // 'webgpu-buffer' has no row of its own because it is what 'branch-auto' now selects - it is the shipped
  // default. Its one-frame kusriya difference is carried in KNOWN below rather than as a missing case.
  // 'webgl2-atlas' is gone from the branch: slower than webgl2, pixel-identical where it worked, and blank
  // at 1920x1080 under renderers.mjs.
  // 'webgpu' is gone too, though not for that reason: it does not name a renderer at all any more, and the
  // forced-name chain in worker.ts tests 'webgpu-buffer', 'canvas2d' and 'webgl1' before falling through to
  // WebGL2 - so it silently selects WebGL2, not the storage buffer. Probed on a live instance: 'webgpu' and
  // 'webgl2' both come back with texArrayWidth 256, where 'webgpu-buffer' reports dataCapacity instead. A
  // row for it would have measured branch-webgl2 twice. The array-texture renderer it used to select is
  // still reachable headlessly, under Deno.
]
const EXTRA = (process.env.EXTRA_CASES || '').split(',').filter(Boolean).map(x => {
  const [label, build, renderer, packed] = x.split(':')
  return { label, build, renderer, packed: packed ?? '1' }
})
CASES.push(...EXTRA)

const SAMPLES = +(process.env.SAMPLES || 24)
// Same trap the other runners warn about, with a sharper edge here. Unpinned, this page renders at the full
// device-pixel size of its box - 1920x1080 at deviceScaleFactor 2 - and the upstream baseline draws nothing
// at all at that size, on every renderer it offers. So every frame reads as a mismatch, and the report
// blames the branch for a blank upstream. Pinning the height sidesteps it; the branch itself renders
// correctly at either size (see backends.mjs, which asserts exactly that).
if (!process.env.MRH) console.error('MRH is not set: this renders at 1920x1080, where the upstream baseline draws nothing and every frame will "differ". Re-run with MRH=540.')
// screenshots are the one part here that needs a human to judge, so they are opt-in.
// the hash comparison below is fully mechanical and is what decides pass/fail.
const SHOTS = process.env.SHOTS === '1'
const SHOT_EVERY = +(process.env.SHOT_EVERY || 8)

// anchored to the repo root, not the process cwd: run from the repo root these landed in the repo root
// while the failure message pointed at shots/
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = join(HERE, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
await printMachine()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const results = {}

for (const track of TRACKS) {
  results[track] = {}
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
    await page.goto(`http://localhost:5199/pages/matrix.html?build=${c.build}&renderer=${c.renderer}&packed=${c.packed}&track=${track}&samples=${SAMPLES}&mrh=${process.env.MRH || 0}`)
    try {
      await page.waitForFunction(() => window.__RESULT, null, { timeout: 240000 })
      const r = await page.evaluate(() => window.__RESULT)
      results[track][c.label] = { frames: r.frames, range: r.range, errors: errs }

      // re-render a few checkpoints and screenshot them for eyeballing
      if (SHOTS) for (let i = 0; i < r.frames.length; i += SHOT_EVERY) {
        const t = r.frames[i].t
        await page.evaluate(async t => {
          await window.__i.manualRender({ expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: t }, true)
          await new Promise(r => setTimeout(r, 150))
        }, t)
        await page.locator('#c').screenshot({ path: join(SHOT_DIR, `${track}__${c.label}__t${t.toFixed(2)}.png`) })
      }
    } catch {
      results[track][c.label] = { frames: null, errors: errs.concat(await page.evaluate(() => window.__s ?? '?').catch(() => '?')) }
    }
    await ctx.close()
    const f = results[track][c.label].frames
    console.error(`  ${track}/${c.label}: ${f ? f.length + ' frames, ' + f.filter(x => x.lit > 0).length + ' non-empty' : 'FAILED ' + results[track][c.label].errors[0]}`)
  }
}
await browser.close()
writeFileSync(join(HERE, 'matrix.json'), JSON.stringify(results, null, 2))

// Deltas that have been chased to the bottom and accepted, keyed by track and frame index.
//
// The hash is exact on purpose - a tolerance here would have hidden two real bugs while this was written -
// so an accepted difference is listed rather than tolerated, and printed every run. Anything not on this
// list still fails. Re-verify with bench/diff on the frame if one of these ever changes shape.
const KNOWN = [
  {
    track: 'kusriya',
    frame: 13,
    cases: ['branch-auto', 'gpubuf'],
    why: 'storage-buffer renderer: 1 pixel, blue channel, 1/255. f32(b)/255 in the shader against a hardware R8 fetch, over 624 overlapping blends.'
  }
]
const known = (track, label, i) => KNOWN.find(k => k.track === track && k.frame === i && k.cases.includes(label))

// compare every case against upstream, frame by frame
console.log('\npixel identity vs upstream (per track)')
console.log(`${'track'.padEnd(10)} ${'case'.padEnd(17)} ${'frames'.padStart(7)} ${'nonEmpty'.padStart(9)} ${'mismatch'.padStart(9)}  verdict`)
let anyDiff = false
for (const track of TRACKS) {
  const ref = results[track].upstream?.frames
  for (const c of CASES) {
    const f = results[track][c.label]?.frames
    if (!f) { console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${'-'.padStart(7)} ${'-'.padStart(9)} ${'-'.padStart(9)}  FAILED`); anyDiff = true; continue }
    const nonEmpty = f.filter(x => x.lit > 0).length
    if (!ref || c.label === 'upstream') { console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${String(f.length).padStart(7)} ${String(nonEmpty).padStart(9)} ${'ref'.padStart(9)}  -`); continue }
    // The 2D fallback composites on a canvas context instead of in a shader, so it cannot be held to the
    // colour hash - but its coverage is now exact, and is checked as such.
    //
    // It used to lose faint pixels: -11.1% of the lit pixels on the worst fate frame, -8.4% on kusriya,
    // always fewer and never more. The cause was `((alpha * k) << 24)`, where the shift coerces to int32 and
    // truncates, while every other renderer writes a float to an rgba8unorm target and rounds. Rounding
    // instead makes the lit counts match exactly on every track, so an inexact one is now a real regression
    // rather than a known wart, and this asserts it.
    //
    // The colour hash still differs and is not checked. ImageData carries straight alpha, a canvas stores
    // premultiplied, and getImageData un-premultiplies - two lossy conversions against the GPU path's one.
    // The residual is bounded by 255/alpha, so it is 1/255 on 98.9% of samples and only reaches three digits
    // on pixels too faint to see. On screen the stored premultiplied values differ by at most one step; the
    // readback is what amplifies it.
    const coverageBad = (x, r) => {
      if (!r) return true
      if (x.w !== r.w || x.h !== r.h) return true
      return x.lit !== r.lit
    }
    const diffs = c.coverageOnly
      ? f.map((x, i) => coverageBad(x, ref[i]) ? i : -1).filter(i => i >= 0)
      : f.map((x, i) => (!ref[i] || x.hash !== ref[i].hash) ? i : -1).filter(i => i >= 0)
    const accepted = diffs.filter(i => known(track, c.label, i))
    const mism = diffs.length - accepted.length
    if (mism) anyDiff = true
    const note = accepted.length ? ` (+${accepted.length} known)` : ''
    const verdict = mism ? 'DIFFERS' : (c.coverageOnly ? 'coverage ok' : 'identical')
    console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${String(f.length).padStart(7)} ${String(nonEmpty).padStart(9)} ${String(mism).padStart(9)}  ${verdict}${note}`)
    for (const i of accepted) console.log(`${' '.repeat(28)}known: frame ${i} - ${known(track, c.label, i).why}`)
  }
}
console.log(anyDiff
  ? '\nRESULT: FAIL - at least one case differs' + (SHOTS ? ' (see shots/)' : ' (re-run with SHOTS=1 to capture images)')
  : '\nRESULT: PASS - all cases pixel-identical to upstream across all tracks (canvas2d: coverage only)')
process.exitCode = anyDiff ? 1 : 0
