// Is the GPU path actually the right default outside the browser?
//
//   node gpu-vs-cpu.mjs
//   SIZES=1920x1080 REPS=5 node gpu-vs-cpu.mjs
//
// jassub/deno picks WebGPU whenever the runtime has it. Compositing there really is faster, but the frame
// then has to be copied back out of the GPU, and that copy scales with pixel count while libass' work does
// not. Whether the trade pays therefore depends on resolution - which is the thing a fixed default cannot
// know. This measures both renderers at several sizes, in both drive modes, and prints the crossover.
//
// One instance per process is a hard limit (a second create() dies inside emscripten's pthread setup), so
// every case is its own spawn. Cases are interleaved rather than grouped, so thermal drift hits all of them.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILD = process.env.BUILD || 'patched'
const REPS = +(process.env.REPS || 3)
const FRAMES = +(process.env.FRAMES || 20)
const THREADS = +(process.env.THREADS || 8)
const SIZES = (process.env.SIZES || '640x360,960x540,1920x1080,3840x2160').split(',').map(s => s.split('x').map(Number))
// kusriya's densest stretch: ~670 ASS_Images a frame, which is the case worth defaulting for
const TRACK = { sub: 'Kusriya S2 OP1v3.ass', fonts: ['FOT-TsukuCOldMinPr6NR.OTF', 'RoughFlowers.TTF'], t0: 35.7 }
const times = Array.from({ length: FRAMES }, (_, i) => +(TRACK.t0 + i * 0.04).toFixed(3))

const DENO = process.env.DENO || 'deno'
const DENO_ARGS = ['run', '--allow-read', '--allow-net', '--allow-env', '--allow-sys', '--allow-ffi', '--unstable-webgpu']

const run = (renderer, mode, [width, height]) => {
  const opts = { build: BUILD, track: 'kusriya', sub: TRACK.sub, fonts: TRACK.fonts, width, height, times, threads: THREADS, renderer, mode }
  const r = spawnSync(DENO, [...DENO_ARGS, join(HERE, 'backend-render.mjs'), JSON.stringify(opts)],
    { cwd: HERE, encoding: 'utf8', maxBuffer: 1 << 28 })
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('__RESULT__'))
  if (!line) return { error: (r.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 160) }
  return JSON.parse(line.slice('__RESULT__'.length))
}

const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const cases = []
for (const size of SIZES) for (const renderer of ['auto', 'cpu']) for (const mode of ['serial', 'pipelined']) cases.push({ size, renderer, mode })

const out = new Map()
for (let rep = 0; rep < REPS; rep++) {
  for (const c of cases) {
    const key = `${c.size.join('x')}|${c.renderer}|${c.mode}`
    const r = run(c.renderer, c.mode, c.size)
    if (r.error) { console.error(`  ! ${key} rep ${rep + 1}: ${r.error}`); continue }
    // drop the first frame: it carries the pipeline's fill cost in pipelined mode
    const ms = med(r.frames.slice(1).map(f => f.ms))
    const rec = out.get(key) ?? { ...c, renderer_actual: r.renderer, ms: [], hash: r.frames[1]?.hash, lit: r.frames[1]?.lit }
    rec.ms.push(ms)
    out.set(key, rec)
    console.error(`  ${key.padEnd(28)} rep ${rep + 1}: ${ms.toFixed(2)}ms  ${r.renderer}`)
  }
}

console.log('\nsize        mode        GPU ms   CPU ms   winner   margin   pixels agree')
for (const size of SIZES) {
  for (const mode of ['serial', 'pipelined']) {
    const g = out.get(`${size.join('x')}|auto|${mode}`)
    const c = out.get(`${size.join('x')}|cpu|${mode}`)
    if (!g || !c) continue
    const gm = med(g.ms); const cm = med(c.ms)
    const win = gm < cm ? 'GPU' : 'CPU'
    const margin = `${(Math.abs(gm - cm) / Math.max(gm, cm) * 100).toFixed(0)}%`
    console.log(`${size.join('x').padEnd(11)} ${mode.padEnd(11)} ${gm.toFixed(2).padStart(7)} ${cm.toFixed(2).padStart(8)}   ${win.padEnd(8)} ${margin.padStart(6)}   ${g.lit === c.lit ? 'lit ' + g.lit : 'LIT DIFFERS'}`)
  }
}
// the GPU case must actually have been the GPU, or this compares the CPU path with itself
const gpuRows = [...out.values()].filter(r => r.renderer === 'auto')
const bad = gpuRows.filter(r => !/WebGPU/.test(r.renderer_actual))
if (bad.length) console.error(`\nWARNING: ${bad.length} 'auto' case(s) did not select a WebGPU renderer: ${[...new Set(bad.map(b => b.renderer_actual))].join(', ')}`)
