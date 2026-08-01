import { defineConfig } from 'vitest/config'

// The M6.7 full-chain trace e2e. One test file: it boots the real gateway Hono
// app on ephemeral ports (so the W3C `traceparent` the undici auto-
// instrumentation injects is actually extracted on the receiving hop by the
// `http` server instrumentation — the property `app.request()` in-process calls
// cannot exercise), a stub LLM provider as a real `node:http` server, and a
// real `runDaemon` with a fake claude backend. It drives one `run_id` through
// gateway → @dagents/workflow → dispatch → daemon → LLM and asserts the run_id
// + one OTel traceId thread every hop, with text/tool-use events, usage, and
// node spans all landed.
//
// DB: the docker-compose dev stack (127.0.0.1:15432). One file only, so
// `fileParallelism: false` is belt-and-suspenders against any future sibling
// file racing the shared `runs` / `dispatch_tasks` tables. `setupFiles` runs
// `setup.ts` once per file: env defaults + pending migrations so `runs` /
// `run_node_spans` exist on a fresh DB (same pattern as packages/repro).
export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./src/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
