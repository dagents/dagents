import { defineConfig } from 'vitest/config'

// Two gateway test files touch the shared `token_meta` table (tokens.test.ts
// and probe.test.ts), each wiping it in beforeEach. Run files serially so they
// don't race on the same Postgres rows — the proxy.test.ts / llm.test.ts files
// don't touch the DB, but serializing the whole (small, fast) suite is simpler
// than scoping cleanup per file and keeps counts deterministic.
//
// globalSetup 把整套测试钉到自动供给的专用库 dagents_gw_test（建库 + 迁移
// + 注入 POSTGRES_URL）—— 此前集成测试直连 dev 库，dispatch 文件还会全表
// wipe runs。服务器地址沿用 POSTGRES_URL，只换库名，dev 库零触碰。
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['./src/test-support/gw-test-db.ts'],
  },
})
