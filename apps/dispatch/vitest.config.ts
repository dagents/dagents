import { defineConfig } from 'vitest/config'

// Vitest config for the dispatch package. Integration tests drive the real
// dagents Postgres (127.0.0.1:15432) via `app.request()`, and every test
// file wipes the shared dispatch tables in `beforeEach`. Two files running in
// parallel would interleave those wipes and corrupt each other's state, so we
// force file-serial execution (`fileParallelism: false`). Tests are fast
// (sub-second total) so the serial cost is negligible.
//
// DB-backed files: `dispatch.test.ts`, `agents.test.ts` (M5a.2),
// `runs-usage.test.ts` (M6.2). Same `fileParallelism: false` pattern as
// `apps/scheduler/vitest.config.ts`.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.ts'],
  },
})
