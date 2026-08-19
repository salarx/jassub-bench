// One-shot setup: fetch the benchmark assets, then build the two jassub trees this harness compares.
//
//   node prepare.mjs                  # assets + both builds
//   node prepare.mjs --assets         # assets only
//
// This repo holds no jassub source. It clones jassub into work/jassub (or reuses a checkout you point
// JASSUB_REPO at) and builds two refs out of it:
//
//   JASSUB_REPO=/path/to/jassub       use an existing checkout instead of cloning
//   JASSUB_REMOTE=<url>               where to clone from (default: the fork this harness tracks)
//   PATCHED_REF=<ref>                 the tree under test        (default: main)
//   BASELINE_REF=<ref>                what to compare it against (default: pinned upstream SHA)
//
// Assets are fetched rather than committed: they are the upstream demo's own video, subtitles and fonts,
// about 45 MB, and they are not ours to redistribute.
import { mkdirSync, existsSync, writeFileSync, statSync, rmSync, cpSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets')
const DIST = join(HERE, 'dist')
const WORK = join(HERE, 'work')
const ORIGIN = 'https://jassub.pages.dev'

const JASSUB_REMOTE = process.env.JASSUB_REMOTE || 'https://github.com/salarx/jassub.git'
// The last upstream commit before the perf work. Pinned as a SHA, not a branch name: once that work is
// merged, `main` *is* the patched tree, and a branch default would build both sides from one source and
// compare a build against itself while reporting a clean pass.
const UPSTREAM_BASE = '2753847'

// mirrors the upstream demo's own manifest
const SUBTITLES = ['beastars.ass', 'FGOBD.ass', 'test.ass', 'box.ass', 'Kusriya S2 OP1v3.ass']
const VIDEOS = ['Beastars.mp4', 'vfr.mp4', 'cfr.mp4']
const FONTS = [
  'Averia Sans Libre Light.ttf', 'Averia Serif Simple Light.ttf', 'FOT-TsukuCOldMinPr6NR.OTF',
  'FRABK.TTF', 'Gramond.ttf', 'Lato-Regular.ttf', 'RoughFlowers.TTF', 'SlatePro-Medium.otf',
  'allison-script.regular.otf', 'architext.regular.ttf', 'arial.ttf', 'chawp.otf'
]

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })

const fetchTo = async (url, dest) => {
  if (existsSync(dest) && statSync(dest).size > 2048) return false
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // the SPA returns a ~1.6 KB HTML shell for missing paths instead of a 404
  if (buf.length < 2048 && buf.includes(Buffer.from('<!DOCTYPE'))) throw new Error(`not found: ${url}`)
  writeFileSync(dest, buf)
  return true
}

const getAssets = async () => {
  for (const d of ['subtitles', 'videos', 'fonts']) mkdirSync(join(ASSETS, d), { recursive: true })
  let got = 0
  for (const [dir, names] of [['subtitles', SUBTITLES], ['videos', VIDEOS], ['fonts', FONTS]]) {
    for (const n of names) {
      const url = `${ORIGIN}/${dir}/${encodeURIComponent(n)}`
      if (await fetchTo(url, join(ASSETS, dir, n))) { got++; console.log(`  fetched ${dir}/${n}`) }
    }
  }
  console.log(got ? `assets: ${got} fetched` : 'assets: already present')
}

// A jassub checkout to build refs out of. Cloned once into work/jassub and then reused; point
// JASSUB_REPO at an existing checkout to skip the clone entirely (handy when iterating on jassub itself).
//
// Submodules are deliberately never initialised: jassub's tsconfig only includes `src`, and its wasm
// binaries are committed, so nothing here compiles libass. Fetching harfbuzz and libass costs minutes on a
// fresh machine and buys the benchmark nothing.
const jassubCheckout = () => {
  const existing = process.env.JASSUB_REPO
  if (existing) {
    console.log(`jassub: using ${existing}`)
    return existing
  }
  const repo = join(WORK, 'jassub')
  if (existsSync(join(repo, '.git'))) {
    console.log('jassub: fetching into work/jassub')
    sh('git', ['fetch', '--all', '--tags', '--prune'], { cwd: repo })
  } else {
    mkdirSync(WORK, { recursive: true })
    console.log(`jassub: cloning ${JASSUB_REMOTE}`)
    sh('git', ['clone', '--no-checkout', JASSUB_REMOTE, repo])
  }
  return repo
}

// Build one ref of jassub into dist/<label>.
const buildRef = (repo, ref, label) => {
  const out = join(DIST, label)
  rmSync(out, { recursive: true, force: true })
  const wt = join(WORK, `wt-${label}`)
  rmSync(wt, { recursive: true, force: true })

  console.log(`\n[${label}] worktree at ${ref}`)
  sh('git', ['worktree', 'prune'], { cwd: repo })
  sh('git', ['worktree', 'add', '--detach', '--force', wt, ref], { cwd: repo })

  console.log(`[${label}] tsc`)
  // The worktree has no node_modules of its own. It lives under this repo on purpose: jassub's tsconfig
  // pulls in `eslint-config-standard-universal` and `@webgpu/types`, and Node-style resolution walks up
  // from the tsconfig's directory into this repo's node_modules, which carries both. Move `work/` outside
  // the repo and the build stops resolving.
  sh('npx', ['tsc', '-p', join(wt, 'tsconfig.json'), '--noCheck', '--outDir', join(wt, 'dist')], { cwd: HERE })

  mkdirSync(out, { recursive: true })
  cpSync(join(wt, 'dist'), out, { recursive: true })
  cpSync(join(wt, 'src/wasm'), join(out, 'wasm'), { recursive: true, force: true })
  cpSync(join(wt, 'src/default.woff2'), join(out, 'default.woff2'))

  // The built bundle imports jassub's runtime dependencies as bare specifiers ('abslink', 'rvfc-polyfill',
  // ...). Vite resolves those from this repo's node_modules when it serves dist/, so this repo has to carry
  // them. That list is jassub's to change, not ours, so check it rather than trusting it to stay put:
  // a missing entry otherwise shows up as an opaque 500 on the page, long after prepare said "ready".
  const theirs = Object.keys(JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).dependencies ?? {})
  const ours = Object.keys(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies ?? {})
  const missing = theirs.filter(d => !ours.includes(d))
  if (missing.length) {
    console.error(`\n[${label}] jassub depends on ${missing.join(', ')}, which this harness does not carry.`)
    console.error(`Add them to this repo's package.json and re-run, or the served page will 500 on import.`)
    process.exitCode = 1
  }

  sh('git', ['worktree', 'remove', '--force', wt], { cwd: repo })
  console.log(`[${label}] -> dist/${label}`)
}

const args = process.argv.slice(2)
await getAssets()
if (!args.includes('--assets')) {
  const repo = jassubCheckout()
  buildRef(repo, process.env.PATCHED_REF || 'main', 'patched')
  buildRef(repo, process.env.BASELINE_REF || UPSTREAM_BASE, 'baseline')
  console.log('\nready. start the server with:  npx vite --port 5199 --strictPort')
}
