// Do node, bun and deno render the same pixels as each other, and how fast?
//
//   node backends.mjs
//   RUNTIMES=node,deno node backends.mjs
//   TRACKS=beastars SIZES=1920x1080,960x540 node backends.mjs
//
// The browser runners cannot see any of this: they drive Chrome, and the backend entry points share the
// libass bindings and the blending maths with the browser but not the render target. A backend that silently
// stopped drawing would pass every other runner in this repo.
//
// It is a check as well as a measurement. Every runtime renders identical timestamps at identical sizes, and
// the per-frame hashes have to agree - across runtimes, and across render sizes for the lit/empty pattern.
// The second half is what settles jassub#12: whether a larger frame size costs frames. It does not, and this
// asserts that headlessly, without the fixed settle time that made the browser harness look like it did.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachine } from './machine.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILD = process.env.BUILD || 'patched'
const SAMPLES = +(process.env.SAMPLES || 6)
const THREADS = +(process.env.THREADS || 1)
const SIZES = (process.env.SIZES || '1920x1080,960x540').split(',').map(s => s.split('x').map(Number))

const TRACKS = {
  variable: { sub: 'box.ass', fonts: [] },
  simple: { sub: 'test.ass', fonts: [] },
  fate: { sub: 'FGOBD.ass', fonts: ['Averia Sans Libre Light.ttf', 'Averia Serif Simple Light.ttf', 'Gramond.ttf'] },
  beastars: { sub: 'beastars.ass', fonts: ['architext.regular.ttf', 'FRABK.TTF', 'allison-script.regular.otf', 'Lato-Regular.ttf', 'chawp.otf', 'arial.ttf', 'SlatePro-Medium.otf'] },
  kusriya: { sub: 'Kusriya S2 OP1v3.ass', fonts: ['FOT-TsukuCOldMinPr6NR.OTF', 'RoughFlowers.TTF'] }
}
const WANTED = (process.env.TRACKS || Object.keys(TRACKS).join(',')).split(',')

// deno needs its permissions spelled out, and --allow-ffi is what lets a native WebGPU binding load
const DENO_ARGS = ['run', '--allow-read', '--allow-net', '--allow-env', '--allow-sys', '--allow-ffi', '--unstable-webgpu']
const RUNTIMES = {
  node: { cmd: 'node', args: [] },
  bun: { cmd: 'bun', args: ['run'] },
  deno: { cmd: 'deno', args: DENO_ARGS }
  // A 'deno-array' case briefly lived here to cover the array-texture renderer, which the browser had
  // stopped offering. Measuring it is what showed it to be 8-10% slower than the storage buffer rather than
  // faster, so it was removed from jassub entirely and there is nothing left for this case to select. The
  // per-run renderer name below is the guard against that happening quietly: a case that resolves to a
  // different renderer than the one asked for shows up as the same name twice.
}
const WANTED_RUNTIMES = (process.env.RUNTIMES || 'node,bun,deno').split(',')

const secs = s => { const [h, m, x] = s.split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(x) }
const range = sub => {
  const text = readFileSync(join(HERE, 'assets/subtitles', sub), 'utf8')
  let lo = Infinity; let hi = 0
  for (const m of text.matchAll(/^Dialogue:[^,]*,([^,]+),([^,]+),/gm)) {
    const a = secs(m[1]); const b = secs(m[2])
    if (a < lo) lo = a
    if (b > hi) hi = b
  }
  return isFinite(lo) ? [lo, hi] : [0, 10]
}

// bun is a .cmd shim on Windows and Node will not spawn one without a shell - it fails with EINVAL, which
// this used to read as "not installed" and skip the whole runtime silently.
const WIN = process.platform === 'win32'

const available = name => {
  const { cmd } = RUNTIMES[name]
  return spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: WIN }).status === 0
}

function render (runtime, opts) {
  const { cmd, args, renderer } = RUNTIMES[runtime]
  if (renderer) opts = { ...opts, renderer }
  // base64 so the payload survives the shell that Windows needs; the path is quoted for the same reason
  const script = join(HERE, 'backend-render.mjs')
  const arg = WIN ? Buffer.from(JSON.stringify(opts)).toString('base64') : JSON.stringify(opts)
  const r = spawnSync(cmd, [...args, WIN ? `"${script}"` : script, arg], {
    cwd: HERE,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    shell: WIN
  })
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('__RESULT__'))
  if (!line) {
    return { error: ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-4).join(' | ') || `exit ${r.status}` }
  }
  return JSON.parse(line.slice('__RESULT__'.length))
}

await printMachine()
console.log(`build=${BUILD} samples=${SAMPLES} threads=${THREADS}\n`)

const runtimes = WANTED_RUNTIMES.filter(r => {
  if (!RUNTIMES[r]) throw new Error('unknown runtime ' + r)
  if (available(r)) return true
  console.log(`${r}: not installed, skipping`)
  return false
})
if (!runtimes.length) throw new Error('no runtimes available')

let failures = 0
const results = {}

for (const track of WANTED) {
  const cfg = TRACKS[track]
  if (!cfg) throw new Error('unknown track ' + track)
  const [lo, hi] = range(cfg.sub)
  const times = Array.from({ length: SAMPLES }, (_, i) => lo + (hi - lo) * (i / (SAMPLES - 1 || 1)))

  console.log(`${track}  t=${times.map(t => t.toFixed(1)).join(',')}`)
  for (const [w, h] of SIZES) {
    for (const runtime of runtimes) {
      const res = render(runtime, { build: BUILD, track, sub: cfg.sub, fonts: cfg.fonts, width: w, height: h, times, threads: THREADS })
      const key = `${track}|${w}x${h}|${runtime}`
      results[key] = res
      if (res.error) {
        failures++
        console.log(`  ${String(w + 'x' + h).padEnd(9)} ${runtime.padEnd(10)} ERROR ${res.error}`)
        continue
      }
      const ms = res.frames.reduce((a, f) => a + f.ms, 0) / res.frames.length
      console.log(
        `  ${String(w + 'x' + h).padEnd(9)} ${runtime.padEnd(10)} ${ms.toFixed(2).padStart(7)}ms/frame  ` +
        `${(res.renderer || '?').padEnd(28)} ` +
        `nonEmpty=${res.frames.filter(f => f.lit > 0).length}/${res.frames.length}  ` +
        `lit=[${res.frames.map(f => f.lit).join(',')}]`
      )
    }
  }
  console.log()
}

// --- checks -------------------------------------------------------------------------------------------

// 1. every runtime agrees, pixel for pixel, at the same size
for (const track of WANTED) {
  for (const [w, h] of SIZES) {
    const got = runtimes.map(r => [r, results[`${track}|${w}x${h}|${r}`]]).filter(([, v]) => v && !v.error)
    if (got.length < 2) continue
    const [, ref] = got[0]
    for (const [runtime, res] of got.slice(1)) {
      const bad = res.frames.filter((f, i) => f.hash !== ref.frames[i].hash)
      if (bad.length) {
        failures++
        console.log(`DIFFER ${track} ${w}x${h}: ${runtime} vs ${got[0][0]} on t=${bad.map(f => f.t).join(',')}`)
      }
    }
  }
}

// 2. a larger render size must not cost frames. This is jassub#12 stated as an assertion: the pattern of
//    which timestamps are empty is a property of the track, not of the size it is rendered at.
if (SIZES.length > 1) {
  for (const track of WANTED) {
    for (const runtime of runtimes) {
      const pattern = SIZES
        .map(([w, h]) => results[`${track}|${w}x${h}|${runtime}`])
        .filter(r => r && !r.error)
        .map(r => r.frames.map(f => (f.lit > 0 ? 1 : 0)).join(''))
      if (new Set(pattern).size > 1) {
        failures++
        console.log(`SIZE-DEPENDENT EMPTINESS ${track} ${runtime}: ${pattern.join(' vs ')}`)
      }
    }
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall backends agree, and no frame is lost at the larger render size')
process.exit(failures ? 1 : 0)
