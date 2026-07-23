import { defineConfig } from 'vitest/config'

// Two gateway test files touch the shared `token_meta` table (tokens.test.ts
// and probe.test.ts), each wiping it in beforeEach. Run files serially so they
// don't race on the same Postgres rows — the proxy.test.ts / llm.test.ts files
// don't touch the DB, but serializing the whole (small, fast) suite is simpler
// than scoping cleanup per file and keeps counts deterministic.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
