import { defineConfig } from 'vitest/config'

// Integration tests hit the real milagents Postgres (127.0.0.1:15432) and
// MinIO (127.0.0.1:9000) from the docker-compose stack, and mutate the shared
// `runs` + `pipeline_versions` tables. Run files serially: the suite shares
// those tables across files (each file wipes them in beforeEach), and parallel
// files would race on the same rows / version-hash dedup keys. The suite is
// small and fast, so serializing keeps counts deterministic (same rationale as
// apps/scheduler/vitest.config.ts).
export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
