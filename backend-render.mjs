// Runs inside node, bun or deno. Renders a track headlessly and prints one JSON line on stdout.
//
// Kept separate from backends.mjs so all three runtimes execute byte-identical code: any difference in the
// result is the runtime or the renderer, never the harness.
//
//   node backend-render.mjs '<json opts>'
//
// opts: { build, track, sub, fonts[], width, height, times[], threads, renderer, mode }
//
// mode defaults to 'serial' - renderFrame per timestamp, which is what a one-shot caller gets. 'pipelined'
// drives renderFrames instead, which overlaps each frame's readback with the next frame's rasterisation.
// The distinction only matters where there is a readback to overlap, i.e. the GPU path: timing a GPU
// renderer serially charges it the full copy every frame and reads as far slower than it is in use.
// The argument is JSON, or the same JSON base64-encoded. Windows ships bun as a .cmd shim, which Node
// refuses to spawn without a shell - and going through a shell makes a raw JSON argument a quoting hazard,
// so the driver sends base64 there. Both accepted, so running this by hand still works.
const raw = globalThis.Deno ? Deno.args[0] : process.argv[2]
const opts = JSON.parse(raw.trimStart().startsWith('{')
  ? raw
  : new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))))

const HERE = new URL('.', import.meta.url)
const entry = new URL(`dist/${opts.build}/${globalThis.Deno ? 'deno' : 'node'}.js`, HERE).href
const { default: JASSUB } = await import(entry)

const subUrl = new URL(`assets/subtitles/${encodeURIComponent(opts.sub)}`, HERE).href
const fonts = opts.fonts.map(f => new URL(`assets/fonts/${encodeURIComponent(f)}`, HERE).href)

const subs = await JASSUB.create({
  width: opts.width,
  height: opts.height,
  subUrl,
  fonts,
  threads: opts.threads,
  ...(opts.renderer ? { renderer: opts.renderer } : {})
})

// FNV-1a over the RGBA, plus a lit count. Same shape as the browser harness' hashCanvas, so a backend frame
// and a canvas frame are comparable rather than merely both "a hash".
const digest = rgba => {
  let h = 2166136261
  let lit = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a > 0) {
      lit++
      h ^= rgba[i] + rgba[i + 1] * 3 + rgba[i + 2] * 7 + a * 11
    } else {
      h ^= 0x9e
    }
    h = Math.imul(h, 16777619) >>> 0
  }
  return { hash: lit === 0 ? 0 : (h >>> 0), lit }
}

// warm-up: the first frame pays for font loading and libass' caches, and it is not what we are timing
await subs.renderFrame(opts.times[0])

const frames = []
if (opts.mode === 'pipelined') {
  // one timestamp per yield, so the per-frame cost is wall time across the whole run divided by frames -
  // there is no meaningful per-frame boundary once the readbacks overlap
  const t0 = performance.now()
  let i = 0
  for await (const rgba of subs.renderFrames(opts.times)) {
    frames.push({ t: +opts.times[i++].toFixed(3), ...digest(rgba) })
  }
  const per = (performance.now() - t0) / frames.length
  for (const fr of frames) fr.ms = +per.toFixed(2)
} else {
  for (const t of opts.times) {
    const t0 = performance.now()
    const rgba = await subs.renderFrame(t)
    const ms = performance.now() - t0
    frames.push({ t: +t.toFixed(3), ms: +ms.toFixed(2), ...digest(rgba) })
  }
}

// Which renderer actually got selected. Asking for one is not the same as getting it: without a native
// WebGPU binding installed, `renderer: 'webgpu'` quietly composites on the CPU instead, and the run would
// otherwise look like a passing GPU case that is really the default measured twice.
const actual = subs._renderer?._gpurender?.constructor?.name ?? 'unknown'

await subs.destroy()
console.log('__RESULT__' + JSON.stringify({ track: opts.track, width: opts.width, height: opts.height, renderer: actual, mode: opts.mode ?? 'serial', frames }))
