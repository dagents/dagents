import { defineConfig } from 'vitest/config'

// Integration tests hit the real milagents Postgres (127.0.0.1:15432) and
// Redis (127.0.0.1:16479) from the docker-compose stack. Run files serially:
// the suite shares the `runs` table + `mil:sem`/`mil:tasks` keys across files
// (each file wipes them in beforeEach), and parallel files would race on the
// same rows/keys. The suite is small and fast, so serializing the whole thing
// keeps counts deterministic (same rationale as apps/gateway/vitest.config.ts).
//
// `setupFiles` runs `setup.ts` once per file before any test: it sets the dev
// POSTGRES_URL / REDIS_URL defaults (with the dev Redis password baked in — a
// bare URL hits NOAUTH) and runs pending migrations so `runs` exists on a
// fresh DB. Keeping it as a setupFile (not inline in each test) means the
// migration + env defaults are owned in one place shared by the worker,
// fan-out, semaphore, and prediction-client suites.
export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
