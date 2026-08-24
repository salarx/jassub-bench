// How much throughput a pool of single-threaded jassub instances gets you.
//
// libass' own threads are unavailable outside a cross-origin-isolated browser, so a single frame costs what
// it costs. Frame extraction does not need a faster frame though - it needs more frames per second, and
// those are independent of each other. One instance per worker, frames dealt out round-robin.
//
//   node parallel.mjs              # scale from 1 worker up to the core count
//   WORKERS=4 node parallel.mjs    # just that many
//   FRAMES=120 node parallel.mjs
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets')
const DIST = process.env.JASSUB_DIST || join(HERE, "dist", "patched")
const TRACK = process.env.TRACK || 'beastars.ass'
const FRAMES = +(process.env.FRAMES || 60)
const W = +(process.env.W || 1920)
const H = +(process.env.H || 1080)
const FONTS = ['architext.regular.ttf', 'FRABK.TTF', 'Lato-Regular.ttf', 'arial.ttf', 'chawp.otf', 'SlatePro-Medium.otf', 'allison-script.regular.otf']
// libass threads *per instance*. These multiply with the worker count: eight workers each asking for eight
// threads is 64 on a 12-core box, and the two levels of parallelism just contend. THREADS=1 measures the
// pool on its own.
const THREADS = process.env.THREADS ? +process.env.THREADS : undefined

const timeFor = i => 248 + (i % 20) * 0.25

if (!isMainThread) {
  const { times } = workerData
  const JASSUB = (await import(`${DIST}/node.js`)).default
  const subs = await JASSUB.create({
    subContent: await readFile(join(ASSETS, 'subtitles', TRACK), 'utf8'),
    width: W,
    height: H,
    fonts: FONTS.map(f => `file://${join(ASSETS, 'fonts', f)}`),
    ...(THREADS ? { threads: THREADS } : {})
  })
  // warm up before the clock starts, so JIT and font resolution are not in the measurement
  for (let i = 0; i < 3; i++) await subs.renderFrame(times[0])
  parentPort.postMessage({ ready: true })

  await new Promise(resolve => parentPort.once('message', resolve))
  const started = performance.now()
  let lit = 0
  for (const t of times) {
    const rgba = await subs.renderFrame(t)
    // touch the pixels so nothing can be optimised away, and so the count is checkable
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) lit++
  }
  parentPort.postMessage({ ms: performance.now() - started, frames: times.length, lit })
  await subs.destroy()
  process.exit(0)
}

const run = async n => {
  const share = Array.from({ length: n }, () => [])
  for (let i = 0; i < FRAMES; i++) share[i % n].push(timeFor(i))

  const workers = share.map(times => new Worker(new URL(import.meta.url), { workerData: { times } }))
  const results = []

  // Two phases, and they must not be collapsed: waiting for results before sending "go" deadlocks, because
  // the results are what "go" produces.
  await Promise.all(workers.map(w => new Promise((resolve, reject) => {
    w.once('message', resolve)
    w.once('error', reject)
  })))

  const done = Promise.all(workers.map(w => new Promise((resolve, reject) => {
    w.once('message', m => { results.push(m); resolve() })
    w.once('error', reject)
  })))

  // every worker is warm; start them together so the measurement is of the pool, not of startup
  const started = performance.now()
  for (const w of workers) w.postMessage('go')
  await done
  const wall = performance.now() - started
  await Promise.all(workers.map(w => w.terminate()))
  return { wall, frames: results.reduce((a, r) => a + r.frames, 0), lit: results.reduce((a, r) => a + r.lit, 0) }
}

const cores = os.cpus().length
const counts = process.env.WORKERS ? [+process.env.WORKERS] : [1, 2, 4, Math.min(8, cores)]
console.log(`${TRACK} ${W}x${H}, ${FRAMES} frames, ${cores} cores, libass threads/instance: ${THREADS ?? 'default'}\n`)
console.log('workers   wall(ms)   ms/frame   fps    speedup   lit')
let base = null
for (const n of counts) {
  const { wall, frames, lit } = await run(n)
  const per = wall / frames
  base ??= per
  console.log(`  ${String(n).padEnd(7)} ${wall.toFixed(0).padStart(8)} ${per.toFixed(2).padStart(10)} ${(1000 / per).toFixed(0).padStart(6)} ${(base / per).toFixed(2).padStart(9)}x   ${lit}`)
}
