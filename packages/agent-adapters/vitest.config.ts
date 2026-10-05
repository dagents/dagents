import { defineConfig } from 'vitest/config'

// 与 gateway 同款：文件串行（fileParallelism: false）。adapters 的生命周期
// 用例是「真子进程 + 秒级看门狗」的时序敏感型测试 —— 多 worker 并行时 CPU
// 争抢会把 300ms 看门狗拉长过 15s 测试上限（win32 真机复现）。用例本身
// 断言的是升级路径是否触发，不是精确延迟；串行换确定性，总时长仍在秒级。
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
