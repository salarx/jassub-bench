import { defineConfig } from 'vite'

// SharedArrayBuffer needs cross-origin isolation. Without these headers libass silently drops to
// single-threaded — worth about 1.6x — and every number the harness prints is quietly wrong.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  }
})
