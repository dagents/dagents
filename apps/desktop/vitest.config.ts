import { defineConfig } from 'vitest/config'

// M1 只有纯 Node 的接线守护测试；M2 起编排器单测（真子进程树终止 / 真 listener
// 端口探测）是时序敏感用例——沿用 gateway / agent-adapters 的 fileParallelism=false
// 串行约定（docs/desktop-architecture.md §6）。
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    include: ['src/**/*.{test,spec}.ts'],
  },
})
