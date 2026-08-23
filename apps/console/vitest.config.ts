import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Vitest config for the console package. The environment is jsdom so the
// component tests (src/components/__tests__) get a document + window; the
// existing route-handler + lib suites keep working because jsdom still runs
// in Node — `node:http` stub servers, `Buffer`, `process.env`, and the
// undici `Request`/`Response`/`fetch` globals `NextRequest` relies on all
// remain available, and none of the lib/route modules read `window`/`document`
// at import time. setupFiles wires jest-dom matchers + RTL cleanup once per
// file (cleanup is a no-op for tests that never render). The `@/*` alias
// mirrors tsconfig `paths` so `@/lib/config` / `@/components/...` resolve
// under vitest the same way they do under Next's bundler.
//
// `esbuild.jsx: 'automatic'` makes esbuild emit `react/jsx-runtime` calls so
// `.tsx` files compile under the modern JSX transform — the same transform
// Next/SWC uses at runtime, which is why the app's `.tsx` never imports React
// explicitly. Without this, vitest's esbuild would leave JSX as `preserve`
// (per tsconfig `jsx`) and component tests throw "React is not defined".
export default defineConfig({
  resolve: {
    alias: {
      '@/': `${resolve(fileURLToPath(import.meta.url), '..', 'src')}/`,
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 这台开发机常驻高负载（宿主应用 + 多 dev server），jsdom 渲染类用例
    // 在默认 5s 下会因 CPU 饥饿偶发超时（断言本身没问题）。放宽到 20s /
    // hook 10s，并行度跟随 CPU 但压到 4 以内，减少抖动。
    testTimeout: 20_000,
    hookTimeout: 10_000,
    maxConcurrency: 4,
  },
})

